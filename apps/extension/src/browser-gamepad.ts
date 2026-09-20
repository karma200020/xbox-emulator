import {
  BUTTONS,
  type AdsActivation,
  type MouseSettings,
  type Profile,
  type ResponseCurve,
  type Target,
} from "./profile-schema";
import type { InputEvent } from "./protocol";

export interface XboxState {
  buttons: readonly number[];
  axes: readonly number[];
}

type MovementSegment = { mode: "hip" | "ads"; dx: number; dy: number };

const BUTTON_INDEX = new Map<number, number>([
  [BUTTONS.a, 0], [BUTTONS.b, 1], [BUTTONS.x, 2], [BUTTONS.y, 3],
  [BUTTONS.left_shoulder, 4], [BUTTONS.right_shoulder, 5],
  [BUTTONS.back, 8], [BUTTONS.start, 9], [BUTTONS.left_thumb, 10],
  [BUTTONS.right_thumb, 11], [BUTTONS.dpad_up, 12], [BUTTONS.dpad_down, 13],
  [BUTTONS.dpad_left, 14], [BUTTONS.dpad_right, 15], [BUTTONS.guide, 16],
]);

const MENU_KEY_FALLBACKS: Readonly<Record<string, readonly Target[]>> = {
  ArrowUp: [{ button: BUTTONS.dpad_up }],
  ArrowDown: [{ button: BUTTONS.dpad_down }],
  ArrowLeft: [{ button: BUTTONS.dpad_left }],
  ArrowRight: [{ button: BUTTONS.dpad_right }],
};

export class BrowserGamepadMapper {
  readonly #profile: Profile;
  readonly #keys = new Set<string>();
  readonly #mouseButtons = new Set<number>();
  #previousMouse: [number, number] = [0, 0];
  #previousMode: "hip" | "ads" | null = null;

  constructor(profile: Profile) {
    this.#profile = structuredClone(profile);
  }

  apply(events: readonly InputEvent[]): XboxState {
    const movements: MovementSegment[] = [];
    let segment: MovementSegment = { mode: this.#mouseMode(), dx: 0, dy: 0 };
    const finishSegment = (force = false): void => {
      if (force || segment.dx !== 0 || segment.dy !== 0) movements.push(segment);
    };
    for (const event of events) {
      if (event.kind === "key" || event.kind === "mouse_button") {
        const previousMode = segment.mode;
        if (event.kind === "key") updateSet(this.#keys, event.code, event.down);
        else updateSet(this.#mouseButtons, event.button, event.down);
        const nextMode = this.#mouseMode();
        if (nextMode !== previousMode) {
          finishSegment(true);
          segment = { mode: nextMode, dx: 0, dy: 0 };
        }
      } else if (event.kind === "mouse_move") {
        segment.dx = saturatingAdd(segment.dx, event.dx);
        segment.dy = saturatingAdd(segment.dy, event.dy);
      }
    }
    finishSegment();
    return this.#state(movements);
  }

  reset(): XboxState {
    this.#keys.clear();
    this.#mouseButtons.clear();
    this.#resetMouse();
    return neutralState();
  }

  #state(movements: readonly MovementSegment[]): XboxState {
    const targets: Target[] = [];
    for (const code of this.#keys) {
      if (Object.hasOwn(this.#profile.key_bindings, code)) {
        targets.push(...this.#profile.key_bindings[code]!);
      } else if (Object.hasOwn(MENU_KEY_FALLBACKS, code)) {
        targets.push(...MENU_KEY_FALLBACKS[code]!);
      }
    }
    for (const button of this.#mouseButtons) {
      targets.push(...(this.#profile.mouse_bindings[String(button)] ?? []));
    }

    const buttons = Array<number>(17).fill(0);
    let lxNegative = false;
    let lxPositive = false;
    let lyNegative = false;
    let lyPositive = false;
    for (const target of targets) {
      if (typeof target !== "string") {
        const index = BUTTON_INDEX.get(target.button);
        if (index !== undefined) buttons[index] = 1;
      } else if (target === "left_trigger") buttons[6] = 1;
      else if (target === "right_trigger") buttons[7] = 1;
      else if (target === "left_x_negative") lxNegative = true;
      else if (target === "left_x_positive") lxPositive = true;
      else if (target === "left_y_negative") lyNegative = true;
      else if (target === "left_y_positive") lyPositive = true;
    }

    const mouse = this.#mouseAxes(movements);
    return {
      buttons,
      axes: [
        digitalAxis(lxNegative, lxPositive),
        -digitalAxis(lyNegative, lyPositive),
        mouse[0],
        mouse[1],
      ],
    };
  }

  #mouseMode(): "hip" | "ads" {
    return isSourceHeld(this.#profile.mouse.ads_activation, this.#keys, this.#mouseButtons)
      ? "ads"
      : "hip";
  }

  #mouseAxes(movements: readonly MovementSegment[]): [number, number] {
    if (movements.length === 0) {
      this.#resetMouse();
      return [0, 0];
    }
    let combinedX = 0;
    let combinedY = 0;
    for (const { dx, dy, mode } of movements) {
      const [x, y] = this.#mouseSegment(dx, dy, mode);
      combinedX = clamp(combinedX + x, -1, 1);
      combinedY = clamp(combinedY + y, -1, 1);
    }
    return [combinedX, combinedY];
  }

  #mouseSegment(dx: number, dy: number, mode: "hip" | "ads"): [number, number] {
    if (mode !== this.#previousMode) this.#previousMouse = [0, 0];
    this.#previousMode = mode;
    const settings = this.#profile.mouse[mode];
    const targets: [number, number] = [
      mouseAxis(dx, settings.sensitivity_x, settings.invert_x, settings.deadzone,
        settings.curve, settings.velocity_scale),
      mouseAxis(dy, settings.sensitivity_y, settings.invert_y, settings.deadzone,
        settings.curve, settings.velocity_scale),
    ];
    const output: [number, number] = [
      smoothAxis(targets[0], this.#previousMouse[0], settings.smoothing, dx !== 0),
      smoothAxis(targets[1], this.#previousMouse[1], settings.smoothing, dy !== 0),
    ];
    this.#previousMouse = output;
    return output;
  }

  #resetMouse(): void {
    this.#previousMouse = [0, 0];
    this.#previousMode = null;
  }
}

export function neutralState(): XboxState {
  return { buttons: Array<number>(17).fill(0), axes: [0, 0, 0, 0] };
}

export function mouseAxis(
  delta: number,
  sensitivity: number,
  invert: boolean,
  deadzone: number,
  curve: ResponseCurve,
  velocityScale = 0,
): number {
  if (delta === 0 || !Number.isFinite(sensitivity) || sensitivity <= 0) return 0;
  const safeVelocityScale = clampFinite(velocityScale, 0, 4, 0);
  const velocityMultiplier = 1 + safeVelocityScale * Math.min(Math.abs(delta) / 100, 1);
  const normalized = clamp(delta * sensitivity * velocityMultiplier * (invert ? -1 : 1), -1, 1);
  const safeDeadzone = clamp(deadzone, 0, 0.95);
  const scaled = Math.abs(normalized) <= safeDeadzone
    ? 0
    : Math.sign(normalized) * ((Math.abs(normalized) - safeDeadzone) / (1 - safeDeadzone));
  const magnitude = curve === "linear"
    ? Math.abs(scaled)
    : curve === "exponential" ? Math.abs(scaled) ** 2 : Math.abs(scaled) ** 3;
  return Math.sign(scaled) * magnitude;
}

export function applyMouseSettings(
  delta: number,
  settings: MouseSettings,
): number {
  return mouseAxis(
    delta,
    settings.sensitivity_x,
    settings.invert_x,
    settings.deadzone,
    settings.curve,
    settings.velocity_scale,
  );
}

function digitalAxis(negative: boolean, positive: boolean): number {
  return negative === positive ? 0 : negative ? -1 : 1;
}

function updateSet<T>(set: Set<T>, value: T, down: boolean): void {
  if (down) set.add(value);
  else set.delete(value);
}

function isSourceHeld(
  source: AdsActivation | null,
  keys: ReadonlySet<string>,
  mouseButtons: ReadonlySet<number>,
): boolean {
  if (!source) return false;
  return source.type === "key" ? keys.has(source.code) : mouseButtons.has(source.button);
}

function smoothAxis(target: number, previous: number, smoothing: number, moved: boolean): number {
  if (!moved || target === 0) return 0;
  const factor = clampFinite(smoothing, 0, 0.95, 0);
  if (factor === 0 || previous === 0) return target;
  return clamp(previous * factor + target * (1 - factor), -1, 1);
}

function saturatingAdd(left: number, right: number): number {
  return clamp(left + right, -2_147_483_648, 2_147_483_647);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function clampFinite(value: number, minimum: number, maximum: number, fallback: number): number {
  return Number.isFinite(value) ? clamp(value, minimum, maximum) : fallback;
}
