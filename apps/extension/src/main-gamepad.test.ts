import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStarterProfiles } from "./profile-schema";

describe("MAIN-world gamepad lifecycle", () => {
  let win: EventTarget;
  let doc: EventTarget & { hidden: boolean; hasFocus: () => boolean; documentElement: object; pointerLockElement: object | null };
  let port: EventTarget & { start: ReturnType<typeof vi.fn>; postMessage: ReturnType<typeof vi.fn> };
  let real: (Gamepad | null)[];
  let nav: { getGamepads: () => (Gamepad | null)[] };

  function command(data: object): void {
    port.dispatchEvent(new MessageEvent("message", { data }));
  }
  function activate(): void {
    command({ command: "activate", profile: createStarterProfiles().profiles[0] });
  }

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
    win = new EventTarget();
    const root = {};
    doc = Object.assign(new EventTarget(), {
      hidden: false, hasFocus: () => true, documentElement: root, pointerLockElement: root,
    });
    real = [null, null, null, null];
    nav = { getGamepads: () => [...real] };
    port = Object.assign(new EventTarget(), { start: vi.fn(), postMessage: vi.fn() });
    vi.stubGlobal("window", win);
    vi.stubGlobal("document", doc);
    vi.stubGlobal("navigator", nav);
    vi.stubGlobal("location", { origin: "https://www.xbox.com", href: "https://www.xbox.com/en-US/play" });
    await import("./main-gamepad");
    const event = new Event("message");
    Object.defineProperties(event, {
      source: { value: win }, origin: { value: "https://www.xbox.com" },
      data: { value: { type: "xib_bridge_init_v1", nonce: "test" } },
      ports: { value: [port] },
    });
    win.dispatchEvent(event);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("neutralizes held controls when the content script stops heartbeating", () => {
    activate();
    const pad = nav.getGamepads()[0]!;
    command({ command: "events", message: {
      type: "browser_events", events: [{ kind: "key", code: "Space", down: true }], timestamp_ms: 1,
    } });
    expect(pad.buttons[0]!.pressed).toBe(true);
    vi.advanceTimersByTime(1750);
    expect(nav.getGamepads().every(p => p === null)).toBe(true);
    expect(pad.connected).toBe(false);
    expect(pad.buttons.every(b => b.value === 0)).toBe(true);
  });

  it("updates cached native-style axes, button arrays, and button objects in place", () => {
    activate();
    const pad = nav.getGamepads()[0]!;
    const axes = pad.axes;
    const buttons = pad.buttons;
    const faceA = buttons[0]!;
    command({ command: "events", message: {
      type: "browser_events",
      events: [
        { kind: "key", code: "KeyW", down: true },
        { kind: "key", code: "Space", down: true },
      ],
      timestamp_ms: 1,
    } });
    expect(pad.axes).toBe(axes);
    expect(pad.buttons).toBe(buttons);
    expect(pad.buttons[0]).toBe(faceA);
    expect(axes[1]).toBe(-1);
    expect(faceA.pressed).toBe(true);
    expect(faceA.value).toBe(1);
  });

  it("keeps a held key with live heartbeats, then disconnects immediately on lock loss", () => {
    activate();
    for (let i = 0; i < 12; i++) {
      vi.advanceTimersByTime(250);
      command({ command: "heartbeat" });
    }
    expect(nav.getGamepads()[0]?.connected).toBe(true);
    doc.pointerLockElement = null;
    doc.dispatchEvent(new Event("pointerlockchange"));
    expect(nav.getGamepads()[0]).toBeNull();
  });

  it("rejects activation outside pointer lock and on unrelated Xbox routes", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    doc.pointerLockElement = null;
    activate();
    expect(nav.getGamepads()[0]).toBeNull();
    doc.pointerLockElement = doc.documentElement;
    location.href = "https://www.xbox.com/en-US/playground";
    activate();
    expect(nav.getGamepads()[0]).toBeNull();
    vi.restoreAllMocks();
  });

  it("preserves real controllers and disconnect event identity when moving a colliding slot", () => {
    activate();
    const disconnected: Gamepad[] = [];
    win.addEventListener("gamepaddisconnected", event => {
      disconnected.push((event as GamepadEvent).gamepad);
    });
    const physical = { id: "Physical", index: 0, connected: true } as Gamepad;
    real[0] = physical;
    const pads = nav.getGamepads();
    expect(pads[0]).toBe(physical);
    expect(pads[1]?.index).toBe(1);
    expect(disconnected[0]?.index).toBe(0);
    expect(disconnected[0]?.connected).toBe(false);
    real[0] = null;
    expect(nav.getGamepads()[1]?.index).toBe(1);
  });

  it("clears the previous held state if a replacement profile is invalid", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    activate();
    command({ command: "activate", profile: {} });
    expect(nav.getGamepads()[0]).toBeNull();
    vi.restoreAllMocks();
  });

  it("neutralizes held physical state before activating a replacement profile", () => {
    activate();
    const previousPad = nav.getGamepads()[0]!;
    command({ command: "events", message: {
      type: "browser_events",
      events: [{ kind: "key", code: "Space", down: true }],
      timestamp_ms: 1,
    } });
    expect(previousPad.buttons[0]!.pressed).toBe(true);
    command({ command: "activate", profile: createStarterProfiles().profiles[1] });
    expect(previousPad.buttons.every(button => button.value === 0)).toBe(true);
    expect(nav.getGamepads()[0]?.buttons.every(button => button.value === 0)).toBe(true);
  });
});
