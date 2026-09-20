import { isRuntimeMessage, type RuntimeMessage } from "./protocol";
import { BACKEND_MODE_STORAGE_KEY, type BackendMode } from "./profile-schema";
import { isXboxPlayUrl } from "./xbox-url";

const statusElement = requireElement<HTMLParagraphElement>("status");
const startButton = requireElement<HTMLButtonElement>("start");
const stopButton = requireElement<HTMLButtonElement>("stop");
const backendSelect = requireElement<HTMLSelectElement>("backend");
const mappingsButton = requireElement<HTMLButtonElement>("edit-mappings");

void chrome.storage.local.get(BACKEND_MODE_STORAGE_KEY).then((stored) => {
  if (!chrome.runtime.getManifest().permissions?.includes("nativeMessaging")) {
    backendSelect.value = "browser";
    backendSelect.disabled = true;
    return;
  }
  const mode = stored[BACKEND_MODE_STORAGE_KEY];
  backendSelect.value = mode === "native" || mode === "auto" ? mode : "browser";
});
backendSelect.addEventListener("change", () => {
  const mode = backendSelect.value as BackendMode;
  void chrome.storage.local.set({ [BACKEND_MODE_STORAGE_KEY]: mode });
});

startButton.addEventListener("click", () => void armActiveTab());
mappingsButton.addEventListener("click", () => void openMappings());
stopButton.addEventListener("click", () => {
  void chrome.runtime.sendMessage({
    type: "stop_capture",
    reason: "user_requested",
  } satisfies RuntimeMessage);
});

chrome.runtime.onMessage.addListener((message: unknown) => {
  if (isRuntimeMessage(message) && message.type === "status_update") {
    renderStatus(message);
  }
});

void refreshStatus();

async function openMappings(): Promise<void> {
  mappingsButton.disabled = true;
  try {
    await chrome.runtime.openOptionsPage();
    window.close();
  } catch {
    statusElement.textContent = "Could not open the mapping editor. Please try again.";
  } finally {
    mappingsButton.disabled = false;
  }
}

async function refreshStatus(): Promise<void> {
  const response = (await chrome.runtime.sendMessage({
    type: "get_status",
  } satisfies RuntimeMessage)) as RuntimeMessage | undefined;
  if (response && response.type === "status_update") renderStatus(response);
}

async function armActiveTab(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url || !isXboxPlayUrl(tab.url)) {
    statusElement.textContent = "Open Xbox Cloud Gaming before starting capture.";
    return;
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "arm_capture" } satisfies RuntimeMessage);
    window.close();
  } catch {
    statusElement.textContent = "Reload the Xbox Cloud Gaming tab and try again.";
  }
}

function renderStatus(message: Extract<RuntimeMessage, { type: "status_update" }>): void {
  if (message.error) {
    statusElement.textContent = message.error;
  } else if (message.active) {
    statusElement.textContent = `Capture active (${message.backend ?? "controller"} backend).`;
  } else if (message.connected) {
    statusElement.textContent = "Companion connected. Capture is inactive.";
  } else {
    statusElement.textContent = "Capture is inactive.";
  }
  stopButton.disabled = !message.active;
}

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing required element #${id}`);
  return element as T;
}
