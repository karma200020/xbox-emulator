import { BUTTONS, type Profile, type Target } from "./profile-schema";

export type ActionLabelKey =
  | "actionMoveForward" | "actionMoveBackward" | "actionMoveLeft" | "actionMoveRight"
  | "actionLookAim" | "actionJump" | "actionInteract" | "actionReload"
  | "actionCrouch" | "actionSprint" | "actionFire" | "actionAds"
  | "actionPause" | "actionInventory" | "actionPreviousItem" | "actionNextItem"
  | "actionAccelerate" | "actionBrake" | "actionHandbrake" | "actionDash"
  | "actionAttack" | "actionCamera" | "actionGameDefined";

const COMMON: Record<string, ActionLabelKey> = {
  left_y_positive: "actionMoveForward",
  left_y_negative: "actionMoveBackward",
  left_x_negative: "actionMoveLeft",
  left_x_positive: "actionMoveRight",
  right_trigger: "actionFire",
  left_trigger: "actionAds",
  [`button:${BUTTONS.a}`]: "actionJump",
  [`button:${BUTTONS.b}`]: "actionInteract",
  [`button:${BUTTONS.x}`]: "actionReload",
  [`button:${BUTTONS.y}`]: "actionInventory",
  [`button:${BUTTONS.left_thumb}`]: "actionSprint",
  [`button:${BUTTONS.right_thumb}`]: "actionCrouch",
  [`button:${BUTTONS.start}`]: "actionPause",
  [`button:${BUTTONS.back}`]: "actionInventory",
  [`button:${BUTTONS.left_shoulder}`]: "actionPreviousItem",
  [`button:${BUTTONS.right_shoulder}`]: "actionNextItem",
};

const PRESETS: Record<string, Partial<Record<string, ActionLabelKey>>> = {
  racing: {
    right_trigger: "actionAccelerate",
    left_trigger: "actionBrake",
    [`button:${BUTTONS.a}`]: "actionHandbrake",
    [`button:${BUTTONS.b}`]: "actionCamera",
    [`button:${BUTTONS.x}`]: "actionNextItem",
    [`button:${BUTTONS.y}`]: "actionGameDefined",
  },
  platformer: {
    [`button:${BUTTONS.x}`]: "actionDash",
    [`button:${BUTTONS.b}`]: "actionInteract",
    [`button:${BUTTONS.y}`]: "actionAttack",
  },
  action: {
    [`button:${BUTTONS.x}`]: "actionAttack",
    [`button:${BUTTONS.b}`]: "actionInteract",
  },
};

export function targetId(target: Target): string {
  return typeof target === "string" ? target : `button:${target.button}`;
}

export function actionLabelKey(profile: Pick<Profile, "id">, target: Target): ActionLabelKey {
  const presetId = Object.keys(PRESETS).find((id) => profile.id === id || profile.id.startsWith(`${id}-copy`));
  return (presetId ? PRESETS[presetId]?.[targetId(target)] : undefined) ??
    COMMON[targetId(target)] ?? "actionGameDefined";
}

export function friendlyInputLabel(
  source: string,
  mouse: boolean,
  translate: (key: string) => string = defaultInputLabel,
): string {
  if (mouse) {
    const key = ["inputMouseLeft", "inputMouseMiddle", "inputMouseRight", "inputMouseBack", "inputMouseForward"][
      Number(source)
    ];
    return key ? translate(key) : `Mouse ${source}`;
  }

  if (/^Key[A-Z]$/.test(source)) return source.slice(3);
  if (/^Digit[0-9]$/.test(source)) return source.slice(5);
  const labels: Record<string, string> = {
    Space: "inputSpace",
    ShiftLeft: "inputShiftLeft",
    ShiftRight: "inputShiftRight",
    ControlLeft: "inputControlLeft",
    ControlRight: "inputControlRight",
    AltLeft: "inputAltLeft",
    AltRight: "inputAltRight",
    Enter: "inputEnter",
    Tab: "inputTab",
    ArrowUp: "inputArrowUp",
    ArrowDown: "inputArrowDown",
    ArrowLeft: "inputArrowLeft",
    ArrowRight: "inputArrowRight",
  };
  return labels[source] ? translate(labels[source]) : source;
}

export function matchesProfileSearch(
  profile: Pick<Profile, "id" | "name">,
  query: string,
  localizedLabel: string,
): boolean {
  const normalized = query.normalize("NFKC").trim().toLocaleLowerCase();
  return normalized === "" || [profile.id, profile.name, localizedLabel]
    .some((value) => value.normalize("NFKC").toLocaleLowerCase().includes(normalized));
}

function defaultInputLabel(key: string): string {
  const labels: Record<string, string> = {
    inputMouseLeft: "Left Mouse", inputMouseMiddle: "Middle Mouse",
    inputMouseRight: "Right Mouse", inputMouseBack: "Mouse Back",
    inputMouseForward: "Mouse Forward", inputSpace: "Space",
    inputShiftLeft: "Left Shift", inputShiftRight: "Right Shift",
    inputControlLeft: "Left Ctrl", inputControlRight: "Right Ctrl",
    inputAltLeft: "Left Alt", inputAltRight: "Right Alt", inputEnter: "Enter",
    inputTab: "Tab", inputArrowUp: "Up Arrow", inputArrowDown: "Down Arrow",
    inputArrowLeft: "Left Arrow", inputArrowRight: "Right Arrow",
  };
  return labels[key] ?? key;
}
