import type { MouseSettings, ResponseCurve, Target } from "./profile-schema";

export const MIN_SENSITIVITY = 0.001;
export const MAX_SENSITIVITY = 0.2;
export const MAX_CALIBRATION_SAMPLES = 240;

export interface CalibrationSample {
  dx: number;
  dy: number;
}

export function applyResponseCurve(
  normalized: number,
  deadzone: number,
  curve: ResponseCurve,
): number {
  const bounded = Math.max(-1, Math.min(1, normalized));
  const boundedDeadzone = Math.max(0, Math.min(0.95, Math.fround(deadzone)));
  const scaled = Math.abs(bounded) <= boundedDeadzone
    ? 0
    : Math.sign(bounded) * ((Math.abs(bounded) - boundedDeadzone) / (1 - boundedDeadzone));
  const magnitude = curve === "linear"
    ? Math.abs(scaled)
    : curve === "exponential"
      ? Math.abs(scaled) ** 2
      : Math.abs(scaled) ** 3;
  return Math.sign(scaled) * magnitude;
}

export function mouseAxis(
  delta: number,
  sensitivity: number,
  invert: boolean,
  deadzone: number,
  curve: ResponseCurve,
  velocityScale = 0,
): number {
  if (delta === 0 || !Number.isFinite(sensitivity) || sensitivity <= 0) return 0;
  const direction = invert ? -1 : 1;
  const boundedVelocityScale = Number.isFinite(velocityScale)
    ? Math.max(0, Math.min(4, velocityScale))
    : 0;
  const velocityMultiplier = 1 + boundedVelocityScale * Math.min(Math.abs(delta) / 100, 1);
  return applyResponseCurve(
    delta * Math.fround(sensitivity) * velocityMultiplier * direction,
    deadzone,
    curve,
  );
}

export function previewPoints(deadzone: number, curve: ResponseCurve, steps = 64): [number, number][] {
  return Array.from({ length: steps + 1 }, (_, index) => {
    const input = index / steps;
    return [input, applyResponseCurve(input, deadzone, curve)];
  });
}

export function addCalibrationSample(
  samples: readonly CalibrationSample[],
  sample: CalibrationSample,
): CalibrationSample[] {
  if (!Number.isFinite(sample.dx) || !Number.isFinite(sample.dy)) return [...samples];
  return [...samples.slice(-(MAX_CALIBRATION_SAMPLES - 1)), {
    dx: Math.trunc(sample.dx),
    dy: Math.trunc(sample.dy),
  }];
}

export function suggestedSensitivity(samples: readonly CalibrationSample[]): number | null {
  const magnitudes = samples
    .map(({ dx, dy }) => Math.max(Math.abs(dx), Math.abs(dy)))
    .filter((value) => value > 0 && Number.isFinite(value))
    .sort((left, right) => left - right);
  if (magnitudes.length < 8) return null;
  const percentile = magnitudes[Math.ceil(magnitudes.length * 0.9) - 1]!;
  return roundSensitivity(Math.max(MIN_SENSITIVITY, Math.min(MAX_SENSITIVITY, 0.85 / percentile)));
}

export function replaceTarget(targets: readonly Target[], index: number, target: Target): Target[] {
  if (index < 0 || index >= targets.length || hasTarget(targets, target, index)) return [...targets];
  return targets.map((current, currentIndex) => currentIndex === index ? target : current);
}

export function addTarget(targets: readonly Target[], target: Target): Target[] {
  if (targets.length >= 4 || hasTarget(targets, target)) return [...targets];
  return [...targets, target];
}

export function removeTarget(targets: readonly Target[], index: number): Target[] {
  if (targets.length <= 1 || index < 0 || index >= targets.length) return [...targets];
  return targets.filter((_, currentIndex) => currentIndex !== index);
}

function hasTarget(targets: readonly Target[], target: Target, except = -1): boolean {
  const identity = targetIdentity(target);
  return targets.some((current, index) => index !== except && targetIdentity(current) === identity);
}

function targetIdentity(target: Target): string {
  return typeof target === "string" ? target : `button:${target.button}`;
}

function roundSensitivity(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function normalizedStick(sample: CalibrationSample, settings: MouseSettings): CalibrationSample {
  return {
    dx: mouseAxis(
      sample.dx,
      settings.sensitivity_x,
      settings.invert_x,
      settings.deadzone,
      settings.curve,
      settings.velocity_scale,
    ),
    dy: mouseAxis(
      -sample.dy,
      settings.sensitivity_y,
      settings.invert_y,
      settings.deadzone,
      settings.curve,
      settings.velocity_scale,
    ),
  };
}
