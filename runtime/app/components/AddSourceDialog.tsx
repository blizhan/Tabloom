export type SourceInputKind = "file" | "url" | "json";
export type SourceFormatChoice = "csv" | "parquet" | "arrow" | "json" | "duckdb";
export interface AddSourceInput { readonly kind: SourceInputKind; readonly name: string; readonly url?: string; readonly jsonPath?: string; readonly format: SourceFormatChoice; readonly file?: File; }

export function validateAddSourceInput(input: AddSourceInput): string | undefined {
  if (!input.name.trim()) return "请输入表名";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(input.name.trim())) return "数据源名只能包含字母、数字和下划线，并且不能以数字开头";
  if (input.name.trim().toLowerCase() === "dataset" || input.name.trim().toLowerCase().startsWith("__tabloom_")) return "这个名称是工作台保留名称，请换一个数据源名";
  if (input.format === "duckdb") return "DuckDB 文件暂不能直接作为数据源，请先导出为 Parquet 或 CSV";
  if (input.kind === "url") {
    if (!input.url?.trim()) return "请输入 URL";
    try { const parsed = new URL(input.url); if (!["http:", "https:"].includes(parsed.protocol)) return "URL 必须使用 HTTP 或 HTTPS"; }
    catch { return "URL 格式无效"; }
  }
  if (input.kind === "file" && !input.file) return "请选择本地文件";
  if (input.kind === "json" && input.jsonPath && !/^\$(?:\.[A-Za-z_$][\w$-]*)*$/.test(input.jsonPath)) return "JSON 路径必须以 $ 开头并使用点号路径";
  if (input.format === "json" && input.kind === "file" && input.file && !/\.json$/i.test(input.file.name)) return "JSON 格式需要选择 .json 文件";
  return undefined;
}

export function renderAddSourceDialog(): string {
  return `<dialog id="source-dialog" aria-labelledby="source-dialog-title"><form id="source-form" method="dialog">
    <div class="dialog-heading"><div><span class="eyebrow">SOURCE</span><h2 id="source-dialog-title">添加数据源</h2></div><button type="button" id="close-source-dialog" aria-label="关闭">×</button></div>
    <label>入口类型<select id="source-kind" name="kind"><option value="file">本地文件</option><option value="url">远端 URL</option><option value="json">JSON 行数组</option></select></label>
    <label>数据源名<input id="source-name" name="name" required placeholder="weather_example" autocomplete="off" /></label>
    <label id="source-file-row">文件<input id="source-file" name="file" type="file" accept=".csv,.json,.parquet,.arrow,.duckdb" /></label>
    <label id="source-url-row" hidden>URL<input id="source-url" name="url" type="url" placeholder="https://example.test/data.csv" autocomplete="off" /></label>
    <label>格式<select id="source-format" name="format"><option value="csv">CSV</option><option value="parquet">Parquet</option><option value="arrow">Arrow IPC</option><option value="json">JSON</option><option value="duckdb" disabled>DuckDB</option></select></label>
    <label id="source-json-path-row" hidden>JSON 行数组路径<input id="source-json-path" name="jsonPath" value="$" placeholder="$.rows" /></label>
    <div class="example-source"><span class="eyebrow">QUICK START</span><strong>没有数据文件？</strong><p class="hint">加载内置天气示例，一次生成 Dataset 和默认 80 / 20 切分。</p><button type="button" id="load-example">加载示例数据</button></div>
    <p id="source-error" class="form-error" role="alert" hidden></p><div class="dialog-actions"><button type="button" id="cancel-source-dialog">取消</button><button type="submit" class="primary">导入</button></div>
  </form></dialog>`;
}

export function readAddSourceInput(form: HTMLFormElement): AddSourceInput {
  const values = new FormData(form);
  return { kind: String(values.get("kind") || "file") as SourceInputKind, name: String(values.get("name") || "").trim(), url: String(values.get("url") || "").trim() || undefined, jsonPath: String(values.get("jsonPath") || "$").trim() || "$", format: String(values.get("format") || "csv") as SourceFormatChoice, file: (values.get("file") instanceof File && (values.get("file") as File).size > 0) ? values.get("file") as File : undefined };
}
