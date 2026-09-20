import {
  normalizeGameText,
  type GameAssociation,
  type Profile,
  type ProfileDocument,
} from "./profile-schema";

export interface GameIdentity {
  product_id: string;
  title_slug: string;
  title_name: string;
}

export type GameProfileMatch =
  | { kind: "unknown"; basis: null; profile_ids: [] }
  | { kind: "unique"; basis: "product_id" | "alias"; profile_ids: [string] }
  | { kind: "ambiguous"; basis: "product_id" | "alias"; profile_ids: string[] };

const GAME_ROUTE =
  /^\/(?:[a-z]{2}-[a-z]{2}\/)?play\/games\/(?<titleSlug>[^/]+)\/(?<productId>\w+)(?:\/|$)/i;

export function parseXcloudGameIdentity(value: string): GameIdentity | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== "www.xbox.com" || url.port !== "") return null;
  const match = GAME_ROUTE.exec(url.pathname);
  if (!match?.groups) return null;
  let decodedSlug: string;
  try {
    decodedSlug = decodeURIComponent(match.groups.titleSlug!);
  } catch {
    return null;
  }
  const productId = normalizeProductId(match.groups.productId!);
  const titleSlug = normalizeSlug(decodedSlug);
  const titleName = normalizeGameText(decodedSlug.replace(/[-_]+/g, " "));
  if (!productId || !titleSlug || !titleName) return null;
  return { product_id: productId, title_slug: titleSlug, title_name: titleName };
}

export function matchGameProfile(
  profiles: readonly Profile[],
  identity: GameIdentity,
): GameProfileMatch {
  const productMatches = matchingProfileIds(profiles, (association) =>
    normalizeProductId(association.title_id) === identity.product_id);
  if (productMatches.length > 0) return matchResult("product_id", productMatches);

  const aliasMatches = matchingProfileIds(profiles, (association) => {
    const names = [association.title_name, ...association.aliases];
    return names.some((name) => normalizeGameText(name.replace(/[-_]+/g, " ")) === identity.title_name);
  });
  return aliasMatches.length > 0 ? matchResult("alias", aliasMatches) :
    { kind: "unknown", basis: null, profile_ids: [] };
}

export function associateGameWithProfile(
  document: ProfileDocument,
  identity: GameIdentity,
  profileId: string,
): ProfileDocument | null {
  if (!document.profiles.some(({ id }) => id === profileId)) return null;
  const next = structuredClone(document);
  for (const profile of next.profiles) {
    profile.game_associations = profile.game_associations.filter(
      ({ title_id }) => normalizeProductId(title_id) !== identity.product_id,
    );
  }
  const selected = next.profiles.find(({ id }) => id === profileId)!;
  if (selected.game_associations.length >= 20) return null;
  selected.game_associations.push({
    title_id: identity.product_id,
    title_name: identity.title_name,
    aliases: [],
  });
  next.active_profile_id = profileId;
  return next;
}

export function searchProfiles(profiles: readonly Profile[], query: string): Profile[] {
  const needle = normalizeGameText(query);
  if (!needle) return [...profiles];
  return profiles.filter((profile) =>
    normalizeGameText(`${profile.name} ${profile.id}`).includes(needle));
}

export function isGameIdentity(value: unknown): value is GameIdentity {
  if (!isRecord(value) || !hasExactKeys(value, ["product_id", "title_slug", "title_name"])) return false;
  return typeof value.product_id === "string" &&
    value.product_id === normalizeProductId(value.product_id) &&
    typeof value.title_slug === "string" &&
    value.title_slug === normalizeSlug(value.title_slug) &&
    typeof value.title_name === "string" &&
    value.title_name === normalizeGameText(value.title_name) &&
    value.product_id.length <= 80 && value.title_slug.length <= 100 && value.title_name.length <= 100;
}

function matchingProfileIds(
  profiles: readonly Profile[],
  predicate: (association: GameAssociation) => boolean,
): string[] {
  return profiles
    .filter((profile) => profile.game_associations.some(predicate))
    .map(({ id }) => id);
}

function matchResult(
  basis: "product_id" | "alias",
  profileIds: string[],
): GameProfileMatch {
  return profileIds.length === 1
    ? { kind: "unique", basis, profile_ids: [profileIds[0]!] }
    : { kind: "ambiguous", basis, profile_ids: profileIds };
}

function normalizeProductId(value: string): string {
  const normalized = value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
  return /^[a-z0-9_]{1,80}$/.test(normalized) ? normalized : "";
}

function normalizeSlug(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}
