import type { PlayerAdapter } from "./PlayerAdapter";

/**
 * Адаптер для звичайних HTML5 відеофайлів (mp4 / webm / ogg).
 * Створює <video> елемент всередині переданого контейнера.
 */
export class HtmlVideoPlayerAdapter implements PlayerAdapter {
  protected container: HTMLElement;
  protected video: HTMLVideoElement;
  /**
   * Лічильник замість boolean: коли в одній мікро-черзі робимо seek()→play(),
   * два паралельні setTimeout(0) на реліз guard’а не повинні дозволити першому
   * зняти guard, поки другий ще в польоті. handle*() ігнорують події, поки
   * лічильник > 0.
   */
  protected suppressDepth = 0;
  /**
   * Якщо load() ще в польоті — це функція, яка викине його promise з rejection
   * і прибере слухачі. destroy() викликає її, щоб не залишити висячих слухачів
   * (loadedmetadata/error) на відкріпленому <video> елементі. Protected, бо
   * HlsVideoPlayerAdapter перевизначає load() і виставляє свій loadAbort.
   */
  protected loadAbort: (() => void) | null = null;

  onPlay?: () => void;
  onPause?: () => void;
  onSeek?: (time: number) => void;

  constructor(container: HTMLElement) {
    this.container = container;
    this.video = document.createElement("video");
    this.video.controls = true;
    this.video.playsInline = true;
    this.video.preload = "auto";
    this.video.style.width = "100%";
    this.video.style.height = "100%";
    this.video.style.background = "#000";

    this.video.addEventListener("play", this.handlePlay);
    this.video.addEventListener("pause", this.handlePause);
    this.video.addEventListener("seeked", this.handleSeeked);
  }

  protected handlePlay = (): void => {
    if (this.suppressDepth > 0) return;
    this.onPlay?.();
  };

  protected handlePause = (): void => {
    if (this.suppressDepth > 0) return;
    this.onPause?.();
  };

  protected handleSeeked = (): void => {
    if (this.suppressDepth > 0) return;
    this.onSeek?.(this.video.currentTime);
  };

  /**
   * Приватний хелпер: иncrement, виконати програмну дію, потім в наступному macrotask
   * декрементнути. Якщо між цим був ще один виклик (напр. seek→play), лічильник
   * все одно залишається > 0, поки другий виклик не завершиться — жодних leak’ів.
   */
  private withSuppression(): () => void {
    this.suppressDepth += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      // setTimeout 0, щоб вже вже поставлені в чергу "play"/"pause"/"seeked" події
      // встигли відфільтруватися до того, як лічильник впаде до 0.
      setTimeout(() => {
        this.suppressDepth = Math.max(0, this.suppressDepth - 1);
      }, 0);
    };
  }

  async load(url: string): Promise<void> {
    this.container.innerHTML = "";
    this.video.src = url;
    this.container.appendChild(this.video);
    // Чекаємо завантаження метаданих, щоб getDuration() / seek() працювали стабільно.
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        this.video.removeEventListener("loadedmetadata", onLoaded);
        this.video.removeEventListener("error", onError);
        this.loadAbort = null;
      };
      const onLoaded = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error("Не вдалося завантажити відео"));
      };
      this.video.addEventListener("loadedmetadata", onLoaded);
      this.video.addEventListener("error", onError);
      // Якщо destroy() викликають, поки ми чекаємо loadedmetadata/error — без
      // цього слухачі залишаються висіти на відкріпленому <video> разом з closures,
      // а awaiting promise ніколи не settle'ився б.
      this.loadAbort = () => {
        cleanup();
        reject(new Error("Адаптер знищено до завершення завантаження"));
      };
    });
  }

  async play(): Promise<void> {
    const release = this.withSuppression();
    try {
      await this.video.play();
    } catch {
      // Браузер міг заблокувати автоплей — це нормально, ігноруємо.
    } finally {
      release();
    }
  }

  async pause(): Promise<void> {
    const release = this.withSuppression();
    this.video.pause();
    release();
  }

  async seek(time: number): Promise<void> {
    const release = this.withSuppression();
    this.video.currentTime = time;
    // Подія seeked прийде асинхронно; залишаємо guard, поки вона не пройде.
    // Safety net: якщо `seeked` так і не випалить (відео в error state, відкріплене
    // від DOM, seek поза тривалістю) — таймаут не дає promise висіти вічно і
    // блокувати drift correction / remote-обробники в RoomPage.
    await new Promise<void>((resolve) => {
      let settled = false;
      let timeoutId: number | null = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        this.video.removeEventListener("seeked", finish);
        if (timeoutId !== null) window.clearTimeout(timeoutId);
        resolve();
      };
      timeoutId = window.setTimeout(finish, 3000);
      this.video.addEventListener("seeked", finish);
    });
    release();
  }

  getTime(): number {
    return this.video.currentTime || 0;
  }

  isPlaying(): boolean {
    return !this.video.paused && !this.video.ended;
  }

  destroy(): void {
    this.video.removeEventListener("play", this.handlePlay);
    this.video.removeEventListener("pause", this.handlePause);
    this.video.removeEventListener("seeked", this.handleSeeked);
    // Якщо destroy викликали посеред load() — реджектимо awaiting promise
    // і знімаємо loadedmetadata/error слухачі.
    this.loadAbort?.();
    try {
      this.video.pause();
      this.video.removeAttribute("src");
      this.video.load();
    } catch {
      /* noop */
    }
    this.container.innerHTML = "";
  }
}
