import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { access } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { inflateRawSync } from "node:zlib";
import { fitPreprocessing, transformFeatures, transformTrainingFeatures } from "../../src/model/tabpfn35/preprocessing";
import { decodeRegressionMean } from "../../src/model/tabpfn35/decode";
import { RuntimeError } from "../../src/model/errors";
import type { TabularDataset, TrainingDataset } from "../../src/model/types";

interface NpyArray { readonly shape: readonly number[]; readonly values: Float32Array; }
interface GoldenState {
  readonly seed: number;
  readonly fingerprint: boolean;
  readonly featureShiftDecoder: "shuffle" | "rotate" | null;
  readonly featureShiftCount: number;
  readonly targetMean: number;
  readonly targetScale: number;
  readonly temperature: number;
  readonly passthroughInf: boolean;
  readonly gpu: { readonly fittedCache?: readonly { readonly permutation?: readonly number[]; readonly lower?: readonly (readonly number[])[]; readonly upper?: readonly (readonly number[])[] }[] };
}

function repoArtifactRoot(): string {
  const candidates = [
    resolve(process.cwd(), "artifacts/tabpfn35/estimator-golden"),
    resolve(process.cwd(), "../artifacts/tabpfn35/estimator-golden"),
  ];
  // npm runs package scripts with the package as cwd, while direct `tsx`
  // invocations are commonly made from the repository root.
  return candidates.find((candidate) => existsSync(resolve(candidate, "manifest.json"))) ?? candidates[0];
}

async function readBytes(path: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(path));
}

function dataView(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const view = dataView(bytes);
  // NPZ files in the exporter are ordinary ZIP32 archives.  Search the final
  // 64 KiB as required by the ZIP format so an arbitrary comment is harmless.
  for (let offset = Math.max(0, bytes.byteLength - 22 - 0xffff); offset <= bytes.byteLength - 22; offset += 1) {
    if (view.getUint32(offset, true) === 0x06054b50) return offset;
  }
  throw new Error("Golden NPZ has no ZIP end record");
}

function readNpz(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = dataView(bytes);
  const eocd = findEndOfCentralDirectory(bytes);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  const entries = new Map<string, Uint8Array>();
  let offset = centralOffset;
  const end = centralOffset + centralSize;
  while (offset < end) {
    assert.equal(view.getUint32(offset, true), 0x02014b50, "Golden NPZ central directory entry is malformed");
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    assert.equal(view.getUint32(localOffset, true), 0x04034b50, `Golden NPZ local entry ${name} is malformed`);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = bytes.subarray(dataOffset, dataOffset + compressedSize);
    const decoded = method === 0 ? new Uint8Array(compressed) : method === 8 ? new Uint8Array(inflateRawSync(compressed)) : undefined;
    if (!decoded) throw new Error(`Golden NPZ uses unsupported ZIP compression method ${method}`);
    entries.set(name, decoded);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function parseNpy(bytes: Uint8Array): NpyArray {
  const view = dataView(bytes);
  assert.equal(new TextDecoder().decode(bytes.subarray(0, 6)), "�NUMPY", "Golden array does not have an NPY header");
  const major = bytes[6];
  const headerLength = major === 1 ? view.getUint16(8, true) : major === 2 ? view.getUint32(8, true) : 0;
  if (!headerLength) throw new Error(`Unsupported NPY version ${major}`);
  const headerOffset = major === 1 ? 10 : 12;
  const header = new TextDecoder().decode(bytes.subarray(headerOffset, headerOffset + headerLength));
  const dtype = /['"]descr['"]\s*:\s*['"]([^'"]+)['"]/.exec(header)?.[1];
  if (dtype !== "<f4") throw new Error(`Golden array dtype ${dtype ?? "unknown"} is not little-endian float32`);
  const shapeText = /['"]shape['"]\s*:\s*\(([^)]*)\)/.exec(header)?.[1];
  const shape = shapeText?.split(",").map((part) => part.trim()).filter(Boolean).map(Number) ?? [];
  if (shape.length === 0 || shape.some((value) => !Number.isSafeInteger(value) || value < 0)) throw new Error("Golden array shape is invalid");
  const elementCount = shape.reduce((total, value) => total * value, 1);
  const dataOffset = headerOffset + headerLength;
  if (bytes.byteLength - dataOffset !== elementCount * 4) throw new Error("Golden array byte length does not match its shape");
  const values = new Float32Array(elementCount);
  values.set(new Float32Array(bytes.buffer, bytes.byteOffset + dataOffset, elementCount));
  return { shape, values };
}

async function readScenario(root: string, name: string): Promise<{ readonly arrays: Map<string, NpyArray>; readonly state: GoldenState }> {
  const archive = readNpz(await readBytes(resolve(root, `${name}.npz`)));
  const arrays = new Map<string, NpyArray>();
  for (const [entry, bytes] of archive) arrays.set(entry.replace(/\.npy$/, ""), parseNpy(bytes));
  const state = JSON.parse(await readFile(resolve(root, `${name}.state.json`), "utf8")) as GoldenState;
  return { arrays, state };
}

function columnsFromRowMajor(values: Float32Array, rowCount: number, featureCount: number): Float32Array[] {
  return Array.from({ length: featureCount }, (_, column) => {
    const output = new Float32Array(rowCount);
    for (let row = 0; row < rowCount; row += 1) output[row] = values[row * featureCount + column];
    return output;
  });
}

function asDataset(array: NpyArray, target?: Float32Array): TrainingDataset | TabularDataset {
  assert.equal(array.shape.length, 2);
  const rowCount = array.shape[0];
  const featureCount = array.shape[1];
  const dataset = { columns: columnsFromRowMajor(array.values, rowCount, featureCount), columnNames: Array.from({ length: featureCount }, (_, index) => `x${index}`), rowCount };
  return target ? { ...dataset, target, targetName: "target" } : dataset;
}

function rowMajorFromColumns(columns: readonly Float32Array[], rowCount: number): Float32Array {
  const output = new Float32Array(rowCount * columns.length);
  for (let row = 0; row < rowCount; row += 1) for (let column = 0; column < columns.length; column += 1) output[row * columns.length + column] = columns[column][row];
  return output;
}

function maxAbsDifference(actual: ArrayLike<number>, expected: ArrayLike<number>, tolerance = 1e-5, label = "golden"): number {
  assert.equal(actual.length, expected.length);
  let maximum = 0;
  for (let index = 0; index < actual.length; index += 1) {
    const left = Number(actual[index]);
    const right = Number(expected[index]);
    if (Number.isNaN(left) || Number.isNaN(right)) {
      assert.ok(Number.isNaN(left) && Number.isNaN(right), `${label} mismatch at ${index}: ${left} != ${right}`);
      continue;
    }
    if (!Number.isFinite(left) || !Number.isFinite(right)) assert.equal(left, right, `${label} non-finite mismatch at ${index}`);
    if (Number.isFinite(left)) {
      const difference = Math.abs(left - right);
      maximum = Math.max(maximum, difference);
      assert.ok(difference <= tolerance, `${label} mismatch at ${index}: ${left} != ${right} (delta ${difference})`);
    }
  }
  return maximum;
}

test("TabPFN preprocessing and decoder match all exported official goldens", async () => {
  const root = repoArtifactRoot();
  await access(resolve(root, "manifest.json"));
  const names = ["normal", "missing", "opt-in-inf", "second-seed", "duplicate-rows", "constant-column", "extreme-values"];
  for (const name of names) {
    const { arrays, state } = await readScenario(root, name);
    // Keep the failing scenario visible when a future exporter changes a
    // single fitted cache field; the test still remains quiet on success.
    const train = asDataset(arrays.get("x_train")!, arrays.get("y_train")!.values) as TrainingDataset;
    const prediction = asDataset(arrays.get("x_test")!) as TabularDataset;
    const cache = state.gpu.fittedCache ?? [];
    const permutation = cache[1]?.permutation;
    assert.ok(permutation, `${name} golden is missing the fitted feature permutation`);
    const fitted = fitPreprocessing(train, {
      profile: "tabpfn35-none",
      seed: state.seed,
      passthroughInf: state.passthroughInf,
      featureFingerprint: state.fingerprint,
      featurePermutation: permutation,
      featureShiftDecoder: state.featureShiftDecoder,
      featureShiftCount: state.featureShiftCount,
    });
    const trainModel = transformTrainingFeatures(train, fitted);
    const testModel = transformFeatures(prediction, fitted);
    const expectedTrain = arrays.get("x_train_model")!;
    const expectedTest = arrays.get("x_test_model")!;
    assert.deepEqual(expectedTrain.shape, [train.rowCount, 1, trainModel.values.length], `${name} train model shape`);
    assert.deepEqual(expectedTest.shape, [prediction.rowCount, 1, testModel.values.length], `${name} test model shape`);
    maxAbsDifference(rowMajorFromColumns(trainModel.values, train.rowCount), expectedTrain.values, 1e-5, `${name} train preprocessing`);
    maxAbsDifference(rowMajorFromColumns(testModel.values, prediction.rowCount), expectedTest.values, 1e-5, `${name} test preprocessing`);
    const expectedY = arrays.get("y_train_model")!;
    const actualY = train.target.map((value) => Math.fround((value - fitted.targetMean) / fitted.targetScale));
    maxAbsDifference(actualY, expectedY.values, 1e-5, `${name} target preprocessing`);
    assert.ok(Math.abs(fitted.targetMean - Math.fround(state.targetMean)) <= 1e-7, `${name} target mean`);
    assert.ok(Math.abs(fitted.targetScale - Math.fround(state.targetScale)) <= 1e-6, `${name} target scale`);
    const logits = arrays.get("logits")!;
    const borders = arrays.get("standard_borders")!;
    const decoded = decodeRegressionMean(logits.values, [prediction.rowCount, 1, 5000], { targetMean: state.targetMean, targetScale: state.targetScale, temperature: state.temperature, borders: [...borders.values] });
    const mean = arrays.get("mean")!;
    const decoderError = maxAbsDifference(decoded, mean.values, 1e-4, `${name} decoder`);
    assert.ok(decoderError <= 1e-4, `${name} decoder error ${decoderError} exceeds 1e-4`);
  }
  const inf = await readScenario(root, "opt-in-inf");
  const infTrain = asDataset(inf.arrays.get("x_train")!, inf.arrays.get("y_train")!.values) as TrainingDataset;
  assert.throws(() => fitPreprocessing(infTrain, { profile: "tabpfn35-none", seed: inf.state.seed, featureFingerprint: inf.state.fingerprint, featurePermutation: inf.state.gpu.fittedCache?.[1]?.permutation }), (error) => error instanceof RuntimeError && error.code === "INF_DISABLED");
});
