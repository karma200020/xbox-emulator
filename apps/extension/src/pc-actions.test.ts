import { describe, expect, it } from "vitest";
import { controllerTargetLabel, friendlyInputLabel, matchesProfileSearch } from "./pc-actions";
import { AXIS_TARGETS, BUTTONS } from "./profile-schema";

describe("PC-first mapping labels", () => {
  it("shows familiar labels while retaining canonical codes", () => {
    expect(friendlyInputLabel("KeyW", false)).toBe("W");
    expect(friendlyInputLabel("ShiftLeft", false)).toBe("Left Shift");
    expect(friendlyInputLabel("0", true)).toBe("Left Mouse");
  });

  it("uses Xbox abbreviations rather than guessing game actions", () => {
    const translate = (key: string): string => ({
      rightBumper: "Right bumper", leftBumper: "Left bumper",
      rightStickClick: "Right stick click", leftStickClick: "Left stick click",
      leftTrigger: "Left trigger", rightTrigger: "Right trigger",
    })[key] ?? key;
    expect(controllerTargetLabel({ button: BUTTONS.right_shoulder }, translate)).toBe("RB - Right bumper");
    expect(controllerTargetLabel({ button: BUTTONS.left_shoulder }, translate)).toBe("LB - Left bumper");
    expect(controllerTargetLabel({ button: BUTTONS.right_thumb }, translate)).toBe("RS - Right stick click");
    expect(controllerTargetLabel({ button: BUTTONS.left_thumb }, translate)).toBe("LS - Left stick click");
    expect(controllerTargetLabel("left_trigger", translate)).toBe("LT - Left trigger");
    expect(controllerTargetLabel("right_trigger", translate)).toBe("RT - Right trigger");
  });

  it("provides a translated label for every supported controller target", () => {
    const targets = [...AXIS_TARGETS, ...Object.values(BUTTONS).map(button => ({ button }))];
    for (const target of targets) {
      expect(controllerTargetLabel(target, key => `localized:${key}`)).toContain("localized:");
    }
  });

  it("finds presets by a localized PC-genre label", () => {
    expect(matchesProfileSearch(
      { id: "racing", name: "Racing" },
      "carreras",
      "Carreras — dirección con WASD",
    )).toBe(true);
  });
});
