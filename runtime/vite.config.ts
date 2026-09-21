import { defineConfig } from "vite";
import path from "node:path";
import fs from "node:fs";
import sirv from "sirv";

function copyRuntimeAssets() {
  const packageRoot = path.resolve("node_modules");
  const duckdbRoot = path.join(packageRoot, "@duckdb/duckdb-wasm/dist");
  const ortRoot = path.join(packageRoot, "onnxruntime-web/dist");
  const tabiclRoot = path.resolve("..", "artifacts", "tabiclv2");
  const caseGoldenRoot = path.join(tabiclRoot, "case-golden");
  const tabpfnRoot = path.resolve("..", "artifacts", "tabpfn35");
  const tabpfnGoldenRoot = path.join(tabpfnRoot, "estimator-golden");
  const tabpfnContextChainRoot = path.join(tabpfnRoot, "context-chain", "web-fixture");
  const workbenchFixtureRoot = path.resolve("tests", "fixtures", "workbench", "v1");
  const tabpfnFp16Root = path.join(tabpfnRoot, "shared-weights-dynamic-fp16-storage");
  const tabpfnFp32Root = path.join(tabpfnRoot, "shared-weights");
  const addBinaryMimeMiddleware = (server: { middlewares: { use: (handler: (request: { url?: string }, response: { setHeader: (name: string, value: string) => void }, next: () => void) => void) => void } }) => {
    server.middlewares.use((request, response, next) => {
      const pathname = (request.url ?? "").split("?", 1)[0];
      if (pathname.endsWith(".onnx") || pathname.endsWith(".onnx.data") || pathname.endsWith(".data") || pathname.endsWith(".f32")) response.setHeader("Content-Type", "application/octet-stream");
      next();
    });
  };
  const mountDevAssets = (server: { middlewares: { use: (prefix: string, handler: ReturnType<typeof sirv>) => void } }) => {
    // Vite's SPA fallback turns an unresolved `/node_modules/...` request
    // into index.html.  That is valid for a page, but a DuckDB worker then
    // fails with `Unexpected token '<'`.  Mount the pinned package assets
    // explicitly so dev and production use the same URLs and MIME types.
    const assetHeaders = (response: { setHeader: (name: string, value: string) => void }) => {
      response.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      response.setHeader("Access-Control-Allow-Origin", "*");
    };
    server.middlewares.use("/runtime-assets/duckdb", sirv(duckdbRoot, { dev: true, setHeaders: assetHeaders }));
    server.middlewares.use("/runtime-assets/ort", sirv(ortRoot, { dev: true, setHeaders: assetHeaders }));
    // The published Case is immutable and artifact-bound.  Expose only the
    // two manifest-selected graph directories and its checked fixture files;
    // Vite's SPA fallback must never answer one of these requests.
    server.middlewares.use("/runtime-assets/tabiclv2/fp32", sirv(path.join(tabiclRoot, "onnx"), { dev: true, setHeaders: assetHeaders }));
    server.middlewares.use("/runtime-assets/tabiclv2/fp16-storage-fp32-compute", sirv(path.join(tabiclRoot, "optimized"), { dev: true, setHeaders: assetHeaders }));
    server.middlewares.use("/runtime-fixtures/tabiclv2/case-golden", sirv(caseGoldenRoot, { dev: true, setHeaders: assetHeaders }));
    server.middlewares.use("/runtime-assets/tabpfn35/fp16-storage-fp32-compute", sirv(tabpfnFp16Root, { dev: true, setHeaders: assetHeaders }));
    server.middlewares.use("/runtime-assets/tabpfn35/fp32", sirv(tabpfnFp32Root, { dev: true, setHeaders: assetHeaders }));
    server.middlewares.use("/runtime-fixtures/tabpfn35/estimator-golden", sirv(tabpfnGoldenRoot, { dev: true, setHeaders: assetHeaders }));
    server.middlewares.use("/runtime-fixtures/tabpfn35/context-chain", sirv(tabpfnContextChainRoot, { dev: true, setHeaders: assetHeaders }));
    server.middlewares.use("/runtime-fixtures/workbench/v1", sirv(workbenchFixtureRoot, { dev: true, setHeaders: assetHeaders }));
  };
  return {
    name: "tabloom-copy-runtime-assets",
    configureServer(server: Parameters<typeof mountDevAssets>[0]) {
      addBinaryMimeMiddleware(server);
      mountDevAssets(server);
    },
    configurePreviewServer(server: Parameters<typeof mountDevAssets>[0]) {
      addBinaryMimeMiddleware(server);
    },
    closeBundle() {
      const distRoot = path.resolve("dist-harness");
      const outputRoot = path.join(distRoot, "runtime-assets");
      fs.mkdirSync(path.join(outputRoot, "duckdb"), { recursive: true });
      fs.mkdirSync(path.join(outputRoot, "ort"), { recursive: true });
      for (const file of ["duckdb-browser-mvp.worker.js", "duckdb-browser-coi.worker.js", "duckdb-browser-coi.pthread.worker.js", "duckdb-mvp.wasm", "duckdb-coi.wasm"]) {
        fs.copyFileSync(path.join(duckdbRoot, file), path.join(outputRoot, "duckdb", file));
      }
      for (const file of fs.readdirSync(ortRoot).filter((name) => name.startsWith("ort-wasm") && (name.endsWith(".wasm") || name.endsWith(".mjs")))) {
        fs.copyFileSync(path.join(ortRoot, file), path.join(outputRoot, "ort", file));
      }
      const tabpfnOutput = path.join(outputRoot, "tabpfn35");
      fs.mkdirSync(path.join(tabpfnOutput, "fp32"), { recursive: true });
      fs.mkdirSync(path.join(tabpfnOutput, "fp16-storage-fp32-compute"), { recursive: true });
      for (const [sourceRoot, destinationRoot] of [[tabpfnFp32Root, path.join(tabpfnOutput, "fp32")], [tabpfnFp16Root, path.join(tabpfnOutput, "fp16-storage-fp32-compute")]] as const) {
        for (const file of ["tabpfn35-context-dynamic.onnx", "tabpfn35-predict-dynamic.onnx", "tabpfn35-shared.data"]) fs.copyFileSync(path.join(sourceRoot, file), path.join(destinationRoot, file));
      }
      const tabiclOutput = path.join(outputRoot, "tabiclv2");
      fs.mkdirSync(path.join(tabiclOutput, "fp32"), { recursive: true });
      fs.mkdirSync(path.join(tabiclOutput, "fp16-storage-fp32-compute"), { recursive: true });
      for (const [source, destination] of [
        [path.join(tabiclRoot, "onnx", "tabiclv2-kv-dynamic.onnx"), path.join(tabiclOutput, "fp32", "tabiclv2-kv-dynamic.onnx")],
        [path.join(tabiclRoot, "onnx", "tabiclv2-kv-dynamic.onnx.data"), path.join(tabiclOutput, "fp32", "tabiclv2-kv-dynamic.onnx.data")],
        [path.join(tabiclRoot, "optimized", "tabiclv2-kv-dynamic-fp16-storage.onnx"), path.join(tabiclOutput, "fp16-storage-fp32-compute", "tabiclv2-kv-dynamic-fp16-storage.onnx")],
        [path.join(tabiclRoot, "optimized", "tabiclv2-kv-dynamic-fp16-storage.onnx.data"), path.join(tabiclOutput, "fp16-storage-fp32-compute", "tabiclv2-kv-dynamic-fp16-storage.onnx.data")],
      ] as const) fs.copyFileSync(source, destination);
      const fixtureOutput = path.join(distRoot, "runtime-fixtures", "tabiclv2", "case-golden");
      fs.mkdirSync(fixtureOutput, { recursive: true });
      for (const file of fs.readdirSync(caseGoldenRoot)) fs.copyFileSync(path.join(caseGoldenRoot, file), path.join(fixtureOutput, file));
      const estimatorGoldenOutput = path.join(distRoot, "runtime-fixtures", "tabpfn35", "estimator-golden");
      fs.mkdirSync(estimatorGoldenOutput, { recursive: true });
      for (const file of fs.readdirSync(tabpfnGoldenRoot)) fs.copyFileSync(path.join(tabpfnGoldenRoot, file), path.join(estimatorGoldenOutput, file));
      const contextChainOutput = path.join(distRoot, "runtime-fixtures", "tabpfn35", "context-chain");
      fs.mkdirSync(contextChainOutput, { recursive: true });
      for (const file of fs.readdirSync(tabpfnContextChainRoot)) fs.copyFileSync(path.join(tabpfnContextChainRoot, file), path.join(contextChainOutput, file));
      const workbenchOutput = path.join(distRoot, "runtime-fixtures", "workbench", "v1");
      fs.cpSync(workbenchFixtureRoot, workbenchOutput, { recursive: true });
    },
  };
}

export default defineConfig({
  // Serve the validation harness at `/` in dev as well as in the built
  // bundle.  Keeping the root at the repository package made Vite return a
  // 404 for `/` (the page lived at `/harness/index.html`), which in turn
  // caused the browser runner to report a misleading server-start failure.
  root: path.resolve("harness"),
  server: {
    host: "127.0.0.1",
    port: 4175,
    strictPort: true,
    headers: {
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Opener-Policy": "same-origin",
    },
    fs: { allow: [path.resolve(".."), path.resolve(".")] },
  },
  preview: {
    host: "127.0.0.1",
    port: 4175,
    strictPort: true,
    headers: {
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Opener-Policy": "same-origin",
    },
  },
  worker: { format: "es" },
  plugins: [copyRuntimeAssets()],
  build: { outDir: path.resolve("dist-harness"), emptyOutDir: true, rollupOptions: { input: path.resolve("harness/index.html") } },
});
