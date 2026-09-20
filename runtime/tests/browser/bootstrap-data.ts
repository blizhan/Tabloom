import { tableFromArrays } from "apache-arrow";
import { DuckDbService, type DuckDbExecutor } from "../../src/data/duckdb-service";
import { materializeDataset } from "../../src/data/arrow-dataset";

export interface BootstrapDataReport {
  readonly status: "supported";
  readonly queryRows: number;
  readonly nullableRows: number;
  readonly arrowRows: number;
  readonly slicedRows: number;
  readonly rollbackRows: number;
  readonly transactionRolledBack: boolean;
  readonly typedParametersBound: boolean;
  readonly complexParameterLexing: boolean;
}

/**
 * Exercise the real data boundary, rather than only checking that a DuckDB
 * package can be imported.  The executor is injected so the same assertions
 * can run against a deterministic fake in unit tests and against the
 * DuckDB-WASM worker in the browser harness.
 */
export async function bootstrapData(executor: DuckDbExecutor): Promise<BootstrapDataReport> {
  const service = new DuckDbService(executor);
  try {
    await service.exec("CREATE TABLE bootstrap_values (id INTEGER, value DOUBLE)");
    await service.exec("INSERT INTO bootstrap_values VALUES (1, 1.5), (2, NULL), (3, 3.5)");
    await service.exec("INSERT INTO bootstrap_values VALUES (?, ?)", [4, 4.5]);
    const result = await service.query("SELECT id, value FROM bootstrap_values ORDER BY id");
    const nullableRows = result.rows.filter((row) => row.value === null).length;
    const typedQuery = async (label: string, sql: string, parameters: readonly unknown[]) => { try { return await service.query(sql, parameters); } catch (error) { throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`); } };
    const floatRow = (await typedQuery("float64", "SELECT typeof(?) AS type, ? + 1 AS sum, signbit(?) AS negative_zero", [17, 17, -0])).rows[0];
    const intRow = (await typedQuery("int64", "SELECT typeof(?) AS type, ? + 1 AS sum", [10n, 10n])).rows[0];
    const blobRow = (await typedQuery("bytes", "SELECT typeof(?) AS type, hex(?) AS hex", [new Uint8Array([0, 255]), new Uint8Array([0, 255])])).rows[0];
    const scalarRow = (await typedQuery("scalars", "SELECT ? AS bool_value, ? IS NULL AS null_value", [true, null])).rows[0];
    const typedParametersBound = floatRow?.type === "DOUBLE" && Number(floatRow.sum) === 18 && Boolean(floatRow.negative_zero) && intRow?.type === "BIGINT" && Number(intRow.sum) === 11 && blobRow?.type === "BLOB" && blobRow.hex === "00FF" && Boolean(scalarRow?.bool_value) && Boolean(scalarRow?.null_value);
    if (!typedParametersBound) throw new Error(`DuckDB typed parameter binding failed: ${JSON.stringify({ floatRow, intRow, blobRow, scalarRow }, (_key, value) => typeof value === "bigint" ? value.toString() : value)}`);
    const complexRow = (await typedQuery("complex lexer", "SELECT E'a\\' ? b' AS escaped, $$?$$ AS dollar, ? AS value /* outer ? /* inner ? */ still ? */", [1.5])).rows[0];
    const complexParameterLexing = complexRow?.escaped === "a' ? b" && complexRow?.dollar === "?" && Number(complexRow?.value) === 1.5;
    if (!complexParameterLexing) throw new Error(`DuckDB complex parameter lexing failed: ${JSON.stringify(complexRow)}`);
    await service.exec("CREATE TABLE bootstrap_typed (f DOUBLE, i BIGINT, b BLOB, flag BOOLEAN, n VARCHAR)");
    await service.exec("INSERT INTO bootstrap_typed VALUES (?, ?, ?, ?, ?)", [1.5, 10n, new Uint8Array([0, 255]), true, null]);
    const typedExec = await service.query("SELECT f, i, hex(b) AS b, flag, n FROM bootstrap_typed");
    if (Number(typedExec.rows[0]?.f) !== 1.5 || Number(typedExec.rows[0]?.i) !== 10 || typedExec.rows[0]?.b !== "00FF" || !Boolean(typedExec.rows[0]?.flag) || typedExec.rows[0]?.n !== null) throw new Error("DuckDB exec did not preserve typed parameters");

    // Register a genuine Arrow table through the optional executor capability.
    // This is intentionally separate from SQL text insertion: it catches
    // mismatched Arrow/DuckDB versions before product code depends on them.
    const arrowTable = tableFromArrays({ id: [10, 11, 12], value: [2.5, null, 4.5] });
    if (!executor.registerArrow) throw new Error("DuckDB executor does not expose Arrow registration");
    await executor.registerArrow(arrowTable, "bootstrap_arrow");
    const arrowResult = await service.query("SELECT id, value FROM bootstrap_arrow ORDER BY id");

    const dataset = materializeDataset({
      rowCount: 3,
      columns: [{ name: "value", chunks: [new Float64Array([1, 2]), new Float64Array([3])], validity: [1, 0, 1], type: "float64" }],
    });
    const sliced = materializeDataset({
      rowCount: 2,
      columns: [{ name: "value", values: new Float64Array([99, 4, 5, 6]), offset: 1, length: 2, type: "float64" }],
    });
    if (dataset.rowCount !== 3 || !Number.isNaN(dataset.columns[0][1])) throw new Error("Arrow null/chunk materialization failed");
    if (sliced.rowCount !== 2 || sliced.columns[0][0] !== 4 || sliced.columns[0][1] !== 5) throw new Error("Arrow slice materialization failed");

    try {
      await service.transaction(async (transaction) => { await transaction.exec("INSERT INTO bootstrap_values VALUES (99, 99.0)"); throw new Error("rollback probe"); });
    } catch (error) { if (!(error instanceof Error) || error.message !== "rollback probe") throw error; }
    const afterRollback = await service.query("SELECT count(*) AS count FROM bootstrap_values");
    const rollbackRows = Number(afterRollback.rows[0]?.count ?? -1);
    if (rollbackRows !== 4) throw new Error(`DuckDB transaction rollback failed: ${rollbackRows}`);
    return { status: "supported", queryRows: result.rows.length, nullableRows, arrowRows: arrowResult.rows.length, slicedRows: sliced.rowCount, rollbackRows, transactionRolledBack: true, typedParametersBound, complexParameterLexing };
  } finally {
    await service.close();
  }
}
