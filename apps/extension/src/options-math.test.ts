import { describe, expect, it } from "vitest";
import { BUTTONS } from "./profile-schema";
import {
  MAX_CALIBRATION_SAMPLES,
  addCalibrationSample,
  addTarget,
  applyResponseCurve,
  mouseAxis,
  previewPoints,
  removeTarget,
  replaceTarget,
  suggestedSensitivity,
} from "./options-math";

describe("response curve preview math", () => {
  it("matches the runtime curve and deadzone algorithm", () => {
    expect(mouseAxis(25, 0.02, false, 0, "linear")).toBeCloseTo(0.5);
    expect(mouseAxis(25, 0.02, false, 0, "exponential")).toBeCloseTo(0.25);
    expect(mouseAxis(25, 0.02, false, 0, "precision")).toBeCloseTo(0.125);
    expect(mouseAxis(5, 0.02, false, 0.1, "linear")).toBe(0);
    expect(mouseAxis(10, 0.02, true, 0.1, "linear")).toBeCloseTo(-1 / 9);
    expect(applyResponseCurve(3, 0, "linear")).toBe(1);
  });

  it("produces deterministic bounded preview points", () => {
    expect(previewPoints(0.25, "exponential", 4)).toEqual([
      [0, 0],
      [0.25, 0],
      [0.5, 1 / 9],
      [0.75, 4 / 9],
      [1, 1],
    ]);
  });
});

describe("calibration math", () => {
  it("bounds samples and derives a clamped suggestion", () => {
    let samples = Array.from({ length: 300 }, (_, index) => ({ dx: index + 1, dy: 0 }));
    samples = addCalibrationSample(samples, { dx: 301.9, dy: -2.2 });
    expect(samples).toHaveLength(MAX_CALIBRATION_SAMPLES);
    expect(samples.at(-1)).toEqual({ dx: 301, dy: -2 });
    expect(suggestedSensitivity(Array.from({ length: 10 }, () => ({ dx: 10, dy: 2 })))).toBe(0.085);
    expect(suggestedSensitivity([{ dx: 2, dy: 1 }])).toBeNull();
  });
});

describe("multi-target mutations", () => {
  const a = { button: BUTTONS.a };
  const b = { button: BUTTONS.b };

  it("adds, replaces, and removes any of one to four targets", () => {
    expect(addTarget(["left_trigger"], a)).toEqual(["left_trigger", a]);
    expect(replaceTarget(["left_trigger", a], 1, b)).toEqual(["left_trigger", b]);
    expect(removeTarget(["left_trigger", b], 0)).toEqual([b]);
    expect(removeTarget([b], 0)).toEqual([b]);
  });

  it("rejects duplicate and fifth targets", () => {
    expect(addTarget([a], a)).toEqual([a]);
    const four = ["left_trigger", "right_trigger", a, b] as const;
    expect(addTarget(four, { button: BUTTONS.x })).toEqual(four);
    expect(replaceTarget(["left_trigger", a], 1, "left_trigger")).toEqual(["left_trigger", a]);
  });
});
