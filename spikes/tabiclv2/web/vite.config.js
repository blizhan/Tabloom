import { fileURLToPath } from "node:url";
import path from "node:path";
import { defineConfig } from "vite";
import sirv from "sirv";

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, "../../..");
const modelDir = path.join(repositoryRoot, "artifacts/tabiclv2");
const fixtureDir = path.join(repositoryRoot, "artifacts/tabiclv2/web-fixture");
const ortDistDir = path.join(here, "node_modules/onnxruntime-web/dist");

export default defineConfig({
  server: {
    host: "127.0.0.1",
    port: 4174,
    strictPort: true,
    headers: {
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Opener-Policy": "same-origin",
    },
  },
  plugins: [{
    name: "tabicl-spike-artifacts",
    configureServer(server) {
      server.middlewares.use("/model", sirv(modelDir, { dev: true, etag: true }));
      server.middlewares.use("/fixture", sirv(fixtureDir, { dev: true, etag: true }));
      server.middlewares.use("/ort", sirv(ortDistDir, { dev: true, etag: true }));
    },
  }],
});
