import { afterEach, describe, expect, it, vi } from "vitest";
import { isSensitivityValue, OverlayRefreshScheduler, parseOverlayState } from "./quick-overlay";
import { createStarterProfiles } from "./profile-schema";

describe("quick overlay data", () => {
  afterEach(() => vi.useRealTimers());
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
      performance_enabled: false,
      performance: {
        input_events_hz: 0,
        batches_hz: 0,
        average_batch_size: 0,
        mapping_average_ms: null,
        pipeline_estimate_average_ms: null,
        dropped_events: 0,
        capture_uptime_ms: 0,
      },
    };
    expect(parseOverlayState(state)).toEqual(state);
    expect(parseOverlayState({ ...state, injected: true })).toBeNull();
  });

  it("starts once and stops the overlay refresh lifecycle", () => {
    vi.useFakeTimers();
    const scheduler = new OverlayRefreshScheduler();
    const refresh = vi.fn();
    scheduler.start(refresh);
    scheduler.start(refresh);
    vi.advanceTimersByTime(3_000);
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(scheduler.isActive()).toBe(true);
    scheduler.stop();
    vi.advanceTimersByTime(3_000);
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(scheduler.isActive()).toBe(false);
  });
});
