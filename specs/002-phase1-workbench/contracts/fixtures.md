# 测试数据包与验证入口契约

## 交付布局

以下是实施阶段必须生成并提交的小型产物，当前 planning 不生成数据：

```text
runtime/tests/fixtures/workbench/v1/
├── README.md
├── LICENSE
├── manifest.json
├── schema.json
├── normal/
│   ├── train.{csv,parquet,arrow,json}
│   ├── predict.{csv,parquet,arrow,json}
│   └── sample.duckdb
├── truth/predict-targets.csv
├── variants/                  # 八类用例的独立输入
├── queries/                   # train/predict/join/aggregate/export SQL
├── expected/stats.json
├── expected/tabpfn35-mean.json
└── cases.json
```

`sample.duckdb` 只含 train/predict 正常表；不含未来真值。Arrow 使用 IPC file。JSON 使用行对象数组，时间使用显式 UTC 字符串。正常输入及副本为同一规范数据，不是不同随机采样。工作台构建将样本复制到 `sample-data/workbench/v1/`；大模型依旧位于独立资产路径。

## 固定数据与预期

- generatorVersion、seed、规则和依赖锁文件是 manifest 的一部分；默认使用固定整数/定点计算，生成的普通字段全部可准确还原。
- 4 个模型特征及其顺序固定为 `temperature_c, wind_speed_ms, solar_wm2, hour_utc`；目标为 `demand_mwh`，合成值保持小型非负量级并注明没有真实业务预测含义。
- 历史 256 小时，预测随后 32 小时；origin、UTC 和 features_available_at 明确。未来目标只在 truth 中，不能因导入数据库副本自动出现在预测表。
- expectedStats 为独立标量计算的每张表行数、空值、min/max/mean、键集合及示例聚合结果；不可直接把待测数据库输出写回 expected。
- 正常数据没有空值，空值与空字符串的导出往返用例采用单独小表；大整数和时间类型边界同样独立于模型支持范围。
- 数据包不超过 10 MiB，含说明、真值和参考，不含权重。完整文件列表和校验值必须覆盖所有数据文件；manifest 不对自己做递归哈希。

## 八类边界用例

| caseId | 变体 | 预期 |
| --- | --- | --- |
| empty | 只有 schema、零记录 | 导入可检查，预测拒绝 EMPTY_INPUT |
| missing-target | 一个训练目标 NULL 或目标列缺失 | INVALID_TARGET，不隐式删行 |
| missing-feature | 一个特征 NULL；另含缺列子用例 | NULL 按能力处理；缺列 FEATURE_MISMATCH |
| duplicate-key | 业务键重复，源行及数值不同 | 接受，预测仍正确逐行关联 |
| reordered | 固定反序预测输入 | 接受，按实际输入顺序返回；关联后与原序一致 |
| wrong-type | 某特征为不可解析文本 | 明确要求转换，不强行转换为 0 |
| non-finite | Infinity/NaN 目标与无限特征子用例 | 目标拒绝；无限特征默认拒绝；NaN 特征按缺失能力处理 |
| over-limit | 超出所选模型公开输入上限 | INPUT_LIMIT，不能静默截断/抽样 |

非有限数值不能写入标准 JSON number，使用能表达该值的专用文件与类型解释，不产生不合法 JSON。超限用例按锁定模型能力生成小型输入，manifest 明确越界维度和值。

cases.json 还覆盖五格式导入、SQL 预期、预测关联、三格式导出、缓存命中/刷新/损坏/配额失败、取消及错误提示。浏览器环境故障用受控服务或存储注入，不伪装成数据内容问题。

## 官方参考

生成脚本调用官方 TabPFNRegressor 的单成员受支持配置，固定输入、种子、预处理及权重摘要，保存 mean 和完整 provenance。浏览器 FP32 与 FP16-storage 分别比较该同一参考；不重用待测 JS 处理器生成参考。

新数据采用预先指定的 `maxAbsoluteError <= 0.002 MWh` 作为 FP16-storage 验收预算，FP32 为 `<= 0.0001 MWh`；这属于新样本待验证目标，不是沿用历史证据宣称已通过。若独立 reference 或固定浏览器路径无法达到该预算，先调查数据/配置/处理差异；不能自动提高阈值。预算变更需要有独立误差分析并更新数据版本与验收说明。

真值用于后续功能测试，mean 用于实现数值一致性；本期不设合成数据上的模型业务准确率门槛。

## 受控远端服务与文件能力 probe

浏览器测试的第二 origin 提供正常 CSV/Parquet/Arrow、JSON 行数组，以及 CORS 拒绝、403、超时、截断内容、版本变化、Range 支持/不支持，以及注入预算后的字节上限恰好命中/超 1 字节、缺 Content-Length、读取中超时和取消/超时竞争场景。成功数据与本地样本同源；每次测试重置，不能依赖公共服务在线状态。仅需完整下载的路径在不支持 Range 时仍应成功；必需 Range 的优化路径必须回退完整下载或明确受限。

DuckDB 文件 probe 对副本执行 open/attach/read/write，记录原件前后 hash、查询结果、浏览器/包版本和每项状态。浏览器不支持 write 时返回 unsupported 及证据，本地原件不变；不把成功导出 CSV 当作数据库写入成功。

## 数据包校验环境与前置顺序

完整五格式校验由锁定的 `tools/workbench-fixtures/` 原生环境执行。维护者先运行 `uv sync --project tools/workbench-fixtures --frozen`；校验不需要模型权重或官方 TabPFN 环境，不联网、不修改 expected，缺环境明确失败。普通浏览器用户无需 Python。即使浏览器某项 DuckDB 文件操作不支持，也必须由原生校验器证明随附文件有效。

Setup 后数据生成与运行时基础可并行；正常文件生成及真实数据库 executor 就绪后执行独立文件 probe，形成四项明确结论并确认原件不变，不要求四项全部支持。最终 manifest/校验和 US1 集成等待该结论；若调整写入器或文件，重生成摘要并重跑校验。

## 验收参数与缓存分组

flow、model-cache、responsiveness 必填 `--provider wasm|webgpu` 和 `--precision fp32|fp16-storage`。参数决定匹配的资产 manifest；报告校验实际 provider、精度和权重摘要，禁止忽略参数或自动切换。flow 必须执行两种 provider × 两种精度的四个组合，分别输出 `flow-<provider>-<precision>.json`。FP32 预算 ≤0.0001 MWh，FP16-storage ≤0.002 MWh；缺资产或设备不可用记 not-run，不计为通过。

data suite 只验证无模型的数据入口、导出、数据快照及实验定义恢复。model-cache suite 使用真实资产和可用 provider，首次写入应用持久缓存后关闭重开同一浏览器存储，验证零模型内容下载、损坏恢复及独立 mean。测试禁用或排除 HTTP 缓存影响，不能以 HTTP 缓存命中替代应用缓存；允许重新初始化。两组证据共同证明 SC-006。

## 计划新增命令

这些命令由后续实施提供，命名在本计划中固定：

| 命令（仓库根执行） | 责任 |
| --- | --- |
| `npm --prefix runtime run fixtures:workbench` | 调用锁定 Python 工具生成数据与独立参考；缺模型参考环境时明确失败 |
| `npm --prefix runtime run fixtures:workbench:check` | 调用锁定原生工具只读验证五格式语义、摘要、体积与用例，无需模型权重 |
| `npm --prefix runtime run test:workbench -- --suite data` | 无模型的格式、来源、SQL、导出、数据/实验定义缓存与文件能力 |
| `npm --prefix runtime run test:workbench -- --suite duckdb-file` | 独立早期文件 probe，无模型/产品 UI 依赖 |
| `npm --prefix runtime run test:workbench -- --suite flow --provider wasm --precision fp16-storage` | WASM / FP16-storage mean 验收 |
| `npm --prefix runtime run test:workbench -- --suite flow --provider webgpu --precision fp16-storage` | WebGPU / FP16-storage mean 验收 |
| `npm --prefix runtime run test:workbench -- --suite model-cache --provider wasm --precision fp16-storage` | 真实模型应用持久缓存验收 |
| `npm --prefix runtime run test:workbench -- --suite flow --provider wasm --precision fp32` | 真实模型产品闭环与参考比较 |
| `npm --prefix runtime run test:workbench -- --suite flow --provider webgpu --precision fp32` | 真实硬件 WebGPU 同一路径 |
| `npm --prefix runtime run test:workbench -- --suite built-assets` | 产品构建、子路径与资产 MIME/worker 加载 |
| `npm --prefix runtime run test:workbench -- --suite responsiveness --provider webgpu --precision fp16-storage` | 三阶段各 10 次交互、取消和逐次反馈延迟 |

输出放在 `artifacts/workbench/acceptance/`，报告必须区分 passed/failed/not-run/unsupported；unsupported 仅用于规格允许受限的能力，不能掩盖默认预测路径失败。
