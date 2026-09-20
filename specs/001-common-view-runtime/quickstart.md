# Quickstart Validation: Common View Runtime

本文件是实现后的验收入口。第 2 节命令来自现有 spike；第 3–5 节命令运行新的 `runtime/` 包。两者的证据范围不同，不能把页面 spike 的成功当作 TypeScript worker/data runtime 的完整模型验收。

## 1. Prerequisites

- 从仓库根目录运行下列命令；Node 22.22.3、npm 10.9.8 作为复现基线。
- 可执行 Chromium；runner 默认 `/snap/bin/chromium`，不同位置通过 `TABLOOM_CHROMIUM` 指定。`TABLOOM_CHROMIUM` 必须指向可直接执行的 Chromium/Chrome 二进制；Snap 包装器（例如本机的 `/usr/bin/chromium-browser`）若因 DBus 启动失败不能作为可用浏览器。真实 WebGPU 验收需可用硬件 adapter，SwiftShader 不能代替硬件结果。
- 默认 browser runner 为 headless，适合 WASM/data 检查；无头模式下 `navigator.gpu` 存在但 `requestAdapter()` 为空是已知限制，不等于 NVIDIA 驱动故障。真实硬件 WebGPU 需在有 X11 display 的桌面会话显式使用 `TABLOOM_HEADLESS=0 TABLOOM_DISPLAY=:0`。runner 会检查 `navigator.gpu.requestAdapter()` 的 vendor，SwiftShader 或空 adapter 只记为 unavailable。
- localhost/HTTPS，worker/WASM 资产同源且 MIME 正确；dev server 配置 COOP/COEP。浏览器允许 IndexedDB，配额足够容纳所选模型和上下文；另测试禁用/不足场景。
- 大模型位于 ignored `artifacts/`。TabPFN shared graph/weights：`artifacts/tabpfn35/shared-weights-dynamic-fp16-storage/`；现有 raw-model fixture：`artifacts/tabpfn35/context-chain/web-fixture/`。完整 estimator golden 必须另行导出，不能用后者替代。
- Python 3.12/CUDA 和官方 checkpoint 只用于维护者生成参考；最终浏览器工作流不依赖 Python。干净 checkout 不包含权重，先按两个 spike README 的生成步骤准备或使用经过校验且有授权的既定 artifacts，禁止 runner 自动下载未知版本。

## 2. Existing spike baseline — runnable today when artifacts are present

```bash
npm ci --prefix spikes/tabpfn35/web
npm --prefix spikes/tabpfn35/web run probe:shared-context-chain-wasm
npm --prefix spikes/tabpfn35/web run probe:shared-context-chain-webgpu

npm ci --prefix spikes/tabiclv2/web
npm --prefix spikes/tabiclv2/web run probe:fp16-storage-wasm
npm --prefix spikes/tabiclv2/web run probe:fp16-storage-webgpu
```

预期：`status=supported`，TabPFN shared blob fetchCount=1，记录实际 adapter/provider 和时间。输出在各 `spikes/*/web/browser-results/`。这些测试证明现有页面内模型路径，不证明新 Worker、数据库回写或最终 TypeScript estimator 均值通过。

维护者需要复查已有 estimator baseline 时，使用明确环境位置：

```bash
UV_PROJECT_ENVIRONMENT="$PWD/.venv" uv sync --project spikes/tabpfn35 --frozen
.venv/bin/python spikes/tabpfn35/probe_estimator_parity.py \
  --model-path "$PWD/.cache/models/tabpfn-v3.5-20260909.safetensors"
```

前置：官方 checkpoint 和 FP32 context/prediction ONNX 已按 [TabPFN README](../../spikes/tabpfn35/README.md) 生成，CUDA 可见。该脚本当前仅输出摘要，不能生成本 feature 要求的全部 golden。TabICL artifacts 前置见 [TabICL README](../../spikes/tabiclv2/README.md)。

## 3. Runtime setup commands

```bash
npm ci --prefix runtime
npm --prefix runtime run fixtures:prepare -- --artifact-root "$PWD/artifacts"
npm --prefix runtime run typecheck
npm --prefix runtime test
npm --prefix runtime run build
```

- `fixtures:prepare` 检查完整 golden、Case metadata、模型目录和 manifest/checksums，生成本地 harness 路由清单。缺失文件返回非零退出码并列出具体缺项，不自动生成虚假期望值或拉取另一模型版本。
- 完整 golden exporter 已放在两个 spike 中；输入必须包括官方 checkpoint、精确 profile/seed 和 artifact 配置，输出小型版本化 fixtures 与 ignored 大型中间数组。在 exporter 尚未运行前，真实 parity suite 明确返回 unavailable/非零，而不是把 skip 当通过。
- `typecheck` 不加载大模型；`test` 使用 node:test/tsx 覆盖转换、identity、snapshot、错误与调度契约；`build` 验证入口和 worker/WASM 资产可打包。
- npm lockfile 已提交为安装产物；后续使用 `npm ci` 复现。

## 4. Browser acceptance commands

```bash
npm --prefix runtime run test:browser -- --suite integration --provider wasm
npm --prefix runtime run test:browser -- --suite parity --provider wasm
npm --prefix runtime run test:browser -- --suite parity --provider webgpu
npm --prefix runtime run test:browser -- --suite persistence --provider wasm
npm --prefix runtime run test:browser -- --suite lifecycle --provider webgpu --cycles 20
npm --prefix runtime run test:browser -- --suite case --provider wasm
npm --prefix runtime run test:browser -- --suite case --provider webgpu
```

硬件 WebGPU 验收示例（当前桌面 X11）：

```bash
TABLOOM_HEADLESS=0 TABLOOM_DISPLAY=:0 \
  npm --prefix runtime run test:browser -- --suite lifecycle --provider webgpu --cycles 20
```

runner 自动启动/关闭本地服务器与浏览器，输出 `artifacts/runtime/reports/<suite>-<provider>.json`。每份报告含 commit/依赖版本、fixture/artifact digest、设备/浏览器/provider、通过/失败/未支持、计数、完整误差摘要、时序及 unavailable memory 字段。必需硬件或 artifacts 缺失时显式非零退出，不将 skip 当发布通过。WASM 验收固定 WASM；WebGPU 验收禁止自动回退掩盖缺失硬件。

Case 验收使用 `artifacts/tabiclv2/case-golden/manifest.json` 绑定的
`fp32` 与 `fp16-storage-fp32-compute` 两套图和 external-data。四个组合都
通过同源 Vite 路由加载，并在 module worker 内验证 SHA-256、声明 shape、
输入预处理、输出行数、target inverse、baseline/changed/repeat 以及嵌入
snapshot identity。目标单位误差预算分别为 FP32 `0.0001`、FP16-storage
`0.01`；报告中的 `caseEvidence` 记录 provider、adapter vendor、variant、
model/graph digest、预算和 observed maximum error。Case 保持
`canBuildContext=false`，训练变更返回 `UNSUPPORTED_CAPABILITY`，不会自动换
模型或重训。

当前 Chromium/NVIDIA 排查：

```bash
dbus-send --session --dest=org.freedesktop.DBus --type=method_call \
  --print-reply /org/freedesktop/DBus org.freedesktop.DBus.ListNames
nvidia-smi --query-gpu=name,driver_version --format=csv,noheader

TABLOOM_HEADLESS=0 TABLOOM_DISPLAY=:0 \
TABLOOM_CHROMIUM=/usr/bin/chromium-browser \
  npm --prefix runtime run test:browser -- --suite integration --provider webgpu
```

如果 DBus 检查和 `nvidia-smi` 成功，而无头 runner 报 `adapter=false`，应改用上面的 headed X11 命令；这表示无头 Chromium 没有暴露硬件 adapter，不表示驱动不可用。每次验收都必须以当前报告中的 adapter/device 证据为准；历史 headed 结果不能替代当前宿主机证据。真实生命周期的 GPU 分配/设备丢失事件仍单独报告为 unavailable，直到对应事件被实际观测到。

| Suite | Scenario and required outcome | Spec |
| --- | --- | --- |
| integration | 真实 DuckDB 查询→Arrow 分块/slice/null 转换→预测→事务结果表→按 snapshot/ordinal join，重复键与重排零错配；故障注入无部分发布 | SC-001、SC-004、SC-008 |
| parity | 完整 raw input→fitted preprocessing→context→predict→decode；TabPFN 正常/NaN/opt-in Inf 全部最终均值有限，FP32 <=1e-4、FP16-storage <=2e-3；默认 Inf 拒绝 | SC-002 |
| persistence | 冷启动同实例并发 fetch=1；关闭 worker 后保持同 origin/profile 重开，warm 权重 fetch=0/context build=0；标签等变化 miss、预测变化 hit；损坏/中断/配额错误明确 | SC-003、SC-005 |
| lifecycle | 20 次准备/预测/关闭无资源不足；staged 与双 session 对比单独记录；handle 失效、取消/设备故障、迟到结果、资源清理 | SC-007、SC-008 |
| case | TabICL Case 特征处理和 target inverse 后完整均值满足 FP32 `0.0001`/FP16-storage `0.01` 预算；转 Common 身份一致；改训练拒绝、不换模型 | SC-002、SC-006 |

integration 中并发/故障可使用 fake adapter，但必须真实数据库/worker；parity/case 必须真实模型。lifecycle 对 device loss 采用可控注入与设备可观测事件分开记录，不伪称注入就是实际硬件故障测量。不同 suite 中实际运行的配置要完整列出，不能拿单一 provider 覆盖另一 provider 的验收。

## 5. Manual integration walkthrough

```bash
npm --prefix runtime run dev
```

实施约定：验证页面固定在 `http://127.0.0.1:4175/`，占用端口时报错而非静默换端口（避免缓存 origin 不一致）。

1. 打开合成数值回归示例，查看模型能力、artifact 版本与数据范围，选择目标并执行；查询结果表验证逐行对应。
2. 保存基准，连续修改 20 次情景；当前结果只对应最后一次，基准仍可查，旧请求状态明确。
3. 保存 context 后完全重启 model worker，用同一训练/预测 fixture 恢复；检查零 context build、同一精度预算。
4. 单独改变一条 target，再运行；确认旧 context 不命中。再仅改预测行，确认上下文复用。
5. 打开 TabICL Case，查看原始目标单位结果；进入 Common View 后数据/模型/结果身份保持一致，尝试改训练应得到明确能力错误。
6. 模拟配额不足及 provider 不可用，确认 warning/error 和实际执行方式；取消运行或关闭运行环境后，迟到结果不成为当前结果。

复现细节与资源语义分别参考 [runtime contract](contracts/runtime.md)、[persistence contract](contracts/persistence.md) 和 [data contract](contracts/data-and-publication.md)。本 guide 不要求开发最终产品界面。

## 6. Release evidence boundary

通过上述 suite 是待实现的条件，不是本次 plan 的结论。记录实际 target-unit budgets 后才发布真实 Case 的节省体积版本；不得将合成 fixture 误差预算直接套用到不同目标量级。静态部署另验相同构建的 worker/WASM 加载、隔离头、持久重开和模型资产路径，不以 localhost 成功替代部署验证。
