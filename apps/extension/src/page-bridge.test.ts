import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectPageBridge } from "./page-bridge";

class Port extends EventTarget {
  close = vi.fn();
  start = vi.fn();
}

describe("page bridge handshake", () => {
  let channels: { port1: Port; port2: Port }[];
  let post: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.useFakeTimers();
    channels = [];
    post = vi.fn();
    vi.stubGlobal("window", { postMessage: post });
    vi.stubGlobal("location", { origin: "https://www.xbox.com" });
    vi.stubGlobal("MessageChannel", class {
      port1 = new Port();
      port2 = new Port();
      constructor() { channels.push(this); }
    });
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("accepts a delayed ACK from the first candidate after retrying", async () => {
    const ready = connectPageBridge();
    vi.advanceTimersByTime(500);
    expect(channels).toHaveLength(3);
    expect(channels[0]!.port1.close).not.toHaveBeenCalled();
    channels[0]!.port1.dispatchEvent(new MessageEvent("message", {
      data: { type: "xib_bridge_ready_v1", nonce: post.mock.calls[0]![0].nonce },
    }));
    expect(await ready).toBe(channels[0]!.port1);
    expect(channels[1]!.port1.close).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(3000);
    expect(channels).toHaveLength(3);
  });

  it("bounds retries and closes abandoned channels on timeout", async () => {
    const ready = connectPageBridge();
    const failure = expect(ready).rejects.toThrow("did not respond");
    vi.advanceTimersByTime(2000);
    await failure;
    expect(channels).toHaveLength(8);
    expect(channels.every(c => c.port1.close.mock.calls.length === 1)).toBe(true);
  });
});
