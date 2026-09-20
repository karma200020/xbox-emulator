import { describe, expect, it } from "vitest";
import {
  DiagnosticsCollector,
  buildDiagnosticsExport,
  isDiagnosticsSample,
} from "./diagnostics";

describe("local diagnostics", () => {
  it("keeps bounded histograms and never retains input payloads", () => {
    let now = 0;
    const collector = new DiagnosticsCollector(() => now, () => new Date("2026-09-20T00:00:00Z"));
    collector.startCapture();
    collector.addSample({
      input_events: 600,
      batches: 40,
      batch_events: 600,
      dropped_events: 2,
      mapping_durations_ms: Array.from({ length: 100 }, (_, index) => index / 10),
      pipeline_estimates_ms: Array.from({ length: 100 }, (_, index) => index / 5),
    });
    now = 2_000;
    const snapshot = collector.snapshot();
    expect(snapshot.rates.input_events_hz).toBe(300);
    expect(snapshot.rates.batches_hz).toBe(20);
    expect(snapshot.rates.average_batch_size).toBe(15);
    expect(snapshot.durations.mapping_processing_ms.count).toBe(32);
    expect(snapshot.durations.mapping_processing_ms.histogram).toHaveLength(11);
    expect(JSON.stringify(snapshot)).not.toMatch(/Space|mouse_move|delta|KeyW/);
  });

  it("bounds categorized failures and redacts arbitrary failure details", () => {
    const collector = new DiagnosticsCollector(() => 0, () => new Date("2026-09-20T00:00:00Z"));
    for (let index = 0; index < 40; index += 1) {
      collector.recordFailure("runtime", `https://example.test/path?token=secret-${index}`);
    }
    const failures = collector.snapshot().recent_failures;
    expect(failures.length).toBeLessThanOrEqual(24);
    expect(JSON.stringify(failures)).not.toContain("example.test");
    expect(JSON.stringify(failures)).not.toContain("secret");
  });

  it("exports only version, configuration, aggregate data, and measurement labels", () => {
    const collector = new DiagnosticsCollector(() => 0, () => new Date("2026-09-20T00:00:00Z"));
    collector.recordFailure("bridge", "token=abc&url=https://example.test/game?account=1");
    const exported = buildDiagnosticsExport(collector.snapshot(), {
      extensionVersion: "0.1.0",
      protocolVersion: 1,
      profileSchemaVersion: 3,
      persistence: false,
      performanceOverlay: false,
      backend: "browser-gamepad",
    });
    const json = JSON.stringify(exported);
    expect(exported.configuration.diagnostics_persistence).toBe(false);
    expect(exported.measurement_notes.excluded).toContain("network");
    expect(json).not.toContain("https://");
    expect(json).not.toContain("abc");
  });

  it("rejects oversized or raw-shaped diagnostic samples", () => {
    expect(isDiagnosticsSample({
      input_events: 1,
      batches: 1,
      batch_events: 1,
      dropped_events: 0,
      mapping_durations_ms: [0.5],
      pipeline_estimates_ms: [1],
      key: "Space",
    })).toBe(false);
    expect(isDiagnosticsSample({
      input_events: 1,
      batches: 1,
      batch_events: 1,
      dropped_events: 0,
      mapping_durations_ms: Array.from({ length: 33 }, () => 1),
      pipeline_estimates_ms: [],
    })).toBe(false);
  });

  it("resets counters while preserving an active session boundary", () => {
    let now = 5;
    const collector = new DiagnosticsCollector(() => now);
    collector.startCapture();
    now = 100;
    collector.recordBridgeReconnect();
    collector.recordProfileSwitch();
    collector.stopCapture("main_watchdog_timeout");
    expect(collector.snapshot().stop_reasons.main_watchdog_timeout).toBe(1);
    collector.reset();
    expect(collector.snapshot()).toMatchObject({
      totals: { bridge_reconnects: 0, profile_switches: 0, dropped_events: 0 },
      stop_reasons: {},
      recent_failures: [],
    });
  });

  it("uses a bounded rolling window for displayed event and batch rates", () => {
    let now = 0;
    const collector = new DiagnosticsCollector(() => now);
    collector.startCapture();
    for (let index = 0; index < 100; index += 1) {
      now += 1_000;
      collector.addSample({
        input_events: index < 40 ? 100 : 1,
        batches: 1,
        batch_events: 1,
        dropped_events: 0,
        mapping_durations_ms: [],
        pipeline_estimates_ms: [],
      });
    }
    expect(collector.snapshot().rates).toEqual({
      input_events_hz: 1,
      batches_hz: 1,
      average_batch_size: 1,
    });
  });
});
