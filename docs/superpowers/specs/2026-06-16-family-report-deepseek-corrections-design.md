# Family Report DeepSeek Corrections Design

## Context

Family保障报告现在先由代码生成并落库，再调用 DeepSeek 做质检。DeepSeek 返回的问题已经会进入后台“报告问题”，但这些问题不会反向影响家庭报告计算。因此当 DeepSeek 判断“每日床位费 20 元不应作为固定医疗保额”“报销型医疗无法量化为固定保额”时，客户报告仍可能展示原始代码计算结果。

本设计把 DeepSeek 从“只发现问题”升级为“提出结构化修正建议”，但最终报告仍由代码负责 schema、金额计算、校验和展示。选定策略是：高置信、低风险修正自动应用；低置信或高影响修正进入后台人工确认。

## Goals

- DeepSeek 返回可机器读取的修正建议，而不只是自然语言问题描述。
- 代码校验修正建议后，将可采纳修正落库。
- 高置信、低风险修正自动应用到本次和后续家庭报告。
- 低置信或高影响修正进入后台“报告问题”待确认。
- 最终家庭报告仍使用现有格式展示，不展示纠错细节。
- 后台可看到问题、修正建议、状态、修正前后值和原因。
- 后台每条 DeepSeek 问题都要标注处理结果：已修正、待确认、未修正及未修正原因。
- 原始 OCR 保单数据保持不变，所有修正可追溯、可撤回。

## Non-Goals

- 不让 DeepSeek 直接生成最终客户报告。
- 不让 DeepSeek 直接改写原始保单、OCR 结果或官网知识库。
- 不在客户报告里展示“DeepSeek 说了什么”。
- 第一版不自动新增大额保额，不自动重算复杂寿险、重疾多次给付、分红、万能账户收益。
- 第一版不做历史所有报告批量重算；只影响新生成报告和管理员确认后重新生成的报告。

## Current State

Current flow:

1. `server/routes/families.routes.mjs` 调用 `buildFamilyReport` 生成报告。
2. `createFamilyReportRecord` 将报告和代码规则问题写入 `familyReports` / `familyReportIssues`。
3. `appendDeepSeekReportIssues` 调用 `generateFamilyReportQualityIssues`。
4. DeepSeek 的质检结果只通过 `appendFamilyReportIssues` 追加到 `familyReportIssues`。
5. 报告记录本身不会被 DeepSeek 结果修正。

这个结构安全，但无法修复截图中的金额误算。

## Proposed Architecture

新增一个受控修正层：`familyReportCorrections`。

DeepSeek 输出两类结构化结果：

- `issues`: 后台问题，用于人工复核和问题列表。
- `corrections`: 报告计算修正建议，用于代码校验和应用。

代码新增一个修正服务，负责：

1. 校验 DeepSeek 返回的 correction 是否引用真实 `familyId`、`reportId`、`policyId`、`memberId`。
2. 判断 action 是否在允许列表中。
3. 根据风险和置信度决定 `auto_applied` 还是 `pending_review`。
4. 将修正落库。
5. 重新用已应用修正生成最终报告记录。

最终数据流:

1. 代码初算报告。
2. DeepSeek 基于“保单基本信息 + 官网条款 + 初算报告”返回问题和修正建议。
3. 代码校验修正建议。
4. 自动应用高置信、低风险修正。
5. 代码带修正重新生成最终报告。
6. 报告、问题、修正全部落库。

Every DeepSeek issue must also receive a backend processing label. If a correction is applied, the issue is labeled as corrected. If a correction is not applied, the issue is labeled with a specific non-applied reason, such as low confidence, high risk, unsupported action, missing policy mapping, or evidence gap.

## Correction Data Model

新增状态数组和 SQLite 表：`familyReportCorrections` / `family_report_corrections`。

Core fields:

```ts
type FamilyReportCorrection = {
  id: number;
  reportId: number;
  familyId: number;
  ownerUserId: number | null;
  ownerGuestId: string;
  policyId: number | null;
  memberId: number | null;
  dimension: 'critical' | 'accident' | 'medical' | 'life' | 'wealth' | 'other';
  action: 'exclude_amount' | 'mark_unquantifiable' | 'replace_amount' | 'change_dimension';
  targetPath: string;
  originalValue: unknown;
  correctedValue: unknown;
  reason: string;
  evidence: string;
  confidence: number | null;
  riskLevel: 'low' | 'medium' | 'high';
  status: 'auto_applied' | 'pending_review' | 'accepted' | 'rejected' | 'archived';
  source: 'deepseek' | 'admin';
  issueId: number | null;
  model: string;
  createdAt: string;
  updatedAt: string;
};
```

`targetPath` is a stable logical path, not a JavaScript eval path. Examples:

- `radar.medical.policyAmount`
- `inventory.policy.coverageIndicators`
- `memberRadar.medical`

The correction table stores JSON payloads for `originalValue` and `correctedValue`, following the existing SQLite payload pattern used elsewhere in the project.

DeepSeek issue rows should also expose correction metadata in the backend API. This can be persisted on the issue row or derived from linked correction rows, but the API contract must return it explicitly:

```ts
type ReportIssueCorrectionState = {
  correctionStatus:
    | 'corrected'
    | 'pending_review'
    | 'not_corrected'
    | 'rejected'
    | 'not_applicable';
  correctionLabel: string;
  correctionReason: string;
  correctionId: number | null;
};
```

Example labels:

- `已自动修正`
- `待人工确认`
- `已人工采纳`
- `未修正：置信度不足`
- `未修正：高风险金额替换`
- `未修正：未定位到保单`
- `未修正：动作暂不支持`
- `未修正：仅提示，不影响报告计算`

## Supported Actions

First version supports four actions:

- `exclude_amount`: exclude a specific amount contribution from a dimension calculation.
- `mark_unquantifiable`: keep the responsibility visible as coverage evidence, but do not show it as a fixed amount.
- `replace_amount`: replace a dimension amount only when evidence is exact and low risk.
- `change_dimension`: move a contribution to another dimension only when the original category is clearly wrong.

First version auto-applies only:

- `exclude_amount`
- `mark_unquantifiable`

`replace_amount` and `change_dimension` default to `pending_review`, except later versions can widen this after enough test coverage and production examples.

## Auto-Apply Rules

A correction is auto-applied only when all conditions pass:

- `confidence >= 0.85`.
- `riskLevel === 'low'`.
- action is `exclude_amount` or `mark_unquantifiable`.
- correction references a real policy and, when provided, a real member in the family.
- correction dimension is one of the known report dimensions.
- correction evidence is present.
- corrected result cannot increase any displayed insurance amount.

Typical auto-applied cases:

- 报销型医疗责任被错误展示为固定保额。
- 住院津贴、床位费、日额、月额、免赔额被错误当成医疗总保额。
- 官网证据只支持“报销型/限额型/无法量化”，不支持固定数字。

Typical pending-review cases:

- 寿险保额从 0 修正为较大金额。
- 重疾首次给付、癌症额外给付、多次给付之间需要拆分。
- 财富、现金价值、分红、万能账户金额修正。
- DeepSeek 只指出问题但没有明确 policy/member/dimension。
- confidence is below 0.85.

## Report Generation Flow

`POST /api/family-profiles/:id/report` should become a two-pass workflow when DeepSeek is enabled:

1. Attach policy responsibility, indicator, cashflow, and cash value data as today.
2. Build an initial report with existing `buildFamilyReport`.
3. Persist a draft-like report record or keep the initial report in memory until corrections are resolved.
4. Call DeepSeek quality service.
5. Normalize issues and corrections.
6. Persist issues and correction rows.
7. Apply `auto_applied` and previously `accepted` corrections.
8. Rebuild the report with the correction context.
9. Persist the final active report.

If DeepSeek is disabled or fails, the system keeps the current behavior: code-generated report is returned and an optional backend issue records the failure.

Accepted corrections from older reports for the same family/policy should be reusable in future reports while the underlying policy remains active. When a family member or policy changes, existing report records, issues, and corrections for that family are archived with the same invalidation behavior used for reports and issues.

## Applying Corrections

The family report engine should stay deterministic. It receives an optional correction context:

```ts
buildFamilyReport(policies, planningProfile, {
  familyId,
  corrections,
});
```

The engine applies only trusted corrections:

- `auto_applied`
- `accepted`

Corrections alter calculation contributions, not arbitrary final JSON. For example:

- A medical indicator contribution can be excluded from `radar.medical`.
- A contribution can be marked unquantifiable so UI can show a textual note instead of a fixed amount.
- The original policy and indicator remain visible in inventory and evidence sections.

This keeps schema generation, totals, summaries, and front-end formatting under code control.

## Admin UX

The existing “报告问题” menu remains the entry point.

List rows should expose:

- report id and family
- issue count
- correction count
- auto-applied count
- pending-review count
- latest status

Detail page should show:

- DeepSeek issue text.
- issue processing label: corrected, pending review, or not corrected.
- Linked correction recommendation.
- action, dimension, policy, member.
- original value and corrected value.
- confidence and risk level.
- non-applied reason when no correction was applied.
- status.
- buttons for pending corrections: accept, reject.

Accepting a correction marks it `accepted` and regenerates the active report for the family. Rejecting it marks it `rejected` and leaves the report unchanged. Auto-applied corrections are read-only in the first version.

For issues without applied corrections, the backend must still show a clear label. Examples:

- DeepSeek identified a medical amount problem and the system auto-applied `mark_unquantifiable`: show `已自动修正`.
- DeepSeek suggested a life amount replacement but it is high risk: show `待人工确认` or `未修正：高风险金额替换`, depending on whether a reviewable correction row exists.
- DeepSeek only raised an evidence warning and no calculation change is possible: show `未修正：仅提示，不影响报告计算`.
- DeepSeek correction cannot map to a policy/member: show `未修正：未定位到保单`.

## DeepSeek Response Contract

DeepSeek prompt should require JSON:

```json
{
  "issues": [
    {
      "severity": "error",
      "category": "amount_calculation",
      "title": "意外医疗保障金额计算错误",
      "detail": "后台复核说明",
      "suggestion": "处理建议",
      "memberRef": "member_1",
      "policyRef": "policy_1",
      "dimension": "medical",
      "confidence": 0.91
    }
  ],
  "corrections": [
    {
      "issueIndex": 0,
      "action": "mark_unquantifiable",
      "targetPath": "radar.medical.policyAmount",
      "originalValue": 60,
      "correctedValue": null,
      "reason": "该责任为报销型或日额型，不应展示为固定医疗保额。",
      "evidence": "官网条款仅支持每日床位费 20 元或按实际费用报销。",
      "memberRef": "member_1",
      "policyRef": "policy_1",
      "dimension": "medical",
      "riskLevel": "low",
      "confidence": 0.91
    }
  ]
}
```

Server-side normalization maps `memberRef` and `policyRef` back to internal ids. If a correction cannot be mapped, it is stored as a problem but not applied.

## Error Handling

- No DeepSeek key: skip corrections and keep code report.
- DeepSeek timeout or upstream error: keep code report and add `deepseek_quality_failed` issue.
- Invalid JSON: keep code report and add backend issue.
- Correction validation failure: store the issue and store the correction as `pending_review` only if it has enough context; otherwise drop the correction and keep the issue.
- Every failure path must still assign an issue correction label, usually `未修正：未定位到保单`, `未修正：动作暂不支持`, or `未修正：仅提示，不影响报告计算`.
- Applying correction throws: mark correction `pending_review`, keep code report, and record a backend issue.

The customer report endpoint should still return a report even when DeepSeek correction fails.

## Persistence and Bundles

SQLite state must include:

- `family_report_corrections` table.
- state load/save support.
- archive support when family, member, or policy changes.
- production data bundle inclusion.

Routes should use focused persistence methods instead of full-state persistence, matching the harness rules.

## Testing

Focused tests should cover:

- DeepSeek correction response parsing and validation.
- Every DeepSeek issue returns a backend correction label, including issues with no applied correction.
- Auto-apply threshold behavior.
- Low-risk medical `mark_unquantifiable` removes fixed amount from report totals.
- Pending-review high-risk `replace_amount` does not change customer report until accepted.
- Admin accept regenerates report with accepted correction.
- Admin reject does not change report.
- SQLite round-trip for correction rows.
- Production bundle includes correction rows.
- DeepSeek failure keeps current code-generated report behavior.

Required verification for implementation:

- `npm run check`
- `npm run typecheck`
- `npm test`
- `npm run build`

## Rollout

The first implementation should handle the screenshot class of issues:

- medical fixed amount false positives
- reimbursement medical amount marked unquantifiable
- daily allowance/bed fee not counted as total medical coverage

After this is stable, later iterations can expand to:

- critical illness first-payment splitting
- life amount replacement with stronger official evidence
- wealth/cashflow correction suggestions
- bulk regeneration for accepted historical corrections

## Success Criteria

- For 吴连英-style medical issues, DeepSeek can return a low-risk correction and the final family report no longer displays the daily bed fee or reimbursement marker as fixed medical coverage.
- Backend report issues still show the original problem and the correction that was applied or queued.
- Backend report issues explicitly label both corrected and not-corrected DeepSeek findings.
- High-risk corrections are not auto-applied.
- All reports, issues, and corrections are persisted and survive restart.
- Customer-facing report format stays stable.
