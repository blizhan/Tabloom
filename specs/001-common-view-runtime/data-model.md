# Data Model: Common View Runtime

本文件描述逻辑实体与不变量；消息和保存格式见 [运行时契约](contracts/runtime.md)。所有 id 不从可变数组对象地址生成。SQL 内部表名由系统分配，用户列名按标识符规则转义。

## ModelArtifactManifest

- `schemaVersion`, `modelId`, `modelVersion`, `manifestDigest`, `preprocessingVersion` 和固定 profile。
- `precision`: fp32 / fp16-storage-fp32-compute；文件清单含相对 URL、角色、bytes、sha256、external-data path；图 I/O 名称、dtype、shape/bounds。
- `capabilities`：任务、缺失/Inf 支持、context 构建/导入支持、训练及预测边界。
- `providerCompatibility`：经验证的 provider/runtime 组合和允许的 context 来源 provider；Case artifact 另有固定训练身份。
- 不变量：所有文件验证后才 available；未知 schema/precision/profile 拒绝，不根据文件名猜版本。

## TrainingSnapshot

- `sourceSnapshotId`, 有序 `featureNames`、源类型 provenance、`rowCount`、独占 Float32 特征列、有限 target、`targetName`。
- `featureSqlFingerprint`（SQL + bound parameters 或 null）；`trainingDataDigest`、`schemaDigest`。
- 所有列同长、名字唯一，目标不进入特征矩阵；移交后调用者不能修改数据。
- 来源名称不替代内容摘要；同内容的新 sourceSnapshotId 不强制 miss。参与模型 schema identity 的是规范化有序列名与 Float32 类型，源类型只作 provenance。

## ContextIdentity / ContextSnapshot

- identity：模型 id/version、artifact digest、context format version、预处理实现版本、训练内容/schema/SQL 摘要、target name、resolved config digest（含 seed）和最终 `key`。
- snapshot：identity、`featureNames`、`identityInputs`（可重算 key 的规范记录）、fitted estimator state、构建 provider/runtime/source provenance、payload manifest checksum。
- `portable-tensors`：命名 tensor 列表，每项有 dtype、shape、byteLength、校验值和 CPU bytes 引用。
- `embedded-artifact`：TabICL 匹配 manifest digest、固定 train shape 与训练身份；不接受 tensor 替换。
- 恢复时重算 key，核对模型/profile；tensor byteLength 必须等于元素数乘 dtype 字宽，维度和总量不超过 manifest 限制。
- fitted state 是版本化允许字段集：permutation/fingerprint 配置与拟合状态、normalization、borders/tails/temperature，或 TabICL target scaler；不能包含可执行对象。
- 一个语义 key 可以有不同 provider/runtime 构建变体。查找先按 key 再按兼容性，不得用不兼容变体覆盖后当命中。

## LiveContext

- `handleId`, `adapterInstanceId`, `workerEpoch`, identity、owned CPU backing、可选 provider uploads、active-operation pins。
- 缓存命中可共享 backing，但每次返回独立 handle；release 只释放调用者的 handle。
- 状态：`ready → releasing → released`。设备故障使设备资源失效，当前运行失败；保存的 CPU snapshot 可在显式重载后恢复。
- adapter dispose 使其全部 handles 失效，不删除保存的 snapshots。export 返回独立快照。

## PredictionInputSnapshot / Scenario

- 输入：`inputSnapshotId`, `rowCount`, rows、`rowOrdinal` 0..N-1、原始业务键、特征列、baseline/parent id、创建时间。
- 情景：`scenarioId`, `streamId`, baseline reference、修改参数、不可变输入快照引用。
- 业务键/时间字段保留原类型；情景用 baseline ordinal 建立对应，不凭重复业务键推断。
- 行集合改变需新快照与明确 parent mapping，不宣称与基准一一相同。基准和情景互不原地修改。
- 运行、保留的结果或实验引用的 snapshot 不得清理；引用归零允许清理。

## PredictionRequest / Result

- request：`requestId`, `workerEpoch`, `contextHandleId`, `inputSnapshotId`, `scenarioId`, `streamId`, `generation`, `mode`（interactive/experiment）。
- 状态：`queued → running → succeeded | failed | cancelled | superseded`；queued 可直接取消。运行中逻辑取消可先完成，物理计算继续到清理结束。
- result：请求/上下文/输入身份、按 ordinal 排列的有限均值、模型/artifact/preprocessing/runtime/provider、阶段时间及 warnings。
- `mean.length === rowCount`；成功计算不等于发布成功，发布还检查 generation、epoch 和取消状态。
- interactive 每流只保留运行项和最新待执行项；显式 experiment 不合并，整体模型执行仍串行。

## Publication / Experiment

- `run_results`：request id + rowOrdinal 唯一标识，引用不可变 input snapshot，附带情景、context 和运行 metadata。
- `scenario_heads`：每 stream 的 generation、requestId 或 pending 状态，决定当前结果；基准有独立引用。
- `experiments`：显式保留的输入、修改参数、运行和结果引用；本期仅会话内，不承诺整个数据库跨重启恢复。
- 状态：reserve generation → pending → 原子发布 current 或 failed；错误不损坏历史结果。pending 时旧结果可作为“上一次结果”查看，不得标为当前情景计算结果。

## PersistentEntry / ResourceObservation

- entry：`kind`, semantic key、build variant、write generation、chunks、checksum、bytes、createdAt、lastAccess、state。
- 状态：`writing → verified → complete`；仅 complete 可查找。中断 generation 成为 orphan，后续清理；磁盘 entry 删除与 live allocation 引用独立。
- observation：device/browser/provider、阶段、耗时、owned byte counters、内存信号的 value 或 unavailable reason。owned bytes 不等同系统峰值。

## Relationships and trust boundaries

`TrainingSnapshot + model/config → ContextIdentity → ContextSnapshot → LiveContext`。

`PredictionInputSnapshot + LiveContext + Scenario → Request → Result → Publication`。

持久 context 不包含恢复完整实验所需的全部原始数据；Case 必须同时提供它声称可带入 Common View 的数据与配置。外部 manifest/snapshot 先验证结构、大小上限和 checksum，再分配张量。checksum 保证完整性，不是来源真实性；可信 model manifest 由应用配置固定。
