import {
  isHostMessage,
  isRuntimeMessage,
  NATIVE_HOST,
  PROFILE_SCHEMA_VERSION,
  PROTOCOL_VERSION,
  type ClientMessage,
  type HostMessage,
  type RuntimeMessage,
} from "./protocol";
import {
  BACKEND_MODE_STORAGE_KEY,
  PROFILE_STORAGE_KEY,
  createStarterProfiles,
  type BackendMode,
  type Profile,
} from "./profile-schema";
import { loadSelectedProfile } from "./profile-runtime";
import { isXboxPlayUrl } from "./xbox-url";

type BridgeStatus = {
  connected: boolean;
  active: boolean;
  error: string | null;
  backend: string | null;
};

let port: chrome.runtime.Port | null = null;
let sequence = 0;
let heartbeat: ReturnType<typeof setInterval> | null = null;
let handshakeComplete = false;
let queuedProfile: Profile | null = null;
let inFlightProfile: Profile | null = null;
let activationRequested = false;
let activeProfile: Profile | null = null;
let activeTabId: number | null = null;
let requestedMode: BackendMode = "browser";
let activationGeneration = 0;
let status: BridgeStatus = {
  connected: false,
  active: false,
  error: null,
  backend: null,
};

chrome.runtime.onMessage.addListener(
  (
    rawMessage: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void,
  ) => {
    if (!isRuntimeMessage(rawMessage)) return false;
    void handleRuntimeMessage(rawMessage, sender).then(sendResponse, (error: unknown) => {
      failClosed(error instanceof Error ? error.message : "Extension operation failed", "runtime_failure");
      sendResponse({ type: "status_update", ...status });
    });
    return true;
  },
);

async function handleRuntimeMessage(
  message: RuntimeMessage,
  sender: chrome.runtime.MessageSender,
): Promise<unknown> {
  switch (message.type) {
    case "capture_started":
      if (!isXboxSender(sender)) return status;
      await prepareActivation(sender.tab?.id ?? null);
      return status;
    case "capture_stopped":
      if (!isXboxSender(sender) || sender.tab?.id !== activeTabId) return status;
      deactivate(message.reason);
      return status;
    case "capture_heartbeat":
      if (!isXboxSender(sender)) return status;
      if (sender.tab?.id !== activeTabId || (!status.active && !activationRequested)) {
        await sendToTab(sender.tab!.id!, { type: "stop_capture", reason: "capture_session_expired" });
      }
      return status;
    case "input_events":
      if (!status.active || !isXboxSender(sender) || sender.tab?.id !== activeTabId) {
        return status;
      }

      if (status.backend === "browser-gamepad") {
        if (sender.tab?.id === activeTabId) {
          await sendToTab(sender.tab.id, {
            type: "browser_events",
            events: message.events,
            timestamp_ms: message.timestamp_ms,
          });
        }
        return status;
      }
      sequence += 1;
      post({
        type: "input_batch",
        sequence,
        timestamp_ms: message.timestamp_ms,
        events: message.events,
      });
      return status;
    case "stop_capture":
      deactivate(message.reason);
      await broadcastToXboxTabs({ type: "stop_capture", reason: message.reason });
      return status;
    case "get_status":
      return { type: "status_update", ...status } satisfies RuntimeMessage;
    default:
      return status;
  }

}

async function prepareActivation(tabId: number | null = activeTabId): Promise<void> {
  if (tabId === null) return;
  if (activeTabId !== null && activeTabId !== tabId) {
    const previousTabId = activeTabId;
    deactivate("capture_replaced");
    void sendToTab(previousTabId, { type: "stop_capture", reason: "capture_replaced" });
  }
  const generation = ++activationGeneration;
  activeTabId = tabId;
  activationRequested = true;
  const selected = await loadSelectedProfile(chrome.storage.local);
  if (generation !== activationGeneration) return;
  if (!selected.ok) {
    failClosed(selected.error, "invalid_profile");
    return;
  }
  queuedProfile = selected.profile;
  activeProfile = selected.profile;
  activeTabId = tabId;
  activationRequested = true;
  updateStatus({ ...status, active: false, error: null });
  let mode: BackendMode;
  try {
    mode = await loadBackendMode();
  } catch (error) {
    if (generation !== activationGeneration) return;
    throw error;
  }
  if (generation !== activationGeneration) return;
  requestedMode = mode;
  if (requestedMode === "browser") {
    await activateBrowser(selected.profile);
    return;
  }
  connect();
  if (handshakeComplete) sendPendingProfile();
}

function connect(): void {
  if (port) return;
  try {
    port = chrome.runtime.connectNative(NATIVE_HOST);
    const nativePort = port;
    nativePort.onMessage.addListener(handleHostMessage);
    nativePort.onDisconnect.addListener(() => {
      const error = chrome.runtime.lastError?.message ?? "Companion disconnected";
      if (port !== nativePort) return;
      const shouldFallback = requestedMode === "auto" && activeProfile !== null && activeTabId !== null;
      port = null;
      handshakeComplete = false;
      inFlightProfile = null;
      stopHeartbeat();
      if (shouldFallback) {
        void activateBrowser(activeProfile!);
        return;
      }
      queuedProfile = null;
      activeProfile = null;
      activationRequested = false;
      updateStatus({
        connected: false,
        active: false,
        error,
        backend: null,
      });
      void broadcastToXboxTabs({
        type: "stop_capture",
        reason: "companion_disconnected",
      });
    });
    post({
      type: "hello",
      protocol_version: PROTOCOL_VERSION,
      client_version: chrome.runtime.getManifest().version,
    });
  } catch (error) {
    if (requestedMode === "auto" && activeProfile) {
      void activateBrowser(activeProfile);
      return;
    }
    updateStatus({
      connected: false,
      active: false,
      error: error instanceof Error ? error.message : "Unable to start companion",
      backend: null,
    });
    void broadcastToXboxTabs({
      type: "stop_capture",
      reason: "companion_unavailable",
    });
  }
}

function handleHostMessage(rawMessage: unknown): void {
  if (!isHostMessage(rawMessage)) {
    deactivate("invalid_host_message");
    updateStatus({ ...status, error: "Companion returned an invalid message" });
    void broadcastToXboxTabs({
      type: "stop_capture",
      reason: "invalid_host_message",
    });
    return;
  }
  const message: HostMessage = rawMessage;
  switch (message.type) {
    case "hello_ack":
      if (message.protocol_version !== PROTOCOL_VERSION) {
        deactivate("protocol_mismatch");
        updateStatus({ ...status, error: "Companion protocol is incompatible" });
        return;
      }
      updateStatus({
        connected: true,
        active: false,
        error: null,
        backend: message.backend,
      });
      handshakeComplete = true;
      startHeartbeat();
      sendPendingProfile();
      break;
    case "profile_applied":
      if (!activationRequested) {
        return;
      }
      if (
        !inFlightProfile ||
        message.profile_id !== inFlightProfile.id
      ) {
        failClosed("Companion applied an unexpected profile", "invalid_profile");
        return;
      }
      inFlightProfile = null;
      if (queuedProfile) {
        sendPendingProfile();
        return;
      }
      post({ type: "activate", profile_id: message.profile_id });
      activationRequested = false;
      break;
    case "status":
      const wasActive = status.active;
      updateStatus({
        ...status,
        connected: true,
        active: message.active,
        error: message.active ? null : status.error,
      });
      if (wasActive && !message.active) {
        void broadcastToXboxTabs({
          type: "stop_capture",
          reason: "companion_deactivated",
        });
      }
      break;
    case "error":
      if (
        message.code === "backend_unavailable" &&
        requestedMode === "auto" &&
        activeProfile
      ) {
        void activateBrowser(activeProfile);
        break;
      }
      failClosed(message.message, message.code);
      break;
    case "ack":
      break;
  }

}

function sendPendingProfile(): void {
  if (
    !handshakeComplete ||
    !queuedProfile ||
    inFlightProfile ||
    !activationRequested
  ) {
    return;
  }
  inFlightProfile = queuedProfile;
  queuedProfile = null;
  post({
    type: "set_profile",
    schema_version: PROFILE_SCHEMA_VERSION,
    profile: inFlightProfile,
  });
}

function failClosed(error: string, reason: string): void {
  activationRequested = false;
  queuedProfile = null;
  inFlightProfile = null;
  deactivate(reason);
  updateStatus({ ...status, active: false, error });
  void broadcastToXboxTabs({ type: "stop_capture", reason });
}

function deactivate(reason: string): void {
  activationGeneration += 1;
  activationRequested = false;
  queuedProfile = null;
  inFlightProfile = null;
  if (port) post({ type: "deactivate", reason });
  if (activeTabId !== null) {
    void sendToTab(activeTabId, { type: "browser_deactivate" });
  }
  activeProfile = null;
  activeTabId = null;
  updateStatus({ ...status, active: false });
}

async function activateBrowser(profile: Profile): Promise<void> {
  if (activeTabId === null) {
    failClosed("The Xbox Cloud Gaming tab is unavailable.", "invalid_state");
    return;
  }
  const tabId = activeTabId;
  const generation = activationGeneration;
  queuedProfile = null;
  inFlightProfile = null;
  stopHeartbeat();
  if (port) {
    const nativePort = port;
    port = null;
    handshakeComplete = false;
    nativePort.onMessage.removeListener(handleHostMessage);
    nativePort.disconnect();
  }
  try {
    const response: unknown = await chrome.tabs.sendMessage(tabId, { type: "browser_activate", profile });
    if (generation !== activationGeneration) return;
    if (typeof response !== "object" || response === null ||
      !("accepted" in response) || response.accepted !== true) {
      const error = typeof response === "object" && response !== null &&
        "error" in response && typeof response.error === "string"
        ? response.error : "Browser capture is no longer active. Start capture again.";
      failClosed(error, "browser_activation_failed");
      return;
    }
  } catch (error) {
    if (generation !== activationGeneration) return;
    failClosed(error instanceof Error ? error.message : "Xbox tab is unavailable", "browser_activation_failed");
    return;
  }
  activationRequested = false;
  updateStatus({
    connected: false,
    active: true,
    error: null,
    backend: "browser-gamepad",
  });
}

async function loadBackendMode(): Promise<BackendMode> {
  if (!chrome.runtime.getManifest().permissions?.includes("nativeMessaging")) {
    return "browser";
  }
  try {
    const stored = await chrome.storage.local.get(BACKEND_MODE_STORAGE_KEY);
    const value = stored[BACKEND_MODE_STORAGE_KEY];
    return value === "native" || value === "auto" ? value : "browser";
  } catch (error) {
    throw new Error("Could not read controller mode.", { cause: error });
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void chrome.storage.local.get(PROFILE_STORAGE_KEY).then((stored) => {
    if (stored[PROFILE_STORAGE_KEY] === undefined) {
      return chrome.storage.local.set({
        [PROFILE_STORAGE_KEY]: createStarterProfiles(),
      });
    }
    return undefined;
  }).catch((error: unknown) => {
    failClosed(error instanceof Error ? error.message : "Could not initialize profiles", "profile_initialization_failed");
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === activeTabId) deactivate("tab_closed");
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (tabId === activeTabId && (change.status === "loading" ||
    (change.url !== undefined && !isXboxPlayUrl(change.url)))) {
    deactivate("tab_navigated");
    void sendToTab(tabId, { type: "stop_capture", reason: "tab_navigated" });
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (
    areaName === "local" &&
    PROFILE_STORAGE_KEY in changes &&
    (status.active || activationRequested)
  ) {
    void prepareActivation().catch((error: unknown) => {
      failClosed(error instanceof Error ? error.message : "Profile update failed", "profile_update_failed");
    });
  }
});

function post(message: ClientMessage): void {
  if (!port) {
    updateStatus({ ...status, error: "Companion is not connected" });
    return;
  }
  port.postMessage(message);
}

function startHeartbeat(): void {
  stopHeartbeat();
  heartbeat = setInterval(() => {
    sequence += 1;
    post({ type: "heartbeat", sequence });
  }, 500);
}

function stopHeartbeat(): void {
  if (heartbeat !== null) clearInterval(heartbeat);
  heartbeat = null;
}

function updateStatus(next: BridgeStatus): void {
  status = next;
  const message: RuntimeMessage = { type: "status_update", ...next };
  void chrome.runtime.sendMessage(message).catch(() => undefined);
}

function isXboxSender(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && sender.frameId === 0 &&
    sender.tab?.id !== undefined && !!sender.url && isXboxPlayUrl(sender.url);
}

async function broadcastToXboxTabs(message: RuntimeMessage): Promise<void> {
  const tabs = await chrome.tabs.query({ url: "https://www.xbox.com/*" });
  await Promise.all(
    tabs
      .filter((tab): tab is chrome.tabs.Tab & { id: number } => tab.id !== undefined)
      .map((tab) => chrome.tabs.sendMessage(tab.id, message).catch(() => undefined)),
  );
}

async function sendToTab(tabId: number, message: RuntimeMessage): Promise<void> {
  await chrome.tabs.sendMessage(tabId, message).catch((error: unknown) => {
    console.warn("Xbox Input Bridge tab communication failed:", error);
  });
}
