import { describe, expect, it } from "vitest";
import { replaceBindingSource, resolveCapture } from "./key-capture";

describe("safe binding capture", () => {
  it("keeps Escape reserved and cancels without a replacement", () => {
    expect(resolveCapture("keyboard", { code: "Escape" }, ["KeyW"], "KeyW"))
      .toEqual({ status: "cancelled" });
  });

  it("accepts canonical key codes and preserves replacement identity", () => {
    expect(resolveCapture("keyboard", { code: "ShiftLeft" }, ["KeyW"], "KeyW"))
      .toEqual({ status: "accepted", source: "ShiftLeft" });
  });

  it("rejects duplicate and invalid keyboard input", () => {
    expect(resolveCapture("keyboard", { code: "KeyW" }, ["KeyW", "Space"], "Space"))
      .toEqual({ status: "duplicate", source: "KeyW" });
    expect(resolveCapture("keyboard", { code: "" }, [], null))
      .toEqual({ status: "invalid" });
  });

  it("accepts only the five supported mouse buttons", () => {
    expect(resolveCapture("mouse", { button: 4 }, [], null))
      .toEqual({ status: "accepted", source: "4" });
    expect(resolveCapture("mouse", { button: 5 }, [], null))
      .toEqual({ status: "invalid" });
  });

  it("preserves all targets when replacing a source", () => {
    const targets = [{ button: 1 }, { button: 2 }];
    const bindings = { KeyW: targets };
    replaceBindingSource(bindings, "KeyW", "ArrowUp");
    expect(bindings).toEqual({ ArrowUp: targets });
    expect(bindings.ArrowUp).toBe(targets);
  });
});
