import {
  AXIS_TARGETS,
  BUTTONS,
  MAX_IMPORT_BYTES,
  PROFILE_STORAGE_KEY,
  createStarterProfiles,
  duplicateBindingWarnings,
  normalizeGameText,
  parseProfileDocument,
  parseProfileJson,
  type Profile,
  type ProfileDocument,
  type ResponseCurve,
  type MouseSettings,
  type Target,
} from "./profile-schema";
import { searchProfiles } from "./game-profile";
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
};

let documentState = createStarterProfiles();
let selectedProfileId = documentState.active_profile_id;
let dirty = false;
let calibrationSamples: CalibrationSample[] = [];
let calibrationActive = false;
let currentSuggestion: number | null = null;
let overlayShortcut: OverlayShortcutId = DEFAULT_OVERLAY_SHORTCUT;

requireElement<HTMLButtonElement>("save").addEventListener("click", () => void save());
requireElement<HTMLButtonElement>("reset").addEventListener("click", () => void reset());
requireElement<HTMLButtonElement>("export").addEventListener("click", exportProfiles);
requireElement<HTMLButtonElement>("import").addEventListener("click", () => elements.importFile.click());
requireElement<HTMLButtonElement>("duplicate-profile").addEventListener("click", duplicateProfile);
requireElement<HTMLButtonElement>("delete-profile").addEventListener("click", deleteProfile);
requireElement<HTMLButtonElement>("add-key").addEventListener("click", () => addBinding(false));
requireElement<HTMLButtonElement>("add-mouse").addEventListener("click", () => addBinding(true));
requireElement<HTMLButtonElement>("add-game").addEventListener("click", addGameAssociation);
elements.startCalibration.addEventListener("click", () => void startCalibration());
elements.stopCalibration.addEventListener("click", () => stopCalibration("Stopped"));
elements.applySuggestion.addEventListener("click", applySuggestion);
elements.importFile.addEventListener("change", () => void importProfiles());
elements.responseMode.addEventListener("change", render);
elements.adsSource.addEventListener("change", updateAdsSource);
elements.profile.addEventListener("change", () => {
  stopCalibration("Stopped");
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

function selectedResponse(): MouseSettings {
  return selectedProfile().mouse[elements.responseMode.value === "ads" ? "ads" : "hip"];
}

function renderAdsSources(profile: Profile): void {
  const selected = encodeAdsSource(profile.mouse.ads_activation);
  const sources: [string, string][] = [
    ["", "None"],
    ...Object.keys(profile.key_bindings)
      .sort()
      .map((code): [string, string] => [`key:${code}`, `Keyboard: ${code}`]),
    ...Object.keys(profile.mouse_bindings)
      .sort()
      .map((button): [string, string] => [`mouse:${button}`, `Mouse button ${button}`]),
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
    setStatus("A maximum of 20 game associations is supported.", true);
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
    const titleId = gameInput("Title ID", association.title_id);
    const titleName = gameInput("Normalized title name", association.title_name);
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
    remove.setAttribute("aria-label", `Remove game association ${index + 1}`);
    remove.addEventListener("click", () => {
      profile.game_associations.splice(index, 1);
      changed(true);
    });
    row.append(titleId, titleName, aliases, remove);
    return row;
  }));
}

function gameInput(label: string, value: string): HTMLInputElement {
  const input = document.createElement("input");
  input.value = value;
  input.maxLength = label === "Title ID" ? 80 : 1000;
  input.setAttribute("aria-label", label);
  return input;
}

function gameAliasesInput(values: readonly string[]): HTMLTextAreaElement {
  const input = document.createElement("textarea");
  input.value = values.join("\n");
  input.maxLength = 1000;
  input.rows = 3;
  input.placeholder = "One normalized alias per line";
  input.setAttribute("aria-label", "Normalized aliases, one per line");
  return input;
}

function markPendingEdit(): void {
  dirty = true;
  setStatus("Unsaved changes.");
}

window.addEventListener("beforeunload", (event) => {
  stopCalibration("Stopped");
  if (dirty) event.preventDefault();
});
window.addEventListener("pagehide", () => stopCalibration("Stopped"));
window.addEventListener("blur", () => stopCalibration("Stopped (window lost focus)"));
document.addEventListener("pointerlockchange", () => {
  if (calibrationActive && document.pointerLockElement !== elements.calibrationSurface) {
    stopCalibration("Stopped (pointer lock lost)");
  }
});
window.addEventListener("mousemove", onCalibrationMove);

void load();

async function load(): Promise<void> {
  try {
    const stored = await chrome.storage.local.get([
      PROFILE_STORAGE_KEY,
      OVERLAY_SHORTCUT_STORAGE_KEY,
    ]);
    overlayShortcut = parseOverlayShortcut(stored[OVERLAY_SHORTCUT_STORAGE_KEY]);
    const raw = stored[PROFILE_STORAGE_KEY] as unknown;
    if (raw === undefined) {
      await persist(documentState);
      setStatus("Starter profiles created.");
    } else {
      const result = parseProfileDocument(raw);
      if (!result.ok) {
        setStatus(`Stored profiles are invalid: ${result.errors.join(" ")}`, true);
        render();
        return;
      }
      documentState = result.value;
      selectedProfileId = documentState.active_profile_id;
      if (result.migrated) {
        await persist(documentState);
        setStatus("Profile upgraded to the current schema.");
      }
    }
    dirty = false;
    render();
  } catch {
    setStatus("Could not read local profile storage.", true);
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
  renderConflicts(profile);
  requireElement<HTMLButtonElement>("delete-profile").disabled = documentState.profiles.length === 1;
}

function renderProfileList(): void {
  const visible = searchProfiles(documentState.profiles, elements.profileSearch.value);
  const selected = selectedProfile();
  if (!visible.some(({ id }) => id === selected.id)) visible.unshift(selected);
  elements.profile.replaceChildren(
    ...visible.map((item) => option(item.id, item.name, item.id === selected.id)),
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

      const sourceInput = document.createElement("input");
      sourceInput.value = source;
      sourceInput.setAttribute("aria-label", isMouse ? "Mouse button" : "Keyboard code");
      sourceInput.inputMode = isMouse ? "numeric" : "text";
      sourceInput.addEventListener("change", () => renameBinding(bindings, source, sourceInput.value, isMouse));

      const targetList = document.createElement("div");
      targetList.className = "target-list";
      targets.forEach((target, targetIndex) => {
        const targetRow = document.createElement("div");
        targetRow.className = "target-row";
        const select = document.createElement("select");
        select.setAttribute("aria-label", `Controller target ${targetIndex + 1} for ${source}`);
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
        removeTargetButton.setAttribute("aria-label", `Remove target ${targetIndex + 1} from ${source}`);
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
      addTargetButton.textContent = "Add target";
      addTargetButton.disabled = targets.length >= 4 || nextAvailableTarget(targets) === null;
      addTargetButton.setAttribute("aria-label", `Add controller target to ${source}`);
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
      remove.setAttribute("aria-label", `Remove ${source} binding`);
      remove.addEventListener("click", () => {
        delete bindings[source];
        clearAdsSourceIfRemoved(source, isMouse);
        changed(true);
      });
      row.append(sourceInput, targetList, remove);
      return row;
    });
  container.replaceChildren(...rows);
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
    setStatus(isMouse ? "Mouse button must be 0–4." : "Enter a valid KeyboardEvent code.", true);
    render();
    return;
  }
  if (newSource in bindings) {
    setStatus(`${newSource} already has a binding.`, true);
    render();
    return;
  }
  bindings[newSource] = bindings[oldSource]!;
  delete bindings[oldSource];
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
  const candidates = isMouse
    ? ["0", "1", "2", "3", "4"]
    : Array.from({ length: 26 }, (_, index) => `Key${String.fromCharCode(65 + index)}`);
  const source = candidates.find((candidate) => !(candidate in bindings));
  if (!source) {
    setStatus(isMouse ? "All supported mouse buttons are assigned." : "Rename an existing key before adding another.", true);
    return;
  }
  bindings[source] = [{ button: BUTTONS.a }];
  changed(true);
}

function duplicateProfile(): void {
  if (documentState.profiles.length >= 20) {
    setStatus("A maximum of 20 profiles is supported.", true);
    return;
  }
  const source = selectedProfile();
  const id = uniqueId(`${source.id}-copy`);
  const copy = structuredClone(source);
  copy.id = id;
  copy.name = `${source.name} copy`.slice(0, 60);
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
    setStatus(`Not saved: ${result.errors.join(" ")}`, true);
    return;
  }
  try {
    await persist(result.value);
    documentState = result.value;
    dirty = false;
    setStatus("Profiles saved locally.");
    render();
  } catch {
    setStatus("Save failed. Existing profiles were not changed.", true);
  }
}

async function reset(): Promise<void> {
  if (!window.confirm("Replace every local profile with the bundled generic presets?")) return;
  const replacement = createStarterProfiles();
  try {
    await persist(replacement);
    documentState = replacement;
    selectedProfileId = replacement.active_profile_id;
    dirty = false;
    setStatus("Starter profiles restored.");
    render();
  } catch {
    setStatus("Reset failed. Existing profiles were not changed.", true);
  }
}

async function importProfiles(): Promise<void> {
  const file = elements.importFile.files?.[0];
  elements.importFile.value = "";
  if (!file) return;
  if (file.size > MAX_IMPORT_BYTES) {
    setStatus(`Import exceeds ${MAX_IMPORT_BYTES} bytes.`, true);
    return;
  }
  try {
    const result = parseProfileJson(await file.text());
    if (!result.ok) {
      setStatus(`Import rejected: ${result.errors.join(" ")}`, true);
      return;
    }
    documentState = result.value;
    selectedProfileId = result.value.active_profile_id;
    dirty = true;
    setStatus(result.migrated ? "Legacy profile imported. Review and save it." : "Profiles imported. Review and save them.");
    render();
  } catch {
    setStatus("Could not read the selected file.", true);
  }
}

function exportProfiles(): void {
  const result = parseProfileDocument(documentState);
  if (!result.ok) {
    setStatus(`Export blocked: ${result.errors.join(" ")}`, true);
    return;
  }
  const blob = new Blob([`${JSON.stringify(result.value, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "xbox-input-bridge-profiles.json";
  anchor.click();
  URL.revokeObjectURL(url);
  setStatus("Validated profiles exported.");
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
  setStatus("Unsaved changes.");
  if (rerender) render();
  else renderConflicts(selectedProfile());
}

function renderConflicts(profile: Profile): void {
  const validation = parseProfileDocument(documentState);
  const gameWarnings = validation.ok
    ? []
    : validation.errors.filter((error) => error.startsWith("Game association "));
  const warnings = [...duplicateBindingWarnings(profile), ...gameWarnings];
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
      stopCalibration("Stopped (pointer lock unavailable)");
      return;
    }
    calibrationActive = true;
    elements.startCalibration.disabled = true;
    elements.stopCalibration.disabled = false;
    elements.calibrationSurface.classList.add("capturing");
    elements.calibrationState.textContent = "Capturing — move the pointer; press Stop or Escape to finish";
    renderCalibration({ dx: 0, dy: 0 });
  } catch {
    stopCalibration("Stopped (pointer lock denied)");
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
    `Raw Δ ${sample.dx}, ${sample.dy} · Stick ${stick.dx.toFixed(3)}, ${stick.dy.toFixed(3)} · ${calibrationSamples.length} samples`;
  elements.stickDot.style.left = `${50 + stick.dx * 46}%`;
  elements.stickDot.style.top = `${50 - stick.dy * 46}%`;
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
  setStatus("Suggested sensitivity applied. Save to keep it.");
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
    ...AXIS_TARGETS.map((target): [string, string] => [target, labelTarget(target)]),
    ...Object.entries(BUTTONS).map(([name, code]): [string, string] => [`button:${code}`, `Button ${labelTarget(name)}`]),
  ];
}

function labelTarget(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
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
