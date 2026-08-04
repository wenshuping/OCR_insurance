---
name: ocr-insurance-participating-annuity-semantic-audit
description: 审计分红型年金/寿险的原子指标，识别“保单周年日保险金额”被错误降级为初始基本保额、遗漏已分配红利、重复原子指标或卡片投影失配；用于全库只读扫描和逐产品受控修复。
---

# 分红年金责任语义审计与受控修复

## 用途与边界

用于分红型年金、两全及终身寿险的责任指标审计，特别是条款使用“该保单生效对应日基本责任保险金额”或“该保单生效对应日可选责任保险金额”时。

此类金额是**该保单周年日的责任保险金额**。对于增额分红，已确定且已增加的年度红利保险金额会构成该日金额的一部分；未来红利不保证，不能预先写成固定金额。它绝不能被运行时降级为投保时的初始基本保额。

默认模式是离线、只读审计。不得在 API 请求、应用启动、常规导入或未取得官方来源的情况下自动修改数据库。所有数据库写入必须明确指向开发 SSD：

`/Users/wenshuping/OCR_insurance_ssd/.runtime/local/policy-ocr.sqlite`

生产库需要用户单独授权与指定 profile。

## 先做全库只读扫描

在归档源码工作树执行；不要从旧 worktree SQLite 或生产数据库读取。

```bash
node .agents/skills/ocr-insurance-participating-annuity-semantic-audit/scripts/audit-participating-annuity-semantics.mjs \
  --db /Users/wenshuping/OCR_insurance_ssd/.runtime/local/policy-ocr.sqlite \
  --output /tmp/participating-annuity-semantic-audit.json \
  --manifest-dir /tmp/participating-annuity-semantic-manifests
```

可以先按产品验证规则：

```bash
node .agents/skills/ocr-insurance-participating-annuity-semantic-audit/scripts/audit-participating-annuity-semantics.mjs \
  --db /Users/wenshuping/OCR_insurance_ssd/.runtime/local/policy-ocr.sqlite \
  --company 新华保险 \
  --product-name '尊享人生年金保险（分红型）'
```

脚本以只读方式打开 SQLite。输出包含 SHA-256、范围、逐产品问题和修复建议；`indicator_definitions` 仅作为全局模板库存量信息，不能作为某一保单条款的事实来源。
同时生成 `true-positive`、`false-positive-audit`、`source-review`、`version-conflict`、`materializer-blocked` 和 `import-pending` 队列；产品数与 issue 数分开统计。
候选入口先取产品名/责任卡类别中明确的“分红/红利”身份，再用同一责任的 indicator、artifact 和客户投影证据判定；不能因为 sourceExcerpt 的其他责任出现“周年日”就扩大候选或判错。报告另生成互斥的产品级 `confirmed_repair`、`already_correct`、`source_review`、`version_conflict`、`materializer_blocked`、`incremental_whole_life_special_lane` 队列及 `terminal-receipt.json`。

## 问题码与判定

| 问题码 | 触发条件 | 正确处理 |
| --- | --- | --- |
| `ANNIVERSARY_BASIC_AMOUNT_COLLAPSED` | 原文/公式有“保单生效对应日基本责任保险金额”，但 `basisKey` 是 `basic_amount` 等静态保额，或仍被标为可直接计算 | 改为 `policy_anniversary_basic_amount`；设 `calculationKey=schedule_or_policy_table`、`calculationEligible=false`，要求保单年度/金额变更表。 |
| `ANNIVERSARY_OPTIONAL_AMOUNT_COLLAPSED` | 原文有“保单生效对应日可选责任保险金额”，却被降级为静态基本保额或直接计算 | 保留动态周年日语义，使用表格/保单信息门禁；可选责任还须保留客户选择状态。 |
| `PARTICIPATING_SOURCE_NOT_ARTIFACT_BACKED` | 分红或红利文字与周年日责任共存，但没有获批官方责任 artifact / source digest | 先获取同版官方条款，建立 artifact，不得从全局模板库推断红利。 |
| `DUPLICATE_ATOMIC_INDICATOR` | 同产品、同责任、同公式、同条件、同口径的原子指标重复 | 保留有官方证据且版本正确的一条；不要把不同年龄/保单年度阶段误判成重复。 |
| `REPEATED_FORMULA_PREFIX` | 公式被串接成 `责任 = 责任 = …` | 回到官方原文，重建单一公式及条件。 |
| `CARD_INDICATOR_PROJECTION_MISMATCH` | 责任卡嵌套原子指标与原子指标表的基数、计算键或可计算性不一致 | 先修 artifact/原子指标，再物化卡片；禁止卡片层覆盖原子指标语义。 |
| `DIVIDEND_COMPONENT_LOST` | 同一责任官方证据明确“基本/有效保险金额 + 累积红利保险金额”，但 indicator/card/customer projection 丢失红利组成 | 进入 confirmed_repair 或 source_review；不推算未来红利。 |

`ANNIVERSARY_BASIC_AMOUNT_COLLAPSED`、`ANNIVERSARY_OPTIONAL_AMOUNT_COLLAPSED` 只有在同一责任的连续名词短语明确周年日动态金额时触发；“周年日触发但按静态基本保额给付”记录为 `legitimate_static_amount`，不修复。

## 受控修复流程

对每个扫描命中的产品逐一执行，不能批量直接写库：

1. 锁定同版本官方条款，记录 URL、页码、摘录和 `sourceDigest`；分红定义与保险责任必须来自同一版本或有明确版本关系。
2. 拆出原子指标。把“责任名称”“条件/阶段”“计算基数”“比例”“频率”“是否已选/已分配”分开。年度红利是已分配后的动态基数的一部分，不能当作固定预测值。
3. 对每个指标写出公式和状态：

   ```text
   生存保险金（某保单年度）
   = 该保单生效对应日基本责任保险金额 × 9%

   basisKey: policy_anniversary_basic_amount
   calculationKey: schedule_or_policy_table
   calculationEligible: false
   requiredInputs: policyScheduleTable, policyYearOrAge
   ```

4. 使用现有 `ocr-insurance-single-product-responsibility-review`、`ocr-insurance-responsibility-merge` 和 `import-reviewed-responsibility-artifacts.mjs` 生成 artifact；先针对**实际 SSD 目标** dry-run，必须 `ok=true` 且 `validationIssueCount=0`。
5. 在总门禁为 `BLOCKED` 时只做临时 clone canary，并把候选写入 `import-pending`；不得写真实 SSD。只有协调器明确总门禁为 `PASS` 后，才能停止开发服务、确认唯一 writer、备份实际目标库并记录 SHA-256，再按最多20产品事务单元串行写入。
6. 回读 artifact → responsibility card → `insurance_indicator_records`，确认动态基数没有被卡片或运行时投影改回 `basic_amount`；执行 `PRAGMA foreign_key_check` 与 `PRAGMA quick_check`。
7. 将受影响保单的派生结果标记为 stale，等待显式重算；不得把旧的初始保额现金流继续展示为正确结果。

## 禁止事项

- 不得以 `indicator_definitions` 的通用公式替代该产品官方条款。
- 不得把“含已确定的年度红利”换算为未来固定红利金额。
- 不得把两段不同年龄、不同周年日频率的生存金合并为一条原子指标。
- 不得让运行时兜底把动态周年日基数取为初始基本保额。
- 不得在没有备份、dry-run、版本来源和语义回读的情况下写 SSD 库。
