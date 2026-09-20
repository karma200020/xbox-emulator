export const PROFILE_SCHEMA_VERSION = 2 as const;
export const PROFILE_STORAGE_KEY = "xib.profile_document";
export const BACKEND_MODE_STORAGE_KEY = "xib.backend_mode";
export type BackendMode = "auto" | "native" | "browser";
export const MAX_IMPORT_BYTES = 256 * 1024;

export const BUTTONS = {
  dpad_up: 0x0001,
  dpad_down: 0x0002,
  dpad_left: 0x0004,
  dpad_right: 0x0008,
  start: 0x0010,
  back: 0x0020,
  left_thumb: 0x0040,
  right_thumb: 0x0080,
  left_shoulder: 0x0100,
  right_shoulder: 0x0200,
  guide: 0x0400,
  a: 0x1000,
  b: 0x2000,
  x: 0x4000,
  y: 0x8000,
} as const;

export const AXIS_TARGETS = [
  "left_x_negative",
  "left_x_positive",
  "left_y_negative",
  "left_y_positive",
  "left_trigger",
  "right_trigger",
] as const;

export type AxisTarget = (typeof AXIS_TARGETS)[number];
export type Target = AxisTarget | { button: number };
export type ResponseCurve = "linear" | "exponential" | "precision";
export type AdsActivation =
  | { type: "key"; code: string }
  | { type: "mouse_button"; button: number };

export interface MouseSettings {
  sensitivity_x: number;
  sensitivity_y: number;
  invert_x: boolean;
  invert_y: boolean;
  deadzone: number;
  curve: ResponseCurve;
  smoothing: number;
  velocity_scale: number;
}

export interface MouseModes {
  hip: MouseSettings;
  ads: MouseSettings;
  ads_activation: AdsActivation | null;
}

export interface GameAssociation {
  title_id: string;
  title_name: string;
  aliases: string[];
}

export interface Profile {
  id: string;
  name: string;
  key_bindings: Record<string, Target[]>;
  mouse_bindings: Record<string, Target[]>;
  mouse: MouseModes;
  game_associations: GameAssociation[];
}

export interface ProfileDocument {
  schema_version: typeof PROFILE_SCHEMA_VERSION;
  active_profile_id: string;
  profiles: Profile[];
}

export type ValidationResult =
  | { ok: true; value: ProfileDocument; migrated: boolean }
  | { ok: false; errors: string[] };

export type SelectedProfileResult =
  | { ok: true; document: ProfileDocument; profile: Profile }
  | { ok: false; errors: string[] };

const AXIS_SET = new Set<string>(AXIS_TARGETS);
const BUTTON_SET = new Set<number>(Object.values(BUTTONS));
const CURVES = new Set<string>(["linear", "exponential", "precision"]);
const PROFILE_ID = /^[a-z0-9](?:[a-z0-9_-]{0,38}[a-z0-9])?$/;
const TITLE_ID = /^[a-z0-9](?:[a-z0-9._:-]{0,78}[a-z0-9])?$/;
const KEY_CODE = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const MAX_PROFILES = 20;
const MAX_BINDINGS = 128;
const MAX_GAME_ASSOCIATIONS = 20;
const MAX_GAME_ALIASES = 10;

export function parseProfileDocument(input: unknown): ValidationResult {
  const errors: string[] = [];
  const migration = migrateDocument(input);
  const candidate = migration.value;

  if (!isRecord(candidate)) return { ok: false, errors: ["Root must be an object."] };
  exactKeys(candidate, ["schema_version", "active_profile_id", "profiles"], "root", errors);
  if (candidate.schema_version !== PROFILE_SCHEMA_VERSION) {
    errors.push(`schema_version must be ${PROFILE_SCHEMA_VERSION}.`);
  }
  if (typeof candidate.active_profile_id !== "string") {
    errors.push("active_profile_id must be a string.");
  }
  if (!Array.isArray(candidate.profiles)) {
    errors.push("profiles must be an array.");
  } else {
    if (candidate.profiles.length < 1 || candidate.profiles.length > MAX_PROFILES) {
      errors.push(`profiles must contain 1-${MAX_PROFILES} entries.`);
    }
    candidate.profiles.forEach((profile, index) => validateProfile(profile, index, errors));
    const ids = candidate.profiles
      .filter(isRecord)
      .map((profile) => profile.id)
      .filter((id): id is string => typeof id === "string");
    if (new Set(ids).size !== ids.length) errors.push("Profile ids must be unique.");
    if (
      typeof candidate.active_profile_id === "string" &&
      !ids.includes(candidate.active_profile_id)
    ) {
      errors.push("active_profile_id must identify a profile.");
    }
    validateGameConflicts(candidate.profiles, errors);
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: structuredClone(candidate) as unknown as ProfileDocument,
    migrated: migration.migrated,
  };
}

export function parseProfileJson(json: string): ValidationResult {
  if (new TextEncoder().encode(json).byteLength > MAX_IMPORT_BYTES) {
    return { ok: false, errors: [`Import exceeds ${MAX_IMPORT_BYTES} bytes.`] };
  }

  try {
    return parseProfileDocument(JSON.parse(json) as unknown);
  } catch {
    return { ok: false, errors: ["File is not valid JSON."] };
  }
}

export function parseSelectedProfile(input: unknown): SelectedProfileResult {
  const result = parseProfileDocument(input);
  if (!result.ok) return result;
  const profile = result.value.profiles.find(({ id }) => id === result.value.active_profile_id);
  if (!profile) return { ok: false, errors: ["active_profile_id must identify a profile."] };
  return { ok: true, document: result.value, profile };
}

export function createStarterProfiles(): ProfileDocument {
  const profiles = [defaultProfile(), fpsProfile(), racingProfile()];
  return {
    schema_version: PROFILE_SCHEMA_VERSION,
    active_profile_id: profiles[0]!.id,
    profiles,
  };
}

export function normalizeGameText(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US").replace(/\s+/g, " ");
}

export function duplicateBindingWarnings(profile: Profile): string[] {
  const sourcesByTarget = new Map<string, string[]>();
  for (const [source, targets] of Object.entries(profile.key_bindings)) {
    addTargets(sourcesByTarget, `Key ${source}`, targets);
  }
  for (const [source, targets] of Object.entries(profile.mouse_bindings)) {
    addTargets(sourcesByTarget, `Mouse ${source}`, targets);
  }
  return [...sourcesByTarget.entries()]
    .filter(([, sources]) => sources.length > 1)
    .map(([target, sources]) => `${target} is assigned to ${sources.join(", ")}.`);
}

function migrateDocument(input: unknown): { value: unknown; migrated: boolean } {
  let candidate: unknown = input;
  let migrated = false;

  if (isRecord(candidate) && !("schema_version" in candidate) && looksLikeLegacyProfile(candidate)) {
    const profile = {
      ...candidate,
      name: typeof candidate.id === "string" ? titleFromId(candidate.id) : "Imported profile",
      mouse: isRecord(candidate.mouse) ? { ...candidate.mouse, curve: "linear" } : candidate.mouse,
    };
    candidate = { schema_version: 1, active_profile_id: candidate.id, profiles: [profile] };
    migrated = true;
  }

  if (isRecord(candidate) && candidate.schema_version === 1 && Array.isArray(candidate.profiles)) {
    candidate = {
      ...candidate,
      schema_version: PROFILE_SCHEMA_VERSION,
      profiles: candidate.profiles.map(migrateV1Profile),
    };
    migrated = true;
  }
  return { value: candidate, migrated };
}

function migrateV1Profile(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const response = isRecord(value.mouse)
    ? { ...value.mouse, smoothing: 0, velocity_scale: 0 }
    : value.mouse;
  return {
    ...value,
    mouse: {
      hip: isRecord(response) ? { ...response } : response,
      ads: isRecord(response) ? { ...response } : response,
      ads_activation: null,
    },
    game_associations: [],
  };
}

function validateProfile(value: unknown, index: number, errors: string[]): void {
  const path = `profiles[${index}]`;
  if (!isRecord(value)) {
    errors.push(`${path} must be an object.`);
    return;
  }
  exactKeys(
    value,
    ["id", "name", "key_bindings", "mouse_bindings", "mouse", "game_associations"],
    path,
    errors,
  );
  if (typeof value.id !== "string" || !PROFILE_ID.test(value.id)) {
    errors.push(`${path}.id must be 1-40 lowercase letters, numbers, "_" or "-".`);
  }
  if (
    typeof value.name !== "string" ||
    value.name.trim().length < 1 ||
    value.name.length > 60
  ) {
    errors.push(`${path}.name must be 1-60 characters.`);
  }
  validateBindings(value.key_bindings, `${path}.key_bindings`, false, errors);
  validateBindings(value.mouse_bindings, `${path}.mouse_bindings`, true, errors);
  validateMouseModes(value.mouse, value.key_bindings, value.mouse_bindings, `${path}.mouse`, errors);
  validateGameAssociations(value.game_associations, `${path}.game_associations`, errors);
}

function validateBindings(
  value: unknown,
  path: string,
  mouse: boolean,
  errors: string[],
): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object.`);
    return;
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_BINDINGS) errors.push(`${path} exceeds ${MAX_BINDINGS} bindings.`);
  for (const [source, targets] of entries) {
    const validSource = mouse
      ? /^(?:0|1|2|3|4)$/.test(source)
      : KEY_CODE.test(source);
    if (!validSource) errors.push(`${path}.${source} has an invalid source.`);
    if (!Array.isArray(targets) || targets.length < 1 || targets.length > 4) {
      errors.push(`${path}.${source} must contain 1-4 targets.`);
      continue;
    }
    targets.forEach((target, index) => validateTarget(target, `${path}.${source}[${index}]`, errors));
    const identities = targets.map(targetIdentity);
    if (identities.some((target) => target === null) || new Set(identities).size !== identities.length) {
      errors.push(`${path}.${source} must not contain duplicate targets.`);
    }
  }
}

function validateTarget(value: unknown, path: string, errors: string[]): void {
  if (typeof value === "string" && AXIS_SET.has(value)) return;
  if (isRecord(value)) {
    exactKeys(value, ["button"], path, errors);
    if (typeof value.button === "number" && BUTTON_SET.has(value.button)) return;
  }
  errors.push(`${path} is not a supported controller target.`);
}

function validateMouseModes(
  value: unknown,
  keyBindings: unknown,
  mouseBindings: unknown,
  path: string,
  errors: string[],
): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object.`);
    return;
  }
  exactKeys(value, ["hip", "ads", "ads_activation"], path, errors);
  validateMouse(value.hip, `${path}.hip`, errors);
  validateMouse(value.ads, `${path}.ads`, errors);
  validateAdsActivation(value.ads_activation, keyBindings, mouseBindings, `${path}.ads_activation`, errors);
}

function validateMouse(value: unknown, path: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object.`);
    return;
  }
  exactKeys(
    value,
    [
      "sensitivity_x", "sensitivity_y", "invert_x", "invert_y", "deadzone", "curve",
      "smoothing", "velocity_scale",
    ],
    path,
    errors,
  );
  boundedNumber(value.sensitivity_x, 0.001, 0.2, `${path}.sensitivity_x`, errors);
  boundedNumber(value.sensitivity_y, 0.001, 0.2, `${path}.sensitivity_y`, errors);
  boundedNumber(value.deadzone, 0, 0.95, `${path}.deadzone`, errors);
  boundedNumber(value.smoothing, 0, 0.95, `${path}.smoothing`, errors);
  boundedNumber(value.velocity_scale, 0, 4, `${path}.velocity_scale`, errors);
  if (typeof value.invert_x !== "boolean") errors.push(`${path}.invert_x must be boolean.`);
  if (typeof value.invert_y !== "boolean") errors.push(`${path}.invert_y must be boolean.`);
  if (typeof value.curve !== "string" || !CURVES.has(value.curve)) {
    errors.push(`${path}.curve is invalid.`);
  }
}

function validateAdsActivation(
  value: unknown,
  keyBindings: unknown,
  mouseBindings: unknown,
  path: string,
  errors: string[],
): void {
  if (value === null) return;
  if (!isRecord(value) || typeof value.type !== "string") {
    errors.push(`${path} must be null or an input source.`);
    return;
  }
  if (value.type === "key") {
    exactKeys(value, ["type", "code"], path, errors);
    if (typeof value.code !== "string" || !KEY_CODE.test(value.code)) {
      errors.push(`${path}.code must be a valid KeyboardEvent code.`);
    } else if (!isRecord(keyBindings) || !Object.hasOwn(keyBindings, value.code)) {
      errors.push(`${path} must reference an existing keyboard binding.`);
    }
    return;
  }
  if (value.type === "mouse_button") {
    exactKeys(value, ["type", "button"], path, errors);
    if (!Number.isInteger(value.button) || Number(value.button) < 0 || Number(value.button) > 4) {
      errors.push(`${path}.button must be an integer from 0 to 4.`);
    } else if (!isRecord(mouseBindings) || !Object.hasOwn(mouseBindings, String(value.button))) {
      errors.push(`${path} must reference an existing mouse binding.`);
    }
    return;
  }
  errors.push(`${path}.type is invalid.`);
}

function validateGameAssociations(value: unknown, path: string, errors: string[]): void {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array.`);
    return;
  }
  if (value.length > MAX_GAME_ASSOCIATIONS) {
    errors.push(`${path} exceeds ${MAX_GAME_ASSOCIATIONS} entries.`);
  }
  const titleIds = new Set<string>();
  value.forEach((association, index) => {
    const itemPath = `${path}[${index}]`;
    if (!isRecord(association)) {
      errors.push(`${itemPath} must be an object.`);
      return;
    }
    exactKeys(association, ["title_id", "title_name", "aliases"], itemPath, errors);
    if (typeof association.title_id !== "string" || !TITLE_ID.test(association.title_id)) {
      errors.push(`${itemPath}.title_id must be a normalized 1-80 character title id.`);
    } else if (titleIds.has(association.title_id)) {
      errors.push(`${path} must not contain duplicate title ids.`);
    } else {
      titleIds.add(association.title_id);
    }
    validateNormalizedGameName(association.title_name, `${itemPath}.title_name`, errors);
    if (!Array.isArray(association.aliases)) {
      errors.push(`${itemPath}.aliases must be an array.`);
    } else {
      if (association.aliases.length > MAX_GAME_ALIASES) {
        errors.push(`${itemPath}.aliases exceeds ${MAX_GAME_ALIASES} entries.`);
      }
      association.aliases.forEach((alias, aliasIndex) =>
        validateNormalizedGameName(alias, `${itemPath}.aliases[${aliasIndex}]`, errors));
      if (
        association.aliases.every((alias) => typeof alias === "string") &&
        new Set(association.aliases).size !== association.aliases.length
      ) {
        errors.push(`${itemPath}.aliases must be unique.`);
      }
      if (
        typeof association.title_name === "string" &&
        association.aliases.includes(association.title_name)
      ) {
        errors.push(`${itemPath}.aliases must not repeat title_name.`);
      }
    }
  });
}

function validateGameConflicts(profiles: unknown[], errors: string[]): void {
  const owners = new Map<string, string>();
  profiles.forEach((profile) => {
    if (!isRecord(profile) || typeof profile.id !== "string" || !Array.isArray(profile.game_associations)) {
      return;
    }
    const profileId = profile.id;
    profile.game_associations.forEach((association) => {
      if (!isRecord(association)) return;
      const values = [
        typeof association.title_id === "string" ? `id:${association.title_id}` : null,
        typeof association.title_name === "string" ? `name:${association.title_name}` : null,
        ...(Array.isArray(association.aliases)
          ? association.aliases.map((alias) => typeof alias === "string" ? `name:${alias}` : null)
          : []),
      ].filter((value): value is string => value !== null);
      for (const value of values) {
        const owner = owners.get(value);
        if (owner && owner !== profileId) {
          errors.push(`Game association "${value.slice(value.indexOf(":") + 1)}" is assigned to multiple profiles.`);
        } else {
          owners.set(value, profileId);
        }
      }
    });
  });
}

function validateNormalizedGameName(value: unknown, path: string, errors: string[]): void {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 100 ||
    value !== normalizeGameText(value)
  ) {
    errors.push(`${path} must be normalized lowercase text from 1 to 100 characters.`);
  }
}

function boundedNumber(
  value: unknown,
  minimum: number,
  maximum: number,
  path: string,
  errors: string[],
): void {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    errors.push(`${path} must be a finite number from ${minimum} to ${maximum}.`);
  }
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  errors: string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push(`${path}.${key} is not allowed.`);
  }
}

function targetIdentity(target: unknown): string | null {
  if (typeof target === "string" && AXIS_SET.has(target)) return target;
  if (isRecord(target) && typeof target.button === "number" && BUTTON_SET.has(target.button)) {
    return buttonName(target.button);
  }
  return null;
}

function addTargets(map: Map<string, string[]>, source: string, targets: Target[]): void {
  for (const target of targets) {
    const identity = targetIdentity(target);
    if (!identity) continue;
    const sources = map.get(identity) ?? [];
    sources.push(source);
    map.set(identity, sources);
  }
}

function buttonName(value: number): string {
  return Object.entries(BUTTONS).find(([, code]) => code === value)?.[0] ?? `button_${value}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function looksLikeLegacyProfile(value: Record<string, unknown>): boolean {
  return "id" in value && "key_bindings" in value && "mouse_bindings" in value && "mouse" in value;
}

function titleFromId(id: string): string {
  const title = id.replace(/[_-]+/g, " ").trim();
  return title ? title.replace(/\b\w/g, (character) => character.toUpperCase()).slice(0, 60) : "Imported profile";
}

function mouse(
  sensitivity = 0.018,
  deadzone = 0,
  curve: ResponseCurve = "linear",
): MouseSettings {
  return {
    sensitivity_x: sensitivity,
    sensitivity_y: sensitivity,
    invert_x: false,
    invert_y: false,
    deadzone,
    curve,
    smoothing: 0,
    velocity_scale: 0,
  };
}

function mouseModes(response = mouse(), adsActivation: AdsActivation | null = null): MouseModes {
  return {
    hip: structuredClone(response),
    ads: structuredClone(response),
    ads_activation: adsActivation,
  };
}

function target(button: keyof typeof BUTTONS): Target[] {
  return [{ button: BUTTONS[button] }];
}

function defaultProfile(): Profile {
  return {
    id: "default",
    name: "Default",
    key_bindings: {
      KeyW: ["left_y_positive"],
      KeyS: ["left_y_negative"],
      KeyA: ["left_x_negative"],
      KeyD: ["left_x_positive"],
      Space: target("a"),
      ShiftLeft: target("left_thumb"),
      KeyE: target("b"),
      KeyR: target("x"),
      KeyQ: target("y"),
      Enter: target("start"),
      Tab: target("back"),
    },
    mouse_bindings: {
      "0": ["right_trigger"],
      "1": target("right_thumb"),
      "2": ["left_trigger"],
    },
    mouse: mouseModes(),
    game_associations: [],
  };
}

function fpsProfile(): Profile {
  const profile = defaultProfile();
  return {
    ...profile,
    id: "fps",
    name: "FPS",
    key_bindings: {
      ...profile.key_bindings,
      ControlLeft: target("b"),
      KeyF: target("x"),
      Digit1: target("y"),
    },
    mouse: mouseModes(mouse(0.024, 0.04, "precision"), { type: "mouse_button", button: 2 }),
  };
}

function racingProfile(): Profile {
  return {
    id: "racing",
    name: "Racing",
    key_bindings: {
      KeyW: ["right_trigger"],
      KeyS: ["left_trigger"],
      KeyA: ["left_x_negative"],
      KeyD: ["left_x_positive"],
      Space: target("a"),
      ShiftLeft: target("x"),
      KeyR: target("y"),
      Enter: target("start"),
    },
    mouse_bindings: {
      "0": target("a"),
      "2": target("b"),
    },
    mouse: mouseModes(mouse(0.012, 0.08, "exponential")),
    game_associations: [],
  };
}
