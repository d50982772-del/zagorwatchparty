import { describe, it, expect } from "vitest";
import { sanitizeTime, MAX_VIDEO_TIME_SECONDS } from "../utils/sanitizeTime";

describe("sanitizeTime", () => {
  it("turns NaN-like values into 0", () => {
    expect(sanitizeTime(undefined)).toBe(0);
    expect(sanitizeTime(null)).toBe(0);
    expect(sanitizeTime("abc")).toBe(0);
    expect(sanitizeTime({})).toBe(0);
    expect(sanitizeTime(NaN)).toBe(0);
  });

  it("clamps negative values to 0", () => {
    expect(sanitizeTime(-1)).toBe(0);
    expect(sanitizeTime(-1e9)).toBe(0);
  });

  it("clamps Infinity and -Infinity to safe values", () => {
    // Infinity → 0 (бо `!Number.isFinite(Infinity)` === true)
    expect(sanitizeTime(Infinity)).toBe(0);
    expect(sanitizeTime(-Infinity)).toBe(0);
  });

  it("clamps very large positive numbers to MAX_VIDEO_TIME_SECONDS", () => {
    expect(sanitizeTime(MAX_VIDEO_TIME_SECONDS + 1)).toBe(MAX_VIDEO_TIME_SECONDS);
    expect(sanitizeTime(1e308)).toBe(MAX_VIDEO_TIME_SECONDS);
  });

  it("keeps reasonable values intact", () => {
    expect(sanitizeTime(0)).toBe(0);
    expect(sanitizeTime(42)).toBe(42);
    expect(sanitizeTime(3600.5)).toBe(3600.5);
    expect(sanitizeTime("123.4")).toBe(123.4);
  });
});
