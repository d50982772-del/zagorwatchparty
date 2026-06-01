/**
 * Приймає сире значення currentTime з payload і повертає безпечне число.
 *
 * Захищає від:
 *  - NaN ("abc", null, undefined → 0);
 *  - Infinity / -Infinity ("Math.max(0, Infinity) === Infinity" не клемпало);
 *  - дуже великих чисел (1e308), які стрибали б плеєри у нонсенс-стан;
 *  - від'ємних значень.
 *
 * Верхня межа 24 год обрана з великим запасом: довших легальних відео у вільному
 * доступі дуже мало, а зловмисні значення (Number.MAX_VALUE) гарантовано
 * відсікаються.
 */
export const MAX_VIDEO_TIME_SECONDS = 24 * 60 * 60; // 24h

export function sanitizeTime(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  if (n <= 0) return 0;
  if (n >= MAX_VIDEO_TIME_SECONDS) return MAX_VIDEO_TIME_SECONDS;
  return n;
}
