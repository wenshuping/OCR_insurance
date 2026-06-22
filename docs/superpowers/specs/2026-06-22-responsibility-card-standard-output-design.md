# 保单责任卡片标准输出设计

> 日期: 2026-06-22
> 状态: 用户已确认设计
> 范围: 统一保险责任输出、指标核对、可量化字段、现金流分类

## 目标

建立一个统一的后端标准层，把保险责任输出成“用户能看懂、系统能量化”的责任卡片。

第一期目标:

- 三个入口共享同一套责任卡片标准:
  - 输入保险公司和产品名查询责任。
  - 上传或录入保单后的分析结果。
  - 保单详情和家庭报告展示。
- 每张责任卡片先给用户清楚说明责任内容，再挂载 0-N 个可量化指标。
- 每条指标进入计算前必须核对来源、责任语义、计算基准和现金流分类。
- 严格模式处理不合格指标: 展示责任，但不让不合格指标进入金额、现金流、保障额度或家庭报告量化。
- 保持旧字段兼容，避免一次性重写现有 OCR、责任查询、现金流和报告流程。

## 背景

项目已经有三类责任相关数据:

- `knowledge_records`: 官方责任正文和来源材料。
- `insurance_indicator_records`: 结构化保障指标。
- `optional_responsibility_records`: 可选责任治理数据。

现有指标已经包含 `basisKey`、`calculationKey`、`calculationEligible`、`calculationReason` 等后台计算字段，但仍有问题:

- 责任查询快路径会把官方责任正文整段返回，未拆成用户易读的责任卡片。
- 前端仍有部分启发式金额计算逻辑，容易和后端指标规则不一致。
- `cashflowTreatment` 尚未形成统一输出字段，导致“可计算金额”和“是否进入现金流”容易混在一起。
- 老数据质量不一致，需要输出时严格拦截，而不是先全库清洗再上线。

## 范围外

- 不直接修改生产库。
- 不一次性清洗全部历史指标。
- 不自动把老指标全部写回 `cashflowTreatment`。
- 不把医疗、重疾、意外、身故、全残等出险触发责任硬转成固定现金流。
- 不新增复杂人工指标编辑器。
- 不改变官方资料爬取和 OCR 识别流程。

## 核心决策

用户已确认以下设计决策:

- 采用统一后端标准层，而不是只改前端展示。
- 输出形态为“每个责任一张卡片，卡片下面挂 0-N 个量化指标”。
- 采用严格模式: 指标核对失败时，责任可展示，指标不可计算。
- 第一版覆盖全险种责任卡片，但只有高置信指标进入计算。
- 每条可计算指标必须有 `sourceUrl` 和 `sourceExcerpt`。

## 架构

新增后端标准化模块:

```text
server/responsibility-card-standardizer.mjs
```

职责:

- 接收现有责任、指标、官方知识、可选责任和保单字段。
- 合并同一产品下的责任和指标。
- 生成统一的 `responsibilityCards`。
- 对每条指标执行严格校验。
- 输出计算可用性、失败原因和现金流分类。

不负责:

- 不爬取资料。
- 不调用 OCR。
- 不直接写数据库。
- 不替代现有现金流引擎。
- 不把模型回答当作来源。

标准层输入:

```text
policy/responsibilities
coverageIndicators
knowledgeRecords
optionalResponsibilityRecords
policy fields: company, name, amount, firstPremium, paymentPeriod, coveragePeriod, plans
officialDomainProfiles
```

标准层输出:

```text
responsibilityCards[]
```

三个入口使用方式:

- `/api/policy-responsibilities/query`: 在 `analysis` 上增加 `responsibilityCards`，旧的 `coverageTable` 保留。
- `/api/policies/analyze` 和保存保单流程: 返回 `responsibilityCards`，并在派生结果中持久化。
- 保单详情和家庭报告: 优先使用已持久化 `responsibilityCards`，没有时回退旧字段。

## 数据结构

### ResponsibilityCard

```ts
type ResponsibilityCard = {
  id: string;
  company: string;
  productName: string;
  title: string;
  category:
    | '现金流'
    | '人寿保障'
    | '疾病保障'
    | '医疗保障'
    | '意外保障'
    | '豁免'
    | '规则参数'
    | '其他';
  plainSummary: string;
  triggerCondition: string;
  payoutSummary: string;
  sourceUrl: string;
  sourceTitle: string;
  sourceExcerpt: string;
  confidence: 'high' | 'medium' | 'low';
  calculationStatus:
    | 'calculable'
    | 'needs_table'
    | 'claim_contingent'
    | 'waiver_only'
    | 'not_cashflow'
    | 'needs_review';
  calculationReason: string;
  cashflowTreatment:
    | 'scheduled_cashflow'
    | 'claim_contingent'
    | 'waiver_only'
    | 'not_cashflow';
  indicators: QuantifiedIndicator[];
};
```

### QuantifiedIndicator

```ts
type QuantifiedIndicator = {
  id?: string;
  liability: string;
  triggerCondition: string;
  basis: string;
  formulaText: string;
  basisKey: string;
  calculationKey: string;
  calculationEligible: boolean;
  calculationReason: string;
  cashflowTreatment:
    | 'scheduled_cashflow'
    | 'claim_contingent'
    | 'waiver_only'
    | 'not_cashflow';
  value?: number | null;
  unit?: string;
  sourceUrl: string;
  sourceExcerpt: string;
};
```

## 指标核对规则

### 来源校验

可计算指标必须满足:

- `sourceUrl` 非空。
- `sourceExcerpt` 非空。
- 来源能追到官方条款、官方说明书或官方披露材料。
- 指标内容不能超出来源片段支持范围。

缺来源时:

- 责任卡片仍可展示。
- 指标 `calculationEligible = false`。
- `calculationReason = '缺少官方来源片段，不能进入计算'`。

### 责任语义校验

指标必须有:

- 独立责任名，例如 `满期保险金`、`身故保险金`、`住院医疗保险金`。
- 触发条件，例如生存、满期、身故、确诊、住院、发生医疗费用。
- 给付动作，例如给付、赔付、报销、补偿、豁免。

不合格示例:

- `该项保险金`
- `相应保险金`
- `保险责任`
- `疾病种数`
- `赔付方式`
- `等待期`

这些可以作为规则参数或说明展示，但不能作为可计算责任金额。

### 计算基准校验

标准层复用 `src/indicator-calculation.mjs` 的基准判断，并补齐输出解释。

核心映射:

| 条款基准 | `basisKey` | 处理 |
| --- | --- | --- |
| 基本保险金额、基本保额、有效保险金额 | `basic_amount` | 可在保额存在时计算 |
| 首次交纳的基本责任保险费 | `first_basic_responsibility_premium` | 不可改成累计已交保费或保额 |
| 首期/首年保险费 | `first_premium` | 使用首期或首年保费 |
| 已交保险费、实际交纳保险费、所交保险费 | `total_paid_premium` | 使用保费和缴费期计算累计 |
| 现金价值 | `cash_value` | 需现金价值表，不直接计算 |
| 账户价值 | `account_value` | 需账户价值或账户余额，不直接计算 |
| 领取计划、比例表、计划表、保单载明金额 | `schedule_or_policy_table` | 需条款表或保单参数 |
| 实际医疗费用、免赔额、报销比例 | `medical_expense` | 需理赔费用参数 |
| 日津贴、给付天数、住院天数 | `daily_allowance` | 需天数或津贴表 |

### 现金流分类

`calculationEligible` 只表示金额是否能算，`cashflowTreatment` 表示是否进入现金流。

规则:

- 年金、生存金、满期金、祝寿金、教育金:
  - 金额和时间都明确时为 `scheduled_cashflow`。
  - 金额或时间依赖表时为 `not_cashflow`，并写明原因。
- 身故、全残、重疾、中症、轻症、特定疾病、意外、医疗:
  - 默认为 `claim_contingent`。
  - 即使金额可算，也不作为固定现金流。
- 豁免保险费:
  - 为 `waiver_only`。
  - 不作为给客户返钱的现金流。
- 等待期、赔付方式、疾病种数、规则参数:
  - 为 `not_cashflow`。

## 责任卡片生成规则

### 责任来源优先级

1. 已匹配的 `insuranceIndicatorRecords`。
2. 已确认选择状态的 `optionalResponsibilityRecords`。
3. 用户保单里的 `responsibilities`。
4. 官方知识库 `knowledgeRecords.pageText`。

当同一责任同时存在指标和责任正文时:

- 指标用于量化字段。
- 官方责任正文用于补足 `plainSummary`、`triggerCondition` 和 `payoutSummary`。
- 来源片段以指标 `sourceExcerpt` 优先，缺失时只能作为不可计算卡片展示。

### 卡片合并

同一产品下的同一责任应该合并到一张卡片。

合并 key:

```text
company + productName + normalized liability/title + responsibilityScope
```

可选责任必须保留 `responsibilityScope = optional` 和选择状态:

- `selected`: 指标通过校验后才可进入计算。
- `not_selected`: 展示为未选择，不进入计算。
- `unknown`: 展示为待确认，不进入计算。

### 用户可读文案

`plainSummary` 应该使用短句:

- 什么情况下触发。
- 保险公司承担什么。
- 按什么基准计算。
- 哪些内容需要表或人工确认。

示例:

```text
被保险人生存至合同约定日期时，保险公司按基本保险金额的约定比例给付生存保险金。
```

不要把整段条款原文直接塞进用户摘要。原文应保留在 `sourceExcerpt`。

## 持久化策略

第一期不新增独立责任卡片表，优先复用派生结果体系。

保存保单或重算派生结果时:

- 生成 `responsibilityCards`。
- 写入 `policy_derived_results.payload.responsibilityCards`。
- 返回保单时把派生结果里的 `responsibilityCards` 合并到响应。

兼容策略:

- `responsibilities` 保留。
- `coverageIndicators` 保留。
- `optionalResponsibilities` 保留。
- 新前端优先读 `responsibilityCards`。
- 老前端或旧测试仍可读旧字段。

查询产品责任时:

- `/api/policy-responsibilities/query` 不持久化查询结果。
- 响应 `analysis.responsibilityCards`。
- 响应 `analysis.sources` 继续保留来源列表。

## 错误处理

标准层不能因为单条指标错误阻断整张保单输出。

处理方式:

- 单条指标失败: 指标标记不可计算，并写 `calculationReason`。
- 单张卡片没有可用指标: 仍展示责任说明，`calculationStatus = needs_review` 或 `claim_contingent`。
- 产品没有官方来源: 返回空卡片或低置信卡片，并提示缺来源，不生成可计算指标。
- 数据字段冲突: 保留卡片，阻断计算，并记录冲突原因。

## API 兼容

新增字段:

```ts
analysis.responsibilityCards?: ResponsibilityCard[]
policy.responsibilityCards?: ResponsibilityCard[]
```

不删除字段:

```ts
analysis.coverageTable
policy.responsibilities
policy.coverageIndicators
policy.optionalResponsibilities
```

前端迁移:

- 保单详情优先展示 `responsibilityCards`。
- 家庭报告量化优先使用卡片里的通过校验指标。
- 没有 `responsibilityCards` 时回退 `coverageIndicators` 和 `responsibilities`。
- 金额显示应调用统一计算结果，不再在前端重复猜测计算基准。

## 测试计划

### 单元测试

新增责任卡片标准化测试:

- 年金/满期金在金额和时间明确时输出 `scheduled_cashflow`。
- 身故、全残、重疾、意外、医疗输出 `claim_contingent`。
- 豁免输出 `waiver_only`。
- 等待期、赔付方式、疾病种数输出 `not_cashflow`。
- 缺 `sourceUrl` 或 `sourceExcerpt` 的指标不可计算。
- 现金价值、账户价值、医疗费用、比例表、疾病分组、伤残等级、给付天数依赖不可直接计算。
- `首次交纳的基本责任保险费` 必须保持 `first_basic_responsibility_premium`。

### API 测试

覆盖:

- `/api/policy-responsibilities/query` 返回 `responsibilityCards`。
- `/api/policies/analyze` 返回 `responsibilityCards`。
- 保存保单后派生结果持久化 `responsibilityCards`。
- 老字段仍存在且旧流程不报错。

### 抽样验证

至少使用以下产品类型抽样:

- 年金险: `新华保险 / 尊享人生年金保险（分红型）`。
- 重疾险: 选一条已有官方来源和结构化指标的重疾产品。
- 医疗险: 选一条包含医疗费用、免赔额或报销比例的产品。
- 意外险: 选一条包含交通意外倍数或意外医疗的产品。
- 可选责任产品: 选一条有 `optionalResponsibilityRecords` 的产品。

## 验收标准

- 三个入口都能拿到同一结构的 `responsibilityCards`。
- 所有 `calculationEligible = true` 的指标都有 `sourceUrl` 和 `sourceExcerpt`。
- 出险触发责任不会进入固定现金流。
- 表依赖、医疗费用依赖、现金价值依赖不会被直接算成固定金额。
- 旧字段兼容，现有保存、详情、家庭报告流程不被破坏。
- 新增测试覆盖标准层和至少一个 API 路径。

## 后续阶段

第二期可以做历史数据治理:

- 对缺 `cashflowTreatment` 的指标分批补标。
- 把责任卡片质量问题输出成治理报表。
- 为管理员增加人工复核入口。
- 给可选责任增加更细的选择证据和量化状态编辑。
- 把经过验证的卡片摘要回写为可检索的官方责任摘要。
