/**
 * Простий per-key per-event token bucket. Тримаємо стан у пам'яті сокета
 * (через WeakMap[socket] → state).
 *
 * Це не повноцінний rate-limit (не захищає від ботнету), а проста защита від
 * випадкових / ненавмисних флудів типу "клієнт із багом шле 200 video:seek
 * на секунду".
 */
export interface BucketConfig {
  /** Максимум токенів у бакеті. */
  capacity: number;
  /** Скільки токенів реджениться за секунду. */
  refillPerSec: number;
}

interface BucketState {
  tokens: number;
  lastRefillMs: number;
}

export class RateLimiter {
  private buckets = new Map<string, BucketState>();
  constructor(private config: BucketConfig) {}

  /**
   * Повертає true, якщо подія дозволена і токен спожитий.
   * Повертає false, якщо ліміт перевищено.
   */
  consume(key: string, now: number = Date.now()): boolean {
    let state = this.buckets.get(key);
    if (!state) {
      state = { tokens: this.config.capacity, lastRefillMs: now };
      this.buckets.set(key, state);
    }
    // Реджен токенів пропорційно часу, який минув.
    const elapsedMs = now - state.lastRefillMs;
    if (elapsedMs > 0) {
      const refill = (elapsedMs / 1000) * this.config.refillPerSec;
      state.tokens = Math.min(this.config.capacity, state.tokens + refill);
      state.lastRefillMs = now;
    }
    if (state.tokens >= 1) {
      state.tokens -= 1;
      return true;
    }
    return false;
  }

  /** Викидаємо стан для ключа — викликати на disconnect, щоб не текла пам'ять. */
  drop(key: string): void {
    this.buckets.delete(key);
  }
}
