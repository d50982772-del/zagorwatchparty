import Hls from "hls.js";
import { HtmlVideoPlayerAdapter } from "./HtmlVideoPlayerAdapter";

/**
 * Адаптер для HLS (.m3u8). Розширює HTML5-плеєр і додає hls.js,
 * якщо браузер не підтримує HLS нативно (Safari/iOS вміє з коробки).
 */
export class HlsVideoPlayerAdapter extends HtmlVideoPlayerAdapter {
  private hls: Hls | null = null;

  async load(url: string): Promise<void> {
    // Підготовка <video> у контейнері.
    this.container.innerHTML = "";
    this.container.appendChild(this.video);

    // Сафарі та інші бравери з нативним HLS можуть просто отримати src напряму.
    if (this.video.canPlayType("application/vnd.apple.mpegurl")) {
      this.video.src = url;
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
          reject(new Error("Не вдалося завантажити HLS-потік"));
        };
        this.video.addEventListener("loadedmetadata", onLoaded);
        this.video.addEventListener("error", onError);
        // Якщо destroy() викликають посеред native-HLS load — закриваємо promise
        // і знімаємо слухачі з відкріпленого <video>.
        this.loadAbort = () => {
          cleanup();
          reject(new Error("Адаптер знищено до завершення завантаження"));
        };
      });
      return;
    }

    if (!Hls.isSupported()) {
      throw new Error("Цей браузер не підтримує HLS");
    }

    this.hls = new Hls();
    this.hls.loadSource(url);
    this.hls.attachMedia(this.video);

    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        this.hls?.off(Hls.Events.MANIFEST_PARSED, onManifest);
        this.hls?.off(Hls.Events.ERROR, onError);
        this.loadAbort = null;
      };
      const onManifest = () => {
        cleanup();
        resolve();
      };
      const onError = (_e: unknown, data: { fatal: boolean }) => {
        if (!data?.fatal) return;
        cleanup();
        reject(new Error("Не вдалося завантажити HLS-потік"));
      };
      this.hls?.on(Hls.Events.MANIFEST_PARSED, onManifest);
      this.hls?.on(Hls.Events.ERROR, onError);
      // Без цього destroy() посеред hls.js manifest-load залишав би MANIFEST_PARSED
      // / ERROR слухачі на hls інстансі, а awaiting promise висів би навіки.
      this.loadAbort = () => {
        cleanup();
        reject(new Error("Адаптер знищено до завершення завантаження"));
      };
    });
  }

  destroy(): void {
    // Якщо load() ще в польоті — реджектимо promise, прибираємо слухачі. Робимо
    // це ПЕРЕД hls.destroy(), щоб уникнути spurious onError від самого destroy.
    this.loadAbort?.();
    try {
      this.hls?.destroy();
    } catch {
      /* noop */
    }
    this.hls = null;
    super.destroy();
  }
}
