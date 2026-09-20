import { fileURLToPath } from "node:url";
import path from "node:path";
import { defineConfig } from "vite";
import sirv from "sirv";

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, "../../..");
const modelDir = path.join(repositoryRoot, "artifacts/tabpfn35/onnx");
const kvModelDir = path.join(repositoryRoot, "artifacts/tabpfn35/kv-cache/onnx");
const kvOptimizedDir = path.join(repositoryRoot, "artifacts/tabpfn35/optimized");
const kvFixtureDir = path.join(repositoryRoot, "artifacts/tabpfn35/kv-cache/web-fixture");
const contextModelDir = path.join(repositoryRoot, "artifacts/tabpfn35/context-build/onnx");
const contextFixtureDir = path.join(repositoryRoot, "artifacts/tabpfn35/context-build/web-fixture");
const contextChainFixtureDir = path.join(repositoryRoot, "artifacts/tabpfn35/context-chain/web-fixture");
const dynamicContextPredictionDir = path.join(repositoryRoot, "artifacts/tabpfn35/dynamic-context-predict/onnx");
const sharedDynamicFp16Dir = path.join(
  repositoryRoot,
  "artifacts/tabpfn35/shared-weights-dynamic-fp16-storage",
);
const ortDistDir = path.join(here, "node_modules/onnxruntime-web/dist");

export default defineConfig({
  server: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
    headers: {
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Opener-Policy": "same-origin",
    },
  },
  plugins: [
    {
      name: "tabpfn-spike-artifacts",
      configureServer(server) {
        server.middlewares.use("/model", sirv(modelDir, { dev: true, etag: true }));
        server.middlewares.use("/kv-model", sirv(kvModelDir, { dev: true, etag: true }));
        server.middlewares.use("/kv-optimized", sirv(kvOptimizedDir, { dev: true, etag: true }));
        server.middlewares.use("/kv-fixture", sirv(kvFixtureDir, { dev: true, etag: true }));
        server.middlewares.use("/context-model", sirv(contextModelDir, { dev: true, etag: true }));
        server.middlewares.use("/context-fixture", sirv(contextFixtureDir, { dev: true, etag: true }));
        server.middlewares.use("/context-chain-fixture", sirv(contextChainFixtureDir, { dev: true, etag: true }));
        server.middlewares.use("/dynamic-context-predict", sirv(dynamicContextPredictionDir, { dev: true, etag: true }));
        server.middlewares.use("/shared-dynamic-fp16", sirv(sharedDynamicFp16Dir, { dev: true, etag: true }));
        server.middlewares.use("/ort", sirv(ortDistDir, { dev: true, etag: true }));
      },
    },
  ],
});
