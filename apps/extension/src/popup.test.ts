import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class Element extends EventTarget {
  value = "";
  disabled = false;
  textContent = "";
}

describe("mapping editor shortcut", () => {
  let elements: Map<string, Element>;
  let openOptions: ReturnType<typeof vi.fn>;
  let close: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    elements = new Map(["status", "start", "stop", "backend", "edit-mappings"]
      .map(id => [id, new Element()]));
    openOptions = vi.fn(async () => {});
    close = vi.fn();
    vi.stubGlobal("document", { getElementById: (id: string) => elements.get(id) });
    vi.stubGlobal("window", { close });
    vi.stubGlobal("chrome", {
      storage: { local: { get: vi.fn(async () => ({})) } },
      runtime: {
        getManifest: () => ({ permissions: ["storage"] }),
        onMessage: { addListener: vi.fn() },
        sendMessage: vi.fn(async () => ({
          type: "status_update", connected: false, active: false, error: null, backend: null,
        })),
        openOptionsPage: openOptions,
      },
    });
    await import("./popup");
  });
  afterEach(() => vi.unstubAllGlobals());

  it("opens the registered editor without requiring an Xbox tab or capture", async () => {
    elements.get("edit-mappings")!.dispatchEvent(new Event("click"));
    expect(elements.get("edit-mappings")!.disabled).toBe(true);
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(openOptions).toHaveBeenCalledOnce();
  });

  it("shows an error and allows retry if the editor cannot open", async () => {
    openOptions.mockRejectedValueOnce(new Error("Unavailable"));
    elements.get("edit-mappings")!.dispatchEvent(new Event("click"));
    await vi.waitFor(() => expect(elements.get("status")!.textContent).toContain("Could not open"));
    expect(close).not.toHaveBeenCalled();
    expect(elements.get("edit-mappings")!.disabled).toBe(false);
    elements.get("edit-mappings")!.dispatchEvent(new Event("click"));
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  });
});
