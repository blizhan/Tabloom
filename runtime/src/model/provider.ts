import type { ExecutionProvider } from "./types";

/** Primitive adapter details safe to include in diagnostics. WebGPU objects
 * themselves remain owned by the browser/model worker. */
export interface WebGpuAdapterInfo {
  readonly vendor: string;
  readonly architecture: string;
  readonly device: string;
  readonly description: string;
  readonly isFallbackAdapter: boolean | null;
}

export interface WebGpuProbe {
  readonly provider: Extract<ExecutionProvider, "webgpu">;
  readonly available: boolean;
  readonly reason?: string;
  readonly adapterInfo?: WebGpuAdapterInfo;
}

interface GpuAdapterLike {
  readonly info?: {
    readonly vendor?: unknown;
    readonly architecture?: unknown;
    readonly device?: unknown;
    readonly description?: unknown;
    readonly isFallbackAdapter?: unknown;
  };
}

interface GpuLike {
  requestAdapter?: (options?: unknown) => Promise<GpuAdapterLike | null>;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function adapterInfo(adapter: GpuAdapterLike): WebGpuAdapterInfo {
  const info = adapter.info;
  return {
    vendor: text(info?.vendor),
    architecture: text(info?.architecture),
    device: text(info?.device),
    description: text(info?.description),
    isFallbackAdapter: typeof info?.isFallbackAdapter === "boolean" ? info.isFallbackAdapter : null,
  };
}

/**
 * Chromium can expose `navigator.gpu` while returning no adapter, and can
 * expose a software adapter when the hardware driver is missing. Treat both
 * cases as unavailable so an explicit WebGPU request cannot silently become a
 * software or WASM run. Chromium's Google vendor is also the software
 * fallback in the supported browser baseline. Unknown adapter strings remain
 * observable rather than being rejected solely for lacking vendor metadata.
 */
export function classifyWebGpuAdapter(adapter: GpuAdapterLike | null | undefined): WebGpuProbe {
  if (!adapter) return { provider: "webgpu", available: false, reason: "navigator.gpu.requestAdapter() returned no adapter" };
  const info = adapterInfo(adapter);
  const descriptor = [info.vendor, info.architecture, info.device, info.description].join(" ").toLowerCase();
  if (info.isFallbackAdapter === true || info.vendor.toLowerCase() === "google" || /swiftshader|llvmpipe|lavapipe|software rasterizer|software adapter/.test(descriptor)) {
    return { provider: "webgpu", available: false, reason: "WebGPU adapter is a software fallback", adapterInfo: info };
  }
  return { provider: "webgpu", available: true, adapterInfo: info };
}

export async function probeWebGpuAdapter(): Promise<WebGpuProbe> {
  if (typeof navigator === "undefined") return { provider: "webgpu", available: false, reason: "navigator is unavailable" };
  const gpu = (navigator as Navigator & { gpu?: GpuLike }).gpu;
  if (!gpu || typeof gpu.requestAdapter !== "function") return { provider: "webgpu", available: false, reason: "navigator.gpu.requestAdapter() is unavailable" };
  try {
    return classifyWebGpuAdapter(await gpu.requestAdapter({ powerPreference: "high-performance" }));
  } catch (error) {
    return { provider: "webgpu", available: false, reason: `navigator.gpu.requestAdapter() failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function webGpuAvailable(): Promise<boolean> {
  return (await probeWebGpuAdapter()).available;
}
