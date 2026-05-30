# 家庭保单报告 — 设计文档

> 日期: 2026-05-30
> 状态: 待用户确认
> 范围: 家庭保单总统计、保单清单、被保人保单明细、重疾分析、意外分析、财富分析、全家财富统计、导出

## 目标

新增一份家庭保单报告，把用户名下所有保单按家庭视角汇总。报告先给全家总统计和保单档案，再按重疾、意外、财富三大板块分析，每个板块内分别分析家庭成员，最后给全家财富统计和可核对附录。

## 报告顺序

1. 全家总统计
   - 家庭成员数
   - 有效保单数
   - 年交保费合计
   - 保障总额
   - 现金价值合计
   - 未来累计领取
   - 待关注项

2. 家庭保单清单
   - 先列所有保单，作为后续分析的数据来源。
   - 字段: 被保人、保单/产品、类型、年交保费、保障/保额、现金价值、数据状态。

3. 被保人保单明细
   - 按被保人分别列完整有效保单表。
   - 字段: 保险公司/保单号、险种名称、保费、交费期、保障期、生效日期、保额、身故受益人、期交总保费。

4. 重疾分析
   - 报告主轴先进入“重疾分析”板块。
   - 板块内按家庭成员分别生成同结构重疾量化表。
   - 每个成员的表包含: 重疾首次、重疾多次、中症、轻症、特定疾病、癌症/恶性肿瘤、疾病终末期、身故/全残、保费豁免。
   - 每行展示: 金额/比例、次数、状态、条件/说明、来源保单。

5. 意外分析
   - 报告主轴再进入“意外分析”板块。
   - 板块内按家庭成员分别生成同结构意外量化表。
   - 每个成员的表包含: 一般意外身故/全残、意外伤残、意外医疗、交通意外、自驾/驾乘、公共交通、航空、轨道/轮船、猝死、住院津贴。
   - 每行展示: 金额/额度、赔付方式、状态、条件/说明、来源保单。

6. 财富分析
   - 财富板块按家庭成员展开。
   - 每个成员下列出不同财富类保单。
   - 每张财富类保单展示现金流表和现金价值曲线/表。
   - 单保单字段: 年份/年龄、领取金额、累计领取、现金价值。

7. 全家财富统计
   - 放在财富板块结尾。
   - 按日历年汇总所有保单。
   - 字段: 年份、保费支出、领取收入、年度净现金流、累计净现金流、现金价值合计。
   - 汇总数字需要能拆回成员和具体保单。

8. 保单附录/OCR 来源
   - 顾问版导出时展开。
   - 家庭版默认折叠。
   - 每张保单保留基础信息、主险/附加险、责任原文解析、资料来源、OCR 原文、现金价值 OCR 表。

## 数据模型

新增前端纯数据模型 `FamilyReport`，由现有 `Policy[]` 构建，不新增后端接口。

```ts
type FamilyReport = {
  summary: FamilyReportSummary;
  policyInventory: FamilyPolicyInventory;
  criticalIllness: FamilySectionReport;
  accident: FamilySectionReport;
  wealth: FamilyWealthReport;
  appendix: FamilyPolicyAppendix;
};
```

### FamilyReportSummary

```ts
type FamilyReportSummary = {
  memberCount: number;
  policyCount: number;
  annualPremium: number;
  totalCoverage: number;
  cashValueTotal: number;
  futurePayoutTotal: number;
  attentionItems: string[];
};
```

### FamilyPolicyInventory

```ts
type FamilyPolicyInventory = {
  rows: FamilyPolicyInventoryRow[];
  insuredGroups: FamilyInsuredPolicyGroup[];
};
```

`rows` 负责家庭保单清单，`insuredGroups` 负责被保人保单明细。

### FamilySectionReport

重疾和意外共用结构:

```ts
type FamilySectionReport = {
  members: FamilyMemberProtectionReport[];
};

type FamilyMemberProtectionReport = {
  member: string;
  rows: FamilyProtectionRow[];
  attentionItems: string[];
};
```

### FamilyProtectionRow

```ts
type FamilyProtectionRow = {
  key: string;
  label: string;
  amountText: string;
  countText: string;
  status: 'covered' | 'partial' | 'missing' | 'formula' | 'unknown';
  conditionText: string;
  sourcePolicies: string[];
};
```

### FamilyWealthReport

```ts
type FamilyWealthReport = {
  memberReports: FamilyMemberWealthReport[];
  aggregateRows: FamilyWealthAggregateRow[];
  keyPoints: FamilyWealthKeyPoint[];
};
```

### FamilyMemberWealthReport

```ts
type FamilyMemberWealthReport = {
  member: string;
  policies: FamilyWealthPolicyReport[];
  attentionItems: string[];
};
```

### FamilyWealthPolicyReport

```ts
type FamilyWealthPolicyReport = {
  policyId: number;
  productName: string;
  company: string;
  annualPremium: number;
  cashflowRows: FamilyWealthPolicyCashflowRow[];
  cashValueRows: FamilyWealthPolicyCashValueRow[];
  keyPoints: FamilyWealthKeyPoint[];
};
```

## 数据口径

### 顶部总统计

- 家庭成员数: 按 `policy.insured` 去重，空值归为“未识别被保人”。
- 有效保单数: 第一版用当前用户的 `policies.length`，后续可加失效识别。
- 年交保费合计: 汇总 `policy.firstPremium`。
- 保障总额: 汇总 `policy.amount`，只作为粗略总额；细分额度以重疾/意外板块为准。
- 现金价值合计: 取每张保单现金价值表中当前可用的最新一行现金价值，按保单合计。
- 未来累计领取: 汇总所有 `cashflowEntries.amount`。
- 待关注项: 来自缺失责任、现金价值表缺失、生日/生效日缺失、责任仍在生成中。

### 重疾量化

优先使用 `coverageIndicators`，再回退到 `responsibilities`，最后回退到保单基础保额。

责任归类:

- 重疾首次: `重疾|重大疾病|重度疾病|首次`
- 重疾多次: `多次|第二次|第2次|再次`
- 中症: `中症|中度疾病`
- 轻症: `轻症|轻度疾病`
- 特定疾病: `特定疾病|少儿特疾|女性特疾|男性特疾`
- 癌症/恶性肿瘤: `恶性肿瘤|癌`
- 疾病终末期: `终末期`
- 身故/全残: `身故|全残`
- 保费豁免: `豁免`

金额口径:

- 明确金额文本优先。
- 指标为基本保额比例时，用保单/险种保额乘比例。
- 指标为倍数时，用保单/险种保额乘倍数。
- 无法确定金额时显示公式或“待识别”，不编造数值。

### 意外量化

优先使用 `coverageIndicators`，再回退到 `responsibilities`。

责任归类:

- 一般意外身故/全残
- 意外伤残
- 意外医疗
- 交通意外
- 自驾/驾乘
- 公共交通
- 航空
- 轨道/轮船
- 猝死
- 住院津贴

不同意外场景分开展示，不合并为一个“意外总额”。

### 财富分析

- 单保单视角按保单年度/被保人年龄展示。
- 全家统计按日历年展示。
- 现金价值表 `cashValues` 通过 `effectiveYear + policyYear - 1` 转成日历年。
- 年度净现金流 = 领取收入 - 保费支出。
- 累计净现金流按日历年递增累计。
- 现金价值合计 = 当年所有有现金价值数据的保单现金价值之和。

## 展示设计

新增家庭报告页面或报告区块，入口在“保障管理/我的保单”页的家庭总览卡片附近。

页面组件:

- `FamilyReportPage`
- `FamilyReportSummaryCards`
- `FamilyPolicyInventoryTable`
- `FamilyInsuredPolicyDetailTables`
- `FamilyCriticalIllnessSection`
- `FamilyAccidentSection`
- `FamilyWealthSection`
- `FamilyWealthAggregateSection`
- `FamilyReportAppendix`

移动端以横向滚动表格为主，避免挤压文本；导出模式使用固定宽度打印布局。

## 错误与缺失数据

- `reportStatus === 'generating'`: 显示“责任生成中”，相关行状态为 unknown。
- `reportStatus === 'failed'`: 显示失败原因，并保留保单基础信息。
- 缺少生日: 财富年龄轴显示“年龄待补充”，仍按日历年展示。
- 缺少生效日: 单保单现金价值无法转日历年，显示“生效日待补充”。
- 缺少现金价值表: 财富保单卡显示“待上传现金价值表”。
- 没有某板块保单: 成员表保留，状态为 missing。

## 测试要求

- 纯函数单元测试覆盖 `FamilyReport` 构建。
- 分类测试覆盖重疾、轻症、中症、特疾、一般意外、交通、航空、意外医疗。
- 财富测试覆盖单保单现金价值转日历年、全家年度汇总、累计净现金流。
- UI 源码测试覆盖页面组件、三大板块顺序、保单清单在三大板块前。

## 非目标

- 第一版不新增后端家庭报告接口。
- 第一版不做收入/负债/预算驱动的建议保额计算。
- 第一版不做保险产品推荐。
- 第一版不重构 OCR 和责任识别流程。
