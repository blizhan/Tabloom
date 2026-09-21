# 工作台接口与用户流程契约

这是待实施契约，命名代表工作台边界，不表示既有 runtime 已导出同名函数。实体字段见 [data-model.md](../data-model.md)。不新增网络业务服务。

## 页面流程

工作台包含数据源/表目录、SQL 编辑与结果预览、实验配置、运行状态和结果区。初始页提供“使用测试数据”和“添加数据”入口；键盘可操作，字段错误靠近输入显示。示例入口加载相同的已发布文件，不在浏览器里随机造另一份数据。

1. 选择文件、样本或远端地址 → 显示名称、格式、类型解释 → 导入成功后显示 schema/统计。
2. 分别编辑训练/预测 SQL → 预览总行数与最多 200 行 → 选择目标和有序特征。
3. 选择模型、任务与显式执行策略 → 能力检查 → 运行，显示阶段和取消入口。
4. 成功后展示结果表与输入身份 → 执行结果 SQL → 导出数据与元数据。
5. 保存实验 → 重新打开 → 校验并恢复固定输入；缺失内容提示重新选择。

模型列表中 TabPFN 3.5 可以接受用户训练数据；TabICL v2 限制为已有兼容案例，TabPFN 3 与分类等能力按现状禁用并说明原因，不为列表可点击而换模型。

## 应用服务操作

| 操作 | 输入 | 返回与行为 |
| --- | --- | --- |
| importSource | source descriptor、文件/URL、格式、类型解释、可选显式替换 | 完整 Snapshot + 表目录；失败不替换现有表 |
| refreshSource | sourceId、重新提供的访问地址 | 新快照；旧实验引用保持不变 |
| inspectTable | snapshotId、tableId | schema、总行数、空值计数及数值 min/max/mean |
| executeQuery | QueryDefinition | 物化查询身份、schema、总行数、分页预览 |
| configureExperiment | 训练/预测查询、目标、有序特征、模型/策略 | 不可变实验 revision 与验证问题 |
| runExperiment | experimentId、revision | runId；异步阶段事件；仅完整结果发布成功 |
| cancelOperation | operationId | 接收确认；最终 cancelled 单独通知 |
| saveExperiment / restoreExperiment | 定义或 ID | 定义及快照校验状态；不恢复失效 worker 句柄 |
| exportResult | 已物化结果 ID、格式 | 数据文件 + 元数据、摘要和格式解释 |
| inspectCapabilities | 当前浏览器与资产版本 | 模型、任务、文件操作及环境支持矩阵 |

服务分层：React 只调用应用服务；运行协调与发布复用现有 runtime；数据源获取、规范化、哈希、数据库查询和文件编码在数据侧执行。不得通过 UI 组件直接调用模型 adapter 或复制 estimator 逻辑。

## Worker 与响应关联

数据操作使用可序列化消息：`{protocolVersion: 1, requestId, operation, payload}`。响应为 success/error/progress/cancelled；所有响应携带 requestId，影响实验展示的响应还携带 experiment revision/generation。未知版本或操作返回受控错误。

File/Blob、Arrow IPC 及 ArrayBuffer 可跨边界传递；Arrow Table 实例、数据库连接、context handle 不跨 worker 直接 structured-clone。传输后所有权转移的 buffer 不得继续作为源数据缓存，需明确复制或从持久快照重新读取。预览只传受限分页数据；计算用 IPC/TypedArray，保留空值有效位。

数据服务串行执行数据库状态变更；查询和取消有独立请求身份。模型计算沿用已有模型 Worker，UI 仅接收状态与结果概要。新增数据处理宿主与 DuckDB 自带 Worker 各自承担转换/数据库计算，关闭时均需释放，不能在 UI 线程同步转换整个大表。

## SQL、发布与资源

- 训练/预测/结果入口接受单条只读关系查询，包括 CTE、JOIN、过滤、排序与聚合；参数与标识符使用对应绑定/引用规则。通过数据库解析与只读执行策略验证，不以字符串前缀检查代替。
- 数据只能从已注册快照读取。实施 bootstrap 必须验证查询对文件/网络函数及变更语句的拒绝；若目标依赖缺乏可靠只读策略，先采用临时查询库隔离并关闭外部访问，不能带着未验证的假设发布。
- 对导入、输入快照、结果发布及导出所需写操作使用内部连接/受控执行入口，与用户查询分开。用户不能覆盖运行时保留的结果或元数据表。
- 确认执行时冻结数据版本和查询 revision；预览之后修改 SQL 或来源需重新验证。运行实际物化输入后不再次执行 SQL 来猜测行对应关系。
- 重复业务键不是失败理由；返回均值数量和有限性检查通过后，运行时事务发布结果与元数据。
- 页面取消迅速反馈，但不声称已中止 GPU kernel。失败、取消、旧 generation 的响应不能替换当前成功结果；释放等待底层工作结束或可安全终止。

## 远端导入预算

应用启动时向数据服务注入 `remoteImportTimeoutMs`（默认 120000）和 `remoteImportMaxBytes`（默认 67108864，即 64 MiB），只接受有限正整数，测试可覆盖为较小值。总超时从发起请求到响应体读取完成计算；字节上限按浏览器可读响应流累计，非数据库或模型内存预算。

恰好等于字节上限允许完成，超出立即中止；可信 Content-Length 已超限可提前拒绝，缺失或不能用于判断时按实际流累计。SOURCE_TIMEOUT 建议重试或改用本地文件；SOURCE_TOO_LARGE 显示限制并建议准备更小文件。两者均取消读取、清理未完成内容、保留既有表，不隐式采样。取消与超时按首先生效的终态原因记录，后续信号不覆盖；用户取消不能被重新标成超时。

## 错误语义

新增应用错误带 `{code, stage, message, recovery, requestId, details?}`；既有 runtime 错误保留原因链并映射为用户说明。代码至少覆盖 SOURCE_UNREACHABLE、SOURCE_EXPIRED、SOURCE_TIMEOUT、SOURCE_TOO_LARGE、CORS_OR_NETWORK、INVALID_FORMAT、TYPE_LOSS、NAME_CONFLICT、INVALID_QUERY、EMPTY_INPUT、INVALID_TARGET、FEATURE_MISMATCH、UNSUPPORTED_CAPABILITY、INPUT_LIMIT、CACHE_UNAVAILABLE、CACHE_CORRUPT、RESULT_INVALID、EXPORT_FAILED、CANCELLED。

浏览器无法区分 CORS 与一般网络错误时应说“网络或跨域访问失败”，不虚构精确 HTTP 状态。可取得响应状态时保留状态；可执行恢复包括重试、修改来源、改用本地文件、修改查询、选择受支持配置或仅本次使用。

## 导出元数据

`metadataVersion: 1`，含数据文件名/格式/SHA-256、行数/schema/nullEncoding、结果类型、查询及参数、实验 revision、训练与预测 SQL、有序特征、目标/任务、数据快照摘要、模型与权重版本、运行 ID、实际 provider 与各阶段耗时。URL 凭证不导出。

CSV 必须采用可区分 NULL 与空字符串的明确编码并随附 schema。精度不能无损表达时拒绝或由用户明确选择有损方式，禁止默默舍入。聚合结果保留查询来源，不保证逐行预测关联；完整预测表导出与再导入必须保持所有行身份。
