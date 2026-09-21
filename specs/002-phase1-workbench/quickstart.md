# Quickstart — Phase 1 验证指南

本文件是 Phase 1 当前实现与验收契约。固定 v1 数据包、锁定校验命令、数据/实验持久化、独立工作台构建入口和真实 TabPFN 四组合验收均已提交。数据结构和详细预期见 [fixtures 契约](contracts/fixtures.md)，流程及错误见 [workbench 契约](contracts/workbench.md)。命令均从仓库根执行。

## 前提

- Node 22（当前 22.22.3）、npm 10；支持 module Worker、WASM、IndexedDB 的桌面 Chromium，真实 WebGPU 验收需可用硬件 GPU。
- 模型资产按现有 `runtime/README.md` 准备，权重和 ONNX 大文件不随测试数据包提交。首次模型下载需要网络或本地已准备资产；用户使用工作台无需 Python。
- 生成新数据/独立参考的维护者需要 uv、Python 3.12、数据工具锁定依赖及官方 TabPFN 环境和对应权重。浏览器测试直接使用提交的 v1 文件；完整五格式数据检查需要锁定的原生数据工具环境，但不需要模型权重或官方 TabPFN 环境。
- localhost 或 HTTPS。若使用外部 Chromium，沿用 runner 的 `TABLOOM_CHROMIUM`，有头 GPU 环境沿用 `TABLOOM_HEADLESS=0`、`TABLOOM_DISPLAY` 与所需 XAUTHORITY。测试报告记录实际 browser/provider，不将软件渲染当硬件 WebGPU。

## 现有基线命令

```bash
npm --prefix runtime ci
npm --prefix runtime run typecheck
npm --prefix runtime test
npm --prefix runtime run fixtures:prepare
npm --prefix runtime run test:browser -- --suite integration --provider wasm
```

`fixtures:prepare` 检查的是旧运行时资产，不生成 Phase 1 数据。缺少大模型资产时按 runtime README 准备，禁止自动改用 fake/线性 adapter 来通过 integration。当前本地回归为 96 项通过；模型相关命令在缺少官方资产时会保留 `not-run` 证据，本次验收使用已校验的 TabPFN 3.5 checkpoint 和 NVIDIA GB10。

## 数据准备与检查

首次维护者生成先准备独立工具环境，并将官方参考 Python 与权重路径显式传给 wrapper：

```bash
uv sync --project tools/workbench-fixtures --frozen
uv sync --project spikes/tabpfn35 --frozen
WORKBENCH_REFERENCE_PYTHON=spikes/tabpfn35/.venv/bin/python WORKBENCH_MODEL_PATH=.cache/models/tabpfn-v3.5-20260909.safetensors npm --prefix runtime run fixtures:workbench
npm --prefix runtime run fixtures:workbench:check
```

wrapper 的路径参数以仓库根解析；权重路径应替换为实际已授权且校验匹配的文件。生成数据使用 tools/workbench-fixtures 的环境，官方模型仅用 spike 环境，两者不混用。缺权重或 reference 环境应明确失败，不写入标记完整但缺参考的数据包。

期望：提交的 v1 包 ≤10 MiB；train 256 行、predict 32 行，四个特征；五种格式逻辑一致；未来真值独立；八类边界用例和 SQL/统计/官方 mean 参考齐全。check 不运行模型、不修改 expected，失败必须非零退出。生成后先审查数据/版本/参考差异再提交，不自动覆盖基线。

仅校验已有数据时，无需生成参考：

```bash
uv sync --project tools/workbench-fixtures --frozen
npm --prefix runtime run fixtures:workbench:check
```

check 调用原生五格式读取器，不启动工作台、不加载模型、不联网、不修改 expected；缺环境明确失败。浏览器 DuckDB 支持与文件自身正确性分开判定。

Setup 后并行准备数据与运行时基础；正常文件和真实数据库 executor 就绪后，先运行 `npm --prefix runtime run test:workbench -- --suite duckdb-file`。四项操作有明确结论且原件不变即可通过 probe，不要求全部支持。最终 manifest/校验和产品集成等待结论；文件或写入器变化后重生成摘要并校验。

## 启动工作台

```bash
npm --prefix runtime run typecheck:app
npm --prefix runtime run dev:app
```

约定产品开发地址为 `http://127.0.0.1:4176/`，原 harness 保留 4175。打开后加载训练/预测测试数据；模型资产准备好后点击“运行真实预测”，结果会发布为 DuckDB SQL 表；即使模型不可用，导入和只读 SQL 仍可独立使用。

1. 导入 train/predict，逐项核对目录、schema、行数和统计。正常样本空值数为零。
2. 使用数据包示例 SQL，训练选目标 demand_mwh，特征依次选择 temperature_c、wind_speed_ms、solar_wm2、hour_utc。预览显示完整总行数，预测表无目标真值。
3. 选择 TabPFN 3.5 数值回归与显式 provider，运行。查看下载、初始化、context、预测和发布各阶段；产生 32 行有限 mean，与官方独立参考满足固定预算。
4. 使用关联和聚合 SQL 查询结果。改用重复业务键/行重排变体，仍需与实际输入逐行准确对应。
5. 分别导出 CSV/Parquet/Arrow 及元数据，重新导入检查行身份、空值与数值；CSV 使用随附 schema，另以空值/空字符串和精度边界表验证类型保真。
6. 保存实验，关闭并重开：快照、SQL、模型版本和特征配置恢复；相同完整缓存模型/数据零内容下载，允许数据库重新注册和模型初始化。

## 自动验收

```bash
npm --prefix runtime run fixtures:workbench:check
npm --prefix runtime run test:workbench -- --suite data
npm --prefix runtime run test:workbench -- --suite flow --provider wasm --precision fp32
npm --prefix runtime run test:workbench -- --suite flow --provider wasm --precision fp16-storage
npm --prefix runtime run test:workbench -- --suite flow --provider webgpu --precision fp32
npm --prefix runtime run test:workbench -- --suite flow --provider webgpu --precision fp16-storage
npm --prefix runtime run test:workbench -- --suite model-cache --provider wasm --precision fp16-storage
npm --prefix runtime run test:workbench -- --suite responsiveness --provider webgpu --precision fp16-storage
npm --prefix runtime run test:workbench -- --suite app-flow
npm --prefix runtime run build:app
npm --prefix runtime run test:workbench -- --suite built-assets
```

`data` 校验固定包并可在无模型环境运行；受控第二 origin 可通过 `npm --prefix runtime run workbench:source-server` 启动，远端 API 的单元边界由 `remote-source.ts` 覆盖。数据库文件 probe 输出 open/attach/read/write 各项结果和原件前后校验；unsupported 必须有原因与证据。

flow/model-cache/responsiveness 的 provider 和 precision 均为必填。flow 执行四种组合，每次校验实际 provider、精度、匹配 manifest 和权重摘要，分别保存 `flow-<provider>-<precision>.json`。缺资产/设备记 not-run，不能计为通过；当前报告四种组合均为 passed。`app-flow` 通过当前 Chromium 点击页面按钮，验证 32 行真实结果已发布到 SQL 表。

`flow` 使用真实 model Worker，不允许产品默认 fallback；检查 reference、预测 SQL 表、无业务键/重复键/重排以及失败发布回滚。数据库注册故障后旧结果必须仍是当前结果；返回错误 ordinal、迟到 generation 和取消结果不得发布。

`data` 不加载模型，只覆盖数据快照/实验定义恢复和缓存损坏/容量不足/清理/重选文件；显式刷新生成新版本，旧实验不能被悄悄重绑定。同名表替换必须确认。缺失 executor、模型任务不可用、查询错误与导出失败均有明确用户提示。

`model-cache` 需要真实模型资产及可用 provider，首次缓存后关闭并重开同一浏览器存储，验证零模型内容下载、损坏恢复和独立 mean。禁用或排除 HTTP 缓存影响，不将 HTTP 缓存命中冒充应用持久缓存；重新初始化允许。分别保存 `persistence-data.json` 与 `model-cache-<provider>-<precision>.json`，共同证明 SC-006。

远端导入默认总超时 120 秒（从请求到响应体完成），响应流累计上限 64 MiB（67108864 字节），不是数据库或模型内存上限。配置启动时注入且必须为有限正整数，测试注入小值覆盖恰好上限、超 1 字节、缺 Content-Length、读取中超时及取消竞争；SOURCE_TIMEOUT/SOURCE_TOO_LARGE 必须清理未完成内容并保留旧表。

`responsiveness` 在加载、可控长查询、真实预测三阶段分别触发 10 次面板切换或取消，记录每次反馈时间，全部 ≤1 秒。任务过短时使用独立可控延时验证“忙碌状态”交互，同时保留真实模型路径的事件记录；不能将模拟计算耗时写成真实推理耗时。

`built-assets` 从 dist-app 启动静态预览，检查根路径与非根 base、正确 MIME、无 SPA fallback 伪装资产、worker/WASM/权重按需加载。断网重启测试在 app 资源仍可本地提供的条件下验证缓存，不能将“数据/模型已缓存”等同于完整 PWA 离线安装。

## 验收证据与通过标准

报告输出到 `artifacts/workbench/acceptance/`；可追溯的命令、版本、支持矩阵和结果摘要应写入交付说明。每项明确 passed/failed/not-run/unsupported，跳过不算通过。

| 标准 | 必需证据 |
| --- | --- |
| SC-001 | 完整流程、32 行、实际 SQL 表与零错误关联 |
| SC-002 | 五格式一致、三格式往返、NULL/精度/身份验证 |
| SC-003 | 数据包清单、摘要、≤10 MiB、256/32/4 与八类输入 |
| SC-004 | 独立 mean、权重/输入/配置身份、32 行误差与时间泄漏检查 |
| SC-005 | 设备/provider、三阶段共 30 次逐次反馈延迟 |
| SC-006 | 重启零数据/模型下载，缓存失败/刷新与固定版本 |
| SC-007 | 数据/模型能力矩阵、异常提示、同名确认与发布回滚 |

新数据参考预算 FP32 ≤0.0001 MWh、FP16-storage ≤0.002 MWh；本次 checkpoint/reference 已生成并在 WASM/WebGPU 四组合通过。真实模型闭环、必需格式或任一 SC 失败时不能标记完成；仅 DuckDB 文件等规格允许的能力可用有证据的受限结论验收。
