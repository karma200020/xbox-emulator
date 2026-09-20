import {
  AXIS_TARGETS,
  BUTTONS,
  MAX_IMPORT_BYTES,
  PROFILE_STORAGE_KEY,
  createStarterProfiles,
  duplicateBindingWarnings,
  parseProfileDocument,
  parseProfileJson,
  type Profile,
  type ProfileDocument,
  type ResponseCurve,
  type Target,
} from "./profile-schema";
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
  name: requireElement<HTMLInputElement>("profile-name"),
  id: requireElement<HTMLInputElement>("profile-id"),
  sensitivityX: requireElement<HTMLInputElement>("sensitivity-x"),
  sensitivityY: requireElement<HTMLInputElement>("sensitivity-y"),
  deadzone: requireElement<HTMLInputElement>("deadzone"),
  curve: requireElement<HTMLSelectElement>("curve"),
  curveLine: requireElement<SVGPolylineElement>("curve-line"),
  invertX: requireElement<HTMLInputElement>("invert-x"),
  invertY: requireElement<HTMLInputElement>("invert-y"),
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

requireElement<HTMLButtonElement>("save").addEventListener("click", () => void save());
requireElement<HTMLButtonElement>("reset").addEventListener("click", () => void reset());
requireElement<HTMLButtonElement>("export").addEventListener("click", exportProfiles);
requireElement<HTMLButtonElement>("import").addEventListener("click", () => elements.importFile.click());
requireElement<HTMLButtonElement>("duplicate-profile").addEventListener("click", duplicateProfile);
requireElement<HTMLButtonElement>("delete-profile").addEventListener("click", deleteProfile);
requireElement<HTMLButtonElement>("add-key").addEventListener("click", () => addBinding(false));
requireElement<HTMLButtonElement>("add-mouse").addEventListener("click", () => addBinding(true));
elements.startCalibration.addEventListener("click", () => void startCalibration());
elements.stopCalibration.addEventListener("click", () => stopCalibration("Stopped"));
elements.applySuggestion.addEventListener("click", applySuggestion);
elements.importFile.addEventListener("change", () => void importProfiles());
elements.profile.addEventListener("change", () => {
  stopCalibration("Stopped");
  selectedProfileId = elements.profile.value;
  documentState.active_profile_id = selectedProfileId;
  dirty = true;
  render();
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
]) {
  input.addEventListener("input", updateSettings);
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
    const stored = await chrome.storage.local.get(PROFILE_STORAGE_KEY);
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
  elements.profile.replaceChildren(
    ...documentState.profiles.map((item) => option(item.id, item.name, item.id === profile.id)),
  );
  elements.name.value = profile.name;
  elements.id.value = profile.id;
  elements.sensitivityX.value = String(profile.mouse.sensitivity_x);
  elements.sensitivityY.value = String(profile.mouse.sensitivity_y);
  elements.deadzone.value = String(profile.mouse.deadzone);
  elements.curve.value = profile.mouse.curve;
  elements.invertX.checked = profile.mouse.invert_x;
  elements.invertY.checked = profile.mouse.invert_y;
  renderCurvePreview();
  renderBindings(elements.keys, profile.key_bindings, false);
  renderBindings(elements.mouse, profile.mouse_bindings, true);
  renderConflicts(profile);
  requireElement<HTMLButtonElement>("delete-profile").disabled = documentState.profiles.length === 1;
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
  profile.mouse.sensitivity_x = elements.sensitivityX.valueAsNumber;
  profile.mouse.sensitivity_y = elements.sensitivityY.valueAsNumber;
  profile.mouse.deadzone = elements.deadzone.valueAsNumber;
  profile.mouse.curve = elements.curve.value as ResponseCurve;
  profile.mouse.invert_x = elements.invertX.checked;
  profile.mouse.invert_y = elements.invertY.checked;
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
  if (!window.confirm("Replace every local profile with the three starter profiles?")) return;
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
  await chrome.storage.local.set({ [PROFILE_STORAGE_KEY]: result.value });
}

function changed(rerender = false): void {
  dirty = true;
  setStatus("Unsaved changes.");
  if (rerender) render();
  else renderConflicts(selectedProfile());
}

function renderConflicts(profile: Profile): void {
  const warnings = duplicateBindingWarnings(profile);
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
  const stick = normalizedStick(sample, selectedProfile().mouse);
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
