export interface PredictionPoint { mean: number; q25?: number; q75?: number; truth: number | null; label: string; xValue?: number; }
export interface PredictionScope { start: number; end: number; }

const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

/** Relabel points and put them into the order represented by the selected axis.
 * The input order remains the stable tie-breaker, so duplicate axis values keep
 * their Test-row order and missing values are shown at the end. */
export function relabelPredictionPoints(points: readonly PredictionPoint[], axisValues: readonly unknown[], axis: string): PredictionPoint[] {
  const relabeled = points.map((point, index) => ({ point: { ...point, label: axis ? String(axisValues[index] ?? "") : String(index + 1), xValue: axis ? numericAxisValue(axisValues[index]) : undefined }, index, axisValue: axisValues[index] }));
  if (!axis) return relabeled.map(({ point }) => point);
  return relabeled.sort((left, right) => compareAxisValues(left.axisValue, right.axisValue) || left.index - right.index).map(({ point }) => point);
}

function compareAxisValues(left: unknown, right: unknown): number {
  const leftMissing = isMissingAxisValue(left); const rightMissing = isMissingAxisValue(right);
  if (leftMissing || rightMissing) return leftMissing === rightMissing ? 0 : leftMissing ? 1 : -1;
  const leftNumeric = numericAxisValue(left); const rightNumeric = numericAxisValue(right);
  if (leftNumeric !== undefined && rightNumeric !== undefined) return leftNumeric - rightNumeric;
  const leftComparable = comparableAxisValue(left); const rightComparable = comparableAxisValue(right);
  if (typeof leftComparable === "number" && typeof rightComparable === "number") return leftComparable - rightComparable;
  const leftText = String(leftComparable); const rightText = String(rightComparable);
  return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
}

function isMissingAxisValue(value: unknown): boolean {
  return value == null || (typeof value === "number" && !Number.isFinite(value)) || (typeof value === "string" && value.trim() === "");
}

function comparableAxisValue(value: unknown): number | string {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const trimmed = value.trim(); const numeric = Number(trimmed);
    return trimmed && Number.isFinite(numeric) ? numeric : value;
  }
  return String(value);
}

function numericAxisValue(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    const trimmed = value.trim(); const numeric = Number(trimmed);
    if (trimmed && Number.isFinite(numeric)) return numeric;
    if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(trimmed)) {
      const timestamp = Date.parse(trimmed);
      if (Number.isFinite(timestamp)) return timestamp;
    }
  }
  return undefined;
}

function normalizeScope(scope: PredictionScope | undefined, total: number): PredictionScope {
  if (total <= 0) return { start: 0, end: 0 };
  const max = total - 1;
  const start = Math.max(0, Math.min(max, Number.isFinite(scope?.start) ? Math.round(scope!.start) : 0));
  const end = Math.max(0, Math.min(max, Number.isFinite(scope?.end) ? Math.round(scope!.end) : max));
  return start <= end ? { start, end } : { start: end, end: start };
}

export function renderPredictionChart(points: readonly PredictionPoint[], target: string, axis: string, scope?: PredictionScope): string {
  if (!points.length) return '<div class="empty"><h3>Test 预测曲线将在这里呈现</h3><p>生成 Dataset，执行 Train / Test SQL，选择目标和特征后运行预测。</p></div>';
  const visibleScope = normalizeScope(scope, points.length);
  const visiblePoints = points.slice(visibleScope.start, visibleScope.end + 1);
  const values = visiblePoints.flatMap((point) => [point.mean, point.q25, point.q75, point.truth].filter((value): value is number => value != null && Number.isFinite(value)));
  let min = Math.min(...values); let max = Math.max(...values); const pad = (max - min || Math.abs(max) || 1) * .12; min -= pad; max += pad;
  const compact = typeof matchMedia !== "undefined" && matchMedia("(max-width: 600px)").matches;
  const width = compact ? 358 : 920; const height = compact ? 280 : 330; const left = compact ? 48 : 64; const right = 18; const top = 22; const bottom = 46;
  const plotWidth = width - left - right; const plotHeight = height - top - bottom;
  const xValues = visiblePoints.map((point) => point.xValue).filter((value): value is number => value !== undefined && Number.isFinite(value));
  const continuousX = xValues.length > 0; const xMin = continuousX ? Math.min(...xValues) : 0; const xMax = continuousX ? Math.max(...xValues) : 1;
  const x = (index: number) => {
    const value = visiblePoints[index]?.xValue;
    if (continuousX && value !== undefined && Number.isFinite(value)) return left + (xMax === xMin ? .5 : (value - xMin) / (xMax - xMin)) * plotWidth;
    if (continuousX) return width - right;
    return left + (visiblePoints.length === 1 ? .5 : index / (visiblePoints.length - 1)) * plotWidth;
  };
  const y = (value: number) => top + (max - value) / (max - min) * plotHeight;
  const coordinate = (index: number, value: number) => `${x(index).toFixed(2)},${y(value).toFixed(2)}`;
  const line = (key: "mean" | "truth") => { let pen = false; return visiblePoints.map((point, index) => { const value = point[key]; if (value === null) { pen = false; return ""; } const segment = `${pen ? "L" : "M"}${coordinate(index, value)}`; pen = true; return segment; }).join(" "); };
  const interval = visiblePoints.every((point) => point.q25 !== undefined && point.q75 !== undefined && Number.isFinite(point.q25) && Number.isFinite(point.q75));
  const band = interval && visiblePoints.length === 1 ? `<line class="chart-band-single" x1="${x(0)}" x2="${x(0)}" y1="${y(visiblePoints[0].q25!)}" y2="${y(visiblePoints[0].q75!)}"/>` : interval ? `<path class="chart-band" d="M${visiblePoints.map((point, index) => coordinate(index, point.q75!)).join(" L")} L${visiblePoints.map((point, index) => coordinate(index, point.q25!)).reverse().join(" L")} Z"/>` : "";
  const grid = Array.from({ length: 5 }, (_, index) => { const value = min + (max - min) * index / 4; return `<line class="chart-grid" x1="${left}" x2="${width - right}" y1="${y(value)}" y2="${y(value)}"/><text x="${left - 10}" y="${y(value) + 4}" text-anchor="end">${Number(value.toPrecision(4))}</text>`; }).join("");
  const ticks = [...new Set(compact ? [0, visiblePoints.length - 1] : [0, Math.floor((visiblePoints.length - 1) / 2), visiblePoints.length - 1])].map((index) => `<text x="${x(index)}" y="${height - 20}" text-anchor="${index === 0 ? "start" : index === visiblePoints.length - 1 ? "end" : "middle"}">${escape(compact && /^\d{4}-\d{2}-\d{2}T/.test(visiblePoints[index].label) ? visiblePoints[index].label.slice(5, 16).replace("T", " ") : visiblePoints[index].label)}</text>`).join("");
  const xPositions = visiblePoints.map((_point, index) => x(index));
  const hitRanges = createHitRanges(xPositions, left, width - right);
  const hits = visiblePoints.map((point, index) => { const [hitLeft, hitRight] = hitRanges[index]; return `<rect class="chart-hit" data-point-index="${index}" data-point-x="${xPositions[index].toFixed(2)}" x="${hitLeft.toFixed(2)}" y="${top}" width="${(hitRight - hitLeft).toFixed(2)}" height="${plotHeight}" tabindex="0" role="button" aria-label="${escape(point.label)}，均值 ${formatNumber(point.mean)}"/>`; }).join("");
  const truthLegend = visiblePoints.some((point) => point.truth !== null) ? '<span class="legend-truth">真值</span>' : "";
  const overviewHeight = compact ? 44 : 52;
  const overviewTop = 5;
  const overviewBottom = 5;
  const overviewValues = points.flatMap((point) => [point.mean, point.q25, point.q75, point.truth].filter((value): value is number => value != null && Number.isFinite(value)));
  const overviewMin = overviewValues.length ? Math.min(...overviewValues) : 0;
  const overviewMax = overviewValues.length ? Math.max(...overviewValues) : 1;
  const overviewPad = (overviewMax - overviewMin || Math.abs(overviewMax) || 1) * .08;
  const overviewLower = overviewMin - overviewPad;
  const overviewUpper = overviewMax + overviewPad;
  const overviewXValues = points.map((point) => point.xValue).filter((value): value is number => value !== undefined && Number.isFinite(value));
  const overviewContinuousX = overviewXValues.length > 0; const overviewMinX = overviewContinuousX ? Math.min(...overviewXValues) : 0; const overviewMaxX = overviewContinuousX ? Math.max(...overviewXValues) : 1;
  const overviewX = (index: number) => {
    const value = points[index]?.xValue;
    if (overviewContinuousX && value !== undefined && Number.isFinite(value)) return overviewMaxX === overviewMinX ? width / 2 : (value - overviewMinX) / (overviewMaxX - overviewMinX) * width;
    if (overviewContinuousX) return width;
    return points.length === 1 ? width / 2 : index / (points.length - 1) * width;
  };
  const overviewY = (value: number) => overviewTop + (overviewUpper - value) / (overviewUpper - overviewLower) * (overviewHeight - overviewTop - overviewBottom);
  const overviewCoordinate = (index: number, value: number) => `${overviewX(index).toFixed(2)},${overviewY(value).toFixed(2)}`;
  const overviewLine = (key: "mean" | "truth") => { let pen = false; return points.map((point, index) => { const value = point[key]; if (value === null || !Number.isFinite(value)) { pen = false; return ""; } const segment = `${pen ? "L" : "M"}${overviewCoordinate(index, value)}`; pen = true; return segment; }).join(" "); };
  const overviewInterval = points.every((point) => point.q25 !== undefined && point.q75 !== undefined && Number.isFinite(point.q25) && Number.isFinite(point.q75));
  const overviewBand = overviewInterval ? `<path class="scope-overview-band" d="M${points.map((point, index) => overviewCoordinate(index, point.q75!)).join(" L")} L${points.map((point, index) => overviewCoordinate(index, point.q25!)).reverse().join(" L")} Z"/>` : "";
  const scopeStartPercent = visibleScope.start / Math.max(1, points.length - 1) * 100;
  const scopeEndPercent = visibleScope.end / Math.max(1, points.length - 1) * 100;
  const scopeControls = points.length > 1 ? `<div class="scope-footer"><span>曲线范围</span><output id="scope-label" for="scope-start scope-end">${visibleScope.start + 1}–${visibleScope.end + 1} / ${points.length} 行</output></div><div class="scope-navigator" role="group" aria-label="曲线范围选择" style="--scope-start:${scopeStartPercent.toFixed(4)}%;--scope-end:${scopeEndPercent.toFixed(4)}%;"><svg class="scope-overview" viewBox="0 0 ${width} ${overviewHeight}" preserveAspectRatio="none" aria-hidden="true">${overviewBand}<path class="scope-overview-line" d="${overviewLine("mean")}"/>${points.some((point) => point.truth !== null) ? `<path class="scope-overview-truth" d="${overviewLine("truth")}"/>` : ""}</svg><div class="scope-selection" aria-hidden="true"></div><input id="scope-start" class="scope-handle scope-handle-start" data-scope-range="start" type="range" min="0" max="${points.length - 1}" step="1" value="${visibleScope.start}" aria-label="曲线范围起点"/><input id="scope-end" class="scope-handle scope-handle-end" data-scope-range="end" type="range" min="0" max="${points.length - 1}" step="1" value="${visibleScope.end}" aria-label="曲线范围终点"/></div>` : "";
  return `<div class="chart-shell" data-scope-start="${visibleScope.start}" data-scope-end="${visibleScope.end}" data-scope-total="${points.length}"><div class="chart-legend"><span class="legend-mean">Mean 均值</span>${interval ? '<span class="legend-band">q25–q75 · 中间 50% 预测区间</span>' : '<span>此模型未提供分位数</span>'}${truthLegend}</div><div class="chart-frame"><svg class="prediction-chart" viewBox="0 0 ${width} ${height}" data-plot-left="${left}" data-plot-right="${right}" role="img" aria-label="${escape(target)} 预测曲线，横轴 ${escape(axis)}"><title>${escape(target)}：均值、四分位区间与可用真值</title>${grid}${band}<line class="chart-crosshair" x1="0" x2="0" y1="${top}" y2="${height - bottom}" visibility="hidden"/> <path class="chart-mean" d="${line("mean")}"/><path class="chart-truth" d="${line("truth")}"/>${visiblePoints.map((point, index) => `<circle class="chart-point" cx="${x(index)}" cy="${y(point.mean)}" r="${visiblePoints.length === 1 ? 4 : 2}"><title>${escape(point.label)} · mean ${formatNumber(point.mean)}${point.q25 === undefined ? "" : ` · q25 ${formatNumber(point.q25)} · q75 ${formatNumber(point.q75!)}`}${point.truth === null ? "" : ` · 真值 ${formatNumber(point.truth)}`}</title></circle>`).join("")}${visiblePoints.map((point, index) => point.truth === null ? "" : `<circle class="chart-truth-point" cx="${x(index)}" cy="${y(point.truth)}" r="2.5"><title>真值 ${formatNumber(point.truth)}</title></circle>`).join("")}${hits}${ticks}</svg><div class="chart-tooltip" role="status" aria-live="polite" hidden></div></div>${scopeControls}<p class="hint">横轴：${escape(axis)} · 当前显示第 ${visibleScope.start + 1}–${visibleScope.end + 1} 行。移动鼠标、触摸或使用键盘定位数据点查看数值；区间表示模型预测分布，不代表均值的置信区间。</p></div>`;
}

function createHitRanges(positions: readonly number[], left: number, right: number): Array<readonly [number, number]> {
  const ranges: Array<readonly [number, number]> = [];
  for (let groupStart = 0; groupStart < positions.length;) {
    let groupEnd = groupStart;
    while (groupEnd + 1 < positions.length && positions[groupEnd + 1] === positions[groupStart]) groupEnd += 1;
    const groupLeft = groupStart === 0 ? left : (positions[groupStart - 1] + positions[groupStart]) / 2;
    const groupRight = groupEnd === positions.length - 1 ? right : (positions[groupEnd] + positions[groupEnd + 1]) / 2;
    const groupSize = groupEnd - groupStart + 1;
    const boundaries = Array.from({ length: groupSize + 1 }, (_, offset) => groupLeft + (groupRight - groupLeft) * offset / groupSize);
    for (let index = groupStart; index <= groupEnd; index += 1) {
      const offset = index - groupStart;
      ranges[index] = [boundaries[offset], boundaries[offset + 1]];
    }
    groupStart = groupEnd + 1;
  }
  return ranges;
}

export function bindPredictionChart(root: HTMLElement, points: readonly PredictionPoint[]): () => void {
  const svg = root.querySelector<SVGSVGElement>(".prediction-chart"); const tooltip = root.querySelector<HTMLElement>(".chart-tooltip"); const crosshair = root.querySelector<SVGLineElement>(".chart-crosshair"); const frame = root.querySelector<HTMLElement>(".chart-frame"); if (!svg || !tooltip || !crosshair || !frame) return () => undefined;
  const hits = [...svg.querySelectorAll<SVGRectElement>(".chart-hit")];
  const show = (index: number, event?: PointerEvent) => { const point = points[index]; const hit = hits[index]; if (!point || !hit) return; tooltip.textContent = [`${point.label}`, `Mean  ${formatNumber(point.mean)}`, `q25   ${point.q25 === undefined ? "—" : formatNumber(point.q25)}`, `q75   ${point.q75 === undefined ? "—" : formatNumber(point.q75)}`, `真值  ${point.truth === null ? "—" : formatNumber(point.truth)}`].join("\n"); tooltip.hidden = false; crosshair.setAttribute("x1", hitCenter(hit)); crosshair.setAttribute("x2", hitCenter(hit)); crosshair.setAttribute("visibility", "visible"); const frameRect = frame.getBoundingClientRect(); const hitRect = hit.getBoundingClientRect(); const anchorX = event && Number.isFinite(event.clientX) ? event.clientX : hitRect.left + hitRect.width / 2; const anchorY = event && Number.isFinite(event.clientY) ? event.clientY : hitRect.top + hitRect.height / 2; const tooltipRect = tooltip.getBoundingClientRect(); const gap = 12; let left = anchorX - frameRect.left + gap; if (left + tooltipRect.width > frameRect.width - 4) left = anchorX - frameRect.left - tooltipRect.width - gap; let top = anchorY - frameRect.top - tooltipRect.height - gap; if (top < 4) top = anchorY - frameRect.top + gap; left = Math.max(4, Math.min(Math.max(4, frameRect.width - tooltipRect.width - 4), left)); top = Math.max(4, Math.min(Math.max(4, frameRect.height - tooltipRect.height - 4), top)); tooltip.style.left = `${left}px`; tooltip.style.top = `${top}px`; };
  const hide = () => { tooltip.hidden = true; crosshair.setAttribute("visibility", "hidden"); };
  const listeners: Array<() => void> = [];
  hits.forEach((hit, index) => { const onEnter = (event: Event) => show(index, event as PointerEvent); const onMove = (event: Event) => show(index, event as PointerEvent); const onLeave = (event: Event) => { if ((event as PointerEvent).pointerType !== "touch") hide(); }; const onFocus = () => show(index); const onBlur = () => hide(); const onPointerDown = (event: Event) => show(index, event as PointerEvent); hit.addEventListener("pointerenter", onEnter); hit.addEventListener("pointermove", onMove); hit.addEventListener("pointerleave", onLeave); hit.addEventListener("focus", onFocus); hit.addEventListener("blur", onBlur); hit.addEventListener("pointerdown", onPointerDown); listeners.push(() => { hit.removeEventListener("pointerenter", onEnter); hit.removeEventListener("pointermove", onMove); hit.removeEventListener("pointerleave", onLeave); hit.removeEventListener("focus", onFocus); hit.removeEventListener("blur", onBlur); hit.removeEventListener("pointerdown", onPointerDown); }); });
  return () => { listeners.forEach((cleanup) => cleanup()); hide(); };
}

function hitCenter(hit: SVGRectElement): string { return hit.getAttribute("data-point-x") ?? String(Number(hit.getAttribute("x") ?? 0) + Number(hit.getAttribute("width") ?? 0) / 2); }
function formatNumber(value: number): string { return Number.isFinite(value) ? value.toFixed(4) : "—"; }
