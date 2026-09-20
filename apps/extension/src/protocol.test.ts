import { describe, expect, it } from "vitest";
import { isHostMessage } from "./protocol";

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
});
