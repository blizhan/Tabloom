import type { RuntimeCoordinator } from "../src/coordinator/runtime-coordinator";
export function scenarioStatus(coordinator: RuntimeCoordinator, streamId: string): { current: number; history: number } { return { current: coordinator.current(streamId).length, history: coordinator.history(streamId).length }; }
