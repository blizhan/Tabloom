# Research: Common View Runtime

Date: 2026-09-17. 本阶段采用仓库源码、已有实验报告和包注册表元数据；未执行新的模型、浏览器或 DuckDB 实验。以下区分已验证证据、设计选择和实施验证门槛，不把方案决策写成测试结果。

## R1. 产品代码结构与依赖

**Decision**: 新建单个 `runtime/` npm 包（`@tabloom/runtime`），其中分离纯模型运行时、数据转换、查询集成、Worker 和最小验证页面。先不建立多包 workspace 或完整 React 产品页面。TypeScript 5.9.3，Node 22.22.3 作为复现基线；沿用 ORT Web 1.30.0、Vite 7.3.6、playwright-core 1.63.0、sirv 3.0.2。单元测试采用编译后的 `node:test`，真实浏览器检查沿用 Playwright-core runner 方式。

**Rationale**: 当前只有两个独立 spike web 包，没有根 package.json 或产品运行时。一个包已能以不同入口隔离依赖，避免同时引入 workspace 和产品 UI。已有 spike 锁定的浏览器工具链具有实验依据。

**Alternatives considered**: 多个 packages 与 apps workspace，后续确有独立发布需求时再拆；直接扩展 spike 会让 fixtures、页面全局状态和产品资源所有权混在一起。

**Evidence**: `spikes/tabpfn35/web/package.json`、`spikes/tabiclv2/web/package.json`、各自 `run-browser.mjs`。本地 Node/npm 为 22.22.3/10.9.8。注册表确认 TypeScript 5.9.3 存在。

## R2. DuckDB 与 Arrow 配对

**Decision**: 实施锁定 `@duckdb/duckdb-wasm@1.33.1-dev57.0` 与直接依赖 `apache-arrow@17.0.0`，通过新包 lockfile 固定完整依赖图。该 DuckDB 包名含 dev，不将其称为稳定版；不使用浮动 latest。通过导出的库入口进行查询及 Arrow 注册，不依赖内部模块。

**Rationale**: 本次 `npm view @duckdb/duckdb-wasm version dependencies --json` 返回该版本，其 Arrow 依赖为 `^17.0.0`；注册表确认 Arrow 17.0.0 可用。仓库没有安装它们，也没有已验证的 DuckDB 集成。

**Alternatives considered**: 随意选择其他 Arrow 大版本可能引入重复依赖与对象不兼容；先使用行对象/JSON 会丢失本次需要验证的 Arrow 空值、分块和数值语义。

**Implementation gate**: 安装后先验证查询→Arrow→转换、Arrow 结果注册、事务回滚和 worker 资产加载。失败时记录具体兼容原因并调整显式版本及本记录，不静默升级。设计未知项已明确为依赖兼容验证，不影响需求范围。

## R3. 模型路径和数值参考

**Decision**: TabPFN 使用动态 context/prediction 两图，共享 FP16 存储权重，计算仍为 FP32；保留 FP32 参考交付。固定单成员、none preprocessing、fingerprint 和 fitted permutation，不支持其他自动选出的预处理配置。新增完整 estimator golden 导出器后再移植预处理/解码。

**Rationale**: 已有共享 blob 为 427,785,792 bytes；context 输出 54 tensors，prediction 接受 `x_test` 和这 54 tensors。Python parity probe 调用了官方预处理/解码，但只输出摘要与前五个均值，尚不能独立验收 TypeScript。指纹列会增加模型输入宽度。

**Alternatives considered**: 单一大图失去灵活的 context 生命周期；只比 raw logits 不能证明最终均值和原始目标单位正确；继续依赖 Python 在线处理违背产品边界。

**Evidence**: `spikes/tabpfn35/RESULTS.md`、`probe_estimator_parity.py`、`probe_context_build_export.py`、`probe_dynamic_context_prediction_export.py`、`probe_shared_onnx_weights.py`。现有参考误差与 spec SC-002 的拟定预算分别记录，不能混称。

**Implementation gate**: fixture 必须包含原始数据、完整拟合状态、随机过程/指纹状态、处理后数据、解码输入和全部最终均值；多个 seed、重复行、常量列与极端数值另设回归样本。每个中间阶段在移植前固定自己的误差预算，失败不得直接放宽最终预算。

## R4. TabICL 能力限制

**Decision**: 采用 artifact-bound Case snapshot。`canBuildContext=false`；导入时校验案例 artifact、固定训练形状、特征与 target scaler，不提供任意 tensor context 注入。

**Rationale**: `CachedRegressor` 将 30 个 cache tensors 注册为 buffers，`forward` 只有 `x_test`。图已经做了 999 quantiles 排序并取均值，adapter 只做所需特征转换和目标逆缩放，不重复解码。

**Alternatives considered**: 直接声称实现通用 fit 会误用原训练数据；本期重新导出动态训练图会引入尚未证明的技术路线，因此留作独立后续门槛。

**Evidence**: `spikes/tabiclv2/probe_export.py`、`prepare_web_fixture.py`、`RESULTS.md`。现有报告中的图输出误差不是自动适用的原始目标单位预算。

## R5. Worker、调度和原子结果发布

**Decision**: 应用协调器拥有取消/最新请求状态；模型逻辑在自有 module Worker 内运行，关闭 ORT 自带 proxy。数据服务使用 DuckDB 异步 worker 及一个串行命令队列，权威维护 generation 与结果发布。协同取消不承诺打断正在执行的 ORT kernel。

**Rationale**: 已安装 ORT 暴露 session release、tensor readback/dispose；其 proxy 对部分输出位置选项有限制。现有 spike 在页面内执行，不能作为新 Worker 架构已通过的证据。协调器留在不执行同步模型计算的位置，即使模型 worker 忙碌仍可接收取消并拒绝迟到结果。

**Alternatives considered**: 页面内运行会影响交互；同时启用两层 ORT proxy 增加资源/转移所有权复杂性；只在 UI 丢弃旧结果无法阻止数据库陈旧写入。

**Implementation gate**: 首个真实模型浏览器测试验证 module Worker 中两 provider。数据服务以同一串行队列线性化 reserve-generation 和 publish，事务中重查 generation；这是持久结果最新性依据，见 contracts。

## R6. Context 所有权与缓存身份

**Decision**: live context 是单 adapter 实例的 opaque handle；portable snapshot 使用自有 CPU bytes 和版本化拟合状态。GPU 数据先完成 readback/copy，再释放 context session。引用计数保护正在使用的上下文，export 产生独立快照。

**Rationale**: `ReadonlyMap` 不能保护 tensor 内容，session 输出也不能直接当持久对象。训练 key 覆盖规范化内容、schema、配置/seed、SQL/参数、权重图版本和预处理版本；provider 来源单独记录并按兼容矩阵检查。

**Alternatives considered**: 仅 SQL/data source 名称作为 key 无法检测标签更新；序列化 ORT/Python 对象会把保存格式绑定到运行状态。

**Implementation gate**: 完整关闭/重启 worker 后恢复并对比所有输出；不同 provider 间恢复只有对应 artifact 的交叉测试通过才进入兼容矩阵。默认只允许同 provider 恢复。

## R7. 持久化与下载

**Decision**: MVP 只实现 IndexedDB：大 payload 分成固定上限 8 MiB chunks，每次写入独立 generation，最后提交 complete manifest。内容完成校验前不可见；清理不完整 generation 与无引用 chunks。OPFS 留在可替换存储接口之后，不在本期同时实现第二后端。

**Rationale**: 一套存储减少配额、恢复及原子性分支。blob 仍只 fetch 一次，两个 session 共用 store-owned buffer；缓存恢复后仍校验整体验证信息。manifest 发布使用单个 IndexedDB 事务，chunk 写入可以分批，不谎称整个下载是一个长事务。

**Alternatives considered**: OPFS payload + IndexedDB index 更适合大文件扩展，但需要额外的跨存储恢复协议；整块 428 MB 单记录写入增加临时副本压力。先使用 Web Crypto SHA-256 校验整 buffer，并测量 digest/存储产生的临时内存；若目标设备失败，再以保持同一 digest 格式的增量实现替换。

**Scope**: 同一 runtime 实例的并发加载去重是本期保证；跨标签页下载合并不承诺。浏览器清理本地存储不是数据永久性保证。

## R8. 内存与资源策略

**Decision**: 默认 staged sessions，一次仅一个模型被激活。新 fit 前释放旧 prediction session（保留 live context 的 CPU backing）；构建 context、复制输出、释放 builder 后才创建 prediction session。已有 context cache hit 不创建 builder。

**Rationale**: 共享下载未证明 ORT/GPU 分配共享。warm scenario 可以保持 prediction session，切换训练数据可接受再次初始化的开销。

**Alternatives considered**: 同时驻留两个 session 仅作受控对比测试，只有目标设备证据充分才改变默认；不能等 OOM 后再假定可以在受损 device 上无缝重试。

**Implementation gate**: SC-007 的 20 次循环、两生命周期对比，记录 JS/WASM/GPU 可用信号、owned bytes、读回副本、失败与 unavailable 字段。浏览器未暴露 GPU 峰值时不作零占用结论。

## R9. 可复现交付与验收

**Decision**: 新 harness 采用本地静态资产与现有 COOP/COEP 头设置，ORT/DuckDB worker 和 WASM 文件使用锁定依赖的同源构建资产；选择单线程 WASM 初始回退，不承诺多线程增益。发布环境另验正确 MIME、隔离头和 worker 路径。

**Rationale**: 现有 localhost probe 有隔离头及本地模型服务；正式静态站点和浏览器存储尚未经过同样验证。生成的权重留在 ignored artifacts；小型公开合成 golden fixtures 版本化提交。

**Alternatives considered**: 自动从第三方 CDN 选择最新资产会破坏版本与离线复现；在本期构建全部产品界面扩大范围。

**Validation boundary**: quickstart 明确区分现在已有的 spike 命令与实施后应提供的产品命令。Python/CUDA 仅用于开发者生成官方参考，不属于浏览器使用者依赖。
