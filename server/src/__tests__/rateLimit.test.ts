import { describe, it, expect } from "vitest";
import { RateLimiter } from "../utils/rateLimit";

describe("RateLimiter", () => {
  it("allows up to capacity events in a burst", () => {
    const rl = new RateLimiter({ capacity: 3, refillPerSec: 0 });
    expect(rl.consume("a")).toBe(true);
    expect(rl.consume("a")).toBe(true);
    expect(rl.consume("a")).toBe(true);
    expect(rl.consume("a")).toBe(false);
  });

  it("refills tokens over time", () => {
    const rl = new RateLimiter({ capacity: 2, refillPerSec: 2 });
    const t0 = 1_000_000;
    expect(rl.consume("k", t0)).toBe(true);
    expect(rl.consume("k", t0)).toBe(true);
    expect(rl.consume("k", t0)).toBe(false);
    // через 500ms має реджентитися 1 токен
    expect(rl.consume("k", t0 + 500)).toBe(true);
    expect(rl.consume("k", t0 + 500)).toBe(false);
  });

  it("isolates buckets per key", () => {
    const rl = new RateLimiter({ capacity: 1, refillPerSec: 0 });
    expect(rl.consume("a")).toBe(true);
    expect(rl.consume("a")).toBe(false);
    // інший ключ — свій бакет
    expect(rl.consume("b")).toBe(true);
  });

  it("drop() звільняє стейт ключа", () => {
    const rl = new RateLimiter({ capacity: 1, refillPerSec: 0 });
    expect(rl.consume("a")).toBe(true);
    expect(rl.consume("a")).toBe(false);
    rl.drop("a");
    // після drop() — наступний consume бачить свіжий full bucket
    expect(rl.consume("a")).toBe(true);
  });
});
