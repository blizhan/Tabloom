import { ReadonlyQueryService } from "./query-service";
import type { QueryDefinition, TableStats, TableSchema } from "./types";

export interface CatalogEntry { readonly tableId: string; readonly schema: readonly TableSchema[]; readonly stats: TableStats; }

/** Schema/statistics are computed from the same query result that the user can
 * preview, so the catalog cannot silently inspect a different version. */
export class CatalogService {
  constructor(private readonly queries: ReadonlyQueryService) {}
  inspect(definition: QueryDefinition, tableId = definition.sourceSnapshotId): Promise<CatalogEntry> { return this.queries.inspect(definition, tableId).then((entry) => ({ tableId, ...entry })); }
}
