import { describe, expect, it } from "vitest";
import { createStarterProfiles, PROFILE_STORAGE_KEY } from "./profile-schema";
import { loadSelectedProfile } from "./profile-runtime";

describe("loadSelectedProfile", () => {
  it("returns the selected validated local profile", async () => {
    const document = createStarterProfiles();
    document.active_profile_id = "fps";
    const result = await loadSelectedProfile({
      get: async () => ({ [PROFILE_STORAGE_KEY]: document }),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.profile.id).toBe("fps");
  });

  it("fails closed for absent or invalid stored data", async () => {
    expect(await loadSelectedProfile({ get: async () => ({}) })).toEqual(
      expect.objectContaining({ ok: false }),
    );
    const document = createStarterProfiles();
    (document.profiles[0] as unknown as Record<string, unknown>).unknown = true;
    expect(
      await loadSelectedProfile({
        get: async () => ({ [PROFILE_STORAGE_KEY]: document }),
      }),
    ).toEqual(expect.objectContaining({ ok: false }));
  });
});
