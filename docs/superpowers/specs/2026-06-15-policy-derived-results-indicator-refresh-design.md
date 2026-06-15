# 保单派生结果持久化与指标更新重算设计

> 日期: 2026-06-15
> 状态: 用户已确认设计
> 范围: 保单列表读取性能、保单派生结果持久化、产品指标新增/更新后的影响范围重算

## 目标

解决客户手机验证码登录和保单列表读取慢的问题。慢的根因不是短信验证码，而是读取账户保单时每次现场把保单和大规模产品指标、产品知识重新匹配。

新的目标是把这些展示用结果持久化到 SQLite:

- 保单保存或修改时生成派生结果。
- 产品指标新增或更新时，只重算受影响产品对应的保单。
- 读取保单列表时直接读取已持久化的派生结果，不再现场扫描全部 `insurance_indicator_records` 和 `knowledge_records`。

这里的“缓存”不是内存缓存，也不是临时文件，而是可失效、可追踪、可重算的数据库派生结果。

## 范围外

- 不改变 OCR 识别算法。
- 不改变产品指标抽取规则本身。
- 不改变会员价格、支付、短信发送或验证码校验。
- 不把家庭报告作为独立持久化报表。家庭报告继续基于已刷新的保单数据生成。
- 不在客户登录请求里同步执行重算任务。

## 当前问题

当前 `/api/auth/register` 和 `/api/policies` 会把保单列表返回给前端。返回前会调用 `attachPoliciesCoverageIndicators`，对每张保单匹配:

- `insuranceIndicatorRecords`
- `knowledgeRecords`
- `optionalResponsibilityRecords`

本地开发数据已经有数万条产品指标和知识记录。即使客户只有十几张保单，读列表时也会反复扫描大数组。前端手机验证码登录后还会触发一次保单刷新，造成体感更慢。

保单创建和修改路径已经有一部分重算逻辑，例如现金流计算和产品身份变化后的保险责任报告重生成，但保单展示所需的 `coverageIndicators` 和 `optionalResponsibilities` 仍主要在读取时现算。

## 设计原则

1. 源数据和派生数据分离。
2. 派生结果必须持久化到 SQLite。
3. 指标更新后按产品影响范围重算，不全库重算。
4. 登录和列表读取不能被后台重算阻塞。
5. 派生结果可以 stale，但必须可见、可恢复、可验证。
6. 用户手动选择的可选责任状态必须保留。

## 数据模型

### policy_derived_results

新增表保存每张保单的展示派生结果。

```sql
CREATE TABLE policy_derived_results (
  policy_id INTEGER PRIMARY KEY,
  product_keys TEXT NOT NULL,
  coverage_indicators_payload TEXT NOT NULL,
  optional_responsibilities_payload TEXT NOT NULL,
  indicator_versions_payload TEXT NOT NULL,
  knowledge_version INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  stale_reason TEXT NOT NULL DEFAULT '',
  generated_at TEXT,
  error TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL
);
```

字段说明:

- `policy_id`: 对应 `policies.id`。
- `product_keys`: 这张保单涉及的产品 key 列表，JSON 数组。
- `coverage_indicators_payload`: 已匹配的保障指标 JSON。
- `optional_responsibilities_payload`: 已生成的可选责任审查 JSON。
- `indicator_versions_payload`: 本次计算使用的产品指标版本 JSON。
- `knowledge_version`: 本次计算使用的知识库版本。
- `status`: `ready`, `stale`, `generating`, `failed`。
- `stale_reason`: `policy_updated`, `indicator_updated`, `knowledge_updated`, `manual_rebuild` 等。
- `payload`: 聚合保存，便于后续扩展和调试。

第一期可以只读写 JSON payload，不需要把每个指标拆成子表。

### product_indicator_versions

记录每个产品的指标版本。

```sql
CREATE TABLE product_indicator_versions (
  product_key TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  last_batch_id TEXT NOT NULL DEFAULT ''
);
```

每次某个产品的指标新增、更新或删除，该产品版本递增。

### indicator_update_batches

记录指标更新批次和影响范围。

```sql
CREATE TABLE indicator_update_batches (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  changed_product_keys TEXT NOT NULL,
  indicator_upserts INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  finished_at TEXT,
  error TEXT NOT NULL DEFAULT ''
);
```

`source` 可取:

- `backfill`
- `admin`
- `sync`
- `script`

## 产品 key 规则

产品影响范围必须使用稳定 key。

优先级:

1. `canonicalProductId`
2. 规范化后的 `company + productName`

格式:

```text
canonical:<canonicalProductId>
company_product:<normalizedCompany>:<normalizedProductName>
```

保单产品 key 来源:

- `policy.canonicalProductId`
- `policy.company + policy.name`
- `policy.plans[].canonicalProductId`
- `policy.plans[].matchedProductName`
- `policy.plans[].name`

指标产品 key 来源:

- `indicator.canonicalProductId`
- `indicator.company + indicator.productName`

只有 key 有交集的保单才受影响。

## 保单保存和修改流程

### 新保单保存

`POST /api/policies/scan` 保存保单后:

1. 写入 `policies`。
2. 计算保单产品 key。
3. 根据当前指标和知识生成 `coverageIndicators`、`optionalResponsibilities`。
4. 写入 `policy_derived_results`，状态为 `ready`。
5. 计算并保存 `policy_cashflows`。
6. 返回保单时合并 `policy_derived_results`，不再现场全量匹配。

如果派生结果计算失败:

- 保单仍保存成功。
- `policy_derived_results.status = failed`。
- 返回基础保单和错误状态。
- 后台可重试。

### 保单修改

`PATCH /api/policies/:id` 修改保单后:

1. 判断产品身份是否变化。
2. 只要影响产品 key、保额、保费、缴费期、保障期、计划或可选责任选择，就标记该保单派生结果 `stale`。
3. 立即重算该保单派生结果。
4. 重算现金流。
5. 产品身份变化时沿用现有保险责任报告重生成逻辑。

第一期可以同步重算单张保单，因为单张保单的写入路径可以接受稍慢。列表读取和登录不能同步重算。

## 指标新增或更新流程

指标导入、抽取或修复脚本写入 `insurance_indicator_records` 后，必须执行后处理。

1. 收集本批次新增/更新/删除指标的产品 key。
2. 写入 `indicator_update_batches`。
3. 对每个产品 key 更新 `product_indicator_versions.version += 1`。
4. 查找 `policy_derived_results.product_keys` 与 changed product keys 有交集的保单。
5. 把这些保单标记为:

```text
status = stale
stale_reason = indicator_updated
```

6. 后台任务逐张重算 stale 保单。
7. 重算完成后写回 `policy_derived_results.status = ready`。
8. 批次状态改为 `done`。

如果重算失败:

- 批次状态可为 `failed` 或 `done_with_errors`。
- 对应保单 `policy_derived_results.status = failed`。
- 记录错误文本。
- 允许脚本或后台任务重试。

## 后台重算任务

后台任务只处理 stale 或 failed 的派生结果。

输入:

- `policy_id`
- stale reason
- 当前 `policies` 行
- 当前产品指标和知识记录

输出:

- `coverageIndicators`
- `optionalResponsibilities`
- `indicator_versions_payload`
- `knowledge_version`
- `status`

任务必须是幂等的。重复运行同一批次不应产生重复派生数据。

第一期可以实现为脚本和 API 内部 helper，不必先引入队列系统。后续如果任务量变大，再接入更正式的 job runner。

## 列表读取流程

`GET /api/policies` 不再现场调用 `attachPoliciesCoverageIndicators` 扫描大表。新流程:

1. 查出当前用户或游客的保单。
2. 查出这些保单对应的 `policy_derived_results`。
3. 对每张保单合并:
   - family display
   - persisted `coverageIndicators`
   - persisted `optionalResponsibilities`
   - persisted cashflow/cash value
   - `derivedStatus`
4. 返回列表。

如果某张保单没有派生结果:

- 返回基础保单。
- 标记 `derivedStatus = stale`。
- 不在列表读取请求里直接写库或全量持久化。
- 由显式后台任务或窄写入调度处理补算。

客户登录接口也不应同步返回完整重水合保单。验证码通过后先返回 token/user，前端再后台加载列表。

## 家庭报告影响

家庭报告不单独作为持久化报表。

原因:

- 当前家庭报告主要由前端 `buildFamilyReport(policies, ...)` 从保单列表生成。
- 只要保单列表里的派生指标已经刷新，家庭报告自然使用新数据。
- 独立持久化家庭报告会引入额外失效规则，例如成员变化、家庭关系变化、现金价值变化、规划参数变化。

第一期只保证保单派生结果正确刷新。家庭报告打开时基于最新保单数据计算。

## 指标批处理接入

现有 `scripts/backfill-knowledge-responsibility-indicators.mjs` 需要在写入指标后返回本次 changed product keys，并触发派生结果失效流程。

推荐流程:

1. dry-run 计算 `indicatorUpserts` 和 changed product keys。
2. 人工抽样检查。
3. SQLite 备份。
4. write。
5. rerun 同一命令，确认 `indicatorUpserts: 0`。
6. `PRAGMA quick_check`。
7. 标记受影响保单 stale。
8. 重算受影响保单派生结果。
9. 输出:
   - changed product count
   - affected policy count
   - recomputed policy count
   - failed policy count

## 错误处理

### 指标更新但无受影响保单

批次直接完成，输出 affected policy count 为 0。

### 派生结果缺失

列表读取返回基础保单。前端可以显示“保障数据刷新中”。补算由后台任务或显式重算入口处理，读请求本身不做持久化写入。

### 派生结果 stale

列表读取不阻塞。可返回旧结果和 `derivedStatus = stale`，前端显示轻量提示。后台重算完成后，下一次刷新显示新结果。

### 派生结果 failed

返回基础保单和失败状态。后台或管理脚本可重试。错误不得导致登录失败。

## 验证计划

### 单元测试

- 产品 key 生成:
  - canonical id 优先。
  - 无 canonical id 时使用 company/product。
  - 保单 plans 里的附加险产品 key 被包含。
- 指标变更影响范围:
  - 相同 canonical id 命中。
  - 相同 company/product 命中。
  - 相似但不同产品不命中。
- 派生结果合并:
  - list policies 使用持久化 coverage indicators。
  - list policies 不调用全量 `attachPoliciesCoverageIndicators`。

### SQLite store 测试

- 创建、更新、读取 `policy_derived_results`。
- 标记 stale。
- 按 product key 查找受影响 policy id。
- 更新 `product_indicator_versions`。
- 写入并完成 `indicator_update_batches`。

### 流程测试

- 保存保单后生成派生结果。
- 修改保单产品身份后派生结果更新，并触发报告重生成。
- 指标新增后只标记同产品保单 stale。
- 重算 stale 保单后列表读取新指标。
- 登录接口不因派生结果 stale/failed 阻塞。

### 性能验证

使用当前开发库数据验证:

- `/api/auth/register` 不再返回完整重水合保单。
- `/api/policies` 不再按请求扫描全部指标和知识记录。
- 19 张保单列表读取应明显低于当前约 2 秒级现场匹配。

## 迁移策略

上线后需要为现有保单补齐派生结果:

1. 扫描所有 `policies`。
2. 为每张保单计算 product keys。
3. 写入 `policy_derived_results`。
4. 输出总数、成功数、失败数。
5. 失败保单保持基础数据可读。

迁移脚本必须支持:

- dry-run
- 指定 policy id 范围
- 指定 company/product 范围
- 重跑幂等

## 完成标准

- 保单派生结果持久化到 SQLite。
- 保单列表读取使用持久化派生结果。
- 产品指标新增/更新后按产品影响范围标记和重算。
- 登录请求不阻塞在保单派生结果计算上。
- 现有指标抽取批处理能输出 affected policy 证据。
- 相关 focused tests 通过。
