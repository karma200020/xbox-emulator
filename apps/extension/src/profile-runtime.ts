import {
  PROFILE_STORAGE_KEY,
  parseSelectedProfile,
  type Profile,
} from "./profile-schema";

type LocalStorageReader = {
  get(key: string): Promise<Record<string, unknown>>;
};

export type StoredProfileResult =
  | { ok: true; profile: Profile }
  | { ok: false; error: string };

export async function loadSelectedProfile(
  storage: LocalStorageReader,
): Promise<StoredProfileResult> {
  try {
    const stored = await storage.get(PROFILE_STORAGE_KEY);
    const raw = stored[PROFILE_STORAGE_KEY];
    if (raw === undefined) {
      return { ok: false, error: "No saved profile is available. Open extension options and save a profile." };
    }
    const result = parseSelectedProfile(raw);
    if (!result.ok) {
      return { ok: false, error: `Saved profile data is invalid: ${result.errors.join(" ")}` };
    }
    return { ok: true, profile: result.profile };
  } catch {
    return { ok: false, error: "Could not read local profile storage." };
  }
}
