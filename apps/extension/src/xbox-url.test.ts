import { describe, expect, it } from "vitest";
import { isXboxPlayUrl } from "./xbox-url";

describe("Xbox play scope", () => {
  it.each(["https://www.xbox.com/play", "https://www.xbox.com/en-US/play/games/test",
    "https://www.xbox.com/en-IN/play?source=test"])("allows %s", value => {
    expect(isXboxPlayUrl(value)).toBe(true);
  });
  it.each(["https://www.xbox.com/playground", "https://www.xbox.com/store/play",
    "https://www.xbox.com/en-US/playback", "http://www.xbox.com/play",
    "https://www.xbox.com:8443/play", "https://www.xbox.com.evil.test/play",
    "https://example.com/play"])("rejects %s", value => {
    expect(isXboxPlayUrl(value)).toBe(false);
  });
});
