# Phase 0 Research — Phase 1 工作台

日期：2026-09-20。研究范围为当前仓库、安装依赖及既有验证资产；本次不安装依赖、不运行模型、不宣称新增能力已通过浏览器验证。

## R1 — 工作台与既有运行时的关系

**Decision**: 在 `runtime/` 现有包中新增 `app/` 产品入口、`vite.app.config.ts` 和 `tsconfig.app.json`，使用 React 19 与现有 TypeScript/Vite；保留 `harness/` 和原有命令。产品构建输出到 `dist-app/`。React 的确切补丁版本及类型包在实施安装时固定到现有 lockfile，不变更现有运行时依赖版本。

**Rationale**: `runtime/package.json` 已固定 TypeScript 5.9.3、Vite 7.3.6、DuckDB-WASM 1.33.1-dev57.0、Arrow 17.0.0、ORT 1.30.0、playwright-core 1.63.0；当前 `vite.config.ts` 的 root 是 `harness/`。现有 `tsconfig.json` 仅编译 `src/**/*.ts`，产品 TSX 需独立配置，避免 UI 依赖进入库声明。

**Alternatives considered**: 根目录新建第二个前端包会重复依赖与资产配置；把 harness 改成产品页面会丢失稳定验收入口。两者当前均无收益。

## R2 — 静态资产与部署

**Decision**: 从现有 Vite 配置提取共享资产挂载/复制逻辑，产品只发布选中模型的必要产物、DuckDB/ORT 资产与小型测试数据；不强制复制整个测试 golden 集合。资产 URL 以构建 base 为根，开发、预览和生产使用相同映射。

**Rationale**: 现有配置明确处理过 worker 路径被 SPA fallback 返回 HTML 的问题，且默认复制多套模型和 golden。产品页面应按需加载、显示体积及版本；静态子路径、正确 MIME、module worker、HTTPS/localhost 与 COOP/COEP 是独立验收项。

**Alternatives considered**: 从 CDN 临时加载 worker/WASM 会引入版本及跨域差异；只验证 dev server 无法覆盖构建后路径问题。不新增生产后端。

## R3 — 数据入口、SQL 与快照

**Decision**: 导入先取得完整可校验内容并生成不可变快照，再注册至浏览器数据库。支持本地文件、远端 CSV/Parquet/Arrow、JSON 行数组接口；首版接口为单次 GET，不自动分页。远端 URL 支持浏览器可读的 HTTPS/预签名/对象地址；从 HTTPS 页面访问不安全 HTTP 被拒绝时明确提示。不得使用 no-cors 获得不可读响应后假装成功。

**Rationale**: 当前工作台样本很小，完整物化使内容版本、重启缓存和重复实验有一致定义；查询不能在同一运行中混读变化的远端内容。分段读取是优化条件而非所有导入的必需条件。完整下载失败或超过显式资源预算时拒绝，不隐式采样。加载较大文件需给出大小/内存提示并允许取消。默认总超时 120000 ms、响应流累计上限 67108864 字节；启动时注入有限正整数，超限/超时清理未完成内容并保留旧表，详见工作台契约。

**Alternatives considered**: 直接把可变 URL 当表或用 ETag 当内容身份不能保证复现；为每个对象存储厂商创建专用连接器在本期没有必要。远端响应嵌套 JSON 必须明确选择行数组路径，否则拒绝，不猜测业务结构。

**SQL policy**: 用户训练、预测和结果查询入口只接受单条只读查询；借助数据库解析/语句分类与隔离连接禁止写操作和直接网络/文件读取，不使用正则识别 SQL 安全性。导入、替换和发布由受控操作执行。将查询结果物化一次后生成模型输入，后续结果关联使用同一份输入快照。

## R4 — 数据缓存与恢复

**Decision**: 沿用 IndexedDB，新增独立的数据快照与实验定义存储，不把大文件塞进 React state 或 localStorage。按原始内容 SHA-256、格式、显式类型解释与 schemaVersion 确认身份；先写分块内容与校验，再提交完整标记。实验绑定快照而非可变表名。保留原始内容校验及规范化表内容摘要两个层次。

**Rationale**: 001 规格的持久模型/context 不等于整个实验持久化。002 要求关闭后重新打开同一实验，因此必须补充源数据与实验定义恢复。运行时句柄不能持久化；重启重建数据库注册与有效句柄，不要求零初始化。

**Alternatives considered**: 新增 OPFS 是第二种持久后端，暂不需要；自动刷新会破坏版本固定。缓存清理不得移除仍被实验引用的数据，显式删除实验之后才允许回收无引用内容。配额失败时保留内存中的当前运行并显示持久化失败。

## R5 — 导出与类型保真

**Decision**: CSV/Parquet 由数据库导出，Arrow 使用 IPC 文件格式。每次导出提供数据文件及配套 JSON 元数据，记录结果摘要、schema、CSV 空值/转义约定、实验与模型版本、训练/预测 SQL、特征顺序和输入快照身份。元数据还包含完整预测表与输入快照的映射依据。

**Rationale**: CSV 无法独立表达全部类型和 NULL/空字符串差异，需要伴随 schema。数值与时间按明确类型往返，不经过 JSON number 强行转换大整数。聚合 SQL 可以改变行数或不输出逐行身份，此时元数据声明 `aggregation`，不捏造与每个输入行一一对应的关系；完整预测表导出必须保留行身份。

**Alternatives considered**: 只输出预测值无法复现；自动向用户聚合结果追加行标识会改变查询语义。元数据默认去除预签名 URL 的凭证部分，重现身份依靠内容摘要，不依赖导出秘密参数。

## R6 — DuckDB 数据库文件能力门槛

**Decision**: Setup 后数据生成与运行时基础并行，正常文件和真实 executor 就绪后即通过独立 duckdb-file suite 对工作副本验证 open、attach、read、write；最终 manifest/校验及 US1 集成等待 probe 结论。给出可执行 probe、文件前后校验值、浏览器/依赖版本和每项 supported/constrained/unsupported 结论。产品只开放经过验证的操作，源文件始终不原地写回。

**Rationale**: roadmap 和 FR-003 明确允许能力受限；安装包类型定义并非浏览器功能证据。即使 write 不支持，只要如实展示结论、证据及导出替代方式，也符合要求。

**Alternatives considered**: 直接依据原生 DuckDB 能力承诺浏览器读写会混淆两种执行环境；静默将 DuckDB 文件当普通二进制表导入没有用户价值。

## R7 — 数据包生成与独立参考

**Decision**: 交付固定 `v1` 合成小时级天气/用电数据，使用整数/定点规则生成 256 个历史样本和 32 个未来输入；4 个模型特征为温度、风速、辐照、小时。保留源行标识、业务键、UTC 目标时刻和特征可用时刻。预测真值放入独立文件。正常样本提供五种格式，异常变体独立。数据及参考总量不超过 10 MiB，权重不纳入数据包。

**Rationale**: 这满足全部输入与时间边界，且能复用于后续情景功能。无需在线服务即可复验；多格式副本由同一规范数据生成，但预期行数/汇总由独立标量计算核对。文件字节摘要按锁定工具版本记录，不能要求不同编码器版本的 Parquet 二进制相同。

**Alternatives considered**: 实时天气/电网抓取会增加来源许可、API 稳定性与数据泄漏问题，属于后续案例范围；已有模型 golden 适合算法对齐但不能直接代替具备时间、来源、类型与多格式入口的数据包。

**Reference policy**: 使用官方 TabPFN estimator 和与浏览器支持范围一致的单成员配置得到独立 mean；固定模型权重摘要、依赖版本、预处理、随机种子及输入摘要。比较同一数据的浏览器 FP32/FP16-storage 输出，按目标单位记录误差预算。预算在产品回归验收之前固定，不能根据待测失败结果自动放宽；参考不可取得或浏览器数值不通过时阻止预测验收，不改用同一路径输出作为 expected。

## R8 — 验收方式

**Decision**: 复用 node:test/tsx 和 Playwright-core；轻量测试覆盖确定性数据、IPC、故障、类型/身份与缓存逻辑，浏览器测试覆盖真实 DuckDB、文件导出、IndexedDB、Worker 和产品构建。真实模型独立执行 WASM/WebGPU × FP32/FP16-storage 四组合验收，flow/model-cache/responsiveness 必填 provider/precision；data 不加载模型，model-cache 使用真实资产排除 HTTP 缓存影响后验证应用持久缓存，不将 fake adapter 当模型准确性证据。

**Rationale**: 现有项目已具备两层验证工具，新增测试应围绕产品边界而非重复模型单元测试。SC-005 在记录设备的浏览器里，对加载、长查询、预测各测试 10 次交互并记录逐次反馈时间。

**Alternatives considered**: 新增另一套测试框架成本高且没有必要；只执行 mock 无法证明浏览器资源与导出正确。未安装真实模型资产的环境可以运行非模型测试，但真实模型验收必须显式报告未执行，不能归为全通过。

## R9 — 既有运行时的真实集成缺口

**Decision**: 将以下补齐列为 Phase 1 实施前置工作，不能只包装现有 API 后宣称闭环完成：

1. 提供 `WorkerModelClient`，连接真实 `model.worker-entry.ts`，实现 ready、请求关联、进度转发、取消、transfer 所有权与关闭；产品必须走 `requireOrtRuntime: true` 的 artifact-bound factory，不能进入测试用默认线性 fallback。
2. 产品 bootstrap 显式创建并注入真实 `createDuckDbWasmExecutor()`。缺 executor 必须 fail closed，禁止用空数组作为查询成功。
3. 将结果、输入行和元数据真正注册为 SQL 表；重构发布顺序，使数据库事务提交成功后才更新当前结果指针。注册失败、取消或 generation 变化不能留下已发布内存结果与数据库不一致状态。
4. 发布前校验模型返回的 rowOrdinal 是实际输入行的完整一一映射，不能忽略返回身份再按索引重建；无业务键时仍保存输入行与内部序号。
5. 数据入口保留通用 Arrow 类型，只有明确选定的模型特征进入数值适配；不能将业务键、日期及导出字段统一 `Number()`。
6. 新增数据快照/实验定义持久存储。现有 context 持久化可复用，但不能替代缺失的源数据和查询定义。

**Rationale / evidence**: `runtime/src/data/duckdb-service.ts` 的 results/snapshot 为内存集合，上层文件导入/导出与目录未实现；`runtime/src/data/duckdb-wasm-executor.ts` 已有真实 worker 与 Arrow 注册。`runtime/src/coordinator/runtime-client.ts` 直接调用 adapter，现有 `workers/protocol.ts`/dispatcher 和测试中的手写 postMessage 尚不是完整应用客户端。`runtime-coordinator.ts` 在 publication 后调用 registerResults；`result-publication.ts` 尚需强化返回 ordinal 校验。`data/experiments.ts` 与 `input-snapshots.ts` 只有内存状态。

**Alternatives considered**: 单纯把现有 harness 按钮放入 React 会掩盖缺口；重写全部运行时会丢掉可复用的调度、context 和 artifact 缓存。采用最小边界扩展，原 001 契约测试继续执行。

**Existing evidence**: luna_worker 调研期间执行 `npm --prefix runtime test`，71 个测试通过；这只证明既有测试基线，不能证明上述未实现边界。`artifacts/runtime/reports/bootstrap-data.json` 已记录真实 DuckDB worker、Arrow/NULL、参数及事务回滚；它不覆盖文件导入或数据库文件读写。

## R10 — 可复现生成工具

**Decision**: 新建维护者工具项目 `tools/workbench-fixtures/`，以独立 `pyproject.toml`/`uv.lock` 固定 Python 3.12、PyArrow 与原生 DuckDB 写入器；不用环境中偶然可导入的包。正常数据生成与参考生成分步，`fixtures:workbench` 串联两步，`fixtures:workbench:check` 通过 `tools/workbench-fixtures/check.py` 原生读取并校验提交的五格式小文件；需预先同步该锁定工具环境，但无需模型权重/官方 TabPFN 环境，不联网不改 expected。缺校验环境明确失败。浏览器文件能力受限不影响原生文件正确性判定。

**Rationale / evidence**: 两个 spike 的锁定依赖都没有 PyArrow/Python DuckDB。`spikes/tabpfn35/export_estimator_golden.py` 仅接受 model-path/output-dir/seed，内部固定 160×8 train + 32×8 test，不能直接读取新数据。新增 `spikes/tabpfn35/export_workbench_reference.py` 调用相同官方 estimator 配置及可复用辅助函数，但读取固定 canonical 数据，不修改原 exporter 的默认行为。官方版本 `tabpfn==9.0.0`，单成员、none 预处理、fingerprint/permutation、固定 seed；4 个原始特征经 fingerprint 后为 5 个，低于 32 的上限。

**Alternatives considered**: 改变原 golden 的数据形状会破坏已有数值回归；仅调用图 smoke fixture 不具备 estimator 独立参考。原生 DuckDB 写出的数据库与浏览器兼容性必须由 R6 probe 判定，必要时选择兼容写入器版本并锁定，不能凭本地读取成功当成浏览器支持。

## 研究结论

两名 luna_worker 分别收集运行时/Worker 边界、数据与参考工具资料；主代理核对包与构建结构并制定以上设计。所有设计选择已落定，无待用户决定的澄清项。模型新样本数值、数据库文件能力、用户查询只读策略与产品资产构建属于明确的实施验证门槛，尚未运行，不计为已通过。
