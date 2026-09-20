import { openInCommon, type CaseDescriptor } from "../src/coordinator/cases";
export function caseSummary(caseDescriptor: CaseDescriptor): string { const common = openInCommon(caseDescriptor); return `${caseDescriptor.caseId} → Common (${common.contextKey}) · training is fixed`; }
