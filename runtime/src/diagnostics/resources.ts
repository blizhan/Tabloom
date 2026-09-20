/**
 * Browser memory APIs are deliberately incomplete.  Keep the values that the
 * runtime owns separate from host-wide measurements and represent an absent
 * signal as unavailable rather than as zero.  In particular, neither
 * `navigator.gpu` nor a downloaded model size is a GPU allocation measurement.
 */

export const RESOURCE_COUNTER_NAMES = [
  "ownedBytes",
  "hostCopyBytes",
  "readbackBytes",
  "digestBytes",
  "cacheBytes",
  "temporaryBytes",
] as const;

export type ResourceCounterName = (typeof RESOURCE_COUNTER_NAMES)[number];
export type ResourceSignalName = "jsHeapBytes" | "wasmBytes" | "gpuBytes";

export interface ResourceSignal {
  readonly value: number | null;
  readonly unavailableReason?: string;
}

export interface ResourceObservation {
  /** Non-owned browser signals. `null` means the browser did not expose it. */
  readonly jsHeapBytes: number | null;
  readonly wasmBytes: number | null;
  readonly gpuBytes: number | null;
  /** Counters reported by a runtime-owned ledger, never guessed from a signal. */
  readonly ownedBytes: number | null;
  readonly hostCopyBytes: number | null;
  readonly readbackBytes: number | null;
  readonly digestBytes: number | null;
  readonly cacheBytes: number | null;
  readonly temporaryBytes: number | null;
  /** Historical high-water marks, separate from current stage counters. */
  readonly peaks: Readonly<Record<ResourceCounterName, number | null>>;
  readonly signals: Readonly<Record<ResourceSignalName, ResourceSignal>>;
  readonly unavailable: readonly string[];
  readonly unavailableReasons: Readonly<Record<string, string>>;
  readonly stage: string;
  readonly capturedAt: string;
}

export interface ResourceObservationInput {
  /** Explicit signal values are useful when a browser-specific API is known. */
  readonly jsHeapBytes?: number | null;
  readonly wasmBytes?: number | null;
  readonly gpuBytes?: number | null;
  /** Values must be owned counters; omitted counters stay unavailable. */
  readonly ownedBytes?: number | null;
  readonly hostCopyBytes?: number | null;
  readonly readbackBytes?: number | null;
  readonly digestBytes?: number | null;
  readonly cacheBytes?: number | null;
  readonly temporaryBytes?: number | null;
  readonly counters?: Partial<Record<ResourceCounterName, number | null>>;
  readonly peaks?: Partial<Record<ResourceCounterName, number | null>>;
  /** Makes reports deterministic in tests without changing production defaults. */
  readonly capturedAt?: string;
}

export interface ResourceLedgerSnapshot {
  readonly counters: Readonly<Partial<Record<ResourceCounterName, number>>>;
  readonly peaks: Readonly<Partial<Record<ResourceCounterName, number>>>;
}

function validByteCount(value: number | null | undefined): number | null {
  return value !== null && value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function peakByteCount(current: number | null, supplied: number | null | undefined): number | null {
  const peak = validByteCount(supplied);
  if (current === null) return peak;
  return Math.max(current, peak ?? current);
}

function browserJsHeapBytes(): number | null {
  if (typeof performance === "undefined") return null;
  const memory = (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory;
  return validByteCount(memory?.usedJSHeapSize);
}

function explicitOrBrowser(value: number | null | undefined, browserValue: number | null): number | null {
  return value === undefined ? browserValue : validByteCount(value);
}

function signalReason(name: ResourceSignalName, value: number | null, explicitlyProvided: boolean): string | undefined {
  if (value !== null) return undefined;
  if (explicitlyProvided) return "provided value was not a non-negative safe integer";
  if (name === "jsHeapBytes") return typeof performance === "undefined" ? "performance.memory is unavailable" : "performance.memory.usedJSHeapSize is unavailable";
  if (name === "wasmBytes") return "WebAssembly allocation counters are not exposed by this browser";
  return "GPU allocation counters are not exposed by this browser";
}

/**
 * Capture resource information without turning unknown values into zero.
 * `input` is intentionally optional so existing callers can use browser
 * signals, while worker/model code can provide its own owned-byte counters.
 */
export function observeResources(stage: string, input: ResourceObservationInput = {}): ResourceObservation {
  const jsHeapBytes = explicitOrBrowser(input.jsHeapBytes, browserJsHeapBytes());
  const wasmBytes = validByteCount(input.wasmBytes);
  const gpuBytes = validByteCount(input.gpuBytes);
  const counters = { ...input.counters } as Partial<Record<ResourceCounterName, number | null>>;
  for (const name of RESOURCE_COUNTER_NAMES) {
    if (input[name] !== undefined) counters[name] = input[name] ?? null;
  }

  const values: Record<ResourceCounterName, number | null> = {
    ownedBytes: validByteCount(counters.ownedBytes),
    hostCopyBytes: validByteCount(counters.hostCopyBytes),
    readbackBytes: validByteCount(counters.readbackBytes),
    digestBytes: validByteCount(counters.digestBytes),
    cacheBytes: validByteCount(counters.cacheBytes),
    temporaryBytes: validByteCount(counters.temporaryBytes),
  };
  const peaks: Record<ResourceCounterName, number | null> = {
    ownedBytes: peakByteCount(values.ownedBytes, input.peaks?.ownedBytes),
    hostCopyBytes: peakByteCount(values.hostCopyBytes, input.peaks?.hostCopyBytes),
    readbackBytes: peakByteCount(values.readbackBytes, input.peaks?.readbackBytes),
    digestBytes: peakByteCount(values.digestBytes, input.peaks?.digestBytes),
    cacheBytes: peakByteCount(values.cacheBytes, input.peaks?.cacheBytes),
    temporaryBytes: peakByteCount(values.temporaryBytes, input.peaks?.temporaryBytes),
  };
  const unavailable: string[] = [];
  const unavailableReasons: Record<string, string> = {};
  const signals: Record<ResourceSignalName, ResourceSignal> = {
    jsHeapBytes: { value: jsHeapBytes },
    wasmBytes: { value: wasmBytes },
    gpuBytes: { value: gpuBytes },
  };
  for (const name of ["jsHeapBytes", "wasmBytes", "gpuBytes"] as const) {
    const reason = signalReason(name, signals[name].value, input[name] !== undefined);
    if (reason) {
      unavailable.push(name);
      unavailableReasons[name] = reason;
      signals[name] = { value: null, unavailableReason: reason };
    }
  }
  for (const name of RESOURCE_COUNTER_NAMES) {
    if (values[name] === null) {
      unavailable.push(name);
      unavailableReasons[name] = "runtime-owned counter was not supplied";
    }
  }
  return {
    jsHeapBytes,
    wasmBytes,
    gpuBytes,
    ...values,
    peaks,
    signals,
    unavailable,
    unavailableReasons,
    stage,
    capturedAt: input.capturedAt ?? new Date().toISOString(),
  };
}

/**
 * A small owned-resource ledger for model/session code.  A counter is known
 * only after it has been set or changed; this prevents an empty ledger from
 * being reported as an observed zero allocation.
 */
export class ResourceLedger {
  private readonly values = new Map<ResourceCounterName, number>();
  private readonly peakValues = new Map<ResourceCounterName, number>();

  set(name: ResourceCounterName, bytes: number): void {
    if (validByteCount(bytes) === null) throw new RangeError(`${name} must be a non-negative safe integer`);
    this.values.set(name, bytes);
    this.peakValues.set(name, Math.max(bytes, this.peakValues.get(name) ?? 0));
  }

  add(name: ResourceCounterName, bytes: number): number {
    if (validByteCount(bytes) === null) throw new RangeError(`${name} must be a non-negative safe integer`);
    const next = (this.values.get(name) ?? 0) + bytes;
    if (validByteCount(next) === null) throw new RangeError(`${name} exceeds safe byte range`);
    this.values.set(name, next);
    this.peakValues.set(name, Math.max(next, this.peakValues.get(name) ?? 0));
    return next;
  }

  release(name: ResourceCounterName, bytes: number): number {
    if (validByteCount(bytes) === null) throw new RangeError(`${name} must be a non-negative safe integer`);
    const current = this.values.get(name);
    if (current === undefined || bytes > current) throw new RangeError(`${name} release exceeds observed allocation`);
    const next = current - bytes;
    this.values.set(name, next);
    return next;
  }

  snapshot(): ResourceLedgerSnapshot {
    return {
      counters: Object.fromEntries(this.values) as Partial<Record<ResourceCounterName, number>>,
      peaks: Object.fromEntries(this.peakValues) as Partial<Record<ResourceCounterName, number>>,
    };
  }

  observe(stage: string, input: Omit<ResourceObservationInput, "counters"> = {}): ResourceObservation {
    const snapshot = this.snapshot();
    return observeResources(stage, { ...input, counters: snapshot.counters, peaks: snapshot.peaks });
  }
}
