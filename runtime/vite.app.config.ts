import { defineConfig, type Plugin } from "vite";
import fs from "node:fs";
import path from "node:path";
import sirv from "sirv";
import { copyDirectory, copyFiles, runtimeAssetHeaders } from "./build/asset-config";

const packageRoot = path.resolve(import.meta.dirname);
const repoRoot = path.resolve(packageRoot, "..");
const fixtureRoot = path.join(repoRoot, "runtime/tests/fixtures/workbench/v1");
const duckdbRoot = path.join(packageRoot, "node_modules/@duckdb/duckdb-wasm/dist");
const ortRoot = path.join(packageRoot, "node_modules/onnxruntime-web/dist");
const tabpfnRoot = path.join(repoRoot, "artifacts/tabpfn35/shared-weights-dynamic-fp16-storage");

function setAssetHeaders(response: { setHeader: (name: string, value: string) => void }, filePath?: string): void {
  for (const [name, value] of Object.entries(runtimeAssetHeaders)) response.setHeader(name, value);
  if (filePath?.endsWith(".wasm")) response.setHeader("Content-Type", "application/wasm");
  else if (filePath?.endsWith(".onnx") || filePath?.endsWith(".data")) response.setHeader("Content-Type", "application/octet-stream");
  else if (filePath?.endsWith(".mjs") || filePath?.endsWith(".js")) response.setHeader("Content-Type", "text/javascript");
}

function selectedAssets(): readonly { readonly source: string; readonly destination: string; readonly files: readonly string[] }[] {
  return [
    { source: duckdbRoot, destination: "runtime-assets/duckdb", files: ["duckdb-browser-mvp.worker.js", "duckdb-mvp.wasm"] },
    { source: ortRoot, destination: "runtime-assets/ort", files: ["ort-wasm-simd-threaded.wasm", "ort-wasm-simd-threaded.mjs"] },
    { source: path.join(repoRoot, "artifacts/tabpfn35/shared-weights"), destination: "runtime-assets/tabpfn35/fp32", files: ["tabpfn35-context-dynamic.onnx", "tabpfn35-predict-dynamic.onnx", "tabpfn35-shared.data"] },
    { source: tabpfnRoot, destination: "runtime-assets/tabpfn35/fp16-storage-fp32-compute", files: ["tabpfn35-context-dynamic.onnx", "tabpfn35-predict-dynamic.onnx", "tabpfn35-shared.data"] },
  ];
}

function workbenchAssets(): Plugin {
  return {
    name: "tabloom-workbench-assets",
    configureServer(server) {
      const middleware = sirv(fixtureRoot, { dev: true, setHeaders: (response) => { for (const [name, value] of Object.entries(runtimeAssetHeaders)) response.setHeader(name, value); } });
      server.middlewares.use("/runtime-fixtures/workbench/v1", middleware);
      for (const asset of selectedAssets()) server.middlewares.use(`/${asset.destination}`, sirv(asset.source, { dev: true, setHeaders: (response, filePath) => setAssetHeaders(response, filePath) }));
    },
    closeBundle() {
      const destination = path.resolve(packageRoot, "dist-app/runtime-fixtures/workbench/v1");
      // The package is deliberately small and contains no model weights. Copy
      // only the fixture tree, never artifacts/ or the existing golden sets.
      copyDirectory(fixtureRoot, destination);
      if (!fs.existsSync(path.join(destination, "manifest.json"))) throw new Error("Workbench fixture manifest is missing");
      for (const asset of selectedAssets()) {
        for (const file of asset.files) if (!fs.existsSync(path.join(asset.source, file))) throw new Error(`Selected workbench asset is missing: ${path.join(asset.source, file)}`);
        copyFiles(asset.source, path.resolve(packageRoot, "dist-app", asset.destination), asset.files);
      }
    },
  };
}

export default defineConfig({
  root: path.join(packageRoot, "app"),
  base: process.env.VITE_APP_BASE ?? "/",
  server: { host: "127.0.0.1", port: 4176, strictPort: true, headers: { "Cross-Origin-Embedder-Policy": "require-corp", "Cross-Origin-Opener-Policy": "same-origin" }, fs: { allow: [repoRoot, packageRoot] } },
  preview: { host: "127.0.0.1", port: 4176, strictPort: true, headers: { "Cross-Origin-Embedder-Policy": "require-corp", "Cross-Origin-Opener-Policy": "same-origin" } },
  worker: { format: "es" },
  plugins: [workbenchAssets()],
  build: { outDir: path.resolve(packageRoot, "dist-app"), emptyOutDir: true, rollupOptions: { input: path.join(packageRoot, "app/index.html") } },
});
