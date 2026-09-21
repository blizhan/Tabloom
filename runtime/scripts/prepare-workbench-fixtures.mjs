import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const toolProject = path.join(repoRoot, "tools/workbench-fixtures");
const root = path.join(repoRoot, "runtime/tests/fixtures/workbench/v1");
const python = ["run", "--project", toolProject, "--frozen", "python"];

function run(script, args = []) {
  const result = spawnSync("uv", [...python, script, "--output-dir", root, ...args], { cwd: repoRoot, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const force = process.argv.includes("--force") ? ["--force"] : [];
run("tools/workbench-fixtures/generate.py", force);
const modelPath = process.env.WORKBENCH_MODEL_PATH;
if (!modelPath) {
  console.error("Fixture data generated, but the official reference is missing. Set WORKBENCH_MODEL_PATH to an existing TabPFN 3.5 checkpoint and rerun; no fallback reference is generated.");
  process.exit(2);
}
const referencePython = process.env.WORKBENCH_REFERENCE_PYTHON;
const referenceCommand = referencePython ? [referencePython, "spikes/tabpfn35/export_workbench_reference.py"] : ["uv", ...python, "spikes/tabpfn35/export_workbench_reference.py"];
const result = spawnSync(referenceCommand[0], [...referenceCommand.slice(1), "--root", root, "--model-path", path.resolve(repoRoot, modelPath)], { cwd: repoRoot, stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
