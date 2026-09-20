import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const extensionDir = join(root, "apps", "extension", "dist");
const requested = argument("--browser") ?? "all";
const holdMs = Number(argument("--hold-ms") ?? "32000");
const artifactsDir = resolve(argument("--artifacts") ?? join(tmpdir(), "xib-browser-integration"));
const headed = process.argv.includes("--headed");
const keepProfile = process.argv.includes("--keep-profile");

const candidates = {
  chrome: [
    join(process.env.ProgramFiles ?? "", "Google", "Chrome", "Application", "chrome.exe"),
    join(process.env["ProgramFiles(x86)"] ?? "", "Google", "Chrome", "Application", "chrome.exe"),
    join(process.env.LOCALAPPDATA ?? "", "Google", "Chrome", "Application", "chrome.exe"),
  ],
  edge: [
    join(process.env.ProgramFiles ?? "", "Microsoft", "Edge", "Application", "msedge.exe"),
    join(process.env["ProgramFiles(x86)"] ?? "", "Microsoft", "Edge", "Application", "msedge.exe"),
  ],
};

async function runBrowser(browser, executable) {
  const profileDir = join(tmpdir(), `xib-${browser}-${process.pid}-${Date.now()}`);
  const checks = [];
  let child;
  let browserCdp;
  try {
    await mkdir(profileDir, { recursive: true });
    const args = [
      `--user-data-dir=${profileDir}`,
      "--remote-debugging-port=0",
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      "--no-first-run",
      "--disable-default-apps",
      "--disable-background-networking",
      "--disable-features=ExtensionsMenuAccessControl,DisableLoadExtensionCommandLineSwitch",
      "--enable-unsafe-extension-debugging",
      "--window-size=1280,800",
    ];
    if (!headed) args.push("--headless=new");
    args.push("about:blank");
    child = spawn(executable, args, { stdio: "ignore", windowsHide: !headed });

    const portFile = join(profileDir, "DevToolsActivePort");
    await waitFor(() => existsSync(portFile), 15_000, "DevTools endpoint");
    const [port, browserPath] = (await readFile(portFile, "utf8")).trim().split(/\r?\n/);
    browserCdp = new Cdp(`ws://127.0.0.1:${port}${browserPath}`);
    await browserCdp.ready();
    const version = await browserCdp.send("Browser.getVersion");
    checks.push(pass("browser_version", version.product));

    const extensionTarget = await waitFor(async () => {
      const targets = (await browserCdp.send("Target.getTargets")).targetInfos;
      return targets.find((target) =>
        target.type === "service_worker" &&
        target.url.startsWith("chrome-extension://") &&
        target.url.endsWith("/service-worker.js"));
    }, 20_000, "extension service worker");
    const extensionId = new URL(extensionTarget.url).host;
    checks.push(pass("extension_load", extensionId));

    const initialPage = await findPage(port, () => true);
    await browserCdp.send("Target.closeTarget", { targetId: initialPage.id });
    const xboxTarget = await browserCdp.send("Target.createTarget", {
      url: "https://www.xbox.com/en-US/play",
    });
    const page = await waitFor(async () => {
      const targets = await json(`http://127.0.0.1:${port}/json/list`);
      return targets.find((target) => target.id === xboxTarget.targetId);
    }, 20_000, "Xbox page target");
    const pageCdp = new Cdp(page.webSocketDebuggerUrl);
    await pageCdp.ready();
    await pageCdp.send("Page.enable");
    await pageCdp.send("Runtime.enable");
    await waitFor(() => evaluate(pageCdp,
      "location.hostname === 'www.xbox.com' && location.pathname.includes('/play')"),
    20_000, "Xbox Cloud Gaming route");
    await waitFor(() => evaluate(pageCdp, "document.readyState === 'complete'"), 20_000, "route load");
    await sleep(1_000);
    await pageCdp.send("Page.bringToFront");
    const route = await evaluate(pageCdp, "location.href");
    checks.push(route.includes("/play") ? pass("xcloud_route_injection", route.split("?")[0]) :
      fail("xcloud_route_injection", `Unexpected route ${route.split("?")[0]}`));

    const optionsPage = await waitFor(async () => {
      const targets = await json(`http://127.0.0.1:${port}/json/list`);
      return targets.find((target) => target.id === extensionTarget.targetId);
    }, 10_000, "extension worker debugger");
    let optionsCdp = new Cdp(optionsPage.webSocketDebuggerUrl);
    await optionsCdp.ready();
    await optionsCdp.send("Runtime.enable");
    await waitFor(() => evaluate(optionsCdp,
      "typeof globalThis.chrome?.runtime?.sendMessage === 'function'"), 10_000, "options runtime");
    await evaluate(optionsCdp, `(async () => {
      const [tab] = await chrome.tabs.query({});
      if (tab?.id !== undefined) await chrome.tabs.reload(tab.id);
      return true;
    })()`, true);
    await waitFor(() => evaluate(pageCdp,
      "document.readyState === 'complete' && location.pathname.includes('/play')"),
    20_000, "extension-aware route reload");
    await sleep(1_000);

    const bridge = await evaluate(optionsCdp, `(async () => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find(tab => tab.url?.startsWith("https://www.xbox.com/")) ?? tabs[0];
      return tab?.id === undefined
        ? { contentScript: false, mainWorld: false, watchdog: false, urls: tabs.map(tab => tab.url ?? "") }
        : chrome.tabs.sendMessage(tab.id, { type: "diagnostics_ping" }).catch(async error => ({
            contentScript: false,
            mainWorld: false,
            watchdog: false,
            error: error.message,
            permissions: await chrome.permissions.contains({ origins: ["https://www.xbox.com/*"] }),
            manifest: chrome.runtime.getManifest().content_scripts,
          }));
    })()`, true);
    checks.push(bridge?.contentScript && bridge?.mainWorld
      ? pass("content_main_bridge", bridge.watchdog
          ? "Handshake responded; watchdog active"
          : "Handshake responded; watchdog correctly idle before activation")
      : fail("content_main_bridge", `Incomplete response: ${JSON.stringify(bridge)}; exceptions: ${
          pageCdp.events.filter(event => event.method === "Runtime.exceptionThrown")
            .map(event => event.params?.exceptionDetails?.exception?.description ?? "unknown").join(" | ") || "none"
        }`));

    await chord(pageCdp, "KeyG", 71);
    await waitFor(() => evaluate(pageCdp,
      "document.pointerLockElement === document.documentElement"), 5_000, "capture activation");
    checks.push(pass("activation", "Trusted shortcut acquired pointer lock"));
    const activeBridge = await evaluate(optionsCdp, `(async () => {
      const [tab] = await chrome.tabs.query({});
      return chrome.tabs.sendMessage(tab.id, { type: "diagnostics_ping" });
    })()`, true);
    checks.push(activeBridge?.watchdog
      ? pass("watchdog", "Active MAIN-world watchdog responded")
      : fail("watchdog", "Active watchdog did not respond"));

    await key(pageCdp, "keyDown", "KeyW", 87);
    await waitFor(() => evaluate(pageCdp,
      "Array.from(navigator.getGamepads()).some(p => p && p.id.includes('XInput') && p.axes[1] < -0.5)"),
    5_000, "held mapping");
    checks.push(pass("mapping", "Held W produced virtual left-stick input"));
    optionsCdp.close();
    await sleep(holdMs);
    const heldAlive = await evaluate(pageCdp,
      "Array.from(navigator.getGamepads()).some(p => p && p.id.includes('XInput') && p.axes[1] < -0.5)");
    optionsCdp = await connectExtensionWorker(browserCdp, port);
    const workerRecovered = await evaluate(optionsCdp,
      "chrome.tabs.query({}).then(tabs => tabs.length > 0)", true);
    checks.push(heldAlive && workerRecovered
      ? pass("service_worker_liveness", `Held state survived ${holdMs} ms and the detached worker responded afterward`)
      : fail("service_worker_liveness", "Held state or post-detach worker recovery failed"));

    await evaluate(optionsCdp, `(async () => {
      const key = "xib.profile_document";
      const stored = await chrome.storage.local.get(key);
      const next = structuredClone(stored[key]);
      next.active_profile_id = next.active_profile_id === "fps" ? "default" : "fps";
      await chrome.storage.local.set({ [key]: next });
      return next.active_profile_id;
    })()`, true);
    await sleep(750);
    const switched = await evaluate(pageCdp,
      "Array.from(navigator.getGamepads()).some(p => p && p.id.includes('XInput') && p.connected)");
    checks.push(switched
      ? pass("profile_switch", "Atomic runtime profile replacement kept the virtual controller healthy")
      : fail("profile_switch", "Profile replacement did not restore the virtual controller"));

    await key(pageCdp, "keyUp", "KeyW", 87);
    await key(pageCdp, "keyDown", "Escape", 27);
    await key(pageCdp, "keyUp", "Escape", 27);
    await sleep(250);
    const neutral = await evaluate(pageCdp,
      "Array.from(navigator.getGamepads()).every(p => !p || !p.id.includes('XInput'))");
    checks.push(neutral ? pass("neutralization", "Escape disconnected the virtual controller") :
      fail("neutralization", "Virtual controller remained connected"));

    await evaluate(pageCdp, `(() => {
      const fixture = document.createElement("div");
      fixture.id = "xib-fullscreen-fixture";
      fixture.style.cssText = "position:fixed;inset:0;background:#000;z-index:2147483000";
      document.documentElement.append(fixture);
      return fixture.requestFullscreen();
    })()`, true);
    await chord(pageCdp, "KeyG", 71);
    await waitFor(() => evaluate(pageCdp,
      "document.fullscreenElement?.id === 'xib-fullscreen-fixture' && document.pointerLockElement === document.documentElement"),
    5_000, "fullscreen activation");
    await chord(pageCdp, "KeyG", 71);
    await sleep(250);
    const fullscreenPreserved = await evaluate(pageCdp,
      "document.fullscreenElement?.id === 'xib-fullscreen-fixture' && document.pointerLockElement === null");
    checks.push(fullscreenPreserved
      ? pass("fullscreen_shortcut", "Container fullscreen was preserved on stop")
      : fail("fullscreen_shortcut", "Fullscreen container lifecycle failed"));
    await evaluate(pageCdp, "document.exitFullscreen()", true);
    await evaluate(pageCdp, `(() => {
      const fixture = document.createElement("video");
      fixture.id = "xib-video-fixture";
      fixture.muted = true;
      document.documentElement.append(fixture);
      return fixture.requestFullscreen();
    })()`, true);
    await chord(pageCdp, "KeyG", 71);
    await waitFor(() => evaluate(pageCdp,
      "document.fullscreenElement?.id === 'xib-video-fixture' && document.pointerLockElement === document.documentElement"),
    5_000, "video fullscreen activation");
    await chord(pageCdp, "KeyG", 71);
    await sleep(250);
    const videoFullscreenPreserved = await evaluate(pageCdp,
      "document.fullscreenElement?.id === 'xib-video-fixture' && document.pointerLockElement === null");
    checks.push(videoFullscreenPreserved
      ? pass("video_fullscreen_shortcut", "Video fullscreen shortcut started and stopped capture")
      : fail("video_fullscreen_shortcut", "Video fullscreen shortcut lifecycle failed"));
    await evaluate(pageCdp, "document.exitFullscreen()", true);

    await pageCdp.send("Page.navigate", { url: "https://www.xbox.com/en-US/store" });
    await waitFor(() => evaluate(pageCdp, "location.pathname.includes('/store')"), 15_000, "navigation");
    const cleaned = await evaluate(pageCdp,
      "document.pointerLockElement === null && Array.from(navigator.getGamepads()).every(p => !p || !p.id.includes('XInput'))");
    checks.push(cleaned ? pass("navigation_cleanup", "Navigation removed capture state") :
      fail("navigation_cleanup", "Capture state survived route exit"));

    pageCdp.close();
    optionsCdp.close();
    const failed = checks.some((check) => check.status === "fail");
    return { browser, executable: basename(executable), version: version.product, status: failed ? "failed" : "passed", checks };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const blocked = detail.includes("extension service worker");
    checks.push(blocked ? warn("extension_load", detail) : fail("runner", detail));
    return { browser, executable: basename(executable), status: blocked ? "blocked" : "failed", checks };
  } finally {
    browserCdp?.close();
    if (child && child.exitCode === null) {
      child.kill();
      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        sleep(5_000),
      ]);
    }
    if (!keepProfile) {
      await rm(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
    }
  }
}

class Cdp {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.sequence = 0;
    this.pending = new Map();
    this.events = [];
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) {
        this.events.push(message);
        if (this.events.length > 100) this.events.shift();
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }
  ready() {
    if (this.socket.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", () => reject(new Error("CDP connection failed")), { once: true });
    });
  }
  send(method, params = {}) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  close() {
    if (this.socket.readyState < WebSocket.CLOSING) this.socket.close();
  }
}

async function evaluate(cdp, expression, awaitPromise = false) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  }
  return result.result.value;
}

async function chord(cdp, code, keyCode) {
  await key(cdp, "keyDown", "ControlLeft", 17, 2);
  await key(cdp, "keyDown", "AltLeft", 18, 3);
  await key(cdp, "keyDown", code, keyCode, 3);
  await key(cdp, "keyUp", code, keyCode, 3);
  await key(cdp, "keyUp", "AltLeft", 18, 2);
  await key(cdp, "keyUp", "ControlLeft", 17, 0);
}

function key(cdp, type, code, windowsVirtualKeyCode, modifiers = 0) {
  return cdp.send("Input.dispatchKeyEvent", {
    type,
    code,
    key: code.replace(/^(Key|Digit)/, ""),
    windowsVirtualKeyCode,
    nativeVirtualKeyCode: windowsVirtualKeyCode,
    modifiers,
  });
}

async function findPage(port, predicate) {
  return waitFor(async () => {
    const targets = await json(`http://127.0.0.1:${port}/json/list`);
    return targets.find((target) => target.type === "page" && predicate(target));
  }, 20_000, "Xbox page");
}

async function connectExtensionWorker(browserCdp, port) {
  const target = await waitFor(async () => {
    const targets = (await browserCdp.send("Target.getTargets")).targetInfos;
    return targets.find((candidate) =>
      candidate.type === "service_worker" &&
      candidate.url.startsWith("chrome-extension://") &&
      candidate.url.endsWith("/service-worker.js"));
  }, 10_000, "extension worker recovery");
  const debuggerTarget = await waitFor(async () => {
    const targets = await json(`http://127.0.0.1:${port}/json/list`);
    return targets.find((candidate) => candidate.id === target.targetId);
  }, 10_000, "extension worker debugger");
  const cdp = new Cdp(debuggerTarget.webSocketDebuggerUrl);
  await cdp.ready();
  await cdp.send("Runtime.enable");
  return cdp;
}

async function json(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

async function waitFor(probe, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pass(name, detail = "") {
  return { name, status: "pass", detail };
}

function fail(name, detail) {
  return { name, status: "fail", detail };
}

function warn(name, detail) {
  return { name, status: "warn", detail };
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

await mkdir(artifactsDir, { recursive: true });
const browsers = requested === "all" ? ["chrome", "edge"] : [requested];
const runs = [];
for (const browser of browsers) {
  const executable = candidates[browser]?.find(existsSync);
  if (!executable) {
    runs.push({ browser, status: "not_available", checks: [] });
    continue;
  }
  runs.push(await runBrowser(browser, executable));
}

const report = {
  schema_version: 1,
  generated_at: new Date().toISOString(),
  route: "https://www.xbox.com/en-US/play",
  authenticated_game_launched: false,
  hold_ms: holdMs,
  runs,
};
const reportPath = join(artifactsDir, `browser-integration-${Date.now()}.json`);
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(reportPath);
for (const run of runs) {
  console.log(`${run.browser}: ${run.status}`);
  for (const check of run.checks ?? []) {
    console.log(`  ${check.status.padEnd(4)} ${check.name}${check.detail ? ` - ${check.detail}` : ""}`);
  }
}
if (runs.some((run) => run.status !== "passed")) process.exitCode = 1;
