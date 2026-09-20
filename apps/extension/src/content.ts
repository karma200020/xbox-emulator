import {
  MAX_BATCH_EVENTS,
  isRuntimeMessage,
  type InputEvent,
  type RuntimeMessage,
} from "./protocol";
import { connectPageBridge } from "./page-bridge";
import { isXboxPlayUrl } from "./xbox-url";

const FLUSH_INTERVAL_MS = 8;

let armed = false;
let active = false;
let browserActive = false;
let overlay: HTMLButtonElement | null = null;
let events: InputEvent[] = [];
let flushTimer: number | null = null;
let needsMouseNeutral = false;
let bridgePort: MessagePort | null = null;
let bridgeConnection: Promise<MessagePort> | null = null;
let captureGeneration = 0;
let lastHeartbeat = 0;
let lastWorkerHeartbeat = 0;
let activationPending = false;

chrome.runtime.onMessage.addListener((rawMessage: unknown, _sender, sendResponse) => {
  if (!isRuntimeMessage(rawMessage)) return;
  if (rawMessage.type === "arm_capture") armCapture();
  if (rawMessage.type === "stop_capture") stopCapture(rawMessage.reason);
  if (rawMessage.type === "browser_activate") {
    const generation = captureGeneration;
    void activateBrowser(rawMessage, generation).then(sendResponse, (error: unknown) => {
      if (generation === captureGeneration) stopCapture("browser_bridge_unavailable");
      sendResponse({ accepted: false, error: error instanceof Error ? error.message : "Browser bridge failed" });
    });
    return true;
  }
  if (rawMessage.type === "browser_events" && active && browserActive) {
    bridgeEvents(rawMessage.events, rawMessage.timestamp_ms);
  }
  if (rawMessage.type === "browser_deactivate") {
    browserActive = false;
    bridge({ command: "deactivate" });
  }
});

async function activateBrowser(
  message: Extract<RuntimeMessage, { type: "browser_activate" }>,
  generation: number,
): Promise<{ accepted: boolean }> {
  if (!active || !canCapture()) return { accepted: false };
  if (!bridgePort) {
    bridgeConnection ??= connectPageBridge();
    try {
      bridgePort = await bridgeConnection;
    } finally {
      bridgeConnection = null;
    }
  }
  if (!active || generation !== captureGeneration || !canCapture()) return { accepted: false };
  browserActive = true;
  events = [];
  needsMouseNeutral = false;
  bridge({ command: "activate", profile: message.profile });
  return { accepted: true };
}

window.addEventListener("blur", () => stopCapture("window_blur"));
window.addEventListener("pagehide", () => stopCapture("page_hidden"));
window.addEventListener("keydown", onCaptureShortcut, true);
document.addEventListener("fullscreenchange", () => {
  if (active || activationPending) return;
  if (document.fullscreenElement && isXboxPlayUrl(location.href)) {
    if (!overlayParent()) {
      if (armed) stopCapture("fullscreen_surface_changed");
      return;
    }
    if (overlay) showOverlay();
    else armCapture(false);
  } else if (armed) {
    stopCapture("fullscreen_exited");
  }
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopCapture("document_hidden");
});
document.addEventListener("pointerlockchange", () => {
  if (active && document.pointerLockElement !== document.documentElement) {
    stopCapture("pointer_lock_lost");
  }
});

function armCapture(focus = true): void {
  if (armed || active || !isXboxPlayUrl(location.href) || !overlayParent()) return;
  armed = true;
  overlay = document.createElement("button");
  overlay.type = "button";
  overlay.popover = "manual";
  overlay.textContent = "Click to activate Xbox Input Bridge";
  overlay.setAttribute("aria-label", overlay.textContent);
  Object.assign(overlay.style, {
    position: "fixed",
    zIndex: "2147483647",
    left: "50%",
    top: "24px",
    transform: "translateX(-50%)",
    margin: "0",
    right: "auto",
    bottom: "auto",
    padding: "12px 18px",
    color: "#fff",
    background: "#107c10",
    border: "2px solid #fff",
    borderRadius: "6px",
    font: "600 14px system-ui, sans-serif",
    boxShadow: "0 4px 20px #0008",
    cursor: "pointer",
  });
  overlay.addEventListener(
    "click",
    (event) => {
      if (!event.isTrusted) return;
      preventDefault(event);
      void activateCapture();
    },
  );
  showOverlay();
  if (focus) overlay.focus();
}

function showOverlay(): void {
  // A large z-index cannot appear over a fullscreen element; use the top layer.
  if (!overlay) return;
  const parent = overlayParent();
  if (!parent) return;
  if (overlay.parentElement !== parent) parent.append(overlay);
  if (!overlay.matches(":popover-open")) overlay.showPopover();
}

function overlayParent(): Element | null {
  const fullscreen = document.fullscreenElement;
  // Replaced elements cannot render an HTML prompt; the shortcut still works.
  if (fullscreen && /^(VIDEO|AUDIO|CANVAS|IFRAME|IMG|OBJECT|EMBED)$/.test(fullscreen.tagName)) return null;
  return fullscreen ?? document.documentElement;
}

function onCaptureShortcut(event: KeyboardEvent): void {
  if (!event.isTrusted || !isXboxPlayUrl(location.href) || document.hidden || !document.hasFocus()) return;
  if (event.code === "Escape" && armed) {
    stopCapture("escape");
    return;
  }
  if (event.code !== "KeyG" || !event.ctrlKey || !event.altKey || event.metaKey || event.shiftKey) return;
  preventDefault(event);
  if (event.repeat) return;
  if (active || activationPending) {
    stopCapture("keyboard_shortcut");
  } else {
    armed = true;
    void activateCapture();
  }
}

async function activateCapture(): Promise<void> {
  if (active || activationPending || !armed) return;
  activationPending = true;
  const generation = ++captureGeneration;
  try {
    await document.documentElement.requestPointerLock();
    if (!armed || generation !== captureGeneration || !canCapture()) {
      if (!active && document.pointerLockElement === document.documentElement) document.exitPointerLock();
      return;
    }
    armed = false;
    active = true;
    overlay?.remove();
    overlay = null;
    installInputListeners();
    flushTimer = window.setInterval(flush, FLUSH_INTERVAL_MS);
    await send({ type: "capture_started" });
  } catch {
    if (generation === captureGeneration) stopCapture("pointer_lock_denied");
  } finally {
    if (generation === captureGeneration) activationPending = false;
  }
}

function stopCapture(reason: string): void {
  captureGeneration += 1;
  activationPending = false;
  browserActive = false;
  if (!armed && !active) return;
  armed = false;
  const wasActive = active;
  active = false;
  overlay?.remove();
  overlay = null;
  removeInputListeners();
  if (flushTimer !== null) window.clearInterval(flushTimer);
  flushTimer = null;
  events = [];
  needsMouseNeutral = false;
  bridge({ command: "deactivate" });
  if (document.pointerLockElement === document.documentElement) {
    document.exitPointerLock();
  }
  if (wasActive) void send({ type: "capture_stopped", reason }).catch(reportRuntimeFailure);
}

function bridge(detail: Readonly<Record<string, unknown>>): void {
  bridgePort?.postMessage(detail);
}

function bridgeEvents(inputEvents: InputEvent[], timestampMs: number): void {
  bridge({
    command: "events",
    message: {
      type: "browser_events",
      events: inputEvents,
      timestamp_ms: timestampMs,
    },
  });
}

function canCapture(): boolean {
  return document.pointerLockElement === document.documentElement &&
    !document.hidden && document.hasFocus() && isXboxPlayUrl(location.href);
}

function installInputListeners(): void {
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("keyup", onKey, true);
  window.addEventListener("mousemove", onMouseMove, true);
  window.addEventListener("mousedown", onMouseButton, true);
  window.addEventListener("mouseup", onMouseButton, true);
  window.addEventListener("wheel", onWheel, { capture: true, passive: false });
  window.addEventListener("contextmenu", preventDefault, true);
}

function removeInputListeners(): void {
  window.removeEventListener("keydown", onKey, true);
  window.removeEventListener("keyup", onKey, true);
  window.removeEventListener("mousemove", onMouseMove, true);
  window.removeEventListener("mousedown", onMouseButton, true);
  window.removeEventListener("mouseup", onMouseButton, true);
  window.removeEventListener("wheel", onWheel, true);
  window.removeEventListener("contextmenu", preventDefault, true);
}

function onKey(event: KeyboardEvent): void {
  if (!active || !event.isTrusted) return;
  if (event.code === "Escape") {
    stopCapture("escape");
    return;
  }
  preventDefault(event);
  if (event.repeat) return;
  enqueue({ kind: "key", code: event.code, down: event.type === "keydown" });
}

function onMouseMove(event: MouseEvent): void {
  if (!active || !event.isTrusted || (event.movementX === 0 && event.movementY === 0)) return;
  preventDefault(event);
  enqueue({ kind: "mouse_move", dx: Math.round(event.movementX), dy: Math.round(event.movementY) });
}

function onMouseButton(event: MouseEvent): void {
  if (!active || !event.isTrusted || event.button < 0 || event.button > 4) return;
  preventDefault(event);
  enqueue({
    kind: "mouse_button",
    button: event.button,
    down: event.type === "mousedown",
  });
}

function onWheel(event: WheelEvent): void {
  if (!active || !event.isTrusted) return;
  preventDefault(event);
  enqueue({ kind: "wheel", delta_y: Math.round(event.deltaY) });
}

function preventDefault(event: Event): void {
  event.preventDefault();
  event.stopImmediatePropagation();
}

function enqueue(event: InputEvent): void {
  if (events.length >= MAX_BATCH_EVENTS) {
    stopCapture("input_overflow");
    return;
  }
  events.push(event);
}

function flush(): void {
  if (!active) return;
  if (!canCapture()) {
    stopCapture("capture_context_lost");
    return;
  }
  const now = performance.now();
  if (browserActive && now - lastHeartbeat >= 250) {
    lastHeartbeat = now;
    bridge({ command: "heartbeat" });
  }
  if (now - lastWorkerHeartbeat >= 1000) {
    lastWorkerHeartbeat = now;
    void send({ type: "capture_heartbeat" }).catch((error: unknown) => {
      stopCapture("extension_unavailable");
      reportRuntimeFailure(error);
    });
  }
  if (events.length === 0) {
    if (!needsMouseNeutral) return;
    needsMouseNeutral = false;
    sendInputEvents([]);
    return;
  }
  const batch = events;
  events = [];
  needsMouseNeutral = batch.some((event) => event.kind === "mouse_move");
  sendInputEvents(batch);
}

function sendInputEvents(inputEvents: InputEvent[]): void {
  const timestampMs = Date.now();
  if (browserActive) {
    bridgeEvents(inputEvents, timestampMs);
    return;
  }
  void send({
    type: "input_events",
    events: inputEvents,
    timestamp_ms: timestampMs,
  }).catch((error: unknown) => {
    stopCapture("extension_unavailable");
    reportRuntimeFailure(error);
  });
}

function send(message: RuntimeMessage): Promise<unknown> {
  return Promise.resolve().then(() => chrome.runtime.sendMessage(message));
}

function reportRuntimeFailure(error: unknown): void {
  console.warn("Xbox Input Bridge runtime communication failed:", error);
}
