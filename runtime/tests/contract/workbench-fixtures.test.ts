import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const root = path.resolve(process.cwd(), "tests/fixtures/workbench/v1");
const repoRoot = path.resolve(process.cwd(), "..");
const toolProject = path.join(repoRoot, "tools/workbench-fixtures");
const checker = path.join(toolProject, "check.py");
const manifestPath = path.join(root, "manifest.json");
type FixtureManifest = { counts: Record<string, number>; features: string[]; target: string; forecastOrigin: string; cases: { caseId: string; file: string }[]; files: { path: string; bytes: number; sha256: string }[]; reference?: { status?: string } };

function manifest(): FixtureManifest { return JSON.parse(fs.readFileSync(manifestPath, "utf8")) as FixtureManifest; }
function checkerResult(copy: string, allowMissingReference = false): ReturnType<typeof spawnSync> {
  return spawnSync("uv", ["run", "--project", toolProject, "--frozen", "python", checker, "--root", copy, ...(allowMissingReference ? ["--allow-missing-reference"] : [])], { cwd: repoRoot, encoding: "utf8" });
}
function copyFixture(): string { const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tabloom-workbench-fixture-")); const destination = path.join(directory, "v1"); fs.cpSync(root, destination, { recursive: true }); return destination; }
function sha256(file: string): string { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }

test("workbench fixture manifest declares the fixed split, schema and all boundary cases", () => {
  const value = manifest();
  assert.deepEqual(value.counts, { train: 256, predict: 32, features: 4 });
  assert.deepEqual(value.features, ["temperature_c", "wind_speed_ms", "solar_wm2", "hour_utc"]);
  assert.equal(value.target, "demand_mwh");
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "schema.json"), "utf8")).forecastOrigin, value.forecastOrigin);
  const required = ["empty", "missing-target", "missing-feature", "duplicate-key", "reordered", "wrong-type", "non-finite", "over-limit"];
  for (const id of required) { const item = value.cases.find((candidate) => candidate.caseId === id); assert.ok(item); assert.ok(fs.existsSync(path.join(root, item.file))); }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "cases.json"), "utf8")).cases.map((item: { caseId: string }) => item.caseId).sort(), value.cases.map((item) => item.caseId).sort());
});

test("complete reference contains 32 finite means and matching input digests", () => {
  const value = manifest();
  assert.equal(value.reference?.status, "complete");
  const reference = JSON.parse(fs.readFileSync(path.join(root, "expected/tabpfn35-mean.json"), "utf8")) as { mean: number[]; input: { trainSha256: string; predictSha256: string } };
  assert.equal(reference.mean.length, 32);
  assert.ok(reference.mean.every(Number.isFinite));
  assert.equal(reference.input.trainSha256, sha256(path.join(root, "normal/train.csv")));
  assert.equal(reference.input.predictSha256, sha256(path.join(root, "normal/predict.csv")));
});

test("checker rejects damaged, missing, oversized and temporally inconsistent fixtures", async (t) => {
  const cases: Array<[string, (copy: string) => void]> = [
    ["damaged data", (copy) => fs.appendFileSync(path.join(copy, "normal/train.csv"), "corruption\n")],
    ["missing file", (copy) => fs.rmSync(path.join(copy, "normal/predict.arrow"))],
    ["missing reference", (copy) => fs.rmSync(path.join(copy, "expected/tabpfn35-mean.json"))],
    ["wrong split", (copy) => { const schemaFile = path.join(copy, "schema.json"); const schema = JSON.parse(fs.readFileSync(schemaFile, "utf8")); schema.forecastOrigin = "2030-01-01T00:00:00Z"; fs.writeFileSync(schemaFile, `${JSON.stringify(schema, null, 2)}\n`); }],
    ["over volume", (copy) => fs.writeFileSync(path.join(copy, "unexpected.bin"), Buffer.alloc(10 * 1024 * 1024 + 1))],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, () => {
      const copy = copyFixture();
      mutate(copy);
      const result = checkerResult(copy);
      assert.notEqual(result.status, 0, `${name} should fail checker`);
    });
  }
});
