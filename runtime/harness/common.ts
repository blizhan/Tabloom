import { RuntimeCoordinator } from "../src/coordinator/runtime-coordinator";
export function renderCapabilities(coordinator: RuntimeCoordinator, root: HTMLElement): void { const capabilities = coordinator.capabilities(); root.textContent = `regression · context=${capabilities.canBuildContext ? "build" : "case-only"} · rows ${capabilities.trainRows.min}-${capabilities.trainRows.max}`; }
export async function runCommonExample(coordinator: RuntimeCoordinator): Promise<void> { await coordinator.load({ preferredProvider: "wasm" }); }
