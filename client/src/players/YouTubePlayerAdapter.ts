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
  playerVars?: Record<string, unknown>;
  events?: {
    onReady?: (e: { target: YTPlayer }) => void;
    onStateChange?: (e: { data: number; target: YTPlayer }) => void;
  };
}

let apiPromise: Promise<void> | null = null;

/** Завантажуємо YouTube IFrame API лише один раз на весь додаток. */
function loadYouTubeApi(): Promise<void> {
  if (window.YT && window.YT.Player) return Promise.resolve();
  if (apiPromise) return apiPromise;

  apiPromise = new Promise<void>((resolve) => {
    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(tag);

    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
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
  /** Внутрішній прапорець, щоб ігнорувати state change від нашого власного play/pause. */
  private suppressEvents = false;

  onPlay?: () => void;
  onPause?: () => void;
  onSeek?: (time: number) => void;

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

    await new Promise<void>((resolve) => {
      const YT = window.YT!;
      this.player = new YT.Player(host, {
        videoId,
        playerVars: {
          autoplay: 0,
          controls: 1,
          rel: 0,
          modestbranding: 1,
          playsinline: 1,
        },
        events: {
          onReady: () => resolve(),
          onStateChange: (e) => this.handleStateChange(e.data),
        },
      });
    });
  }

  private handleStateChange(state: number): void {
    if (!window.YT) return;
    const YT = window.YT;
    if (this.suppressEvents) return;

    if (state === YT.PlayerState.PLAYING) {
      this.playing = true;
      this.lastKnownTime = this.player?.getCurrentTime() ?? this.lastKnownTime;
      this.onPlay?.();
    } else if (state === YT.PlayerState.PAUSED) {
      this.playing = false;
      const t = this.player?.getCurrentTime() ?? this.lastKnownTime;
      // Якщо позиція суттєво відрізняється від останньої — трактуємо як seek+pause.
      if (Math.abs(t - this.lastKnownTime) > 1) {
        this.onSeek?.(t);
      }
      this.lastKnownTime = t;
      this.onPause?.();
    }
  }

  async play(): Promise<void> {
    if (!this.player) return;
    this.suppressEvents = true;
    this.player.playVideo();
    // YouTube не повертає Promise, тож знімаємо guard у наступному тіку.
    setTimeout(() => (this.suppressEvents = false), 0);
  }

  async pause(): Promise<void> {
    if (!this.player) return;
    this.suppressEvents = true;
    this.player.pauseVideo();
    setTimeout(() => (this.suppressEvents = false), 0);
  }

  async seek(time: number): Promise<void> {
    if (!this.player) return;
    this.suppressEvents = true;
    this.player.seekTo(time, true);
    this.lastKnownTime = time;
    setTimeout(() => (this.suppressEvents = false), 50);
  }

  getTime(): number {
    return this.player?.getCurrentTime() ?? this.lastKnownTime;
  }

  isPlaying(): boolean {
    if (!this.player || !window.YT) return this.playing;
    return this.player.getPlayerState() === window.YT.PlayerState.PLAYING;
  }

  destroy(): void {
    try {
      this.player?.destroy();
    } catch {
      /* noop */
    }
    this.player = null;
    this.container.innerHTML = "";
  }
}
