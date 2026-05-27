import { useEffect, useImperativeHandle, useRef, forwardRef } from "react";
import type { PlayerAdapter } from "../players/PlayerAdapter";
import { YouTubePlayerAdapter } from "../players/YouTubePlayerAdapter";
import { HtmlVideoPlayerAdapter } from "../players/HtmlVideoPlayerAdapter";
import { HlsVideoPlayerAdapter } from "../players/HlsVideoPlayerAdapter";
import { detectSourceType } from "../utils/detectSourceType";

export interface VideoPlayerHandle {
  play: () => Promise<void>;
  pause: () => Promise<void>;
  seek: (time: number) => Promise<void>;
  getTime: () => number;
  isPlaying: () => boolean;
}

interface Props {
  url: string | null;
  onLocalPlay: () => void;
  onLocalPause: () => void;
  onLocalSeek: (time: number) => void;
  onError: (msg: string | null) => void;
}

/**
 * Високорівневий React-компонент. Сам обирає правильний адаптер під тип URL
 * і прокидає його методи назовні через ref. Зовнішньому коду не важливо,
 * чи це YouTube, HLS, чи .mp4.
 */
function createAdapter(url: string, container: HTMLElement): PlayerAdapter | null {
  switch (detectSourceType(url)) {
    case "youtube":
      return new YouTubePlayerAdapter(container);
    case "hls":
      return new HlsVideoPlayerAdapter(container);
    case "html5":
      return new HtmlVideoPlayerAdapter(container);
    default:
      return null;
  }
}

const VideoPlayer = forwardRef<VideoPlayerHandle, Props>(function VideoPlayer(
  { url, onLocalPlay, onLocalPause, onLocalSeek, onError },
  ref
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const adapterRef = useRef<PlayerAdapter | null>(null);

  // Тримаємо актуальні колбеки в ref'ах, щоб не пересоздавати плеєр на кожен ререндер.
  const cbsRef = useRef({ onLocalPlay, onLocalPause, onLocalSeek, onError });
  cbsRef.current = { onLocalPlay, onLocalPause, onLocalSeek, onError };

  useImperativeHandle(
    ref,
    () => ({
      play: () => adapterRef.current?.play() ?? Promise.resolve(),
      pause: () => adapterRef.current?.pause() ?? Promise.resolve(),
      seek: (t: number) => adapterRef.current?.seek(t) ?? Promise.resolve(),
      getTime: () => adapterRef.current?.getTime() ?? 0,
      isPlaying: () => adapterRef.current?.isPlaying() ?? false,
    }),
    []
  );

  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;

    // Перевідкриваємо плеєр щоразу, коли змінюється URL.
    let cancelled = false;
    cbsRef.current.onError(null);

    // Спочатку знищуємо старий плеєр.
    adapterRef.current?.destroy();
    adapterRef.current = null;

    if (!url) return;

    const adapter = createAdapter(url, container);
    if (!adapter) {
      cbsRef.current.onError("Це джерело відео не підтримується");
      return;
    }
    adapter.onPlay = () => cbsRef.current.onLocalPlay();
    adapter.onPause = () => cbsRef.current.onLocalPause();
    adapter.onSeek = (t) => cbsRef.current.onLocalSeek(t);

    adapter
      .load(url)
      .then(() => {
        if (cancelled) {
          adapter.destroy();
          return;
        }
        adapterRef.current = adapter;
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : "Не вдалося завантажити відео";
        cbsRef.current.onError(msg);
        adapter.destroy();
      });

    return () => {
      cancelled = true;
      adapter.destroy();
      adapterRef.current = null;
    };
  }, [url]);

  return <div className="video-player" ref={containerRef} />;
});

export default VideoPlayer;
