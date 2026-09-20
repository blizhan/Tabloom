import test from "node:test";
import assert from "node:assert/strict";
import { fitPreprocessing, transformFeatures } from "../../src/model/tabpfn35/preprocessing";
import { decodeRegressionMean, tabPFN35RegressionBorders, TABPFN35_REGRESSION_BINS } from "../../src/model/tabpfn35/decode";
import { RuntimeError } from "../../src/model/errors";
test("TabPFN preprocessing is fitted once and reused for prediction", () => { const state = fitPreprocessing({ columns: [new Float32Array([1, 2, 3])], columnNames: ["x"], rowCount: 3, target: new Float32Array([2, 4, 6]), targetName: "y" }, { profile: "tabpfn35-none", seed: 0 }); const prepared = transformFeatures({ columns: [new Float32Array([4])], columnNames: ["x"], rowCount: 1 }, state); assert.equal(prepared.values[0].length, 1); });

test("TabPFN decoder performs stable 5000-bin midpoint decoding in target units", () => {
  const logits = new Float32Array(TABPFN35_REGRESSION_BINS);
  logits.fill(-1000);
  logits[2500] = 1000;
  const mean = decodeRegressionMean(logits, [1, TABPFN35_REGRESSION_BINS], { targetMean: 10, targetScale: 2, temperature: 1 });
  assert.equal(mean.length, 1);
  assert.ok(Math.abs(mean[0] - 10) < 0.06);
  assert.equal(tabPFN35RegressionBorders().length, TABPFN35_REGRESSION_BINS + 1);
});

test("TabPFN decoder rejects non-finite logits and wrong output shapes", () => {
  const logits = new Float32Array(TABPFN35_REGRESSION_BINS);
  logits[0] = Number.NaN;
  assert.throws(() => decodeRegressionMean(logits, [1, 1, TABPFN35_REGRESSION_BINS], { targetMean: 0, targetScale: 1 }), (error) => error instanceof RuntimeError && error.code === "RESULT_INVALID");
  assert.throws(() => decodeRegressionMean(new Float32Array(2), [1, 1, 2], { targetMean: 0, targetScale: 1 }), (error) => error instanceof RuntimeError && error.code === "SHAPE_UNSUPPORTED");
});

test("TabPFN decoder accepts masked negative-infinite bins", () => {
  const logits = new Float32Array(TABPFN35_REGRESSION_BINS);
  logits.fill(Number.NEGATIVE_INFINITY);
  logits[2500] = 0;
  const mean = decodeRegressionMean(logits, [1, 1, TABPFN35_REGRESSION_BINS], { targetMean: 0, targetScale: 1 });
  assert.ok(Number.isFinite(mean[0]));
  assert.throws(() => {
    const invalid = new Float32Array(logits);
    invalid[0] = Number.POSITIVE_INFINITY;
    decodeRegressionMean(invalid, [1, 1, TABPFN35_REGRESSION_BINS], { targetMean: 0, targetScale: 1 });
  }, (error) => error instanceof RuntimeError && error.code === "RESULT_INVALID");
});
