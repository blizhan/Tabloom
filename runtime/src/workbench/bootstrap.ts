import { RuntimeError } from "../model/errors";
import { DuckDbService, type DuckDbExecutor } from "../data/duckdb-service";
import { ReadonlyQueryService } from "./query-service";

export interface WorkbenchDataBootstrap { readonly db: DuckDbService; readonly queries: ReadonlyQueryService; }
export async function bootstrapWorkbenchData(executor?: DuckDbExecutor): Promise<WorkbenchDataBootstrap> {
  if (!executor) throw new RuntimeError("UNSUPPORTED_CAPABILITY", "A real DuckDB executor is required for workbench data");
  const db = new DuckDbService(executor); await db.open();
  try { const probe = await db.query("SELECT 1 AS ready"); if (Number(probe.rows[0]?.ready) !== 1) throw new RuntimeError("RESULT_INVALID", "DuckDB bootstrap probe returned an invalid result"); return { db, queries: new ReadonlyQueryService(db) }; }
  catch (error) { await db.close(); throw error; }
}
