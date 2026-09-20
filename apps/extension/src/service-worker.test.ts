import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStarterProfiles, PROFILE_STORAGE_KEY } from "./profile-schema";

describe("service worker activation ownership", () => {
  let listener: (message: unknown, sender: chrome.runtime.MessageSender, reply: (value: any) => void) => boolean;
  let storageGet: ReturnType<typeof vi.fn>;
  let sendTab: ReturnType<typeof vi.fn>;
  const sender = (id: number): chrome.runtime.MessageSender => ({
    id: "extension-id", frameId: 0, url: "https://www.xbox.com/en-US/play",
    tab: { id } as chrome.tabs.Tab,
  });
  const message = (value: object, tab = 1): Promise<any> =>
    new Promise(resolve => listener(value, sender(tab), resolve));
  beforeEach(async () => {
    vi.resetModules();
    storageGet = vi.fn(async () => ({ [PROFILE_STORAGE_KEY]: createStarterProfiles() }));
    sendTab = vi.fn(async () => ({ accepted: true }));
    vi.stubGlobal("chrome", {
      runtime: {
        id: "extension-id",
        onMessage: { addListener: (fn: typeof listener) => { listener = fn; } },
        onInstalled: { addListener: vi.fn() },
        getManifest: () => ({ permissions: ["storage"] }),
        sendMessage: vi.fn(async () => {}),
      },
      storage: { local: { get: storageGet }, onChanged: { addListener: vi.fn() } },
      tabs: { sendMessage: sendTab, query: vi.fn(async () => []),
        onRemoved: { addListener: vi.fn() }, onUpdated: { addListener: vi.fn() } },
    });
    await import("./service-worker");
  });
  afterEach(() => vi.unstubAllGlobals());

  it("does not reactivate after stop while loading the profile", async () => {
    let finish!: (value: object) => void;
    storageGet.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const starting = message({ type: "capture_started" });
    await message({ type: "capture_stopped", reason: "escape" });
    finish({ [PROFILE_STORAGE_KEY]: createStarterProfiles() });
    await starting;
    expect(sendTab.mock.calls.some(([, value]) => value.type === "browser_activate")).toBe(false);
    expect((await message({ type: "get_status" })).active).toBe(false);
  });

  it("ignores stops from an unrelated tab", async () => {
    await message({ type: "capture_started" });
    await message({ type: "capture_stopped", reason: "window_blur" }, 2);
    expect((await message({ type: "get_status" })).active).toBe(true);
  });

  it("stops the old tab before taking ownership of a new one", async () => {
    await message({ type: "capture_started" });
    await message({ type: "capture_started" }, 2);
    expect(sendTab).toHaveBeenCalledWith(1, { type: "stop_capture", reason: "capture_replaced" });
    await message({ type: "capture_stopped", reason: "late_stop" }, 1);
    expect((await message({ type: "get_status" })).active).toBe(true);
  });

  it("does not report success when the content script rejects activation", async () => {
    sendTab.mockResolvedValueOnce({ accepted: false, error: "Bridge unavailable" });
    const result = await message({ type: "capture_started" });
    expect(result.active).toBe(false);
    expect(result.error).toBe("Bridge unavailable");
  });

  it("cancels a pending acknowledgement when stop is requested", async () => {
    let finish!: (value: object) => void;
    sendTab.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const starting = message({ type: "capture_started" });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    await message({ type: "capture_stopped", reason: "escape" });
    finish({ accepted: true });
    await starting;
    expect((await message({ type: "get_status" })).active).toBe(false);
  });

  it("stops an orphaned capture after a worker restart", async () => {
    await message({ type: "capture_heartbeat" });
    expect(sendTab).toHaveBeenCalledWith(1, { type: "stop_capture", reason: "capture_session_expired" });
  });

  it("clears ownership when the active tab closes", async () => {
    await message({ type: "capture_started" });
    const removed = vi.mocked(chrome.tabs.onRemoved.addListener).mock.calls[0]![0];
    removed(1, { windowId: 1, isWindowClosing: false });
    expect((await message({ type: "get_status" })).active).toBe(false);
  });

  it("stops capture when the active tab begins navigating", async () => {
    await message({ type: "capture_started" });
    const updated = vi.mocked(chrome.tabs.onUpdated.addListener).mock.calls[0]![0];
    updated(1, { status: "loading" }, sender(1).tab!);
    expect((await message({ type: "get_status" })).active).toBe(false);
    expect(sendTab).toHaveBeenCalledWith(1, { type: "stop_capture", reason: "tab_navigated" });
  });
});
