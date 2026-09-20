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
    if (result.ok) expect(result.value.profiles.map(({ id }) => id)).toEqual([
      "default", "fps", "racing", "action", "platformer", "one-handed",
    ]);
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
          mouse: {
            ...profile.mouse,
            hip: { ...profile.mouse.hip, sensitivity_x: Number.POSITIVE_INFINITY, deadzone: 1 },
          },
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(expect.arrayContaining([
        expect.stringContaining("unexpected"),
        expect.stringContaining("mouse.hip.sensitivity_x"),
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

  it("migrates an unversioned mapping profile without changing its response", () => {
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
      expect(result.value.schema_version).toBe(2);
      expect(result.value.profiles[0]!.name).toBe("Custom Profile");
      expect(result.value.profiles[0]!.mouse.hip.curve).toBe("linear");
      expect(result.value.profiles[0]!.mouse.ads).toEqual(result.value.profiles[0]!.mouse.hip);
      expect(result.value.profiles[0]!.mouse.ads_activation).toBeNull();
      expect(result.value.profiles[0]!.game_associations).toEqual([]);
    }
  });

  it("migrates a versioned v1 document and round-trips v2 JSON", () => {
    const legacy = {
      schema_version: 1,
      active_profile_id: "legacy",
      profiles: [{
        id: "legacy",
        name: "Legacy",
        key_bindings: { KeyW: ["left_y_positive"] },
        mouse_bindings: { "0": ["right_trigger"] },
        mouse: {
          sensitivity_x: 0.018,
          sensitivity_y: 0.02,
          invert_x: false,
          invert_y: true,
          deadzone: 0.1,
          curve: "precision",
        },
      }],
    };
    const migrated = parseProfileDocument(legacy);
    expect(migrated.ok).toBe(true);
    if (!migrated.ok) return;
    expect(migrated.migrated).toBe(true);
    expect(migrated.value.profiles[0]!.mouse.hip).toEqual({
      ...legacy.profiles[0]!.mouse,
      smoothing: 0,
      velocity_scale: 0,
    });
    expect(parseProfileJson(JSON.stringify(migrated.value))).toEqual({
      ok: true,
      value: migrated.value,
      migrated: false,
    });
  });

  it("enforces finite advanced bounds and an existing ADS source", () => {
    const document = createStarterProfiles();
    const profile = document.profiles[0]!;
    profile.mouse.hip.smoothing = Number.NaN;
    profile.mouse.ads.velocity_scale = 4.1;
    profile.mouse.ads_activation = { type: "key", code: "KeyZ" };
    const result = parseProfileDocument(document);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(expect.arrayContaining([
        expect.stringContaining("smoothing"),
        expect.stringContaining("velocity_scale"),
        expect.stringContaining("existing keyboard binding"),
      ]));
    }
  });

  it("validates normalized game metadata and rejects product-id conflicts", () => {
    const document = createStarterProfiles();
    document.profiles[0]!.game_associations = [{
      title_id: "halo-infinite",
      title_name: "halo infinite",
      aliases: ["halo 6"],
    }];
    document.profiles[1]!.game_associations = [{
      title_id: "halo-infinite",
      title_name: "other game",
      aliases: ["halo infinite"],
    }];
    const conflict = parseProfileDocument(document);
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) {
      expect(conflict.errors).toContain('Game product id "halo-infinite" is assigned to multiple profiles.');
    }
    document.profiles[1]!.game_associations[0]!.title_id = "other-id";
    document.profiles[1]!.game_associations[0]!.aliases = ["Halo"];
    const notNormalized = parseProfileDocument(document);
    expect(notNormalized.ok).toBe(false);
    if (!notNormalized.ok) {
      expect(notNormalized.errors).toEqual(expect.arrayContaining([
        expect.stringContaining("normalized lowercase text"),
      ]));
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

    document.profiles[0]!.mouse.hip.curve = "unsupported" as never;
    expect(parseSelectedProfile(document).ok).toBe(false);
  });
});
