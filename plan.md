# Tabloom

> Browser-native tabular machine learning powered by DuckDB-WASM and TabPFN 3.5.

## 1. Overview

Tabloom is a browser-native environment for exploring tabular data and running machine-learning inference directly against that data.

The core idea is simple:

```text
Parquet / CSV / Arrow / Object Storage
                  │
                  ▼
             DuckDB-WASM
                  │
          SQL / Data Views
                  │
                  ▼
           Feature Dataset
                  │
                  ▼
            TabPFN 3.5
                  │
          ONNX / WebGPU
                  │
                  ▼
 Prediction / Probability
                  │
                  ▼
       Visualization / Export
```

The application should require no Python runtime and no inference backend for its core workflow.

Data querying, preprocessing, model execution, prediction, and visualization should happen locally inside the browser.

The initial model target is **TabPFN 3.5**, while the architecture should remain extensible enough to support other tabular foundation models in the future.

---

# 2. Motivation

Modern browser applications can already perform surprisingly sophisticated data processing.

DuckDB-WASM provides:

- SQL execution
- Parquet scanning
- Arrow integration
- local file access
- remote object-storage access
- analytical queries

At the same time, WebAssembly and WebGPU make local machine-learning inference increasingly practical.

However, these two capabilities are usually treated separately:

```text
Browser data tools

CSV / Parquet
     ↓
DuckDB
     ↓
SQL
     ↓
Chart
```

or:

```text
Browser AI

Input
  ↓
Model
  ↓
Prediction
```

Tabloom combines them:

```text
                 Browser

        ┌───────────────────┐
        │    Data Sources   │
        │ CSV / Parquet     │
        │ Arrow / Remote    │
        └─────────┬─────────┘
                  │
                  ▼
        ┌───────────────────┐
        │    DuckDB-WASM    │
        │ SQL / Filtering   │
        │ Aggregation       │
        │ Feature Views     │
        └─────────┬─────────┘
                  │
                  ▼
        ┌───────────────────┐
        │ Feature Dataset   │
        │ X_train / y_train │
        │ X_test            │
        └─────────┬─────────┘
                  │
                  ▼
        ┌───────────────────┐
        │    TabPFN 3.5     │
        │ WebGPU inference  │
        └─────────┬─────────┘
                  │
                  ▼
        ┌───────────────────┐
        │ Prediction Layer  │
        │ class / prob / y  │
        └─────────┬─────────┘
                  │
                  ▼
        ┌───────────────────┐
        │ Visualization     │
        │ Analysis / Export │
        └───────────────────┘
```

The browser becomes both the **data engine** and the **ML inference engine**.

---

# 3. Product Vision

Tabloom should feel like a lightweight local data laboratory.

A user should be able to:

1. Open a webpage.
2. Load a Parquet or CSV dataset.
3. Inspect the schema and data.
4. Query the dataset using SQL.
5. Select a target column.
6. Define training and prediction subsets.
7. Run TabPFN locally.
8. Inspect predictions and probabilities.
9. Join predictions back to the original dataset.
10. Analyze and visualize the results.
11. Export the resulting data.

No notebook should be required.

No Python environment should be required.

No model inference API should be required for the core workflow.

---

# 4. Core Principles

## 4.1 Browser Native

Core computation happens inside the browser.

```text
Data → Query → Model → Prediction
```

should not require a backend service.

---

## 4.2 Local First

Local datasets should remain on the user's machine unless the user explicitly accesses remote data.

This provides:

- privacy
- low deployment complexity
- reproducibility
- offline capability after assets are cached

---

## 4.3 SQL as the Data Interface

DuckDB SQL is the primary mechanism for defining datasets.

Instead of creating a separate feature engineering DSL:

```sql
SELECT
    temperature,
    humidity,
    wind_speed,
    pressure,
    target
FROM weather
WHERE date < '2026-09-01';
```

The result becomes the model input.

---

## 4.4 Model-Agnostic Runtime

TabPFN 3.5 is the first supported model, but Tabloom should not permanently couple its data layer to TabPFN.

The model layer should expose a generic interface:

```ts
interface TabularModel {
  load(): Promise<void>;

  predict(input: TabularDataset): Promise<PredictionResult>;

  capabilities(): ModelCapabilities;
}
```

Future models could include:

- TabPFN variants
- TabICL
- tabular embeddings
- lightweight classifiers
- regression models
- forecasting models

---

# 5. Primary Use Case

Suppose a user loads:

```text
electricity_prices.parquet
```

with columns:

```text
date
hour
temperature
load
wind_generation
solar_generation
day_ahead_price
real_time_price
```

The user defines:

```sql
SELECT
    hour,
    temperature,
    load,
    wind_generation,
    solar_generation,
    real_time_price - day_ahead_price AS spread
FROM electricity_prices
WHERE date < '2026-09-01';
```

The user chooses:

```text
Target:

spread
```

Tabloom converts the query result into:

```text
X_train
y_train
```

Then another query defines the prediction dataset:

```sql
SELECT
    hour,
    temperature,
    load,
    wind_generation,
    solar_generation
FROM electricity_prices
WHERE date >= '2026-09-01';
```

which becomes:

```text
X_test
```

TabPFN performs inference:

```text
X_train
y_train
X_test
   │
   ▼
TabPFN 3.5
   │
   ▼
predictions
```

The predictions are returned to DuckDB as another relation:

```text
predictions
```

allowing:

```sql
SELECT
    test.*,
    predictions.prediction
FROM test
JOIN predictions USING (row_id);
```

The result can then be visualized or exported.

---

# 6. System Architecture

## 6.1 High-Level Architecture

```text
                        Browser

┌────────────────────────────────────────────────────┐
│                                                    │
│                   Tabloom UI                       │
│                                                    │
│  Data Browser    SQL Editor    Model Panel         │
│       │              │             │               │
│       └──────────────┼─────────────┘               │
│                      │                             │
│                      ▼                             │
│                Data Runtime                        │
│                DuckDB-WASM                         │
│                      │                             │
│                 Arrow Tables                       │
│                      │                             │
│                      ▼                             │
│               Feature Adapter                      │
│                      │                             │
│                      ▼                             │
│               Model Runtime                        │
│                                                    │
│        TabPFN 3.5 → ONNX → WebGPU                  │
│                      │                             │
│                      ▼                             │
│               Prediction Table                     │
│                      │                             │
│                      ▼                             │
│                DuckDB-WASM                         │
│                      │                             │
│                      ▼                             │
│             Chart / SQL / Export                   │
│                                                    │
└────────────────────────────────────────────────────┘
```

---

# 7. Data Layer

## 7.1 DuckDB-WASM

DuckDB-WASM is responsible for:

- reading data
- SQL execution
- filtering
- aggregation
- feature selection
- train/test selection
- joining predictions
- exporting results

Supported initial formats:

```text
Parquet
CSV
Arrow
```

Future formats may include:

```text
JSON
Iceberg
remote object storage
HTTP datasets
domain-specific formats
```

---

# 8. Internal Data Representation

Arrow should be preferred as the interchange format between DuckDB and the ML runtime.

```text
DuckDB
   │
   ▼
Arrow Table
   │
   ▼
Feature Adapter
   │
   ├── Float32Array
   ├── Int32Array
   └── metadata
          │
          ▼
       TabPFN
```

Avoid unnecessary:

```text
Arrow → JavaScript Objects → Array → Tensor
```

conversions.

Prefer:

```text
Arrow buffers
      ↓
TypedArray
      ↓
Tensor
```

where possible.

This reduces memory copies and garbage collection pressure.

---

# 9. Model Layer

## 9.1 Initial Model

Initial target:

```text
TabPFN 3.5
```

The goal is to execute TabPFN inference locally inside the browser.

Potential runtime path:

```text
TabPFN 3.5
     │
     ▼
PyTorch checkpoint
     │
     ▼
ONNX export
     │
     ▼
ONNX Runtime Web
     │
     ▼
WebGPU
```

Transformers.js may be used where useful for model management or compatible runtime abstractions, but it should not be treated as a hard architectural requirement.

The lower-level execution target should be WebGPU-compatible browser inference.

---

# 10. TabPFN Porting Investigation

A major technical objective of the project is determining whether TabPFN 3.5 can run efficiently and correctly in the browser.

The investigation should answer:

### Exportability

Can the TabPFN forward path be exported to ONNX?

Identify:

- unsupported operators
- dynamic control flow
- custom PyTorch operators
- dynamic tensor shapes
- attention implementation dependencies

### WebGPU Compatibility

Determine whether every required ONNX operator has a viable WebGPU execution path.

### Dynamic Dataset Shapes

Tabular inference naturally varies across:

```text
N = number of rows
F = number of features
C = number of classes
```

The browser runtime should support useful variation in these dimensions without requiring a separate model file for every dataset shape.

### Numerical Correctness

Browser predictions must be compared against the reference Python implementation.

For identical input:

```text
Python TabPFN
      vs
Browser TabPFN
```

compare:

```text
logits
probabilities
predicted classes
regression values
```

with explicit numerical tolerances.

---

# 11. Model Adapter

The application should isolate TabPFN-specific logic.

```text
ModelAdapter
      │
      ├── TabPFNAdapter
      │
      ├── FutureTabICLAdapter
      │
      └── FutureModelAdapter
```

Example interface:

```ts
interface TabularDataset {
  features: Float32Array;
  labels?: Float32Array;
  rows: number;
  columns: number;
}

interface PredictionResult {
  predictions: Float32Array;
  probabilities?: Float32Array;
  metadata: Record<string, unknown>;
}
```

---

# 12. Preprocessing

The browser implementation must reproduce all preprocessing required by the reference TabPFN implementation.

Potential operations include:

- missing-value handling
- categorical handling
- numerical normalization
- feature transformations
- target encoding
- class mapping
- feature ordering
- dataset-size handling

Preprocessing correctness is part of model correctness.

The project should avoid the situation:

```text
same model weights
+
different preprocessing
=
different model
```

---

# 13. Worker Architecture

Heavy computation should not block the UI.

Use Web Workers for:

```text
DuckDB-WASM
Model preprocessing
Model inference orchestration
Large data transformations
```

Possible architecture:

```text
Main Thread
     │
     ├── UI
     ├── charts
     └── interaction
          │
          ▼
      Data Worker
          │
      DuckDB-WASM
          │
          ▼
      Arrow buffers
          │
          ▼
      Model Worker
          │
       WebGPU
          │
          ▼
      Predictions
```

Transferable buffers should be used where possible.

---

# 14. User Interface

The initial interface should contain four primary areas.

## Data

Display:

- loaded files
- tables
- row count
- columns
- schema
- basic statistics

## SQL

Provide a SQL editor backed by DuckDB.

Example:

```sql
SELECT *
FROM dataset
WHERE date >= '2026-01-01'
LIMIT 1000;
```

## Model

Allow users to configure:

```text
Model
Target column
Task type
Training query
Prediction query
```

Initial task types:

```text
Classification
Regression
```

## Results

Display:

```text
Prediction
Probability
Actual value if available
Error
Distribution
```

and allow the result to become another DuckDB table.

---

# 15. Prediction as Data

A key design principle is:

> Model output should become queryable data.

Predictions should not exist only inside a chart component.

After inference:

```text
prediction_id
row_id
prediction
probability
model
runtime
```

should be registered with DuckDB.

This allows users to run:

```sql
SELECT *
FROM predictions
WHERE probability < 0.6;
```

or:

```sql
SELECT
    date,
    AVG(ABS(actual - prediction)) AS mae
FROM prediction_results
GROUP BY date;
```

This closes the loop:

```text
Data
 ↓
SQL
 ↓
Model
 ↓
Prediction
 ↓
SQL
 ↓
Analysis
```

---

# 16. Visualization

Initial visualization requirements should remain intentionally small.

Support:

- table view
- scatter plot
- line chart
- histogram
- prediction distribution
- probability distribution

Visualization should consume DuckDB query results rather than directly coupling to TabPFN.

---

# 17. Export

Users should be able to export prediction results.

Initial formats:

```text
CSV
Parquet
Arrow
```

Example:

```text
original data
+
prediction
+
probability
+
model metadata
```

→

```text
prediction_results.parquet
```

---

# 18. Browser Capability Detection

At startup, detect:

```text
WebGPU availability
WASM support
browser memory constraints where observable
model cache availability
```

Runtime status should be visible:

```text
DuckDB        Ready
WebGPU        Available
TabPFN        Not loaded
Model cache   1.2 GB
```

If WebGPU is unavailable, the application should clearly indicate that model inference is unavailable or running through a slower fallback where supported.

---

# 19. Model Download and Cache

Model weights may be large.

The browser should therefore support persistent model caching.

Possible storage:

```text
Cache API
IndexedDB
OPFS
```

Desired lifecycle:

```text
First visit

download model
      ↓
cache locally
      ↓
run inference

Later visit

local cache
      ↓
run inference
```

The application should show:

```text
download progress
model size
cache status
loading progress
```

---

# 20. Performance Goals

The initial PoC should benchmark at least:

```text
100 rows × 10 features
1,000 rows × 20 features
10,000 rows × 50 features
```

where supported by TabPFN and available browser resources.

Measure:

```text
model download time
model initialization time
preprocessing time
inference time
peak memory
GPU memory pressure
prediction accuracy difference vs Python
```

Performance should be measured separately for:

```text
Cold start
Warm start
```

because cached browser inference is a fundamentally different experience from first-load inference.

---

# 21. Correctness Tests

Every browser model implementation should have reference fixtures generated by Python.

Example fixture:

```text
fixture/
├── X_train.npy
├── y_train.npy
├── X_test.npy
├── python_logits.npy
├── python_probabilities.npy
└── metadata.json
```

Browser tests execute the same dataset and compare results.

Tests should cover:

```text
binary classification
multiclass classification
regression
missing values
different feature counts
different dataset sizes
```

where supported.

---

# 22. MVP

The first usable version should support:

```text
Open local Parquet/CSV
        ↓
Inspect with DuckDB
        ↓
Write SQL
        ↓
Select target
        ↓
Create train/test dataset
        ↓
Run TabPFN
        ↓
Display prediction
        ↓
Register prediction in DuckDB
        ↓
Query / visualize
        ↓
Export Parquet
```

The MVP does NOT need:

- accounts
- authentication
- cloud backend
- collaborative editing
- hosted inference
- notebooks
- complex dashboards
- agent functionality

---

# 23. Phase 0 — Feasibility PoC

Before building the full application, validate the hardest assumption:

> Can TabPFN 3.5 execute correctly through a browser-compatible WebGPU runtime?

Build the smallest possible experiment:

```text
Python
  │
TabPFN 3.5
  │
ONNX export
  │
tabpfn.onnx
  │
Browser
  │
ONNX Runtime Web
  │
WebGPU
  │
Prediction
```

Use approximately:

```text
1000 rows
20 features
binary classification
```

Compare against Python.

Success criteria:

- model exports
- browser loads model
- WebGPU executes model
- prediction output is numerically close to Python
- execution does not exceed practical browser memory
- no server-side inference is required

This phase should happen before significant UI development.

---

# 24. Phase 1 — DuckDB Integration

After model execution works:

```text
Parquet
   ↓
DuckDB-WASM
   ↓
Arrow
   ↓
TabPFN
```

Validate zero/minimal-copy data transfer.

Implement:

- file loading
- schema inspection
- SQL editor
- Arrow extraction
- model adapter

---

# 25. Phase 2 — End-to-End MVP

Build:

```text
Dataset
   ↓
SQL
   ↓
Train/Test
   ↓
TabPFN
   ↓
Predictions
   ↓
DuckDB
   ↓
Chart
```

Add:

- model panel
- prediction table
- probability display
- export

---

# 26. Phase 3 — Browser ML Workbench

Expand from a TabPFN demo into a general browser-native tabular ML environment.

Possible features:

```text
multiple models
model comparison
cross-validation
uncertainty visualization
feature analysis
evaluation metrics
saved queries
saved experiments
```

---

# 27. Phase 4 — Agentic Data Views

A future extension is allowing an AI agent to dynamically construct data views and model experiments.

Example user request:

```text
Find which weather variables are associated with
large electricity price spread errors.
```

Possible workflow:

```text
Natural Language
       ↓
      Agent
       ↓
DuckDB SQL generation
       ↓
Feature dataset
       ↓
TabPFN experiment
       ↓
Evaluation
       ↓
new SQL / new experiment
       ↓
Visualization
```

The important architectural property is that the agent operates on a structured browser data/model runtime instead of manually manipulating raw files.

---

# 28. Non-Goals

Tabloom is not initially intended to become:

- a general Python notebook replacement
- a full AutoML platform
- a cloud ML training platform
- a distributed compute engine
- an LLM chat frontend

Its core abstraction is:

```text
Queryable Data
      +
Browser-native Tabular Model
      =
Interactive Local ML
```

---

# 29. Technical Risks

## TabPFN Exportability

TabPFN 3.5 may contain operations that cannot be directly exported or executed by ONNX Runtime Web.

Mitigation:

```text
identify unsupported graph
        ↓
replace problematic operations
        ↓
export minimal inference graph
```

---

## Browser Memory

Model weights + dataset tensors + attention intermediates may exceed practical browser limits.

Mitigation:

- quantization
- reduced precision
- dataset-size limits
- model variants
- chunked preprocessing
- buffer reuse

---

## Numerical Differences

WebGPU kernels may produce differences compared with PyTorch/CUDA.

Mitigation:

Define tolerances and compare probabilities/predictions rather than requiring bit-identical execution.

---

## Model Size

Initial download may negatively affect UX.

Mitigation:

- persistent caching
- quantization
- lazy loading
- download progress
- optional smaller model variants

---

## Preprocessing Parity

Python-side preprocessing may be difficult to reproduce exactly in JavaScript.

Mitigation:

Separate preprocessing from model execution and build reference fixtures for every transformation.

---

# 30. Repository Structure

Suggested initial repository layout:

```text
tabloom/
│
├── apps/
│   └── web/
│
├── packages/
│   ├── duckdb/
│   ├── data/
│   ├── model-runtime/
│   ├── tabpfn/
│   ├── visualization/
│   └── ui/
│
├── model/
│   ├── export/
│   ├── reference/
│   └── fixtures/
│
├── benchmarks/
│
├── tests/
│
├── docs/
│
├── SPEC.md
└── README.md
```

---

# 31. Suggested Technology Stack

Frontend:

```text
TypeScript
React
Vite
```

Data:

```text
DuckDB-WASM
Apache Arrow
```

ML:

```text
TabPFN 3.5
PyTorch — reference/export
ONNX
ONNX Runtime Web
WebGPU
```

Optional:

```text
Transformers.js
```

Visualization:

```text
Vega-Lite
Observable Plot
or another lightweight browser-native chart layer
```

Storage:

```text
IndexedDB / OPFS / Cache API
```

---

# 32. Key Research Question

The most important question is not:

> Can we build another browser data viewer?

DuckDB-WASM already makes that possible.

The interesting question is:

> **Can a tabular foundation model become a native primitive of the browser data stack?**

Today the common architecture is:

```text
Browser
   ↓
API
   ↓
Python
   ↓
Model
```

Tabloom explores:

```text
Browser
   │
   ├── DuckDB
   ├── Arrow
   ├── TabPFN
   └── WebGPU
```

The data and model live in the same local computational environment.

That enables a different interaction model:

```text
query → predict → query → inspect → modify → predict
```

with very low friction.

---

# 33. Success Criteria

The project is successful at the PoC level when:

```text
✓ TabPFN 3.5 executes in a browser
✓ inference uses WebGPU
✓ predictions match Python within tolerance
✓ DuckDB-WASM results can directly feed the model
✓ predictions can return to DuckDB
✓ no inference backend is required
```

The project is successful at the MVP level when a user can:

```text
drop Parquet
     ↓
write SQL
     ↓
choose target
     ↓
run TabPFN
     ↓
inspect predictions
     ↓
query predictions
     ↓
export result
```

entirely from a static web application.

---

# 34. Project Identity

**Name:** Tabloom

**Tagline:**

> Run tabular foundation models directly on your data, entirely in the browser.

Alternative technical description:

> DuckDB-WASM + WebGPU for browser-native tabular foundation models.

The name intentionally does not reference TabPFN directly.

TabPFN 3.5 is the first model backend, while Tabloom represents the broader idea of combining browser-native analytical databases with browser-native tabular foundation models.
