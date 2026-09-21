# Data Model — Phase 1 工作台

本文件描述新增工作台实体及与 001 的映射；既有训练上下文、模型 artifact、运行句柄和预测发布规则继续由运行时拥有。

## 1. SourceDescriptor 与 DataSnapshot

`SourceDescriptor` 字段：`sourceId`、`displayName`、`kind`（local/remote/sample）、`format`（csv/parquet/arrow/json/duckdb）、`locator`、`createdAt`。远端 locator 的凭证不进入导出或日志；缓存恢复依靠快照，链接过期后的刷新需重新提供有效地址。

`DataSnapshot` 字段：`snapshotId`、`sourceId`、`schemaVersion`、`rawContentHash`、`logicalContentHash`、`byteLength`、`format`、`typeInterpretation`、`tables[]`、`acquiredAt`、`cacheState`、`complete`。`tables[]` 包含表身份、schema、行数及各列统计。一个数据库文件可包含多个表，不能把文件与表等同。

规则：

- `rawContentHash` 对原文件/完整响应计算 SHA-256；格式和类型解释共同参与 `snapshotId`。跨格式等价通过规范化 schema、记录和空值验证，不能直接比较原文件 hash。
- 表显示名称是别名；替换别名不修改旧快照，已保存实验继续引用旧身份。同名导入先提示改名或显式替换。
- 导入在 staging 中完成校验后才可见；中断留下的内容没有 `complete`，不得命中缓存。
- 大整数保留整数表示，时间带明确 UTC 语义，NULL 与空字符串分别记录；不允许隐式精度损失。

状态：`selected → acquiring → validating → registering → ready`；任一步可进入 `failed/cancelled`。持久状态独立为 `not-saved/writing/complete/corrupt/unavailable`，持久失败不自动使内存中的 ready 数据失效。

## 2. QueryDefinition 与 MaterializedInput

`QueryDefinition` 字段：`queryId`、`role`（training/prediction/result）、`sql`、`parameters`、`snapshotBindings`（表别名到快照内表身份的映射）、`revision`。

`MaterializedInput` 字段：`inputId`、`queryId`、`queryRevision`、`snapshotBindings`、`schema`、`rowCount`、`contentHash`、`orderedFeatureNames`、`targetName?`、`runtimeInputSnapshotId`。实际模型输入从物化结果生成，预览不得成为另一份未绑定版本的预测来源。

规则：SQL 只读入口、参数类型显式；训练目标有限非空，预测特征与训练的名称/顺序匹配；特征缺失遵循模型能力，默认拒绝无限值；训练、预测空结果在模型准备前拒绝。预览最多显示 200 行，必须显示总行数和“仅预览”提示，模型输入不得因此被截断。

行身份：数据包 `source_row_id` 是原始业务数据，不能替代运行时逐行身份。重复键、连接扩张或查询重排时，运行时 input snapshot 的 `(inputSnapshotId, rowIndex)` 是唯一预测关联依据；保留业务键用于用户查询。

## 3. WorkbenchExperiment

字段：`experimentId`、`schemaVersion`、`name`、`revision`、`createdAt`、`updatedAt`、`trainingQuery`、`predictionQuery`、`orderedFeatureNames`、`targetName`、`taskType`、`modelSelection`、`providerPolicy`、`seed`、`snapshotRefs[]`、`runtimeExperimentId?`。

`modelSelection` 固定模型 ID、权重/交付版本、配置版本和精度；`providerPolicy` 显式声明可用 provider 及是否允许降级。用户编辑配置产生新 revision；运行冻结当前 revision，后续编辑不改变运行输入。

状态：`draft → validating → ready → running → succeeded/failed/cancelled`。配置修订与每次运行分开记录；失败运行不删除上一次成功结果。

恢复：先读取实验定义并校验引用快照，再注册数据和重建运行时实验。模型和 context 由已有存储恢复，旧的 worker/context 句柄不可序列化。缺失快照标记 `needs-data` 并提供重新选择/导入方式，不自动查询新远端版本替代。要求恢复定义和输入，不额外承诺所有历史结果跨重启自动恢复。

## 4. WorkbenchRun 与 PublishedResult

`WorkbenchRun` 字段：`runId`、`experimentId`、`experimentRevision`、`requestId`、`generation`、`status`、`stage`、`progress?`、`timings`、`resourceObservations`、`actualProvider`、`error?`、`runtimeResultId?`。

阶段包括 data-acquire/query/validate/model-download/model-init/context/predict/publish/export。进度缺失不伪造百分比；资源观测为 `{value, unit, source}` 或 `{unavailableReason}`。

状态：`queued → running → publishing → succeeded`；取消为 `cancel-requested → cancelled`；异常为 `failed`。取消确认后不再将该结果发布为当前结果；底层任务未终止时暂不启动会破坏资源所有权的新任务。`requestId` 配合 generation 防止迟到响应覆盖当前界面。

`PublishedResult` 指向运行时结果表和实际输入快照，含 `runId`、`resultId`、`tableName`、`rowCount`、`inputSnapshotId`、`metadata`。输出数量不符或非有限时不发布；数据库写入失败回滚，不显示半张表。

## 5. ExportBundle

字段：`exportId`、`format`、`dataFile`、`sha256`、`rowCount`、`schema`、`nullEncoding`、`resultKind`（row-predictions/query-result/aggregation）、`query`、`experimentDefinition`、`runMetadata`、`snapshotRefs`、`createdAt`。

CSV 元数据必须声明编码、分隔符、引用和 NULL 规则；schema 附带逻辑类型与单位。数据文件与 `<filename>.metadata.json` 成对下载，也可打包为单一下载。恢复实验元数据不自动执行 SQL 或拉取远端地址，先预览并验证依赖。

## 6. CapabilityEvidence

字段：`capabilityId`、`operation`、`status`（supported/constrained/unsupported）、`reason`、`limits`、`browser`、`dependencyVersions`、`evidencePath`、`checkedAt`。

数据库文件 open/attach/read/write 分别一条；模型任务与当前设备能力分别展示。证据缺失时保持 unsupported/unverified 展示，不因存在类型声明视为支持。运行设备与验收设备不同时重新检测环境条件。

## 7. FixtureManifest 与 FixtureCase

`FixtureManifest`：`datasetId`、`version`、`schemaVersion`、`synthetic: true`、`license`、`generatorVersion`、`seed`、`timeZone: UTC`、`forecastOrigin`、`featureOrder`、`files[]`、`expectedStats`、`cases[]`、`reference`。

`files[]`：相对路径、用途、格式、字节数、SHA-256、表名、schema、记录数。`FixtureCase`：`caseId`、`inputs`、`operation`、`expectedStatus`、`expectedErrorCode?`、`expectedCounts`、`expectedValues?`、`requirementIds`。

`reference`：官方 estimator 名称/版本、权重摘要、配置/种子、输入摘要、输出文件、目标单位、绝对/相对误差预算、生成命令、参考环境；数据真值与参考模型输出分别保存。

规范数据字段：

| 字段 | 逻辑类型 | 语义 |
| --- | --- | --- |
| source_row_id | int32 | 样本行号，正常数据唯一 |
| business_key | string | 可读业务身份，异常变体允许重复 |
| target_time | UTC timestamp | 预测目标小时 |
| features_available_at | UTC timestamp | 该行四个特征最晚可用时刻 |
| temperature_c | float64 | 定点生成的摄氏温度 |
| wind_speed_ms | float64 | 非负风速 |
| solar_wm2 | float64 | 非负辐照 |
| hour_utc | int32 | 0–23，模型中作为数值特征 |
| demand_mwh | float64 | 仅历史训练数据与独立真值文件含此目标 |

正常数据为 256 个训练小时与随后 32 个预测小时；统一 forecastOrigin 为首个预测小时。全部训练目标已在 origin 前或当时可用；未来天气明确标注为在 origin 可用的合成预报输入，不能标注为未来实测。真值文件按 source_row_id 关联，默认不导入模型输入表。

## 8. 引用与清理

Source → 多个不可变 Snapshot → 多个 Query/Experiment revision → 多个 Run → PublishedResult → ExportBundle。删除显示别名不等于删除快照；删除实验后，仅无实验与结果引用的快照可回收。模型和 context 的清理由已有运行时存储负责，工作台不直接释放其 GPU 对象。
