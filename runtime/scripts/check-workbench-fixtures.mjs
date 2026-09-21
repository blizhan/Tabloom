import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const toolProject = path.join(repoRoot, "tools/workbench-fixtures");
const root = path.join(repoRoot, "runtime/tests/fixtures/workbench/v1");
const result = spawnSync("uv", ["run", "--project", toolProject, "--frozen", "python", "tools/workbench-fixtures/check.py", "--root", root, ...process.argv.slice(2)], { cwd: repoRoot, stdio: "inherit" });
if (result.error) {
  console.error(`Unable to run locked fixture checker: ${result.error.message}`);
  process.exit(2);
}
process.exit(result.status ?? 1);
