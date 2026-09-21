import {
  MAX_BATCH_EVENTS,
  isRuntimeMessage,
  type InputEvent,
  type RuntimeMessage,
} from "./protocol";
import { connectPageBridge } from "./page-bridge";
import { isXboxPlayUrl } from "./xbox-url";
import { parseXcloudGameIdentity } from "./game-profile";
import {
  DEFAULT_OVERLAY_SHORTCUT,
  OVERLAY_SHORTCUT_STORAGE_KEY,
  matchesOverlayShortcut,
  parseOverlayShortcut,
  type OverlayShortcutId,
} from "./overlay-shortcut";
import { parseOverlayState, QuickOverlay } from "./quick-overlay";
import { t } from "./i18n";
import type { DiagnosticsSample } from "./diagnostics";

const FLUSH_INTERVAL_MS = 8;
const MIN_MOUSE_BUTTON_PRESS_MS = 40;

let armed = false;
let active = false;
let browserActive = false;
let overlay: HTMLButtonElement | null = null;
const mouseButtonDownAt = new Map<number, number>();
const mouseButtonReleaseTimers = new Map<number, number>();
let events: InputEvent[] = [];
let flushTimer: number | null = null;
let needsMouseNeutral = false;
let bridgePort: MessagePort | null = null;
let bridgeConnection: Promise<MessagePort> | null = null;
let captureGeneration = 0;
let lastHeartbeat = 0;
let lastWorkerHeartbeat = 0;
let activationPending = false;
let overlayShortcut: OverlayShortcutId = DEFAULT_OVERLAY_SHORTCUT;
let observedHref = "";
let pendingAmbiguousState: Extract<RuntimeMessage, { type: "overlay_state" }> | null = null;
let diagnosticSample: DiagnosticsSample = emptyDiagnosticSample();
let lastDiagnosticReport = 0;
let diagnosticBatchSequence = 0;
const pendingDiagnosticBatches = new Map<number, number>();
const pendingDiagnosticPings = new Map<string, (healthy: boolean) => void>();

const quickOverlay = new QuickOverlay(document, {
  getState: () => requestOverlayState({ type: "get_overlay_state" }),
  selectProfile: (profileId, associate) => requestOverlayState({
    type: "select_profile",
    profile_id: profileId,
    associate,
  }),
  saveSensitivity: (profileId, values) => requestOverlayState({
    type: "update_profile_sensitivity",
    profile_id: profileId,
    ...values,
  }),
});

chrome.runtime.onMessage.addListener((rawMessage: unknown, sender, sendResponse) => {
  if (!isExtensionSender(sender) || !isRuntimeMessage(rawMessage)) return;
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
  if (rawMessage.type === "diagnostics_ping") {
    void runBridgeSelfTest().then(sendResponse);
    return true;
  }
  if (rawMessage.type === "overlay_state") {
    pendingAmbiguousState = rawMessage.match === "ambiguous" ? rawMessage : null;
    if (quickOverlay.isOpen()) {
      void quickOverlay.refresh(rawMessage);
    } else if (rawMessage.match === "ambiguous" && !active && !activationPending) {
      const parent = overlayParent();
      if (parent) {
        pendingAmbiguousState = null;
        void quickOverlay.show(parent, rawMessage, false);
      }
    }
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
      bridgePort.addEventListener?.("message", receiveBridgeDiagnostics);
      bridgePort.start?.();
    } finally {
      bridgeConnection = null;
    }
  }
  if (!active || generation !== captureGeneration || !canCapture()) return { accepted: false };
  browserActive = true;
  events = [];
  clearMouseButtonPulses();
  needsMouseNeutral = false;
  bridge({ command: "activate", profile: message.profile });
  return { accepted: true };
}

window.addEventListener("blur", () => stopCapture("window_blur"));
window.addEventListener("pagehide", () => stopCapture("page_hidden"));
window.addEventListener("keydown", onCaptureShortcut, true);
window.addEventListener("popstate", observeNavigation);
window.addEventListener("hashchange", observeNavigation);
window.setInterval(observeNavigation, 500);
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && OVERLAY_SHORTCUT_STORAGE_KEY in changes) {
    overlayShortcut = parseOverlayShortcut(changes[OVERLAY_SHORTCUT_STORAGE_KEY]?.newValue);
  }
});
void chrome.storage.local.get(OVERLAY_SHORTCUT_STORAGE_KEY).then((stored) => {
  overlayShortcut = parseOverlayShortcut(stored[OVERLAY_SHORTCUT_STORAGE_KEY]);
}).catch(reportRuntimeFailure);
observeNavigation();
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
  overlay.textContent = t("activationPrompt");
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
  if (matchesOverlayShortcut(event, overlayShortcut)) {
    preventDefault(event);
    if (event.repeat) return;
    void toggleQuickOverlay();
    return;
  }
  if (event.code === "Escape" && quickOverlay.isOpen()) {
    preventDefault(event);
    quickOverlay.close();
    if (active || armed || activationPending) stopCapture("escape");
    return;
  }
  if (event.code === "Escape" && armed) {
    quickOverlay.close();
    stopCapture("escape");
    return;
  }
  if (event.code !== "KeyG" || !event.ctrlKey || !event.altKey || event.metaKey || event.shiftKey) return;
  preventDefault(event);
  if (event.repeat) return;
  quickOverlay.close();
  if (active || activationPending) {
    stopCapture("keyboard_shortcut");
  } else {
    armed = true;
    void activateCapture();
  }
}

async function toggleQuickOverlay(): Promise<void> {
  if (quickOverlay.isOpen()) {
    quickOverlay.close();
    return;
  }
  if (armed || active || activationPending) stopCapture("quick_overlay");
  pendingAmbiguousState = null;
  let parent = overlayParent();
  if (!parent && document.fullscreenElement && typeof document.exitFullscreen === "function") {
    await document.exitFullscreen();
    parent = document.documentElement;
  }
  if (parent) await quickOverlay.show(parent);
}

function observeNavigation(): void {
  if (location.href === observedHref) return;
  observedHref = location.href;
  pendingAmbiguousState = null;
  const identity = parseXcloudGameIdentity(location.href);
  void send({ type: "game_identity_changed", identity }).catch(reportRuntimeFailure);
  if (!isXboxPlayUrl(location.href)) {
    quickOverlay.close();
    stopCapture("tab_navigated");
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
  clearMouseButtonPulses();
  needsMouseNeutral = false;
  reportDiagnostics(true);
  pendingDiagnosticBatches.clear();
  bridge({ command: "deactivate" });
  if (document.pointerLockElement === document.documentElement) {
    document.exitPointerLock();
  }
  if (wasActive) void send({ type: "capture_stopped", reason }).catch(reportRuntimeFailure);
  if (reason !== "quick_overlay" && pendingAmbiguousState) {
    const pending = pendingAmbiguousState;
    const parent = overlayParent();
    if (parent) {
      pendingAmbiguousState = null;
      void quickOverlay.show(parent, pending, false);
    }
  }
}

function bridge(detail: Readonly<Record<string, unknown>>): void {
  bridgePort?.postMessage(detail);
}

function bridgeEvents(inputEvents: InputEvent[], timestampMs: number): void {
  const batchId = ++diagnosticBatchSequence;
  pendingDiagnosticBatches.set(batchId, performance.now());
  if (pendingDiagnosticBatches.size > 32) {
    const oldest = pendingDiagnosticBatches.keys().next().value as number | undefined;
    if (oldest !== undefined) pendingDiagnosticBatches.delete(oldest);
  }
  bridge({
    command: "events",
    batch_id: batchId,
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
    quickOverlay.close();
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
  if (event.type === "mousedown") {
    const pendingRelease = mouseButtonReleaseTimers.get(event.button);
    if (pendingRelease !== undefined) {
      window.clearTimeout(pendingRelease);
      mouseButtonReleaseTimers.delete(event.button);
      enqueue({ kind: "mouse_button", button: event.button, down: false });
      flush();
    }
    if (mouseButtonDownAt.has(event.button)) return;
    mouseButtonDownAt.set(event.button, performance.now());
    enqueue({ kind: "mouse_button", button: event.button, down: true });
    flush();
    return;
  }
  const pressedAt = mouseButtonDownAt.get(event.button);
  if (pressedAt === undefined) return;
  mouseButtonDownAt.delete(event.button);
  const remaining = Math.max(0, MIN_MOUSE_BUTTON_PRESS_MS - (performance.now() - pressedAt));
  if (remaining === 0) {
    enqueue({ kind: "mouse_button", button: event.button, down: false });
    flush();
    return;
  }
  const timer = window.setTimeout(() => {
    mouseButtonReleaseTimers.delete(event.button);
    if (!active) return;
    enqueue({ kind: "mouse_button", button: event.button, down: false });
    flush();
  }, remaining);
  mouseButtonReleaseTimers.set(event.button, timer);
}

function clearMouseButtonPulses(): void {
  for (const timer of mouseButtonReleaseTimers.values()) window.clearTimeout(timer);
  mouseButtonReleaseTimers.clear();
  mouseButtonDownAt.clear();
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
    diagnosticSample.dropped_events += 1;
    stopCapture("input_overflow");
    return;
  }
  events.push(event);
  diagnosticSample.input_events += 1;
}

function flush(): void {
  if (!active) return;
  if (!canCapture()) {
    stopCapture("capture_context_lost");
    return;
  }
  const now = performance.now();
  if (now - lastDiagnosticReport >= 1000) reportDiagnostics();
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
  diagnosticSample.batches += 1;
  diagnosticSample.batch_events += batch.length;
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

async function requestOverlayState(message: RuntimeMessage): Promise<
  Extract<RuntimeMessage, { type: "overlay_state" }> | null
> {
  return parseOverlayState(await send(message));
}

function isExtensionSender(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && sender.tab === undefined;
}

function reportRuntimeFailure(error: unknown): void {
  console.warn("Xbox Input Bridge runtime communication failed:", error);
}

function receiveBridgeDiagnostics(event: MessageEvent<unknown>): void {
  if (typeof event.data !== "object" || event.data === null || Array.isArray(event.data)) return;
  const detail = event.data as Record<string, unknown>;
  if (
    Object.keys(detail).length === 3 &&
    detail.type === "xib_diagnostics_v1" &&
    Number.isSafeInteger(detail.batch_id) &&
    typeof detail.mapping_duration_ms === "number" &&
    Number.isFinite(detail.mapping_duration_ms)
  ) {
    const batchId = Number(detail.batch_id);
    const started = pendingDiagnosticBatches.get(batchId);
    pendingDiagnosticBatches.delete(batchId);
    if (started !== undefined) {
      pushBounded(diagnosticSample.mapping_durations_ms, detail.mapping_duration_ms);
      pushBounded(diagnosticSample.pipeline_estimates_ms, Math.max(0, performance.now() - started));
    }
    return;
  }
  if (
    Object.keys(detail).length === 2 &&
    detail.type === "xib_main_stop_v1" &&
    typeof detail.reason === "string" &&
    detail.reason.length <= 64
  ) {
    stopCapture(detail.reason);
    return;
  }
  if (
    Object.keys(detail).length === 3 &&
    detail.type === "xib_diagnostics_pong_v1" &&
    typeof detail.nonce === "string" &&
    typeof detail.watchdog === "boolean"
  ) {
    pendingDiagnosticPings.get(detail.nonce)?.(detail.watchdog);
    pendingDiagnosticPings.delete(detail.nonce);
  }
}

async function runBridgeSelfTest(): Promise<{
  contentScript: true;
  mainWorld: boolean;
  watchdog: boolean;
}> {
  try {
    if (!bridgePort) {
      bridgeConnection ??= connectPageBridge();
      try {
        bridgePort = await bridgeConnection;
        bridgePort.addEventListener?.("message", receiveBridgeDiagnostics);
        bridgePort.start?.();
      } finally {
        bridgeConnection = null;
      }
    }
    const nonce = crypto.randomUUID();
    const watchdog = await new Promise<boolean | null>((resolve) => {
      const timer = window.setTimeout(() => {
        pendingDiagnosticPings.delete(nonce);
        resolve(null);
      }, 500);
      pendingDiagnosticPings.set(nonce, (value) => {
        window.clearTimeout(timer);
        resolve(value);
      });
      bridge({ command: "diagnostics_ping", nonce });
    });
    return {
      contentScript: true,
      mainWorld: watchdog !== null,
      watchdog: watchdog === true,
    };
  } catch (error) {
    reportRuntimeFailure(error);
    return { contentScript: true, mainWorld: false, watchdog: false };
  }
}

function reportDiagnostics(force = false): void {
  if (!force && performance.now() - lastDiagnosticReport < 1_000) return;
  const sample = diagnosticSample;
  diagnosticSample = emptyDiagnosticSample();
  lastDiagnosticReport = performance.now();
  void send({ type: "diagnostics_sample", sample }).catch(reportRuntimeFailure);
}

function emptyDiagnosticSample(): DiagnosticsSample {
  return {
    input_events: 0,
    batches: 0,
    batch_events: 0,
    dropped_events: 0,
    mapping_durations_ms: [],
    pipeline_estimates_ms: [],
  };
}

function pushBounded(target: number[], value: number): void {
  if (!Number.isFinite(value) || value < 0) return;
  if (target.length >= 32) target.shift();
  target.push(Math.round(value * 1000) / 1000);
}
