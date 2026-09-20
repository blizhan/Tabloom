# Implementation Plan: Common View Runtime

**Branch**: `main` | **Date**: 2026-09-17 | **Spec**: [spec.md](spec.md)

**Input**: `specs/001-common-view-runtime/spec.md` and the reviewed [runtime design](../../docs/superpowers/specs/2026-09-17-common-view-runtime-design.md).

**Feature identifier**: `001-common-view-runtime`. setup-plan.sh reports this identifier as BRANCH via feature-directory fallback; git branch --show-current remains main. No branch was created or switched.

## Summary

提供独立于产品 UI 的浏览器运行时：用 TabPFN 3.5 为数值训练数据建立可复用上下文，运行情景预测，将结果准确对应到保存的输入并注册到查询环境。TabICL v2 先支持绑定预构建 artifact 的案例，明确拒绝任意训练。

采用一个 TypeScript 包及独立模块入口。模型在自有 Worker 中执行；协调器和数据服务保证取消、情景 generation 与事务发布。共享一次下载的模型内容，默认分阶段创建/释放两张图，使用可保存 CPU snapshot 与不跨实例的运行句柄。首版使用 IndexedDB 分块缓存，不同时引入 OPFS 后端。数值实现先由完整官方 golden fixtures 定义，再逐层验证。

## Technical Context

**Language/Version**: TypeScript 5.9.3；Node 22.22.3/npm 10.9.8 开发复现基线。开发参考生成沿用 Python 3.12 和两个 spike 各自 lockfile。

**Primary Dependencies**: onnxruntime-web 1.30.0、@duckdb/duckdb-wasm 1.33.1-dev57.0、apache-arrow 17.0.0；Vite 7.3.6、playwright-core 1.63.0、sirv 3.0.2。新增依赖以 runtime/package-lock.json 固定。DuckDB/Arrow 配对来自注册表声明而非本地运行验证，先过 bootstrap 集成门槛。

**Storage**: DuckDB 浏览器内存库保存输入快照与结果；IndexedDB 保存分块权重和 context snapshots。运行上下文为 model-worker 内的 CPU/GPU 资源。实验输入/结果的跨浏览器重启保存不在本期，持久 context 不等于持久整个实验。

**Testing**: 编译后 node:test 用于纯逻辑及契约；Playwright-core + Chromium 用于真实 DuckDB、Worker、IndexedDB、ORT。轻量故障/并发测试采用可控 fake adapter；真实 WASM 与非软件回退 WebGPU 分别验收完整均值。

**Target Platform**: 支持 module Workers、IndexedDB 和 WASM 的桌面 Chromium；hardware WebGPU 优先、显式允许的 WASM 回退。localhost/HTTPS，同源 worker/WASM 资产，部署时验证 COOP/COEP 与 MIME。当前 spike 基线 Chromium 152/NVIDIA GB10，不泛化为所有浏览器保证。

**Project Type**: 浏览器库 + 最小集成验证页面，无服务端、账户或完整产品 UI。

**Performance Goals**: 未变训练条件的情景重算不重建上下文；并发首次加载单次下载、持久命中零模型内容下载；20 次情景请求无陈旧覆盖；20 次准备/预测/释放无资源不足失败。记录延迟，不把 spike 的约 41–53 ms 当成全流程 SLA。

**Constraints**: TabPFN 单成员、none 预处理和验证过的指纹/打乱规则；FP32 均值预算 1e-4、FP16-storage 2e-3（仅现有合成参考）。原始数据不上传推理服务。一次激活一个模型；取消不保证 kernel 中断。约 428 MB 共享权重不代表运行时内存占用。无静默模型/精度/执行方式切换。

**Scale/Scope**: TabPFN 3–1,024 训练行、1–1,024 预测行、处理后 1–32 特征；TabICL 训练/特征固定到 Case manifest，预测行 1–1,024。4 个故事，17 项功能需求，8 项成功标准。

## Constitution Check

**Before Phase 0**: .specify/memory/constitution.md 仍是占位模板，无已采纳原则可形成额外 gate。遵循用户关于简单任务可省略 TDD 的偏好；本次只规划，不编写实现或测试。

**Feature gates**（来自规格而非伪造 constitution）：

| Gate | Pre-research | Post-design evidence |
| --- | --- | --- |
| 浏览器内计算、不依赖在线 Python | Pass | 模型 Worker；Python 仅作为开发 fixture 生成器 |
| TabICL 不承诺任意训练 | Pass | embedded-artifact snapshot 与明确 capability error |
| 预测关联与复用身份可验证 | Pass | [数据模型](data-model.md)及[data 契约](contracts/data-and-publication.md) |
| 不静默降级或发布陈旧结果 | Pass | [运行时契约](contracts/runtime.md)中的 provider 策略和取消协议 |
| 数值与资源证据区分于预期 | Pass | [research](research.md)和[quickstart](quickstart.md)明确历史证据与待实施验证 |

**After Phase 1**: Pass；无未解释的范围例外或待用户决策的澄清项。依赖安装、Worker provider、完整 golden、目标设备内存属于已列出的实施验证门槛，不表示它们已经通过。正式 constitution 将来采纳后需重新检查。

## Project Structure

### Documentation (this feature)

```text
specs/001-common-view-runtime/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── checklists/requirements.md
└── contracts/
    ├── runtime.md
    ├── persistence.md
    └── data-and-publication.md
```

tasks.md 由后续 speckit-tasks 生成，本阶段不创建。

### Source Code (repository root)

以下是待实施结构，当前仅有 spikes 与 artifacts：

```text
runtime/
├── package.json, package-lock.json, tsconfig.json, vite.config.ts
├── src/
│   ├── index.ts                 # 模型中立的公开接口
│   ├── coordinator/             # 请求调度、取消、Case/Common 共享实验状态
│   ├── data/                    # Arrow 转换、输入快照、DuckDB 注册
│   ├── workers/                 # model worker 与 data-service 消息边界
│   ├── model/                   # adapter contracts、session/context ownership
│   │   ├── tabpfn35/            # fitted preprocessing、decode、adapter
│   │   └── tabiclv2/            # Case adapter、目标逆缩放
│   ├── storage/                 # artifact/context stores、IndexedDB chunks
│   └── diagnostics/             # 状态、阶段耗时、可用资源信号
├── harness/                     # 最小 Common/Case 集成验证入口
├── scripts/                     # fixture provisioning 与 browser test runner
└── tests/
    ├── unit/
    ├── contract/
    ├── browser/
    └── fixtures/                # 小型合成 golden 与固定校验值
spikes/tabpfn35/                 # 保留原有 probe；增加完整 golden 导出能力
spikes/tabiclv2/                 # 保留原有 probe；补全 Case fitted metadata
artifacts/                      # 既有 ignored 大模型/完整中间输出/运行报告
```

**Structure Decision**: 单包内按所有权分模块；纯 model 接口不能 import DuckDB、页面或产品状态，data 入口负责数据库依赖。无需为了模型中立性先拆多个包。harness 只证明契约，不承担最终 UI。原 spike 脚本行为保留，新 exporter 可以复用其中已验证函数。

## Phase 0 — Research outcome

[research.md](research.md) 的 R1–R9 记录依赖、模型证据、缓存、Worker、存储及数值决策。按技能要求完成两个只读并行调研：模型/fixture 边界与浏览器数据/资源集成。注册表只用于确定新增依赖版本，不宣称完成兼容实验。

## Phase 1 — Design handoff

- [data-model.md](data-model.md)：身份、实体、引用关系及状态转移。
- [contracts/runtime.md](contracts/runtime.md)：库接口、Worker 协议、失败与资源所有权。
- [contracts/persistence.md](contracts/persistence.md)：artifact/context manifests、规范化摘要与恢复。
- [contracts/data-and-publication.md](contracts/data-and-publication.md)：Arrow 语义、输入快照和最新结果发布。
- [quickstart.md](quickstart.md)：现有 probe 命令、未来验证入口及 SC 对照。

### Implementation dependency order

1. 锁定依赖，建立最小 harness，验证 DuckDB/Arrow 往返与 model module-worker 中真实 provider；同时导出完整官方 golden。无法通过则先修复此基础门槛。
2. 实现纯数据校验、规范化 identity、snapshot codec、受控错误和调度契约；用小 fixtures 验证，无需每次加载大模型。
3. 实现共享 artifact loading 与 staged session，移植 TabPFN fitted preprocessing/decode，按中间阶段及最终均值验证。
4. 接入持久缓存、恢复、句柄释放、故障和配额降级；验证重启与重复生命周期。
5. 接入 DuckDB 输入快照、情景 generation 和事务结果发布，打通 User Stories 1–3。
6. 实现 TabICL embedded Case adapter 和 Case→Common 身份传递，验收 Story 4；不添加动态 TabICL context graph。
7. 在两 provider 与目标设备收集最终证据；将未通过的配置维持 unsupported，不放宽需求冒充通过。

### Requirement traceability

| Requirements | Owning design | Main evidence |
| --- | --- | --- |
| FR-001, 003, 004, 005 | data / publication contract | SC-001、Arrow 往返与坏数据拒绝 |
| FR-002, 006, 015 | model adapters / runtime contract | SC-002、SC-006、完整均值 |
| FR-007, 008, 009 | context identity / persistence | SC-003、标签/版本变更失效 |
| FR-010, 011 | artifact store / persistence | SC-005、下载次数/配额/中断 |
| FR-012, 013, 014, 016 | coordinator / worker lifecycle | SC-004、SC-007、SC-008 |
| FR-017 | input snapshot references / publication | SC-001、SC-004、保留与清理测试 |

## Complexity Tracking

无 constitution 例外。刻意只引入一个产品包、一种持久后端、一个串行模型队列和一种默认 session 生命周期。两个 Worker 职责用于隔离计算与数据库所有权，并确保模型忙碌时协调器仍能处理取消；这是本特性行为所需的复杂度。
