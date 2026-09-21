import type { CapabilityEvidence } from "../src/workbench/types";

export function renderCapabilities(entries: readonly CapabilityEvidence[]): string {
  return `<div class="capability-status" aria-label="运行能力">${entries.map((entry) => {
    const checking = entry.checkedAt === "checking";
    const state = checking ? "checking" : entry.supported ? "supported" : "unsupported";
    const label = checking ? "检测中" : entry.supported ? "可用" : "不可用";
    const title = entry.reason ? ` title="${escapeHtml(entry.reason)}"` : "";
    return `<span class="capability-status-item ${state}"${title}><span class="capability-dot" aria-hidden="true"></span><span>${escapeHtml(entry.name)}</span><small>${label}</small></span>`;
  }).join("")}</div>`;
}

function escapeHtml(value: string): string { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;"); }
