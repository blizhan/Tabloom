# Runtime and Worker Contract v1

范围：浏览器库公开接口与跨 Worker 消息，不提供 HTTP 推理端点。实体字段见 [data-model](../data-model.md)，规范 identity 与磁盘格式见 [persistence](persistence.md)。

## Adapter operations

| Operation | Input | Success | Failure/ownership |
| --- | --- | --- | --- |
| capabilities | model id / selected manifest | 声明任务、profile、行列边界、context 能力、missing/Inf 支持 | 未加载时按 manifest 描述，不宣称设备已可用 |
| load | manifest reference + expected digest、preferredProvider、allowWasmFallback=false | actual provider、runtime version、warnings | 校验失败不得创建 session；同实例同配置重复调用共享初始化 |
| fitContext | TrainingDataset、targetName、sourceSnapshotId、SQL fingerprint/null、profile、seed | 独立 ModelContext handle + identity | TabICL 先返回 unsupported；输入独占复制/转移后才开始 hash |
| importContext | validated ContextSnapshot | 新的本实例 handle | artifact、schema、provider compatibility 不符则拒绝 |
| exportContext | 本实例有效 handle | 独立 owned CPU ContextSnapshot | 导出期间 pin backing，不能转移走 live bytes |
| predict | 有效 handle、TabularDataset、request/inputSnapshot/scenario ids | mean + ids + contextKey + metadata | 列顺序、shape 或数值不符拒绝；不从预测行拟合统计量 |
| releaseContext | handle | 该 handle 已失效，pins 结束后释放 backing | 对同实例已释放 handle 幂等；foreign handle 报错 |
| dispose | 无 | queued 工作结束为 cancelled，running 物理工作清理完毕，资源释放 | 幂等；开始 dispose 即拒绝新请求 |

TrainingDataset 有非空 target；普通 TabularDataset 不含 target。所有数组长度与 rowCount 一致，feature names 唯一有序。支持的模型 profile 固定为 TabPFN 单成员 none/fingerprint/shuffle/no target-transform，以及 TabICL Case 单成员 normalization none/no shuffle。不能把其他配置当作同一模型结果。

## Runtime state

`new → loading → ready → disposing → disposed`。加载失败进入 failed，清理部分资源；显式创建新实例重试。ready 的模型选择和 load 配置不允许原地变更，先 dispose 再加载。

staged 默认策略：fit cache miss 前释放已有 prediction session，保留 CPU context backing；builder 运行并将全部输出复制为 context-owned bytes，释放 builder 后创建 prediction session。cache hit 不创建 builder。warm predict 保留 prediction session。失败时清理当前调用的临时张量，不释放其他有效 handle 引用的 backing。

TabICL import 必须匹配该实例选定的 Case artifact；同一实例不能偷偷重新绑定另一份训练 cache。Case→Common 可以保留同一实例；跨实例必须 export/import。

## Worker envelope

每条 command 有 `protocolVersion: 1`, `workerEpoch`, `requestId`, `operation`, `payload`。终态 reply 为以下一项，恰好一次：

- success：同 envelope ids、结构化 result；
- failure：`code`, `message`, `stage`, `retryable`, 可选安全 details；
- cancelled/superseded：同 ids、原因。

progress event 不算终态，字段为 ids、stage、completed/total（不可知时 null）、timings 和 warnings。收到未知 version、旧 epoch 或未知 operation 即拒绝。ORT session/tensor 实例不得穿过消息边界。来自 worker 的 handle id 只是代理标识，不能由调用者伪造跨实例使用。

控制命令：`cancel(requestId)`, `status()`, `dispose()`。协调器在 UI 执行上下文中立即记录逻辑取消、更新本地状态并通知 data service；模型 worker 即使暂时无法处理消息，也不能让迟到结果被提交。dispose 的 completion 与取消 ack 不同：只有物理工作结束并完成清理才返回 dispose completion。

## Request scheduling

协调器每 interactive stream 保存一个运行项和一个最新 pending 项，generation 单调递增。模型 worker 全局串行，不并行跑两个 session 操作；多个流进入公平 FIFO，替换同流 pending 时显式通知被替换请求。显式 experiment 不合并，按 FIFO 执行。

开始新情景先向 data service reserve generation，收到确认才让该请求可运行；publish 必须经 [data contract](data-and-publication.md) 检查。取消和 reserve 同样由 data service 串行登记，跨系统消息到达前已经完成的提交按先前状态线性化，但一旦新 generation 被接受，旧结果不能成为新的 current。协调器从用户提出新请求起就不显示旧回复为当前结果。

不承诺 ORT kernel 可中断；running 被逻辑取消后，它的 tensors 在计算结束时释放。丢弃结果时同样执行 finally 清理。设备丢失报 DEVICE_LOST、失效 device resources，禁止隐式 WASM 重跑。

## Ownership and transfer

- ArtifactStore 的共享权重 buffer 不 transferable 给其他 worker、不被 session 调用者修改；store 位于 model worker。传给两 session 的是同一对象。
- Data service 保留原始快照，只转移独占的 feature copies；向 UI 返回结果时不转移仍被持久/运行对象引用的 backing。
- CPU snapshot 是 durable source；GPU tensors 只是派生资源。读取 GPU 输出完成后才能释放 producer。
- model worker 使用应用自己管理的 module worker，ORT proxy=false。数据服务包装 DuckDB async worker，不强制新增嵌套 data worker；其协调队列在独立于模型计算的位置运行。

## Error codes and fallback

稳定 codes：INVALID_DATA、SCHEMA_MISMATCH、SHAPE_UNSUPPORTED、UNSUPPORTED_CAPABILITY、NONFINITE_TARGET、INF_DISABLED、NUMERIC_OVERFLOW、ARTIFACT_MISMATCH、SNAPSHOT_CORRUPT、CONTEXT_INCOMPATIBLE、CONTEXT_RELEASED、FOREIGN_CONTEXT、PROVIDER_UNAVAILABLE、DEVICE_LOST、ADAPTER_DISPOSED、RESULT_INVALID、STALE_REQUEST、CANCELLED、CACHE_QUOTA、STORAGE_UNAVAILABLE。

语义/完整性错误不可降级。CACHE_QUOTA/STORAGE_UNAVAILABLE 在已验证内存内容可用时转为明确 warning，保留运行结果；内存也不可用则失败。load 首选 provider 初始化失败仅在 allowWasmFallback=true 时尝试 WASM，记录原失败原因和实际 provider。数值失败不能触发精度或模型自动切换。

## Required contract evidence

每操作成功/失败均覆盖；两个 provider 的 module worker smoke；foreign/released handle；dispose during run；20 次 latest-only；独立 experiment 不丢弃；fallback metadata；设备故障；context 重启导入；guarded publication。轻量调度故障可注入 fake executor，但不能替代真实模型数值与真实浏览器 storage 测试。
