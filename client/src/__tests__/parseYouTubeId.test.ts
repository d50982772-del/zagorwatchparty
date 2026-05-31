import { describe, it, expect } from "vitest";
import { parseYouTubeId } from "../utils/parseYouTubeId";

describe("parseYouTubeId", () => {
  it("витягує id з звичайного watch URL", () => {
    expect(parseYouTubeId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(
      "dQw4w9WgXcQ"
    );
  });

  it("витягує id з watch URL з додатковими параметрами", () => {
    expect(
      parseYouTubeId("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10s&feature=share")
    ).toBe("dQw4w9WgXcQ");
  });

  it("витягує id з youtu.be short URL", () => {
    expect(parseYouTubeId("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(parseYouTubeId("https://youtu.be/dQw4w9WgXcQ?t=10")).toBe("dQw4w9WgXcQ");
  });

  it("повертає null для невалідних URL", () => {
    expect(parseYouTubeId("https://example.com")).toBeNull();
    expect(parseYouTubeId("")).toBeNull();
    expect(parseYouTubeId("not a url")).toBeNull();
  });
});
