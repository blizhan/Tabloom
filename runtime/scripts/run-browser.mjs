import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { chromium } from "playwright-core";

const args = process.argv.slice(2);
const value = (name, fallback) => { const index = args.indexOf(`--${name}`); return index >= 0 ? args[index + 1] : fallback; };
const suite = value("suite", "integration");
const provider = value("provider", "wasm");
const cycles = Number(value("cycles", "1"));
const headless = process.env.TABLOOM_HEADLESS !== "0";
const display = process.env.TABLOOM_DISPLAY || process.env.DISPLAY || "";
const suites = new Set(["integration", "parity", "persistence", "lifecycle", "built-assets", "case"]);
const providers = new Set(["wasm", "webgpu"]);
if (!suites.has(suite) || !providers.has(provider) || !Number.isSafeInteger(cycles) || cycles < 1) {
  console.error("Usage: --suite integration|parity|persistence|lifecycle|case --provider wasm|webgpu [--cycles N]");
  process.exit(2);
}

const repoRoot = path.resolve(process.cwd(), "..");
const runtimeRoot = path.join(repoRoot, "runtime");
const port = Number(process.env.TABLOOM_PORT ?? "4175");
const baseUrl = `http://127.0.0.1:${port}`;
const unavailable = [];
let browser;
let server;
let serverStderr = "";
const report = { suite, provider, cycles, port, status: "not-run", unavailable, passed: 0, failed: 0, generatedAt: new Date().toISOString(), evidence: [] };

async function exists(relative) {
  try { await fs.access(path.join(repoRoot, relative)); return true; } catch { return false; }
}
function startServer() {
  const viteBin = path.join(runtimeRoot, "node_modules/vite/bin/vite.js");
  const command = suite === "built-assets" ? "preview" : "dev";
  const child = spawn(process.execPath, [viteBin, command, "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: runtimeRoot, stdio: ["ignore", "ignore", "pipe"], detached: true });
  child.stderr?.on("data", (chunk) => { serverStderr += String(chunk); });
  return child;
}
async function waitForHarness(child) {
  let exited = false; child.once("exit", () => { exited = true; });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (exited) break;
    try { const response = await fetch(`${baseUrl}/`); if (response.ok && (await response.text()).includes("Tabloom Runtime")) return; } catch { /* still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const error = new Error(serverStderr.trim() || `runtime harness did not start on ${baseUrl}`); error.code = "HARNESS_UNAVAILABLE"; throw error;
}
async function preflight() {
  if ((suite === "parity" || suite === "persistence") && !await exists("artifacts/tabpfn35/estimator-golden/manifest.json")) unavailable.push("artifacts/tabpfn35/estimator-golden/manifest.json");
  if (suite === "case" && !await exists("artifacts/tabiclv2/case-golden/manifest.json")) unavailable.push("artifacts/tabiclv2/case-golden/manifest.json");
  const executable = process.env.TABLOOM_CHROMIUM || "/snap/bin/chromium";
  try { await fs.access(executable); } catch { unavailable.push(`Chromium executable: ${executable}`); }
  if (provider === "webgpu" && !headless && !display) unavailable.push("Headed WebGPU validation requires DISPLAY (set TABLOOM_DISPLAY, for example :0)");
  return executable;
}

function launchOptions(executable) {
  const args = ["--disable-gpu-sandbox"];
  if (provider === "webgpu") args.push("--enable-features=Vulkan");
  if (!headless) args.push("--ozone-platform=x11", "--start-minimized");
  const env = display ? { ...process.env, DISPLAY: display } : undefined;
  return { executablePath: executable, headless, args, ...(env ? { env } : {}) };
}

try {
  const executable = await preflight();
  if (unavailable.length === 0) {
    if (suite === "built-assets" && !await exists("runtime/dist-harness/index.html")) {
      const build = spawn(process.execPath, [path.join(runtimeRoot, "node_modules/vite/bin/vite.js"), "build"], { cwd: runtimeRoot, stdio: "inherit" });
      await new Promise((resolve, reject) => { build.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`built-assets prerequisite build exited with ${code}`))); build.once("error", reject); });
    }
    server = startServer(); await waitForHarness(server);
    browser = await chromium.launch(launchOptions(executable));
    const page = await browser.newPage(); await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" });
    const smoke = await page.evaluate(async (requestedProvider) => {
      let adapterAvailable = false;
      let adapterInfo = null;
      let adapterError = null;
      if (navigator.gpu) {
        try {
          const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
          adapterAvailable = Boolean(adapter);
          if (adapter?.info) adapterInfo = { vendor: adapter.info.vendor, architecture: adapter.info.architecture, device: adapter.info.device, description: adapter.info.description, isFallbackAdapter: adapter.info.isFallbackAdapter ?? null };
        } catch (error) { adapterError = String(error); }
      }
      const vendor = String(adapterInfo?.vendor ?? "").toLowerCase();
      const architecture = String(adapterInfo?.architecture ?? "").toLowerCase();
    const hardwareWebgpu = adapterAvailable && Boolean(vendor) && vendor !== "google" && vendor !== "swiftshader" && architecture !== "swiftshader" && adapterInfo?.isFallbackAdapter !== true;
      return {
        crossOriginIsolated: globalThis.crossOriginIsolated,
        runtimeText: document.querySelector("#status")?.textContent ?? "",
        webgpu: Boolean(navigator.gpu),
        webgpuAdapter: adapterAvailable,
        hardwareWebgpu,
        webgpuAdapterInfo: adapterInfo,
        webgpuAdapterError: adapterError,
        requestedProvider,
      };
    }, provider);
    report.evidence.push(smoke);
    if (!smoke.crossOriginIsolated) throw new Error("COOP/COEP isolation is not active");
    if (provider === "webgpu" && !smoke.hardwareWebgpu) {
      unavailable.push(`Hardware WebGPU adapter is unavailable (adapter=${smoke.webgpuAdapter}, vendor=${smoke.webgpuAdapterInfo?.vendor ?? "unknown"}); use headed X11 mode with TABLOOM_HEADLESS=0 for NVIDIA validation`);
      report.status = "unavailable";
    }
    else {
      const result = await page.evaluate(async ({ requestedSuite, requestedProvider, requestedCycles }) => {
        const harness = globalThis.__TABLOOM_HARNESS__;
        if (!harness?.run) throw new Error("Harness suite API is not registered");
        return harness.run(requestedSuite, requestedProvider, requestedCycles);
      }, { requestedSuite: suite, requestedProvider: provider, requestedCycles: cycles });
      report.evidence.push(result); report.status = result.status;
      if (result.status === "unavailable" && result.reason) unavailable.push(result.reason);
      if (result.status === "passed") report.passed = 1; if (result.status === "failed") report.failed = 1;
    }
  } else report.status = "unavailable";
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (error?.code === "HARNESS_UNAVAILABLE" || /EADDRINUSE|did not start|already in use|browserType\.launch|cannot create transient scope|Target page, context or browser has been closed/i.test(message)) { unavailable.push(message); report.status = "unavailable"; }
  else { report.status = "failed"; report.failed = 1; }
  report.evidence.push({ error: message });
} finally {
  await browser?.close().catch(() => undefined);
  if (server) { try { process.kill(-server.pid, "SIGTERM"); } catch { server.kill("SIGTERM"); } }
}
const reportDir = path.join(repoRoot, "artifacts/runtime/reports"); await fs.mkdir(reportDir, { recursive: true }); await fs.writeFile(path.join(reportDir, `${suite}-${provider}.json`), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
const aliases = {
  integration: provider === "wasm" ? ["bootstrap-data", "bootstrap-model", "us1-acceptance", "us2-acceptance"] : ["integration-webgpu"],
  persistence: provider === "wasm" ? ["us3-acceptance"] : ["persistence-webgpu"],
  case: ["us4-acceptance"],
  lifecycle: provider === "webgpu" ? ["lifecycle-webgpu"] : ["lifecycle-wasm"],
  "built-assets": provider === "wasm" ? ["built-assets"] : ["built-assets-webgpu"],
};
for (const alias of aliases[suite] ?? []) {
  const aliasReport = { ...report, alias, note: report.status === "passed" ? "Evidence is scoped to the suite result; no unavailable model/hardware prerequisite is promoted to a pass." : "Explicit unavailable/failed evidence; not a feature acceptance pass." };
  await fs.writeFile(path.join(reportDir, `${alias}.json`), JSON.stringify(aliasReport, null, 2));
}
if (suite === "case") {
  // Case acceptance is a cross-provider artifact.  Keep both provider runs in
  // one traceability report instead of letting the last invocation overwrite
  // the first one.
  const providerReports = [];
  for (const requestedProvider of ["wasm", "webgpu"]) {
    try { providerReports.push(JSON.parse(await fs.readFile(path.join(reportDir, `case-${requestedProvider}.json`), "utf8"))); } catch { /* current/other provider may not have run */ }
  }
  const status = providerReports.some((item) => item.status === "failed") ? "failed" : providerReports.some((item) => item.status === "unavailable") ? "unavailable" : providerReports.length === 2 && providerReports.every((item) => item.status === "passed") ? "passed" : "not-run";
  const aggregate = {
    suite: "case", provider: "both", status, alias: "us4-acceptance", generatedAt: new Date().toISOString(),
    passed: status === "passed" ? 1 : 0, failed: status === "failed" ? 1 : 0,
    unavailable: providerReports.flatMap((item) => item.unavailable ?? []),
    evidence: providerReports.flatMap((item) => item.evidence ?? []),
    note: status === "passed" ? "Real ORT Case evidence covers WASM/WebGPU × FP32/FP16-storage; target-unit budgets and graph digests remain in each variant result." : "Case provider/variant evidence is incomplete or explicitly unavailable.",
  };
  await fs.writeFile(path.join(reportDir, "us4-acceptance.json"), JSON.stringify(aggregate, null, 2));
}
if (report.status !== "passed") process.exitCode = 1;
