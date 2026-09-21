import { describe, expect, it } from "vitest";
import { BrowserGamepadMapper, mouseAxis } from "./browser-gamepad";
import { BUTTONS, createStarterProfiles, type Profile } from "./profile-schema";

function profile(): Profile {
  return structuredClone(createStarterProfiles().profiles[0]!);
}

describe("BrowserGamepadMapper", () => {
  it("ignores unbound names inherited from Object.prototype", () => {
    const mapper = new BrowserGamepadMapper(profile());
    expect(mapper.apply([{ kind: "key", code: "constructor", down: true }]).buttons)
      .toEqual(Array<number>(17).fill(0));
  });
  it("uses standard Xbox button and axis ordering", () => {
    const mapper = new BrowserGamepadMapper(profile());
    const state = mapper.apply([
      { kind: "key", code: "Space", down: true },
      { kind: "key", code: "KeyW", down: true },
      { kind: "mouse_button", button: 0, down: true },
    ]);
    expect(state.buttons[0]).toBe(1);
    expect(state.buttons[7]).toBe(1);
    expect(state.axes).toEqual([0, -1, 0, 0]);
    expect(state.buttons).toHaveLength(17);
    expect(state.axes).toHaveLength(4);
  });

  it("maps the left mouse button to the left bumper when configured", () => {
    const value = profile();
    value.mouse_bindings["0"] = [{ button: BUTTONS.left_shoulder }];
    const state = new BrowserGamepadMapper(value)
      .apply([{ kind: "mouse_button", button: 0, down: true }]);
    expect(state.buttons[4]).toBe(1);
    expect(state.buttons[7]).toBe(0);
  });

  it("uses unbound arrow keys for D-pad menu navigation", () => {
    const mapper = new BrowserGamepadMapper(profile());
    const state = mapper.apply([
      { kind: "key", code: "ArrowLeft", down: true },
      { kind: "key", code: "ArrowUp", down: true },
    ]);
    expect(state.buttons[12]).toBe(1);
    expect(state.buttons[14]).toBe(1);
  });

  it("honors custom arrow bindings instead of menu fallbacks", () => {
    const value = profile();
    value.key_bindings.ArrowLeft = [{ button: BUTTONS.b }];
    const state = new BrowserGamepadMapper(value)
      .apply([{ kind: "key", code: "ArrowLeft", down: true }]);
    expect(state.buttons[1]).toBe(1);
    expect(state.buttons[14]).toBe(0);
  });

  it("supports multi-bindings and does not release a target held elsewhere", () => {
    const value = profile();
    value.key_bindings.Enter = [{ button: BUTTONS.a }, { button: BUTTONS.b }];
    const mapper = new BrowserGamepadMapper(value);
    mapper.apply([
      { kind: "key", code: "Space", down: true },
      { kind: "key", code: "Enter", down: true },
    ]);
    const state = mapper.apply([{ kind: "key", code: "Enter", down: false }]);
    expect(state.buttons.slice(0, 2)).toEqual([1, 0]);
  });

  it("cancels opposing digital directions and resets all held input", () => {
    const mapper = new BrowserGamepadMapper(profile());
    const state = mapper.apply([
      { kind: "key", code: "KeyA", down: true },
      { kind: "key", code: "KeyD", down: true },
    ]);
    expect(state.axes[0]).toBe(0);
    expect(mapper.reset()).toEqual({
      buttons: Array<number>(17).fill(0),
      axes: [0, 0, 0, 0],
    });
  });

  it("makes mouse movement transient on the next empty frame", () => {
    const mapper = new BrowserGamepadMapper(profile());
    expect(mapper.apply([{ kind: "mouse_move", dx: 20, dy: -10 }]).axes.slice(2))
      .toEqual([0.36, -0.18]);
    expect(mapper.apply([]).axes.slice(2)).toEqual([0, 0]);
  });

  it("switches between hip and ADS response while the configured source is held", () => {
    const value = profile();
    value.mouse.hip.sensitivity_x = 0.01;
    value.mouse.ads.sensitivity_x = 0.02;
    value.mouse.ads_activation = { type: "mouse_button", button: 2 };
    const mapper = new BrowserGamepadMapper(value);
    expect(mapper.apply([{ kind: "mouse_move", dx: 10, dy: 0 }]).axes[2]).toBeCloseTo(0.1);
    expect(mapper.apply([
      { kind: "mouse_button", button: 2, down: true },
      { kind: "mouse_move", dx: 10, dy: 0 },
    ]).axes[2]).toBeCloseTo(0.2);
    expect(mapper.apply([
      { kind: "mouse_button", button: 2, down: false },
      { kind: "mouse_move", dx: 10, dy: 0 },
    ]).axes[2]).toBeCloseTo(0.1);
  });

  it("applies each response to movement in event order within one batch", () => {
    const value = profile();
    value.mouse.hip.sensitivity_x = 0.01;
    value.mouse.ads.sensitivity_x = 0.02;
    value.mouse.ads_activation = { type: "mouse_button", button: 2 };
    const mapper = new BrowserGamepadMapper(value);
    expect(mapper.apply([
      { kind: "mouse_move", dx: 10, dy: 0 },
      { kind: "mouse_button", button: 2, down: true },
      { kind: "mouse_move", dx: 10, dy: 0 },
    ]).axes[2]).toBeCloseTo(0.3);
  });

  it("applies deterministic smoothing and clears it immediately without movement", () => {
    const value = profile();
    value.mouse.hip.sensitivity_x = 0.01;
    value.mouse.hip.smoothing = 0.5;
    const mapper = new BrowserGamepadMapper(value);
    expect(mapper.apply([{ kind: "mouse_move", dx: 10, dy: 0 }]).axes[2]).toBeCloseTo(0.1);
    expect(mapper.apply([{ kind: "mouse_move", dx: 20, dy: 0 }]).axes[2]).toBeCloseTo(0.15);
    expect(mapper.apply([]).axes[2]).toBe(0);
    expect(mapper.apply([{ kind: "mouse_move", dx: 20, dy: 0 }]).axes[2]).toBeCloseTo(0.2);
    expect(mapper.reset().axes).toEqual([0, 0, 0, 0]);
  });

  it("resets smoothing even when ADS is pressed and released without movement", () => {
    const value = profile();
    value.mouse.hip.sensitivity_x = 0.01;
    value.mouse.hip.smoothing = 0.5;
    value.mouse.ads_activation = { type: "mouse_button", button: 2 };
    const mapper = new BrowserGamepadMapper(value);
    expect(mapper.apply([{ kind: "mouse_move", dx: 10, dy: 0 }]).axes[2]).toBeCloseTo(0.1);
    expect(mapper.apply([
      { kind: "mouse_button", button: 2, down: true },
      { kind: "mouse_button", button: 2, down: false },
      { kind: "mouse_move", dx: 20, dy: 0 },
    ]).axes[2]).toBeCloseTo(0.2);
  });
});

describe("mouseAxis", () => {
  it("matches Rust deadzone, inversion, clamping, and curves", () => {
    expect(mouseAxis(25, 0.02, false, 0, "linear")).toBe(0.5);
    expect(mouseAxis(25, 0.02, false, 0, "exponential")).toBe(0.25);
    expect(mouseAxis(25, 0.02, false, 0, "precision")).toBe(0.125);
    expect(mouseAxis(1, 0.02, false, 0.1, "linear")).toBe(0);
    expect(mouseAxis(1000, 0.2, true, 0, "linear")).toBe(-1);
  });

  it("uses bounded velocity scaling without changing the disabled default", () => {
    expect(mouseAxis(50, 0.01, false, 0, "linear")).toBe(0.5);
    expect(mouseAxis(50, 0.01, false, 0, "linear", 1)).toBe(0.75);
    expect(mouseAxis(100, 0.001, false, 0, "linear", 1)).toBeCloseTo(0.2);
  });
});
