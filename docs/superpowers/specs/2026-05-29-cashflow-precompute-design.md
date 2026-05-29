# 现金流预计算设计 (方案 A: 服务端计算 + 存储)

## 概述

将现金流计算从前端实时计算改为服务端预计算并存库，前端直接读取预计算结果。

**核心变化：**
- 知识库中附加产品级现金流模板（结构化 JSON 规则，带变量占位符）
- 保单创建/更新时，服务端用保单实际值替换模板变量，计算年度条目，存入 `policy_cashflows` 表
- 前端从 API 响应中直接读取预计算结果，不再实时计算

## Section 1: 数据模型

### 1.1 现金流模板（知识库附加）

在 `knowledge_records` 表的 `payload` JSON 中增加 `cashflowTemplate` 字段：

```json
{
  "cashflowTemplate": {
    "version": 1,
    "rules": [
      {
        "liability": "生存保险金",
        "timing": {
          "type": "range",
          "start": { "policyYear": 5 },
          "end": { "beforeEvent": "pensionStart" }
        },
        "amount": { "basis": "基本保额", "factor": 1 }
      },
      {
        "liability": "养老年金",
        "timing": {
          "type": "range",
          "start": { "age": "{{领取起始年龄}}" },
          "end": { "beforeEvent": "coverageEnd" }
        },
        "amount": { "basis": "基本保额", "factor": 1 }
      },
      {
        "liability": "满期生存保险金",
        "timing": { "type": "maturity" },
        "amount": { "basis": "已交保费" }
      }
    ],
    "params": {
      "领取起始年龄": { "source": "indicator", "key": "领取起始年龄" }
    }
  }
}
```

**变量占位符：**

| 变量 | 来源 |
|------|------|
| `{{基本保额}}` | `policy.amount` |
| `{{首期保费}}` | `policy.firstPremium` |
| `{{交费年数}}` | 从 `paymentPeriod` 解析 |
| `{{生效年}}` | 从 `policy.date` 解析 |
| `{{出生年}}` | 从 `insuredBirthday` 解析 |
| `{{领取起始年龄}}` | 从 indicator 的 `value` 取值 |
| `{{保障结束年}}` | 从 `coveragePeriod` 解析 |

### 1.2 现金流结果表（新建）

```sql
CREATE TABLE policy_cashflows (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  policy_id   INTEGER NOT NULL REFERENCES policies(id),
  year        INTEGER NOT NULL,
  age         INTEGER NOT NULL,
  amount      REAL    NOT NULL,
  cumulative  REAL    NOT NULL,
  liability   TEXT    NOT NULL,
  calc_text   TEXT,
  created_at  TEXT    DEFAULT (datetime('now'))
);
CREATE INDEX idx_cashflows_policy ON policy_cashflows(policy_id);
```

### 1.3 场景结果

场景条目（身故/全残等非年度现金流）存在 policy payload 的 `scenarioEntries` 字段中，因为它们是条件性的、不按年展开。

## Section 2: 服务端计算服务

### 2.1 核心模块：`server/cashflow-compute.mjs`

从现有 `src/cashflow-engine.mjs` 提取核心逻辑到服务端：

```javascript
/**
 * 为单个保单计算现金流，返回年度条目数组。
 * 优先级：模板规则 > 责任文本解析 > 指标回退
 */
export function computePolicyCashflow(policy, template, indicators) {
  const ctx = buildContext(policy);
  const rules = template?.rules || [];
  
  let entries = [];
  
  // 路径1: 有模板 → 用模板规则计算
  if (rules.length) {
    entries = computeFromTemplate(rules, template.params, ctx, indicators);
  }
  
  // 路径2: 无模板但有责任文本 → 解析责任文本
  if (!entries.length && policy.responsibilities?.length) {
    entries = computeFromResponsibilities(policy, ctx, indicators);
  }
  
  // 路径3: 都没有 → 用指标回退
  if (!entries.length && indicators.length) {
    entries = computeFromIndicators(indicators, ctx);
  }
  
  let cumulative = 0;
  entries = entries.map(e => { cumulative += e.amount; return { ...e, cumulative }; });
  
  return entries;
}
```

### 2.2 模板规则计算

```javascript
function computeFromTemplate(rules, params, ctx, indicators) {
  const resolvedParams = {};
  for (const [key, spec] of Object.entries(params || {})) {
    if (spec.source === 'indicator') {
      const ind = indicators.find(i => i.liability === spec.key);
      resolvedParams[key] = ind?.value || 0;
    }
  }
  
  const entries = [];
  for (const rule of rules) {
    entries.push(...expandRule(rule, ctx, resolvedParams));
  }
  return entries;
}
```

### 2.3 timing 类型

| type | 含义 | start/end 格式 |
|------|------|---------------|
| `range` | 每年领取区间 | `{policyYear:5}` / `{age:55}` / `{beforeEvent:"pensionStart"}` |
| `pointList` | 特定年龄列表 | `{ages:[15,18,21,24], minPolicyYear:5}` |
| `singleAge` | 单个年龄 | `{age:30}` |
| `maturity` | 满期一次性 | 无需 start/end |

### 2.4 amount 计算

| basis | factor | 结果 |
|-------|--------|------|
| `基本保额` | 1 | `policy.amount` |
| `基本保额` | 2 | `policy.amount * 2` |
| `基本保额` | 0.1 | `policy.amount * 10%` |
| `已交保费` | — | `firstPremium * 交费年数` |
| `已交保费` | 1.2 | `已交保费 * 120%` |
| `max` | — | `max(已交保费, 基本保额)` |

## Section 3: API 变更

### 3.1 触发时机

```
POST /api/policies/scan     → 保存保单 → 计算现金流 → 存库 → 返回
PATCH /api/policies/:id     → 更新保单 → 重新计算 → 存库 → 返回
```

### 3.2 服务端处理流程

```
1. 保存/更新 policy
2. 匹配 coverageIndicators（现有逻辑）
3. 匹配 cashflowTemplate（从 knowledge_records 按 company+productName 查）
4. computePolicyCashflow(policy, template, indicators)
5. 删除该 policy 旧的 policy_cashflows 行
6. 批量插入新的 policy_cashflows 行
7. 返回 policy（附带 cashflowEntries + scenarioEntries + totalCashflow）
```

### 3.3 API 响应格式

```json
{
  "ok": true,
  "policies": [{
    "id": 500549,
    "name": "盛世恒盈年金保险",
    "coverageIndicators": [...],
    "cashflowEntries": [
      { "year": 2030, "age": 42, "amount": 1465, "cumulative": 1465, "liability": "生存保险金", "calcText": "基本保额 = 1,465元" }
    ],
    "scenarioEntries": [
      { "scenario": "疾病身故", "formula": "60,312 × 160%", "amount": 96499 }
    ],
    "totalCashflow": 173095
  }]
}
```

### 3.4 管理端点

```
POST /api/admin/cashflow/recompute   → 批量重算所有保单现金流
GET  /api/admin/cashflow/status      → 查看预计算状态
```

## Section 4: 前端变更

### 4.1 读取预计算结果

```typescript
function CashflowDetailPage({ member, policies, onBack }) {
  const memberPolicies = policies.filter(p => p.insured === member);
  
  const plans = memberPolicies.map(p => ({
    policyId: p.id,
    productName: p.name,
    company: p.company,
    insured: p.insured,
    insuredBirthday: p.insuredBirthday,
    effectiveDate: p.date,
    annualEntries: p.cashflowEntries || [],
    scenarioEntries: p.scenarioEntries || [],
    totalDeterministicCashflow: p.totalCashflow || 0,
    expired: false,
  }));
  
  const summaries = buildMemberAnnualSummaries(plans);
  // ...
}
```

### 4.2 保留的前端函数

| 函数 | 保留原因 |
|------|---------|
| `buildMemberAnnualSummaries` | 跨保单按年聚合，纯展示逻辑 |
| `fillCashflowYears` | 表格填充空年份，纯展示辅助 |

### 4.3 移除/迁移的代码

| 代码 | 去向 |
|------|------|
| `parseBenefitSection` / `splitResponsibilitySections` | → `server/cashflow-compute.mjs` |
| `resolveBenefitAmount` / `extractAgeList` / `parseChineseNumber` | → `server/cashflow-compute.mjs` |
| `synthesizeCashflowFromParams` / `synthesizeCashflowFromIndicatorsOnly` | → `server/cashflow-compute.mjs` |
| `expandCashflowIndicator` / `parseConditionYearRange` | → `server/cashflow-compute.mjs` |
| `buildScenarioEntries` / `resolveScenarioAmount` | → `server/cashflow-compute.mjs` |
| `buildPolicyCashflowPlans` | 前端不再调用 |

### 4.4 Policy 类型扩展

```typescript
export type Policy = {
  // ... 现有字段 ...
  cashflowEntries?: CashflowEntry[];
  scenarioEntries?: ScenarioEntry[];
  totalCashflow?: number;
};

export type CashflowEntry = {
  year: number;
  age: number;
  amount: number;
  cumulative: number;
  liability: string;
  calcText?: string;
};

export type ScenarioEntry = {
  scenario: string;
  formula: string;
  amount: number;
  condition?: string;
  calcText?: string;
};
```

## Section 5: 迁移策略

### 5.1 四阶段渐进迁移

**阶段1: 基础设施**
- 新建 `policy_cashflows` 表
- 创建 `server/cashflow-compute.mjs`（移植核心逻辑）
- 创建模板匹配函数
- 编写单元测试

**阶段2: 写入路径**
- 保单 scan/update 流程增加现金流计算+存库
- API 响应增加 `cashflowEntries` 字段
- 前端不受影响

**阶段3: 读取路径切换**
- 前端优先读 `cashflowEntries`
- 为空时回退到前端实时计算
- 两套逻辑并行

**阶段4: 补算 + 清理**
- 运行 `POST /api/admin/cashflow/recompute` 补算所有现存保单
- 验证所有保单都有预计算结果
- 移除前端回退逻辑和计算代码

### 5.2 兼容性保障

- 阶段 3 期间前端同时支持预计算和实时计算
- 无模板的产品走责任文本解析路径
- 老保单通过 recompute 批量补算
- 模板配置后调 recompute 即可刷新

## Section 6: 模板配置工作流

### 6.1 模板创建

模板由管理员在知识库管理时配置。一个产品的模板只配一次，所有投保该产品的保单共用。

存储位置：`knowledge_records` 表，按 `company + product_name` 匹配，在 `payload` JSON 中增加 `cashflowTemplate` 字段。

### 6.2 模板示例

**盛世恒盈年金保险（3 条规则）：**
```json
{
  "cashflowTemplate": {
    "version": 1,
    "rules": [
      {
        "liability": "生存保险金",
        "timing": { "type": "range", "start": { "policyYear": 5 }, "end": { "beforeEvent": "pensionStart" } },
        "amount": { "basis": "基本保额" }
      },
      {
        "liability": "养老年金",
        "timing": { "type": "range", "start": { "age": "{{领取起始年龄}}" }, "end": { "beforeEvent": "coverageEnd" } },
        "amount": { "basis": "基本保额" }
      },
      {
        "liability": "满期生存保险金",
        "timing": { "type": "maturity" },
        "amount": { "basis": "已交保费" }
      }
    ],
    "params": {
      "领取起始年龄": { "source": "indicator", "key": "领取起始年龄" }
    }
  }
}
```

**畅行万里两全保险（1 条规则）：**
```json
{
  "cashflowTemplate": {
    "version": 1,
    "rules": [
      {
        "liability": "满期生存保险金",
        "timing": { "type": "maturity" },
        "amount": { "basis": "已交保费" }
      }
    ]
  }
}
```

**安鑫优选终身护理保险（无定期现金流）：**
```json
{
  "cashflowTemplate": { "version": 1, "rules": [] }
}
```

### 6.3 模板更新流程

```
1. 管理员修改产品的 cashflowTemplate
2. 调用 POST /api/admin/cashflow/recompute?product=盛世恒盈年金
3. 服务端重新计算该产品所有保单的现金流
4. 返回更新数量
```
