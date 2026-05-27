/**
 * Тип джерела відео, який сервер і клієнт використовують для синхронізації.
 * Обидва (server + client) мають однакову логіку детекції, щоб не довіряти
 * виключно одній стороні.
 */
export type SourceType = "youtube" | "hls" | "html5" | "unknown";

/**
 * Визначає тип джерела за URL.
 *
 * Підтримуються:
 *  - YouTube (youtube.com/watch?v=..., youtu.be/...)
 *  - HLS (.m3u8)
 *  - HTML5 (.mp4, .webm, .ogg)
 */
export function detectSourceType(rawUrl: string): SourceType {
  if (!rawUrl || typeof rawUrl !== "string") return "unknown";

  const url = rawUrl.trim();

  // YouTube
  if (/(?:youtube\.com\/watch\?[^#]*v=|youtu\.be\/|youtube\.com\/embed\/)/i.test(url)) {
    return "youtube";
  }

  // Спершу пробуємо розпарсити як URL і подивитись на pathname,
  // щоб не плутатись через query string.
  let pathname = "";
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch {
    pathname = url.toLowerCase();
  }

  if (pathname.endsWith(".m3u8")) return "hls";
  if (pathname.endsWith(".mp4") || pathname.endsWith(".webm") || pathname.endsWith(".ogg") || pathname.endsWith(".ogv")) {
    return "html5";
  }

  return "unknown";
}
