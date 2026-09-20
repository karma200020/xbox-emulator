import { describe, expect, it } from "vitest";
import { isSensitivityValue, parseOverlayState } from "./quick-overlay";
import { createStarterProfiles } from "./profile-schema";

describe("quick overlay data", () => {
  it.each([0.001, 0.018, 0.2])("accepts bounded sensitivity %s", (value) => {
    expect(isSensitivityValue(value)).toBe(true);
  });

  it.each([0, 0.201, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects unsafe sensitivity %s",
    (value) => expect(isSensitivityValue(value)).toBe(false),
  );

  it("accepts only exact validated overlay state", () => {
    const profile = createStarterProfiles().profiles[0]!;
    const state = {
      type: "overlay_state",
      identity: null,
      match: "unknown",
      candidate_profile_ids: [],
      active_profile_id: profile.id,
      profiles: [{
        id: profile.id,
        name: profile.name,
        hip_x: profile.mouse.hip.sensitivity_x,
        hip_y: profile.mouse.hip.sensitivity_y,
        ads_x: profile.mouse.ads.sensitivity_x,
        ads_y: profile.mouse.ads.sensitivity_y,
      }],
      capture_active: false,
    };
    expect(parseOverlayState(state)).toEqual(state);
    expect(parseOverlayState({ ...state, injected: true })).toBeNull();
  });
});
