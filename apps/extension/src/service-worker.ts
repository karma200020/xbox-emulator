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
  parseProfileDocument,
  type BackendMode,
  type Profile,
  type ProfileDocument,
} from "./profile-schema";
import { isXboxPlayUrl } from "./xbox-url";
import {
  associateGameWithProfile,
  matchGameProfile,
  parseXcloudGameIdentity,
  type GameIdentity,
} from "./game-profile";
import {
  DIAGNOSTICS_PERSIST_STORAGE_KEY,
  DIAGNOSTICS_SNAPSHOT_STORAGE_KEY,
  PERFORMANCE_OVERLAY_STORAGE_KEY,
  DiagnosticsCollector,
  buildDiagnosticsExport,
  type DiagnosticFailureCategory,
  type DiagnosticsSnapshot,
} from "./diagnostics";

type BridgeStatus = {
  connected: boolean;
  active: boolean;
  error: string | null;
  backend: string | null;
};
const diagnosticsReady = loadDiagnosticsPreferences();

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
const detectedGames = new Map<number, GameIdentity | null>();
const internalProfileWrites = new Set<string>();
let profileMutationQueue: Promise<void> = Promise.resolve();
let profileMutationCount = 0;
const diagnostics = new DiagnosticsCollector();
let diagnosticsPersistence = false;
let performanceOverlay = false;
let diagnosticsPersistenceTimer: ReturnType<typeof setTimeout> | null = null;
let nativeConnectionAttempts = 0;
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
      recordFailure("runtime", "runtime_message_failed");
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
      detectedGames.set(sender.tab!.id!, identityFromSender(sender));
      await serializeProfileMutation(() =>
        prepareActivation(sender.tab!.id!, identityFromSender(sender)));
      return status;
    case "capture_stopped":
      if (!isXboxSender(sender) || sender.tab?.id !== activeTabId) return status;
      deactivate(message.reason);
      return status;
    case "capture_heartbeat":
      if (!isXboxSender(sender)) return status;
      if (sender.tab?.id !== activeTabId || (!status.active && !activationRequested)) {
        recordFailure("watchdog", "capture_session_expired");
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
      if (!isExtensionPageSender(sender)) return status;
      deactivate(message.reason);
      await broadcastToXboxTabs({ type: "stop_capture", reason: message.reason });
      return status;
    case "get_status":
      if (!isTrustedExtensionSender(sender)) return status;
      return { type: "status_update", ...status } satisfies RuntimeMessage;
    case "game_identity_changed":
      if (!isXboxSender(sender)) return status;
      if (!sameIdentity(message.identity, identityFromSender(sender))) return status;
      if (!canManageTab(sender.tab!.id!)) {
        detectedGames.set(sender.tab!.id!, message.identity);
        return buildOverlayState(sender.tab!.id!);
      }
      await serializeProfileMutation(() =>
        handleGameIdentity(sender.tab!.id!, message.identity));
      return buildOverlayState(sender.tab!.id!);
    case "get_overlay_state":
      if (!isXboxSender(sender)) return status;
      detectedGames.set(sender.tab!.id!, identityFromSender(sender));
      return buildOverlayState(sender.tab!.id!);
    case "diagnostics_sample":
      if (!isXboxSender(sender) || sender.tab?.id !== activeTabId) return status;
      await diagnosticsReady;
      diagnostics.addSample(message.sample);
      scheduleDiagnosticsPersistence();
      return status;
    case "get_diagnostics":
      if (!isExtensionPageSender(sender)) return status;
      await diagnosticsReady;
      return diagnosticsResponse();
    case "reset_diagnostics":
      if (!isExtensionPageSender(sender)) return status;
      await diagnosticsReady;
      diagnostics.reset();
      await persistDiagnosticsNow();
      return diagnosticsResponse();
    case "set_diagnostics_preferences":
      if (!isExtensionPageSender(sender)) return status;
      await diagnosticsReady;
      diagnosticsPersistence = message.persistence;
      performanceOverlay = message.performance_overlay;
      await chrome.storage.local.set({
        [DIAGNOSTICS_PERSIST_STORAGE_KEY]: diagnosticsPersistence,
        [PERFORMANCE_OVERLAY_STORAGE_KEY]: performanceOverlay,
      });
      if (diagnosticsPersistence) await persistDiagnosticsNow();
      else await chrome.storage.local.remove(DIAGNOSTICS_SNAPSHOT_STORAGE_KEY);
      return diagnosticsResponse();
    case "diagnostics_ping":
      if (!isExtensionPageSender(sender)) return status;
      return runBridgeSelfTest();
    case "select_profile":
      if (!isXboxSender(sender) || !canManageTab(sender.tab!.id!)) return status;
      detectedGames.set(sender.tab!.id!, identityFromSender(sender));
      return serializeProfileMutation(() =>
        selectProfileForTab(
          sender.tab!.id!,
          message.profile_id,
          message.associate,
        ));
    case "update_profile_sensitivity":
      if (!isXboxSender(sender) || !canManageTab(sender.tab!.id!)) return status;
      detectedGames.set(sender.tab!.id!, identityFromSender(sender));
      return serializeProfileMutation(() =>
        updateSensitivityForTab(sender.tab!.id!, message));
    default:
      return status;
  }
}

async function handleGameIdentity(tabId: number, identity: GameIdentity | null): Promise<void> {
  detectedGames.set(tabId, identity);
  if (!identity) return;
  const document = await loadProfileDocument();
  if (!document) return;
  const match = matchGameProfile(document.profiles, identity);
  if (match.kind === "unique" && document.active_profile_id !== match.profile_ids[0]) {
    document.active_profile_id = match.profile_ids[0];
    await persistProfileDocument(document);
    await applyProfileToActiveCapture(document.profiles.find(
      ({ id }) => id === document.active_profile_id,
    )!, tabId);
  }
  if (match.kind === "ambiguous") {
    await sendToTab(tabId, await buildOverlayState(tabId));
  }
}

async function selectProfileForTab(
  tabId: number,
  profileId: string,
  associate: boolean,
): Promise<RuntimeMessage> {
  const document = await loadProfileDocument();
  if (!document) return buildUnavailableOverlayState(tabId);
  let next = structuredClone(document);
  if (associate) {
    const identity = detectedGames.get(tabId);
    if (!identity) return buildOverlayState(tabId);
    const associated = associateGameWithProfile(next, identity, profileId);
    if (!associated) return buildOverlayState(tabId);
    next = associated;
  } else {
    if (!next.profiles.some(({ id }) => id === profileId)) return buildOverlayState(tabId);
    next.active_profile_id = profileId;
  }
  const parsed = parseProfileDocument(next);
  if (!parsed.ok) return buildOverlayState(tabId);
  await persistProfileDocument(parsed.value);
  await applyProfileToActiveCapture(
    parsed.value.profiles.find(({ id }) => id === profileId)!,
    tabId,
  );
  return buildOverlayState(tabId, parsed.value);
}

async function updateSensitivityForTab(
  tabId: number,
  message: Extract<RuntimeMessage, { type: "update_profile_sensitivity" }>,
): Promise<RuntimeMessage> {
  const document = await loadProfileDocument();
  if (!document) return buildUnavailableOverlayState(tabId);
  const profile = document.profiles.find(({ id }) => id === message.profile_id);
  if (!profile) return buildOverlayState(tabId, document);
  profile.mouse.hip.sensitivity_x = message.hip_x;
  profile.mouse.hip.sensitivity_y = message.hip_y;
  profile.mouse.ads.sensitivity_x = message.ads_x;
  profile.mouse.ads.sensitivity_y = message.ads_y;
  document.active_profile_id = profile.id;
  const parsed = parseProfileDocument(document);
  if (!parsed.ok) return buildOverlayState(tabId);
  await persistProfileDocument(parsed.value);
  await applyProfileToActiveCapture(profile, tabId);
  return buildOverlayState(tabId, parsed.value);
}

async function buildOverlayState(
  tabId: number,
  suppliedDocument?: ProfileDocument,
): Promise<RuntimeMessage> {
  await diagnosticsReady;
  const document = suppliedDocument ?? await loadProfileDocument();
  if (!document) return buildUnavailableOverlayState(tabId);
  const identity = detectedGames.get(tabId) ?? null;
  const match = identity ? matchGameProfile(document.profiles, identity) :
    { kind: "unknown" as const, basis: null, profile_ids: [] as [] };
  return {
    type: "overlay_state",
    identity,
    match: match.kind === "unique" ? "matched" : match.kind,
    candidate_profile_ids: [...match.profile_ids],
    active_profile_id: document.active_profile_id,
    profiles: document.profiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      hip_x: profile.mouse.hip.sensitivity_x,
      hip_y: profile.mouse.hip.sensitivity_y,
      ads_x: profile.mouse.ads.sensitivity_x,
      ads_y: profile.mouse.ads.sensitivity_y,
    })),
    capture_active: status.active && activeTabId === tabId,
    performance_enabled: performanceOverlay,
    performance: performanceSummary(),
  };
}

function buildUnavailableOverlayState(tabId: number): RuntimeMessage {
  const fallback = createStarterProfiles();
  return {
    type: "overlay_state",
    identity: detectedGames.get(tabId) ?? null,
    match: "unknown",
    candidate_profile_ids: [],
    active_profile_id: fallback.active_profile_id,
    profiles: fallback.profiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      hip_x: profile.mouse.hip.sensitivity_x,
      hip_y: profile.mouse.hip.sensitivity_y,
      ads_x: profile.mouse.ads.sensitivity_x,
      ads_y: profile.mouse.ads.sensitivity_y,
    })),
    capture_active: false,
    performance_enabled: performanceOverlay,
    performance: performanceSummary(),
  };
}

async function loadProfileDocument(): Promise<ProfileDocument | null> {
  try {
    const stored = await chrome.storage.local.get(PROFILE_STORAGE_KEY);
    const parsed = parseProfileDocument(stored[PROFILE_STORAGE_KEY]);
    if (!parsed.ok) recordFailure("profile", "stored_profile_invalid");
    return parsed.ok ? parsed.value : null;
  } catch {
    recordFailure("storage", "profile_read_failed");
    return null;
  }
}

async function persistProfileDocument(document: ProfileDocument): Promise<void> {
  const serialized = JSON.stringify(document);
  internalProfileWrites.add(serialized);
  try {
    await chrome.storage.local.set({ [PROFILE_STORAGE_KEY]: document });
  } catch (error) {
    recordFailure("bridge", "companion_unavailable");
    internalProfileWrites.delete(serialized);
    throw error;
  }
}

async function applyProfileToActiveCapture(profile: Profile, tabId: number): Promise<void> {
  if (activeTabId !== tabId || (!status.active && !activationRequested)) return;
  if (activeProfile && activeProfile.id !== profile.id) {
    diagnostics.recordProfileSwitch();
    scheduleDiagnosticsPersistence();
  }
  const generation = ++activationGeneration;
  activationRequested = true;
  activeProfile = profile;
  queuedProfile = null;
  updateStatus({ ...status, active: false, error: null });

  if (status.backend === "browser-gamepad" || requestedMode === "browser") {
    inFlightProfile = null;
    await chrome.tabs.sendMessage(tabId, { type: "browser_deactivate" } satisfies RuntimeMessage);
    if (generation !== activationGeneration || activeTabId !== tabId) return;
    await activateBrowser(profile);
    return;
  }

  if (port) post({ type: "deactivate", reason: "profile_switch" });
  queuedProfile = profile;
  if (handshakeComplete) sendPendingProfile();
}

function canManageTab(tabId: number): boolean {
  return activeTabId === null || activeTabId === tabId;
}

function identityFromSender(sender: chrome.runtime.MessageSender): GameIdentity | null {
  return sender.url ? parseXcloudGameIdentity(sender.url) : null;
}

function sameIdentity(left: GameIdentity | null, right: GameIdentity | null): boolean {
  return left === null ? right === null : right !== null &&
    left.product_id === right.product_id &&
    left.title_slug === right.title_slug &&
    left.title_name === right.title_name;
}

function serializeProfileMutation<T>(operation: () => Promise<T>): Promise<T> {
  let next: Promise<T>;
  if (profileMutationCount === 0) {
    try {
      next = operation();
    } catch (error) {
      next = Promise.reject(error);
    }
  } else {
    next = profileMutationQueue.then(operation);
  }
  profileMutationCount += 1;
  profileMutationQueue = next.then(() => undefined, () => undefined);
  return next.finally(() => {
    profileMutationCount -= 1;
  });
}

async function prepareActivation(
  tabId: number | null = activeTabId,
  identity: GameIdentity | null = tabId === null ? null : detectedGames.get(tabId) ?? null,
): Promise<void> {
  if (tabId === null) return;
  if (activeTabId !== null && activeTabId !== tabId) {
    const previousTabId = activeTabId;
    deactivate("capture_replaced");
    void sendToTab(previousTabId, { type: "stop_capture", reason: "capture_replaced" });
  }
  diagnostics.startCapture();
  scheduleDiagnosticsPersistence();
  const generation = ++activationGeneration;
  activeTabId = tabId;
  activationRequested = true;
  const document = await loadProfileDocument();
  if (generation !== activationGeneration) return;
  if (!document) {
    failClosed("No valid saved profile is available.", "invalid_profile");
    return;
  }
  const match = identity ? matchGameProfile(document.profiles, identity) : null;
  if (match?.kind === "unique") {
    document.active_profile_id = match.profile_ids[0];
    await persistProfileDocument(document);
    if (generation !== activationGeneration) return;
  } else if (match?.kind === "ambiguous") {
    void sendToTab(tabId, await buildOverlayState(tabId, document));
  }
  const selected = document.profiles.find(({ id }) => id === document.active_profile_id);
  if (!selected) {
    failClosed("Selected profile is unavailable.", "invalid_profile");
    return;
  }
  queuedProfile = selected;
  activeProfile = selected;
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
    await activateBrowser(selected);
    return;
  }
  connect();
  if (handshakeComplete) sendPendingProfile();
}

function connect(): void {
  if (port) return;
  nativeConnectionAttempts += 1;
  if (nativeConnectionAttempts > 1) diagnostics.recordBridgeReconnect();
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
      recordFailure("bridge", "companion_disconnected");
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
    recordFailure("protocol", "invalid_host_message");
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
        recordFailure("protocol", "protocol_mismatch");
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
      recordFailure(
        message.code === "invalid_profile" ? "profile" : "bridge",
        message.code,
      );
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
  recordFailure(failureCategory(reason), reason);
  activationRequested = false;
  queuedProfile = null;
  inFlightProfile = null;
  deactivate(reason);
  updateStatus({ ...status, active: false, error });
  void broadcastToXboxTabs({ type: "stop_capture", reason });
}

function deactivate(reason: string): void {
  const hadSession = activeTabId !== null || status.active || activationRequested;
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
  if (hadSession) {
    diagnostics.stopCapture(reason);
    scheduleDiagnosticsPersistence();
  }
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
  detectedGames.delete(tabId);
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
    const serialized = JSON.stringify(changes[PROFILE_STORAGE_KEY]?.newValue);
    if (internalProfileWrites.delete(serialized)) return;
    const parsed = parseProfileDocument(changes[PROFILE_STORAGE_KEY]?.newValue);
    const profile = parsed.ok
      ? parsed.value.profiles.find(({ id }) => id === parsed.value.active_profile_id)
      : undefined;
    if (!profile || activeTabId === null) {
      failClosed(
        parsed.ok ? "Selected profile is unavailable." : parsed.errors.join(" "),
        "profile_update_failed",
      );
      return;
    }
    void applyProfileToActiveCapture(profile, activeTabId).catch((error: unknown) => {
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

function isExtensionPageSender(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && sender.tab === undefined &&
    !!sender.url && sender.url.startsWith(`chrome-extension://${chrome.runtime.id}/`);
}

function isTrustedExtensionSender(sender: chrome.runtime.MessageSender): boolean {
  return isXboxSender(sender) || isExtensionPageSender(sender);
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
    recordFailure("runtime", "tab_message_failed");
    console.warn("Xbox Input Bridge tab communication failed:", error);
  });
}

async function loadDiagnosticsPreferences(): Promise<void> {
  try {
    const stored = await chrome.storage.local.get([
      DIAGNOSTICS_PERSIST_STORAGE_KEY,
      DIAGNOSTICS_SNAPSHOT_STORAGE_KEY,
      PERFORMANCE_OVERLAY_STORAGE_KEY,
    ]);
    diagnosticsPersistence = stored[DIAGNOSTICS_PERSIST_STORAGE_KEY] === true;
    performanceOverlay = stored[PERFORMANCE_OVERLAY_STORAGE_KEY] === true;
    if (diagnosticsPersistence) diagnostics.restore(stored[DIAGNOSTICS_SNAPSHOT_STORAGE_KEY]);
  } catch {
    diagnostics.recordFailure("storage", "diagnostics_read_failed");
  }
}

function scheduleDiagnosticsPersistence(): void {
  if (!diagnosticsPersistence || diagnosticsPersistenceTimer !== null) return;
  diagnosticsPersistenceTimer = setTimeout(() => {
    diagnosticsPersistenceTimer = null;
    void persistDiagnosticsNow();
  }, 5_000);
}

async function persistDiagnosticsNow(): Promise<void> {
  if (diagnosticsPersistenceTimer !== null) {
    clearTimeout(diagnosticsPersistenceTimer);
    diagnosticsPersistenceTimer = null;
  }
  try {
    if (diagnosticsPersistence) {
      await chrome.storage.local.set({
        [DIAGNOSTICS_SNAPSHOT_STORAGE_KEY]: diagnostics.snapshot(),
      });
    } else {
      await chrome.storage.local.remove(DIAGNOSTICS_SNAPSHOT_STORAGE_KEY);
    }
  } catch {
    diagnostics.recordFailure("storage", "diagnostics_write_failed");
  }
}

function diagnosticsResponse(): {
  snapshot: DiagnosticsSnapshot;
  persistence: boolean;
  performance_overlay: boolean;
  export: ReturnType<typeof buildDiagnosticsExport>;
} {
  const snapshot = diagnostics.snapshot();
  return {
    snapshot,
    persistence: diagnosticsPersistence,
    performance_overlay: performanceOverlay,
    export: buildDiagnosticsExport(snapshot, {
      extensionVersion: chrome.runtime.getManifest().version ?? "unknown",
      protocolVersion: PROTOCOL_VERSION,
      profileSchemaVersion: PROFILE_SCHEMA_VERSION,
      persistence: diagnosticsPersistence,
      performanceOverlay,
      backend: status.backend,
    }),
  };
}

function performanceSummary(): import("./protocol").PerformanceSummary {
  const snapshot = diagnostics.snapshot();
  const average = (value: DiagnosticsSnapshot["durations"]["mapping_processing_ms"]): number | null =>
    value.count > 0 ? Math.round(value.sum_ms / value.count * 1000) / 1000 : null;
  return {
    input_events_hz: snapshot.rates.input_events_hz,
    batches_hz: snapshot.rates.batches_hz,
    average_batch_size: snapshot.rates.average_batch_size,
    mapping_average_ms: average(snapshot.durations.mapping_processing_ms),
    pipeline_estimate_average_ms: average(snapshot.durations.extension_pipeline_estimate_ms),
    dropped_events: snapshot.totals.dropped_events,
    capture_uptime_ms: snapshot.capture.uptime_ms,
  };
}

async function runBridgeSelfTest(): Promise<{
  contentScript: boolean;
  mainWorld: boolean;
  watchdog: boolean;
}> {
  const tabs = await chrome.tabs.query({
    url: ["https://www.xbox.com/*/play*", "https://www.xbox.com/play*"],
  });
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    try {
      const response: unknown = await chrome.tabs.sendMessage(tab.id, { type: "diagnostics_ping" });
      if (typeof response === "object" && response !== null &&
        "contentScript" in response && response.contentScript === true) {
        return {
          contentScript: true,
          mainWorld: "mainWorld" in response && response.mainWorld === true,
          watchdog: "watchdog" in response && response.watchdog === true,
        };
      }
    } catch {
      recordFailure("bridge", "self_test_handshake_failed");
    }
  }
  return { contentScript: false, mainWorld: false, watchdog: false };
}

function recordFailure(category: DiagnosticFailureCategory, code: string): void {
  diagnostics.recordFailure(category, code);
  scheduleDiagnosticsPersistence();
}

function failureCategory(reason: string): DiagnosticFailureCategory {
  if (reason.includes("profile")) return "profile";
  if (reason.includes("protocol") || reason.includes("message")) return "protocol";
  if (reason.includes("watchdog") || reason.includes("expired")) return "watchdog";
  if (reason.includes("bridge") || reason.includes("companion")) return "bridge";
  return "capture";
}
