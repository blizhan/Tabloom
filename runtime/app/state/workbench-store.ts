import type { WorkbenchPrecision, WorkbenchProvider } from "../../src/storage/workbench-experiment-store";

export interface WorkbenchUiState { readonly tableName?: string; readonly rowCount: number; readonly status: string; readonly provider: WorkbenchProvider; readonly precision: WorkbenchPrecision; readonly busy: boolean; }
export class WorkbenchStore {
  private state: WorkbenchUiState = { rowCount: 0, status: "准备就绪", provider: "wasm", precision: "fp32", busy: false };
  private readonly listeners = new Set<(state: WorkbenchUiState) => void>();
  get snapshot(): WorkbenchUiState { return { ...this.state }; }
  subscribe(listener: (state: WorkbenchUiState) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  patch(update: Partial<WorkbenchUiState>): void { this.state = { ...this.state, ...update }; for (const listener of this.listeners) listener(this.snapshot); }
}
