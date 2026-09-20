import { describe, expect, it } from "vitest";
import { createStarterProfiles } from "./profile-schema";
import { runCompatibilitySelfTests, summarizeSelfTests } from "./compatibility-self-test";

describe("compatibility self-tests", () => {
  it("reports actionable passes for a healthy local Chromium environment", () => {
    const results = runCompatibilitySelfTests({
      userAgent: "Mozilla/5.0 Chrome/153.0.8010.52 Safari/537.36",
      pointerLockSupported: true,
      gamepadApiSupported: true,
      localStorageSupported: true,
      profileDocument: createStarterProfiles(),
      timerElapsedMs: 51,
      bridge: { contentScript: true, mainWorld: true, watchdog: true },
    });
    expect(summarizeSelfTests(results)).toBe("pass");
    expect(results.every(({ action }) => action === null)).toBe(true);
  });

  it("does not claim game validation when the route bridge is unavailable", () => {
    const results = runCompatibilitySelfTests({
      userAgent: "Mozilla/5.0 Edg/146.0.3856.109",
      pointerLockSupported: true,
      gamepadApiSupported: true,
      localStorageSupported: true,
      profileDocument: createStarterProfiles(),
      timerElapsedMs: 900,
      bridge: { contentScript: false, mainWorld: false, watchdog: false },
    });
    expect(summarizeSelfTests(results)).toBe("warn");
    expect(results.find(({ id }) => id === "bridge")?.action).toContain("play route");
    expect(results.map(({ summary }) => summary).join(" ")).not.toMatch(/game passed|game validated/i);
  });

  it("fails closed for invalid profiles or missing required capabilities", () => {
    const results = runCompatibilitySelfTests({
      userAgent: "Unknown",
      pointerLockSupported: false,
      gamepadApiSupported: false,
      localStorageSupported: true,
      profileDocument: {},
      timerElapsedMs: 50,
      bridge: { contentScript: false, mainWorld: false, watchdog: false },
    });
    expect(summarizeSelfTests(results)).toBe("fail");
    expect(results.filter(({ status }) => status === "fail").map(({ id }) => id))
      .toEqual(expect.arrayContaining(["pointer_lock", "gamepad_api", "profile"]));
  });
});
