import {
  PROFILE_SCHEMA_VERSION,
  parseSelectedProfile,
  type Profile,
} from "./profile-schema";
import { isGameIdentity, type GameIdentity } from "./game-profile";

export const PROTOCOL_VERSION = 1;
export { PROFILE_SCHEMA_VERSION };
export const NATIVE_HOST = "com.xib.companion";
export const MAX_BATCH_EVENTS = 512;

export type InputEvent =
  | { kind: "key"; code: string; down: boolean }
  | { kind: "mouse_move"; dx: number; dy: number }
  | { kind: "mouse_button"; button: number; down: boolean }
  | { kind: "wheel"; delta_y: number };

export type ClientMessage =
  | {
      type: "hello";
      protocol_version: number;
      client_version: string;
    }
  | { type: "activate"; profile_id: string }
  | {
      type: "set_profile";
      schema_version: typeof PROFILE_SCHEMA_VERSION;
      profile: Profile;
    }
  | { type: "deactivate"; reason: string }
  | { type: "heartbeat"; sequence: number }
  | {
      type: "input_batch";
      sequence: number;
      timestamp_ms: number;
      events: InputEvent[];
    };

export type HostMessage =
  | {
      type: "hello_ack";
      protocol_version: number;
      host_version: string;
      backend: string;
    }
  | { type: "status"; active: boolean; profile_id: string | null }
  | { type: "profile_applied"; profile_id: string }
  | { type: "ack"; sequence: number }
  | {
      type: "error";
      code:
        | "invalid_message"
        | "protocol_mismatch"
        | "invalid_state"
        | "backend_unavailable"
        | "invalid_profile";
      message: string;
    };

export interface OverlayProfileSummary {
  id: string;
  name: string;
  hip_x: number;
  hip_y: number;
  ads_x: number;
  ads_y: number;
}

export type OverlayMatch = "unknown" | "matched" | "ambiguous";

export type RuntimeMessage =
  | { type: "arm_capture" }
  | { type: "browser_activate"; profile: Profile }
  | { type: "browser_events"; events: InputEvent[]; timestamp_ms: number }
  | { type: "browser_deactivate" }
  | { type: "stop_capture"; reason: string }
  | { type: "capture_started" }
  | { type: "capture_heartbeat" }
  | { type: "capture_stopped"; reason: string }
  | { type: "input_events"; events: InputEvent[]; timestamp_ms: number }
  | { type: "get_status" }
  | { type: "game_identity_changed"; identity: GameIdentity | null }
  | { type: "get_overlay_state" }
  | { type: "select_profile"; profile_id: string; associate: boolean }
  | {
      type: "update_profile_sensitivity";
      profile_id: string;
      hip_x: number;
      hip_y: number;
      ads_x: number;
      ads_y: number;
    }
  | {
      type: "overlay_state";
      identity: GameIdentity | null;
      match: OverlayMatch;
      candidate_profile_ids: string[];
      active_profile_id: string;
      profiles: OverlayProfileSummary[];
      capture_active: boolean;
    }
  | {
      type: "status_update";
      connected: boolean;
      active: boolean;
      error: string | null;
      backend: string | null;
    };

export function isHostMessage(value: unknown): value is HostMessage {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "hello_ack":
      return (
        hasExactKeys(value, ["type", "protocol_version", "host_version", "backend"]) &&
        typeof value.protocol_version === "number" &&
        typeof value.host_version === "string" &&
        typeof value.backend === "string"
      );
    case "status":
      return (
        hasExactKeys(value, ["type", "active", "profile_id"]) &&
        typeof value.active === "boolean" &&
        (value.profile_id === null || typeof value.profile_id === "string")
      );
    case "profile_applied":
      return hasExactKeys(value, ["type", "profile_id"]) &&
        typeof value.profile_id === "string" && value.profile_id.length <= 40;
    case "ack":
      return hasExactKeys(value, ["type", "sequence"]) && Number.isSafeInteger(value.sequence);
    case "error":
      return (
        hasExactKeys(value, ["type", "code", "message"]) &&
        isErrorCode(value.code) &&
        typeof value.message === "string" &&
        value.message.length <= 1024
      );
    default:
      return false;
  }
}

export function isRuntimeMessage(value: unknown): value is RuntimeMessage {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "arm_capture":
    case "capture_started":
    case "capture_heartbeat":
    case "get_status":
    case "get_overlay_state":
    case "browser_deactivate":
      return hasExactKeys(value, ["type"]);
    case "browser_activate":
      return hasExactKeys(value, ["type", "profile"]) && isProfile(value.profile);
    case "browser_events":
      return isInputEventsMessage(value);
    case "stop_capture":
    case "capture_stopped":
      return hasExactKeys(value, ["type", "reason"]) &&
        typeof value.reason === "string" && value.reason.length <= 256;
    case "input_events":
      return isInputEventsMessage(value);
    case "status_update":
      return (
        hasExactKeys(value, ["type", "connected", "active", "error", "backend"]) &&
        typeof value.connected === "boolean" &&
        typeof value.active === "boolean" &&
        (value.error === null || typeof value.error === "string") &&
        (value.backend === null || typeof value.backend === "string")
      );
    case "game_identity_changed":
      return hasExactKeys(value, ["type", "identity"]) &&
        (value.identity === null || isGameIdentity(value.identity));
    case "select_profile":
      return hasExactKeys(value, ["type", "profile_id", "associate"]) &&
        isProfileId(value.profile_id) && typeof value.associate === "boolean";
    case "update_profile_sensitivity":
      return hasExactKeys(value, [
        "type", "profile_id", "hip_x", "hip_y", "ads_x", "ads_y",
      ]) &&
        isProfileId(value.profile_id) &&
        isSensitivity(value.hip_x) && isSensitivity(value.hip_y) &&
        isSensitivity(value.ads_x) && isSensitivity(value.ads_y);
    case "overlay_state":
      return isOverlayState(value);
    default:
      return false;
  }

  function isOverlayState(value: Record<string, unknown>): boolean {
    return hasExactKeys(value, [
      "type", "identity", "match", "candidate_profile_ids", "active_profile_id",
      "profiles", "capture_active",
    ]) &&
      (value.identity === null || isGameIdentity(value.identity)) &&
      (value.match === "unknown" || value.match === "matched" || value.match === "ambiguous") &&
      Array.isArray(value.candidate_profile_ids) &&
      value.candidate_profile_ids.length <= 20 &&
      value.candidate_profile_ids.every(isProfileId) &&
      isProfileId(value.active_profile_id) &&
      Array.isArray(value.profiles) &&
      value.profiles.length >= 1 &&
      value.profiles.length <= 20 &&
      value.profiles.every(isOverlayProfileSummary) &&
      typeof value.capture_active === "boolean";
  }

  function isOverlayProfileSummary(value: unknown): boolean {
    return isRecord(value) &&
      hasExactKeys(value, ["id", "name", "hip_x", "hip_y", "ads_x", "ads_y"]) &&
      isProfileId(value.id) &&
      typeof value.name === "string" && value.name.length >= 1 && value.name.length <= 60 &&
      isSensitivity(value.hip_x) && isSensitivity(value.hip_y) &&
      isSensitivity(value.ads_x) && isSensitivity(value.ads_y);
  }

  function isProfile(value: unknown): value is Profile {
    if (!isRecord(value) || typeof value.id !== "string") return false;
    return parseSelectedProfile({
      schema_version: PROFILE_SCHEMA_VERSION,
      active_profile_id: value.id,
      profiles: [value],
    }).ok;
  }

  function isProfileId(value: unknown): value is string {
    return typeof value === "string" &&
      /^[a-z0-9](?:[a-z0-9_-]{0,38}[a-z0-9])?$/.test(value);
  }

  function isSensitivity(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) &&
      value >= 0.001 && value <= 0.2;
  }
}

export function isInputEventsMessage(
  value: unknown,
): value is { events: InputEvent[]; timestamp_ms: number } {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["type", "events", "timestamp_ms"]) &&
    (value.type === "input_events" || value.type === "browser_events") &&
    Array.isArray(value.events) &&
    value.events.length <= MAX_BATCH_EVENTS &&
    value.events.every(isInputEvent) &&
    Number.isSafeInteger(value.timestamp_ms) &&
    Number(value.timestamp_ms) >= 0
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInputEvent(value: unknown): value is InputEvent {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  switch (value.kind) {
    case "key":
      return (
        hasExactKeys(value, ["kind", "code", "down"]) &&
        typeof value.code === "string" &&
        value.code.length > 0 &&
        value.code.length <= 64 &&
        typeof value.down === "boolean"
      );
    case "mouse_move":
      return hasExactKeys(value, ["kind", "dx", "dy"]) &&
        isBoundedInteger(value.dx, 100_000) && isBoundedInteger(value.dy, 100_000);
    case "mouse_button":
      return (
        hasExactKeys(value, ["kind", "button", "down"]) &&
        Number.isInteger(value.button) &&
        Number(value.button) >= 0 &&
        Number(value.button) <= 4 &&
        typeof value.down === "boolean"
      );
    case "wheel":
      return hasExactKeys(value, ["kind", "delta_y"]) &&
        isBoundedInteger(value.delta_y, 100_000);
    default:
      return false;
  }
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function isBoundedInteger(value: unknown, magnitude: number): value is number {
  return (
    Number.isSafeInteger(value) &&
    Math.abs(Number(value)) <= magnitude
  );
}

function isErrorCode(value: unknown): value is Extract<HostMessage, { type: "error" }>["code"] {
  return (
    value === "invalid_message" ||
    value === "protocol_mismatch" ||
    value === "invalid_state" ||
    value === "backend_unavailable" ||
    value === "invalid_profile"
  );
}
