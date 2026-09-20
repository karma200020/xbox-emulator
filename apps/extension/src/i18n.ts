import englishMessages from "../_locales/en/messages.json";

type MessageCatalog = Record<string, {
  message: string;
  placeholders?: Record<string, { content: string }>;
}>;
type MessageProvider = (name: string, substitutions?: string | string[]) => string;

const fallbackMessages = englishMessages as MessageCatalog;

export function t(
  name: string,
  substitutions: string | string[] = [],
  provider: MessageProvider | undefined = globalThis.chrome?.i18n?.getMessage,
): string {
  const values = typeof substitutions === "string" ? [substitutions] : substitutions;
  const localized = provider?.(name, values);
  if (localized) return localized;
  const entry = fallbackMessages[name];
  if (!entry) return name;
  const withNamedPlaceholders = Object.entries(entry.placeholders ?? {}).reduce(
    (message, [placeholder, { content }]) => {
      const index = Number(content.replace("$", "")) - 1;
      return message.replaceAll(`$${placeholder.toUpperCase()}$`, values[index] ?? "");
    },
    entry.message,
  );
  return values.reduce(
    (message, value, index) => message.replaceAll(`$${index + 1}`, value),
    withNamedPlaceholders,
  );
}

export function localizeDocument(root: Document = document): void {
  const language = globalThis.chrome?.i18n?.getUILanguage?.();
  if (language && root.documentElement) root.documentElement.lang = language.replace("_", "-");
  if (typeof root.querySelectorAll !== "function") return;
  for (const element of root.querySelectorAll<HTMLElement>("[data-i18n]")) {
    const key = element.dataset.i18n;
    if (key) element.textContent = t(key);
  }
  for (const element of root.querySelectorAll<HTMLInputElement>("[data-i18n-placeholder]")) {
    const key = element.dataset.i18nPlaceholder;
    if (key) element.placeholder = t(key);
  }
  for (const element of root.querySelectorAll<HTMLElement>("[data-i18n-aria-label]")) {
    const key = element.dataset.i18nAriaLabel;
    if (key) element.setAttribute("aria-label", t(key));
  }
  root.title = t(root.body?.dataset.i18nTitle ?? "extensionName");
}

export function englishMessageKeys(): string[] {
  return Object.keys(fallbackMessages).sort();
}
