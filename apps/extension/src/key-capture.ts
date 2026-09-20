export type CaptureKind = "keyboard" | "mouse";
export type CaptureResult =
  | { status: "accepted"; source: string }
  | { status: "cancelled" }
  | { status: "duplicate"; source: string }
  | { status: "invalid" };

export interface CaptureInput {
  code?: string;
  button?: number;
}

export function resolveCapture(
  kind: CaptureKind,
  input: CaptureInput,
  existingSources: readonly string[],
  currentSource: string | null,
): CaptureResult {
  if (input.code === "Escape") return { status: "cancelled" };
  const source = kind === "keyboard"
    ? validKeyboardCode(input.code) ? input.code : null
    : validMouseButton(input.button) ? String(input.button) : null;
  if (source === null) return { status: "invalid" };
  if (source !== currentSource && existingSources.includes(source)) {
    return { status: "duplicate", source };
  }
  return { status: "accepted", source };
}

export function validKeyboardCode(code: unknown): code is string {
  return typeof code === "string" && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(code) &&
    code !== "Escape";
}

export function replaceBindingSource<T>(
  bindings: Record<string, T[]>,
  oldSource: string,
  newSource: string,
): void {
  if (oldSource === newSource) return;
  const targets = bindings[oldSource];
  if (!targets || Object.hasOwn(bindings, newSource)) return;
  bindings[newSource] = targets;
  delete bindings[oldSource];
}

function validMouseButton(button: unknown): button is number {
  return Number.isInteger(button) && Number(button) >= 0 && Number(button) <= 4;
}
