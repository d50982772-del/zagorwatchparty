// AUTO-COPIED FROM shared/detectSourceType.ts — DO NOT EDIT EITHER COPY.
// Edit shared/detectSourceType.ts і запусти `node shared/sync.cjs` (це робить
// також `npm run build` обох проектів).
//
// Тип джерела відео, який сервер і клієнт використовують для синхронізації.
// Обидва (server + client) мають однакову логіку детекції, щоб не довіряти
// виключно одній стороні.
export type SourceType = "youtube" | "html5" | "hls" | "unknown";

/**
 * Визначає тип джерела за URL.
 *
 * Підтримуються:
 *  - YouTube (youtube.com/watch?v=..., youtu.be/..., youtube.com/embed/...)
 *  - HLS (.m3u8)
 *  - HTML5 (.mp4, .webm, .ogg)
 */
export function detectSourceType(url: string): SourceType {
  if (!url) return "unknown";
  const lower = url.toLowerCase();

  // YouTube — три формати, які підтримує `parseYouTubeId` і вміє грати
  // `YouTubePlayerAdapter`. Раніше тут було тільки watch/youtu.be — embed
  // потрапляв в `unknown` і блокувався сервером, хоча адаптер вмів його грати.
  if (
    lower.includes("youtube.com/watch") ||
    lower.includes("youtu.be/") ||
    lower.includes("youtube.com/embed/")
  ) {
    return "youtube";
  }

  // Спершу пробуємо розпарсити як URL і подивитись на pathname,
  // щоб не плутатись через query string.
  let pathname = lower;
  try {
    pathname = new URL(lower).pathname;
  } catch {
    // Не URL — лишаємо lower як є (можливо, відносний шлях).
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
