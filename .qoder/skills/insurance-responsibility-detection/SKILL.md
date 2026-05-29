---
name: insurance-responsibility-detection
description: Use for OCR_insurance tasks that need to identify, validate, audit, or repair extracted insurance responsibility text in local knowledgeRecords or Feishu Base tables, including completeness checks for savings, participating, annuity, and increasing whole life products.
---

# Insurance Responsibility Detection

Use this skill when checking whether `保险责任正文` is the real insurance responsibility text, whether it is complete enough to use, and whether a row needs official-source re-extraction.

## Core Judgment

`保险责任` is the clause text that states what the insurer must pay, reimburse, waive, or otherwise perform when contractual trigger conditions are met.

Judge every row on three axes:

1. `is_responsibility`: does the text contain insurer payment, reimbursement, waiver, or benefit obligations.
2. `is_complete`: does it include all major benefit items expected for that product/material, not just a tail fragment.
3. `needs_reextract`: should the row be re-read from the official PDF/page before any correction.

Use these statuses:

- `valid_complete`: real responsibility text and appears complete.
- `valid_partial`: real responsibility text, but likely starts/ends mid-section or misses major benefit items.
- `invalid_empty`: blank, `null`, placeholder, or extraction failure.
- `invalid_non_responsibility`:目录, 责任免除, product intro, fee table, benefit illustration, dividend/account rules only, or unrelated text.
- `suspect_needs_source_check`: enough signal to be suspicious, but not enough to mark wrong without checking the official source.

## Included Responsibilities

Insurance responsibility includes both protection and savings-style life products:

- Death, total disability, disability, disease, critical illness, accident, medical expense, hospitalization, nursing, and liability benefits.
- Survival benefit, annuity, pension, education benefit, maturity benefit, birthday/longevity benefit, and similar scheduled benefit payments.
- Premium waiver responsibilities tied to agreed events.
- For participating products, the guaranteed insurance benefits such as death, total disability, survival, annuity, or maturity benefits.
- For increasing whole life products, death or total disability benefit formulas that reference effective sum insured, cash value, or paid premium ratios.

## Keep Separate

Do not treat these as insurance responsibility by themselves:

- `责任免除`, exclusions, waiting period, grace period, reinstatement, claims documents, notification duties, policyholder obligations, or dispute handling.
- Product highlights, sales copy, filing information, company profile, application rules, eligibility, premium rate tables, payment-period descriptions, or benefit illustrations.
- Dividend allocation, terminal dividend, dividend options, universal-account value, settlement interest rate, investment-account value, surrender value, policy loan, reduction/partial withdrawal, or cash-value table.
- `有效保险金额递增` or cash-value growth rules alone. They are benefit/interest rules; they support calculation but are not a standalone insurance responsibility unless tied to a concrete payment trigger.
- Section headers only,目录 only, or text that merely says `已截取保险责任正文段` without benefit rules.
- The literal string `null`, `undefined`, OCR garbage, or one-character fragments such as `想·`.

## Product-Specific Guidance

For `分红型` products:

- Accept death, total disability, survival, annuity, maturity, or waiver benefit clauses as insurance responsibility.
- Mark dividend text as separate `保单利益/收益规则`, not bad if it appears after real responsibilities, but bad if the extracted field only contains dividend rules.
- Do not require the dividend rules to be present inside `保险责任正文`.

For `增额终身寿` products:

- Accept clauses like `身故保险金`, `全残保险金`, and formulas comparing effective sum insured, cash value, and paid premiums.
- Do not require disease/accident wording. These products often have no medical responsibility.
- Treat pure effective-sum-insured growth, cash-value schedule, reduction, loan, or surrender text as not enough by itself.

For annuity, pension, education, and endowment products:

- Accept scheduled payment responsibilities triggered by survival to agreed dates, ages, policy anniversaries, maturity, or pension-start dates.
- Do not mark them bad just because there is no illness or accident trigger.
- Expected benefit names often include `关爱年金`, `生存保险金`, `满期保险金`, `祝寿金`, `养老金`, `教育金`, `身故或全残保险金`, and `豁免保险费`.

## Material-Aware Rules

For official `条款`:

- Prefer the real `保险责任` / `保险金给付` section through the next major heading such as `责任免除`.
- A table of contents that only lists `保险责任 ... 2.3` is not responsibility text.

For official `产品说明书`:

- A section named `本保险提供的利益保障`, `利益保障`, or similar can be accepted if it lists concrete benefit items and payment rules.
- Mark as `valid_partial` when it only contains the end of the benefit list, a sentence like `上述 1-4 条为基本责任`, or a tail fragment such as `保险责任继续有效` without the preceding items.
- Do not mix the later `保险利益演示`, `红利及红利分配`, or `现金价值/退保` sections into `保险责任正文`.

## Completeness Checks

Mark `valid_partial` instead of `valid_complete` when:

- The text starts mid-sentence or with continuation wording: `保险责任继续有效`, `上述`, `该保险金`, `本项责任`, `前述`, `同时`, `此外`.
- The text references missing numbered items, for example `上述 1-4 条为基本责任`, and the extracted text does not contain the corresponding major benefit items.
- A product name implies major savings benefits, but the text only contains one tail benefit, such as only `祝寿金` or only `身故或全残`.
- A product manual's first benefit section in the source includes multiple items, but the extracted row contains only the last item or only explanatory text.

Do not mark a row partial solely because a complete responsibility section later uses wording such as `上述责任`, `上述比例`, or `前述保险金`. If the text starts at `保险责任` / `本公司承担下列保险责任` and includes concrete major benefits such as `养老年金`, `生存保险金`, `满期保险金`, `身故保险金`, `全残保险金`, or `豁免保险费`, keep it `valid_complete` unless another defect is present.

Example: `尊享人生年金保险（分红型）` should include `关爱年金`, `生存保险金`, `身故或身体全残保险金`, `投保人意外伤害身故或意外伤害身体全残豁免保险费`, and optional `祝寿金`. If the row only starts at `保险责任继续有效` and contains the `祝寿金` tail, classify it as `valid_partial`, not `invalid_non_responsibility`.

## Audit Heuristics

High-confidence invalid:

- Blank text, whitespace-only text, literal `null` / `undefined`, or placeholders such as `未抽取保险责任正文`, `未提取保险责任正文`, `暂无保险责任正文`, `PDF不可用`, `官网有资料标记`.
- Text dominated by product introduction, company disclosures, rate tables, coverage examples, claims materials, exclusions, or policy benefits without any insurer payment trigger.
- Only field names, title fragments, table-of-contents entries, or unrelated website/navigation text.

Medium-confidence suspect:

- Text has a responsibility-like heading but no concrete payment rule or trigger.
- Text contains only dividend/account/cash-value/effective-amount rules.
- Text is extremely short and lacks benefit names such as `保险金`, `给付`, `赔付`, `报销`, `豁免`, `年金`, `生存`, `满期`, `身故`, or `全残`.

Usually valid:

- Text includes a benefit name plus a trigger and payment rule.
- Text starts mid-clause but still clearly describes insurer benefit payment.
- Text contains `责任免除` or policy-benefit content after the real responsibility section; flag only if the responsibility content is missing or overwhelmed.

Usually incomplete:

- Text is responsibility-like but missing earlier benefit items.
- Text names only one optional benefit while the same section says other basic responsibilities exist.
- Text has benefit formulas but lacks all expected triggers for the product type.

## Feishu Audit Workflow

1. Load Feishu table configs from `.runtime/feishu-knowledge*.json`.
2. Read only these fields: `本地ID`, `保险公司`, `产品名称`, `资料类型`, `标题`, `来源链接`, `保险责任正文`, `质量状态`, `质量问题`.
3. Do not trust stale local config names. If a config says `保险资料` but points to a known insurer table ID, report the actual table/insurer from row contents or table lookup.
4. Use `lark-cli base +record-list` or `+record-search` page by page. Do not call update/create/delete commands unless the user explicitly asks to repair.
5. Classify each row as `valid_complete`, `valid_partial`, `invalid_empty`, `invalid_non_responsibility`, or `suspect_needs_source_check`.
6. For exact product questions, search the product name first, then verify against the official PDF/page before declaring correctness.
7. Report bad rows grouped by insurer/table with row id, product name, status, reason, and a short excerpt.
8. Keep local `knowledgeRecords`, Feishu knowledge rows, and catalog tables distinct. If only Feishu is bad, do not assume local data is bad.

## Repair Guidance

Only repair after the user explicitly asks.

- For `invalid_empty` or `valid_partial`, re-open the official `来源链接` and extract from the real responsibility/benefit section.
- Preserve product-type truth: do not replace annuity, participating, or increasing whole-life responsibilities with disease/accident-only expectations.
- Store only the responsibility section in `保险责任正文`; keep dividends, cash value, benefit illustrations, policy loans, surrender rules, and account rules outside this field.
