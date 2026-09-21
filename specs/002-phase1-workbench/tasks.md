# Tasks: Phase 1 共享数据与实验闭环

**Input**: `specs/002-phase1-workbench/` 下的 [spec.md](spec.md)、[plan.md](plan.md)、[research.md](research.md)、[data-model.md](data-model.md)、[工作台契约](contracts/workbench.md)、[数据包契约](contracts/fixtures.md)、[quickstart.md](quickstart.md)。

**Prerequisites**: 以上设计已完成；constitution 尚为模板，不将示例原则当作约束。本文件仅生成任务，不表示任何实现或数据已交付。

**Tests**: 规格明确要求可重复测试数据、格式往返、独立预测参考、缓存与响应性验收，因此包含相应测试任务。测试先定义预期，再实现并运行；不为简单配置或文档改动另加形式化 TDD。

**Organization**: Setup →（Foundational 与 US4 数据准备并行）→ US1/P1 → US2/P1 → US3/P2 → 收尾。同为 P1 的 US4 提前，给其他故事提供固定数据；故事编号沿用 spec。每阶段完成后独立验收，不依赖后续故事才算通过。

## Format: `[ID] [P?] [Story] Description`

- 所有任务初始未勾选，ID 按推荐执行顺序连续。
- `[P]` 表示在已完成显式前置任务及阶段前提后，可与同组不同文件任务并行，不表示可跳过依赖。
- `[US1]` 至 `[US4]` 对应规格故事；共享和收尾任务不加故事标签。
- 路径相对仓库根；新文件是实施目标。多人执行时按文件分工，不覆盖其他人的修改。共享 `runtime/package.json` 与既有核心文件的修改串行合并。

## Phase 1: Setup — 共享工程入口

**Purpose**: 在现有包中建立产品与验证入口，保留原 harness，不启动功能实现。

- [X] T001 在 `runtime/package.json`、`runtime/package-lock.json`、`runtime/tsconfig.app.json` 和 `runtime/app/index.html` 增加锁定的 React 19/DOM/类型依赖与独立 TSX 编译入口，预留 `dev:app`、`build:app`、`typecheck:app`、两条 fixture 命令和 `test:workbench`；保持现有 runtime 依赖版本及原命令。
- [X] T002 从 `runtime/vite.config.ts` 提取 `runtime/build/asset-config.ts`，新增 `runtime/vite.app.config.ts`：产品端口 4176、输出 dist-app、支持构建 base，按所选模型挂载/复制必要资产和样本，保留 harness 4175、正确 MIME 与 COOP/COEP，不复制整个 golden 集合。
- [X] T003 [P] 在 `tools/workbench-fixtures/pyproject.toml`、`tools/workbench-fixtures/uv.lock` 锁定 Python 3.12、PyArrow 和原生 DuckDB 生成环境；与官方 TabPFN spike 环境分离，不依赖环境偶然安装的软件。
- [X] T004 [P] 在 `runtime/scripts/run-workbench.mjs` 与 `runtime/tests/browser/workbench-entry.ts` 建立 Playwright-core 测试调度，支持 data/duckdb-file/flow/model-cache/built-assets/responsiveness；flow/model-cache/responsiveness 必填 `--provider wasm|webgpu` 和 `--precision fp32|fp16-storage`，保留已有 Chromium 环境变量；未实现/跳过的 suite 非成功退出，报告写入 `artifacts/workbench/acceptance/summary.json` 并区分 passed/failed/not-run/unsupported。

**Checkpoint**: T001→T002；T003、T004 可在 T001/T002 完成后并行。新命令不得用空测试返回全通过。

## Phase 2: Foundational — 数据与应用公共边界

**Purpose**: 建立产品集成依赖的数据类型、Worker 通道、真实数据库和只读查询基础；US4 数据生成在 Setup 后可独立并行，文件 probe 仅额外等待 T008，US1 集成等待本阶段及 US4 完成。

- [X] T005 在 `runtime/src/workbench/types.ts`、`runtime/src/workbench/errors.ts` 定义数据模型中的 SourceDescriptor/DataSnapshot、QueryDefinition/MaterializedInput、实验 revision/Run、ExportBundle、CapabilityEvidence 和版本化错误/事件，记录 `(inputSnapshotId, rowOrdinal)` 为运行时行身份并统一映射文档中的 rowIndex，不另建第二套行序号。
- [X] T006 [P] 在 `runtime/tests/contract/workbench-data.test.ts` 定义数据/IPC 契约测试：未知协议、buffer 转移、真实 executor 缺失、空值/字符串/大整数/时间保真、只读 SQL、取消及失败不覆盖原表；只针对本期新增行为建立可失败的检查。
- [X] T007 在 `runtime/src/workers/data-protocol.ts`、`runtime/src/workers/data.worker-entry.ts`、`runtime/src/workbench/data-client.ts` 实现数据宿主与 requestId/revision/generation 响应路由，将获取、整表转换、哈希、IPC 编码移出 UI；拒绝无效消息，明确 transferable 所有权、分页响应、取消确认及关闭释放。
- [X] T008 在 `runtime/src/data/duckdb-wasm-executor.ts`、`runtime/src/data/duckdb-service.ts` 注入真实 DuckDB worker，补内部文件/Arrow IPC 注册与通用类型查询能力；在 `runtime/src/workbench/bootstrap.ts` 对缺 executor 明确失败，禁止空数组冒充查询成功，保留测试显式 fake 的边界。
- [X] T009 在 `runtime/src/workbench/source-snapshots.ts`、`runtime/src/workbench/file-codecs.ts` 实现本地 CSV/Parquet/Arrow 的类型解释、原始 SHA-256 与逻辑摘要、不可变表身份、staging 完成后注册和同名显式替换；原始列保留类型，仅选定模型列可数值化，失败不污染已导入表。
- [X] T010 在 `runtime/src/workbench/query-service.ts` 和 `runtime/tests/browser/workbench-bootstrap.ts` 实现并验证单条只读关系查询、参数绑定、CTE/JOIN/聚合、禁止直接网络/文件函数与变更语句、总行数和最多 200 行预览；验证数据库隔离/只读策略（不可用则采用设计中的隔离查询库），运行 T006 与真实浏览器 bootstrap，记录 `artifacts/workbench/acceptance/bootstrap.json`，策略未验证不得继续产品集成。

**Checkpoint**: T005 后 T006 可与 T007 并行；实现链 T007→T008→T009→T010。真实数据通道与只读策略通过，产品不再依赖空 executor；数据包生成/原生校验不等待本阶段。

## Phase 3: User Story 4 — 固定数据验收后续功能 (Priority: P1)

**Goal**: 实际交付固定版本、离线可核对的数据包和独立模型参考，成为后续功能测试共同输入。

**Independent Test**: 不启动工作台、不访问在线数据服务，在锁定的原生数据工具环境执行 `fixtures:workbench:check`；核对 256/32/4、五格式、八类边界、时间可用性、≤10 MiB 和完整 provenance。官方参考在维护者环境生成，日常校验不需要模型权重。

### Tests for User Story 4

- [X] T011 [P] [US4] 在 `runtime/tests/contract/workbench-fixtures.test.ts` 定义 manifest/schema/cases/独立 reference 契约及失败用例，要求数据损坏、漏文件、漏参考、错误时间切分或超体积返回失败，不自动重写 expected。
- [X] T012 [P] [US4] 在 `tools/workbench-fixtures/tests/test_dataset.py` 定义正常数据与变体检查，独立标量核对记录数/空值/min/max/mean/键与时间；区分五格式字节 hash 和逻辑等价，不调用待测浏览器输出生成预期。

### Implementation for User Story 4

- [X] T013 [US4] 在 `tools/workbench-fixtures/generate.py` 实现固定版本/seed 的整数或定点小时数据生成，写出 `runtime/tests/fixtures/workbench/v1/schema.json`、正常 CSV/Parquet/Arrow IPC/JSON 和 `normal/sample.duckdb`；历史 256 行、未来 32 行、4 特征及 `demand_mwh`，真值仅写 `truth/predict-targets.csv`，保留 UTC/可用时刻/源行/业务键。
- [X] T014 [US4] 在 `tools/workbench-fixtures/variants.py` 生成 empty、missing-target、missing-feature、duplicate-key、reordered、wrong-type、non-finite、over-limit 独立输入，并补 NULL/空字符串、大整数/时间往返小表；写入 `runtime/tests/fixtures/workbench/v1/cases.json`，明确错误或接受预期，标准 JSON 不写 NaN/Infinity，超限按锁定模型能力生成。
- [X] T015 [P] [US4] 在 `runtime/tests/fixtures/workbench/v1/queries/train.sql`、`predict.sql`、`join.sql`、`aggregate.sql`、`export.sql` 写可复用示例，并由 `tools/workbench-fixtures/expected_stats.py` 独立生成 `runtime/tests/fixtures/workbench/v1/expected/stats.json`；训练与预测特征顺序固定，查询不混入未来真值（依赖 T013）。
- [X] T016 [P] [US4] 新增 `spikes/tabpfn35/export_workbench_reference.py` 读取 T013 的 canonical 输入，复用官方 TabPFN 9.0.0 单成员 none/fingerprint/permutation 配置，固定种子、权重摘要和处理版本，输出 mean/provenance；保持原 `export_estimator_golden.py` 默认行为（依赖 T013）。
- [X] T017 [US4] 在 `runtime/tests/browser/workbench-duckdb-file.ts` 对 US4 `normal/sample.duckdb` 的工作副本运行 open/attach/read/write probe，输出依赖/浏览器版本、查询与原件前后 hash 到 `artifacts/workbench/acceptance/duckdb-file.json`；将可重复命令及逐项结论写入 `runtime/docs/workbench-capabilities.md`，依赖 T008 与 T013，可通过独立 `--suite duckdb-file` 执行；形成四项明确结论且原件不变即满足 probe，不要求全部支持。原生文件必须有效；调整生成器版本或文件后重新生成摘要并重跑校验。
- [X] T018 [US4] 在 `runtime/scripts/prepare-workbench-fixtures.mjs` 串联数据和官方参考生成，按仓库根解析 WORKBENCH_REFERENCE_PYTHON/WORKBENCH_MODEL_PATH，分别使用锁定工具环境；将最终 manifest/文件摘要提交到 `runtime/tests/fixtures/workbench/v1/manifest.json`，缺参考时不标记 complete，既有基线必须先输出差异后显式更新。
- [X] T019 [US4] 在 `runtime/scripts/check-workbench-fixtures.mjs` 调用锁定的 `tools/workbench-fixtures/check.py` 原生校验器读取五种格式，检查摘要、逻辑等价、行数、八类 cases、时间/目标隔离、参考完整性和 ≤10 MiB；不加载模型、不联网、不修改 expected，缺校验环境明确失败。浏览器 DuckDB 支持状态由独立 probe 判定。
- [X] T020 [US4] 执行完整生成及 T011/T012/T019，实际保存 `runtime/tests/fixtures/workbench/v1/expected/tabpfn35-mean.json` 和全部小文件；固定 FP32 ≤0.0001 MWh、FP16-storage ≤0.002 MWh 预算及权重/输入/provenance，参考生成失败不得用 JS 输出或旧 golden 代替，浏览器误差验证留给 T038。
- [X] T021 [US4] 完成 `runtime/tests/fixtures/workbench/v1/README.md`、`LICENSE` 与 `cases.json` 的使用/生成/来源/许可/单位/限制说明，把每个用例映射到 FR 与预期操作；在干净数据副本运行只读检查，确认无在线抓取或账户依赖。

**Checkpoint**: 数据包已准备且可独立检查；所有参考预算是验收目标，不能把生成 mean 当成浏览器已经对齐。

## Phase 4: User Story 1 — 随附数据预测、查询与导出闭环 (Priority: P1) — MVP

**Goal**: 用户在可操作的工作台用固定数据运行真实模型、查询实际预测表并完成三格式导出往返。

**Independent Test**: 使用 US4 数据包，按示例完成导入、统计、训练/预测 SQL、模型配置、32 行预测、关联/聚合与 CSV/Parquet/Arrow 往返；不依赖远端接口、案例页面或 US3 的持久恢复。

### Tests for User Story 1

- [X] T022 [P] [US1] 在 `runtime/tests/contract/workbench-publication.test.ts` 定义真实表发布与行身份测试：重复/缺失/越界 ordinal、无业务键、重排、行数/有限性错误、数据库注册失败、取消/迟到 generation 必须拒绝或回滚，旧成功结果保持可查询。
- [X] T023 [P] [US1] 在 `runtime/tests/browser/workbench-flow.ts`、`runtime/tests/browser/workbench-export.ts` 编写真实模型产品闭环及三格式往返验收，绑定 US4 mean/查询预期，检查模型、SQL 表、逐行关联、聚合语义和 NULL/精度元数据，禁止 fake adapter 替代。

### Implementation for User Story 1

- [X] T024 [US1] 在 `runtime/src/coordinator/worker-model-client.ts`、`runtime/src/workers/protocol.ts`、`runtime/src/workers/model.worker.ts` 实现真实 WorkerModelClient 的 ready/epoch、请求路由、progress、取消、transfer 与关闭；连接现有 `model.worker-entry.ts` 和 artifact-bound factory，产品必须 `requireOrtRuntime: true`，不得进入线性 fallback。
- [X] T025 [US1] 在 `runtime/src/data/input-snapshots.ts`、`runtime/src/data/arrow-dataset.ts` 与 `runtime/src/data/duckdb-service.ts` 补齐冻结查询结果/模型输入的映射，只转换有序数值特征，保留全部原始业务列和无业务键时的输入行；校验空输入、目标、特征匹配、缺失/无限值及处理后规模。
- [X] T026 [US1] 在 `runtime/src/data/duckdb-service.ts` 实现输入、预测及运行元数据的真实 SQL 表注册，在 `runtime/src/data/result-publication.ts` 校验输出 ordinal 完整一一映射；不把返回数组索引强行重建为身份。
- [X] T027 [US1] 在 `runtime/src/coordinator/runtime-coordinator.ts`、`runtime/src/data/result-publication.ts` 调整 reserve→compute→validate→事务写表→更新当前指针的发布顺序，串行化 generation/取消检查与提交，数据库失败回滚，完成 T022 故障验收。
- [X] T028 [US1] 在 `runtime/src/workbench/experiment-service.ts` 实现实验 revision、训练/预测查询绑定、模型配置、实际输入物化和运行编排，复用 context/调度器；提交后冻结版本，UI 编辑不得改变运行中实验。
- [X] T029 [P] [US1] 在 `runtime/src/workbench/catalog-service.ts` 实现表/字段/逻辑类型/总行数、各列空值数和数值 min/max/mean 的查询，并在 `runtime/app/components/DataCatalog.tsx` 显示；结果与 US4 stats 一致（依赖 T025、T028）。
- [X] T030 [P] [US1] 在 `runtime/app/components/QueryEditor.tsx` 和 `runtime/app/components/QueryPreview.tsx` 实现训练/预测/结果 SQL 编辑、错误定位、类型化参数和分页预览，显示最多 200 行及真实总行数，保留失败查询文本（依赖 T025、T028）。
- [X] T031 [P] [US1] 在 `runtime/app/components/ExperimentConfig.tsx` 实现目标、有序特征、模型、任务、版本/精度和显式 provider 策略选择，展示模型体积/许可/能力范围，禁用不支持的新训练和分类等任务并说明原因（依赖 T025、T028）。
- [X] T032 [US1] 在 `runtime/src/workbench/export-service.ts` 实现 CSV/Parquet 数据库导出和 Arrow IPC 导出，在 `runtime/src/workbench/export-metadata.ts` 写 schema/NULL 编码、运行身份、训练/预测 SQL、数据/模型版本和行映射；聚合标记 aggregation，拒绝静默精度损失，移除 URL 凭证。
- [X] T033 [US1] 在 `runtime/src/workbench/file-codecs.ts` 增加导出 sidecar 的显式 schema/NULL 解码和预览确认，往返保持时间、大整数、空字符串及行身份；读取元数据不自动执行 SQL 或拉取远端来源。
- [X] T034 [US1] 在 `runtime/app/components/ResultsPanel.tsx` 实现结果表/关联/聚合查看与三种导出、元数据成对下载，展示数据与运行身份，失败结果不得覆盖上一成功结果；连接 T032/T033。
- [X] T035 [US1] 在 `runtime/app/main.tsx`、`runtime/app/App.tsx`、`runtime/app/state/workbench-store.ts` 组装工作台与服务事件，提供“使用测试数据”和本地三格式导入入口、重名确认，接入目录/查询/配置/结果与基本状态/取消；加载已发布 v1 文件，不在页面重新随机造数据。
- [X] T036 [US1] 在 `runtime/tests/contract/worker-model-client.test.ts` 验证 T024 的 ready、requestId、transfer、重复/迟到响应与 shutdown；运行既有 runtime 类型/单元测试及新契约，确认 model 模块不依赖 React、原 harness 仍可运行。
- [X] T037 [US1] 运行 T023 的真实 DuckDB/三格式导出往返、schema/统计/示例查询检查，并逐项执行 US4 cases.json 的八类输入接受/拒绝断言，结果写入 `artifacts/workbench/acceptance/flow-data.json`；断言预测表可被独立 SQL 查询而非只读取内存 Map。
- [X] T038 [US1] 使用 `runtime/scripts/run-workbench.mjs` 通过必填 provider/precision 参数执行 flow 的四种组合，校验实际 provider、精度、匹配资产 manifest/权重摘要及 US4 官方 mean 的 32 行预算和重复键/重排映射，分别写入 `artifacts/workbench/acceptance/flow-<provider>-<precision>.json`；缺资产/provider 或误差不达标不得标完成或自动放宽预算。

**Checkpoint**: MVP 为共享基础 + US4 + 完整 US1；用户已能导入、预测、继续 SQL 和导出。US2 的远端/DuckDB 文件及 US3 恢复能力仍未完成。

## Phase 5: User Story 2 — 自带本地或远端数据 (Priority: P1)

**Goal**: 将共同导入基础扩展到远端文件/接口与有证据的 DuckDB 文件操作，独立于模型加载验证来源能力。

**Independent Test**: 不加载模型，导入本地/远端等价数据并查统计；用受控第二 origin 验证错误；对 DuckDB 副本逐项输出能力结论，原件 hash 不变。

### Tests for User Story 2

- [X] T039 [P] [US2] 在 `runtime/tests/browser/workbench-sources.ts` 定义本地三格式、远端三格式/JSON/CSV、显式类型解释及失败隔离验收，包含混合内容、损坏、403/过期、CORS/网络、Range、同名替换，以及注入预算下恰好命中字节上限、超 1 字节、缺 Content-Length、读取中超时和取消/超时竞争，失败后其他表仍可查询。
- [X] T040 [P] [US2] 在 `runtime/scripts/workbench-source-server.mjs` 提供可重置的第二 origin：等价样本、JSON 数组/显式路径、CORS 拒绝、403、超时/截断、版本变化、Range 有/无，并记录请求次数；该服务仅为测试辅助，不是产品后端。

### Implementation for User Story 2

- [X] T041 [US2] 在 `runtime/src/workbench/remote-source.ts` 实现可取消的单次 GET 和完整响应内容摘要：默认总超时 120000 ms（请求至响应体完成），响应流累计上限 67108864 字节（64 MiB）；启动时注入有限正整数配置，测试允许小值，恰好上限允许、超出立即中止，可信 Content-Length 超限可提前拒绝，缺失时按流累计；SOURCE_TIMEOUT/SOURCE_TOO_LARGE 清理未完成内容并保留旧表，支持 HTTPS/预签名/对象 URL 及 HTTP JSON/CSV，JSON 明确选择行数组路径；完整下载不强制 Range，不可读响应与混合内容明确报错，不分页或隐式采样。
- [X] T042 [US2] 在 `runtime/src/workbench/duckdb-file-source.ts` 实现 T017 已验证的文件副本操作、表目录和查询接入，未验证/不支持操作明确拒绝；不原地写回，不以普通文件导出冒充数据库写入。
- [X] T043 [US2] 在 `runtime/src/workbench/capability-service.ts` 注册各数据入口及 DuckDB open/attach/read/write 的版本化证据，结合浏览器和所选模型检测返回 supported/constrained/unsupported、限制和恢复建议，不把缺证据当支持。
- [X] T044 [US2] 在 `runtime/app/components/AddSourceDialog.tsx`、`runtime/app/components/CapabilitiesPanel.tsx` 实现文件/URL/JSON 路径/格式/类型输入、能力展示和来源错误恢复，再串行接入 `runtime/app/App.tsx`；网络或 CORS 无法区分时不虚构原因，凭证不进入日志。
- [X] T045 [US2] 将来源服务、探针和 T039/T040 接入 `runtime/scripts/run-workbench.mjs` 的 data suite，运行格式等价、来源失败隔离、Range 回退和原文件保护，结果写入 `artifacts/workbench/acceptance/sources.json`。
- [X] T046 [US2] 更新 `runtime/docs/workbench-capabilities.md` 和 `runtime/README.md` 的入口支持矩阵/限制/恢复步骤，用无模型环境重放数据故事；默认必需入口失败不能记为 unsupported 后宣称通过。

**Checkpoint**: 本地/远端数据故事可独立运行；DuckDB 文件允许有证据的受限结论，三种本地/远端必需格式不能借此豁免。

## Phase 6: User Story 3 — 运行状态与可靠重复实验 (Priority: P2)

**Goal**: 恢复固定数据和实验定义、复用模型缓存，失败可恢复；长操作中页面可响应，取消与成功结果语义清楚。

**Independent Test**: 保存固定实验后关闭重开，验证数据/模型零内容下载；逐项注入损坏/配额/清理/刷新/执行失败；三阶段各 10 次交互均在 1 秒内反馈。

### Tests for User Story 3

- [X] T047 [P] [US3] 在 `runtime/tests/browser/workbench-persistence.ts` 定义无模型的实验定义/数据快照重启与零数据下载、显式刷新、缓存中断/损坏/配额/清理、缺数据重选与引用清理测试，使用 T040 请求计数和存储故障注入，不把 context 缓存当数据/实验恢复。
- [X] T048 [P] [US3] 在 `runtime/tests/browser/workbench-responsiveness.ts` 定义加载/长查询/真实预测各 10 次交互、取消确认与最终状态、旧结果保留、未知指标和设备丢失验收，记录逐次延迟/设备/provider，模拟延时与真实计算证据分开。

### Implementation for User Story 3

- [X] T049 [P] [US3] 在 `runtime/src/storage/data-snapshot-store.ts` 实现 IndexedDB 数据快照分块/摘要/complete 提交、恢复校验、损坏失效与容量失败的内存降级，覆盖 source/format/typeInterpretation/schemaVersion 身份，不新增第二持久后端。
- [X] T050 [P] [US3] 在 `runtime/src/storage/workbench-experiment-store.ts` 持久保存实验 revision、查询/参数、目标/特征、数据引用和模型/策略版本，校验 schema 版本，不保存 Worker/context 活句柄或默认持久化 URL 凭证；按 T005 类型独立实现。
- [X] T051 [US3] 在 `runtime/src/workbench/restore-service.ts` 连接 T049/T050，恢复快照表与实验定义并复用现有模型/context 存储；缺数据进入 needs-data，重新选择必须核对原摘要，禁止自动取新 URL 内容替代旧实验；串行接入 `runtime/src/workbench/bootstrap.ts`。
- [X] T052 [US3] 在 `runtime/src/workbench/source-lifecycle.ts` 实现显式 refresh 的新版本、别名替换不改旧实验、实验/结果引用保护及无引用回收，写入失败保持原版本；调用已有源和存储服务，不删除仍在使用的模型/context。
- [X] T053 [US3] 在 `runtime/src/diagnostics/progress.ts`、`runtime/src/workbench/operation-events.ts` 贯通数据与模型阶段进度/耗时/实际 provider/资源观测，未知值明确 unavailable；取消立即确认后等待安全结束，失败重试显式，禁止静默换模型或重放。
- [X] T054 [US3] 在 `runtime/app/components/RunStatus.tsx`、`runtime/app/components/SavedExperiments.tsx` 接入保存/恢复、固定数据版本、缓存失效/配额提示、阶段/取消/重试；串行更新 `runtime/app/App.tsx`，保留失败配置与上一成功结果。
- [X] T055 [US3] 将 T047 纳入无模型 data suite，记录 `artifacts/workbench/acceptance/persistence-data.json`；新增 `runtime/tests/browser/workbench-model-cache.ts` 并接入 model-cache suite，显式指定 provider/precision，首次缓存真实模型后关闭重开同一存储，禁止 HTTP 缓存代替应用持久缓存，验证零模型内容下载、损坏恢复和独立 mean，记录 `artifacts/workbench/acceptance/model-cache-<provider>-<precision>.json`；两组共同证明 SC-006。
- [X] T056 [US3] 将 T048 纳入 responsiveness suite，显式指定 `--provider webgpu --precision fp16-storage` 并在声明设备执行，记录三阶段共 30 次反馈时间、取消/故障最终状态到 `artifacts/workbench/acceptance/responsiveness.json`；每次 ≤1 秒，若超时按线程/事件定位修复后复测，不能只报告平均值。
- [X] T057 [US3] 在 `runtime/docs/workbench-capabilities.md` 汇总当前浏览器/模型/存储/设备受限路径，重放“不支持配置、下载失败、无加速、设备丢失、取消、关闭”恢复流程；确认无静默换模型、迟到覆盖或故障后的自动重复推理。

**Checkpoint**: 四个故事完成；重启恢复数据与配置不等于永久备份或全历史结果恢复，不引入 PWA 离线承诺。

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: 验证构建、跨故事回归、交付说明和全部成功标准。不能以 mock/跳过替代实际验收。

- [X] T058 [P] 在 `runtime/tests/browser/workbench-built-assets.ts` 实现并运行 dist-app 根路径/非根 base 的静态验证，检查样本、模型、DuckDB/ORT、Worker/WASM MIME、COOP/COEP、按需加载和无 SPA fallback 伪装资产，报告 `artifacts/workbench/acceptance/built-assets.json`。
- [X] T059 [P] 在 `runtime/tests/browser/workbench-accessibility.ts` 验证工作台键盘操作、焦点、字段旁错误、长表分页和状态可读性，修复对应 `runtime/app/components/` 组件，结果写入 `artifacts/workbench/acceptance/accessibility.json`；修复共享 UI 时与其他任务串行。
- [X] T060 通过 `runtime/scripts/run-workbench.mjs` 运行 quickstart 全部数据/四组合 flow/model-cache/响应性/构建命令、应用类型检查与既有 runtime 回归，核对 FP32/FP16-storage 和 WASM/WebGPU 证据；产出 `artifacts/workbench/acceptance/summary.json`，任一必需 SC 失败或 not-run 时不标完成。
- [X] T061 更新 `runtime/README.md`、根 `README.md` 和 `specs/002-phase1-workbench/quickstart.md` 为实际命令/启动/资产/数据许可/限制/验收摘要，链接版本化支持矩阵与参考来源；注明浏览器用户不需要 Python、维护者生成数据/参考及完整五格式校验需要，移除已实现命令的“待新增”表述。
- [X] T062 在 `specs/002-phase1-workbench/acceptance.md` 按 FR-001 至 FR-016、SC-001 至 SC-007 记录可追溯命令、输入/代码/模型版本和证据路径，核实数据包实际存在且 ≤10 MiB；仅有已通过证据的任务可更新 `specs/002-phase1-workbench/tasks.md` 复选框，未运行与受限项如实列出。

## Dependencies & Execution Order

### Phase Dependencies

```text
Setup T001–T004
  ├→ Foundation T005–T010
  └→ US4 T011–T021（数据生成可并行）
       T013 + T008 → T017 文件 probe → 最终数据包

Foundation + US4 完成
  → US1 T022–T038：MVP
    → US2 T039–T046
      → US3 T047–T057
        → Polish T058–T062
```

这是阶段依赖图；基础和数据准备可并行，以下局部并行不改变各故事的独立验收门槛。

### User Story Dependencies

- US4 的数据生成和原生检查工具开发只依赖 Setup；最终 manifest/完整检查等待文件 probe T017，probe 额外依赖 T008、T013。US1 集成和验收必须等待 Foundation、US4 和文件 probe 完成；不得临时使用旧 golden。
- US2 的来源核心/受控服务在 Foundation + US4 后可与 US1 实现并行，但 T044 的 App 接入和 T045/T046 故事完成等待 US1 页面入口；验收本身不加载模型。
- US3 的存储核心按已冻结 T005 契约可在 US1/US2 期间并行准备；集成和验收等待 US1 应用及 US2 刷新/第二 origin。不能为追求“独立”复制导入或模型实现。
- T015/T016 均依赖 T013；T018 依赖 T014–T016 和 T017 的能力结论；T020 依赖生成与校验实现；T021 是 US4 交付门槛。
- US1 核心链 T024→T025→T026→T027→T028；T029/T030/T031 可并行，T032→T033→T034 为导出链；T035 合并全部服务/组件；T036–T038 验收。
- US4 的 T017 必须先于 US2 的 T042/T043；T041 和 T042 可分文件执行，但此处未标额外并行以避免同时改变共享 executor。T044 等待两者与能力服务。
- US3 中 T049/T050 可并行，T051 等待两者，T052→T053→T054 串行集成，再执行验收。
- T058/T059 可并行收集独立证据；T060 等待两者，T061→T062 完成交付。

### Within Each User Story

先定义契约/验收预期，再实现实体/服务与 UI 接入；先运行轻量数据和失败测试，再运行真实模型。必须使用模型参考/类型/行身份等实际断言，空 suite 或只检查页面打开不能算完成。

### Parallel Examples per Story

| 故事 | 前提 | 可同时执行 | 不可并行的合并点 |
| --- | --- | --- | --- |
| US4 | Setup 完成 | T011 数据包契约 + T012 标量预期测试 | T013 生成后才能做 T015/T016，再由 T018 合并 |
| US1 | US4 完成 | T022 发布契约 + T023 浏览器验收定义 | T024–T028 共享核心串行；T035 统一接入 UI |
| US1 | T028 完成 | T029 目录 + T030 SQL + T031 配置组件 | 不能分别改 App.tsx，由 T035 负责 |
| US2 | US4/基础完成 | T039 来源验收 + T040 受控服务 | T044 修改 App 等待 US1 接入完成 |
| US3 | 前期故事完成 | T047 缓存测试 + T048 交互测试；随后 T049 + T050 | T051 恢复集成需两种存储就绪 |

只在文件所有权和契约已明确的批次并行；`[P]` 不是自动启动 subagent 的指令。

## Implementation Strategy

### MVP First

完成 T001–T021 建立基础和真实数据，再完成 T022–T038 的完整 US1。验收“导入 → SQL → 真实预测 → SQL 查询 → 三格式导出再导入”，并对独立 mean 达标。此时可演示 MVP，但不能宣称整个 Phase 1 完成。

### Incremental Delivery

1. US4：固定数据包可独立供后续测试使用。
2. US1：用户能在工作台完成预测与查询/导出。
3. US2：扩展可用来源并公开 DuckDB 文件能力证据。
4. US3：固定版本恢复、缓存、取消/错误和响应性。
5. 收尾：验证生产构建与所有 SC，交付可复现说明。

### Coverage Map

| 要求 | 实现任务 | 主要验证 |
| --- | --- | --- |
| FR-001 | T028–T035 | T037–T038 / SC-001 |
| FR-002 | T009、T041–T044 | T039、T045 / SC-002、SC-007 |
| FR-003 | T017、T042–T043 | T045–T046 / SC-007 |
| FR-004 | T029 | T037 / SC-002 |
| FR-005 | T010、T025、T028、T030–T031 | T006、T022–T023 / SC-001 |
| FR-006 | T024、T028、T031 | T036、T038 / SC-001、SC-004 |
| FR-007 | T025–T027、T034 | T022、T037–T038 / SC-001、SC-007 |
| FR-008 | T032–T034 | T023、T037 / SC-002 |
| FR-009 | T007、T024、T053–T054 | T048、T056 / SC-005 |
| FR-010 | T049–T052 | T047、T055 / SC-006 |
| FR-011 | T005、T041–T044、T053–T054 | T045、T055–T057 / SC-007 |
| FR-012 | T013–T021 | T011–T012、T019–T021 / SC-003 |
| FR-013 | T013、T015 | T019、T037、T045 / SC-002、SC-003 |
| FR-014 | T014、T021 | T019、T037–T038 / SC-003、SC-007 |
| FR-015 | T013、T016–T020 | T019、T038 / SC-004 |
| FR-016 | T014–T015、T021 | T019、T060、T062 / 全部 SC |

## Notes

- 62 项任务：Setup 4、Foundation 6、US4 11、US1 17、US2 8、US3 11、收尾 5；20 项标注 `[P]`。
- 缺少真实模型资产或硬件时可先完成非模型任务，但 T038/T056/T060 的必需验收不能用 not-run 冒充通过。
- DuckDB 文件操作允许有证据的 constrained/unsupported；本期默认预测闭环、三格式导出等必需行为不适用该豁免。
- 本任务清单不授权发布站点、上传权重或提交大型原始数据；实现产物与证据以既有许可和范围为准。
