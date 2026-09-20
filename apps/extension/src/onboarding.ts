export const ONBOARDING_VERSION = 1;
export const ONBOARDING_STORAGE_KEY = "xib.onboarding";

export type OnboardingOutcome = "completed" | "skipped";

export interface OnboardingState {
  version: typeof ONBOARDING_VERSION;
  outcome: OnboardingOutcome;
}

export function parseOnboardingState(value: unknown): OnboardingState | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).length !== 2 ||
    candidate.version !== ONBOARDING_VERSION ||
    (candidate.outcome !== "completed" && candidate.outcome !== "skipped")
  ) return null;
  return candidate as unknown as OnboardingState;
}

export function needsOnboarding(value: unknown): boolean {
  return parseOnboardingState(value) === null;
}

export function finishOnboarding(outcome: OnboardingOutcome): OnboardingState {
  return { version: ONBOARDING_VERSION, outcome };
}

export function restartOnboardingState(): null {
  return null;
}

export interface ActivationReadiness {
  pointerLock: boolean;
  localStorage: boolean;
  starterProfile: boolean;
}

export function activationReady(readiness: ActivationReadiness): boolean {
  return readiness.pointerLock && readiness.localStorage && readiness.starterProfile;
}
