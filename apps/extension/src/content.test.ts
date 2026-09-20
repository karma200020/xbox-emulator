import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const connection = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("./page-bridge", () => ({ connectPageBridge: connection.connect }));
const quick = vi.hoisted(() => ({
  show: vi.fn(async () => {}),
  close: vi.fn(),
  refresh: vi.fn(async () => {}),
  isOpen: vi.fn(() => false),
}));
vi.mock("./quick-overlay", () => ({
  QuickOverlay: class {
    show = quick.show;
    close = quick.close;
    refresh = quick.refresh;
    isOpen = quick.isOpen;
  },
  parseOverlayState: (value: any) => value?.type === "overlay_state" ? value : null,
}));

class Target {
  handlers = new Map<string, Set<(event: any) => void>>();
  addEventListener(type: string, fn: (event: any) => void) {
    const handlers = this.handlers.get(type) ?? new Set();
    handlers.add(fn);
    this.handlers.set(type, handlers);
  }
  removeEventListener(type: string, fn: (event: any) => void) { this.handlers.get(type)?.delete(fn); }
  emit(type: string, event: object = {}) {
    for (const fn of this.handlers.get(type) ?? []) fn({ type, ...event });
  }
}

describe("content capture lifecycle", () => {
  let listener: (message: object, sender?: object, reply?: (value: any) => void) => unknown;
  let root: { requestPointerLock: ReturnType<typeof vi.fn>; append: ReturnType<typeof vi.fn> };
  let doc: Target & { documentElement: object; pointerLockElement: object | null; fullscreenElement: object | null; hidden: boolean; hasFocus: () => boolean; exitPointerLock: ReturnType<typeof vi.fn> };
  let win: Target;
  let button: Target & { showPopover: ReturnType<typeof vi.fn>; focus: ReturnType<typeof vi.fn> };
  let post: ReturnType<typeof vi.fn>;
  let send: ReturnType<typeof vi.fn>;
  const input = () => ({ isTrusted: true, preventDefault: vi.fn(), stopImmediatePropagation: vi.fn() });
  const runtime = (message: object, sender: object = { id: "extension-id" }) =>
    listener(message, sender, vi.fn());

  async function start() {
    runtime({ type: "arm_capture" });
    button.emit("click", input());
    await vi.advanceTimersByTimeAsync(0);
  }
  async function browser() {
    const { createStarterProfiles } = await import("./profile-schema");
    const reply = vi.fn();
    listener(
      { type: "browser_activate", profile: createStarterProfiles().profiles[0] },
      { id: "extension-id" },
      reply,
    );
    await vi.advanceTimersByTimeAsync(0);
    return reply;
  }

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    post = vi.fn();
    send = vi.fn(async () => ({}));
    connection.connect.mockReset().mockResolvedValue({ postMessage: post });
    Object.values(quick).forEach(mock => mock.mockClear());
    quick.isOpen.mockReturnValue(false);
    root = {
      requestPointerLock: vi.fn(async () => { doc.pointerLockElement = root; }),
      append: vi.fn(),
    };
    let popoverOpen = false;
    button = Object.assign(new Target(), {
      style: {}, setAttribute: vi.fn(), focus: vi.fn(),
      remove: vi.fn(() => { popoverOpen = false; }),
      matches: vi.fn(() => popoverOpen),
      showPopover: vi.fn(() => { popoverOpen = true; }),
    });
    doc = Object.assign(new Target(), {
      documentElement: root, pointerLockElement: null, fullscreenElement: null, hidden: false, hasFocus: () => true,
      exitPointerLock: vi.fn(() => { doc.pointerLockElement = null; }),
      createElement: () => button,
    });
    win = Object.assign(new Target(), { setInterval, clearInterval });
    vi.stubGlobal("document", doc);
    vi.stubGlobal("window", win);
    vi.stubGlobal("location", { origin: "https://www.xbox.com", href: "https://www.xbox.com/en-US/play" });
    vi.stubGlobal("chrome", { runtime: {
      id: "extension-id",
      onMessage: { addListener: (fn: typeof listener) => { listener = fn; } }, sendMessage: send,
    }, storage: {
      local: { get: vi.fn(async () => ({})) },
      onChanged: { addListener: vi.fn() },
    } });
    await import("./content");
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("does not resurrect capture when pointer lock resolves after cancellation", async () => {
    let finish!: () => void;
    root.requestPointerLock.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    runtime({ type: "arm_capture" });
    button.emit("click", input());
    runtime({ type: "stop_capture", reason: "user_requested" });
    doc.pointerLockElement = root;
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(doc.pointerLockElement).toBeNull();
    expect(send).not.toHaveBeenCalledWith({ type: "capture_started" });
  });

  it("rejects delayed browser activation after stop", async () => {
    await start();
    let finish!: (port: object) => void;
    connection.connect.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const reply = await browser();
    runtime({ type: "stop_capture", reason: "escape" });
    finish({ postMessage: post });
    await vi.advanceTimersByTimeAsync(0);
    expect(reply).toHaveBeenCalledWith({ accepted: false });
    expect(post.mock.calls.some(([value]) => value.command === "activate")).toBe(false);
  });

  it("suppresses repeated keys and ignores page-generated input", async () => {
    await start();
    await browser();
    post.mockClear();
    const repeat = { ...input(), code: "Space", repeat: true };
    win.emit("keydown", repeat);
    expect(repeat.preventDefault).toHaveBeenCalledOnce();
    win.emit("keydown", { ...input(), isTrusted: false, code: "Space", repeat: false });
    await vi.advanceTimersByTimeAsync(8);
    expect(post.mock.calls.some(([value]) => value.command === "events")).toBe(false);
  });

  it("rounds fractional movement and routes live input directly", async () => {
    await start();
    await browser();
    win.emit("mousemove", { ...input(), movementX: 1.4, movementY: -2.8 });
    await vi.advanceTimersByTimeAsync(8);
    expect(post).toHaveBeenCalledWith(expect.objectContaining({
      command: "events", message: expect.objectContaining({
        events: [{ kind: "mouse_move", dx: 1, dy: -3 }],
      }),
    }));
  });

  it("stops on SPA navigation away from the permitted route", async () => {
    await start();
    await browser();
    location.href = "https://www.xbox.com/en-US/store";
    await vi.advanceTimersByTimeAsync(8);
    expect(doc.pointerLockElement).toBeNull();
    expect(post).toHaveBeenCalledWith({ command: "deactivate" });
  });

  it("reports stable SPA game-route changes without reading page content", async () => {
    send.mockClear();
    location.href = "https://www.xbox.com/en-US/play/games/Test-Game/ABC123";
    await vi.advanceTimersByTimeAsync(500);
    expect(send).toHaveBeenCalledWith({
      type: "game_identity_changed",
      identity: {
        product_id: "abc123",
        title_slug: "test-game",
        title_name: "test game",
      },
    });
  });

  it("keeps the worker informed even while browser input bypasses it", async () => {
    await start();
    await browser();
    await vi.advanceTimersByTimeAsync(1100);
    expect(send).toHaveBeenCalledWith({ type: "capture_heartbeat" });
    expect(post).toHaveBeenCalledWith({ command: "heartbeat" });
  });

  it("shows a top-layer prompt on fullscreen entry without capturing or stealing focus", () => {
    const fullscreen = { append: vi.fn() };
    doc.fullscreenElement = fullscreen;
    doc.emit("fullscreenchange");
    expect(button.showPopover).toHaveBeenCalledOnce();
    expect(fullscreen.append).toHaveBeenCalledWith(button);
    expect(root.requestPointerLock).not.toHaveBeenCalled();
    expect(button.focus).not.toHaveBeenCalled();
  });

  it("starts from a trusted fullscreen shortcut and stops without exiting fullscreen", async () => {
    const fullscreen = { append: vi.fn() };
    doc.fullscreenElement = fullscreen;
    doc.emit("fullscreenchange");
    const chord = { ...input(), code: "KeyG", ctrlKey: true, altKey: true, repeat: false };
    win.emit("keydown", chord);
    await vi.advanceTimersByTimeAsync(0);
    expect(root.requestPointerLock).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith({ type: "capture_started" });
    await browser();
    win.emit("keydown", chord);
    await vi.advanceTimersByTimeAsync(0);
    expect(doc.pointerLockElement).toBeNull();
    expect(doc.fullscreenElement).toBe(fullscreen);
    expect(send).toHaveBeenCalledWith({ type: "capture_stopped", reason: "keyboard_shortcut" });
  });

  it("also starts from the shortcut outside site fullscreen", async () => {
    win.emit("keydown", { ...input(), code: "KeyG", ctrlKey: true, altKey: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(root.requestPointerLock).toHaveBeenCalledOnce();
  });

  it("opens quick settings with its separate shortcut and neutralizes active capture", async () => {
    await start();
    await browser();
    send.mockClear();
    win.emit("keydown", {
      ...input(), code: "KeyP", ctrlKey: true, altKey: true, shiftKey: false, metaKey: false,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(doc.pointerLockElement).toBeNull();
    expect(send).toHaveBeenCalledWith({ type: "capture_stopped", reason: "quick_overlay" });
    expect(quick.show).toHaveBeenCalledOnce();
  });

  it("lets Escape dismiss an inactive quick overlay", () => {
    quick.isOpen.mockReturnValue(true);
    const escape = { ...input(), code: "Escape" };
    win.emit("keydown", escape);
    expect(quick.close).toHaveBeenCalledOnce();
    expect(escape.preventDefault).toHaveBeenCalledOnce();
    expect(root.requestPointerLock).not.toHaveBeenCalled();
  });

  it("rejects runtime commands that do not come from the extension", () => {
    runtime({ type: "arm_capture" }, { id: "page-script" });
    expect(button.showPopover).not.toHaveBeenCalled();
  });

  it("does not show a stale ambiguous choice after SPA navigation", async () => {
    const { createStarterProfiles } = await import("./profile-schema");
    await start();
    await browser();
    const document = createStarterProfiles();
    runtime({
      type: "overlay_state",
      identity: { product_id: "first", title_slug: "first-game", title_name: "first game" },
      match: "ambiguous",
      candidate_profile_ids: ["default", "fps"],
      active_profile_id: "default",
      profiles: document.profiles.map(profile => ({
        id: profile.id,
        name: profile.name,
        hip_x: profile.mouse.hip.sensitivity_x,
        hip_y: profile.mouse.hip.sensitivity_y,
        ads_x: profile.mouse.ads.sensitivity_x,
        ads_y: profile.mouse.ads.sensitivity_y,
      })),
      capture_active: true,
    });
    expect(quick.show).not.toHaveBeenCalled();
    location.href = "https://www.xbox.com/en-US/play/games/second-game/SECOND";
    await vi.advanceTimersByTimeAsync(500);
    win.emit("keydown", { ...input(), code: "Escape" });
    expect(quick.show).not.toHaveBeenCalled();
  });

  it("uses the shortcut in native video fullscreen instead of an invisible prompt", async () => {
    doc.fullscreenElement = { tagName: "VIDEO", append: vi.fn() };
    doc.emit("fullscreenchange");
    expect(button.showPopover).not.toHaveBeenCalled();
    win.emit("keydown", { ...input(), code: "KeyG", ctrlKey: true, altKey: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(root.requestPointerLock).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith({ type: "capture_started" });
  });

  it("ignores synthetic, repeating and unrelated-page shortcut requests", () => {
    const chord = { ...input(), code: "KeyG", ctrlKey: true, altKey: true };
    win.emit("keydown", { ...chord, isTrusted: false });
    win.emit("keydown", { ...chord, repeat: true });
    location.href = "https://www.xbox.com/en-US/store";
    win.emit("keydown", chord);
    doc.fullscreenElement = { append: vi.fn() };
    doc.emit("fullscreenchange");
    expect(root.requestPointerLock).not.toHaveBeenCalled();
    expect(button.showPopover).not.toHaveBeenCalled();
  });

  it("dismisses an idle fullscreen prompt with Escape without reopening it", async () => {
    doc.fullscreenElement = { append: vi.fn() };
    doc.emit("fullscreenchange");
    win.emit("keydown", { ...input(), code: "Escape" });
    await vi.advanceTimersByTimeAsync(2000);
    expect(button.showPopover).toHaveBeenCalledOnce();
    expect(root.requestPointerLock).not.toHaveBeenCalled();
  });

  it("does not auto-prompt while capture is already active", async () => {
    await start();
    button.showPopover.mockClear();
    doc.fullscreenElement = { append: vi.fn() };
    doc.emit("fullscreenchange");
    expect(button.showPopover).not.toHaveBeenCalled();
  });
});
