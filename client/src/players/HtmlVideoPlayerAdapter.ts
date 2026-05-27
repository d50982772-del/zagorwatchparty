import type { PlayerAdapter } from "./PlayerAdapter";

/**
 * Адаптер для звичайних HTML5 відеофайлів (mp4 / webm / ogg).
 * Створює <video> елемент всередині переданого контейнера.
 */
export class HtmlVideoPlayerAdapter implements PlayerAdapter {
  protected container: HTMLElement;
  protected video: HTMLVideoElement;
  protected suppressEvents = false;

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
    if (this.suppressEvents) return;
    this.onPlay?.();
  };

  protected handlePause = (): void => {
    if (this.suppressEvents) return;
    this.onPause?.();
  };

  protected handleSeeked = (): void => {
    if (this.suppressEvents) return;
    this.onSeek?.(this.video.currentTime);
  };

  async load(url: string): Promise<void> {
    this.container.innerHTML = "";
    this.video.src = url;
    this.container.appendChild(this.video);
    // Чекаємо завантаження метаданих, щоб getDuration() / seek() працювали стабільно.
    await new Promise<void>((resolve, reject) => {
      const onLoaded = () => {
        this.video.removeEventListener("loadedmetadata", onLoaded);
        this.video.removeEventListener("error", onError);
        resolve();
      };
      const onError = () => {
        this.video.removeEventListener("loadedmetadata", onLoaded);
        this.video.removeEventListener("error", onError);
        reject(new Error("Не вдалося завантажити відео"));
      };
      this.video.addEventListener("loadedmetadata", onLoaded);
      this.video.addEventListener("error", onError);
    });
  }

  async play(): Promise<void> {
    this.suppressEvents = true;
    try {
      await this.video.play();
    } catch {
      // Браузер міг заблокувати автоплей — це нормально, ігноруємо.
    } finally {
      // Знімаємо guard після того, як подія play вже встигла спрацювати.
      setTimeout(() => (this.suppressEvents = false), 0);
    }
  }

  async pause(): Promise<void> {
    this.suppressEvents = true;
    this.video.pause();
    setTimeout(() => (this.suppressEvents = false), 0);
  }

  async seek(time: number): Promise<void> {
    this.suppressEvents = true;
    this.video.currentTime = time;
    // Подія seeked прийде асинхронно; залишаємо guard, поки вона не пройде.
    await new Promise<void>((resolve) => {
      const done = () => {
        this.video.removeEventListener("seeked", done);
        resolve();
      };
      this.video.addEventListener("seeked", done);
    });
    setTimeout(() => (this.suppressEvents = false), 0);
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
