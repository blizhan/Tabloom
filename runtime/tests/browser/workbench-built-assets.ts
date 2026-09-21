export interface BuiltAssetEvidence { readonly path: string; readonly status: number; readonly contentType: string; readonly isSpaFallback: boolean; }
export function assertBinaryAsset(evidence: BuiltAssetEvidence): void { if (evidence.status !== 200 || evidence.isSpaFallback || /text\/html/i.test(evidence.contentType)) throw new Error(`Asset ${evidence.path} is missing or served as SPA HTML`); }
