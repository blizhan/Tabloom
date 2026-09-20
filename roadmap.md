# Tabloom Roadmap

> 讨论纪要与参赛实施路线，更新于 2026-09-16。

## 1. 项目定位

Tabloom 是一个浏览器原生的表格数据预测工作台：使用 DuckDB-WASM 在浏览器中读取、连接和查询数据，再通过 WebGPU 运行表格基础模型，把预测结果注册回 DuckDB，继续查询、比较、可视化和导出。

项目由两种互通的使用方式组成：

- **Common View**：通用工作台。用户连接自己的数据、编写 SQL、定义训练集和预测集、选择模型并运行预测。
- **Case View**：预配置的真实案例。每个案例自带持续更新的数据、特征 SQL、模型配置、图表和可调情景，并能一键展开到 Common View。

核心体验是：

```text
实时 / 本地数据
      ↓
DuckDB SQL 生成训练与预测视图
      ↓
浏览器内模型推理
      ↓
基准预测 + 交互情景预测 + 模型比较
      ↓
预测结果回到 DuckDB
      ↓
查询、决策与导出
```

“哇”时刻不是单纯在前端画一张预测图，而是用户可以修改未来天气等输入，立即看到预测曲线变化，再打开底层数据、SQL 和模型配置验证这个结果。

## 2. 产品形态

### 2.1 Common View

首版支持以下数据入口：

- 浏览器内存数据库；
- 本地 Parquet、CSV、Arrow；
- 本地 DuckDB 数据库文件，具体打开、挂载和读写能力以 DuckDB-WASM PoC 结果为准；
- 公开 HTTPS 或预签名 URL 上的 Parquet/CSV/Arrow；
- 满足 CORS 和 Range Request 条件的 OSS/S3/R2 对象；
- 可跨域访问的 HTTP JSON/CSV API。

运行中的 PostgreSQL、MySQL 等远端数据库不作为首版承诺。它们需要 DuckDB-WASM 对应扩展或用户侧 HTTP 网关，后续单独验证。远端 DuckDB/Quack 也作为扩展项处理。

Common View 的主流程：

1. 添加数据源并查看表、字段、类型、行数和基础统计；
2. 用 DuckDB SQL 定义训练集和预测集；
3. 选择目标列、任务类型和模型；
4. 运行预测并查看进度、耗时与资源使用情况；
5. 将预测、概率和模型元数据注册为 DuckDB 表；
6. 继续使用 SQL 分析，或导出 CSV/Parquet/Arrow；
7. 保存可复现的实验配置，包括数据版本、SQL、模型、权重版本和情景参数。

### 2.2 Case View

Case View 与 Common View 共用同一套数据运行时、模型运行时和实验状态。每个案例通过配置声明：

- 数据源与更新时间；
- 历史数据表和最新数据表；
- 默认训练 SQL、预测 SQL 和目标列；
- 默认模型与可选模型；
- 可调整的情景变量及有效范围；
- 图表、决策目标和结果表；
- 数据来源、许可证和已知限制。

每个案例都必须提供：

- 打开即用的默认预测；
- 数据来源与“最后更新于”；
- 基准、用户情景和官方参考三类曲线中适用的部分；
- 一键重置情景；
- **Open in Common View**，将完整的数据、SQL、模型和结果带入工作台；
- 清楚区分预测、情景探索和因果结论。

## 3. 首批案例

### 3.1 低碳用电情景实验室

目标：根据持续更新的天气和英国电网碳强度数据预测未来曲线，并为有时间约束的设备安排低碳运行窗口。

数据候选：

- [NESO Carbon Intensity API](https://carbon-intensity.github.io/api-definitions/)：半小时碳强度、发电结构、历史值和官方预测；
- [Open-Meteo](https://open-meteo.com/)：实时预报、历史天气和历史预报档案。

交互：

- 调整未来一段时间的温度、风速等天气条件；
- 设置设备运行时长、可运行时间段和截止时间；
- 对比基准预测、修改后的情景预测和官方参考预测；
- 标出满足约束的最低预测碳排运行窗口。

边界：全国碳强度不能只用伦敦天气代表；应选取多个代表区域或使用与发电区域匹配的天气特征。实时实际发电结构不能作为未来时点的输入，避免标签泄漏。

### 3.2 电价与新能源情景实验室

目标：结合历史电价、发电结构和天气预测未来电价，观察风光条件变化与价格曲线的关联。

数据候选：

- [Energy-Charts API](https://api.energy-charts.info/)：欧洲市场电价、发电量及部分预测数据；
- Open-Meteo：风速、辐照度、温度等天气变量。

交互：

- 调整风速、太阳辐照和需求相关天气特征；
- 对比不同模型和不同情景的电价曲线；
- 标出低价时段和模型分歧最大的时段。

边界：Energy-Charts 当前跨域响应不适合由任意站点直接调用，首版通过 CI 整理最新快照。已公布的日前电价、模型预测和用户情景必须使用不同视觉与标签，避免把已知价格展示成预测。

### 3.3 城市骑行需求情景实验室

目标：展示当前站点库存，并预测未来区域或站点的骑行需求如何随天气变化。

数据候选：

- [Citi Bike System Data](https://citibikenyc.com/system-data)：月度历史骑行记录；
- Citi Bike GBFS：实时站点车辆和车位状态；
- Open-Meteo：当前与未来天气。

交互：

- 在地图上选择站点或区域；
- 调整未来温度、降雨和风速；
- 查看未来每小时骑行需求曲线及多个模型的结果；
- 同时查看实时库存，但不把实时库存和需求预测混成同一指标。

边界：公开历史骑行记录可以支持需求预测，但不能直接验证未来站点库存。首版展示“实时库存地图 + 需求预测曲线”，不声称能预测半小时后准确库存。

## 4. 数据更新与发布

数据采用“历史快照 + 最新增量”两条路径。

### 4.1 GitHub Actions 定时整理

CI 负责：

- 定期拉取历史增量和不适合浏览器直连的数据；
- 规范字段名、时区、类型和缺失值；
- 聚合超大原始数据，例如把 Citi Bike 行程聚合成站点/区域每小时需求；
- 写出按来源、地区和月份分区的 Parquet；
- 生成 `manifest.json`，记录来源、许可证、覆盖时间、抓取时间、行数、文件大小、schema 版本和校验值；
- 先完成校验再发布；任务失败时保留上一版可用快照。

仓库中只保存演示所需的小型或聚合数据，不重复提交大型原始数据。若数据体积增长超过适合 Git 仓库与 GitHub Pages 的范围，再迁移到 Release Assets 或对象存储，manifest 地址保持稳定。

### 4.2 浏览器直读 API

对于允许跨域且稳定的接口，浏览器打开 Case View 时获取最新数据，并与历史 Parquet 在 DuckDB 中合并。API 请求失败或超时时，回退到 CI 发布的最近快照，并在页面显示数据陈旧状态。

最新数据获取与用户情景分开：调整滑块只修改浏览器中的预测输入，不重新请求 API，也不触发 CI。

## 5. 多模型运行时

首版目标模型：

- TabPFN 3.5；
- TabPFN 3；
- TabICL v2。

分类和回归都纳入统一接口，但实施上优先打通三个 Case View 所需的回归路径，再补分类。

建议的公共接口：

```ts
type ModelId = "tabpfn-3.5" | "tabpfn-3" | "tabicl-v2";
type TaskType = "classification" | "regression";

interface ModelCapabilities {
  taskTypes: TaskType[];
  maxRows?: number;
  maxColumns?: number;
  supportsCategorical: boolean;
  supportsMissingValues: boolean;
  supportsText: boolean;
  supportsContextCache: boolean;
}

interface TabularModelAdapter {
  id: ModelId;
  load(options: ModelLoadOptions): Promise<void>;
  fitContext(dataset: TabularDataset): Promise<ModelContext>;
  predict(context: ModelContext, input: TabularDataset): Promise<PredictionResult>;
  capabilities(): ModelCapabilities;
  dispose(): Promise<void>;
}
```

运行原则：

- 每个模型独立实现预处理、权重加载、推理和输出映射；
- 按需下载并持久缓存权重，显示大小、进度、版本和许可证；
- 默认一次只在 GPU 中保留一个模型，比较时顺序运行，避免同时占满显存；
- 训练上下文与特征不变时复用可用缓存；TabICL v2 的 KV cache 作为重点验证项；
- 相同的数据切分、特征 SQL 和情景输入用于模型比较；
- 模型间差异称为“模型分歧”，不能当作统计置信区间；
- 预测表记录模型 ID、权重版本、运行时、数据版本、情景 ID、耗时和输出。

截至 2026-09-17，两个回归核心已经通过真实 Chromium WebGPU PoC：

| 模型 | 当前状态 | 动态预测行 | 32 行热交互 | 浏览器产物 | 主要缺口 |
| --- | --- | ---: | ---: | ---: | --- |
| TabPFN 3.5 | 数值回归核心、动态 context、单成员 estimator parity、共享权重均通过 | train 3–1,024；predict 1–1,024 | 约 41 ms | Common View：共享 FP16 权重 blob 约 428 MB + 两个小 graph；Case View 可只载 prediction/context | TypeScript estimator 预处理/解码、运行时内存与持久缓存、多成员/分类 |
| TabICL v2 | 单成员数值 mean 回归通过 | 1–1,024 | 约 53 ms | 约 67 MB；Brotli 约 57 MB | JS 特征元数据、target inverse、浏览器 context 构建 |
| TabPFN 3 | 未验证 | — | — | — | 完整技术验证 |

表中的体积和延迟采用 FP16 存储、FP32 计算候选版；它减少下载体积，但运行时仍可能展开/复制为 FP32，不能据此推断显存也同比下降。TabPFN 3.5 已完成官方 `TabPFNRegressor.predict()` 的单成员最终 mean parity：FP32 三个 fixture 最大误差不超过约 `7.51e-5`，FP16-storage 最大约 `0.00165`；NaN 通过，Inf 仅在显式 `PASSTHROUGH_INF=True` 时通过。两个 TabPFN 图中 417 个 initializer 可精确共享，FP16 两图 722.5 MB initializer 经 dedup 后只需一个 427.8 MB blob；Chromium WASM/WebGPU 都验证了只 fetch 一次并由两个 session 复用同一 `Uint8Array`。TabICL v2 使用官方 12 MiB KV cache，官方高层 estimator 与直接缓存路径加 target inverse 在验证 fixture 上完全一致。详细证据见 [`spikes/tabpfn35/RESULTS.md`](spikes/tabpfn35/RESULTS.md)、[`spikes/tabiclv2/RESULTS.md`](spikes/tabiclv2/RESULTS.md) 与 [`spikes/COMPRESSION_RESULTS.md`](spikes/COMPRESSION_RESULTS.md)。

## 6. 情景交互

首版提供参数化情景编辑：选择未来时间范围，然后对温度、风速、降雨或辐照等变量施加偏移、倍率或固定值。自由手绘整条输入曲线作为后续能力。

每次情景预测保留：

- 情景名称和修改参数；
- 原始输入与修改后的输入；
- 模型与权重版本；
- 输出曲线与相对基准的差异；
- 运行时间和数据时间戳。

交互采用防抖和“只接受最新请求”机制。TabPFN 3.5 与 TabICL v2 PoC 已分别验证 32 行 WebGPU 情景热重算约 41 ms 与 32–35 ms，因此首版可在拖动时预览；产品实现仍以设备能力为准，较慢设备退化为松开滑块后刷新。

## 7. 一到两周实施路线

### Phase 0：技术可行性门槛

当前状态：**TabPFN 3.5 与 TabICL v2 的数值回归核心均已越过浏览器可行性门槛，TabPFN 3 待验证。** TabPFN 3.5 的 context builder 支持 3–1,024 个训练行和 1–32 个数值特征，prediction graph 支持动态 train/test/features；Chromium WASM 与真实 NVIDIA WebGPU 都完成了 `训练数据 → context → prediction` 闭环。单成员 estimator 的预处理 + 回归分布解码也已对齐官方 `TabPFNRegressor.predict()`，并验证 NaN 与 opt-in Inf 行为。权重交付方面，Common View 可让两个 ORT session 复用一次下载的 427.8 MB FP16 shared blob，不必为了去重强制合并为单图。共同剩余工作转为 TypeScript estimator adapter、浏览器持久缓存/运行时内存、真实时间数据，以及多成员/分类路径。

优先验证最困难的假设，避免先投入完整 UI：

1. 为三个模型准备同一组小型分类和回归 fixtures；
2. 分别研究模型预处理、动态 shape 和注意力算子的导出路径；
3. 尝试 ONNX/WebGPU 或其他浏览器可用执行路径；
4. 对比 Python 与浏览器的预测值、概率和类别；
5. 记录冷启动、热启动、推理延迟、内存和 GPU 资源；
6. 给每个模型形成 `supported / constrained / blocked` 结论与证据。

通过标准：至少一条模型路径能在浏览器完整运行并达到可接受的数值误差和交互延迟。其他模型即使暂时受限，也保留适配器和明确状态，不静默切换到别的模型或远端推理。

### Phase 1：共享数据与实验闭环

- 初始化 React、TypeScript、Vite 与 DuckDB-WASM；
- 完成本地文件、远端 Parquet/API 和 DuckDB 文件能力验证；
- 实现 schema 浏览、SQL 编辑和 Arrow/TypedArray 特征适配；
- 完成模型选择、运行状态、预测表注册和基础导出；
- 实现数据/模型 worker，避免阻塞 UI；
- 加入模型与数据缓存、能力检测和错误提示。

完成标志：用户能导入一份数据，用 SQL 定义训练/预测视图，选择一个已验证模型，在浏览器生成预测，并继续用 SQL 查询预测表。

### Phase 2：低碳用电 Case View

- 先用该案例贯通 Case 配置、CI 数据、最新 API、情景编辑和 Common View 跳转；
- 展示基准、情景和官方参考曲线；
- 完成受时间约束的低碳运行窗口推荐；
- 加入时间穿越回测，确认只使用预测时点之前可获得的数据。

### Phase 3：电价与骑行案例

- 复用同一套 Case 配置和情景组件接入电价案例；
- 通过 CI 解决 Energy-Charts 数据整理与跨域问题；
- 聚合 Citi Bike 历史行程，接入实时 GBFS 地图；
- 保持实时库存与需求预测的指标边界。

### Phase 4：演示与参赛交付

- 准备三个固定演示路径和一个用户自带数据路径；
- 在 README 写明安装、浏览器要求、模型权重、许可证、数据来源和运行方法；
- 增加模型兼容矩阵、性能基准和已知限制；
- 制作短视频：实时数据 → 调整天气 → 曲线变化 → 模型比较 → Open in Common View → SQL 查询预测结果；
- 确保仓库可运行、静态站点可访问、失败时有可用快照。

## 8. 验证与验收

### 模型正确性

- 三个模型分别生成 Python 参考 fixtures；
- 覆盖回归、二分类、多分类、缺失值、类别特征和不同 shape；
- 比较原始输出、概率、预测类别或回归值；
- 为不同精度和运行时定义并记录明确误差阈值。

### 数据正确性

- CI 检查 schema、唯一键、时间连续性、重复行和异常空值；
- 历史回测严格按时间切分，避免随机切分造成未来泄漏；
- 预测输入只使用当时可获得的数据；
- 页面上的数据更新时间、预测时点和目标时段必须可见。

### 产品验收

- Case View 在最新 API 不可用时仍可从快照打开；
- 修改情景后基准保持不变，新结果作为独立曲线加入；
- 快速连续修改只展示最后一次请求的结果；
- Case View 展开到 Common View 后，数据、SQL、模型和结果一致；
- 三模型比较使用完全相同的数据和输入；
- 导出的结果包含可复现元数据。

### 性能验收

- 分别记录模型下载、初始化、上下文准备、首次预测和重复预测耗时；
- 验证模型切换后的内存释放；
- 在无 WebGPU、显存不足、模型下载失败和不支持算子的情况下给出清晰状态；
- 在目标演示设备上确定可交互的数据规模和刷新延迟。

## 9. 首版范围控制

首版暂不包含：

- 账号、协作和云端项目管理；
- 托管推理后端；
- 通用 AutoML 和超参数搜索；
- 对任意 PostgreSQL/MySQL 连接串的直接支持；
- 对站点未来库存的未经验证预测；
- 将情景相关性描述为因果影响；
- 自由手绘所有未来特征曲线；
- 大而全的仪表盘系统。

## 10. 当前关键风险

1. **模型浏览器可行性**：TabPFN 3.5 的数值回归动态 context、预测、单成员最终 mean parity 和 shared-weight 浏览器加载都已验证，TabICL v2 数值回归核心已验证；TypeScript estimator 适配、分类路径和 TabPFN 3 仍待完成。TabPFN 3.5 Common View 当前更实际的技术风险已经从“能不能生成 context / 两图是否必须重复下载”转为首次约 428 MB 权重下载、持久缓存，以及两个 ORT session 是否会在运行时重复展开/占用内存。
2. **模型体积与许可证**：权重需按需加载、缓存并展示许可；TabPFN 3/3.5 权重许可与 TabICL v2 不同，发布方式需要逐项遵守。
3. **预处理一致性**：模型权重相同但预处理不同会产生不同模型行为，必须以 Python 参考实现为准。
4. **实时数据稳定性**：API 会有跨域、限流、延迟和 schema 变化，CI 快照与 manifest 是可用性保障。
5. **时间序列泄漏**：天气、发电结构、实际价格和最终库存的可用时间必须严格建模。
6. **一到两周的范围**：先确保一个案例完整、三个模型有兼容结论，再扩展其余案例；不为凑数量复制三套独立实现。

## 11. 参赛成功标准

最低成功标准：

- 至少一个模型能在浏览器通过 WebGPU 完成正确推理；
- DuckDB-WASM 查询结果能够直接成为模型输入；
- 预测结果能够注册回 DuckDB 并继续查询；
- 低碳用电案例能加载持续更新的数据并完成交互情景预测；
- Common View 能处理用户自己的本地或远端文件；
- README、数据来源、许可证、基准与已知限制完整。

理想提交标准：

- TabPFN 3.5、TabPFN 3、TabICL v2 均能在兼容浏览器中运行，或给出透明且有证据的兼容矩阵；
- 三个 Case View 都基于持续更新的数据运行；
- 用户能在同一情景下比较多个模型；
- Case View 与 Common View 无缝互转；
- 整个核心流程无需 Python 环境和推理服务器。
