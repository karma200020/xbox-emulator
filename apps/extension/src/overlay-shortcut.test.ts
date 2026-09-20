import { describe, expect, it } from "vitest";
import {
  DEFAULT_OVERLAY_SHORTCUT,
  matchesOverlayShortcut,
  parseOverlayShortcut,
} from "./overlay-shortcut";

describe("quick overlay shortcut", () => {
  it("uses a non-conflicting default and validates stored choices", () => {
    expect(DEFAULT_OVERLAY_SHORTCUT).toBe("ctrl-alt-p");
    expect(parseOverlayShortcut("ctrl-alt-o")).toBe("ctrl-alt-o");
    expect(parseOverlayShortcut("ctrl-alt-g")).toBe(DEFAULT_OVERLAY_SHORTCUT);
  });

  it("requires the exact configured chord", () => {
    const event = { code: "KeyP", ctrlKey: true, altKey: true, shiftKey: false, metaKey: false };
    expect(matchesOverlayShortcut(event, "ctrl-alt-p")).toBe(true);
    expect(matchesOverlayShortcut({ ...event, shiftKey: true }, "ctrl-alt-p")).toBe(false);
    expect(matchesOverlayShortcut({ ...event, code: "KeyG" }, "ctrl-alt-p")).toBe(false);
  });
});
