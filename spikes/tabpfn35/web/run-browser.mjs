import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const backend = process.argv[2] ?? "webgpu";
const mode = process.argv[3] ?? "full";
const variant = process.argv[4] ?? "fp32";
if (!new Set(["wasm", "webgpu"]).has(backend)) {
  throw new Error(`Unsupported backend: ${backend}`);
}

const server = await createServer({ configFile: path.resolve("vite.config.js") });
await server.listen();

const browser = await chromium.launch({
  executablePath: process.env.TABLOOM_CHROMIUM ?? "/snap/bin/chromium",
  headless: true,
  args: [
    "--enable-unsafe-webgpu",
    "--enable-features=Vulkan",
    "--use-angle=vulkan",
  ],
});

try {
  const page = await browser.newPage();
  page.on("console", (message) => console.error(`[browser:${message.type()}] ${message.text()}`));
  page.on("pageerror", (error) => console.error(`[browser:error] ${error.stack ?? error}`));
  await page.goto(`http://127.0.0.1:4173/?backend=${backend}&mode=${mode}&variant=${variant}`);
  await page.waitForFunction(() => window.__TABLOOM_RESULT__ !== undefined, null, {
    timeout: 300_000,
  });
  const result = await page.evaluate(() => window.__TABLOOM_RESULT__);
  const resultsDir = path.resolve("browser-results");
  await mkdir(resultsDir, { recursive: true });
  await writeFile(
    path.join(resultsDir, `${mode}-${backend}-${variant}.json`),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  console.log(JSON.stringify(result, null, 2));
  const holdMs = Number(process.env.TABLOOM_HOLD_MS ?? 0);
  if (holdMs > 0) await new Promise((resolve) => setTimeout(resolve, holdMs));
  if (result.status !== "supported") {
    process.exitCode = 1;
  }
} finally {
  await browser.close();
  await server.close();
}
