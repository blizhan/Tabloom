# Artifact and Context Persistence Contract v1

## Artifact manifest and integrity

可信应用配置提供 manifest URL 与 expected SHA-256；manifest bytes 和其列出的每个文件都检查 length/checksum。manifest 指定 graph 与 external-data path 的精确映射、precision、I/O schema、范围和 provider compatibility。URL 是相对于 manifest 的位置，不作为内容身份。禁止自动改到 latest 或另一精度。

ArtifactStore.load 以 manifest digest 合并同 runtime 实例内的 pending loads。首次每文件 fetch 一次，其中 shared weight blob 只有一个 fetch；全部 verified 后 session 才使用 bytes。warm persistent 命中不重新下载模型文件；重新拉 manifest 可选，不计为权重下载，但离线时已验证且应用仍指向同 digest 的 manifest 直接可用。

## Canonical context identity

SHA-256 输入为 versioned framed record。每字段写类型 tag、uint64 little-endian byte length、内容；字符串 UTF-8，记录 key 字典序排序，列表保留顺序，null 独立 tag。所有 count/shape 为非负 safe integers；禁止模糊字符串拼接。

训练内容先写 row/column count 和有序列名，再按列写转换后的 Float32 values，最后 targetName 和 target values。Float32 编码 little-endian；NaN 统一为 `0x7fc00000`；signed zero 保留，Inf 仅在已验证的 profile 中允许。sourceSnapshotId、预测数据和情景不入训练 key。

配置只接收 schema 允许的字段，解析默认值后写入 seed/profile/passthroughInf 和其他影响语义的选项。非有限配置 scalar 拒绝；大数组通过带 dtype/shape 的二进制引用表达。SQL fingerprint 包含原始 SQL 文本及带类型的绑定参数（整数/decimal 不通过有损 JS number），直接数据调用为 null。

最终 identity record 包含 model/version、manifestDigest、contextFormatVersion、preprocessingVersion、trainingDataDigest、schemaDigest、featureSqlFingerprint、targetName、configurationDigest。snapshot 保存该规范记录以便重算 key；导入不能重算缺失原始训练数据，但必须验证已固定的训练摘要与 Case/请求期望身份一致。

provider/runtime provenance 不更改语义 key，但决定可恢复性。持久 entry 使用 key + build variant（provider/runtime + snapshot payload digest），只能选择 compatibility matrix 允许的变体。默认同 provider；未验证的跨 provider 恢复拒绝或在有训练数据时显式重建。

## Context snapshot serialization

JSON metadata + binary payload chunks；不 JSON 编码 NaN/Inf tensor，不执行任意反序列化代码。metadata 指定版本、identityInputs、featureNames、estimatorState schema、payload kind 与所有 binary references/checksums。portable tensors 按 manifest 的 names/dtypes/shapes 校验；embedded Case 仅允许绑定声明的 artifact digest。

TabPFN state 包含完整特征处理配置/拟合状态和解码状态；TabICL 包含案例固定特征条件、处理元数据、有限 target mean 与合法非零 scale。状态字段版本由 adapter 定义并做显式验证，不将未知字段当作可忽略的语义扩展。

export snapshot 所有 bytes 独立于 live handle 生命周期。restore 全部校验后才创建 uploads。损坏自动缓存是 miss；用户提供/案例预置 snapshot 不兼容必须返回明确错误。转换旧格式不在本期，旧版本需重建或获取匹配发布内容。

## IndexedDB layout and commit protocol

Object stores：entries（complete manifests）、chunks（entry generation/index）、writes（未完成 generation）。chunk 上限 8 MiB；exact last-chunk length 由 manifest 指定。

1. 创建独立 write generation，在分批短事务中保存 chunks。
2. 检查完整字节长度及 digest；verified 前不出现在 entries。
3. 最后一个事务原子写 complete entry 并结束 write record。读取只枚举 complete entry，验证其全部 chunks。
4. 中断留下的 writes/chunks 在后续打开时回收；并发 write generation 不覆盖对方未完成 bytes。已完成旧 entry 在新 generation 完成前仍有效。
5. quota/read/write 错误不损坏已有完整 entry；当前已验证内存内容可继续使用，同时发 warning。IndexedDB 不可用时用会话内存 store，功能状态可见。

删除缓存只删除磁盘 entry 及不再引用的 chunks，不修改 live context bytes。MVP 不承诺跨标签页下载去重；需要并发存储时以 generation 和事务避免半写可见。恢复时仍检查 checksum，不信任单个 complete 标记。

## Validation

并发单 fetch、warm/offline 零模型内容下载；中途关闭、缺 chunk、错误长度/hash、未知版本、配额故障；只改一个标签/顺序/seed/precision/预处理版本导致 miss；只改预测行导致 hit；snapshot 保存→完整关闭 worker→恢复→全部均值一致；disk eviction 不破坏 live handle。
