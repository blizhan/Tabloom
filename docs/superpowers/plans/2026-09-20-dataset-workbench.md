# Dataset Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现数据源 → Dataset → Train/Test → 模型 → 同行预测结果的完整浏览器工作台。

**Architecture:** 保留 DuckDB、Worker 推理和快照存储，在其上增加 Dataset 物化与确定性切分模块。视图、图表交互、数据操作各有独立边界；App 仅协调状态，成功结果原子发布。新配置兼容旧实验，不修改模型分位数算法。

**Tech Stack:** TypeScript、原生 DOM、DuckDB-WASM、Apache Arrow、ONNX Runtime Web、IndexedDB、Vite、Node test runner、Playwright-core。无需新增依赖。

**Spec:** `docs/superpowers/specs/2026-09-20-dataset-workbench-design.md`（用户已通过）。

## Global Constraints

- 沿用现有浏览器内 DuckDB、TabPFN 3.5、Worker 推理、IndexedDB 存储和深色界面，不引入服务器数据处理。
- 本次一个工作台维护一个活动 Dataset，可由多个数据源构建；不扩展为多个 Dataset 的管理平台。不增加新模型的推理实现。
- 预览最多显示 200 行，不截断模型数据。
- q25–q75 表示预测分布的四分位区间，不称为置信区间。
- Test 可包含同名目标作为真值，但该列绝不进入模型输入。
- 仅改动本请求涉及的工作台与测试，不整理其他未提交修改。
- 已有开发服务 4176 不终止；自动化另用 4186/4187，重型模型测试串行。
- 当前工作区有大量用户未提交内容，执行前按 worktree 技能检查隔离方式；新 worktree 不得遗漏现有未跟踪工作台。Git 只读时不绕过权限、不自动提交其他文件，记录限制。

## Review Focus

- 源列名包含空格、双引号或与内部名称冲突：安全引用或拒绝，不执行注入 SQL（Task 1）。
- JOIN 产生重复列名及重复行：不丢列，不将重复业务键误当唯一行标识（Task 1、5）。
- 编辑配置时异步旧任务完成：不覆盖新配置，不将旧结果标为当前（Task 3、5）。
- 缓存清单存在但数据损坏、缓存配额失败：状态不虚报已验证缓存，不妨碍有效网络加载（Task 4）。
- CSV 原始列名为 mean/q25、部分真值缺失、单行预测：输出不覆盖输入，曲线及导出仍正确（Task 5）。

## 文件边界

新增 `runtime/src/workbench/dataset-workflow.ts`：命名验证、物化、确定性切分、重叠检查。

新增 `runtime/app/source-loader.ts`：连接现有 codecs 与 DuckDB 文件接口。

新增 `runtime/src/workbench/test-results.ts`：Test 同行结果、无冲突输出名、CSV 输入结构。

新增 `runtime/src/workbench/model-asset-status.ts`：轻量缓存清单探测、资产事件类型；不在 UI 导入包含 ORT 的 worker-factory。

修改 `App.ts`、`workbench-view.ts`、`styles.css`：状态协调、完整信息结构及样式。

修改 `prediction-chart.ts`：保留渲染 API，增加交互绑定。

修改 source dialog、Worker bootstrap/client、实验存储与恢复、浏览器脚本；新增对应测试。

---

### Task 1: 数据源解码与 Dataset 边界

**Files:**
- Create: `runtime/app/source-loader.ts`
- Create: `runtime/src/workbench/dataset-workflow.ts`
- Modify: `runtime/src/data/duckdb-service.ts`
- Modify: `runtime/src/workbench/file-codecs.ts`
- Test: `runtime/tests/unit/dataset-workflow.test.ts`
- Test: `runtime/tests/contract/workbench-codecs.test.ts`

**Interfaces:**

```ts
// dataset-workflow.ts
export const DATASET_ROW_ID = "__tabloom_row_id";
export function validateSourceName(name: string): void;
export function quoteColumn(name: string): string;
export async function materializeWorkbenchDataset(
  db: DuckDbService, sql: string
): Promise<DuckDbResult>;
// source-loader.ts: decodeSource returns existing DecodedTable
export async function loadSourceBytes(
  db: DuckDbService, bytes: Uint8Array,
  format: "csv" | "json" | "arrow-ipc" | "parquet", jsonPath?: string
): Promise<DecodedTable>;
// DuckDbService: serial executor bridges
registerFileBuffer(name: string, bytes: Uint8Array): Promise<void>;
dropFile(name: string): Promise<void>;
```

- [x] 写命名及 codec 测试，断言以下行为，然后运行 `npm --prefix runtime test` 确认新增测试因缺少实现失败。

```ts
assert.throws(() => validateSourceName("dataset"));
assert.throws(() => validateSourceName("__tabloom_import"));
assert.throws(() => validateSourceName('x"; DROP TABLE x'));
assert.equal(quoteColumn('a" b'), '"a"" b"');
assert.doesNotThrow(() => validateSourceName("weather_2025"));
```

- [x] 实现安全命名；源名只允许字母/下划线起始的标识符，保留 `dataset` 和 `__tabloom_` 前缀；列名采用双引号转义。物化前调用现有只读 SQL 校验，查询结果检查重复列/内部列冲突；补稳定从 1 开始行标识。通过 staging Arrow 表加事务替换 `dataset`，失败保留旧表。查询完整结果，不追加 LIMIT。

```ts
const result = await db.query(sql);
if (!result.rows.length) throw new Error("Dataset 返回 0 行");
if (new Set(result.columns).size !== result.columns.length)
  throw new Error("Dataset 含重复列名，请使用 AS 指定唯一名称");
```

- [x] 文件桥复用 DuckDbService 的 serial 队列和 closed/transaction 检查。Parquet 使用随机内部文件名注册 bytes、可信内部 `read_parquet` 查询、finally 释放文件；用户 SQL 仍禁止外部文件函数。Arrow/CSV/JSON 复用 decodeSource；二进制分支不先 TextDecoder 解码整文件，避免大文件内存浪费。错误、布尔值、时间列、大整数按 codec 无损策略处理。
- [x] 运行测试；Task 7 的真实 DuckDB 浏览器测试补齐 Parquet、Arrow、JOIN 及重复列，不能仅用 fake executor 声称格式可用。

### Task 2: 确定性 Train / Test 切分

**Files:** Modify `dataset-workflow.ts`; Test `dataset-workflow.test.ts`。

**Interfaces:**

```ts
export type SplitPreset =
  | { mode: "ratio"; orderBy?: string }
  | { mode: "time"; column: string; cutoff: string };
export function createSplitSql(preset: SplitPreset): {
  trainingSql: string; testSql: string
};
export function inspectOverlap(train: DuckDbResult, test: DuckDbResult):
  { verifiable: boolean; overlapCount: number };
```

- [x] 先写生成 SQL 与重叠检查测试。缺失稳定 ID 返回不可验证；相同行 ID 重叠计数采用集合，重复业务键不参与判断。

```ts
const a = { columns: [DATASET_ROW_ID], rows: [{[DATASET_ROW_ID]: 1}] };
assert.deepEqual(inspectOverlap(a, a), {verifiable: true, overlapCount: 1});
assert.equal(inspectOverlap({columns: [], rows: [{}]}, a).verifiable, false);
assert.match(createSplitSql({mode: "time", column: "time", cutoff: "2025-01-02T00:00:00Z"}).testSql, />=/);
```

- [x] 比例 SQL 使用 row_number/count 窗口、floor(n*0.8)；排序为用户列 ASC NULLS LAST 加稳定 ID。内部临时 rank/count 不泄漏为候选特征。

```sql
WITH ranked AS (
 SELECT *, row_number() OVER (ORDER BY "__tabloom_row_id") AS __tabloom_rank,
 count(*) OVER () AS __tabloom_count FROM dataset
)
SELECT * EXCLUDE (__tabloom_rank, __tabloom_count) FROM ranked
WHERE __tabloom_rank <= floor(__tabloom_count * 0.8)
ORDER BY __tabloom_rank
```

- [x] 时间 SQL 对列和 cutoff 使用 TIMESTAMPTZ 转换；验证 cutoff，SQL 字符串单引号双写，非法非空时间报错。空时间计数单独展示。Test 条件是 `>=`，Train 是 `<`。执行两条 SQL 后拒绝空组；不隐式截断到模型最大行数。
- [x] 运行单测；在 Task 7 中执行真实 SQL 验证 10 行→8/2、同时间 tie、时间边界、空时间、小于 2 行和用户 LIMIT。

### Task 3: 工作台信息结构及状态整合

**Files:** Modify `runtime/app/App.ts`, `runtime/app/workbench-view.ts`, `runtime/app/styles.css`, `runtime/app/components/AddSourceDialog.tsx`, `runtime/app/components/CapabilitiesPanel.tsx`。

**Consumes:** Tasks 1–2 函数、现有 DataSnapshotStore、preparePredictionInput。

**Produces:** 下列稳定 DOM 与状态约束，供 Task 7 自动化使用。

```ts
// App 内部状态：来源、Dataset、输入、结果严格分开
type DatasetState = { snapshotId: string; sql: string; table: DuckDbResult; stale: boolean };
type PreparedInputs = { train: DuckDbResult; test: DuckDbResult; revision: number };
// configRevision 在源/SQL/列选择/模型配置变化时增加
// 后续异步发布必须满足 capturedRevision === configRevision
```

- [x] 按已读 impeccable Operate/craft-floor 执行；不要重跑本会话 context。替换页面结构：左源/导出；主 Dataset、切分页签、tags、模型、结果。删除无关联底部查询区和双示例按钮。添加数据源对话框内 `#load-example` 一次导入已有 train fixture 全部 256 行并默认构建 Dataset。
- [x] 使用以下 ID；Train/Test `role=tab`、`aria-selected`、关联 tabpanel、左右键/Home/End 切换；SQL 与折叠预览同面板。

```html
<textarea id="dataset-query" aria-label="Dataset SQL"></textarea>
<button id="build-dataset">生成 Dataset</button>
<button id="train-tab" role="tab" aria-controls="train-panel">Train</button>
<button id="test-tab" role="tab" aria-controls="test-panel">Test</button>
<!-- train-panel / test-panel 内分别放 training-query / test-query -->
<button id="prepare-input">执行 Train / Test SQL</button>
```

- [x] 单选目标用原生 radio 外包 tag，特征用 checkbox tag；保留 `[data-target]`、`[data-feature]`。特征初次准备默认选择，之后尊重空选择。源与 Dataset schema 可展示，JOIN 输入提供示例。表格最多 200 行并显示完整输入总数。
- [x] 所有修改使 prepared 失效，源/Dataset SQL 修改额外标记 Dataset stale；重建后默认重建切分预设，但不静默覆盖已有自定义 SQL（提示用户应用预设）。运行时禁用配置；异步 generation/revision 双检查防止旧任务覆盖新状态。展示验证错误、重叠警告、能力限制（32 特征/训练3–1024/Test1–1024，以实际 capabilities 为准）。
- [x] 用 `npm --prefix runtime run build:app` 验证类型和构建；此阶段按钮连接真实流程，不制作静态假状态。视觉验证统一留 Task 7。

### Task 4: 可验证的模型资产/加载状态

**Files:** Create `runtime/src/workbench/model-asset-status.ts`; Modify `runtime/src/model/tabpfn35/worker-factory.ts`, `runtime/src/workers/model-worker-bootstrap.ts`, `runtime/src/coordinator/worker-model-client.ts`, `runtime/app/App.ts`; Test `runtime/tests/contract/worker-model-client.test.ts`。

**Interfaces:**

```ts
export interface ModelAssetEvent {
  kind: "model-assets";
  precision: "fp32" | "fp16-storage-fp32-compute";
  state: "checking" | "downloading" | "available" | "failed";
  file?: string; message?: string;
}
// createTabPFN35Adapter options 增加 onAssetEvent?: (event: ModelAssetEvent) => void
// WorkerModelClientOptions 增加同签名 onAssetEvent，可在 ready 前接收
```

- [x] 先扩展 fake Worker 测试：ready 前资产事件能转发；无 requestId 不丢弃；Worker 出错、重建精度和 dispose 后事件不污染新模型状态。
- [x] 将缓存 DB/version/文件列表与 key 构造放到轻量 model-asset-status 模块。复用 IndexedDbStore.getManifest 做不读取巨型 bytes 的状态探测，UI 清楚显示“发现缓存，加载时校验”，不能称已验证。
- [x] fetchAsset 真正网络开始时发 downloading，缓存命中必须通过现有 get 的 hash 校验。所有资产到位才发 available；持久化失败与内存可用分别说明。bootstrap 转发事件并保留原始错误描述；client load 成功后才显示已加载。多个并行文件事件按文件集合聚合，不因单文件就宣称全部可用。
- [x] 主界面提供显式加载模型按钮，推理仍可懒加载。模型只有 TabPFN3.5 可选，fp16 显示“FP16 存储 / FP32 计算”；后端/精度变更释放旧上下文并使模型失效。
- [x] 跑 `npm --prefix runtime test`；Task 7 验证真实冷/暖缓存显示，不并行加载两套大模型。

### Task 5: Test 同行结果与交互曲线

**Files:** Create `runtime/src/workbench/test-results.ts`; Modify `runtime/app/App.ts`, `runtime/app/prediction-chart.ts`, `runtime/app/styles.css`; Test `runtime/tests/unit/test-results.test.ts`。

**Interfaces:**

```ts
export interface TestResultTable {
  table: DuckDbResult;
  outputColumns: { mean: string; q25: string; q75: string };
}
export function enrichTestRows(test: DuckDbResult, predictions: {
  mean: readonly number[]; q25: readonly number[]; q75: readonly number[];
}): TestResultTable;
export function bindPredictionChart(root: HTMLElement,
  points: readonly PredictionPoint[]): () => void;
```

- [x] 单测覆盖长度不匹配、非有限分位数、q25>q75 报错；输入含 `mean`/`prediction_mean` 时自动寻找唯一输出名，原列与顺序不变。mean 不必位于 IQR 内，不错误拒绝尾部分布。

```ts
const source = {columns: ["mean"], rows: [{mean: 99}]};
const result = enrichTestRows(source, {mean: [1], q25: [0], q75: [2]});
assert.equal(result.table.rows[0].mean, 99);
assert.equal(result.table.rows[0][result.outputColumns.mean], 1);
```

- [x] runModel 只提交运行时冻结的 Test 对应结果，移除 `tables.set("predictions", ...)`。输入元数据/曲线/导出共享同一成功结果对象。配置变化显示旧结果标记；失败保留旧结果与其原始描述。
- [x] 图表增加透明交互层、最近行定位、crosshair、页面内 tooltip；通过 getBoundingClientRect 与 SVG viewBox 换算，兼容缩放。键盘左右/Home/End、touch pointer 与鼠标读取同一 point；tooltip 用 textContent，离开时隐藏，提供可读标签。

```ts
const index = Math.max(0, Math.min(points.length - 1,
  Math.round(normalizedX * (points.length - 1))));
// normalizedX 使用绘图区范围，不使用整个 SVG（需减去轴边距）
```

- [x] 保留单点区间、真值断点、横轴选择和响应式现有行为；绑定返回 cleanup，在 rerender 前释放。导出左侧 `#download-results`，使用正确 CSV 编码，无结果禁用。
- [x] 单测及应用构建通过；Task 7 测 tooltip 数值、键盘、部分真值及 CSV 冲突列。

### Task 6: 实验保存/恢复/导出

**Files:** Modify `runtime/src/storage/workbench-experiment-store.ts`, `runtime/src/workbench/restore-service.ts`, `runtime/app/App.ts`; Test `runtime/tests/contract/workbench-data.test.ts`。

**Interfaces:** 现有 WorkbenchExperimentDefinition 增加可选字段；旧 predictionQuery 持久化字段暂保留避免破坏历史消费者，UI 始终称 Test。

```ts
readonly dataset?: {
  readonly version: 1;
  readonly query: string;
  readonly snapshotId: string;
  readonly splitPreset?: SplitPreset;
};
```

- [x] 写 round-trip 测试，断言 dataset/sourceBindings 深拷贝，修改返回对象不能更改内存存储；源/物化快照不存在返回明确不可恢复信息。旧 definition 无 dataset 仍可读取。
- [x] 保存所有源快照和物化 Dataset 快照，ID、schema、类型与当前 SQL 保持一致；只允许保存已生成且切分有效配置。restore 先验证所有引用，再一次替换 UI 状态，不半恢复。
- [x] 旧实验维持原始 SQL/source bindings 并显示迁移提示，不自动套80/20。新实验恢复物化 Dataset 而非重新查询可能变化的源；列/模型能力重新校验。
- [x] 左侧 `#save-experiment`、`#export-experiment`，JSON 包含 schema 版本和快照引用，明确“不包含数据和权重”；保留既有敏感参数过滤，不导出带凭据远程 URL。预测 CSV 属于 Task 5，同一左侧区域显示。
- [x] 运行单测与构建；Task 7 浏览器保存刷新恢复后再运行，检查行数、target、features、Dataset SQL 相等。

### Task 7: 集成验收、视觉检查与交接

**Files:** Modify `runtime/scripts/test-prediction-ui.mjs`, `runtime/scripts/run-workbench.mjs`, `runtime/README.md`; output existing `artifacts/workbench/`。

- [x] 更新 prediction-ui 脚本到新 DOM 流程，保留真实模型测试而不是 mock 替换：添加源→示例→Dataset256→Train204/Test52；再运行自定义 Train LIMIT64/Test LIMIT7，核对实际结果7行。

```js
await page.click("#add-source");
await page.click("#load-example");
await page.waitForFunction(() => document.querySelector("#train-count")?.textContent.includes("204"));
await page.click("#test-tab");
await page.locator("#test-preview").evaluate(node => node.open = true);
assert.match(await page.locator("#test-count").innerText(), /52/);
```

- [x] 扩展非模型浏览器场景：导入真实 Parquet/Arrow fixture、导入两源 JOIN、重复列拒绝、时间边界/空值、非法源名、预览200但输入完整、SQL错误及恢复、移动端无页面横向溢出。
- [x] 模型场景核对 mean/q25/q75 数量有限且 q25<=q75、Test 列保持不变、无 predictions 数据源；真实 tooltip 对应 CSV 同一行、键盘切点、真值缺失不填零、失败保留旧结果、配置编辑标记过期、保存刷新恢复及两类导出。
- [x] 更新 legacy app-flow/accessibility 中旧示例按钮、target select、prediction source、底部 preview 选择器；不要删除覆盖。按以下顺序串行运行并记录各命令结果：

```sh
npm --prefix runtime test
npm --prefix runtime run build:app
TABLOOM_CHROMIUM=/snap/chromium/current/usr/lib/chromium-browser/chrome TABLOOM_CAPTURE=1 npm --prefix runtime run test:prediction-ui
TABLOOM_APP_PORT=4187 TABLOOM_CHROMIUM=/snap/chromium/current/usr/lib/chromium-browser/chrome TABLOOM_HEADLESS=1 npm --prefix runtime run test:workbench -- --suite app-flow --provider wasm --precision fp32
TABLOOM_APP_PORT=4187 TABLOOM_CHROMIUM=/snap/chromium/current/usr/lib/chromium-browser/chrome TABLOOM_HEADLESS=1 npm --prefix runtime run test:workbench -- --suite accessibility --provider wasm
TABLOOM_CHROMIUM=/snap/chromium/current/usr/lib/chromium-browser/chrome TABLOOM_HEADLESS=1 npm --prefix runtime run test:workbench -- --suite flow --provider wasm --precision fp16-storage
```

- [x] 使用生成的桌面/移动截图做一次批量视觉检查，集中修正一批，再最多确认一次。运行 impeccable 检测：

```sh
/home/blizhan/.agents/skills/impeccable/scripts/impeccable detect --json runtime/app/App.ts runtime/app/workbench-view.ts runtime/app/styles.css runtime/app/prediction-chart.ts runtime/app/components/AddSourceDialog.tsx
```

- [x] README 增加新流程、SQL 输入与预览上限区别、模型行数限制、实验 JSON 不含数据说明；更新本计划勾选状态。运行 `git diff --check` 并审阅本轮涉及文件（未跟踪文件也需读取审查）。按 verification-before-completion 和 requesting-code-review 技能交接，有条件做独立审查，否则明确限制。
- [x] 最终用中文报告已完成项、实际通过的测试、未验证环境及打开 `http://127.0.0.1:4176` 的验证路径；不将本轮验收扩大为全部 Phase1 完成。

## 计划自审

设计文档的数据源/Dataset 对应 Task1，切分对应 Task2，交互和状态对应 Task3，模型对应 Task4，结果与导出 CSV 对应 Task5，保存恢复/JSON 对应 Task6，整体测试与 impeccable 检查对应 Task7。五个 Review Focus 均有明确测试所属任务。未引入新的外部服务、模型算法或图形化 JOIN 编辑器。
