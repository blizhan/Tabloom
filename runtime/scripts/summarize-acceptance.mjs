import fs from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve(process.cwd(), "..");
const reportDir = path.join(repoRoot, "artifacts/runtime/reports");
const rawNames = [
  "integration-wasm", "integration-webgpu", "parity-wasm", "parity-webgpu",
  "persistence-wasm", "persistence-webgpu", "lifecycle-webgpu",
  "built-assets-wasm", "case-wasm", "case-webgpu",
  "bootstrap-data", "bootstrap-model",
];
const aliasNames = ["us1-acceptance", "us2-acceptance", "us3-acceptance", "us4-acceptance"];
const metadata = {
  "integration-wasm": { suite: "integration", provider: "wasm" }, "integration-webgpu": { suite: "integration", provider: "webgpu" },
  "parity-wasm": { suite: "parity", provider: "wasm" }, "parity-webgpu": { suite: "parity", provider: "webgpu" },
  "persistence-wasm": { suite: "persistence", provider: "wasm" }, "persistence-webgpu": { suite: "persistence", provider: "webgpu" },
  "lifecycle-webgpu": { suite: "lifecycle", provider: "webgpu" },
  "built-assets-wasm": { suite: "built-assets", provider: "wasm" },
  "case-wasm": { suite: "case", provider: "wasm" }, "case-webgpu": { suite: "case", provider: "webgpu" },
  "bootstrap-data": { suite: "bootstrap-data", provider: "wasm" }, "bootstrap-model": { suite: "bootstrap-model", provider: "wasm" },
  "us1-acceptance": { suite: "us1", provider: "both" }, "us2-acceptance": { suite: "us2", provider: "wasm" },
  "us3-acceptance": { suite: "us3", provider: "both" }, "us4-acceptance": { suite: "us4", provider: "both" },
};

async function readReport(name) {
  try { return { name, ...JSON.parse(await fs.readFile(path.join(reportDir, `${name}.json`), "utf8")) }; }
  catch { return { name, ...metadata[name], status: "not-run", evidence: [] }; }
}

const rawReports = Object.fromEntries(await Promise.all(rawNames.map(async (name) => [name, await readReport(name)])));

function aggregate(name, sourceNames, suite, provider) {
  const sources = sourceNames.map((sourceName) => rawReports[sourceName] ?? { name: sourceName, status: "not-run", evidence: [] });
  const status = sources.some((source) => source.status === "failed")
    ? "failed"
    : sources.some((source) => source.status === "not-run")
      ? "not-run"
      : sources.some((source) => source.status === "unavailable")
        ? "unavailable"
        : "passed";
  return {
    name, suite, provider, status, generatedAt: new Date().toISOString(),
    passed: status === "passed" ? 1 : 0, failed: status === "failed" ? 1 : 0,
    unavailable: sources.flatMap((source) => source.unavailable ?? []),
    evidence: sources.flatMap((source) => source.evidence ?? []),
    sourceReports: sources.map((source) => ({ name: source.name, status: source.status, generatedAt: source.generatedAt })),
    note: status === "passed" ? "All required provider reports passed." : "Missing, unavailable, or failed provider evidence is not promoted to a feature acceptance pass.",
  };
}

// Story aliases are derived only from raw provider reports. This prevents a
// stale single-provider alias from making a cross-provider story look green.
const aliases = {
  "us1-acceptance": aggregate("us1-acceptance", ["integration-wasm", "integration-webgpu", "parity-wasm", "parity-webgpu"], "us1", "both"),
  "us2-acceptance": aggregate("us2-acceptance", ["integration-wasm"], "us2", "wasm"),
  "us3-acceptance": aggregate("us3-acceptance", ["persistence-wasm", "persistence-webgpu"], "us3", "both"),
  "us4-acceptance": aggregate("us4-acceptance", ["case-wasm", "case-webgpu"], "us4", "both"),
};
await fs.mkdir(reportDir, { recursive: true });
for (const [name, report] of Object.entries(aliases)) await fs.writeFile(path.join(reportDir, `${name}.json`), JSON.stringify(report, null, 2));

const reports = [...rawNames.map((name) => rawReports[name]), ...aliasNames.map((name) => aliases[name])];
let fixturePreparation;
try { fixturePreparation = JSON.parse(await fs.readFile(path.join(reportDir, "fixture-prepare.json"), "utf8")); }
catch { fixturePreparation = { status: "not-run", missing: ["fixture-prepare.json"] }; }

const scenarioEvidence = {
  "SC-001": ["integration-wasm"], "SC-002": ["parity-wasm", "parity-webgpu", "case-wasm", "case-webgpu"], "SC-003": ["us3-acceptance"],
  "SC-004": ["integration-wasm", "us2-acceptance"], "SC-005": ["us3-acceptance"], "SC-006": ["us4-acceptance"],
  "SC-007": ["lifecycle-webgpu"], "SC-008": ["integration-wasm", "integration-webgpu", "us2-acceptance", "lifecycle-webgpu"],
};
function statusFor(namesForScenario) {
  const selected = reports.filter((report) => namesForScenario.includes(report.name));
  if (selected.some((report) => report.status === "failed")) return "failed";
  if (selected.length > 0 && selected.every((report) => report.status === "passed")) return "passed";
  if (selected.some((report) => report.status === "unavailable")) return "unavailable";
  return "not-run";
}
const scenarioStatus = Object.fromEntries(Object.entries(scenarioEvidence).map(([scenario, evidence]) => [scenario, { status: statusFor(evidence), evidence }]));
const counts = Object.fromEntries(["passed", "unavailable", "failed", "not-run"].map((status) => [status, reports.filter((report) => report.status === status).length]));
const environment = { node: process.version, platform: process.platform, arch: process.arch, chromium: process.env.TABLOOM_CHROMIUM ?? "/snap/bin/chromium", generatedAt: new Date().toISOString() };
const caseEvidence = reports.filter((report) => report.name === "case-wasm" || report.name === "case-webgpu").flatMap((report) => {
  const suiteResult = report.evidence?.find((item) => item && item.suite === "case");
  const adapter = report.evidence?.find((item) => item && Object.prototype.hasOwnProperty.call(item, "webgpuAdapterInfo"));
  return (suiteResult?.evidence ?? []).map((item) => ({
    report: report.name, provider: report.provider,
    adapterVendor: adapter?.webgpuAdapterInfo?.vendor ?? (report.provider === "wasm" ? "wasm" : "unknown"),
    status: item.kind === "success" ? "passed" : "failed", variant: item.variant, precision: item.precision,
    modelVersion: item.modelVersion, artifactManifestDigest: item.artifactManifestDigest, graphSha256: item.graphSha256,
    targetUnitBudget: item.targetUnitBudget, observedMaxAbsError: item.maxAbsError, repeatedMaxAbsDelta: item.repeatedMaxAbsDelta,
    unavailableReason: item.kind === "failure" ? item.error?.message : undefined,
  }));
});
const summary = {
  generatedAt: new Date().toISOString(), environment, fixturePreparation, reports, caseEvidence, scenarioStatus, counts,
  passed: counts.passed, unavailable: counts.unavailable, failed: counts.failed, notRun: counts["not-run"],
  readyForRelease: counts.failed === 0 && counts.unavailable === 0 && counts["not-run"] === 0 && (fixturePreparation.missing?.length ?? 0) === 0,
  note: "Unavailable model fixtures or hardware remain explicit and are not counted as passing evidence.",
};
await fs.writeFile(path.join(reportDir, "acceptance-summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
if (summary.failed > 0) process.exitCode = 1;
