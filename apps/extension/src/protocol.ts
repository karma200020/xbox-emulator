import { PROFILE_SCHEMA_VERSION, type Profile } from "./profile-schema";

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
        typeof value.protocol_version === "number" &&
        typeof value.host_version === "string" &&
        typeof value.backend === "string"
      );
    case "status":
      return (
        typeof value.active === "boolean" &&
        (value.profile_id === null || typeof value.profile_id === "string")
      );
    case "profile_applied":
      return typeof value.profile_id === "string" && value.profile_id.length <= 40;
    case "ack":
      return Number.isSafeInteger(value.sequence);
    case "error":
      return (
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
    case "browser_deactivate":
      return true;
    case "browser_activate":
      return isRecord(value.profile);
    case "browser_events":
      return isInputEventsMessage(value);
    case "stop_capture":
    case "capture_stopped":
      return typeof value.reason === "string" && value.reason.length <= 256;
    case "input_events":
      return isInputEventsMessage(value);
    case "status_update":
      return (
        typeof value.connected === "boolean" &&
        typeof value.active === "boolean" &&
        (value.error === null || typeof value.error === "string") &&
        (value.backend === null || typeof value.backend === "string")
      );
    default:
      return false;
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
