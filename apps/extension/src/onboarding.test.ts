import { describe, expect, it } from "vitest";
import {
  ONBOARDING_VERSION,
  activationReady,
  finishOnboarding,
  needsOnboarding,
  parseOnboardingState,
  restartOnboardingState,
} from "./onboarding";

describe("onboarding state", () => {
  it("shows for first run, malformed state, and older versions", () => {
    expect(needsOnboarding(undefined)).toBe(true);
    expect(needsOnboarding({ version: 0, outcome: "completed" })).toBe(true);
    expect(needsOnboarding({ version: ONBOARDING_VERSION, outcome: "other" })).toBe(true);
  });

  it.each(["completed", "skipped"] as const)("persists the current %s outcome", (outcome) => {
    const state = finishOnboarding(outcome);
    expect(parseOnboardingState(state)).toEqual({
      version: ONBOARDING_VERSION,
      outcome,
    });
    expect(needsOnboarding(state)).toBe(false);
  });

  it("restarts by clearing the completed state", () => {
    expect(needsOnboarding(restartOnboardingState())).toBe(true);
  });

  it("requires every local readiness check without capturing input", () => {
    expect(activationReady({
      pointerLock: true,
      localStorage: true,
      starterProfile: true,
    })).toBe(true);
    expect(activationReady({
      pointerLock: false,
      localStorage: true,
      starterProfile: true,
    })).toBe(false);
  });
});
