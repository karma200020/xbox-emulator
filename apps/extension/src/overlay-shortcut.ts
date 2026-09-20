export const OVERLAY_SHORTCUT_STORAGE_KEY = "xib.overlay_shortcut";

export const OVERLAY_SHORTCUTS = {
  "ctrl-alt-p": { label: "Ctrl+Alt+P", code: "KeyP", ctrl: true, alt: true, shift: false },
  "ctrl-alt-o": { label: "Ctrl+Alt+O", code: "KeyO", ctrl: true, alt: true, shift: false },
  "ctrl-shift-p": { label: "Ctrl+Shift+P", code: "KeyP", ctrl: true, alt: false, shift: true },
} as const;

export type OverlayShortcutId = keyof typeof OVERLAY_SHORTCUTS;
export const DEFAULT_OVERLAY_SHORTCUT: OverlayShortcutId = "ctrl-alt-p";

export function parseOverlayShortcut(value: unknown): OverlayShortcutId {
  return typeof value === "string" && Object.hasOwn(OVERLAY_SHORTCUTS, value)
    ? value as OverlayShortcutId
    : DEFAULT_OVERLAY_SHORTCUT;
}

export function matchesOverlayShortcut(
  event: Pick<KeyboardEvent, "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">,
  shortcutId: OverlayShortcutId,
): boolean {
  const shortcut = OVERLAY_SHORTCUTS[shortcutId];
  return !event.metaKey && event.code === shortcut.code &&
    event.ctrlKey === shortcut.ctrl && event.altKey === shortcut.alt &&
    event.shiftKey === shortcut.shift;
}

export function overlayShortcutLabel(shortcutId: OverlayShortcutId): string {
  return OVERLAY_SHORTCUTS[shortcutId].label;
}
