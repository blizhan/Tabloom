import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright-core";

const root = path.resolve(import.meta.dirname, "..");
const port = process.env.TABLOOM_PREDICTION_PORT ?? "4186";
const server = spawn(process.execPath, [path.join(root, "node_modules/vite/bin/vite.js"), "--config", "vite.app.config.ts", "--host", "127.0.0.1", "--port", port, "--strictPort"], { cwd: root, stdio: ["ignore", "ignore", "pipe"] });
let serverError = ""; server.stderr.on("data", (chunk) => { serverError += String(chunk); });
let browser;
const output = path.resolve(root, "../artifacts/workbench/prediction-ui");
await fs.mkdir(output, { recursive: true });
const report = { status: "failed", checks: [], errors: [] };

function parseCsvLine(line) {
  const cells = []; let cell = ""; let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]; const next = line[index + 1];
    if (char === '"' && quoted && next === '"') { cell += '"'; index += 1; }
    else if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) { cells.push(cell); cell = ""; }
    else cell += char;
  }
  cells.push(cell); return cells;
}

async function waitForStatus(page, pattern, timeout = 240000) {
  await page.waitForFunction((source) => new RegExp(source).test(document.querySelector(".status-pill")?.textContent ?? ""), pattern.source, { timeout });
}

try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt += 1) { try { if ((await fetch(`http://127.0.0.1:${port}`)).ok) { ready = true; break; } } catch { /* Vite is still starting. */ } await new Promise((resolve) => setTimeout(resolve, 100)); }
  assert.ok(ready, serverError || "Vite did not start");
  browser = await chromium.launch({ executablePath: process.env.TABLOOM_CHROMIUM ?? "/snap/chromium/current/usr/lib/chromium-browser/chrome", headless: process.env.TABLOOM_HEADLESS !== "0", args: ["--disable-gpu-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, acceptDownloads: true });
  const page = await context.newPage();
  page.on("pageerror", (error) => report.errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => [...document.querySelectorAll(".capability-status-item")].length === 4 && ![...document.querySelectorAll(".capability-status-item")].some((node) => node.classList.contains("checking")));
  const webgpuStatus = page.locator(".capability-status-item").filter({ hasText: "WebGPU" });
  assert.equal(await webgpuStatus.count(), 1);
  if ((await webgpuStatus.innerText()).includes("不可用")) assert.equal(await page.locator('#provider option[value="webgpu"]').count(), 0);
  else assert.equal(await page.locator('#provider option[value="webgpu"]').count(), 1);
  assert.equal(await page.locator("#save-experiment").count(), 0);
  assert.equal(await page.locator("#capabilities-and-experiments").count(), 0);

  await page.click("#add-source");
  await page.click("#load-example");
  await page.waitForFunction(() => /^SELECT \* FROM "?weather_example"?$/.test(document.querySelector("#dataset-query")?.value ?? "") && document.querySelectorAll(".table-card").length === 1 && (document.querySelector(".status-pill")?.textContent ?? "").includes("Dataset 已生成"));
  assert.equal(await page.locator(".table-card").count(), 1);
  assert.equal(await page.locator('[data-source="predictions"]').count(), 0);
  if (process.env.TABLOOM_PREDICTION_PROVIDER) await page.selectOption("#provider", process.env.TABLOOM_PREDICTION_PROVIDER);
  await page.selectOption("#precision", "fp16-storage");
  assert.equal(await page.locator("#run-model").isDisabled(), true);
  await page.click("#load-model");
  await page.waitForFunction(() => (document.querySelector("#model-state")?.textContent ?? "").includes("已加载"), undefined, { timeout: 240000 });
  assert.equal(await page.locator("#run-model").isDisabled(), false);
  await page.click("#run-model");
  await waitForStatus(page, /真实预测完成|预测失败/);
  assert.match(await page.locator(".status-pill").innerText(), /真实预测完成/);
  assert.equal(await page.locator(".chart-point").count(), 52);
  assert.equal(await page.locator("input[data-target][value='demand_mwh']").isChecked(), true);
  await page.waitForFunction(() => document.querySelector("#train-count")?.textContent?.includes("204") && document.querySelector("#test-count")?.textContent?.includes("52"));
  await page.locator("#train-preview").evaluate((node) => { node.open = true; });
  await page.locator("#test-tab").click();
  await page.locator("#test-preview").evaluate((node) => { node.open = true; });
  assert.ok(await page.locator("#train-preview tbody tr").count() <= 200);
  assert.ok(await page.locator("#test-preview tbody tr").count() <= 200);
  report.checks.push("example source builds one 256-row Dataset with Train 204 / Test 52; previews stay capped at 200");

  assert.equal(await page.locator(".chart-band").count(), 1);
  assert.equal(await page.locator("#prediction-details").evaluate((node) => node.open), false);
  const defaultAxisLabel = await page.locator(".chart-point title").first().textContent();
  await page.locator("#x-axis").selectOption("hour_utc");
  await page.waitForFunction((previous) => document.querySelector(".chart-point title")?.textContent !== previous, defaultAxisLabel);
  assert.match(await page.locator(".prediction-chart").getAttribute("aria-label"), /横轴 hour_utc/);
  assert.notEqual(await page.locator(".chart-point title").first().textContent(), defaultAxisLabel);
  await page.locator(".chart-hit").first().hover();
  assert.match(await page.locator(".chart-tooltip").innerText(), /Mean/);
  const firstTooltipPosition = await page.locator(".chart-tooltip").evaluate((node) => ({ left: node.style.left, top: node.style.top }));
  await page.locator(".chart-hit").last().hover();
  const lastTooltipPosition = await page.locator(".chart-tooltip").evaluate((node) => ({ left: node.style.left, top: node.style.top }));
  assert.notDeepEqual(firstTooltipPosition, lastTooltipPosition);
  await page.locator(".chart-hit").first().focus();
  await page.keyboard.press("ArrowRight");
  assert.match(await page.locator(".chart-tooltip").innerText(), /q25/);
  await page.locator("#scope-start").evaluate((node) => { const input = node; input.value = "10"; input.dispatchEvent(new Event("input", { bubbles: true })); input.dispatchEvent(new Event("change", { bubbles: true })); });
  await page.waitForFunction(() => document.querySelector(".chart-shell")?.getAttribute("data-scope-start") === "10");
  assert.equal(await page.locator(".chart-point").count(), 42);
  assert.match(await page.locator("#scope-label").innerText(), /^11–52 \/ 52 行$/);
  await page.locator("#scope-end").evaluate((node) => { const input = node; input.value = "41"; input.dispatchEvent(new Event("input", { bubbles: true })); input.dispatchEvent(new Event("change", { bubbles: true })); });
  await page.waitForFunction(() => document.querySelector(".chart-shell")?.getAttribute("data-scope-end") === "41");
  assert.equal(await page.locator(".chart-point").count(), 32);
  assert.match(await page.locator("#scope-label").innerText(), /^11–42 \/ 52 行$/);
  await page.locator("#scope-start").evaluate((node) => { const input = node; input.value = "0"; input.dispatchEvent(new Event("input", { bubbles: true })); input.dispatchEvent(new Event("change", { bubbles: true })); });
  await page.locator("#scope-end").evaluate((node) => { const input = node; input.value = "51"; input.dispatchEvent(new Event("input", { bubbles: true })); input.dispatchEvent(new Event("change", { bubbles: true })); });
  await page.waitForFunction(() => document.querySelector(".chart-shell")?.getAttribute("data-scope-end") === "51");
  assert.equal(await page.locator(".chart-point").count(), 52);
  await page.locator("#prediction-details").evaluate((node) => { node.open = true; });
  const defaultHeaders = await page.locator("#prediction-table th").allTextContents();
  assert.ok(defaultHeaders.includes("demand_mwh"));
  assert.ok(defaultHeaders.includes("mean") || defaultHeaders.includes("prediction_mean"));
  const firstDownload = page.waitForEvent("download"); await page.click("#download-results");
  const firstCsv = await fs.readFile(await (await firstDownload).path(), "utf8");
  assert.equal(firstCsv.split(/\r?\n/).filter(Boolean).length, 53);
  report.checks.push("real FP16-storage/FP32-compute Test prediction has 52 points, q25–q75 band, hover/keyboard tooltip and CSV");

  const trainSql = "SELECT temperature_c AS x, demand_mwh * 2 AS price FROM dataset ORDER BY __tabloom_row_id LIMIT 64";
  const testSql = "SELECT temperature_c AS x, CASE WHEN __tabloom_row_id = 250 THEN NULL ELSE demand_mwh * 2 END AS price FROM dataset ORDER BY __tabloom_row_id DESC LIMIT 7";
  await page.locator("#train-tab").click();
  await page.fill("#training-query", trainSql);
  await page.locator("#test-tab").click();
  await page.fill("#test-query", testSql);
  await page.click("#prepare-input");
  await page.waitForFunction(() => document.querySelector("#train-count")?.textContent?.includes("64") && document.querySelector("#test-count")?.textContent?.includes("7"));
  assert.equal(await page.locator("input[data-target][value='price']").isChecked(), true);
  assert.equal(await page.locator("[data-feature-all]").isChecked(), true);
  await page.locator("input[data-target][value='x']").click();
  await page.waitForFunction(() => document.querySelector("input[data-target][value='x']")?.checked === true);
  assert.equal(await page.locator("[data-feature='x']").count(), 0);
  await page.locator("input[data-target][value='price']").click();
  await page.waitForFunction(() => document.querySelector("input[data-target][value='price']")?.checked === true);
  assert.equal(await page.locator("[data-feature='x']").isChecked(), true);
  await page.locator("[data-feature='x']").click();
  await page.waitForFunction(() => document.querySelector("[data-feature='x']")?.checked === false);
  await page.locator("[data-feature-all]").click();
  await page.waitForFunction(() => document.querySelector("[data-feature='x']")?.checked === true && document.querySelector("[data-feature-all]")?.checked === true);
  await page.selectOption("#x-axis", "");
  await page.click("#run-model");
  await waitForStatus(page, /真实预测完成|预测失败/);
  assert.match(await page.locator(".status-pill").innerText(), /真实预测完成：7 个 Test 行/);
  assert.match(await page.locator("#result-summary").innerText(), /Train 64 行 · Test 7 行/);
  assert.equal(await page.locator(".chart-point").count(), 7);
  assert.notEqual(await page.locator(".chart-truth").getAttribute("d"), "");
  await page.locator("#prediction-details").evaluate((node) => { node.open = true; });
  const headers = await page.locator("#prediction-table th").allTextContents();
  const csvDownload = page.waitForEvent("download"); await page.click("#download-results");
  const csv = await fs.readFile(await (await csvDownload).path(), "utf8");
  const rows = csv.split(/\r?\n/).filter(Boolean).map(parseCsvLine);
  const header = rows[0];
  const meanIndex = header.findIndex((name) => name === "mean" || name.includes("prediction_mean"));
  const q25Index = header.findIndex((name) => name === "q25" || name.includes("prediction_q25"));
  const q75Index = header.findIndex((name) => name === "q75" || name.includes("prediction_q75"));
  const truthIndex = header.indexOf("truth");
  assert.ok(meanIndex >= 0 && q25Index >= 0 && q75Index >= 0 && truthIndex >= 0);
  assert.ok(header.includes("price"));
  assert.equal(rows.length, 8);
  for (const row of rows.slice(1)) { assert.ok(Number.isFinite(Number(row[meanIndex]))); assert.ok(Number(row[q25Index]) <= Number(row[q75Index])); }
  assert.equal(rows.slice(1).filter((row) => row[truthIndex] === "").length, 1);
  report.checks.push("custom Train LIMIT 64 / Test LIMIT 7 preserves Test price/truth, target tags and aligned quartile output");
  if (process.env.TABLOOM_CAPTURE === "1") {
    await page.screenshot({ path: path.join(output, "desktop-result.png"), fullPage: true });
    await page.locator("#prediction-details").evaluate((node) => { node.open = false; });
    await page.setViewportSize({ width: 390, height: 844 });
    const mobileOverflow = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth, elements: [...document.querySelectorAll("*")].map((node) => ({ name: node.tagName.toLowerCase(), id: node.id, className: typeof node.className === "string" ? node.className : "", right: node.getBoundingClientRect().right, width: node.getBoundingClientRect().width })).filter((item) => item.right > innerWidth + 1).slice(-12) }));
    assert.ok(mobileOverflow.scrollWidth <= mobileOverflow.innerWidth, JSON.stringify(mobileOverflow));
    await page.screenshot({ path: path.join(output, "mobile-result.png"), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1100 });
  }

  await page.locator("#prediction-details").evaluate((node) => { node.open = false; });
  const experimentDownload = page.waitForEvent("download"); await page.click("#export-experiment");
  const exportedExperiment = JSON.parse(await fs.readFile(await (await experimentDownload).path(), "utf8"));
  assert.equal(exportedExperiment.target, "price");
  assert.deepEqual(exportedExperiment.features, ["x"]);
  report.checks.push("export keeps the current experiment configuration without a local save/restore panel");
  await page.fill("#test-query", "SELECT * FROM missing_table");
  await page.click("#run-model");
  await waitForStatus(page, /预测失败/);
  assert.equal(await page.locator(".chart-point").count(), 7);
  report.checks.push("invalid Test SQL keeps the last successful 7-row result visible");

  if (process.env.TABLOOM_CAPTURE === "1") {
    await page.screenshot({ path: path.join(output, "desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: path.join(output, "mobile.png"), fullPage: true });
  }
  assert.deepEqual(report.errors, []);
  report.status = "passed";
} catch (error) {
  report.errors.push(error.stack ?? String(error)); process.exitCode = 1;
} finally {
  await browser?.close(); server.kill("SIGTERM");
  await fs.writeFile(path.join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}
