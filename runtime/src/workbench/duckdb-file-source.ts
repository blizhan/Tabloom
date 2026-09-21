import { RuntimeError } from "../model/errors";
import { sha256Hex } from "../model/identity";
import type { DuckDbResult } from "../data/duckdb-service";

export type DuckDbFileOperation = "open" | "attach" | "read" | "write";
export type DuckDbFileStatus = "supported" | "constrained" | "unsupported";
export interface DuckDbFileEvidence { readonly operation: DuckDbFileOperation; readonly status: DuckDbFileStatus; readonly reason: string; readonly checkedAt: string; readonly runtime?: string; }
export interface DuckDbFileAdapter { open(bytes: Uint8Array): Promise<void>; attach?(bytes: Uint8Array, alias: string): Promise<void>; query?(sql: string): Promise<DuckDbResult>; write?(sql: string): Promise<void>; close?(): Promise<void>; }
export interface DuckDbFileSourceOptions { readonly adapter?: DuckDbFileAdapter; readonly evidence?: readonly DuckDbFileEvidence[]; }

/** An isolated copy of a DuckDB file. The default path is deliberately
 * read-only/unsupported until a browser probe supplies evidence. */
export class DuckDbFileSource {
  private readonly adapter?: DuckDbFileAdapter;
  private original?: Uint8Array;
  private opened = false;
  constructor(options: DuckDbFileSourceOptions = {}) { this.adapter = options.adapter; this.evidence = options.evidence ?? []; }
  readonly evidence: readonly DuckDbFileEvidence[];
  async open(bytes: Uint8Array): Promise<void> { if (!(bytes instanceof Uint8Array) || !bytes.byteLength) throw new RuntimeError("INVALID_FORMAT", "DuckDB file is empty"); this.original = new Uint8Array(bytes); if (!this.adapter) throw new RuntimeError("UNSUPPORTED_CAPABILITY", "DuckDB file open has no verified browser adapter"); await this.adapter.open(new Uint8Array(bytes)); this.opened = true; }
  async attach(alias: string): Promise<void> { this.requireOpen(); if (!this.adapter?.attach || !this.original) throw new RuntimeError("UNSUPPORTED_CAPABILITY", "DuckDB file attach is not verified"); await this.adapter.attach(new Uint8Array(this.original), alias); }
  async query(sql: string): Promise<DuckDbResult> { this.requireOpen(); if (!this.adapter?.query) throw new RuntimeError("UNSUPPORTED_CAPABILITY", "DuckDB file read is not verified"); return this.adapter.query(sql); }
  async write(sql: string): Promise<void> { this.requireOpen(); if (!this.adapter?.write) throw new RuntimeError("UNSUPPORTED_CAPABILITY", "DuckDB file write is not verified and original files are never modified"); await this.adapter.write(sql); }
  async close(): Promise<void> { await this.adapter?.close?.(); this.opened = false; this.original = undefined; }
  async originalHash(): Promise<string> { if (!this.original) throw new RuntimeError("INVALID_DATA", "No DuckDB file is open"); return sha256Hex(this.original); }
  private requireOpen(): void { if (!this.opened) throw new RuntimeError("INVALID_DATA", "DuckDB file is not open"); }
}
