import { RuntimeError } from "./errors";
import { TabPFN35Adapter, type TabPFN35AdapterOptions } from "./tabpfn35/adapter";
import { TabICLv2CaseAdapter, type TabICLCaseOptions } from "./tabiclv2/adapter";
import type { TabularModelAdapter } from "./types";
export function createModelAdapter(kind: "tabpfn-3.5", options?: TabPFN35AdapterOptions): TabularModelAdapter;
export function createModelAdapter(kind: "tabicl-v2", options: TabICLCaseOptions): TabularModelAdapter;
export function createModelAdapter(kind: string, options?: TabPFN35AdapterOptions | TabICLCaseOptions): TabularModelAdapter { if (kind === "tabpfn-3.5") return new TabPFN35Adapter(options as TabPFN35AdapterOptions); if (kind === "tabicl-v2") return new TabICLv2CaseAdapter(options as TabICLCaseOptions); throw new RuntimeError("UNSUPPORTED_CAPABILITY", `Unsupported model: ${kind}`); }
