export const DIAGNOSTICS_SCHEMA_VERSION = 1;
export const DIAGNOSTICS_PERSIST_STORAGE_KEY = "xib.diagnostics_persist";
export const DIAGNOSTICS_SNAPSHOT_STORAGE_KEY = "xib.diagnostics_snapshot";
export const PERFORMANCE_OVERLAY_STORAGE_KEY = "xib.performance_overlay";

const HISTOGRAM_BOUNDS_MS = [0.1, 0.25, 0.5, 1, 2, 4, 8, 16, 33, 100] as const;
const MAX_FAILURES = 24;
const MAX_REASON_KINDS = 32;
const MAX_RATE_SAMPLES = 60;

export type DiagnosticFailureCategory =
  | "bridge"
  | "capture"
  | "profile"
  | "protocol"
  | "runtime"
  | "storage"
  | "watchdog";

export interface DurationAggregate {
  count: number;
  sum_ms: number;
  min_ms: number | null;
  max_ms: number | null;
  histogram: number[];
}

export interface DiagnosticsSample {
  input_events: number;
  batches: number;
  batch_events: number;
  dropped_events: number;
  mapping_durations_ms: number[];
  pipeline_estimates_ms: number[];
}

export interface DiagnosticsFailure {
  category: DiagnosticFailureCategory;
  code: string;
  count: number;
  last_seen_at: string;
}

export interface DiagnosticsSnapshot {
  schema_version: typeof DIAGNOSTICS_SCHEMA_VERSION;
  generated_at: string;
  capture: {
    active: boolean;
    uptime_ms: number;
    sessions: number;
  };
  totals: {
    input_events: number;
    batches: number;
    batch_events: number;
    dropped_events: number;
    bridge_reconnects: number;
    profile_switches: number;
  };
  rates: {
    input_events_hz: number;
    batches_hz: number;
    average_batch_size: number;
  };
  durations: {
    mapping_processing_ms: DurationAggregate;
    extension_pipeline_estimate_ms: DurationAggregate;
  };
  stop_reasons: Record<string, number>;
  recent_failures: DiagnosticsFailure[];
}

export interface DiagnosticsExport {
  product: "Xbox Input Bridge";
  extension_version: string;
  protocol_version: number;
  profile_schema_version: number;
  diagnostics: DiagnosticsSnapshot;
  configuration: {
    diagnostics_persistence: boolean;
    performance_overlay: boolean;
    backend: string | null;
  };
  measurement_notes: {
    mapping_processing_ms: "measured in the MAIN world with performance.now()";
    extension_pipeline_estimate_ms: "estimated round trip in the isolated world; includes bridge scheduling";
    excluded: "network and game-stream latency are not measured";
  };
}

function emptyDuration(): DurationAggregate {
  return {
    count: 0,
    sum_ms: 0,
    min_ms: null,
    max_ms: null,
    histogram: Array.from({ length: HISTOGRAM_BOUNDS_MS.length + 1 }, () => 0),
  };
}

function finiteCount(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

function boundedCode(value: string): string {
  if (/https?:|[?&=]|(?:auth|session|account)[_-]?token|cookie|authorization|secret/i.test(value)) {
    return "redacted_failure";
  }
  return value.toLowerCase().replace(/[^a-z0-9_-]/g, "_").slice(0, 64) || "unknown";
}

function cloneDuration(value: DurationAggregate): DurationAggregate {
  return { ...value, histogram: [...value.histogram] };
}

export class DiagnosticsCollector {
  private inputEvents = 0;
  private batches = 0;
  private batchEvents = 0;
  private droppedEvents = 0;
  private bridgeReconnects = 0;
  private profileSwitches = 0;
  private sessions = 0;
  private captureStartedAt: number | null = null;
  private completedUptimeMs = 0;
  private mappingDuration = emptyDuration();
  private pipelineEstimate = emptyDuration();
  private stopReasons = new Map<string, number>();
  private failures = new Map<string, DiagnosticsFailure>();
  private rateSamples: Pick<DiagnosticsSample, "input_events" | "batches" | "batch_events">[] = [];
  private restoredRates = { input_events_hz: 0, batches_hz: 0, average_batch_size: 0 };

  constructor(
    private readonly now: () => number = () => performance.now(),
    private readonly wallClock: () => Date = () => new Date(),
  ) {}

  startCapture(): void {
    if (this.captureStartedAt !== null) return;
    this.captureStartedAt = this.now();
    this.sessions += 1;
  }

  stopCapture(reason: string): void {
    if (this.captureStartedAt !== null) {
      this.completedUptimeMs += Math.max(0, this.now() - this.captureStartedAt);
      this.captureStartedAt = null;
    }
    this.incrementBounded(this.stopReasons, boundedCode(reason));
  }

  addSample(sample: DiagnosticsSample): void {
    this.inputEvents += finiteCount(sample.input_events);
    this.batches += finiteCount(sample.batches);
    this.batchEvents += finiteCount(sample.batch_events);
    this.droppedEvents += finiteCount(sample.dropped_events);
    this.rateSamples.push({
      input_events: finiteCount(sample.input_events),
      batches: finiteCount(sample.batches),
      batch_events: finiteCount(sample.batch_events),
    });
    if (this.rateSamples.length > MAX_RATE_SAMPLES) this.rateSamples.shift();
    for (const value of sample.mapping_durations_ms.slice(0, 32)) {
      this.recordDuration(this.mappingDuration, value);
    }
    for (const value of sample.pipeline_estimates_ms.slice(0, 32)) {
      this.recordDuration(this.pipelineEstimate, value);
    }
  }

  recordBridgeReconnect(): void {
    this.bridgeReconnects += 1;
  }

  recordProfileSwitch(): void {
    this.profileSwitches += 1;
  }

  recordFailure(category: DiagnosticFailureCategory, code: string): void {
    const normalized = boundedCode(code);
    const key = `${category}:${normalized}`;
    const existing = this.failures.get(key);
    if (existing) {
      existing.count += 1;
      existing.last_seen_at = this.wallClock().toISOString();
      return;
    }
    if (this.failures.size >= MAX_FAILURES) {
      const oldest = this.failures.keys().next().value as string | undefined;
      if (oldest) this.failures.delete(oldest);
    }
    this.failures.set(key, {
      category,
      code: normalized,
      count: 1,
      last_seen_at: this.wallClock().toISOString(),
    });
  }

  snapshot(): DiagnosticsSnapshot {
    const uptime = this.completedUptimeMs +
      (this.captureStartedAt === null ? 0 : Math.max(0, this.now() - this.captureStartedAt));
    const recent = this.rateSamples.reduce(
      (total, sample) => ({
        input_events: total.input_events + sample.input_events,
        batches: total.batches + sample.batches,
        batch_events: total.batch_events + sample.batch_events,
      }),
      { input_events: 0, batches: 0, batch_events: 0 },
    );
    const seconds = this.rateSamples.length > 0 ? Math.min(uptime / 1000, MAX_RATE_SAMPLES) : 0;
    return {
      schema_version: DIAGNOSTICS_SCHEMA_VERSION,
      generated_at: this.wallClock().toISOString(),
      capture: {
        active: this.captureStartedAt !== null,
        uptime_ms: round(uptime),
        sessions: this.sessions,
      },
      totals: {
        input_events: this.inputEvents,
        batches: this.batches,
        batch_events: this.batchEvents,
        dropped_events: this.droppedEvents,
        bridge_reconnects: this.bridgeReconnects,
        profile_switches: this.profileSwitches,
      },
      rates: {
        input_events_hz: this.rateSamples.length > 0
          ? round(seconds > 0 ? recent.input_events / seconds : 0)
          : this.restoredRates.input_events_hz,
        batches_hz: this.rateSamples.length > 0
          ? round(seconds > 0 ? recent.batches / seconds : 0)
          : this.restoredRates.batches_hz,
        average_batch_size: this.rateSamples.length > 0
          ? round(recent.batches > 0 ? recent.batch_events / recent.batches : 0)
          : this.restoredRates.average_batch_size,
      },
      durations: {
        mapping_processing_ms: cloneDuration(this.mappingDuration),
        extension_pipeline_estimate_ms: cloneDuration(this.pipelineEstimate),
      },
      stop_reasons: Object.fromEntries(this.stopReasons),
      recent_failures: [...this.failures.values()].map((failure) => ({ ...failure })),
    };
  }

  reset(): void {
    this.inputEvents = 0;
    this.batches = 0;
    this.batchEvents = 0;
    this.droppedEvents = 0;
    this.bridgeReconnects = 0;
    this.profileSwitches = 0;
    this.sessions = this.captureStartedAt === null ? 0 : 1;
    this.completedUptimeMs = 0;
    this.captureStartedAt = this.captureStartedAt === null ? null : this.now();
    this.mappingDuration = emptyDuration();
    this.pipelineEstimate = emptyDuration();
    this.stopReasons.clear();
    this.failures.clear();
    this.rateSamples = [];
    this.restoredRates = { input_events_hz: 0, batches_hz: 0, average_batch_size: 0 };
  }

  restore(snapshot: unknown): boolean {
    if (!isDiagnosticsSnapshot(snapshot)) return false;
    this.inputEvents = snapshot.totals.input_events;
    this.batches = snapshot.totals.batches;
    this.batchEvents = snapshot.totals.batch_events;
    this.droppedEvents = snapshot.totals.dropped_events;
    this.bridgeReconnects = snapshot.totals.bridge_reconnects;
    this.profileSwitches = snapshot.totals.profile_switches;
    this.sessions = snapshot.capture.sessions;
    this.completedUptimeMs = snapshot.capture.uptime_ms;
    this.captureStartedAt = null;
    this.mappingDuration = cloneDuration(snapshot.durations.mapping_processing_ms);
    this.pipelineEstimate = cloneDuration(snapshot.durations.extension_pipeline_estimate_ms);
    this.stopReasons = new Map(Object.entries(snapshot.stop_reasons));
    this.failures = new Map(snapshot.recent_failures.map((failure) => [
      `${failure.category}:${failure.code}`,
      { ...failure },
    ]));
    this.rateSamples = [];
    this.restoredRates = { ...snapshot.rates };
    return true;
  }

  private recordDuration(aggregate: DurationAggregate, value: number): void {
    if (!Number.isFinite(value) || value < 0 || value > 60_000) return;
    aggregate.count += 1;
    aggregate.sum_ms = round(aggregate.sum_ms + value);
    aggregate.min_ms = aggregate.min_ms === null ? value : Math.min(aggregate.min_ms, value);
    aggregate.max_ms = aggregate.max_ms === null ? value : Math.max(aggregate.max_ms, value);
    const bucket = HISTOGRAM_BOUNDS_MS.findIndex((bound) => value <= bound);
    const index = bucket < 0 ? HISTOGRAM_BOUNDS_MS.length : bucket;
    aggregate.histogram[index] = (aggregate.histogram[index] ?? 0) + 1;
  }

  private incrementBounded(target: Map<string, number>, key: string): void {
    if (!target.has(key) && target.size >= MAX_REASON_KINDS) key = "other";
    target.set(key, (target.get(key) ?? 0) + 1);
  }
}

export function buildDiagnosticsExport(
  snapshot: DiagnosticsSnapshot,
  config: {
    extensionVersion: string;
    protocolVersion: number;
    profileSchemaVersion: number;
    persistence: boolean;
    performanceOverlay: boolean;
    backend: string | null;
  },
): DiagnosticsExport {
  return {
    product: "Xbox Input Bridge",
    extension_version: boundedCode(config.extensionVersion).replaceAll("_", "."),
    protocol_version: config.protocolVersion,
    profile_schema_version: config.profileSchemaVersion,
    diagnostics: structuredClone(snapshot),
    configuration: {
      diagnostics_persistence: config.persistence,
      performance_overlay: config.performanceOverlay,
      backend: config.backend ? boundedCode(config.backend) : null,
    },
    measurement_notes: {
      mapping_processing_ms: "measured in the MAIN world with performance.now()",
      extension_pipeline_estimate_ms: "estimated round trip in the isolated world; includes bridge scheduling",
      excluded: "network and game-stream latency are not measured",
    },
  };
}

export function isDiagnosticsSample(value: unknown): value is DiagnosticsSample {
  if (!isRecord(value) || !hasExactKeys(value, [
    "input_events", "batches", "batch_events", "dropped_events",
    "mapping_durations_ms", "pipeline_estimates_ms",
  ])) return false;
  return ["input_events", "batches", "batch_events", "dropped_events"].every(
    (key) => Number.isSafeInteger(value[key]) && Number(value[key]) >= 0 && Number(value[key]) <= 1_000_000,
  ) &&
    isDurationArray(value.mapping_durations_ms) &&
    isDurationArray(value.pipeline_estimates_ms);
}

export function isDiagnosticsSnapshot(value: unknown): value is DiagnosticsSnapshot {
  if (!isRecord(value) || value.schema_version !== DIAGNOSTICS_SCHEMA_VERSION) return false;
  if (!isRecord(value.capture) || !isRecord(value.totals) || !isRecord(value.rates) ||
    !isRecord(value.durations) || !isRecord(value.stop_reasons) ||
    !Array.isArray(value.recent_failures)) return false;
  if (!hasExactKeys(value, [
    "schema_version", "generated_at", "capture", "totals", "rates", "durations",
    "stop_reasons", "recent_failures",
  ]) || typeof value.generated_at !== "string" || value.generated_at.length > 40) return false;
  if (!hasExactKeys(value.capture, ["active", "uptime_ms", "sessions"]) ||
    typeof value.capture.active !== "boolean" ||
    !isNonnegativeNumber(value.capture.uptime_ms) ||
    !isNonnegativeInteger(value.capture.sessions)) return false;
  if (!hasExactKeys(value.totals, [
    "input_events", "batches", "batch_events", "dropped_events",
    "bridge_reconnects", "profile_switches",
  ]) || !Object.values(value.totals).every(isNonnegativeInteger)) return false;
  if (!hasExactKeys(value.rates, ["input_events_hz", "batches_hz", "average_batch_size"]) ||
    !Object.values(value.rates).every(isNonnegativeNumber)) return false;
  if (!hasExactKeys(value.durations, [
    "mapping_processing_ms", "extension_pipeline_estimate_ms",
  ]) || !isDurationAggregate(value.durations.mapping_processing_ms) ||
    !isDurationAggregate(value.durations.extension_pipeline_estimate_ms)) return false;
  if (!Object.entries(value.stop_reasons).every(([reason, count]) =>
    /^[a-z0-9_-]{1,64}$/.test(reason) && isNonnegativeInteger(count))) return false;
  if (!value.recent_failures.every(isDiagnosticsFailure)) return false;
  const serialized = JSON.stringify(value);
  return serialized.length <= 64_000 &&
    value.recent_failures.length <= MAX_FAILURES &&
    Object.keys(value.stop_reasons).length <= MAX_REASON_KINDS;
}

function isDurationArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.length <= 32 &&
    value.every((entry) => typeof entry === "number" && Number.isFinite(entry) &&
      entry >= 0 && entry <= 60_000);
}

function isDurationAggregate(value: unknown): value is DurationAggregate {
  return isRecord(value) &&
    hasExactKeys(value, ["count", "sum_ms", "min_ms", "max_ms", "histogram"]) &&
    isNonnegativeInteger(value.count) &&
    isNonnegativeNumber(value.sum_ms) &&
    (value.min_ms === null || isNonnegativeNumber(value.min_ms)) &&
    (value.max_ms === null || isNonnegativeNumber(value.max_ms)) &&
    Array.isArray(value.histogram) &&
    value.histogram.length === HISTOGRAM_BOUNDS_MS.length + 1 &&
    value.histogram.every(isNonnegativeInteger);
}

function isDiagnosticsFailure(value: unknown): value is DiagnosticsFailure {
  return isRecord(value) &&
    hasExactKeys(value, ["category", "code", "count", "last_seen_at"]) &&
    ["bridge", "capture", "profile", "protocol", "runtime", "storage", "watchdog"]
      .includes(String(value.category)) &&
    typeof value.code === "string" && /^[a-z0-9_-]{1,64}$/.test(value.code) &&
    isNonnegativeInteger(value.count) &&
    typeof value.last_seen_at === "string" && value.last_seen_at.length <= 40;
}

function isNonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isNonnegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
