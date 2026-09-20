import { BUTTONS, type Profile, type ResponseCurve, type Target } from "./profile-schema";
import type { InputEvent } from "./protocol";

export interface XboxState {
  buttons: readonly number[];
  axes: readonly number[];
}

const BUTTON_INDEX = new Map<number, number>([
  [BUTTONS.a, 0], [BUTTONS.b, 1], [BUTTONS.x, 2], [BUTTONS.y, 3],
  [BUTTONS.left_shoulder, 4], [BUTTONS.right_shoulder, 5],
  [BUTTONS.back, 8], [BUTTONS.start, 9], [BUTTONS.left_thumb, 10],
  [BUTTONS.right_thumb, 11], [BUTTONS.dpad_up, 12], [BUTTONS.dpad_down, 13],
  [BUTTONS.dpad_left, 14], [BUTTONS.dpad_right, 15], [BUTTONS.guide, 16],
]);

export class BrowserGamepadMapper {
  readonly #profile: Profile;
  readonly #keys = new Set<string>();
  readonly #mouseButtons = new Set<number>();

  constructor(profile: Profile) {
    this.#profile = structuredClone(profile);
  }

  apply(events: readonly InputEvent[]): XboxState {
    let dx = 0;
    let dy = 0;
    for (const event of events) {
      if (event.kind === "key") updateSet(this.#keys, event.code, event.down);
      else if (event.kind === "mouse_button") updateSet(this.#mouseButtons, event.button, event.down);
      else if (event.kind === "mouse_move") {
        dx = saturatingAdd(dx, event.dx);
        dy = saturatingAdd(dy, event.dy);
      }
    }
    return this.#state(dx, dy);
  }

  reset(): XboxState {
    this.#keys.clear();
    this.#mouseButtons.clear();
    return neutralState();
  }

  #state(dx: number, dy: number): XboxState {
    const targets: Target[] = [];
    for (const code of this.#keys) {
      if (Object.hasOwn(this.#profile.key_bindings, code)) {
        targets.push(...this.#profile.key_bindings[code]!);
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

    return {
      buttons,
      axes: [
        digitalAxis(lxNegative, lxPositive),
        -digitalAxis(lyNegative, lyPositive),
        mouseAxis(dx, this.#profile.mouse.sensitivity_x, this.#profile.mouse.invert_x,
          this.#profile.mouse.deadzone, this.#profile.mouse.curve),
        mouseAxis(dy, this.#profile.mouse.sensitivity_y, this.#profile.mouse.invert_y,
          this.#profile.mouse.deadzone, this.#profile.mouse.curve),
      ],
    };
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
): number {
  if (delta === 0 || !Number.isFinite(sensitivity) || sensitivity <= 0) return 0;
  const normalized = clamp(delta * sensitivity * (invert ? -1 : 1), -1, 1);
  const safeDeadzone = clamp(deadzone, 0, 0.95);
  const scaled = Math.abs(normalized) <= safeDeadzone
    ? 0
    : Math.sign(normalized) * ((Math.abs(normalized) - safeDeadzone) / (1 - safeDeadzone));
  const magnitude = curve === "linear"
    ? Math.abs(scaled)
    : curve === "exponential" ? Math.abs(scaled) ** 2 : Math.abs(scaled) ** 3;
  return Math.sign(scaled) * magnitude;
}

function digitalAxis(negative: boolean, positive: boolean): number {
  return negative === positive ? 0 : negative ? -1 : 1;
}

function updateSet<T>(set: Set<T>, value: T, down: boolean): void {
  if (down) set.add(value);
  else set.delete(value);
}

function saturatingAdd(left: number, right: number): number {
  return clamp(left + right, -2_147_483_648, 2_147_483_647);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
