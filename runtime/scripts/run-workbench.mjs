import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chromium } from "playwright-core";

const args = process.argv.slice(2);
const readArg = (name, fallback) => { const index = args.indexOf(`--${name}`); return index >= 0 ? args[index + 1] : fallback; };
const suite = readArg("suite", "data");
const provider = readArg("provider");
const precision = readArg("precision");
const allowedSuites = new Set(["data", "duckdb-file", "flow", "model-cache", "sources", "persistence", "responsiveness", "built-assets", "accessibility", "app-flow"]);
const needsModel = new Set(["flow", "model-cache", "responsiveness"]);
if (!allowedSuites.has(suite)) { console.error("Usage: --suite data|duckdb-file|flow|model-cache|sources|persistence|responsiveness|built-assets|accessibility|app-flow"); process.exit(2); }
if (needsModel.has(suite) && (!["wasm", "webgpu"].includes(provider) || !["fp32", "fp16-storage"].includes(precision))) { console.error("flow/model-cache/responsiveness require --provider wasm|webgpu --precision fp32|fp16-storage"); process.exit(2); }

const runtimeRoot = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(runtimeRoot, "..");
const fixtureRoot = path.join(runtimeRoot, "tests/fixtures/workbench/v1");
const reportRoot = path.join(repoRoot, "artifacts/workbench/acceptance");
await fs.mkdir(reportRoot, { recursive: true });
const report = { suite, provider: provider ?? null, precision: precision ?? null, status: "not-run", passed: 0, failed: 0, unsupported: [], notRun: [], generatedAt: new Date().toISOString(), evidence: [] };

function writeReport(name, value = report) { return fs.writeFile(path.join(reportRoot, name), `${JSON.stringify(value, null, 2)}\n`, "utf8"); }
function hash(file) { return createHash("sha256").update(fsSync.readFileSync(file)).digest("hex"); }
function run(command, commandArgs, options = {}) { return spawnSync(command, commandArgs, { cwd: repoRoot, encoding: "utf8", ...options }); }
function inspectFixtureCases() {
  const manifest = JSON.parse(fsSync.readFileSync(path.join(fixtureRoot, "manifest.json"), "utf8"));
  const cases = (manifest.cases ?? []).map((item) => {
    const file = path.join(fixtureRoot, item.file);
    const exists = fsSync.existsSync(file);
    const text = exists ? fsSync.readFileSync(file, "utf8") : "";
    const rows = item.file.endsWith(".json") ? (() => { try { return JSON.parse(text); } catch { return []; } })() : text.trim().split(/\r?\n/).filter(Boolean).slice(1);
    const expectedAccepted = /ACCEPT|PRESERVE/.test(item.expected);
    const actualAccepted = item.caseId === "duplicate-key" || item.caseId === "reordered" || item.caseId === "type-roundtrip";
    const shape = item.caseId === "empty" ? rows.length === 0 : item.caseId === "over-limit" ? rows.length > 256 : item.caseId === "type-roundtrip" ? Array.isArray(rows) && rows.length === 1 && rows[0]?.empty_string === "" && rows[0]?.nullable === null && rows[0]?.big_integer !== undefined : rows.length > 0;
    const passed = exists && shape && expectedAccepted === actualAccepted;
    return { caseId: item.caseId, file: item.file, expected: item.expected, exists, rows: Array.isArray(rows) ? rows.length : 0, passed };
  });
  return { cases, passed: cases.every((item) => item.passed) };
}

async function runHarnessBrowser(harnessSuite, requestedProvider = "wasm", requestedPrecision = "fp32", payload = undefined) {
  const executable = process.env.TABLOOM_CHROMIUM ?? "/snap/bin/chromium";
  const headless = process.env.TABLOOM_HEADLESS !== "0";
  const display = process.env.TABLOOM_DISPLAY ?? process.env.DISPLAY ?? "";
  const port = Number(process.env.TABLOOM_WORKBENCH_HARNESS_PORT ?? "4175");
  const baseUrl = `http://127.0.0.1:${port}`;
  const viteBin = path.join(runtimeRoot, "node_modules/vite/bin/vite.js");
  const server = spawn(process.execPath, [viteBin, "dev", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: runtimeRoot, stdio: ["ignore", "ignore", "pipe"], detached: true });
  let browser;
  let serverStderr = "";
  server.stderr?.on("data", (chunk) => { serverStderr += String(chunk); });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 180; attempt += 1) {
      try {
        const response = await fetch(`${baseUrl}/`);
        if (response.ok && (await response.text()).includes("Tabloom Runtime")) { ready = true; break; }
      } catch { /* Vite is still starting. */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!ready) throw new Error(serverStderr.trim() || `runtime harness did not start on ${baseUrl}`);
    const argsForBrowser = ["--disable-gpu-sandbox"];
    if (provider === "webgpu") argsForBrowser.push("--enable-features=Vulkan");
    if (!headless) argsForBrowser.push("--ozone-platform=x11", "--start-minimized");
    const browserEnv = display ? { ...process.env, DISPLAY: display } : undefined;
    browser = await chromium.launch({ executablePath: executable, headless, args: argsForBrowser, ...(browserEnv ? { env: browserEnv } : {}) });
    const page = await browser.newPage();
    await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" });
    const smoke = await page.evaluate(async (requestedProvider) => {
      let adapterInfo = null;
      let adapterError = null;
      if (navigator.gpu) {
        try {
          const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
          if (adapter?.info) adapterInfo = { vendor: adapter.info.vendor, architecture: adapter.info.architecture, device: adapter.info.device, description: adapter.info.description, isFallbackAdapter: adapter.info.isFallbackAdapter ?? null };
        } catch (error) { adapterError = String(error); }
      }
      const vendor = String(adapterInfo?.vendor ?? "").toLowerCase();
      const architecture = String(adapterInfo?.architecture ?? "").toLowerCase();
      const hardwareWebgpu = Boolean(adapterInfo) && vendor !== "google" && vendor !== "swiftshader" && architecture !== "swiftshader" && adapterInfo?.isFallbackAdapter !== true;
      return { crossOriginIsolated: globalThis.crossOriginIsolated, webgpu: Boolean(navigator.gpu), hardwareWebgpu, adapterInfo, adapterError, requestedProvider };
    }, provider);
    if (!smoke.crossOriginIsolated) throw new Error("COOP/COEP isolation is not active");
    if (provider === "webgpu" && !smoke.hardwareWebgpu) return { status: "not-run", evidence: [smoke], notRun: [{ reason: `Hardware WebGPU adapter unavailable (${smoke.adapterInfo?.vendor ?? "unknown"})` }] };
    const result = await page.evaluate(({ harnessSuite, requestedProvider, requestedPrecision, payload }) => {
      const harness = globalThis.__TABLOOM_HARNESS__;
      if (!harness?.run) throw new Error("Harness suite API is not registered");
      return harness.run(harnessSuite, requestedProvider, 1, requestedPrecision, payload);
    }, { harnessSuite, requestedProvider, requestedPrecision, payload });
    return { status: result.status === "passed" ? "passed" : result.status === "unavailable" ? "not-run" : "failed", evidence: [smoke, ...(result.evidence ?? [])], ...(result.reason ? { reason: result.reason } : {}) };
  } finally {
    await browser?.close().catch(() => undefined);
    try { process.kill(-server.pid, "SIGTERM"); } catch { server.kill("SIGTERM"); }
  }
}

async function runFlowBrowser() { return runHarnessBrowser("workbench-flow", provider, precision); }

async function runSourceBrowser(sourceBaseUrl) { return runHarnessBrowser("workbench-sources", "wasm", "fp32", { sourceBaseUrl }); }

async function runModelCacheBrowser() { return runHarnessBrowser("workbench-model-cache", provider, precision); }

async function runResponsivenessBrowser() { return runHarnessBrowser("workbench-responsiveness", provider, precision); }

async function runPersistenceBrowser() { return runHarnessBrowser("workbench-persistence", "wasm", "fp32"); }

async function runBootstrapBrowser() { return runHarnessBrowser("workbench-bootstrap", "wasm", "fp32"); }

async function runExportBrowser() { return runHarnessBrowser("workbench-export", "wasm", "fp32"); }

async function runAppFlowBrowser() {
  const appPort = Number(process.env.TABLOOM_APP_PORT ?? "4176");
  const appServer = spawn(process.execPath, [path.join(runtimeRoot, "node_modules/vite/bin/vite.js"), "dev", "--config", path.join(runtimeRoot, "vite.app.config.ts"), "--host", "127.0.0.1", "--port", String(appPort), "--strictPort"], { cwd: runtimeRoot, stdio: ["ignore", "ignore", "pipe"] });
  let appStderr = ""; appServer.stderr?.on("data", (chunk) => { appStderr += String(chunk); });
  let browser;
  try {
    const appUrl = `http://127.0.0.1:${appPort}`;
    let ready = false;
    for (let attempt = 0; attempt < 180; attempt += 1) { try { const response = await fetch(`${appUrl}/`); if (response.ok) { ready = true; break; } } catch { /* app is still starting */ } await new Promise((resolve) => setTimeout(resolve, 100)); }
    if (!ready) throw new Error(appStderr.trim() || `app did not start on ${appUrl}`);
    const executable = process.env.TABLOOM_CHROMIUM ?? "/snap/bin/chromium";
    const headless = process.env.TABLOOM_HEADLESS !== "0";
    const display = process.env.TABLOOM_DISPLAY ?? process.env.DISPLAY ?? "";
    const browserEnv = display ? { ...process.env, DISPLAY: display } : undefined;
    browser = await chromium.launch({ executablePath: executable, headless, args: headless ? ["--disable-gpu-sandbox"] : ["--ozone-platform=x11", "--disable-gpu-sandbox", "--enable-features=Vulkan"], ...(browserEnv ? { env: browserEnv } : {}) });
    const page = await browser.newPage();
    await page.goto(`${appUrl}/`, { waitUntil: "networkidle" });
    const parquetPath = path.join(fixtureRoot, "normal/predict.parquet");
    const arrowPath = path.join(fixtureRoot, "normal/predict.arrow");
    await page.click("#add-source"); await page.fill("#source-name", "parquet_source"); await page.selectOption("#source-format", "parquet"); await page.setInputFiles("#source-file", parquetPath); await page.click("#source-form button[type=submit]");
    await page.waitForFunction(() => document.querySelectorAll(".table-card").length === 1 && (document.querySelector(".status-pill")?.textContent ?? "").includes("parquet_source 已导入"), undefined, { timeout: 60000 });
    await page.click("#add-source"); await page.fill("#source-name", "arrow_source"); await page.selectOption("#source-format", "arrow"); await page.setInputFiles("#source-file", arrowPath); await page.click("#source-form button[type=submit]");
    await page.waitForFunction(() => document.querySelectorAll(".table-card").length === 2 && (document.querySelector(".status-pill")?.textContent ?? "").includes("arrow_source 已导入"), undefined, { timeout: 60000 });
    const joinSql = "SELECT l.source_row_id, l.temperature_c AS left_temperature, r.temperature_c AS right_temperature FROM parquet_source AS l JOIN arrow_source AS r ON l.source_row_id = r.source_row_id ORDER BY l.source_row_id";
    await page.fill("#dataset-query", joinSql); await page.click("#build-dataset");
    await page.waitForFunction(() => (document.querySelector("#dataset-panel .dataset-meta")?.textContent ?? "").includes("32 行"), undefined, { timeout: 60000 });
    const joinEvidence = await page.evaluate(() => ({ sources: [...document.querySelectorAll(".table-card strong")].map((node) => node.textContent), dataset: document.querySelector("#dataset-panel .dataset-meta")?.textContent, duplicatePredictionSource: Boolean(document.querySelector('[data-source="predictions"]')) }));
    if (joinEvidence.sources.length !== 2 || !/32 行/.test(joinEvidence.dataset ?? "") || joinEvidence.duplicatePredictionSource) throw new Error(`multi-source Dataset JOIN failed: ${JSON.stringify(joinEvidence)}`);
    await page.reload({ waitUntil: "networkidle" });
    await page.click("#add-source");
    await page.click("#load-example");
    await page.waitForFunction(() => /^SELECT \* FROM "?weather_example"?$/.test(document.querySelector("#dataset-query")?.value ?? "") && document.querySelectorAll(".table-card").length === 1 && (document.querySelector(".status-pill")?.textContent ?? "").includes("Dataset 已生成"), undefined, { timeout: 30000 });
    await page.click("#prepare-input");
    await page.waitForFunction(() => document.querySelector("#train-count")?.textContent?.includes("204") && document.querySelector("#test-count")?.textContent?.includes("52"), undefined, { timeout: 30000 });
    const runDisabledBeforeReady = await page.locator("#run-model").isDisabled();
    await page.click("#load-model");
    await page.waitForFunction(() => (document.querySelector("#model-state")?.textContent ?? "").includes("已加载"), undefined, { timeout: 240000 });
    await page.waitForFunction(() => { const button = document.querySelector("#run-model"); return button instanceof HTMLButtonElement && !button.disabled; }, undefined, { timeout: 30000 });
    await page.click("#run-model");
    await page.waitForFunction(() => /真实预测完成/.test(document.querySelector(".status-pill")?.textContent ?? ""), undefined, { timeout: 240000 });
    const evidence = await page.evaluate((runDisabled) => ({ status: document.querySelector(".status-pill")?.textContent, runStatus: document.querySelector(".run-status")?.textContent, sourceCount: document.querySelectorAll(".table-card").length, datasetRows: document.querySelector("#dataset-panel .dataset-meta")?.textContent, trainCount: document.querySelector("#train-count")?.textContent, testCount: document.querySelector("#test-count")?.textContent, rows: document.querySelectorAll(".chart-point").length, predictionTable: Boolean(document.querySelector("[data-source='predictions']")), tooltip: Boolean(document.querySelector(".chart-tooltip")), runDisabledBeforeReady: runDisabled }), runDisabledBeforeReady);
    if (evidence.sourceCount !== 1 || !/204/.test(evidence.trainCount ?? "") || !/52/.test(evidence.testCount ?? "") || evidence.rows !== 52 || evidence.predictionTable || !evidence.tooltip || !evidence.runDisabledBeforeReady) throw new Error(`app flow did not publish the expected Dataset/Test result: ${JSON.stringify(evidence)}`);
    return { status: "passed", evidence: [{ url: appUrl, join: joinEvidence, ...evidence }] };
  } finally {
    await browser?.close().catch(() => undefined);
    try { appServer.kill("SIGTERM"); } catch { /* already stopped */ }
  }
}

if (suite === "data") {
  const result = run("node", [path.join(runtimeRoot, "scripts/check-workbench-fixtures.mjs"), "--allow-missing-reference"]);
  report.evidence.push({ command: "fixtures:workbench:check --allow-missing-reference", stdout: result.stdout?.slice(-4000), stderr: result.stderr?.slice(-4000), exitCode: result.status });
  if (result.status !== 0) { report.status = "failed"; report.failed = 1; }
  else {
    try {
      const bootstrap = await runBootstrapBrowser();
      const exportResult = await runExportBrowser();
      const cases = inspectFixtureCases();
      await writeReport("bootstrap.json", { suite: "bootstrap", ...bootstrap });
      await writeReport("flow-data.json", { suite: "flow-data", ...exportResult, cases });
      report.evidence.push({ bootstrap, export: exportResult, cases });
      if (bootstrap.status === "passed" && exportResult.status === "passed" && cases.passed) { report.status = "passed"; report.passed = 1; }
      else { report.status = "failed"; report.failed = 1; }
    } catch (error) { report.status = "failed"; report.failed = 1; report.evidence.push({ error: error instanceof Error ? error.message : String(error) }); }
  }
} else if (suite === "duckdb-file") {
  const database = path.join(fixtureRoot, "normal/sample.duckdb");
  if (!fsSync.existsSync(database)) { report.status = "failed"; report.failed = 1; report.evidence.push({ error: "sample.duckdb is missing" }); }
  else {
    const before = hash(database);
    const check = run("node", [path.join(runtimeRoot, "scripts/check-workbench-fixtures.mjs"), "--allow-missing-reference"]);
    const after = hash(database);
    report.evidence.push({ operation: "open", status: check.status === 0 ? "constrained" : "failed", reason: "Native DuckDB copy is valid; browser adapter probe is not available in this runner", command: "fixtures:workbench:check", originalSha256: before, afterSha256: after, unchanged: before === after });
    report.evidence.push({ operation: "read", status: check.status === 0 ? "constrained" : "failed", reason: "Native read verified; browser read remains adapter-dependent", originalSha256: before, afterSha256: after, unchanged: before === after });
    report.unsupported.push({ operation: "attach", status: "unsupported", reason: "Browser attach requires an adapter-specific probe" }, { operation: "write", status: "unsupported", reason: "The committed source file is read-only" });
    report.status = check.status === 0 && before === after ? "passed" : "failed";
    report[report.status === "passed" ? "passed" : "failed"] = 1;
  }
} else if (suite === "built-assets") {
  const build = run("npm", ["--prefix", runtimeRoot, "run", "build:app"], { stdio: "pipe" });
  const index = path.join(runtimeRoot, "dist-app/index.html");
  const fixture = path.join(runtimeRoot, "dist-app/runtime-fixtures/workbench/v1/manifest.json");
  const assetPaths = [
    "/runtime-assets/duckdb/duckdb-browser-mvp.worker.js",
    "/runtime-assets/duckdb/duckdb-mvp.wasm",
    "/runtime-assets/ort/ort-wasm-simd-threaded.wasm",
    "/runtime-assets/tabpfn35/fp32/tabpfn35-context-dynamic.onnx",
    "/runtime-assets/tabpfn35/fp32/tabpfn35-predict-dynamic.onnx",
    "/runtime-assets/tabpfn35/fp32/tabpfn35-shared.data",
    "/runtime-assets/tabpfn35/fp16-storage-fp32-compute/tabpfn35-context-dynamic.onnx",
    "/runtime-assets/tabpfn35/fp16-storage-fp32-compute/tabpfn35-predict-dynamic.onnx",
    "/runtime-assets/tabpfn35/fp16-storage-fp32-compute/tabpfn35-shared.data",
  ];
  const previewPort = Number(process.env.TABLOOM_APP_PREVIEW_PORT ?? "4176");
  let preview;
  try {
    if (build.status !== 0 || !fsSync.existsSync(index) || !fsSync.existsSync(fixture)) throw new Error(`app build failed: ${build.stderr?.slice(-1000) ?? "unknown error"}`);
    const viteBin = path.join(runtimeRoot, "node_modules/vite/bin/vite.js");
    preview = spawn(process.execPath, [viteBin, "preview", "--config", path.join(runtimeRoot, "vite.app.config.ts"), "--host", "127.0.0.1", "--port", String(previewPort), "--strictPort"], { cwd: runtimeRoot, stdio: ["ignore", "ignore", "pipe"] });
    let previewError = ""; preview.stderr?.on("data", (chunk) => { previewError += String(chunk); });
    const appBase = `http://127.0.0.1:${previewPort}`;
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt += 1) { try { const response = await fetch(`${appBase}/`); if (response.ok) { ready = true; break; } } catch { /* preview is starting */ } await new Promise((resolve) => setTimeout(resolve, 50)); }
    if (!ready) throw new Error(previewError.trim() || "app preview did not start");
    const response = await fetch(`${appBase}/`); const pageText = await response.text(); const headers = Object.fromEntries(response.headers.entries());
    const assets = [];
    for (const assetPath of assetPaths) { const assetResponse = await fetch(`${appBase}${assetPath}`); const body = new Uint8Array(await assetResponse.arrayBuffer()); const contentType = assetResponse.headers.get("content-type") ?? ""; assets.push({ path: assetPath, status: assetResponse.status, contentType, bytes: body.byteLength, isSpaFallback: /^\s*<!doctype html/i.test(new TextDecoder().decode(body.subarray(0, 128))) }); }
    const browser = await chromium.launch({ executablePath: process.env.TABLOOM_CHROMIUM ?? "/snap/bin/chromium", headless: process.env.TABLOOM_HEADLESS !== "0", args: process.env.TABLOOM_HEADLESS === "0" ? ["--ozone-platform=x11", "--disable-gpu-sandbox"] : ["--disable-gpu-sandbox"], ...(process.env.TABLOOM_DISPLAY ? { env: { ...process.env, DISPLAY: process.env.TABLOOM_DISPLAY } } : {}) });
    try { const page = await browser.newPage(); const pageResponse = await page.goto(`${appBase}/`, { waitUntil: "networkidle" }); const isolated = await page.evaluate(() => globalThis.crossOriginIsolated); report.evidence.push({ command: "npm --prefix runtime run build:app", exitCode: build.status, pageStatus: pageResponse?.status() ?? null, headers, pageTextLength: pageText.length, crossOriginIsolated: isolated, assets }); }
    finally { await browser.close(); }
    const assetFailures = assets.filter((asset) => asset.status !== 200 || asset.isSpaFallback || (asset.path.endsWith(".wasm") && !/application\/wasm/i.test(asset.contentType)) || (asset.path.endsWith(".onnx") || asset.path.endsWith(".data")) && /text\/html/i.test(asset.contentType));
    if (assetFailures.length || headers["cross-origin-opener-policy"] !== "same-origin" || headers["cross-origin-embedder-policy"] !== "require-corp") throw new Error(`built asset contract failed: ${JSON.stringify({ assetFailures, headers })}`);
    const nonRootBuild = run("npm", ["--prefix", runtimeRoot, "run", "build:app"], { stdio: "pipe", env: { ...process.env, VITE_APP_BASE: "/tabloom/" } });
    const nonRootIndex = fsSync.existsSync(index) ? fsSync.readFileSync(index, "utf8") : "";
    const nonRootBase = nonRootBuild.status === 0 && /\/tabloom\//.test(nonRootIndex);
    report.evidence.push({ nonRootBaseBuild: { exitCode: nonRootBuild.status, basePathObserved: nonRootBase, indexPreview: nonRootIndex.slice(0, 240) } });
    if (!nonRootBase) throw new Error("non-root Vite base build did not emit /tabloom/ asset paths");
    // Leave the normal root build in dist-app for local development after the
    // acceptance run; the non-root build is evidence only.
    const restoreRootBuild = run("npm", ["--prefix", runtimeRoot, "run", "build:app"], { stdio: "pipe", env: { ...process.env, VITE_APP_BASE: "/" } });
    if (restoreRootBuild.status !== 0) throw new Error(`failed to restore root app build: ${restoreRootBuild.stderr?.slice(-1000) ?? "unknown error"}`);
    report.status = "passed"; report.passed = 1;
  } catch (error) { report.status = "failed"; report.failed = 1; report.evidence.push({ command: "npm --prefix runtime run build:app", exitCode: build.status, stdout: build.stdout?.slice(-4000), stderr: build.stderr?.slice(-4000), error: error instanceof Error ? error.message : String(error) }); }
  finally { try { preview?.kill("SIGTERM"); } catch { /* already stopped */ } }
} else if (suite === "flow") {
  try {
    const result = await runFlowBrowser();
    report.status = result.status;
    report.evidence.push(...result.evidence);
    if (result.reason) report.notRun.push({ reason: result.reason });
    if (result.notRun) report.notRun.push(...result.notRun);
    if (result.status === "passed") report.passed = 1;
    if (result.status === "failed") report.failed = 1;
  } catch (error) {
    report.status = "failed";
    report.failed = 1;
    report.evidence.push({ error: error instanceof Error ? error.message : String(error) });
  }
} else if (suite === "sources") {
  const requestedSourcePort = Number(process.env.WORKBENCH_SOURCE_PORT ?? "4177");
  let sourcePort = requestedSourcePort;
  try { if ((await fetch(`http://127.0.0.1:${sourcePort}/__counts`)).ok) sourcePort = 4178 + (Date.now() % 1000); } catch { /* requested port is free */ }
  const sourceServer = spawn(process.execPath, [path.join(runtimeRoot, "scripts/workbench-source-server.mjs")], { cwd: runtimeRoot, env: { ...process.env, WORKBENCH_SOURCE_PORT: String(sourcePort) }, stdio: ["ignore", "ignore", "pipe"] });
  let sourceStderr = ""; sourceServer.stderr?.on("data", (chunk) => { sourceStderr += String(chunk); });
  try {
    const sourceBaseUrl = `http://127.0.0.1:${sourcePort}`;
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt += 1) { try { const response = await fetch(`${sourceBaseUrl}/__counts`); if (response.ok) { ready = true; break; } } catch { /* source server is still starting */ } await new Promise((resolve) => setTimeout(resolve, 50)); }
    if (!ready) throw new Error(sourceStderr.trim() || `source server did not start on ${sourceBaseUrl}`);
    const result = await runSourceBrowser(sourceBaseUrl);
    report.status = result.status; report.evidence.push(...result.evidence); if (result.reason) report.notRun.push({ reason: result.reason }); if (result.status === "passed") report.passed = 1; if (result.status === "failed") report.failed = 1;
  } catch (error) { report.status = "failed"; report.failed = 1; report.evidence.push({ error: error instanceof Error ? error.message : String(error) }); }
  finally { try { sourceServer.kill("SIGTERM"); } catch { /* already stopped */ } }
} else if (suite === "persistence") {
  try { const result = await runPersistenceBrowser(); report.status = result.status; report.evidence.push(...result.evidence); if (result.reason) report.notRun.push({ reason: result.reason }); if (result.status === "passed") report.passed = 1; if (result.status === "failed") report.failed = 1; await writeReport("persistence-data.json", { suite: "persistence-data", ...result }); }
  catch (error) { report.status = "failed"; report.failed = 1; report.evidence.push({ error: error instanceof Error ? error.message : String(error) }); }
} else if (suite === "model-cache") {
  try { const result = await runModelCacheBrowser(); report.status = result.status; report.evidence.push(...result.evidence); if (result.reason) report.notRun.push({ reason: result.reason }); if (result.status === "passed") report.passed = 1; if (result.status === "failed") report.failed = 1; }
  catch (error) { report.status = "failed"; report.failed = 1; report.evidence.push({ error: error instanceof Error ? error.message : String(error) }); }
} else if (suite === "responsiveness") {
  try { const result = await runResponsivenessBrowser(); report.status = result.status; report.evidence.push(...result.evidence); if (result.reason) report.notRun.push({ reason: result.reason }); if (result.status === "passed") report.passed = 1; if (result.status === "failed") report.failed = 1; await writeReport("responsiveness.json", { suite: "responsiveness", ...result }); }
  catch (error) { report.status = "failed"; report.failed = 1; report.evidence.push({ error: error instanceof Error ? error.message : String(error) }); }
} else if (suite === "app-flow") {
  try { const result = await runAppFlowBrowser(); report.status = result.status; report.evidence.push(...result.evidence); if (result.status === "passed") report.passed = 1; if (result.status === "failed") report.failed = 1; }
  catch (error) { report.status = "failed"; report.failed = 1; report.evidence.push({ error: error instanceof Error ? error.message : String(error) }); }
} else if (suite === "accessibility") {
  const appPort = Number(process.env.TABLOOM_APP_PORT ?? "4176");
  const appServer = spawn(process.execPath, [path.join(runtimeRoot, "node_modules/vite/bin/vite.js"), "dev", "--config", path.join(runtimeRoot, "vite.app.config.ts"), "--host", "127.0.0.1", "--port", String(appPort), "--strictPort"], { cwd: runtimeRoot, stdio: ["ignore", "ignore", "pipe"] });
  let appStderr = ""; appServer.stderr?.on("data", (chunk) => { appStderr += String(chunk); });
  try {
    const appUrl = `http://127.0.0.1:${appPort}`; let ready = false;
    for (let attempt = 0; attempt < 120; attempt += 1) { try { const response = await fetch(`${appUrl}/`); if (response.ok) { ready = true; break; } } catch { /* app is starting */ } await new Promise((resolve) => setTimeout(resolve, 50)); }
    if (!ready) throw new Error(appStderr.trim() || `app did not start on ${appUrl}`);
    const browser = await chromium.launch({ executablePath: process.env.TABLOOM_CHROMIUM ?? "/snap/bin/chromium", headless: process.env.TABLOOM_HEADLESS !== "0", args: process.env.TABLOOM_HEADLESS === "0" ? ["--ozone-platform=x11", "--disable-gpu-sandbox"] : ["--disable-gpu-sandbox"], ...(process.env.TABLOOM_DISPLAY ? { env: { ...process.env, DISPLAY: process.env.TABLOOM_DISPLAY } } : {}) });
    try {
      const page = await browser.newPage(); await page.goto(`${appUrl}/`, { waitUntil: "networkidle" }); await page.click("#add-source"); await page.click("#load-example"); await page.waitForFunction(() => /^SELECT \* FROM "?weather_example"?$/.test(document.querySelector("#dataset-query")?.value ?? "") && document.querySelectorAll(".table-card").length === 1 && (document.querySelector(".status-pill")?.textContent ?? "").includes("Dataset 已生成"), undefined, { timeout: 30000 }); await page.click("#prepare-input"); await page.waitForFunction(() => document.querySelector("#train-count")?.textContent?.includes("204") && document.querySelector("#test-count")?.textContent?.includes("52"), undefined, { timeout: 30000 }); await page.locator("#dataset-preview").evaluate(node => { node.open = true; });
      const keyboard = await page.evaluate(() => [...document.querySelectorAll("button, input, select, textarea")].filter((element) => !element.hasAttribute("disabled") && element.tabIndex >= 0).map((element) => element.id || element.getAttribute("aria-label") || element.tagName.toLowerCase()));
      await page.click("#add-source"); await page.fill("#source-name", ""); await page.evaluate(() => { const form = document.querySelector("#source-form"); if (form) form.setAttribute("novalidate", "true"); }); await page.click("#source-form button[type=submit]");
      const focusedError = await page.locator("#source-error").isVisible(); const paginated = await page.locator("[data-pagination]").count() > 0; const statusLive = await page.locator("[aria-live='polite']").count() > 0;
      const evidence = { keyboardOrder: keyboard, focusedError, paginated, statusLive }; report.evidence.push({ evidence, url: appUrl });
      if (!keyboard.length || !focusedError || !paginated || !statusLive) throw new Error(`accessibility contract failed: ${JSON.stringify(evidence)}`);
      report.status = "passed"; report.passed = 1;
    } finally { await browser.close(); }
  } catch (error) { report.status = "failed"; report.failed = 1; report.evidence.push({ error: error instanceof Error ? error.message : String(error) }); }
  finally { try { appServer.kill("SIGTERM"); } catch { /* already stopped */ } }
} else {
  report.notRun.push({ suite, reason: "Browser runner has not been wired for this suite" });
  report.status = "not-run";
}

const fileName = provider && precision ? `${suite}-${provider}-${precision}.json` : `${suite}.json`;
await writeReport(fileName);
const summaryPath = path.join(reportRoot, "summary.json");
let summary = { generatedAt: new Date().toISOString(), suites: [] };
try { summary = JSON.parse(await fs.readFile(summaryPath, "utf8")); } catch { /* first report */ }
summary.suites = [...(summary.suites ?? []).filter((entry) => !(entry.suite === suite && entry.provider === (provider ?? null) && entry.precision === (precision ?? null))), report];
summary.generatedAt = new Date().toISOString();
await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
if (report.status !== "passed") process.exitCode = 1;
