import { describe, expect, it } from "vitest";
import {
  BUTTONS,
  createStarterProfiles,
  duplicateBindingWarnings,
  parseProfileDocument,
  parseProfileJson,
  parseSelectedProfile,
} from "./profile-schema";

describe("profile schema", () => {
  it("reserves Escape for capture release in every starter profile", () => {
    for (const profile of createStarterProfiles().profiles) {
      expect(profile.key_bindings.Escape).toBeUndefined();
      expect(profile.key_bindings.Enter).toEqual([{ button: BUTTONS.start }]);
    }
  });
  it("accepts all built-in starter profiles", () => {
    const result = parseProfileDocument(createStarterProfiles());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.profiles.map(({ id }) => id)).toEqual(["default", "fps", "racing"]);
  });

  it("rejects unknown fields and unsafe numeric values", () => {
    const document = createStarterProfiles();
    const profile = document.profiles[0]!;
    const result = parseProfileDocument({
      ...document,
      profiles: [
        {
          ...profile,
          unexpected: true,
          mouse: { ...profile.mouse, sensitivity_x: Number.POSITIVE_INFINITY, deadzone: 1 },
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(expect.arrayContaining([
        expect.stringContaining("unexpected"),
        expect.stringContaining("sensitivity_x"),
        expect.stringContaining("deadzone"),
      ]));
    }
  });

  it("rejects unsupported targets, invalid ids, and excess data", () => {
    const document = createStarterProfiles();
    document.profiles[0]!.id = "../escape";
    document.active_profile_id = "../escape";
    document.profiles[0]!.key_bindings.KeyW = [{ button: 0xffff }];
    expect(parseProfileDocument(document).ok).toBe(false);
    expect(parseProfileJson(`"${"x".repeat(300_000)}"`).ok).toBe(false);
  });

  it("migrates the current unversioned mapping profile", () => {
    const result = parseProfileDocument({
      id: "custom-profile",
      key_bindings: { KeyW: ["left_y_positive"], Space: [{ button: BUTTONS.a }] },
      mouse_bindings: { "0": ["right_trigger"] },
      mouse: {
        sensitivity_x: 0.018,
        sensitivity_y: 0.02,
        invert_x: false,
        invert_y: true,
        deadzone: 0.1,
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.migrated).toBe(true);
      expect(result.value.profiles[0]!.name).toBe("Custom Profile");
      expect(result.value.profiles[0]!.mouse.curve).toBe("linear");
    }
  });

  it("reports duplicate controller-target assignments", () => {
    const profile = createStarterProfiles().profiles[0]!;
    profile.key_bindings.KeyZ = [{ button: BUTTONS.a }];
    expect(duplicateBindingWarnings(profile)).toEqual([
      expect.stringContaining("Key Space, Key KeyZ"),
    ]);
  });

  it("looks up the selected profile only after validating the whole document", () => {
    const document = createStarterProfiles();
    document.active_profile_id = "racing";
    const result = parseSelectedProfile(document);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.profile.name).toBe("Racing");

    document.profiles[0]!.mouse.curve = "unsupported" as never;
    expect(parseSelectedProfile(document).ok).toBe(false);
  });
});
