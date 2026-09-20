# Arrow Input and Result Publication Contract v1

## Dataset conversion

数据服务执行训练/预测 SQL 后物化一次逻辑结果。对每 batch、slice 的逻辑行读取 Arrow validity 与 offsets；不能把底层 value buffer 直接当完整列。接受 numeric integer/float，拒绝 decimal、dictionary、boolean、日期、类别等未声明类型，要求调用者用 SQL 明确转换。业务键和时间元数据可保留这些类型，只是不进入模型矩阵。

特征 null→NaN，之后按 adapter capability 接受/拒绝；target 必须存在、有限、非 null。64-bit integers 在转换前检查安全整数范围；普通有限值的 Float32 rounding 是规定语义，有限值溢出必须报错。Inf 必须 capability + 显式配置同时允许。重复列名、列长不一致、空数据和不匹配特征顺序拒绝。

先校验原始规模，再校验 fitted preprocessing 后图形状；不自动删行、重排、补列、抽样或 chunk 预测。纯转换模块接受 Arrow fixture，不要求启动 DuckDB。

## Input snapshot operations

- `materializeTraining(query, typedParams, features, target)`：得到冻结训练快照与 provenance；目标排除在特征外。
- `materializePrediction(query, typedParams, features)`：得到不可变 snapshotId、ordinal、原始 rows 与模型列；保留顺序由本次物化定义，无需 SQL 另有唯一键。
- `deriveScenario(baseSnapshotId, modifications)`：生成新 snapshot，保留基准对应与修改参数，绝不原地改 baseline。
- `retainSnapshot/releaseSnapshot`：调用运行/实验/结果都持有引用；引用归零才能清理。

同一 inputSnapshotId 不得绑定第二份不同数据。返回模型列时使用 owned copies，保留 data-service 的原始快照供后续 join。

## Result table schema

逻辑结果字段：request_id、input_snapshot_id、row_ordinal、scenario_id、context_key、model_id、model_version、artifact_digest、preprocessing_version、runtime_version、provider、mean、created_at、timings、warnings。主身份为 request_id + row_ordinal；input_snapshot_id + row_ordinal 回查保存的输入。

metadata 可规范化到 run 表，结果行引用 run；业务用户仍可通过查询视图同时读取。schema 名称固定，任意原始业务列保留在输入表，避免同名覆盖内部字段。

## Latest request and transaction protocol

data service 是唯一发布者，串行队列包含 reserve、cancel、publish 和 cleanup。模型 worker 不直接写数据库。

1. reserve(streamId, generation, requestId, epoch) 检查递增 generation，登记 pending head；之前结果保留为历史，不能称当前 generation 结果。
2. coordinator 收到 reserve 确认后才调度模型请求；UI 可更早显示新的 pending 状态。
3. publish 校验 envelope 身份、snapshot 存在、context key、expected rowCount、所有均值有限。先准备私有 staging 数据，不能成为当前用户结果。
4. 在串行数据操作中开启事务，重新确认 generation/epoch/request 未取消且匹配；插入完整 run/results 并更新 head，commit 后才通知 published。
5. stale、cancelled、长度/数值错误或任何写入失败则 rollback/清理 staging，不更新 head；旧的 retained results 保持可查。

reserve 与 publish 的线性化由 data-service 队列确定，不在 await 之间让另一个发布事务插队。最新 UI 请求到达但 reserve 尚未确认时，UI 已屏蔽旧回复；reserve 确认后数据库 head 同样屏蔽旧代结果。不要声称异步消息在到达前已经使远端操作失效。

显式 experiment 不采用 interactive head 合并，独立 request 身份保存，仍受 epoch/cancel/有效性检查。结果删除与 snapshot 引用递减在同一数据操作中，避免留下悬空 join。

## Case to Common

转移的是实验 descriptor：dataset/snapshot refs、SQL/typed params、target、model/artifact、context identity/handle 或 snapshot reference、scenario modifications、result refs。同运行时保留 ids；跨 model-worker 必须导入持久 snapshot 并生成新 handle，但语义身份不变。Case 原始训练数据不可用时不得伪装成可任意编辑训练的 Common View。

TabICL Case 训练变更返回 UNSUPPORTED_CAPABILITY，不继续使用固定 cache，不自动切换模型。

## Acceptance matrix

- 分块/slice/null/Float64/安全边界 integer：值、顺序与 missing 语义一致。
- 重复业务键、源查询重排、独立新查询：join 仍回到本次保存的输入。
- 连续 20 请求、取消和迟到回复：只有最新 generation 为 current。
- 非有限输出、数量不符、事务失败：无部分可见结果。
- baseline 与 scenario 不互改；保留结果阻止输入清理，显式删除后无悬空引用。
- DuckDB 实际 Arrow insertion/transaction API 在锁定依赖安装后由真实浏览器 smoke 确认，不能以 fake database 测试替代。
