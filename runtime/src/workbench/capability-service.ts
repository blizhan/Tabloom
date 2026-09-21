import { RuntimeError } from "../model/errors";
import type { ModelCapabilities } from "../model/types";
import type { DuckDbFileEvidence } from "./duckdb-file-source";
import type { CapabilityEvidence } from "./types";

export interface WorkbenchCapabilities { readonly dataFormats: Readonly<Record<string, CapabilityEvidence>>; readonly duckdbFile: Readonly<Record<string, DuckDbFileEvidence>>; readonly model: ModelCapabilities & { readonly provider: string; readonly precision: string }; }

export class CapabilityService {
  private readonly entries = new Map<string, CapabilityEvidence>();
  register(entry: CapabilityEvidence): void { this.entries.set(entry.name, { ...entry }); }
  registerMany(entries: readonly CapabilityEvidence[]): void { for (const entry of entries) this.register(entry); }
  get(name: string): CapabilityEvidence | undefined { const value = this.entries.get(name); return value ? { ...value } : undefined; }
  all(): readonly CapabilityEvidence[] { return [...this.entries.values()].map((value) => ({ ...value })); }
  requireSupported(name: string): CapabilityEvidence { const value = this.entries.get(name); if (!value || !value.supported) throw new RuntimeError("UNSUPPORTED_CAPABILITY", value?.reason ?? `Capability ${name} is not supported`); return { ...value }; }
}

export function capabilityEvidence(name: string, supported: boolean, reason?: string): CapabilityEvidence { return { name, supported, reason, checkedAt: new Date().toISOString() }; }
