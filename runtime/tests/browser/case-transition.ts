import { createCaseDescriptor, openInCommon } from "../../src/coordinator/cases";
export function caseTransitionSmoke() { const descriptor = createCaseDescriptor({ caseId: "case", inputSnapshotId: "input", modelId: "tabicl-v2", artifactDigest: "a".repeat(64), contextKey: "ctx" }); return openInCommon(descriptor); }
