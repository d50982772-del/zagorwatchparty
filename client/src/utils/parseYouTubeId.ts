/**
 * Витягуємо id відео з YouTube URL.
 * Підтримує:
 *  - https://www.youtube.com/watch?v=ID
 *  - https://youtu.be/ID
 *  - https://www.youtube.com/embed/ID
 */
export function parseYouTubeId(rawUrl: string): string | null {
  if (!rawUrl) return null;
  try {
    const u = new URL(rawUrl);

    if (u.hostname.includes("youtu.be")) {
      const id = u.pathname.replace(/^\//, "").split("/")[0];
      return id || null;
    }

    if (u.hostname.includes("youtube.com")) {
      if (u.pathname === "/watch") {
        return u.searchParams.get("v");
      }
      if (u.pathname.startsWith("/embed/")) {
        const id = u.pathname.replace("/embed/", "").split("/")[0];
        return id || null;
      }
    }
  } catch {
    return null;
  }
  return null;
}
