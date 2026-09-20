import { parseProfileDocument, type ProfileDocument } from "./profile-schema";

export type SelfTestStatus = "pass" | "warn" | "fail";

export interface SelfTestResult {
  id: string;
  status: SelfTestStatus;
  summary: string;
  action: string | null;
}

export interface SelfTestEnvironment {
  userAgent: string;
  pointerLockSupported: boolean;
  gamepadApiSupported: boolean;
  localStorageSupported: boolean;
  profileDocument: unknown;
  timerElapsedMs: number;
  bridge: {
    contentScript: boolean;
    mainWorld: boolean;
    watchdog: boolean;
  };
}

export function runCompatibilitySelfTests(environment: SelfTestEnvironment): SelfTestResult[] {
  const browser = parseBrowser(environment.userAgent);
  const profile = parseProfileDocument(environment.profileDocument);
  return [
    result(
      "browser",
      browser.supported ? "pass" : "warn",
      browser.name,
      browser.supported ? null : "Use a current Chrome or Microsoft Edge release.",
    ),
    result(
      "pointer_lock",
      environment.pointerLockSupported ? "pass" : "fail",
      environment.pointerLockSupported ? "Pointer Lock API is available." : "Pointer Lock API is unavailable.",
      environment.pointerLockSupported ? null : "Enable Pointer Lock support or use a supported desktop browser.",
    ),
    result(
      "gamepad_api",
      environment.gamepadApiSupported ? "pass" : "fail",
      environment.gamepadApiSupported ? "Gamepad API is available." : "Gamepad API is unavailable.",
      environment.gamepadApiSupported ? null : "Use a browser with the standard Gamepad API enabled.",
    ),
    result(
      "storage",
      environment.localStorageSupported ? "pass" : "fail",
      environment.localStorageSupported ? "Extension-local storage is available." : "Extension-local storage is unavailable.",
      environment.localStorageSupported ? null : "Allow extension storage, then rerun the checks.",
    ),
    result(
      "bridge",
      environment.bridge.contentScript && environment.bridge.mainWorld ? "pass" : "warn",
      environment.bridge.contentScript && environment.bridge.mainWorld
        ? "Content and MAIN-world bridge handshake passed."
        : "Bridge handshake was not observed on an open Xbox Cloud Gaming route.",
      environment.bridge.contentScript && environment.bridge.mainWorld
        ? null : "Open an unauthenticated xbox.com play route and rerun the checks.",
    ),
    result(
      "gamepad_shim",
      environment.bridge.mainWorld ? "pass" : "warn",
      environment.bridge.mainWorld
        ? "The local Gamepad API shim responded."
        : "The Gamepad API shim could not be queried without a bridge.",
      environment.bridge.mainWorld ? null : "Open a supported play route and rerun the checks.",
    ),
    result(
      "profile",
      profile.ok ? (profile.migrated ? "warn" : "pass") : "fail",
      profile.ok
        ? (profile.migrated ? "The saved profile is valid but requires migration." : "The saved profile is valid.")
        : "The saved profile failed validation.",
      profile.ok
        ? (profile.migrated ? "Save profiles once to persist the current schema." : null)
        : "Reset or import a valid profile before capture.",
    ),
    result(
      "timer",
      environment.timerElapsedMs >= 40 && environment.timerElapsedMs <= 500 ? "pass" : "warn",
      `A 50 ms timer completed in ${Math.round(environment.timerElapsedMs)} ms.`,
      environment.timerElapsedMs >= 40 && environment.timerElapsedMs <= 500
        ? null : "Close heavily loaded tabs and rerun; background throttling may delay watchdogs.",
    ),
    result(
      "watchdog",
      environment.bridge.watchdog ? "pass" : "warn",
      environment.bridge.watchdog
        ? "The MAIN-world watchdog is installed and responsive."
        : "Watchdog health could not be confirmed without an active bridge.",
      environment.bridge.watchdog ? null : "Open a supported play route and rerun the checks.",
    ),
  ];
}

export function summarizeSelfTests(results: readonly SelfTestResult[]): SelfTestStatus {
  if (results.some(({ status }) => status === "fail")) return "fail";
  return results.some(({ status }) => status === "warn") ? "warn" : "pass";
}

export function testTimer(
  now: () => number = () => performance.now(),
  delay: (callback: () => void, ms: number) => unknown = (callback, ms) => setTimeout(callback, ms),
): Promise<number> {
  const started = now();
  return new Promise((resolve) => delay(() => resolve(Math.max(0, now() - started)), 50));
}

function parseBrowser(userAgent: string): { supported: boolean; name: string } {
  const edge = /\bEdg\/(\d+(?:\.\d+){0,3})/.exec(userAgent);
  if (edge) return { supported: Number(edge[1]!.split(".")[0]) >= 120, name: `Microsoft Edge ${edge[1]}` };
  const chrome = /\bChrome\/(\d+(?:\.\d+){0,3})/.exec(userAgent);
  if (chrome) return { supported: Number(chrome[1]!.split(".")[0]) >= 120, name: `Google Chrome ${chrome[1]}` };
  return { supported: false, name: "Browser could not be identified as Chrome or Microsoft Edge." };
}

function result(
  id: string,
  status: SelfTestStatus,
  summary: string,
  action: string | null,
): SelfTestResult {
  return { id, status, summary, action };
}

export function profileForSelfTest(value: unknown, fallback: ProfileDocument): unknown {
  return value === undefined ? fallback : value;
}
