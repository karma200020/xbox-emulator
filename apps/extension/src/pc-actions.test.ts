import { describe, expect, it } from "vitest";
import { actionLabelKey, friendlyInputLabel, matchesProfileSearch } from "./pc-actions";
import { BUTTONS } from "./profile-schema";

describe("PC-first mapping labels", () => {
  it("shows familiar labels while retaining canonical codes", () => {
    expect(friendlyInputLabel("KeyW", false)).toBe("W");
    expect(friendlyInputLabel("ShiftLeft", false)).toBe("Left Shift");
    expect(friendlyInputLabel("0", true)).toBe("Left Mouse");
  });

  it("lets starter genres define honest action suggestions", () => {
    expect(actionLabelKey({ id: "fps" }, { button: BUTTONS.a })).toBe("actionJump");
    expect(actionLabelKey({ id: "racing" }, "right_trigger")).toBe("actionAccelerate");
    expect(actionLabelKey({ id: "platformer-copy" }, { button: BUTTONS.x })).toBe("actionDash");
  });

  it("finds presets by a localized PC-genre label", () => {
    expect(matchesProfileSearch(
      { id: "racing", name: "Racing" },
      "carreras",
      "Carreras — dirección con WASD",
    )).toBe(true);
  });
});
