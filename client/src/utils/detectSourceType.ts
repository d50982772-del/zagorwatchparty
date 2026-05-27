export type SourceType = "youtube" | "hls" | "html5" | "unknown";

/**
 * Визначаємо тип відео-джерела за URL. Логіка має збігатися із серверною —
 * якщо хочеш додати новий тип, онови файл тут і у `server/src/utils/`.
 */
export function detectSourceType(rawUrl: string): SourceType {
  if (!rawUrl || typeof rawUrl !== "string") return "unknown";
  const url = rawUrl.trim();

  if (/(?:youtube\.com\/watch\?[^#]*v=|youtu\.be\/|youtube\.com\/embed\/)/i.test(url)) {
    return "youtube";
  }

  let pathname = "";
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch {
    pathname = url.toLowerCase();
  }

  if (pathname.endsWith(".m3u8")) return "hls";
  if (
    pathname.endsWith(".mp4") ||
    pathname.endsWith(".webm") ||
    pathname.endsWith(".ogg") ||
    pathname.endsWith(".ogv")
  ) {
    return "html5";
  }
  return "unknown";
}
