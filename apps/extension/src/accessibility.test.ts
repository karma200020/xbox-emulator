import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const extensionRoot = resolve(import.meta.dirname, "..");
const html = readFileSync(resolve(extensionRoot, "options.html"), "utf8");
const css = readFileSync(resolve(extensionRoot, "options.css"), "utf8");

describe("accessibility surfaces", () => {
  it("provides live status, a modal onboarding name, and focusable controller semantics", () => {
    expect(html).toContain('id="status" class="status" role="status" aria-live="polite"');
    expect(html).toContain('id="onboarding" aria-labelledby="onboarding-title"');
    expect(html).toMatch(/class="controller-control"[^>]+tabindex="0"/);
    expect(html).toContain('id="controller-output" class="controller-output" aria-live="polite"');
    expect(html).toContain('class="skip-link"');
    expect(html).toContain('id="advanced-mode"');
    expect(html).toContain('class="glossary"');
    expect(html).toContain('data-i18n="actionDisclaimer"');
  });

  it("supports visible focus, reduced motion, system contrast, and explicit high contrast", () => {
    expect(css).toContain(":focus-visible");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain("@media (prefers-contrast: more)");
    expect(css).toContain("@media (forced-colors: active)");
    expect(css).toContain(":root.high-contrast");
  });
});
