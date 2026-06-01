import { describe, it, expect } from "vitest";
import { detectSourceType } from "../utils/detectSourceType";

describe("detectSourceType", () => {
  it("розпізнає YouTube посилання", () => {
    expect(detectSourceType("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("youtube");
    expect(detectSourceType("https://youtu.be/dQw4w9WgXcQ")).toBe("youtube");
    // Embed-URL: треба пропускати, бо адаптер їх грає, а парсер id (parseYouTubeId)
    // вміє витягувати id саме з /embed/. Без цього сервер блокував би їх з
    // UNSUPPORTED_SOURCE.
    expect(detectSourceType("https://www.youtube.com/embed/dQw4w9WgXcQ")).toBe("youtube");
    expect(detectSourceType("https://youtube.com/embed/dQw4w9WgXcQ?autoplay=1")).toBe("youtube");
  });

  it("розпізнає HLS (.m3u8)", () => {
    expect(detectSourceType("https://example.com/stream.m3u8")).toBe("hls");
    expect(detectSourceType("https://example.com/stream.m3u8?token=abc")).toBe("hls");
  });

  it("розпізнає HTML5 (mp4/webm/ogg)", () => {
    expect(detectSourceType("https://example.com/video.mp4")).toBe("html5");
    expect(detectSourceType("https://example.com/movie.webm")).toBe("html5");
    expect(detectSourceType("https://example.com/song.ogg")).toBe("html5");
  });

  it("повертає unknown для невідомих URL", () => {
    expect(detectSourceType("https://example.com/page")).toBe("unknown");
    expect(detectSourceType("https://example.com/")).toBe("unknown");
    expect(detectSourceType("")).toBe("unknown");
    expect(detectSourceType("javascript:alert(1)")).toBe("unknown");
  });
});
