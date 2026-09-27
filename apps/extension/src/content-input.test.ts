import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStarterProfiles } from "./profile-schema";
import { BrowserGamepadMapper } from "./browser-gamepad";

const mocks = vi.hoisted(() => ({
  postMessage: vi.fn(),
}));
vi.mock("./page-bridge", () => ({
  connectPageBridge: async () => ({
    postMessage: mocks.postMessage,
    addEventListener: vi.fn(),
    start: vi.fn(),
  }),
}));
vi.mock("./quick-overlay", () => ({
  parseOverlayState: () => null,
  QuickOverlay: class {
    isOpen() { return false; }
    close() {}
  },
}));

describe("content input dispatch timing", () => {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  let runtimeListener: (
    message: unknown, sender: chrome.runtime.MessageSender, reply: (value: unknown) => void,
  ) => unknown;
  let doc: { documentElement: object; pointerLockElement: object | null; hidden: boolean };

  function key(type: string, code: string, extra: object = {}): void {
    const event = {
      type, code, isTrusted: true, repeat: false, ctrlKey: false, altKey: false,
      shiftKey: false, metaKey: false, preventDefault: vi.fn(),
      stopImmediatePropagation: vi.fn(), ...extra,
    };
    for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
  }

  const batches = () => mocks.postMessage.mock.calls
    .map(([value]) => value)
    .filter(value => value.command === "events");

  function move(dx = 12, dy = -3): void {
    for (const listener of listeners.get("mousemove") ?? []) {
      listener({
        isTrusted: true, movementX: dx, movementY: dy,
        preventDefault: vi.fn(), stopImmediatePropagation: vi.fn(),
      });
    }
  }

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    mocks.postMessage.mockClear();
    listeners.clear();
    const root = { requestPointerLock: vi.fn(async () => { doc.pointerLockElement = root; }) };
    doc = Object.assign(new EventTarget(), {
      documentElement: root, pointerLockElement: null, hidden: false,
      hasFocus: () => true,
      exitPointerLock: () => { doc.pointerLockElement = null; },
    });
    vi.stubGlobal("document", doc);
    vi.stubGlobal("location", { href: "https://www.xbox.com/en-US/play" });
    vi.stubGlobal("window", {
      addEventListener: (type: string, listener: (event: unknown) => void) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(listener);
      },
      removeEventListener: (type: string, listener: (event: unknown) => void) => {
        listeners.get(type)?.delete(listener);
      },
      setInterval, clearInterval, setTimeout, clearTimeout,
    });
    vi.stubGlobal("chrome", {
      runtime: {
        id: "test-extension",
        onMessage: { addListener: (listener: typeof runtimeListener) => { runtimeListener = listener; } },
        sendMessage: vi.fn(async () => ({})),
      },
      storage: {
        local: { get: vi.fn(async () => ({})) },
        onChanged: { addListener: vi.fn() },
      },
    });
    await import("./content");
    key("keydown", "KeyG", { ctrlKey: true, altKey: true });
    // Settle activation promises without advancing the batching timer.
    for (let i = 0; i < 10; i++) await Promise.resolve();
    await new Promise(resolve => runtimeListener({
      type: "browser_activate", profile: createStarterProfiles().profiles[0],
    }, { id: "test-extension" }, resolve));
    mocks.postMessage.mockClear();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("dispatches key down and up before any timer tick", () => {
    key("keydown", "KeyW");
    expect(batches().map(batch => batch.message.events)).toEqual([
      [{ kind: "key", code: "KeyW", down: true }],
    ]);
    key("keyup", "KeyW");
    expect(batches().map(batch => batch.message.events)).toEqual([
      [{ kind: "key", code: "KeyW", down: true }],
      [{ kind: "key", code: "KeyW", down: false }],
    ]);
  });

  it("flushes pending movement before a key transition in the same batch", () => {
    move();
    expect(batches()).toHaveLength(0);
    key("keydown", "KeyW");
    expect(batches()[0].message.events).toEqual([
      { kind: "mouse_move", dx: 12, dy: -3 },
      { kind: "key", code: "KeyW", down: true },
    ]);
  });

  it.each([9, 17])("does not recenter between mouse samples spaced %i ms apart", (interval) => {
    const mapper = new BrowserGamepadMapper(createStarterProfiles().profiles[0]!);
    let consumed = 0;
    for (let sample = 0; sample < 24; sample++) {
      move();
      vi.advanceTimersByTime(interval);
      const pending = batches().slice(consumed);
      consumed += pending.length;
      for (const batch of pending) {
        expect(batch.message.events.length).toBeGreaterThan(0);
        const axes = mapper.apply(batch.message.events).axes;
        expect(axes[2]).toBeCloseTo(0.216);
        expect(axes[3]).toBeCloseTo(-0.054);
      }
    }
    vi.advanceTimersByTime(32);
    const idle = batches().slice(consumed);
    expect(idle.map(batch => batch.message.events)).toEqual([[]]);
    expect(mapper.apply(idle[0].message.events).axes.slice(2)).toEqual([0, 0]);
  });

  it("keeps the idle deadline when keyboard input flushes between mouse samples", () => {
    move();
    vi.advanceTimersByTime(8);
    key("keydown", "KeyW");
    vi.advanceTimersByTime(15);
    expect(batches().map(batch => batch.message.events.length)).toEqual([1, 1]);
    vi.advanceTimersByTime(1);
    expect(batches().map(batch => batch.message.events.length)).toEqual([1, 1, 0]);
    vi.advanceTimersByTime(24);
    expect(batches()).toHaveLength(3);
  });

  it("cancels pending aim output immediately on capture loss", () => {
    move();
    vi.advanceTimersByTime(8);
    for (const listener of listeners.get("blur") ?? []) listener({});
    expect(mocks.postMessage).toHaveBeenLastCalledWith({ command: "deactivate" });
    const count = batches().length;
    vi.advanceTimersByTime(32);
    expect(batches()).toHaveLength(count);
  });

  it("ignores repeats and untrusted input and stops dispatch on blur", () => {
    key("keydown", "KeyW", { repeat: true });
    key("keydown", "KeyW", { isTrusted: false });
    expect(batches()).toHaveLength(0);
    for (const listener of listeners.get("blur") ?? []) listener({});
    key("keydown", "KeyW");
    expect(batches()).toHaveLength(0);
    expect(mocks.postMessage).toHaveBeenCalledWith({ command: "deactivate" });
  });
});
