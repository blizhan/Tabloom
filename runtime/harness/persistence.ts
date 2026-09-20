import type { RuntimeCoordinator } from "../src/coordinator/runtime-coordinator";
import type { ModelContext } from "../src/model/types";
export async function saveAndReport(coordinator: RuntimeCoordinator, context: ModelContext): Promise<string> { const result = await coordinator.saveContext(context); return result.persistent ? "saved" : `memory-only: ${result.warning ?? "storage unavailable"}`; }
