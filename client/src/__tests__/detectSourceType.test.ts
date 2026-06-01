import { describe, it, expect } from "vitest";
import { detectSourceType } from "../utils/detectSourceType";

describe("detectSourceType (client)", () => {
  it("YouTube", () => {
    expect(detectSourceType("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("youtube");
    expect(detectSourceType("https://youtu.be/dQw4w9WgXcQ")).toBe("youtube");
    // Embed-URL: парсер id їх підтримує (parseYouTubeId), тому detectSourceType
    // мусить пропускати їх, інакше адаптер ніколи не отримає вхідних даних.
    expect(detectSourceType("https://www.youtube.com/embed/dQw4w9WgXcQ")).toBe("youtube");
    expect(detectSourceType("https://youtube.com/embed/dQw4w9WgXcQ?autoplay=1")).toBe("youtube");
  });
  it("HLS", () => {
    expect(detectSourceType("https://e.com/stream.m3u8")).toBe("hls");
  });
  it("HTML5", () => {
    expect(detectSourceType("https://e.com/video.mp4")).toBe("html5");
    expect(detectSourceType("https://e.com/movie.webm")).toBe("html5");
  });
  it("unknown", () => {
    expect(detectSourceType("https://e.com")).toBe("unknown");
    expect(detectSourceType("")).toBe("unknown");
  });
});
