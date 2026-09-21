import { bootstrapWorkbenchData } from "../../src/workbench/bootstrap";
import type { DuckDbExecutor } from "../../src/data/duckdb-service";

export interface WorkbenchBootstrapReport { readonly ready: boolean; readonly querySupported: boolean; readonly joinedRows: number; readonly parameterizedRows: number; readonly mutationRejected: boolean; readonly externalRejected: boolean; }
export async function runWorkbenchBootstrap(executor: DuckDbExecutor): Promise<WorkbenchBootstrapReport> {
  const bootstrap = await bootstrapWorkbenchData(executor);
  try {
    await bootstrap.db.exec("CREATE TABLE workbench_bootstrap_values (id INTEGER, group_name VARCHAR, value DOUBLE)");
    await bootstrap.db.exec("INSERT INTO workbench_bootstrap_values VALUES (1, 'a', 1.5), (2, 'a', 2.5), (3, 'b', 4.0), (4, 'b', NULL)");
    await bootstrap.db.exec("CREATE TABLE workbench_bootstrap_labels (id INTEGER, label VARCHAR)");
    await bootstrap.db.exec("INSERT INTO workbench_bootstrap_labels VALUES (1, 'one'), (2, 'two'), (3, 'three'), (4, 'four')");
    const result = await bootstrap.queries.execute({ sql: "WITH joined AS (SELECT v.id, v.group_name, v.value, l.label FROM workbench_bootstrap_values v JOIN workbench_bootstrap_labels l ON l.id = v.id) SELECT group_name, count(*) AS rows, sum(value) AS total FROM joined GROUP BY group_name ORDER BY group_name", sourceSnapshotId: "bootstrap", revision: 1 });
    const parameterized = await bootstrap.queries.execute({ sql: "SELECT id, value FROM workbench_bootstrap_values WHERE id > ? ORDER BY id", parameters: [1], sourceSnapshotId: "bootstrap", revision: 2 });
    const ready = await bootstrap.queries.execute({ sql: "SELECT 1 AS ready", sourceSnapshotId: "bootstrap", revision: 3 });
    let mutationRejected = false; let externalRejected = false;
    try { await bootstrap.queries.execute({ sql: "DELETE FROM workbench_bootstrap_values", sourceSnapshotId: "bootstrap", revision: 4 }); } catch { mutationRejected = true; }
    try { await bootstrap.queries.execute({ sql: "SELECT * FROM read_csv_auto('not-registered.csv')", sourceSnapshotId: "bootstrap", revision: 5 }); } catch { externalRejected = true; }
    if (!mutationRejected || !externalRejected) throw new Error("Readonly bootstrap accepted a forbidden operation");
    return { ready: Number(ready.result.rows[0]?.ready) === 1, querySupported: result.rowCount === 2 && parameterized.rowCount === 3, joinedRows: result.rowCount, parameterizedRows: parameterized.rowCount, mutationRejected, externalRejected };
  }
  finally { await bootstrap.db.close(); }
}
