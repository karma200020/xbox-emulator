import { BUTTONS, type Profile, type Target } from "./profile-schema";

export function targetId(target: Target): string {
  return typeof target === "string" ? target : `button:${target.button}`;
}

export function controllerTargetLabel(target: Target, translate: (key: string) => string): string {
  const labels: Record<string, [string, string?]> = {
    left_x_negative: ["leftStickLeft"],
    left_x_positive: ["leftStickRight"],
    left_y_negative: ["leftStickBack"],
    left_y_positive: ["leftStickForward"],
    left_trigger: ["leftTrigger", "LT"],
    right_trigger: ["rightTrigger", "RT"],
    [`button:${BUTTONS.a}`]: ["aButton", "A"],
    [`button:${BUTTONS.b}`]: ["bButton", "B"],
    [`button:${BUTTONS.x}`]: ["xButton", "X"],
    [`button:${BUTTONS.y}`]: ["yButton", "Y"],
    [`button:${BUTTONS.left_thumb}`]: ["leftStickClick", "LS"],
    [`button:${BUTTONS.right_thumb}`]: ["rightStickClick", "RS"],
    [`button:${BUTTONS.left_shoulder}`]: ["leftBumper", "LB"],
    [`button:${BUTTONS.right_shoulder}`]: ["rightBumper", "RB"],
    [`button:${BUTTONS.start}`]: ["menuButton"],
    [`button:${BUTTONS.back}`]: ["viewButton"],
    [`button:${BUTTONS.guide}`]: ["guideButton"],
    [`button:${BUTTONS.dpad_up}`]: ["dpadUp"],
    [`button:${BUTTONS.dpad_down}`]: ["dpadDown"],
    [`button:${BUTTONS.dpad_left}`]: ["dpadLeft"],
    [`button:${BUTTONS.dpad_right}`]: ["dpadRight"],
  };
  const label = labels[targetId(target)];
  if (!label) return targetId(target);
  const [key, abbreviation] = label;
  return abbreviation ? `${abbreviation} - ${translate(key)}` : translate(key);
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
