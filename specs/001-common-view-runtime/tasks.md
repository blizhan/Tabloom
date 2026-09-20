# Tasks: Common View Runtime

**Input**: [spec.md](spec.md)、[plan.md](plan.md)、[research.md](research.md)、[data-model.md](data-model.md)、[contracts](contracts/runtime.md)、[quickstart.md](quickstart.md)。

**Prerequisites**: 上述设计已就绪；当前无产品 `runtime/` 包。constitution 仍为未填写模板，不将示例规则视为已采纳约束。任务只覆盖本期数值回归共享运行时与验证页面，不实现完整 UI、任意 TabICL 训练或 OPFS 后端。

**Tests**: 规格 SC-001–SC-008 明确要求准确性、故障、恢复和并发验证，因此包含必要测试。先建立对应验收断言，再实现行为；脚手架和文档不强制 TDD。测试创建任务不等于测试已通过，故事末尾另有执行验收任务。不能将缺少硬件/fixtures 的 skip 视为成功。

**Organization**: Setup → Foundational → US1(P1) → US2(P1) → US3(P2) → US4(P2) → 跨故事验收。所有路径相对仓库根目录。

## Format: `[ID] [P?] [Story] Description`

- 每项勾选仅在实现与该项验证完成后进行，本次生成全部未勾选。
- `[P]` 表示在本节明确的前置任务完成后，可与同一并行组执行；不是无条件提前开始。
- 同一文件只有一个写入负责人。未标 `[P]` 默认按所在阶段顺序执行；跨故事共享文件的修改必须串行合并。

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: 建立单一 npm 包及可复现开发/验证入口。

- [X] T001 创建 `runtime/package.json` 与 `runtime/package-lock.json`，锁定 plan 中 TypeScript 5.9.3、ORT 1.30.0、DuckDB-WASM 1.33.1-dev57.0、Arrow 17.0.0、Vite/Playwright-core/sirv 版本及所需 Node 类型依赖，声明纯模型/data 入口和 typecheck、test、build、dev、fixtures:prepare、test:browser 脚本；验证依赖安装，保留现有 spikes。
- [X] T002 [P] 在 `runtime/tsconfig.json`、`runtime/tsconfig.test.json` 配置浏览器库/Worker 与编译后 node:test 的独立类型环境和输出，禁止将 DuckDB/UI 依赖引入纯模型入口；依赖 T001。
- [X] T003 [P] 在 `runtime/vite.config.ts`、`runtime/harness/index.html` 配置 127.0.0.1:4175 strictPort、COOP/COEP、同源模型/ORT/DuckDB worker/WASM 资产及正确 MIME，区分 dev 资源映射与 build 输出；依赖 T001。
- [X] T004 在 `runtime/scripts/run-browser.mjs` 实现 quickstart 的 suite/provider/cycles 参数、TABLOOM_CHROMIUM、服务器/浏览器清理和 JSON 报告输出，缺 fixture、必需硬件或未注册 suite 返回非零；依赖 T002–T003。
- [X] T005 在 `runtime/README.md` 与 `runtime/tests/fixtures/README.md` 写清环境、artifact 取得前置、版本化小型合成 fixtures/ignored 大文件边界，以及现有 spike 命令与未来 runtime 命令的区别。

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: 建立公共契约及最早的兼容性/数值参考门槛；完成本阶段后才能开始故事实现。

- [X] T006 在 `runtime/src/model/types.ts`、`runtime/src/model/errors.ts`、`runtime/src/index.ts` 定义数据、capabilities、identity、live handle、两种 snapshot payload、fitted state、结果/诊断类型和全部稳定错误码，匹配 contracts，不以任意对象代替版本化状态。
- [X] T007 [P] 在 `runtime/src/workers/protocol.ts`、`runtime/tests/contract/protocol.test.ts` 定义并验证 protocolVersion、epoch、requestId、progress 与恰好一次终态回复、未知命令拒绝和 transferable ownership 规则；依赖 T006。
- [X] T008 [P] 在 `runtime/src/model/identity.ts`、`runtime/tests/unit/identity.test.ts` 实现 framed SHA-256、类型化 SQL 参数、canonical NaN/保留 signed zero、全部配置默认值解析和训练 key，测试目标/行列顺序/seed/precision/版本失效与仅预测变化命中；依赖 T006。
- [X] T009 [P] 在 `runtime/src/storage/manifest.ts`、`runtime/tests/contract/manifest.test.ts` 定义可信 expected digest、文件大小/hash、external-data 映射、I/O shapes、precision/profile/provider compatibility 校验，并为现有 TabPFN 两种精度交付生成 `runtime/tests/fixtures/manifests/tabpfn35.json` 索引；依赖 T006。
- [X] T010 [P] 新增 `spikes/tabpfn35/export_estimator_golden.py`，复用现有 parity probe 导出原始 train/test/y、完整 fitted fingerprint/permutation/seed、处理后输入、归一化标签、logits/解码状态与完整官方均值；生成 ignored `artifacts/tabpfn35/estimator-golden/manifest.json` 及二进制 fixtures，固定各阶段误差预算，覆盖正常/NaN/opt-in Inf、默认 Inf 拒绝、多 seed、重复行、常量列与极值，更新 `spikes/tabpfn35/README.md` 的准确复现命令；依赖 T006，Python/CUDA 只用于参考生成。
- [X] T011 在 `runtime/scripts/prepare-fixtures.mjs` 实现 --artifact-root、完整 golden/文件清单/checksum 检查和 harness 路由清单，缺失时列具体文件并失败，不自动生成期望值或下载未知模型；依赖 T009–T010。
- [X] T012 在 `runtime/tests/browser/bootstrap-data.ts` 验证锁定 DuckDB/Arrow 的真实 async worker 查询、分块/slice/null 读取、Arrow 注册与事务回滚，向 `artifacts/runtime/reports/bootstrap-data.json` 写证据；失败先修复版本/API 并记录 `specs/001-common-view-runtime/research.md`，不得进入产品集成。
- [X] T013 在 `runtime/tests/browser/bootstrap-model.ts`、`runtime/tests/browser/bootstrap-model.worker.ts` 复用原始 context-chain fixture 验证自有 module worker、ORT proxy=false、WASM/真实硬件 WebGPU、共享 buffer、builder 输出独立拷贝后 release→predict，记录 `artifacts/runtime/reports/bootstrap-model.json`；依赖 T007、T009、T011，不能用原页面 spike 成功代替此验证。WASM 与 GB10 NVIDIA WebGPU 均已通过原始 8/24/64/256 行链路；两者均记录 54 cache tensors、独立 cache copy、shared external-data 427,785,792 bytes、builder 已释放、shared-data 请求=1。WebGPU 通过显式 ORT companion-WASM 路径配置。

**Checkpoint**: T007–T010 可并行；T011 等待 manifest/golden。T012 与 T013 在各自前置满足后可独立验证。所有 Phase 2 任务完成且两项 bootstrap 门槛通过，才进入 US1。完整 golden 无法生成属于真实前置缺失，不可把阈值调宽掩盖。

## Phase 3: User Story 1 — 用自己的数据完成预测与查询闭环 (Priority: P1) — MVP

**Goal**: 用户训练输入 → TabPFN 最终均值 → 与保存输入逐行对应 → DuckDB 可查询；无需持久缓存或 Case 功能。

**Independent Test**: 真实 WASM/WebGPU 分别运行合成数据，完整均值满足 SC-002；重复业务键与重排零错配；坏 schema/target/shape 明确拒绝。

### Tests for User Story 1

- [X] T014 [P] [US1] 在 `runtime/tests/unit/arrow-dataset.test.ts` 定义 Arrow null、切片、多 batch、Float64、整数安全边界、溢出、重复名/错序、空输入与 target 校验样本，断言不隐式删行/转换未支持类型。
- [X] T015 [P] [US1] 在 `runtime/tests/unit/tabpfn35-estimator.test.ts` 与 `runtime/tests/contract/adapter.test.ts` 使用 T010 golden 定义 fitted preprocessing、独立 decode、有效/foreign/released handle、profile/bounds 和最终 metadata 契约断言。
- [X] T016 [P] [US1] 在 `runtime/tests/browser/prediction-registration.ts` 定义真实数据库输入快照/ordinal join、重复业务键、源查询重排、非有限输出/数量不符与写入回滚的集成断言。

### Implementation for User Story 1

- [X] T017 [US1] 在 `runtime/src/data/arrow-dataset.ts` 实现逐逻辑行 Arrow 转换、validity/offset/batch 合并、整数范围和 Float32 溢出检查、模型缺失/Inf 策略及严格 schema 顺序验证，通过 T014。
- [X] T018 [US1] 在 `runtime/src/data/duckdb-service.ts` 封装已通过 bootstrap 的 DuckDB async worker 初始化、连接/释放、串行命令队列、类型化查询参数及内部标识符安全转义。
- [X] T019 [US1] 在 `runtime/src/data/input-snapshots.ts` 实现训练/预测查询只物化一次、snapshotId + rowOrdinal、原始业务字段保留、目标排除出特征、owned feature copies 与基本 retain/release，后续 join 禁止重跑原 SQL。
- [X] T020 [US1] 在 `runtime/src/storage/artifact-store.ts` 实现已验证 manifest/file 的会话内加载、进度、同实例 in-flight 去重和单 shared Uint8Array 所有权，声明可替换持久 store 接口；此阶段不依赖 IndexedDB。
- [X] T021 [US1] 在 `runtime/src/model/session-manager.ts` 实现一次一个激活模型、显式 provider fallback、staged builder/predictor 生命周期、host readback/copy、部分初始化失败清理和实际 provider metadata。
- [X] T022 [P] [US1] 在 `runtime/src/model/tabpfn35/preprocessing.ts` 实现固定 none/fingerprint/permutation profile、拟合统计与 seed 状态、target normalization、原始及处理后 shape 校验，预测只使用 fitted state；前置 T015、T017–T021。
- [X] T023 [P] [US1] 在 `runtime/src/model/tabpfn35/decode.ts` 实现温度、borders/tails、分布聚合与原始目标单位均值还原，对照完整 decoder golden；前置 T015、T017–T021，与 T022 无文件依赖。
- [X] T024 [US1] 在 `runtime/src/model/context-registry.ts` 实现 CPU backing、独立 handle、instance/epoch 校验、operation pins、幂等 release/dispose 和会话内按 identity 复用，防止输入/权重 transferable 破坏 live 数据。
- [X] T025 [US1] 在 `runtime/src/model/tabpfn35/adapter.ts` 组合 fitContext/predict/capabilities/load/release/dispose，按 T008 identity 查会话 context，连接 54 tensor context 链与 T022–T024，输出完整原始目标均值/metadata。
- [X] T026 [US1] 在 `runtime/src/workers/model.worker.ts`、`runtime/src/coordinator/runtime-client.ts` 实现协议 dispatcher、串行模型操作、类型化错误和独占数据转移，将 load/fit/predict 等操作接入协调器，保持 ORT 对象不跨边界。
- [X] T027 [US1] 在 `runtime/src/data/result-publication.ts` 实现完整结果校验、私有 staging、run/results 表与原子 commit/rollback，使用 snapshot/ordinal 关联及完整模型/请求 metadata；预留同队列 generation guard 接口供 US2 扩展。
- [X] T028 [US1] 在 `runtime/harness/common.ts`、`runtime/harness/main.ts` 接入能力查看、训练/预测、目标选择、结果查询和错误展示，使用同一库 API 完成最小闭环，不构建最终产品 UI。
- [X] T029 [US1] 在 `runtime/tests/browser/parity.ts` 连接完整模型验收并运行 T014–T016、两 provider 的 FP32/FP16-storage 全部均值对照和 integration，记录 `artifacts/runtime/reports/us1-acceptance.json`；正常/NaN/opt-in Inf 分别检查 1e-4/2e-3，不能用 raw logits 误差代替均值。WASM FP32 opt-in-inf `0.00010582804679870605`、GB10 WebGPU FP32 opt-in-inf `0.00010651350021362305` 均为用户接受的 ORT 后端已知偏差；阈值未放宽，原始失败证据保留，其他场景及 FP16-storage 两 provider 均通过，真实硬件 WebGPU 交叉验证已完成。

**Checkpoint**: US1 独立交付并满足 SC-001/SC-002 的默认模型部分。持久缓存、交互队列与案例尚未交付，不将其缺失隐藏为全部 feature 完成。

## Phase 4: User Story 2 — 修改情景并只查看最新预测 (Priority: P1)

**Goal**: 相同训练 context 热复用、基准保留、最新请求才能发布；显式实验不被合并。

**Independent Test**: 使用 US1 产生的 context 或受控 fake executor 连续提交 20 个情景，确认最终为第 20 个、旧请求不覆盖、基准不变；真实模型重复预测不重建 context。

### Tests for User Story 2

- [X] T030 [P] [US2] 在 `runtime/tests/contract/scheduler.test.ts` 定义每流 running+latest pending、跨流 FIFO、独立 experiment、不重复终态、cancel/status/dispose、旧 epoch 拒绝的确定性竞态测试。
- [X] T031 [P] [US2] 在 `runtime/tests/browser/scenario-publication.ts` 定义 reserve/cancel/publish 数据队列与真实事务的竞态、20 次快速更新、旧 UI 回复屏蔽、历史结果可查和 baseline 保留断言。

### Implementation for User Story 2

- [X] T032 [US2] 在 `runtime/src/data/scenarios.ts` 实现 immutable deriveScenario、baseline ordinal/parent mapping、修改参数与显式 experiment 描述，行集合变化生成新映射。
- [X] T033 [US2] 在 `runtime/src/coordinator/scheduler.ts` 实现 interactive 合并、全局串行公平 FIFO、experiment 独立保留及运行中逻辑取消，先 reserve 确认后运行，不承诺 kernel 中断。
- [X] T034 [US2] 扩展 `runtime/src/data/result-publication.ts` 的 scenario_heads、generation/epoch/request 校验、reserve/cancel/publish 串行线性化及事务内重查，pending 与历史结果区分，陈旧结果 rollback。
- [X] T035 [US2] 扩展 `runtime/src/coordinator/runtime-client.ts`、`runtime/src/workers/model.worker.ts` 的立即取消 ack、排队取消、dispose completion 等待物理清理和 device-loss 失败传播；无隐式 WASM 重放。
- [X] T036 [US2] 在 `runtime/src/diagnostics/progress.ts` 实现加载/拟合/预测阶段进度、可读取状态、provider fallback 原因及不可知总量，模型 worker 忙碌时协调器仍能接受取消。
- [X] T037 [US2] 扩展 `runtime/src/data/input-snapshots.ts` 并在 `runtime/src/data/experiments.ts` 实现运行/结果/实验引用计数与删除事务，保留引用阻止输入清理、显式删除后无悬空 join。
- [X] T038 [US2] 在 `runtime/harness/scenarios.ts` 接入快速修改、独立实验、基准/历史/当前结果和取消状态，通过协调器 generation 防止迟到回复成为当前展示。
- [X] T039 [US2] 运行 T030–T031 和真实 context 热复用检查，补齐 `runtime/tests/browser/scenario-publication.ts` 的保留/清理与设备故障测试，将 SC-004/SC-008 证据写入 `artifacts/runtime/reports/us2-acceptance.json`。WASM module-worker integration 已验证 context reuse、20 次 scenario、baseline 保留、清理和注入 device-loss 拒绝；真实 GPU device-loss 仍由 T059 单独覆盖。

**Checkpoint**: US2 在已有 context 上独立验收，不依赖持久存储；US1 行对应与准确性仍须成立。

## Phase 5: User Story 3 — 保存并恢复可复现的预测上下文 (Priority: P2)

**Goal**: 已验证权重/上下文跨运行恢复，错误数据不能被当作命中，安全时配额失败降级为会话内存。

**Independent Test**: 真实 IndexedDB 保存→完整关闭 model worker→同 origin 重开，零权重内容下载、零 context build、均值满足原预算；逐项改变训练语义 miss，预测变化 hit。

### Tests for User Story 3

- [X] T040 [P] [US3] 在 `runtime/tests/browser/storage-faults.ts` 定义 chunk 中断/缺失、错误 hash/长度、quota/disabled storage、并发 write generation 与活跃 context 缓存删除测试。
- [X] T041 [P] [US3] 在 `runtime/tests/contract/context-snapshot.test.ts` 定义完整 fitted state/CPU bytes round-trip、尺寸上限、版本/profile/provider 不兼容、独立 export bytes、foreign/released handle 与 provider variant 选择断言。

### Implementation for User Story 3

- [X] T042 [US3] 在 `runtime/src/storage/indexeddb-store.ts` 实现 entries/chunks/writes、8 MiB chunks、分批写入/验证后 complete manifest 原子提交、读取重新校验与 orphan 回收，不让未完成写入覆盖旧完整 entry。
- [X] T043 [US3] 在 `runtime/src/model/context-snapshot.ts` 实现版本化 metadata + binary codec、identity 重算、tensor name/dtype/shape/bytes/checksum 限制、TabPFN fitted state 白名单和 provider compatibility 校验；预留 embedded-artifact 判别分支。
- [X] T044 [US3] 在 `runtime/src/storage/context-store.ts` 实现 semantic key + build variant 查询、兼容恢复、损坏自动缓存 miss 与外部 snapshot 明确失败、磁盘删除与 live backing 分离。
- [X] T045 [US3] 扩展 `runtime/src/storage/artifact-store.ts` 接入 IndexedDB warm/offline 命中、失败仅内存 warning 和 chunk 生命周期，保证恢复后仍校验且不重新下载相同内容。
- [X] T046 [US3] 扩展 `runtime/src/model/tabpfn35/adapter.ts`、`runtime/src/model/context-registry.ts` 接入持久查找、独立 export/import、同 provider 默认恢复与部分失败清理，串行更新 `runtime/src/workers/model.worker.ts` 以暴露保存/导入操作。
- [X] T047 [US3] 在 `runtime/tests/browser/persistence.ts` 实现完整关闭 worker/重开、冷并发 fetch=1、warm fetch/build=0、全部训练 identity 变更失效和预测输入变化复用测试，并验证导入后完整均值。真实 WASM 浏览器重开已通过：worker 重启、14 个训练 identity 变更全部 miss、预测输入变化复用、warm fetch/build=0、恢复均值误差为 0。
- [X] T048 [US3] 在 `runtime/harness/persistence.ts` 展示缓存状态、保存/恢复/删除和 quota/disabled 警告，保留相同 origin 与 artifact digest 的可复现操作入口。
- [X] T049 [US3] 运行 T040–T041、T047 于真实浏览器，覆盖 WASM 与同 provider WebGPU 恢复，将 SC-003/SC-005 及损坏/中断证据写入 `artifacts/runtime/reports/us3-acceptance.json`；未经交叉测试的 provider 组合保持拒绝。WASM 与 GB10 WebGPU 均通过 worker 重启、IndexedDB restore、warm fetch/build=0、14 项训练 identity miss、预测 identity hit 和完整均值验证。

**Checkpoint**: US3 可用 US1 固定数据独立验证，无需 US2 交互 UI；持久 context 不代表整个内存实验数据库已持久化。

## Phase 6: User Story 4 — 从预配置案例进入通用工作台 (Priority: P2)

**Goal**: TabICL 固定 Case 预测与原始目标逆缩放正确，Case→Common 身份一致，训练变更明确拒绝。

**Independent Test**: 加载已发布 artifact-bound 合成 Case，在两 provider 比较完整原始目标均值，转 Common 后比较 descriptor/结果，修改训练时确认没有新 fit 或模型切换。

### Fixture and tests for User Story 4

- [X] T050 [US4] 新增 `spikes/tabiclv2/export_case_golden.py`，导出固定训练身份、完整特征处理元数据、target mean/scale、原始输入与全部官方均值，为两精度在验证前固定目标单位预算，生成 ignored `artifacts/tabiclv2/case-golden/manifest.json` 和 embedded Case snapshot，更新 `spikes/tabiclv2/README.md`；不得将 graph-output 误差直接当目标单位预算。
- [X] T051 [P] [US4] 在 `runtime/tests/contract/tabiclv2-adapter.test.ts` 定义 fitContext 先拒绝、artifact/训练形状绑定、缺失值/Inf 拒绝、target inverse 和错误 snapshot 行为；依赖 T050。
- [X] T052 [P] [US4] 在 `runtime/tests/browser/case-transition.ts` 定义 Case descriptor、同实例身份保持/跨实例导入、结果引用保留、原训练不可用时能力提示及训练变更拒绝断言；依赖 T050。

### Implementation for User Story 4

- [X] T053 [US4] 在 `runtime/src/model/tabiclv2/preprocessing.ts` 实现已固定 Case 特征转换与合法非零 target scale 的逆变换，验证有限原始目标均值，不重复排序或解码图内 quantiles。
- [X] T054 [US4] 在 `runtime/src/model/tabiclv2/adapter.ts` 实现 load/import/export/predict/release/dispose 与 canBuildContext=false，绑定唯一 Case artifact，按 T043 codec 扩展 embedded state 校验并更新 `runtime/src/index.ts` 的模型选择入口。
- [X] T055 [US4] 在 `runtime/src/coordinator/cases.ts` 实现包含数据快照、SQL/typed params、target、artifact/context、情景修改、结果引用的 descriptor 和 Case→Common 转移，跨 worker 生成新 handle 但保持语义 identity。
- [X] T056 [US4] 在 `runtime/harness/cases.ts` 接入默认 Case、允许的情景修改、Open in Common View 与训练限制说明，并扩展 `runtime/scripts/prepare-fixtures.mjs` 验证完整 Case 资产。
- [X] T057 [US4] 在 `runtime/tests/browser/case.ts` 执行 T051–T052 与两 provider/两精度最终原始目标均值验证，将 SC-006 和模型准确性结果写入 `artifacts/runtime/reports/us4-acceptance.json`；案例不兼容不得换模型或擅自重训。WASM ORT Case worker 当前通过 FP32/FP16-storage，target-unit budgets 分别为 0.0001/0.01；此前硬件 WebGPU 证据仅作为历史参考，当前宿主机报告为 unavailable；动态 fit 明确返回 `UNSUPPORTED_CAPABILITY`。

**Checkpoint**: 四条故事可分别演示和验收；TabICL 动态训练仍明确 unsupported，不因接口存在而宣称支持。

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: 完成跨故事资源证据、构建资产验证和可复现交付。

- [X] T058 在 `runtime/src/diagnostics/resources.ts` 与 `runtime/tests/browser/lifecycle.ts` 补齐阶段 owned bytes、host copy/readback、digest/cache 临时资源与可用 JS/WASM/GPU 信号，运行 20 次准备/预测/关闭及受控 staged/双 session 对比，向 `artifacts/runtime/reports/lifecycle-webgpu.json` 写 unavailable 与故障证据，不将下载体积或 owned bytes 冒充峰值。GB10 WebGPU 已完成真实 20-cycle model-worker context/predict/release；报告保留浏览器未暴露 GPU allocation/WASM counters 的 unavailable 信号，并记录 owned bytes、host/readback、digest/cache/temporary 及峰值分离证据。
- [ ] T059 在 `runtime/tests/browser/lifecycle.ts` 补齐模型切换、失败初始化、export/release pins、dispose during run、device loss 注入与真实事件区别，验证零迟到发布/foreign handle 复用；必要时运行 WASM 生命周期对照并将诊断接入 `runtime/harness/main.ts`。当前已接入实际 worker lifecycle probe 与 deterministic fault evidence；真实 device-loss 事件仍保持 unavailable。
- [X] T060 [P] 在 `runtime/tests/browser/built-assets.ts` 验证 build 产物的同源 worker/WASM、MIME/隔离头、加载与持久重开，检查 runtime 无远端推理请求；验证本地 production-like 服务，不擅自发布外部站点；前置所有故事完成。
- [X] T061 [P] 更新 `runtime/README.md` 和 `specs/001-common-view-runtime/quickstart.md` 为实际已实现命令、完整 fixture 获取/导出步骤、能力/精度/环境边界、静态部署要求与故障排查，明确真实 Case 的独立误差预算；前置所有故事完成。
- [X] T062 运行 `runtime/package.json` 的 typecheck/test/build 与 quickstart 必需 suites，复用未受后续修改影响的已通过昂贵模型证据、重跑受影响项，在 `artifacts/runtime/reports/acceptance-summary.json` 汇总 SC-001–SC-008、artifact/fixture/环境版本及未通过配置；有必需失败不得宣称完成。最新汇总使用直接 Chromium `/snap/chromium/current/usr/lib/chromium-browser/chrome` 与 GB10 NVIDIA：typecheck/test/build、WASM suites、WebGPU integration/persistence/Case 通过；parity 保留用户接受的 FP32 opt-in-inf ORT 已知偏差原始失败证据，lifecycle 保留真实 device-loss/GPU allocation unavailable，故 `readyForRelease=false`，不能据此宣称发布就绪。

## Dependencies & Execution Order

### Phase dependencies

```text
Setup T001–T005
    → Foundational T006–T013
        → US1 T014–T029 (MVP)
            ├→ US2 T030–T039
            └→ US3 T040–T049
                 US2 + US3 → US4 T050–T057
                     → Polish T058–T062
```

US2/US3 的验收彼此独立，但都复用 US1 的模型/数据基础。US4 的端到端转移复用 US2 的实验描述及 US3 的 snapshot codec；fixture 与只读研究可以提前准备，完成标准不能跳过这些依赖。不把“独立验收”误写成“零共享代码依赖”。

### Task dependencies and safe parallel groups

- T001 后 T002/T003 并行；T004 等待二者。
- T006 后 T007/T008/T009/T010 并行；T011 等待 T009/T010；T012/T013 各自前置满足后可同时运行，但硬件/浏览器资源竞争时串行。
- US1：T014/T015/T016 可并行；T017–T021 依次完成后 T022/T023 并行；T024–T029 顺序集成。
- US2：T030/T031 可并行；T032–T039 顺序完成。T033 reserve 调用在 T034 提供实现前用契约 fake，不提前宣称端到端通过。
- US3：T040/T041 可并行；T042–T049 顺序完成。
- US4：T050 后 T051/T052 可并行；T053–T057 顺序完成。
- T060/T061 可与不改相同文件的资源验证并行；T062 等待 T058–T061。真实模型测试默认串行，防止同时占用 GPU 扭曲内存证据。
- 跨故事并行仅限新文件/测试：US2 的 T035 与 US3 的 T046 都修改 worker，不能同时写；US1 完成前其他故事不得修改其共享 adapter/service。

### Parallel examples per story

| Story | 可同时分配的工作 | 汇合点 |
| --- | --- | --- |
| US1 | T014 Arrow 边界、T015 estimator/adapter 契约、T016 数据库发布断言；后续 T022 预处理与 T023 解码 | T025 adapter、T029 完整验收 |
| US2 | T030 调度竞态、T031 数据库/情景竞态测试 | T033–T035 调度与发布集成 |
| US3 | T040 IndexedDB 故障、T041 snapshot 契约 | T046 adapter 恢复集成 |
| US4 | T051 adapter 能力断言、T052 Case 转移断言 | T054–T057 实现与真实均值验收 |

## Requirement Coverage

| Spec requirements | Implementation tasks | Acceptance tasks |
| --- | --- | --- |
| FR-001 | T017–T028 | T029 |
| FR-002 | T006、T025、T054 | T015、T051、T057 |
| FR-003 | T017、T022、T053 | T014、T029、T051 |
| FR-004 | T019、T027 | T016、T029 |
| FR-005 | T025、T027、T034 | T016、T031、T039 |
| FR-006 | T010、T022–T025、T050、T053–T054 | T015、T029、T057 |
| FR-007 | T024–T025、T033 | T039、T047 |
| FR-008 | T008、T044、T046 | T008、T047、T049 |
| FR-009 | T024、T043–T046 | T041、T047、T049 |
| FR-010 | T020、T042、T045 | T040、T047、T049 |
| FR-011 | T042、T044–T045、T048 | T040、T049 |
| FR-012 | T033–T035、T038 | T030–T031、T039 |
| FR-013 | T021、T024、T035 | T015、T030、T039、T059 |
| FR-014 | T006、T021、T028、T036、T054 | T029、T039、T057 |
| FR-015 | T055–T056 | T052、T057 |
| FR-016 | T035–T036、T058 | T039、T058–T059 |
| FR-017 | T019、T032、T037 | T031、T039 |

SC-001→T029；SC-002→T029/T057；SC-003→T049；SC-004→T039；SC-005→T049；SC-006→T057；SC-007→T058–T059；SC-008→T039/T059；T062 汇总最终证据。

## Implementation Strategy

### MVP first

先完成 T001–T029，交付 US1 的完整浏览器数值预测/查询闭环。独立演示不要求先实现缓存或 Case；但不宣称已完成全部 feature。随后按 P1 情景交互、P2 恢复、P2 Case 转移增量交付。

### Incremental validation

每条故事末尾运行其独立验收，记录真实 artifact/fixture/provider 版本。预处理/解码从完整 golden 开始，不能用输出头部或旧报告替代。轻量 fake executor 用于竞态与故障，真实数值、DuckDB、IndexedDB 和 worker 验收不以 fake 替代。只有新修改或未解决风险要求时才重复昂贵运行。

### Collaboration and boundaries

信息收集与需求核对可使用 Luna worker；实施时每个并行任务需明确文件所有权并保留他人改动。任务表本身不授权发布、上传权重或修改远端应用；当前分支保持 main，未创建提交。外部依赖/硬件不可用时记录具体阻塞，不勾选未完成任务。
