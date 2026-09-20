import {
  AXIS_TARGETS,
  BUTTONS,
  MAX_IMPORT_BYTES,
  PROFILE_STORAGE_KEY,
  createStarterProfiles,
  normalizeGameText,
  parseProfileDocument,
  parseProfileJson,
  type Profile,
  type ProfileDocument,
  type ResponseCurve,
  type MouseSettings,
  type Target,
} from "./profile-schema";
import {
  DEFAULT_OVERLAY_SHORTCUT,
  OVERLAY_SHORTCUT_STORAGE_KEY,
  OVERLAY_SHORTCUTS,
  parseOverlayShortcut,
  type OverlayShortcutId,
} from "./overlay-shortcut";
import {
  addCalibrationSample,
  addTarget,
  normalizedStick,
  previewPoints,
  removeTarget,
  replaceTarget,
  suggestedSensitivity,
  type CalibrationSample,
} from "./options-math";
import { controllerParts } from "./controller-visualization";
import { localizeDocument, t } from "./i18n";
import { replaceBindingSource, resolveCapture, type CaptureKind } from "./key-capture";
import { actionLabelKey, friendlyInputLabel, matchesProfileSearch } from "./pc-actions";
import {
  ONBOARDING_STORAGE_KEY,
  activationReady,
  finishOnboarding,
  needsOnboarding,
} from "./onboarding";
import {
  runCompatibilitySelfTests,
  summarizeSelfTests,
  testTimer,
  type SelfTestResult,
} from "./compatibility-self-test";
import type { DiagnosticsExport, DiagnosticsSnapshot } from "./diagnostics";

const CONTRAST_STORAGE_KEY = "xib.high_contrast";
localizeDocument();

const elements = {
  status: requireElement<HTMLDivElement>("status"),
  profile: requireElement<HTMLSelectElement>("profile"),
  profileSearch: requireElement<HTMLInputElement>("profile-search"),
  overlayShortcut: requireElement<HTMLSelectElement>("overlay-shortcut"),
  name: requireElement<HTMLInputElement>("profile-name"),
  id: requireElement<HTMLInputElement>("profile-id"),
  responseMode: requireElement<HTMLSelectElement>("response-mode"),
  adsSource: requireElement<HTMLSelectElement>("ads-source"),
  sensitivityX: requireElement<HTMLInputElement>("sensitivity-x"),
  sensitivityY: requireElement<HTMLInputElement>("sensitivity-y"),
  deadzone: requireElement<HTMLInputElement>("deadzone"),
  curve: requireElement<HTMLSelectElement>("curve"),
  curveLine: requireElement<SVGPolylineElement>("curve-line"),
  invertX: requireElement<HTMLInputElement>("invert-x"),
  invertY: requireElement<HTMLInputElement>("invert-y"),
  smoothing: requireElement<HTMLInputElement>("smoothing"),
  velocityScale: requireElement<HTMLInputElement>("velocity-scale"),
  calibrationSurface: requireElement<HTMLDivElement>("calibration-surface"),
  calibrationState: requireElement<HTMLSpanElement>("calibration-state"),
  calibrationValues: requireElement<HTMLOutputElement>("calibration-values"),
  stickDot: requireElement<HTMLSpanElement>("stick-dot"),
  suggestion: requireElement<HTMLDivElement>("suggestion"),
  suggestedValue: requireElement<HTMLElement>("suggested-value"),
  startCalibration: requireElement<HTMLButtonElement>("start-calibration"),
  stopCalibration: requireElement<HTMLButtonElement>("stop-calibration"),
  applySuggestion: requireElement<HTMLButtonElement>("apply-suggestion"),
  keys: requireElement<HTMLDivElement>("key-bindings"),
  mouse: requireElement<HTMLDivElement>("mouse-bindings"),
  games: requireElement<HTMLDivElement>("game-associations"),
  conflictsCard: requireElement<HTMLElement>("conflicts-card"),
  conflicts: requireElement<HTMLUListElement>("conflicts"),
  importFile: requireElement<HTMLInputElement>("import-file"),
  controllerDiagram: requireElement<SVGElement>("controller-diagram"),
  controllerMappings: requireElement<HTMLUListElement>("controller-mappings"),
  controllerOutput: requireElement<HTMLOutputElement>("controller-output"),
  controllerStickDot: requireElement<SVGCircleElement>("controller-stick-dot"),
  contrast: requireElement<HTMLButtonElement>("contrast"),
  advancedMode: requireElement<HTMLButtonElement>("advanced-mode"),
  onboarding: requireElement<HTMLDialogElement>("onboarding"),
  onboardingProgress: requireElement<HTMLDivElement>("onboarding-progress"),
  onboardingProfile: requireElement<HTMLSelectElement>("onboarding-profile"),
  onboardingBack: requireElement<HTMLButtonElement>("onboarding-back"),
  onboardingNext: requireElement<HTMLButtonElement>("onboarding-next"),
  persistDiagnostics: requireElement<HTMLInputElement>("persist-diagnostics"),
  performanceOverlay: requireElement<HTMLInputElement>("performance-overlay"),
  diagnosticsStatus: requireElement<HTMLElement>("diagnostics-status"),
  diagnosticsMetrics: requireElement<HTMLDListElement>("diagnostics-metrics"),
  selfTestResults: requireElement<HTMLOListElement>("self-test-results"),
};

let documentState = createStarterProfiles();
let selectedProfileId = documentState.active_profile_id;
let dirty = false;
let calibrationSamples: CalibrationSample[] = [];
let calibrationActive = false;
let currentSuggestion: number | null = null;
let overlayShortcut: OverlayShortcutId = DEFAULT_OVERLAY_SHORTCUT;
let capture: { kind: CaptureKind; oldSource: string | null; button: HTMLButtonElement | null } | null = null;
let onboardingStep = 0;
let suppressCapturedMouse = false;
let onboardingProfileChanged = false;
let onboardingInitialProfileId = selectedProfileId;

requireElement<HTMLButtonElement>("save").addEventListener("click", () => void save());
requireElement<HTMLButtonElement>("reset").addEventListener("click", () => void reset());
requireElement<HTMLButtonElement>("export").addEventListener("click", exportProfiles);
requireElement<HTMLButtonElement>("import").addEventListener("click", () => elements.importFile.click());
requireElement<HTMLButtonElement>("duplicate-profile").addEventListener("click", duplicateProfile);
requireElement<HTMLButtonElement>("delete-profile").addEventListener("click", deleteProfile);
requireElement<HTMLButtonElement>("add-key").addEventListener("click", () => addBinding(false));
requireElement<HTMLButtonElement>("add-mouse").addEventListener("click", () => addBinding(true));
requireElement<HTMLButtonElement>("add-game").addEventListener("click", addGameAssociation);
requireElement<HTMLButtonElement>("restart-onboarding").addEventListener("click", () => {
  void chrome.storage.local.remove(ONBOARDING_STORAGE_KEY).then(() => showOnboarding());
});
requireElement<HTMLButtonElement>("onboarding-skip").addEventListener("click", () => void closeOnboarding("skipped"));
requireElement<HTMLButtonElement>("tour-calibration").addEventListener("click", () => {
  onboardingStep = 4;
  elements.onboarding.close();
  requireElement<HTMLButtonElement>("resume-onboarding").hidden = false;
  elements.startCalibration.scrollIntoView({ block: "center" });
  elements.startCalibration.focus();
  void startCalibration();
});
requireElement<HTMLButtonElement>("tour-mappings").addEventListener("click", () => {
  void closeOnboarding("completed");
  requireElement<HTMLButtonElement>("add-key").scrollIntoView({ block: "center" });
  requireElement<HTMLButtonElement>("add-key").focus();
});
requireElement<HTMLButtonElement>("resume-onboarding").addEventListener("click", (event) => {
  stopCalibration(t("stopped"));
  (event.currentTarget as HTMLButtonElement).hidden = true;
  showOnboarding(4);
});
elements.onboardingBack.addEventListener("click", () => setOnboardingStep(onboardingStep - 1));
elements.onboardingNext.addEventListener("click", () => {
  if (onboardingStep === 1) selectOnboardingProfile();
  if (onboardingStep >= 4) void closeOnboarding("completed");
  else setOnboardingStep(onboardingStep + 1);
});
elements.onboarding.addEventListener("cancel", (event) => {
  event.preventDefault();
  void closeOnboarding("skipped");
});
elements.contrast.addEventListener("click", () => void setHighContrast(!document.documentElement.classList.contains("high-contrast")));
elements.advancedMode.addEventListener("click", () => {
  const enabled = !document.documentElement.classList.contains("advanced");
  document.documentElement.classList.toggle("advanced", enabled);
  elements.advancedMode.setAttribute("aria-pressed", String(enabled));
  elements.advancedMode.textContent = t(enabled ? "simpleMode" : "advancedMode");
});
elements.startCalibration.addEventListener("click", () => void startCalibration());
elements.stopCalibration.addEventListener("click", () => stopCalibration(t("stopped")));
elements.applySuggestion.addEventListener("click", applySuggestion);
elements.importFile.addEventListener("change", () => void importProfiles());
elements.responseMode.addEventListener("change", render);
elements.adsSource.addEventListener("change", updateAdsSource);
elements.profile.addEventListener("change", () => {
  stopCalibration(t("stopped"));
  selectedProfileId = elements.profile.value;
  documentState.active_profile_id = selectedProfileId;
  dirty = true;
  render();
});
elements.profileSearch.addEventListener("input", renderProfileList);
elements.overlayShortcut.addEventListener("change", () => {
  overlayShortcut = parseOverlayShortcut(elements.overlayShortcut.value);
  markPendingEdit();
});
requireElement<HTMLButtonElement>("refresh-diagnostics").addEventListener("click", () => void loadDiagnostics());
requireElement<HTMLButtonElement>("export-diagnostics").addEventListener("click", () => void exportDiagnostics());
requireElement<HTMLButtonElement>("reset-diagnostics").addEventListener("click", () => void resetDiagnostics());
requireElement<HTMLButtonElement>("run-self-tests").addEventListener("click", () => void runSelfTests());
elements.persistDiagnostics.addEventListener("change", () => void saveDiagnosticsPreferences());
elements.performanceOverlay.addEventListener("change", () => void saveDiagnosticsPreferences());

for (const input of [
  elements.name,
  elements.id,
  elements.sensitivityX,
  elements.sensitivityY,
  elements.deadzone,
  elements.curve,
  elements.invertX,
  elements.invertY,
  elements.smoothing,
  elements.velocityScale,
]) {
  input.addEventListener("input", updateSettings);
}

function focusBindingSource(kind: CaptureKind, source: string): void {
  const container = kind === "mouse" ? elements.mouse : elements.keys;
  const button = [...container.querySelectorAll<HTMLButtonElement>(".capture-source")]
    .find((candidate) => candidate.dataset.source === source);
  button?.focus();
}

function selectedResponse(): MouseSettings {
  return selectedProfile().mouse[elements.responseMode.value === "ads" ? "ads" : "hip"];
}

function localizedBindingWarnings(profile: Profile): string[] {
  const assignments = new Map<string, string[]>();
  for (const [source, targets] of Object.entries(profile.key_bindings)) {
    for (const target of targets) {
      const id = encodeTarget(target);
      assignments.set(id, [...(assignments.get(id) ?? []), friendlyInputLabel(source, false, t)]);
    }
  }
  for (const [source, targets] of Object.entries(profile.mouse_bindings)) {
    for (const target of targets) {
      const id = encodeTarget(target);
      assignments.set(id, [...(assignments.get(id) ?? []), friendlyInputLabel(source, true, t)]);
    }
  }
  return [...assignments.entries()]
    .filter(([, sources]) => sources.length > 1)
    .map(([target, sources]) => t("duplicateTargetWarning", [
      controllerTargetLabel(decodeTarget(target) ?? target as Target),
      sources.join(", "),
    ]));
}

function renderAdsSources(profile: Profile): void {
  const selected = encodeAdsSource(profile.mouse.ads_activation);
  const sources: [string, string][] = [
    ["", t("none")],
    ...Object.keys(profile.key_bindings)
      .sort()
      .map((code): [string, string] => [`key:${code}`, t("keyboardSource", code)]),
    ...Object.keys(profile.mouse_bindings)
      .sort()
      .map((button): [string, string] => [`mouse:${button}`, t("mouseSource", button)]),
  ];
  elements.adsSource.replaceChildren(
    ...sources.map(([value, label]) => option(value, label, value === selected)),
  );
}

function updateAdsSource(): void {
  const value = elements.adsSource.value;
  selectedProfile().mouse.ads_activation = value === ""
    ? null
    : value.startsWith("key:")
      ? { type: "key", code: value.slice(4) }
      : { type: "mouse_button", button: Number(value.slice(6)) };
  changed();
}

function encodeAdsSource(source: Profile["mouse"]["ads_activation"]): string {
  if (!source) return "";
  return source.type === "key" ? `key:${source.code}` : `mouse:${source.button}`;
}

function clearAdsSourceIfRemoved(source: string, isMouse: boolean): void {
  const activation = selectedProfile().mouse.ads_activation;
  if (
    (activation?.type === "key" && !isMouse && activation.code === source) ||
    (activation?.type === "mouse_button" && isMouse && activation.button === Number(source))
  ) {
    selectedProfile().mouse.ads_activation = null;
  }
}

function addGameAssociation(): void {
  const associations = selectedProfile().game_associations;
  if (associations.length >= 20) {
    setStatus(t("maxGames"), true);
    return;
  }
  let suffix = associations.length + 1;
  while (associations.some(({ title_id }) => title_id === `game-${suffix}`)) suffix += 1;
  associations.push({ title_id: `game-${suffix}`, title_name: `game ${suffix}`, aliases: [] });
  changed(true);
}

function renderGameAssociations(profile: Profile): void {
  elements.games.replaceChildren(...profile.game_associations.map((association, index) => {
    const row = document.createElement("div");
    row.className = "game-row";
    const titleId = gameInput(t("titleId"), association.title_id, 80);
    const titleName = gameInput(t("normalizedTitle"), association.title_name, 1000);
    const aliases = gameAliasesInput(association.aliases);
    titleId.addEventListener("input", markPendingEdit);
    titleName.addEventListener("input", markPendingEdit);
    aliases.addEventListener("input", markPendingEdit);
    titleId.addEventListener("change", () => {
      association.title_id = normalizeGameText(titleId.value).replace(/\s+/g, "-");
      changed(true);
    });
    titleName.addEventListener("change", () => {
      association.title_name = normalizeGameText(titleName.value);
      changed(true);
    });
    aliases.addEventListener("change", () => {
      association.aliases = [...new Set(
        aliases.value.split(/\r?\n/).map(normalizeGameText).filter(Boolean),
      )].filter((alias) => alias !== association.title_name);
      changed(true);
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "danger";
    remove.textContent = "×";
    remove.setAttribute("aria-label", t("removeGame", String(index + 1)));
    remove.addEventListener("click", () => {
      profile.game_associations.splice(index, 1);
      changed(true);
    });
    row.append(titleId, titleName, aliases, remove);
    return row;
  }));
}

function gameInput(label: string, value: string, maxLength: number): HTMLInputElement {
  const input = document.createElement("input");
  input.value = value;
  input.maxLength = maxLength;
  input.setAttribute("aria-label", label);
  return input;
}

function gameAliasesInput(values: readonly string[]): HTMLTextAreaElement {
  const input = document.createElement("textarea");
  input.value = values.join("\n");
  input.maxLength = 1000;
  input.rows = 3;
  input.placeholder = t("aliasesPlaceholder");
  input.setAttribute("aria-label", t("aliasesLabel"));
  return input;
}

function markPendingEdit(): void {
  dirty = true;
  setStatus(t("unsavedChanges"));
}

window.addEventListener("beforeunload", (event) => {
  stopCalibration(t("stopped"));
  if (dirty) event.preventDefault();
});
window.addEventListener("pagehide", () => stopCalibration(t("stopped")));
window.addEventListener("blur", () => stopCalibration(t("windowLostFocus")));
document.addEventListener("pointerlockchange", () => {
  if (calibrationActive && document.pointerLockElement !== elements.calibrationSurface) {
    stopCalibration(t("pointerLost"));
  }
});
window.addEventListener("mousemove", onCalibrationMove);
window.addEventListener("keydown", onSourceKey, true);
window.addEventListener("mousedown", onSourceMouse, true);
window.addEventListener("mouseup", suppressCapturedMouseEvent, true);
window.addEventListener("click", suppressCapturedMouseEvent, true);
window.addEventListener("auxclick", suppressCapturedMouseEvent, true);
window.addEventListener("contextmenu", suppressCapturedMouseEvent, true);

void load();
void loadDiagnostics();

interface DiagnosticsResponse {
  snapshot: DiagnosticsSnapshot;
  persistence: boolean;
  performance_overlay: boolean;
  export: DiagnosticsExport;
}

async function loadDiagnostics(): Promise<void> {
  try {
    const response = await sendRuntime({ type: "get_diagnostics" });
    if (!isDiagnosticsResponse(response)) throw new Error("Invalid diagnostics response");
    renderDiagnostics(response);
    elements.diagnosticsStatus.textContent = t("diagnosticsEphemeralNotice");
  } catch {
    elements.diagnosticsStatus.textContent = t("diagnosticsUnavailable");
  }
}

async function saveDiagnosticsPreferences(): Promise<void> {
  try {
    const response = await sendRuntime({
      type: "set_diagnostics_preferences",
      persistence: elements.persistDiagnostics.checked,
      performance_overlay: elements.performanceOverlay.checked,
    });
    if (!isDiagnosticsResponse(response)) throw new Error("Invalid diagnostics response");
    renderDiagnostics(response);
    elements.diagnosticsStatus.textContent = t("diagnosticsPreferencesSaved");
  } catch {
    elements.diagnosticsStatus.textContent = t("diagnosticsPreferenceFailed");
  }
}

async function resetDiagnostics(): Promise<void> {
  if (!window.confirm(t("resetDiagnosticsConfirm"))) return;
  try {
    const response = await sendRuntime({ type: "reset_diagnostics" });
    if (!isDiagnosticsResponse(response)) throw new Error("Invalid diagnostics response");
    renderDiagnostics(response);
    elements.diagnosticsStatus.textContent = t("diagnosticsReset");
  } catch {
    elements.diagnosticsStatus.textContent = t("diagnosticsUnavailable");
  }
}

async function exportDiagnostics(): Promise<void> {
  try {
    const response = await sendRuntime({ type: "get_diagnostics" });
    if (!isDiagnosticsResponse(response)) throw new Error("Invalid diagnostics response");
    downloadJson("xbox-input-bridge-diagnostics.json", response.export);
    elements.diagnosticsStatus.textContent = t("diagnosticsExported");
  } catch {
    elements.diagnosticsStatus.textContent = t("diagnosticsUnavailable");
  }
}

async function runSelfTests(): Promise<void> {
  const button = requireElement<HTMLButtonElement>("run-self-tests");
  button.disabled = true;
  elements.selfTestResults.replaceChildren();
  elements.diagnosticsStatus.textContent = t("selfTestsRunning");
  try {
    const [timerElapsedMs, bridgeResponse, stored] = await Promise.all([
      testTimer(),
      sendRuntime({ type: "diagnostics_ping" }),
      chrome.storage.local.get(PROFILE_STORAGE_KEY),
    ]);
    const bridge = isBridgeSelfTestResponse(bridgeResponse)
      ? bridgeResponse : { contentScript: false, mainWorld: false, watchdog: false };
    const results = runCompatibilitySelfTests({
      userAgent: navigator.userAgent,
      pointerLockSupported: typeof document.documentElement.requestPointerLock === "function",
      gamepadApiSupported: typeof navigator.getGamepads === "function",
      localStorageSupported: Boolean(chrome.storage?.local),
      profileDocument: stored[PROFILE_STORAGE_KEY] ?? documentState,
      timerElapsedMs,
      bridge,
    });
    renderSelfTests(results);
    elements.diagnosticsStatus.textContent = t(`selfTests_${summarizeSelfTests(results)}`);
  } catch {
    elements.diagnosticsStatus.textContent = t("selfTestsFailed");
  } finally {
    button.disabled = false;
  }
}

function renderDiagnostics(response: DiagnosticsResponse): void {
  elements.persistDiagnostics.checked = response.persistence;
  elements.performanceOverlay.checked = response.performance_overlay;
  const snapshot = response.snapshot;
  const average = (duration: DiagnosticsSnapshot["durations"]["mapping_processing_ms"]): string =>
    duration.count === 0 ? t("notMeasured") : `${(duration.sum_ms / duration.count).toFixed(3)} ms`;
  const metrics: [string, string][] = [
    [t("inputEventRate"), `${snapshot.rates.input_events_hz.toFixed(1)} Hz`],
    [t("batchRate"), `${snapshot.rates.batches_hz.toFixed(1)} Hz`],
    [t("averageBatchSize"), snapshot.rates.average_batch_size.toFixed(2)],
    [t("mappingDuration"), average(snapshot.durations.mapping_processing_ms)],
    [t("pipelineEstimate"), average(snapshot.durations.extension_pipeline_estimate_ms)],
    [t("droppedEvents"), String(snapshot.totals.dropped_events)],
    [t("bridgeReconnects"), String(snapshot.totals.bridge_reconnects)],
    [t("profileSwitches"), String(snapshot.totals.profile_switches)],
    [t("captureUptime"), formatDuration(snapshot.capture.uptime_ms)],
    [t("sessionStopReasons"), Object.entries(snapshot.stop_reasons)
      .map(([reason, count]) => `${reason}: ${count}`).join(", ") || t("none")],
    [t("recentFailures"), snapshot.recent_failures
      .map(({ category, code, count }) => `${category}/${code}: ${count}`).join(", ") || t("none")],
  ];
  elements.diagnosticsMetrics.replaceChildren(...metrics.flatMap(([label, value]) => {
    const term = document.createElement("dt");
    term.textContent = label;
    const description = document.createElement("dd");
    description.textContent = value;
    return [term, description];
  }));
}

function renderSelfTests(results: readonly SelfTestResult[]): void {
  elements.selfTestResults.replaceChildren(...results.map((result) => {
    const item = document.createElement("li");
    item.className = `self-test-${result.status}`;
    const prefix = t(`selfTestStatus_${result.status}`);
    item.textContent = `${prefix}: ${result.summary}${result.action ? ` ${result.action}` : ""}`;
    return item;
  }));
}

function sendRuntime(message: import("./protocol").RuntimeMessage): Promise<unknown> {
  return Promise.resolve().then(() => chrome.runtime.sendMessage(message));
}

function isDiagnosticsResponse(value: unknown): value is DiagnosticsResponse {
  return typeof value === "object" && value !== null &&
    "snapshot" in value && "persistence" in value && "performance_overlay" in value &&
    "export" in value && typeof value.persistence === "boolean" &&
    typeof value.performance_overlay === "boolean";
}

function isBridgeSelfTestResponse(value: unknown): value is {
  contentScript: boolean;
  mainWorld: boolean;
  watchdog: boolean;
} {
  return typeof value === "object" && value !== null &&
    "contentScript" in value && typeof value.contentScript === "boolean" &&
    "mainWorld" in value && typeof value.mainWorld === "boolean" &&
    "watchdog" in value && typeof value.watchdog === "boolean";
}

function downloadJson(name: string, value: unknown): void {
  const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

function formatDuration(value: number): string {
  const seconds = Math.floor(value / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  return `${hours}h ${minutes}m ${seconds % 60}s`;
}

async function load(): Promise<void> {
  try {
    const stored = await chrome.storage.local.get([
      PROFILE_STORAGE_KEY,
      OVERLAY_SHORTCUT_STORAGE_KEY,
      ONBOARDING_STORAGE_KEY,
      CONTRAST_STORAGE_KEY,
    ]);
    applyHighContrast(stored[CONTRAST_STORAGE_KEY] === true);
    overlayShortcut = parseOverlayShortcut(stored[OVERLAY_SHORTCUT_STORAGE_KEY]);
    const raw = stored[PROFILE_STORAGE_KEY] as unknown;
    if (raw === undefined) {
      await persist(documentState);
      setStatus(t("starterProfilesCreated"));
    } else {
      const result = parseProfileDocument(raw);
      if (!result.ok) {
        setStatus(t("storedProfilesInvalid"), true);
        render();
        return;
      }
      documentState = result.value;
      selectedProfileId = documentState.active_profile_id;
      if (result.migrated) {
        await persist(documentState);
        setStatus(t("profileUpgraded"));
      }
    }
    dirty = false;
    render();
    if (needsOnboarding(stored[ONBOARDING_STORAGE_KEY])) showOnboarding();
  } catch {
    setStatus(t("readStorageFailed"), true);
    render();
  }
}

function render(): void {
  const profile = selectedProfile();
  renderProfileList();
  elements.overlayShortcut.replaceChildren(
    ...Object.entries(OVERLAY_SHORTCUTS).map(([id, shortcut]) =>
      option(id, shortcut.label, id === overlayShortcut)),
  );
  elements.name.value = profile.name;
  elements.id.value = profile.id;
  const response = selectedResponse();
  elements.sensitivityX.value = String(response.sensitivity_x);
  elements.sensitivityY.value = String(response.sensitivity_y);
  elements.deadzone.value = String(response.deadzone);
  elements.curve.value = response.curve;
  elements.invertX.checked = response.invert_x;
  elements.invertY.checked = response.invert_y;
  elements.smoothing.value = String(response.smoothing);
  elements.velocityScale.value = String(response.velocity_scale);
  renderAdsSources(profile);
  renderGameAssociations(profile);
  renderCurvePreview();
  renderBindings(elements.keys, profile.key_bindings, false);
  renderBindings(elements.mouse, profile.mouse_bindings, true);
  renderController(profile);
  renderConflicts(profile);
  requireElement<HTMLButtonElement>("delete-profile").disabled = documentState.profiles.length === 1;
}

function renderProfileList(): void {
  const visible = documentState.profiles.filter((profile) =>
    matchesProfileSearch(profile, elements.profileSearch.value, starterProfileLabel(profile)));
  const selected = selectedProfile();
  if (!visible.some(({ id }) => id === selected.id)) visible.unshift(selected);
  elements.profile.replaceChildren(
    ...visible.map((item) => option(item.id, starterProfileLabel(item), item.id === selected.id)),
  );
}

function renderBindings(
  container: HTMLElement,
  bindings: Record<string, Target[]>,
  isMouse: boolean,
): void {
  const rows = Object.entries(bindings)
    .sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true }))
    .map(([source, targets]) => {
      const row = document.createElement("div");
      row.className = "binding-row";

      const action = document.createElement("div");
      const actionNames = targets.map((target) => t(actionLabelKey(selectedProfile(), target)));
      const targetNames = targets.map(controllerTargetLabel);
      const actionTitle = document.createElement("strong");
      actionTitle.className = "action-name";
      actionTitle.textContent = [...new Set(actionNames)].join(" / ");
      const explanation = document.createElement("span");
      explanation.className = "controller-explanation";
      explanation.textContent = `${[...new Set(actionNames)].join(" / ")} → ${targetNames.join(" + ")}`;
      action.append(actionTitle, explanation);

      const sourceInput = document.createElement("button");
      sourceInput.type = "button";
      sourceInput.className = "secondary capture-source";
      sourceInput.textContent = friendlyInputLabel(source, isMouse, t);
      sourceInput.dataset.source = source;
      sourceInput.dataset.captureKind = isMouse ? "mouse" : "keyboard";
      const rawSource = document.createElement("span");
      rawSource.className = "advanced-code";
      rawSource.textContent = source;
      sourceInput.append(rawSource);
      sourceInput.setAttribute("aria-label", t(isMouse ? "changeMouse" : "changeKey", source));
      sourceInput.addEventListener("click", () => startSourceCapture(isMouse ? "mouse" : "keyboard", source, sourceInput));

      const targetList = document.createElement("div");
      targetList.className = "target-list advanced-only";
      targets.forEach((target, targetIndex) => {
        const targetRow = document.createElement("div");
        targetRow.className = "target-row";
        const select = document.createElement("select");
        select.setAttribute("aria-label", t("controllerTarget", [String(targetIndex + 1), source]));
        for (const [value, label] of targetOptions()) {
          select.append(option(value, label, value === encodeTarget(target)));
        }
        select.addEventListener("change", () => {
          const replacement = decodeTarget(select.value);
          if (replacement) {
            bindings[source] = replaceTarget(targets, targetIndex, replacement);
            changed(true);
          }
        });
        const removeTargetButton = document.createElement("button");
        removeTargetButton.type = "button";
        removeTargetButton.className = "danger";
        removeTargetButton.textContent = "−";
        removeTargetButton.disabled = targets.length === 1;
        removeTargetButton.setAttribute("aria-label", t("removeTarget", [String(targetIndex + 1), source]));
        removeTargetButton.addEventListener("click", () => {
          bindings[source] = removeTarget(targets, targetIndex);
          changed(true);
        });
        targetRow.append(select, removeTargetButton);
        targetList.append(targetRow);
      });
      const addTargetButton = document.createElement("button");
      addTargetButton.type = "button";
      addTargetButton.className = "secondary add-target";
      addTargetButton.textContent = t("addTarget", source);
      addTargetButton.disabled = targets.length >= 4 || nextAvailableTarget(targets) === null;
      addTargetButton.setAttribute("aria-label", t("addTarget", source));
      addTargetButton.addEventListener("click", () => {
        const target = nextAvailableTarget(targets);
        if (target) {
          bindings[source] = addTarget(targets, target);
          changed(true);
        }
      });
      targetList.append(addTargetButton);

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "danger";
      remove.textContent = "×";
      remove.setAttribute("aria-label", t("removeBinding", source));
      remove.addEventListener("click", () => {
        delete bindings[source];
        clearAdsSourceIfRemoved(source, isMouse);
        changed(true);
      });
      row.append(action, sourceInput, targetList, remove);
      return row;
    });
  container.replaceChildren(...rows);
}

function startSourceCapture(
  kind: CaptureKind,
  oldSource: string | null,
  button: HTMLButtonElement | null = null,
): void {
  cancelSourceCapture(false);
  capture = { kind, oldSource, button };
  if (button) {
    button.classList.add("capturing");
    button.textContent = t(kind === "keyboard" ? "pressKey" : "pressMouse");
  }
  setStatus(t(kind === "keyboard" ? "pressKey" : "pressMouse"));
}

function onSourceKey(event: KeyboardEvent): void {
  if (!capture) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  const result = resolveCapture(
    capture.kind,
    { code: event.code },
    Object.keys(capture.kind === "mouse" ? selectedProfile().mouse_bindings : selectedProfile().key_bindings),
    capture.oldSource,
  );
  applyCaptureResult(result);
}

function suppressCapturedMouseEvent(event: Event): void {
  if (!suppressCapturedMouse) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}

function onSourceMouse(event: MouseEvent): void {
  if (!capture || capture.kind !== "mouse") return;
  event.preventDefault();
  event.stopImmediatePropagation();
  const result = resolveCapture(
    "mouse",
    { button: event.button },
    Object.keys(selectedProfile().mouse_bindings),
    capture.oldSource,
  );
  suppressCapturedMouse = true;
  window.setTimeout(() => {
    suppressCapturedMouse = false;
  }, 250);
  applyCaptureResult(result);
}

function applyCaptureResult(result: ReturnType<typeof resolveCapture>): void {
  if (!capture) return;
  if (result.status === "cancelled") {
    cancelSourceCapture();
    return;
  }
  if (result.status === "duplicate") {
    setStatus(t("duplicateSource", result.source), true);
    return;
  }
  if (result.status === "invalid") {
    if (capture.kind === "keyboard") setStatus(t("invalidSource"), true);
    return;
  }
  const { kind, oldSource } = capture;
  if (oldSource === result.source) {
    capture.button?.classList.remove("capturing");
    capture.button!.textContent = friendlyInputLabel(result.source, kind === "mouse", t);
    capture = null;
    setStatus(t("bindingUnchanged"));
    return;
  }
  capture = null;
  const bindings = kind === "mouse"
    ? selectedProfile().mouse_bindings
    : selectedProfile().key_bindings;
  if (oldSource === null) {
    bindings[result.source] = [{ button: BUTTONS.a }];
    changed(true);
    setStatus(t("bindingAdded", result.source));
  } else {
    renameBinding(bindings, oldSource, result.source, kind === "mouse");
    setStatus(t("bindingChanged", [oldSource, result.source]));
  }
  focusBindingSource(kind, result.source);
}

function cancelSourceCapture(announce = true): void {
  if (!capture) return;
  const { kind, oldSource } = capture;
  capture.button?.classList.remove("capturing");
  capture = null;
  render();
  if (oldSource) focusBindingSource(kind, oldSource);
  else requireElement<HTMLButtonElement>(kind === "mouse" ? "add-mouse" : "add-key").focus();
  if (announce) setStatus(t("captureCancelled"));
}

function updateSettings(): void {
  const profile = selectedProfile();
  const previousId = profile.id;
  profile.name = elements.name.value;
  profile.id = elements.id.value;
  const response = selectedResponse();
  response.sensitivity_x = elements.sensitivityX.valueAsNumber;
  response.sensitivity_y = elements.sensitivityY.valueAsNumber;
  response.deadzone = elements.deadzone.valueAsNumber;
  response.curve = elements.curve.value as ResponseCurve;
  response.invert_x = elements.invertX.checked;
  response.invert_y = elements.invertY.checked;
  response.smoothing = elements.smoothing.valueAsNumber;
  response.velocity_scale = elements.velocityScale.valueAsNumber;
  renderCurvePreview();
  if (profile.id !== previousId) {
    selectedProfileId = profile.id;
    documentState.active_profile_id = profile.id;
  }
  changed();
}

function renameBinding(
  bindings: Record<string, Target[]>,
  oldSource: string,
  newSource: string,
  isMouse: boolean,
): void {
  if (newSource === oldSource) return;
  if (!(isMouse ? /^(?:0|1|2|3|4)$/.test(newSource) : /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(newSource))) {
    setStatus(t("invalidSource"), true);
    render();
    return;
  }
  if (newSource in bindings) {
    setStatus(t("duplicateSource", newSource), true);
    render();
    return;
  }
  replaceBindingSource(bindings, oldSource, newSource);
  const activation = selectedProfile().mouse.ads_activation;
  if (activation?.type === "key" && !isMouse && activation.code === oldSource) {
    activation.code = newSource;
  } else if (activation?.type === "mouse_button" && isMouse && activation.button === Number(oldSource)) {
    activation.button = Number(newSource);
  }
  changed(true);
}

function addBinding(isMouse: boolean): void {
  const bindings = isMouse ? selectedProfile().mouse_bindings : selectedProfile().key_bindings;
  if (isMouse && Object.keys(bindings).length >= 5) {
    setStatus(t("allMouseAssigned"), true);
    return;
  }
  startSourceCapture(isMouse ? "mouse" : "keyboard", null);
}

function duplicateProfile(): void {
  if (documentState.profiles.length >= 20) {
    setStatus(t("maxProfiles"), true);
    return;
  }
  const source = selectedProfile();
  const id = uniqueId(`${source.id}-copy`);
  const copy = structuredClone(source);
  copy.id = id;
  copy.name = `${source.name} ${t("copySuffix")}`.slice(0, 60);
  documentState.profiles.push(copy);
  selectedProfileId = id;
  documentState.active_profile_id = id;
  changed(true);
}

function deleteProfile(): void {
  if (documentState.profiles.length === 1) return;
  const index = documentState.profiles.findIndex(({ id }) => id === selectedProfileId);
  documentState.profiles.splice(index, 1);
  selectedProfileId = documentState.profiles[Math.max(0, index - 1)]!.id;
  documentState.active_profile_id = selectedProfileId;
  changed(true);
}

async function save(): Promise<void> {
  const result = parseProfileDocument(documentState);
  if (!result.ok) {
    setStatus(t("notSaved"), true);
    return;
  }
  try {
    await persist(result.value);
    documentState = result.value;
    dirty = false;
    setStatus(t("profilesSaved"));
    render();
  } catch {
    setStatus(t("saveFailed"), true);
  }
}

async function reset(): Promise<void> {
  if (!window.confirm(t("resetConfirm"))) return;
  const replacement = createStarterProfiles();
  try {
    await persist(replacement);
    documentState = replacement;
    selectedProfileId = replacement.active_profile_id;
    dirty = false;
    setStatus(t("startersRestored"));
    render();
  } catch {
    setStatus(t("resetFailed"), true);
  }
}

async function importProfiles(): Promise<void> {
  const file = elements.importFile.files?.[0];
  elements.importFile.value = "";
  if (!file) return;
  if (file.size > MAX_IMPORT_BYTES) {
    setStatus(t("importTooLarge"), true);
    return;
  }
  try {
    const result = parseProfileJson(await file.text());
    if (!result.ok) {
      setStatus(t("importRejected"), true);
      return;
    }
    documentState = result.value;
    selectedProfileId = result.value.active_profile_id;
    dirty = true;
    setStatus(t(result.migrated ? "legacyImported" : "profilesImported"));
    render();
  } catch {
    setStatus(t("readFileFailed"), true);
  }
}

function exportProfiles(): void {
  const result = parseProfileDocument(documentState);
  if (!result.ok) {
    setStatus(t("exportBlocked"), true);
    return;
  }
  const blob = new Blob([`${JSON.stringify(result.value, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "xbox-input-bridge-profiles.json";
  anchor.click();
  URL.revokeObjectURL(url);
  setStatus(t("profilesExported"));
}

async function persist(value: ProfileDocument): Promise<void> {
  const result = parseProfileDocument(value);
  if (!result.ok) throw new Error(result.errors.join(" "));
  await chrome.storage.local.set({
    [PROFILE_STORAGE_KEY]: result.value,
    [OVERLAY_SHORTCUT_STORAGE_KEY]: overlayShortcut,
  });
}

function changed(rerender = false): void {
  dirty = true;
  setStatus(t("unsavedChanges"));
  if (rerender) render();
  else renderConflicts(selectedProfile());
}

function renderConflicts(profile: Profile): void {
  const validation = parseProfileDocument(documentState);
  const warnings = localizedBindingWarnings(profile);
  if (!validation.ok && validation.errors.some((error) => error.startsWith("Game association "))) {
    warnings.push(t("gameAssociationInvalid"));
  }
  elements.conflicts.replaceChildren(...warnings.map((warning) => {
    const item = document.createElement("li");
    item.textContent = warning;
    return item;
  }));
  elements.conflictsCard.hidden = warnings.length === 0;
}

function renderCurvePreview(): void {
  const deadzone = Number.isFinite(elements.deadzone.valueAsNumber)
    ? elements.deadzone.valueAsNumber
    : 0;
  const curve = elements.curve.value as ResponseCurve;
  elements.curveLine.setAttribute(
    "points",
    previewPoints(deadzone, curve)
      .map(([input, output]) => `${24 + input * 288},${156 - output * 148}`)
      .join(" "),
  );
}

async function startCalibration(): Promise<void> {
  if (calibrationActive) return;
  calibrationSamples = [];
  currentSuggestion = null;
  renderSuggestion();
  try {
    await elements.calibrationSurface.requestPointerLock();
    if (document.pointerLockElement !== elements.calibrationSurface) {
      stopCalibration(t("pointerUnavailable"));
      return;
    }
    calibrationActive = true;
    elements.startCalibration.disabled = true;
    elements.stopCalibration.disabled = false;
    elements.calibrationSurface.classList.add("capturing");
    elements.calibrationState.textContent = t("calibrationCapturing");
    renderCalibration({ dx: 0, dy: 0 });
  } catch {
    stopCalibration(t("pointerDenied"));
  }
}

function onCalibrationMove(event: MouseEvent): void {
  if (!calibrationActive || document.pointerLockElement !== elements.calibrationSurface) return;
  const sample = { dx: event.movementX, dy: event.movementY };
  if (sample.dx === 0 && sample.dy === 0) return;
  calibrationSamples = addCalibrationSample(calibrationSamples, sample);
  currentSuggestion = suggestedSensitivity(calibrationSamples);
  renderCalibration(sample);
  renderSuggestion();
}

function stopCalibration(label: string): void {
  const wasActive = calibrationActive;
  calibrationActive = false;
  calibrationSamples = [];
  elements.startCalibration.disabled = false;
  elements.stopCalibration.disabled = true;
  elements.calibrationSurface.classList.remove("capturing");
  elements.calibrationState.textContent = label;
  if (wasActive) renderCalibration({ dx: 0, dy: 0 });
  if (wasActive && document.pointerLockElement === elements.calibrationSurface) {
    document.exitPointerLock();
  }
}

function renderCalibration(sample: CalibrationSample): void {
  const stick = normalizedStick(sample, selectedResponse());
  elements.calibrationValues.value =
    t("calibrationValues", [
      String(sample.dx),
      String(sample.dy),
      stick.dx.toFixed(3),
      stick.dy.toFixed(3),
      String(calibrationSamples.length),
    ]);
  elements.stickDot.style.left = `${50 + stick.dx * 46}%`;
  elements.stickDot.style.top = `${50 - stick.dy * 46}%`;
  elements.controllerStickDot.setAttribute("cx", String(424 + stick.dx * 27));
  elements.controllerStickDot.setAttribute("cy", String(275 - stick.dy * 27));
  elements.controllerOutput.value = t("rightStickOutput", [
    stick.dx.toFixed(3),
    stick.dy.toFixed(3),
  ]);
}

function renderSuggestion(): void {
  elements.suggestion.hidden = currentSuggestion === null;
  elements.suggestedValue.textContent = currentSuggestion?.toFixed(3) ?? "";
}

function applySuggestion(): void {
  if (currentSuggestion === null) return;
  elements.sensitivityX.value = String(currentSuggestion);
  elements.sensitivityY.value = String(currentSuggestion);
  updateSettings();
  setStatus(t("suggestionApplied"));
}

function renderController(profile: Profile): void {
  const parts = controllerParts(profile);
  const byTarget = new Map(parts.map((part) => [part.target, part]));
  for (const control of elements.controllerDiagram.querySelectorAll<SVGGElement>("[data-target]")) {
    const target = control.dataset.target;
    const part = target ? byTarget.get(target) : undefined;
    const label = target ? controllerTargetLabel(decodeTarget(target) ?? target as Target) : "";
    const action = part && target
      ? t(actionLabelKey(profile, decodeTarget(target) ?? target as Target))
      : "";
    const description = part?.mapped
      ? t("mappedControl", [`${action} — ${label}`, part.sources.map((source) =>
          friendlyInputLabel(source.replace("Mouse ", ""), source.startsWith("Mouse "), t)).join(", ")])
      : t("unmappedControl", label);
    control.classList.toggle("mapped", part?.mapped === true);
    control.setAttribute("role", "img");
    control.setAttribute("aria-label", description);
  }
  elements.controllerMappings.replaceChildren(
    ...parts.filter(({ mapped }) => mapped).map((part) => {
      const item = document.createElement("li");
      item.textContent = t("mappedControl", [
        `${t(actionLabelKey(profile, decodeTarget(part.target) ?? part.target as Target))} — ${
          controllerTargetLabel(decodeTarget(part.target) ?? part.target as Target)
        }`,
        part.sources.map((source) =>
          friendlyInputLabel(source.replace("Mouse ", ""), source.startsWith("Mouse "), t)).join(", "),
      ]);
      return item;
    }),
  );
}

function showOnboarding(step = 0): void {
  onboardingStep = step;
  if (step === 0) {
    onboardingProfileChanged = false;
    onboardingInitialProfileId = selectedProfileId;
    requireElement<HTMLButtonElement>("resume-onboarding").hidden = true;
  }
  elements.onboardingProfile.replaceChildren(
    ...documentState.profiles.map((profile) =>
      option(profile.id, starterProfileLabel(profile), profile.id === selectedProfileId)),
  );
  renderReadiness();
  if (!elements.onboarding.open) elements.onboarding.showModal();
  setOnboardingStep(step);
}

function setOnboardingStep(step: number): void {
  onboardingStep = Math.max(0, Math.min(4, step));
  for (const section of elements.onboarding.querySelectorAll<HTMLElement>(".onboarding-step")) {
    section.hidden = Number(section.dataset.step) !== onboardingStep;
  }
  elements.onboardingProgress.textContent = t("tourProgress", [String(onboardingStep + 1), "5"]);
  elements.onboardingBack.disabled = onboardingStep === 0;
  elements.onboardingNext.textContent = t(onboardingStep === 4 ? "finish" : "next");
  if (onboardingStep === 2) renderReadiness();
  const heading = elements.onboarding.querySelector<HTMLElement>(".onboarding-step:not([hidden]) h2");
  if (heading) {
    heading.tabIndex = -1;
    heading.focus();
  }
}

function selectOnboardingProfile(): void {
  if (!documentState.profiles.some(({ id }) => id === elements.onboardingProfile.value)) return;
  onboardingProfileChanged = elements.onboardingProfile.value !== onboardingInitialProfileId;
  selectedProfileId = elements.onboardingProfile.value;
  documentState.active_profile_id = selectedProfileId;
  render();
}

async function closeOnboarding(outcome: "completed" | "skipped"): Promise<void> {
  elements.onboarding.close();
  try {
    await persistOnboarding(outcome);
  } catch {
    setStatus(t("saveFailed"), true);
  }
}

async function persistOnboarding(outcome: "completed" | "skipped"): Promise<void> {
  const stored = await chrome.storage.local.get(PROFILE_STORAGE_KEY);
  const storedProfiles = parseProfileDocument(stored[PROFILE_STORAGE_KEY]);
  const values: Record<string, unknown> = {
    [ONBOARDING_STORAGE_KEY]: finishOnboarding(outcome),
  };
  if (
    onboardingProfileChanged &&
    storedProfiles.ok &&
    storedProfiles.value.profiles.some(({ id }) => id === selectedProfileId)
  ) {
    storedProfiles.value.active_profile_id = selectedProfileId;
    values[PROFILE_STORAGE_KEY] = storedProfiles.value;
  }
  await chrome.storage.local.set(values);
  onboardingProfileChanged = false;
}

function renderReadiness(): void {
  const checks = [
    [t("readinessPointerLock"), typeof elements.calibrationSurface.requestPointerLock === "function"],
    [t("readinessStorage"), Boolean(chrome.storage?.local)],
    [t("readinessProfile"), documentState.profiles.some(({ id }) => id === selectedProfileId)],
  ] as const;
  const readiness = activationReady({
    pointerLock: checks[0][1],
    localStorage: checks[1][1],
    starterProfile: checks[2][1],
  });
  elements.onboardingNext.disabled = onboardingStep === 2 && !readiness;
  requireElement<HTMLUListElement>("readiness-list").replaceChildren(...checks.map(([label, ready]) => {
    const item = document.createElement("li");
    item.className = ready ? "ready" : "not-ready";
    item.textContent = `${ready ? "✓" : "!"} ${label}: ${t(ready ? "ready" : "notReady")}`;
    return item;
  }));
}

async function setHighContrast(enabled: boolean): Promise<void> {
  applyHighContrast(enabled);
  await chrome.storage.local.set({ [CONTRAST_STORAGE_KEY]: enabled });
}

function applyHighContrast(enabled: boolean): void {
  document.documentElement.classList.toggle("high-contrast", enabled);
  elements.contrast.setAttribute("aria-pressed", String(enabled));
  elements.contrast.textContent = t(enabled ? "useStandardContrast" : "highContrast");
}

function selectedProfile(): Profile {
  return documentState.profiles.find(({ id }) => id === selectedProfileId) ?? documentState.profiles[0]!;
}

function setStatus(message: string, error = false): void {
  elements.status.textContent = message;
  elements.status.classList.toggle("error", error);
}

function uniqueId(base: string): string {
  const normalized = base.toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 40);
  if (!documentState.profiles.some(({ id }) => id === normalized)) return normalized;
  for (let suffix = 2; suffix <= 20; suffix += 1) {
    const candidate = `${normalized.slice(0, 37)}-${suffix}`;
    if (!documentState.profiles.some(({ id }) => id === candidate)) return candidate;
  }
  return `profile-${Date.now().toString(36)}`.slice(0, 40);
}

function targetOptions(): [string, string][] {
  return [
    ...AXIS_TARGETS.map((target): [string, string] => [target, controllerTargetLabel(target)]),
    ...Object.values(BUTTONS).map((code): [string, string] => [`button:${code}`, controllerTargetLabel({ button: code })]),
  ];
}

function labelTarget(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function controllerTargetLabel(target: Target): string {
  if (typeof target === "string") {
    const labels: Record<string, string> = {
      left_x_negative: t("leftStickLeft"),
      left_x_positive: t("leftStickRight"),
      left_y_negative: t("leftStickBack"),
      left_y_positive: t("leftStickForward"),
      left_trigger: t("leftTrigger"),
      right_trigger: t("rightTrigger"),
    };
    return labels[target] ?? labelTarget(target);
  }
  const name = Object.entries(BUTTONS).find(([, value]) => value === target.button)?.[0];
  const labels: Record<string, string> = {
    a: t("aButton"), b: t("bButton"), x: t("xButton"), y: t("yButton"),
    left_thumb: t("leftStickClick"), right_thumb: t("rightStickClick"),
    left_shoulder: t("leftBumper"), right_shoulder: t("rightBumper"),
    start: t("menuButton"), back: t("viewButton"), guide: t("guideButton"),
    dpad_up: t("dpadUp"), dpad_down: t("dpadDown"),
    dpad_left: t("dpadLeft"), dpad_right: t("dpadRight"),
  };
  return name ? labels[name] ?? labelTarget(name) : String(target.button);
}

function starterProfileLabel(profile: Profile): string {
  const starterNames: Record<string, string> = {
    default: "Default",
    fps: "FPS",
    racing: "Racing",
    action: "Third-person / Action",
    platformer: "Platformer",
    "one-handed": "Accessibility: One-handed",
  };
  if (starterNames[profile.id] !== profile.name) return profile.name;
  const key = `starter_${profile.id.replace("-", "_")}`;
  const translated = t(key);
  return translated === key ? profile.name : translated;
}

function encodeTarget(target: Target): string {
  return typeof target === "string" ? target : `button:${target.button}`;
}

function decodeTarget(value: string): Target | null {
  if ((AXIS_TARGETS as readonly string[]).includes(value)) return value as Target;
  if (value.startsWith("button:")) {
    const code = Number(value.slice(7));
    if (Object.values(BUTTONS).includes(code as never)) return { button: code };
  }
  return null;
}

function nextAvailableTarget(targets: readonly Target[]): Target | null {
  const used = new Set(targets.map(encodeTarget));
  for (const [value] of targetOptions()) {
    if (!used.has(value)) return decodeTarget(value);
  }
  return null;
}

function option(value: string, label: string, selected: boolean): HTMLOptionElement {
  const element = document.createElement("option");
  element.value = value;
  element.textContent = label;
  element.selected = selected;
  return element;
}

function requireElement<T extends Element>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing required element #${id}`);
  return element as unknown as T;
}
