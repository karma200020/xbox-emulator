import { BrowserGamepadMapper, neutralState, type XboxState } from "./browser-gamepad";
import { PROFILE_SCHEMA_VERSION, parseSelectedProfile } from "./profile-schema";
import { isInputEventsMessage } from "./protocol";
import { isXboxPlayUrl } from "./xbox-url";

const originalGetGamepads = navigator.getGamepads.bind(navigator);
let mapper: BrowserGamepadMapper | null = null;
let active = false;
let timestamp = 0;
let state = neutralState();
let index = 0;
let lastHeartbeat = 0;
let watchdog: ReturnType<typeof setInterval> | null = null;

type MutableGamepadButton = {
  pressed: boolean;
  touched: boolean;
  value: number;
};

const axes = [...state.axes];
const buttons = state.buttons.map((value) => gamepadButton(value));
const gamepad = {
  id: "Xbox 360 Controller (XInput STANDARD GAMEPAD)",
  index,
  connected: false,
  timestamp,
  mapping: "standard",
  axes,
  buttons,
  vibrationActuator: null,
} as unknown as Gamepad;

Object.defineProperties(gamepad, {
  index: { enumerable: true, get: () => index },
  connected: { enumerable: true, get: () => active },
  timestamp: { enumerable: true, get: () => timestamp },
  axes: { enumerable: true, get: () => axes },
  buttons: { enumerable: true, get: () => buttons },
});

Object.defineProperty(navigator, "getGamepads", {
  configurable: true,
  value: (): (Gamepad | null)[] => {
    const real = Array.from(originalGetGamepads());
    if (!active) return real;
    if (real[index] !== null && real[index] !== undefined) {
      moveToIndex(firstFreeIndex(real));
    }
    if (real.length <= index) real.length = index + 1;
    real[index] = gamepad;
    return real;
  },
});

let bridgePort: MessagePort | null = null;
let bridgeNonce: string | null = null;
window.addEventListener("message", (event) => {
  if (
    event.source !== window ||
    event.origin !== location.origin ||
    !isRecord(event.data) ||
    !hasExactKeys(event.data, ["type", "nonce"]) ||
    event.data.type !== "xib_bridge_init_v1" ||
    typeof event.data.nonce !== "string" ||
    event.ports.length !== 1
  ) {
    return;
  }
  if (bridgePort) {
    if (event.data.nonce === bridgeNonce || active || !canCapture()) return;
    bridgePort.close();
  }
  bridgeNonce = event.data.nonce;
  bridgePort = event.ports[0]!;
  bridgePort.addEventListener("message", receiveBridgeMessage);
  bridgePort.start();
  bridgePort.postMessage({
    type: "xib_bridge_ready_v1",
    nonce: event.data.nonce,
  });
});

function receiveBridgeMessage(event: MessageEvent<unknown>): void {
  const detail = event.data;
  if (!isRecord(detail) || typeof detail.command !== "string") return;
  if (detail.command === "activate" && hasExactKeys(detail, ["command", "profile"])) {
    activate(detail.profile);
  } else if (
    detail.command === "events" &&
    (hasExactKeys(detail, ["command", "message"]) ||
      (hasExactKeys(detail, ["command", "message", "batch_id"]) &&
        Number.isSafeInteger(detail.batch_id))) &&
    active &&
    isInputEventsMessage(detail.message)
  ) {
    const started = performance.now();
    update(mapper!.apply(detail.message.events));
    if (Number.isSafeInteger(detail.batch_id)) {
      bridgePort?.postMessage({
        type: "xib_diagnostics_v1",
        batch_id: detail.batch_id,
        mapping_duration_ms: Math.max(0, performance.now() - started),
      });
    }
  } else if (detail.command === "heartbeat" && hasExactKeys(detail, ["command"]) && active) {
    if (canCapture()) lastHeartbeat = performance.now();
    else deactivate("capture_context_lost", true);
  } else if (detail.command === "deactivate" && hasExactKeys(detail, ["command"])) {
    deactivate();
  } else if (
    detail.command === "diagnostics_ping" &&
    hasExactKeys(detail, ["command", "nonce"]) &&
    typeof detail.nonce === "string" &&
    detail.nonce.length <= 64
  ) {
    bridgePort?.postMessage({
      type: "xib_diagnostics_pong_v1",
      nonce: detail.nonce,
      watchdog: watchdog !== null,
    });
  }
}

function activate(rawProfile: unknown): void {
  const parsed = parseSelectedProfile({
    schema_version: PROFILE_SCHEMA_VERSION,
    active_profile_id: isRecord(rawProfile) ? rawProfile.id : undefined,
    profiles: [rawProfile],
  });
  if (!parsed.ok || !canCapture()) {
    deactivate();
    console.warn("Xbox Input Bridge rejected an invalid profile or inactive capture context.");
    return;
  }
  if (active) deactivate();
  mapper = new BrowserGamepadMapper(parsed.profile);
  update(mapper.reset());
  active = true;
  index = firstFreeIndex(Array.from(originalGetGamepads()));
  lastHeartbeat = performance.now();
  watchdog = setInterval(() => {
    if (!canCapture()) deactivate("capture_context_lost", true);
    else if (performance.now() - lastHeartbeat > 1500) deactivate("main_watchdog_timeout", true);
  }, 250);
  dispatchGamepadEvent("gamepadconnected");
}

function deactivate(reason = "deactivated", report = false): void {
  if (watchdog !== null) clearInterval(watchdog);
  watchdog = null;
  if (!active) return;
  update(mapper?.reset() ?? neutralState());
  active = false;
  dispatchGamepadEvent("gamepaddisconnected");
  mapper = null;
  if (report) bridgePort?.postMessage({ type: "xib_main_stop_v1", reason });
}

function moveToIndex(nextIndex: number): void {
  active = false;
  dispatchGamepadEvent("gamepaddisconnected", {
    ...gamepad, connected: false, axes: [0, 0, 0, 0],
    buttons: neutralState().buttons.map(gamepadButton),
  });
  index = nextIndex;
  active = true;
  dispatchGamepadEvent("gamepadconnected");
}

function update(next: XboxState): void {
  state = next;
  for (let position = 0; position < axes.length; position += 1) {
    axes[position] = next.axes[position] ?? 0;
  }
  for (let position = 0; position < buttons.length; position += 1) {
    const value = next.buttons[position] ?? 0;
    const button = buttons[position]!;
    button.value = value;
    button.pressed = value > 0.5;
    button.touched = value > 0;
  }
  bumpTimestamp();
}

function bumpTimestamp(): void {
  timestamp = Math.max(timestamp + 0.001, performance.now());
}

function dispatchGamepadEvent(
  type: "gamepadconnected" | "gamepaddisconnected",
  eventGamepad: Gamepad = gamepad,
): void {
  let event: Event;
  try {
    event = new GamepadEvent(type, { gamepad: eventGamepad });
  } catch {
    event = new Event(type);
    Object.defineProperty(event, "gamepad", { value: eventGamepad });
  }
  window.dispatchEvent(event);
}

function gamepadButton(value: number): MutableGamepadButton {
  return { pressed: value > 0.5, touched: value > 0, value };
}

function firstFreeIndex(gamepads: readonly (Gamepad | null)[]): number {
  const free = gamepads.findIndex((item) => item == null);
  return free < 0 ? gamepads.length : free;
}

function canCapture(): boolean {
  return isXboxPlayUrl(location.href) && !document.hidden &&
    document.hasFocus() && document.pointerLockElement === document.documentElement;
}

window.addEventListener("blur", () => deactivate("window_blur", true));
window.addEventListener("pagehide", () => deactivate("page_hidden", true));
document.addEventListener("visibilitychange", () => {
  if (document.hidden) deactivate("document_hidden", true);
});
document.addEventListener("pointerlockchange", () => {
  if (!canCapture()) deactivate("pointer_lock_lost", true);
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}
