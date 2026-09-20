import { describe, expect, it } from "vitest";
import { isHostMessage, isRuntimeMessage } from "./protocol";

describe("isHostMessage", () => {
  it("accepts a valid handshake", () => {
    expect(
      isHostMessage({
        type: "hello_ack",
        protocol_version: 1,
        host_version: "0.1.0",
        backend: "fake",
      }),
    ).toBe(true);
  });

  it("accepts a profile application acknowledgement", () => {
    expect(isHostMessage({ type: "profile_applied", profile_id: "fps" })).toBe(true);
  });

  it("rejects malformed status messages", () => {
    expect(
      isHostMessage({ type: "status", active: "yes", profile_id: null }),
    ).toBe(false);
  });

  it("rejects extra keys in host and runtime messages", () => {
    expect(isHostMessage({
      type: "profile_applied", profile_id: "fps", injected: true,
    })).toBe(false);
    expect(isRuntimeMessage({ type: "arm_capture", injected: true })).toBe(false);
    expect(isRuntimeMessage({
      type: "select_profile", profile_id: "fps", associate: true, injected: true,
    })).toBe(false);
  });

  it("bounds quick-overlay sensitivity messages", () => {
    expect(isRuntimeMessage({
      type: "update_profile_sensitivity",
      profile_id: "fps",
      hip_x: 0.02,
      hip_y: 0.02,
      ads_x: 0.01,
      ads_y: 0.01,
    })).toBe(true);
    expect(isRuntimeMessage({
      type: "update_profile_sensitivity",
      profile_id: "fps",
      hip_x: 1,
      hip_y: 0.02,
      ads_x: 0.01,
      ads_y: 0.01,
    })).toBe(false);
  });
});
