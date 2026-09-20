import { describe, expect, it } from "vitest";
import { createStarterProfiles } from "./profile-schema";
import {
  associateGameWithProfile,
  matchGameProfile,
  parseXcloudGameIdentity,
  searchProfiles,
} from "./game-profile";

describe("xCloud game identity", () => {
  it.each([
    ["https://www.xbox.com/en-US/play/games/Halo-Infinite/9PP5G1F0C2B6", "9pp5g1f0c2b6", "halo infinite"],
    ["https://www.xbox.com/play/games/Forza%20Horizon/ABC_123?launch=true", "abc_123", "forza horizon"],
  ])("parses stable detail route %s", (url, productId, name) => {
    expect(parseXcloudGameIdentity(url)).toEqual(expect.objectContaining({
      product_id: productId,
      title_name: name,
    }));
  });

  it.each([
    "https://www.xbox.com/en-US/play",
    "https://www.xbox.com/en-US/play/games/title",
    "https://www.xbox.com/en-US/play/games/title/id-with-dash",
    "https://example.com/play/games/title/ABC123",
    "not a url",
  ])("treats unsupported or ambiguous route %s as unknown", (url) => {
    expect(parseXcloudGameIdentity(url)).toBeNull();
  });
});

describe("game profile matching", () => {
  it("prefers a unique exact product id over an alias", () => {
    const profiles = createStarterProfiles().profiles;
    profiles[0]!.game_associations = [{
      title_id: "product123", title_name: "other", aliases: [],
    }];
    profiles[1]!.game_associations = [{
      title_id: "different", title_name: "different", aliases: ["example game"],
    }];
    expect(matchGameProfile(profiles, {
      product_id: "product123", title_slug: "example-game", title_name: "example game",
    })).toEqual({ kind: "unique", basis: "product_id", profile_ids: ["default"] });
  });

  it("returns ambiguity instead of guessing between explicit names", () => {
    const profiles = createStarterProfiles().profiles;
    profiles[0]!.game_associations = [{
      title_id: "first", title_name: "example game", aliases: [],
    }];
    profiles[1]!.game_associations = [{
      title_id: "second", title_name: "second game", aliases: ["example game"],
    }];
    expect(matchGameProfile(profiles, {
      product_id: "unknown", title_slug: "example-game", title_name: "example game",
    })).toEqual({
      kind: "ambiguous", basis: "alias", profile_ids: ["default", "fps"],
    });
  });

  it("persists an explicit product association to only the chosen profile", () => {
    const document = createStarterProfiles();
    document.profiles[0]!.game_associations = [{
      title_id: "product123", title_name: "old title", aliases: [],
    }];
    const next = associateGameWithProfile(document, {
      product_id: "product123", title_slug: "new-title", title_name: "new title",
    }, "fps")!;
    expect(next.active_profile_id).toBe("fps");
    expect(next.profiles[0]!.game_associations).toEqual([]);
    expect(next.profiles[1]!.game_associations).toEqual([{
      title_id: "product123", title_name: "new title", aliases: [],
    }]);
    expect(document.active_profile_id).toBe("default");
  });

  it("filters bundled profiles locally by id or name", () => {
    expect(searchProfiles(createStarterProfiles().profiles, "access").map(({ id }) => id))
      .toEqual(["one-handed"]);
  });
});
