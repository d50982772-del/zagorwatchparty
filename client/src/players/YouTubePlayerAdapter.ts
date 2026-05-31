import type { PlayerAdapter } from "./PlayerAdapter";
import { parseYouTubeId } from "../utils/parseYouTubeId";

declare global {
  interface Window {
    YT?: {
      Player: new (el: HTMLElement, opts: YTPlayerOptions) => YTPlayer;
      PlayerState: {
        UNSTARTED: -1;
        ENDED: 0;
        PLAYING: 1;
        PAUSED: 2;
        BUFFERING: 3;
        CUED: 5;
      };
    };
    onYouTubeIframeAPIReady?: () => void;
  }
}

interface YTPlayer {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getPlayerState(): number;
  destroy(): void;
  loadVideoById(id: string): void;
}

interface YTPlayerOptions {
  videoId: string;
  width?: string | number;
  height?: string | number;
  playerVars?: Record<string, unknown>;
  events?: {
    onReady?: (e: { target: YTPlayer }) => void;
    onStateChange?: (e: { data: number; target: YTPlayer }) => void;
    onError?: (e: { data: number; target: YTPlayer }) => void;
  };
}

/** YouTube IFrame API error codes:
 * https://developers.google.com/youtube/iframe_api_reference#onError
 * 2: invalid parameter
 * 5: HTML5 player issue
 * 100: video removed / private
 * 101 / 150: вбудовування заборонене власником каналу
 * 153: "video player configuration error" (часто — обмеження для embed) */
function youtubeErrorMessage(code: number): string {
  switch (code) {
    case 2:
      return "YouTube не зміг розпізнати посилання. Перевір URL відео.";
    case 5:
      return "YouTube-плеєр повідомив про внутрішню помилку (HTML5).";
    case 100:
      return "Відео не знайдено або зроблено приватним.";
    case 101:
    case 150:
      return "Власник відео заборонив вбудовування. Спробуй інше відео.";
    case 153:
      return "YouTube відмовляється відтворювати це відео тут (конфігурація / антибот). Спробуй інше відео.";
    default:
      return `YouTube повернув помилку (код ${code}).`;
  }
}

/** Якщо очікувана подія так і не приходить (наприклад, YouTube не зміг почати
 * відтворення через autoplay-блок), знімаємо guard самі — інакше всі наступні
 * локальні play/pause перестануть пересилатися на сервер. */
const PENDING_STATE_TIMEOUT_MS = 4000;

const API_LOAD_TIMEOUT_MS = 10_000;

/** Скільки чекати, поки `new YT.Player()` випалить onReady, перш ніж здатися.
 * Це окремий етап від API-load: API вже завантажене, але ініціалізація плеєра
 * може зависнути через CSP, обмеження embeddable у відео, або відсутність
 * мережі. Без цього таймауту `load()` висить вічно — VideoPlayer не показує
 * помилку, не створює retry-можливості. */
const PLAYER_READY_TIMEOUT_MS = 15_000;

let apiPromise: Promise<void> | null = null;

/** Завантажуємо YouTube IFrame API лише один раз на весь додаток. */
function loadYouTubeApi(): Promise<void> {
  if (window.YT && window.YT.Player) return Promise.resolve();
  if (apiPromise) return apiPromise;

  apiPromise = new Promise<void>((resolve, reject) => {
    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";

    let settled = false;
    const timeoutId = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      // Дозволимо повторну спробу після зникнення проблеми.
      apiPromise = null;
      reject(
        new Error(
          "Не вдалося завантажити YouTube IFrame API (timeout). Можливо, заблоковано розширенням або мережею."
        )
      );
    }, API_LOAD_TIMEOUT_MS);

    tag.onerror = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeoutId);
      apiPromise = null;
      reject(new Error("Не вдалося завантажити YouTube IFrame API."));
    };

    document.head.appendChild(tag);

    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      if (settled) return;
      settled = true;
      window.clearTimeout(timeoutId);
      resolve();
    };
  });
  return apiPromise;
}

export class YouTubePlayerAdapter implements PlayerAdapter {
  private container: HTMLElement;
  private player: YTPlayer | null = null;
  private lastKnownTime = 0;
  private playing = false;

  /**
   * Скільки очікуваних state-change подій ми ще не "поглинули".
   * YouTube `onStateChange(PLAYING|PAUSED)` приходить асинхронно (від ~100ms до ~1s
   * залежно від буферизації), тому пласкі `setTimeout`-guard'и недостатні.
   * Замість цього лічимо: коли ми самі викликаємо `play()` — pendingPlay++; коли
   * приходить PLAYING — pendingPlay--. Якщо лічильник > 0 — це наш власний виклик,
   * не пересилаємо назад. Інакше — це користувач натиснув плеєр сам.
   *
   * Таймер — лише safety net на випадок, якщо очікуваний state так і не прийде
   * (наприклад, autoplay заблокований).
   */
  private pendingPlay = 0;
  private pendingPause = 0;
  private pendingPlayTimer: number | null = null;
  private pendingPauseTimer: number | null = null;

  /** Якщо load() ще в польоті — функція, яка реджектить його promise і прибирає
   * слухачі / таймери. destroy() викликає її, щоб не залишити висячий promise. */
  private loadAbort: (() => void) | null = null;

  onPlay?: () => void;
  onPause?: () => void;
  onSeek?: (time: number) => void;
  onError?: (msg: string) => void;

  constructor(container: HTMLElement) {
    this.container = container;
  }

  async load(url: string): Promise<void> {
    const videoId = parseYouTubeId(url);
    if (!videoId) throw new Error("Не вдалося визначити ID YouTube-відео");

    await loadYouTubeApi();

    // Якщо плеєр вже існує — підвантажуємо нове відео в нього.
    if (this.player) {
      this.player.loadVideoById(videoId);
      return;
    }

    // Створюємо div, у який вмонтується iframe.
    const host = document.createElement("div");
    this.container.innerHTML = "";
    this.container.appendChild(host);

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let timeoutId: number | null = null;
      const cleanup = () => {
        if (timeoutId !== null) {
          window.clearTimeout(timeoutId);
          timeoutId = null;
        }
        this.loadAbort = null;
      };
      timeoutId = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        // Плеєр міг вже частково побудуватися — прибираємо їх і очищуємо
        // перереференс, щоб destroy() не робив двоваріантної роботи.
        try {
          this.player?.destroy();
        } catch {
          /* noop */
        }
        this.player = null;
        reject(
          new Error(
            "Не вдалося ініціалізувати YouTube-плеєр (таймаут). Можливо, відео заблоковане для вбудовування."
          )
        );
      }, PLAYER_READY_TIMEOUT_MS);

      this.loadAbort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error("Адаптер знищено до завершення завантаження"));
      };

      const YT = window.YT!;
      this.player = new YT.Player(host, {
        // YT.Player не наслідує розміри з host — без явних width/height
        // iframe буде фіксовано 640x390 у HTML-атрибутах. CSS .video-player iframe
        // нас рятує (width:100%), але кращe одразу задати правильно.
        width: "100%",
        height: "100%",
        videoId,
        playerVars: {
          autoplay: 0,
          controls: 1,
          rel: 0,
          modestbranding: 1,
          playsinline: 1,
        },
        events: {
          onReady: () => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve();
          },
          onStateChange: (e) => this.handleStateChange(e.data),
          onError: (e) => {
            const msg = youtubeErrorMessage(e.data);
            // Якщо помилка прийшла ДО onReady — реджектимо load() з цим
            // повідомленням (промейс ще висить).
            if (!settled) {
              settled = true;
              cleanup();
              try {
                this.player?.destroy();
              } catch {
                /* noop */
              }
              this.player = null;
              reject(new Error(msg));
              return;
            }
            // Помилка вже після ready — пробрасуємо через onError-канал.
            this.onError?.(msg);
          },
        },
      });
    });
  }

  private handleStateChange(state: number): void {
    if (!window.YT) return;
    const YT = window.YT;

    if (state === YT.PlayerState.PLAYING) {
      this.playing = true;
      this.lastKnownTime = this.player?.getCurrentTime() ?? this.lastKnownTime;
      // Якщо PLAYING — це відповідь на наш програмний play(), просто поглинаємо.
      if (this.consumePendingPlay()) return;
      this.onPlay?.();
    } else if (state === YT.PlayerState.PAUSED) {
      this.playing = false;
      const t = this.player?.getCurrentTime() ?? this.lastKnownTime;
      const suppressed = this.consumePendingPause();
      // Seek + pause користувача: якщо позиція суттєво відрізняється — це seek.
      // Не пересилаємо, якщо це наш програмний pause.
      if (!suppressed && Math.abs(t - this.lastKnownTime) > 1) {
        this.onSeek?.(t);
      }
      this.lastKnownTime = t;
      if (suppressed) return;
      this.onPause?.();
    }
  }

  private consumePendingPlay(): boolean {
    if (this.pendingPlay <= 0) return false;
    this.pendingPlay -= 1;
    if (this.pendingPlay === 0 && this.pendingPlayTimer !== null) {
      window.clearTimeout(this.pendingPlayTimer);
      this.pendingPlayTimer = null;
    }
    return true;
  }

  private consumePendingPause(): boolean {
    if (this.pendingPause <= 0) return false;
    this.pendingPause -= 1;
    if (this.pendingPause === 0 && this.pendingPauseTimer !== null) {
      window.clearTimeout(this.pendingPauseTimer);
      this.pendingPauseTimer = null;
    }
    return true;
  }

  private armPendingPlay(): void {
    this.pendingPlay += 1;
    if (this.pendingPlayTimer !== null) window.clearTimeout(this.pendingPlayTimer);
    this.pendingPlayTimer = window.setTimeout(() => {
      this.pendingPlay = 0;
      this.pendingPlayTimer = null;
    }, PENDING_STATE_TIMEOUT_MS);
  }

  private armPendingPause(): void {
    this.pendingPause += 1;
    if (this.pendingPauseTimer !== null) window.clearTimeout(this.pendingPauseTimer);
    this.pendingPauseTimer = window.setTimeout(() => {
      this.pendingPause = 0;
      this.pendingPauseTimer = null;
    }, PENDING_STATE_TIMEOUT_MS);
  }

  async play(): Promise<void> {
    if (!this.player) return;
    this.armPendingPlay();
    this.player.playVideo();
  }

  async pause(): Promise<void> {
    if (!this.player) return;
    this.armPendingPause();
    this.player.pauseVideo();
  }

  async seek(time: number): Promise<void> {
    if (!this.player) return;
    // Оновлюємо lastKnownTime ДО seekTo — щоб у handleStateChange різниця з
    // фактичним currentTime була ~0 і ми не сприйняли seek як користувацький.
    this.lastKnownTime = time;
    const player = this.player;
    player.seekTo(time, true);
    // YouTube не має `seeked` event, але `getCurrentTime()` реально рухається
    // до цільової позиції протягом ~200-600ms. Якщо не чекати — подальший play()
    // (як відповідь на video:play) може почати відтворення від старої позиції, потім
    // "стрибне" на нову — видимо як glitch. Полімо до ~600ms.
    await this.waitForSeekSettle(player, time);
  }

  private waitForSeekSettle(player: YTPlayer, target: number): Promise<void> {
    return new Promise((resolve) => {
      const startedAt = Date.now();
      const tick = () => {
        if (!this.player || this.player !== player) {
          // плеєр знищено або перестворено — виходимо
          resolve();
          return;
        }
        const actual = (() => {
          try {
            return player.getCurrentTime();
          } catch {
            return target;
          }
        })();
        if (Math.abs(actual - target) < 0.6 || Date.now() - startedAt > 600) {
          resolve();
          return;
        }
        window.setTimeout(tick, 80);
      };
      window.setTimeout(tick, 80);
    });
  }

  getTime(): number {
    return this.player?.getCurrentTime() ?? this.lastKnownTime;
  }

  isPlaying(): boolean {
    if (!this.player || !window.YT) return this.playing;
    return this.player.getPlayerState() === window.YT.PlayerState.PLAYING;
  }

  destroy(): void {
    if (this.pendingPlayTimer !== null) {
      window.clearTimeout(this.pendingPlayTimer);
      this.pendingPlayTimer = null;
    }
    if (this.pendingPauseTimer !== null) {
      window.clearTimeout(this.pendingPauseTimer);
      this.pendingPauseTimer = null;
    }
    // Якщо load() ще в польоті — реджектимо promise, розбираємо таймер.
    this.loadAbort?.();
    try {
      this.player?.destroy();
    } catch {
      /* noop */
    }
    this.player = null;
    this.container.innerHTML = "";
  }
}
