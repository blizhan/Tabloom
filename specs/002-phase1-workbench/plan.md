# Implementation Plan: Phase 1 共享数据与实验闭环

**Branch**: `main` | **Date**: 2026-09-20 | **Spec**: [spec.md](spec.md)

**Input**: `specs/002-phase1-workbench/spec.md`，承接 roadmap Phase 1 与既有 001 运行时。

**Feature identifier**: `002-phase1-workbench`。setup-plan.sh 的 BRANCH 采用 feature-directory fallback；实际 git branch 为 main。本次未创建或切换分支。

## Summary

在现有 runtime 包中新增 React 通用工作台入口，完成文件/远端数据导入、schema 与统计浏览、SQL 定义训练/预测、真实浏览器模型运行、预测表查询、导出与实验恢复。数据/模型计算留在 Worker，复用现有 artifact/context 缓存与调度契约。

同时交付不超过 10 MiB 的固定版本合成数据包：256 个训练行、32 个预测行、4 个数值特征，五种数据格式、八类边界输入、示例 SQL、统计预期与官方模型参考。数据先于产品流程测试准备。

调研确认运行时仍有 Worker 客户端、真实 SQL 结果表、原始类型/行身份和实验持久化缺口；这些是本期集成工作，不是假定已有能力。产品不能用测试线性 fallback、内存 Map 或旧 golden 代替真实闭环。

## Technical Context

**Language/Version**: TypeScript 5.9.3；Node 22.22.3/npm 10.9.8 为当前开发基线；Python 3.12 仅用于维护者生成数据和官方参考。

**Primary Dependencies**: 沿用 DuckDB-WASM 1.33.1-dev57.0、Arrow 17.0.0、ORT 1.30.0、Vite 7.3.6、playwright-core 1.63.0、tsx/node:test；新增 React 19/React DOM 及类型包，确切补丁随实施 lockfile 固定。独立工具环境锁定 PyArrow/原生 DuckDB；官方参考沿用 TabPFN spike 锁文件与 tabpfn 9.0.0。

**Storage**: DuckDB 浏览器内存库保存类型完整的数据表、冻结输入与预测表；IndexedDB 分块保存数据快照和实验定义，复用模型/context 存储。用户导出为文件及元数据。无服务端数据库或新增 OPFS 后端。

**Testing**: node:test/tsx 做逻辑与契约；Playwright-core 驱动 Chromium 验证数据、Worker、IndexedDB、UI、导出与构建；受控第二 origin 模拟远端。真实 WASM/WebGPU × FP32/FP16-storage 四组合分别对照官方 mean，必填 provider/precision；data 为无模型测试，model-cache 独立验证真实模型持久缓存。既有 71 个测试在调研中通过，不代表新功能通过。

**Target Platform**: 已验证桌面 Chromium、localhost/HTTPS、module workers、WASM、IndexedDB；WebGPU 优先，仅允许显式配置且已验证的 WASM 降级。开发/生产验证资产 base、MIME、COOP/COEP；不承诺任意浏览器/移动设备性能。

**Project Type**: 单包浏览器应用 + 可复用运行时，独立保留原验证 harness；维护者工具为离线开发辅助。

**Performance Goals**: 加载、长查询、预测各 10 次交互，逐次反馈 ≤1 秒；完整缓存的同版本数据与模型重启后零内容下载。预览最多 200 行，计算输入不截断。记录阶段耗时与可获取资源，不用下载大小推断显存。

**Constraints**: 浏览器内推理，产品强制真实 ORT；TabPFN 单成员数值回归与已验证处理规则，4 个原始特征加 fingerprint 后为 5 个。无静默抽样/换模型/精度变化；通用数据与导出保留类型；原始 DuckDB 文件不原地写回；数据与参考小文件提交，权重独立交付。远端导入默认总超时 120000 ms、响应流上限 67108864 字节，可启动时注入有限正整数配置，边界/错误见工作台契约。

**Scale/Scope**: 4 个故事、16 条 FR、7 条 SC；五种输入格式、三种导出格式、数据与实验恢复。首次权重下载显示体积与许可。真实案例、分类、新模型研发、在线数据流水线和账户协作不在本期。

## Constitution Check

**Before Phase 0**: constitution 为未填写模板，没有已采纳原则形成额外 gate。沿用用户“简单需求可以省略 TDD”的偏好，本次只规划。以下门槛来自特性与 001 契约，不伪称 constitution 规定。

| Gate | 研究前 | 设计后证据 |
| --- | --- | --- |
| 实际浏览器模型闭环 | Pass | R9 强制 ORT Worker 与真实 SQL 表；独立 mean 验收 |
| 原始类型、逐行身份、原子发布 | Pass | 数据模型/契约；发布失败注入与重复键测试 |
| 数据实际交付且独立可核对 | Pass | fixtures 契约、固定数据、官方 custom exporter |
| 恢复不改变实验数据版本 | Pass | 快照/实验定义持久化及引用规则 |
| 不把未知能力当已通过 | Pass | DuckDB 文件逐项 probe、新样本误差/构建验证 |
| 范围与已有运行时兼容 | Pass | 只补产品集成缺口，保留 001 接口回归 |

**After Phase 1**: Pass。无未决产品澄清或未解释的范围例外。Pass 表示设计满足门槛，不是实现已验收；文件能力、只读 SQL 策略、新样本参考与浏览器构建仍需实施验证。

## Project Structure

### Documentation (this feature)

```text
specs/002-phase1-workbench/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── checklists/requirements.md
└── contracts/
    ├── workbench.md
    └── fixtures.md
```

tasks.md 由后续 speckit-tasks 生成，本次不创建。

### Source Code (repository root)

下列为实施目标布局；app、数据工具和新命令尚未存在。

```text
runtime/
├── package.json, package-lock.json
├── tsconfig.json, tsconfig.app.json
├── vite.config.ts, vite.app.config.ts
├── build/asset-config.ts            # 提取既有资产配置
├── app/
│   ├── index.html, main.tsx, App.tsx
│   ├── components/                  # 数据、SQL、配置、状态、结果
│   └── state/                       # UI 状态与服务事件
├── src/
│   ├── workbench/                   # 新增源/查询/导出/能力服务
│   ├── coordinator/                 # worker client/原子发布
│   ├── data/                        # 真实表注册、通用 Arrow、文件
│   ├── workers/                     # 既有模型；新增数据宿主/IPC
│   ├── storage/                     # 新增快照/实验定义存储
│   ├── model/                       # 复用算法与强制 ORT 工厂
│   └── diagnostics/                 # 阶段事件
├── harness/                         # 保留原入口
├── scripts/                         # 数据验证/产品测试 runner
└── tests/
    ├── unit/, contract/, browser/
    └── fixtures/workbench/v1/       # 提交小型数据包
tools/workbench-fixtures/
├── pyproject.toml, uv.lock
└── generate.py
spikes/tabpfn35/export_workbench_reference.py
artifacts/workbench/acceptance/       # ignored 运行报告
```

**Structure Decision**: 复用单包，UI 独立编译，model 不依赖 React。数据宿主管理转换/哈希/编码，DuckDB worker 执行数据库计算，model Worker 拥有 ORT。应用服务编排，UI 不同步转换整表。契约中的新增接口不能假定现有 runtime 已具备。

## Phase 0 — Research outcome

[research.md](research.md) 的 R1–R10 覆盖结构、资产、数据、存储、导出、文件能力、固定数据、测试与运行时缺口。两名 luna_worker 完成资料收集，主代理汇总设计。没有新增依赖安装或模型运行；子代理执行了已有单元测试基线。

## Phase 1 — Design handoff

- [data-model.md](data-model.md)：快照、查询、实验 revision、运行、导出与数据包。
- [contracts/workbench.md](contracts/workbench.md)：流程、服务、Worker、SQL、取消/发布和错误。
- [contracts/fixtures.md](contracts/fixtures.md)：数据布局、变体、参考预算及验证命令。
- [quickstart.md](quickstart.md)：环境、已有基线、未来入口和端到端验证。

### Implementation dependency order

1. Setup 后数据生成与运行时数据基础并行：锁定原生工具生成正常文件和独立参考；真实数据库 executor 就绪且正常文件生成后立即执行独立 DuckDB 文件 probe，四项有结论且原件不变即可，不要求全部支持。最终 manifest/原生五格式校验等待 probe，文件或写入器变化后重生成摘要并复验。只读 SQL 和资产 URL 在运行时基础验证。
2. Foundation、数据包及文件 probe 完成后，补 WorkerModelClient、真实 executor 注入、预测 SQL 表及原子发布；验证 ordinal、无业务键、取消和注册失败。禁止无 executor/线性 fallback，保留 001 回归。
3. 实现数据服务/IPC、文件与远端导入、通用类型、统计和物化查询，数据快照绑定版本。
4. 新增 React app 与独立构建，贯通数据→SQL→配置→预测→查询，接入状态、错误与取消。
5. 实现实验/数据恢复、显式刷新及损坏/配额降级；复用模型/context 缓存。实现三种导出、元数据及往返验证。
6. 跑受控远端、异常输入、缓存、构建、真实模型和响应性验收，记录设备与指标；更新支持矩阵和运行说明。

数据与运行时基础可并行；产品集成和预测验收依赖两者及文件 probe。完整五格式校验调用锁定原生工具，无模型/官方参考环境依赖；浏览器用户无需 Python。日常测试使用已提交数据，不要求每次生成模型参考。

### Requirement traceability

| Requirements | 负责设计 | 证据 |
| --- | --- | --- |
| FR-001, 004, 005 | UI + query/materialized input | SC-001/002，schema/SQL/类型 |
| FR-002, 003 | source/import + capability probe | SC-002/007，本地/远端/文件矩阵 |
| FR-006, 007 | Worker client + publication | SC-001/004，真实 mean/行身份/回滚 |
| FR-008 | export bundle | SC-002，三格式往返与元数据 |
| FR-009, 011 | operation events/errors | SC-005/007，30 次交互与失败 |
| FR-010 | persistence | SC-006，零下载、刷新、损坏 |
| FR-012, 013 | generator/manifest | SC-002/003，五格式、体积/摘要 |
| FR-014, 015, 016 | cases + reference | SC-003/004/007，变体与独立 mean |

## Complexity Tracking

无 constitution 例外。独立数据宿主用于将整表转换与编码移出 UI，与 DuckDB worker 分工，不创建重复模型运行时。维护者工具使用独立锁文件，避免原生依赖进入浏览器。其余复用单包、IndexedDB 与既有测试工具，不新增业务服务器。
