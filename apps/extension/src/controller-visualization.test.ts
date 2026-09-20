import { describe, expect, it } from "vitest";
import { controllerParts } from "./controller-visualization";
import { createStarterProfiles } from "./profile-schema";

describe("controller visualization semantics", () => {
  it("exposes every mapped source, including multi-target bindings", () => {
    const profile = createStarterProfiles().profiles[0]!;
    profile.key_bindings.KeyZ = [
      profile.key_bindings.Space![0]!,
      profile.key_bindings.KeyR![0]!,
    ];
    const parts = controllerParts(profile);
    expect(parts.find(({ target }) => target === "button:4096")?.sources)
      .toEqual(expect.arrayContaining(["Space", "KeyZ"]));
    expect(parts.find(({ target }) => target === "button:16384")?.sources)
      .toEqual(expect.arrayContaining(["KeyR", "KeyZ"]));
  });
});
