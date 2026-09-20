import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { englishMessageKeys, t } from "./i18n";

const extensionRoot = resolve(import.meta.dirname, "..");

describe("localization", () => {
  it("keeps every supported locale complete and non-empty", () => {
    const expected = englishMessageKeys();
    for (const locale of ["en", "es", "pt_BR", "hi"]) {
      const catalog = JSON.parse(readFileSync(
        resolve(extensionRoot, "_locales", locale, "messages.json"),
        "utf8",
      )) as Record<string, { message?: string }>;
      expect(Object.keys(catalog).sort(), locale).toEqual(expected);
      expect(Object.values(catalog).every(({ message }) => Boolean(message?.trim())), locale).toBe(true);
    }
  });

  it("falls back safely to bundled English and replaces placeholders", () => {
    expect(t("detectedGame", "Halo", () => "")).toBe("Detected game: Halo");
    expect(t("missingMessage", [], () => "")).toBe("missingMessage");
  });

  it("covers every declarative UI key and localizes the manifest", () => {
    const catalog = new Set(englishMessageKeys());
    for (const file of ["options.html", "popup.html"]) {
      const source = readFileSync(resolve(extensionRoot, file), "utf8");
      for (const match of source.matchAll(/data-i18n(?:-placeholder|-aria-label)?="([^"]+)"/g)) {
        expect(catalog.has(match[1]!), `${file}: ${match[1]}`).toBe(true);
      }
    }
    const manifest = JSON.parse(readFileSync(resolve(extensionRoot, "manifest.json"), "utf8")) as {
      default_locale?: string;
      name?: string;
      description?: string;
    };
    expect(manifest).toMatchObject({
      default_locale: "en",
      name: "__MSG_extensionName__",
      description: "__MSG_extensionDescription__",
    });
  });
});
