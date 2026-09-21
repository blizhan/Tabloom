import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "../tests/fixtures/workbench/v1/normal");
const port = Number(process.env.WORKBENCH_SOURCE_PORT ?? "4177");
const counts = new Map();
const body = async (file) => fs.readFile(path.join(root, file));
function reply(response, status, contentType, bytes, headers = {}) { const merged = { "Content-Type": contentType, "Content-Length": bytes.byteLength, "Access-Control-Allow-Origin": "*", ...headers }; for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key]; response.writeHead(status, merged); response.end(bytes); }
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
  counts.set(url.pathname, (counts.get(url.pathname) ?? 0) + 1);
  if (request.method === "OPTIONS") return reply(response, 204, "text/plain", new Uint8Array(), { "Access-Control-Allow-Methods": "GET,OPTIONS", "Access-Control-Allow-Headers": "*" });
  if (url.pathname === "/__reset") { counts.clear(); return reply(response, 200, "application/json", Buffer.from(JSON.stringify({ ok: true }))); }
  if (url.pathname === "/__counts") return reply(response, 200, "application/json", Buffer.from(JSON.stringify(Object.fromEntries(counts))));
  if (url.pathname === "/forbidden") return reply(response, 403, "text/plain", Buffer.from("forbidden"));
  if (url.pathname === "/expired") return reply(response, 410, "text/plain", Buffer.from("expired"));
  if (url.pathname === "/no-cors") return reply(response, 200, "text/plain", Buffer.from("same-origin only"), { "Access-Control-Allow-Origin": undefined });
  if (url.pathname === "/timeout") return setTimeout(() => reply(response, 200, "text/plain", Buffer.from("late")), 5000);
  if (url.pathname === "/truncated") return reply(response, 200, "text/csv", Buffer.from("source_row_id\nwb-v1-truncated\n"), { "Content-Length": "999999" });
  if (url.pathname === "/json") { const bytes = await body("predict.json"); return reply(response, 200, "application/json", bytes); }
  if (url.pathname === "/json/nested") { const bytes = await body("predict.json"); return reply(response, 200, "application/json", Buffer.from(JSON.stringify({ rows: JSON.parse(bytes.toString()) }))); }
  const file = url.pathname === "/train.csv" ? "train.csv" : url.pathname === "/predict.csv" ? "predict.csv" : url.pathname === "/train.json" ? "train.json" : url.pathname === "/predict.json" ? "predict.json" : url.pathname === "/train.arrow" ? "train.arrow" : url.pathname === "/predict.arrow" ? "predict.arrow" : url.pathname === "/train.parquet" ? "train.parquet" : url.pathname === "/predict.parquet" ? "predict.parquet" : undefined;
  if (file) {
    const bytes = await body(file);
    const contentType = file.endsWith(".json") ? "application/json" : file.endsWith(".arrow") ? "application/vnd.apache.arrow.file" : file.endsWith(".parquet") ? "application/octet-stream" : "text/csv";
    const range = request.headers.range;
    if (range) { const match = /bytes=(\d+)-(\d*)/.exec(range); if (match) { const start = Number(match[1]); const end = match[2] ? Number(match[2]) : bytes.length - 1; const chunk = bytes.subarray(start, Math.min(end + 1, bytes.length)); return reply(response, 206, contentType, chunk, { "Content-Range": `bytes ${start}-${start + chunk.length - 1}/${bytes.length}`, "Accept-Ranges": "bytes" }); } }
    return reply(response, 200, contentType, bytes, { "Accept-Ranges": "bytes" });
  }
  return reply(response, 404, "text/plain", Buffer.from("not found"));
});
server.listen(port, "127.0.0.1", () => console.log(JSON.stringify({ port, baseUrl: `http://127.0.0.1:${port}`, endpoints: ["/train.csv", "/predict.csv", "/json", "/json/nested", "/forbidden", "/expired", "/timeout", "/truncated", "/__counts", "/__reset"] })));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
