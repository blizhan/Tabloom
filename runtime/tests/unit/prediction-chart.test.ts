import test from "node:test";
import assert from "node:assert/strict";
import { relabelPredictionPoints, renderPredictionChart } from "../../app/prediction-chart";

test("renders accessible hit targets and a tooltip host for every prediction point", () => {
  const markup = renderPredictionChart([
    { label: "2025-01-01T00:00:00Z", mean: 10, q25: 8, q75: 12, truth: 11 },
    { label: "2025-01-01T01:00:00Z", mean: 13, q25: 12, q75: 14, truth: null },
  ], "demand", "timestamp");
  assert.equal((markup.match(/class="chart-hit"/g) ?? []).length, 2);
  assert.match(markup, /data-point-index="1"/);
  assert.match(markup, /class="chart-tooltip"/);
  assert.match(markup, /class="chart-crosshair"/);
});

test("renders a scoped chart with a navigator and recalculates visible points", () => {
  const markup = renderPredictionChart([
    { label: "a", mean: 10, q25: 8, q75: 12, truth: null },
    { label: "b", mean: 20, q25: 18, q75: 22, truth: null },
    { label: "c", mean: 30, q25: 28, q75: 32, truth: null },
  ], "demand", "hour_utc", { start: 1, end: 2 });
  assert.equal((markup.match(/class="chart-hit"/g) ?? []).length, 2);
  assert.match(markup, /data-scope-start="1"/);
  assert.match(markup, /data-scope-end="2"/);
  assert.match(markup, /class="scope-navigator"/);
  assert.match(markup, /class="scope-overview"/);
  assert.match(markup, /id="scope-start"/);
  assert.match(markup, /id="scope-end"/);
  assert.doesNotMatch(markup, /data-scope-action=/);
});

test("relabels prediction points when the selected x-axis changes", () => {
  const points = [
    { label: "1", mean: 10, truth: null },
    { label: "2", mean: 20, truth: null },
  ];
  assert.deepEqual(relabelPredictionPoints(points, ["2025-01-01", "2025-01-02"], "timestamp").map((point) => point.label), ["2025-01-01", "2025-01-02"]);
  assert.deepEqual(relabelPredictionPoints(points, ["ignored", "ignored"], "").map((point) => point.label), ["1", "2"]);
});

test("orders prediction points by the selected x-axis without detaching their values", () => {
  const points = [
    { label: "1", mean: 10, truth: null },
    { label: "2", mean: 20, truth: null },
    { label: "3", mean: 30, truth: null },
  ];
  const ordered = relabelPredictionPoints(points, [3, 1, 2], "wind_speed_ms");
  assert.deepEqual(ordered.map((point) => point.label), ["1", "2", "3"]);
  assert.deepEqual(ordered.map((point) => point.mean), [20, 30, 10]);
});

test("uses selected numeric values for x positions instead of equal row spacing", () => {
  const points = relabelPredictionPoints([
    { label: "1", mean: 10, truth: null },
    { label: "2", mean: 20, truth: null },
    { label: "3", mean: 30, truth: null },
  ], [0, 10, 100], "feature");
  const markup = renderPredictionChart(points, "demand", "feature");
  const xPositions = [...markup.matchAll(/class="chart-point" cx="([0-9.]+)"/g)].map((match) => Number(match[1]));
  assert.equal(xPositions.length, 3);
  assert.ok(xPositions[1] < (xPositions[0] + xPositions[2]) / 2);
});

test("keeps hit targets disjoint when multiple points share an x value", () => {
  const points = relabelPredictionPoints([
    { label: "1", mean: 10, truth: null },
    { label: "2", mean: 20, truth: null },
    { label: "3", mean: 30, truth: null },
    { label: "4", mean: 40, truth: null },
  ], [0, 0, 10, 10], "feature");
  const markup = renderPredictionChart(points, "demand", "feature");
  const ranges = [...markup.matchAll(/<rect class="chart-hit"[^>]* x="([0-9.]+)"[^>]* width="([0-9.]+)"/g)]
    .map((match) => ({ left: Number(match[1]), right: Number(match[1]) + Number(match[2]) }));
  assert.equal(ranges.length, 4);
  for (let index = 1; index < ranges.length; index += 1) assert.ok(ranges[index - 1].right <= ranges[index].left);
});
