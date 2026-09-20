import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStarterProfiles, PROFILE_STORAGE_KEY } from "./profile-schema";

describe("service worker activation ownership", () => {
  let listener: (message: unknown, sender: chrome.runtime.MessageSender, reply: (value: any) => void) => boolean;
  let storageGet: ReturnType<typeof vi.fn>;
  let storageSet: ReturnType<typeof vi.fn>;
  let sendTab: ReturnType<typeof vi.fn>;
  let storedDocument = createStarterProfiles();
  const sender = (id: number, url = "https://www.xbox.com/en-US/play"): chrome.runtime.MessageSender => ({
    id: "extension-id", frameId: 0, url,
    tab: { id } as chrome.tabs.Tab,
  });
  const message = (value: object, tab = 1, url?: string): Promise<any> =>
    new Promise(resolve => listener(value, sender(tab, url), resolve));
  beforeEach(async () => {
    vi.resetModules();
    storedDocument = createStarterProfiles();
    storageGet = vi.fn(async () => ({ [PROFILE_STORAGE_KEY]: storedDocument }));
    storageSet = vi.fn(async (update: Record<string, unknown>) => {
      if (PROFILE_STORAGE_KEY in update) {
        storedDocument = structuredClone(update[PROFILE_STORAGE_KEY]) as typeof storedDocument;
      }
    });
    sendTab = vi.fn(async () => ({ accepted: true }));
    vi.stubGlobal("chrome", {
      runtime: {
        id: "extension-id",
        onMessage: { addListener: (fn: typeof listener) => { listener = fn; } },
        onInstalled: { addListener: vi.fn() },
        getManifest: () => ({ permissions: ["storage"] }),
        sendMessage: vi.fn(async () => {}),
      },
      storage: {
        local: { get: storageGet, set: storageSet, remove: vi.fn(async () => {}) },
        onChanged: { addListener: vi.fn() },
      },
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
    const diagnostics = await new Promise<any>(resolve => listener(
      { type: "get_diagnostics" },
      { id: "extension-id", url: "chrome-extension://extension-id/options.html" },
      resolve,
    ));
    expect(diagnostics.snapshot.capture.active).toBe(true);
    expect(diagnostics.snapshot.capture.sessions).toBe(2);
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

  it("selects a unique exact product profile on a SPA identity update", async () => {
    storedDocument.profiles[1]!.game_associations = [{
      title_id: "abc123", title_name: "test game", aliases: [],
    }];
    const result = await message({
      type: "game_identity_changed",
      identity: { product_id: "abc123", title_slug: "test-game", title_name: "test game" },
    }, 1, "https://www.xbox.com/en-US/play/games/test-game/ABC123");
    expect(storedDocument.active_profile_id).toBe("fps");
    expect(result.active_profile_id).toBe("fps");
    expect(result.match).toBe("matched");
  });

  it("offers an ambiguous alias choice without changing the active profile", async () => {
    storedDocument.profiles[0]!.game_associations = [{
      title_id: "first", title_name: "test game", aliases: [],
    }];
    storedDocument.profiles[1]!.game_associations = [{
      title_id: "second", title_name: "second", aliases: ["test game"],
    }];
    const identity = { product_id: "abc123", title_slug: "test-game", title_name: "test game" };
    const result = await message(
      { type: "game_identity_changed", identity },
      1,
      "https://www.xbox.com/en-US/play/games/test-game/ABC123",
    );
    expect(storedDocument.active_profile_id).toBe("default");
    expect(result.match).toBe("ambiguous");
    expect(result.candidate_profile_ids).toEqual(["default", "fps"]);
    expect(sendTab).toHaveBeenCalledWith(1, expect.objectContaining({ type: "overlay_state" }));
  });

  it("neutralizes browser mapping before atomically applying an automatic switch", async () => {
    await message({ type: "capture_started" });
    sendTab.mockClear();
    storedDocument.profiles[1]!.game_associations = [{
      title_id: "abc123", title_name: "test game", aliases: [],
    }];
    await message({
      type: "game_identity_changed",
      identity: { product_id: "abc123", title_slug: "test-game", title_name: "test game" },
    }, 1, "https://www.xbox.com/en-US/play/games/test-game/ABC123");
    expect(sendTab.mock.calls[0]).toEqual([1, { type: "browser_deactivate" }]);
    expect(sendTab.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      type: "browser_activate",
      profile: expect.objectContaining({ id: "fps" }),
    }));
  });

  it("persists an explicit ambiguous choice as an exact local association", async () => {
    const identity = { product_id: "abc123", title_slug: "test-game", title_name: "test game" };
    await message(
      { type: "game_identity_changed", identity },
      1,
      "https://www.xbox.com/en-US/play/games/test-game/ABC123",
    );
    const result = await message(
      { type: "select_profile", profile_id: "racing", associate: true },
      1,
      "https://www.xbox.com/en-US/play/games/test-game/ABC123",
    );
    expect(storedDocument.active_profile_id).toBe("racing");
    expect(storedDocument.profiles[2]!.game_associations).toContainEqual({
      title_id: "abc123", title_name: "test game", aliases: [],
    });
    expect(result.match).toBe("matched");
  });

  it("persists bounded hip and ADS tuning from the owning tab", async () => {
    const result = await message({
      type: "update_profile_sensitivity",
      profile_id: "fps",
      hip_x: 0.031,
      hip_y: 0.032,
      ads_x: 0.011,
      ads_y: 0.012,
    });
    expect(storedDocument.active_profile_id).toBe("fps");
    expect(storedDocument.profiles[1]!.mouse.hip).toEqual(expect.objectContaining({
      sensitivity_x: 0.031,
      sensitivity_y: 0.032,
    }));
    expect(storedDocument.profiles[1]!.mouse.ads).toEqual(expect.objectContaining({
      sensitivity_x: 0.011,
      sensitivity_y: 0.012,
    }));
    expect(result.active_profile_id).toBe("fps");
  });

  it("rejects profile management from an unrelated tab while capture is owned", async () => {
    await message({ type: "capture_started" });
    const before = JSON.stringify(storedDocument);
    await message({ type: "select_profile", profile_id: "fps", associate: false }, 2);
    expect(JSON.stringify(storedDocument)).toBe(before);
  });

  it("does not let a background game route replace the owning tab's profile", async () => {
    await message({ type: "capture_started" });
    storedDocument.profiles[1]!.game_associations = [{
      title_id: "abc123", title_name: "test game", aliases: [],
    }];
    await message({
      type: "game_identity_changed",
      identity: { product_id: "abc123", title_slug: "test-game", title_name: "test game" },
    }, 2, "https://www.xbox.com/en-US/play/games/test-game/ABC123");
    expect(storedDocument.active_profile_id).toBe("default");
  });

  it("reconstructs game identity from the browser-owned sender URL after restart", async () => {
    const result = await message(
      { type: "get_overlay_state" },
      1,
      "https://www.xbox.com/en-US/play/games/test-game/ABC123",
    );
    expect(result.identity).toEqual({
      product_id: "abc123", title_slug: "test-game", title_name: "test game",
    });
  });

  it("resolves the initiating tab's exact game association before capture starts", async () => {
    storedDocument.profiles[1]!.game_associations = [{
      title_id: "abc123", title_name: "test game", aliases: [],
    }];
    await message(
      { type: "capture_started" },
      1,
      "https://www.xbox.com/en-US/play/games/test-game/ABC123",
    );
    expect(sendTab).toHaveBeenCalledWith(1, expect.objectContaining({
      type: "browser_activate",
      profile: expect.objectContaining({ id: "fps" }),
    }));
  });

  it("serializes concurrent profile selection and sensitivity persistence", async () => {
    let finish!: () => void;
    storageSet.mockImplementationOnce((update: Record<string, unknown>) =>
      new Promise<void>(resolve => {
        finish = () => {
          storedDocument = structuredClone(update[PROFILE_STORAGE_KEY]) as typeof storedDocument;
          resolve();
        };
      }));
    const selecting = message({ type: "select_profile", profile_id: "fps", associate: false });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    const tuning = message({
      type: "update_profile_sensitivity",
      profile_id: "fps",
      hip_x: 0.041,
      hip_y: 0.042,
      ads_x: 0.021,
      ads_y: 0.022,
    });
    finish();
    await Promise.all([selecting, tuning]);
    expect(storedDocument.active_profile_id).toBe("fps");
    expect(storedDocument.profiles[1]!.mouse.hip.sensitivity_x).toBe(0.041);
  });

  it("keeps diagnostics ephemeral until an extension page explicitly opts in", async () => {
    const extensionSender: chrome.runtime.MessageSender = {
      id: "extension-id",
      url: "chrome-extension://extension-id/options.html",
    };
    const request = (value: object): Promise<any> =>
      new Promise(resolve => listener(value, extensionSender, resolve));
    const initial = await request({ type: "get_diagnostics" });
    expect(initial.persistence).toBe(false);
    expect(initial.performance_overlay).toBe(false);

    const enabled = await request({
      type: "set_diagnostics_preferences",
      persistence: true,
      performance_overlay: true,
    });
    expect(enabled.persistence).toBe(true);
    expect(enabled.performance_overlay).toBe(true);
    expect(storageSet).toHaveBeenCalledWith(expect.objectContaining({
      "xib.diagnostics_persist": true,
      "xib.performance_overlay": true,
    }));
    expect(storageSet).toHaveBeenCalledWith(expect.objectContaining({
      "xib.diagnostics_snapshot": expect.any(Object),
    }));
  });
});
