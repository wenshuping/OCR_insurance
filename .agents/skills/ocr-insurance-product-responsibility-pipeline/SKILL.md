---
name: ocr-insurance-product-responsibility-pipeline
description: "Generate a complete, auditable OCR_insurance product result in one run from exact-version official sources or multi-image customer-uploaded responsibility pages: product overview, insurance responsibility content, one customer card per concrete responsibility, quantitative indicators, responsibility-to-indicator mappings, optional-selection handling, replaceable DeepSeek/Gemini extraction, and deterministic review gates. Use whenever a user asks to create, repair, compare, review, backfill, upload, or publish one product's responsibilities, responsibility cards, or indicators."
---

# Insurance Product Responsibility Pipeline

Run one entry point to produce a qualified product overview, complete responsibility inventory, customer cards, quantitative indicators, and exact responsibility-to-indicator mappings.

## High-Throughput Model Backend

Keep `scripts/batch_deepseek_backfill.py` as the compatibility entry point for
existing batch jobs. Its extraction backend is replaceable:

```bash
# Existing DeepSeek fast path
python3 scripts/batch_deepseek_backfill.py \
  --provider=deepseek --model=deepseek-v4-flash \
  --manifest="$MANIFEST" --output-dir="$RUN_DIR" --workers=4 --parse-only

# New batch, same deterministic pipeline, Gemini extraction
python3 scripts/batch_deepseek_backfill.py \
  --provider=gemini --model=gemini-flash-latest \
  --manifest="$MANIFEST" --output-dir="$RUN_DIR" --workers=4 --parse-only
```

The generic role variables
`RESPONSIBILITY_PARSE_API_KEY`, `RESPONSIBILITY_PARSE_BASE_URL`, and
`RESPONSIBILITY_PARSE_MODEL` override provider variables. Otherwise use
`DEEPSEEK_*` for DeepSeek and `GEMINI_*` (or `GOOGLE_API_KEY`) for Gemini.
An arbitrary OpenAI-compatible endpoint may use
`--provider=openai-compatible`, `--base-url`, and `--model`.

An optional local or private OpenAI-compatible model may run as a non-authoritative
formula and risk-signal shadow beside DeepSeek or Gemini:

```bash
python3 scripts/batch_deepseek_backfill.py \
  --provider=gemini --model=gemini-flash-latest \
  --manifest="$MANIFEST" --output-dir="$RUN_DIR" --workers=2 --parse-only \
  --shadow-base-url=http://127.0.0.1:18080/v1 \
  --shadow-model=DianJin-R1-32B \
  --shadow-routing=auto \
  --shadow-timeout-ms=45000 --shadow-max-tokens=1024 \
  --shadow-max-input-chars=10000
```

The shadow call uses JSON Schema structured output and writes
`shadow-receipt.json`, `shadow-raw.txt`, `shadow-unvalidated.json`, and the
deterministically filtered `shadow.json` inside each product directory. Risk
signals require source anchors, and numeric tokens must contain a number or
percentage and occur in source text. It never writes the artifact or database, never replaces locked
responsibility inventory, and never blocks approval when unavailable or late.
With `--shadow-routing=auto`, only products with deterministic complexity
signals such as multiple age or policy-year boundaries, multiple percentages,
max/min formulas, tables, optional packages, or mutual exclusion call the
shadow model. Completed shadow results are compared with accepted artifact
formula branch counts and numeric tokens. Material conflicts are written to
`high-capability-review.jsonl`; aligned products do not call a reviewer.

For every material conflict, write
`high-capability-review-packet.json` containing only the conflicting
responsibility, its validated artifact fields, the validated shadow proposal,
and the smallest available official source window. A configured
`gpt-5.6-luna` reviewer consumes this packet, never the complete document.
Require exactly one structured decision per packet item:

- `keep_artifact` when official evidence supports the validated artifact;
- `repair_artifact` when official evidence supports a missing or incorrect
  branch/token and names the exact required repair;
- `source_repair_required` when the packet lacks readable or complete evidence.

The reviewer may not write SQLite, rewrite aligned responsibilities, invent
source excerpts, or decide by model consensus. Apply any repair through the
normal canonicalizer and validator, and publish only after those deterministic
gates pass again. Before accepting reviewer output, require one decision per
packet item, allowed decision values only, matching responsibility IDs, and
every `officialEvidence` excerpt to be an exact substring of the packet's
official evidence scope.
When a fallback contains the complete long document, the shadow packet starts
at the responsibility section and is bounded by `--shadow-max-input-chars`;
record `inputTruncated` in the receipt.
Treat model-generated waiting periods, exclusions, group headings, and extra
titles as untrusted proposals. Only stable responsibilities already accepted by
deterministic inventory may receive formula or risk-signal assistance.

Never automatically move a whole failed batch to another paid provider. The
runner writes `model-retry.jsonl`, `source-retry.jsonl`, and
`validation-review.jsonl`. After correcting billing, permission, or quota, rerun
only model failures in the same output directory:

```bash
python3 scripts/batch_deepseek_backfill.py \
  --provider=gemini --model=gemini-flash-latest \
  --manifest="$MANIFEST" --output-dir="$RUN_DIR" \
  --retry-failure-layer=model --workers=4 --parse-only
```

Existing `approved`, `published`, and `skipped` product results are never
reparsed. HTTP 402, 401/403, 429, and 5xx model failures must remain distinct
from official-source acquisition failures in result metadata and completion
counts.

## Source Modes

Choose exactly one mode before execution:

- `official_exact_version`: use the official-source workflow and deterministic scripts below. A passing artifact may be published to the development database when the task requests generation/backfill/publication.
- `customer_ocr_upload`: accept 1-5 customer-uploaded insurance responsibility images, OCR every image separately, preserve the original images and page-by-page OCR text, and run the same inventory/card/indicator semantics against only that OCR evidence. This mode is never official evidence and never auto-publishes.

For `customer_ocr_upload`:

1. Assign stable page numbers in upload order and retain `{pageNumber, name, ocrText}` for every image.
2. Remove customer identifiers before model processing, but retain complete non-private responsibility prose rather than keyword-only lines.
3. Every `sourceExcerpt` must be an exact substring of its cited OCR page after NFKC/whitespace normalization. Never silently move an excerpt to a different page.
4. Run deterministic structural normalization to a fixed point, with a hard maximum of three passes.
5. Run model repair at most three times, passing the complete deterministic issue list into each next attempt. Never delete a real responsibility merely to make validation pass.
6. A passing result is `pending_review`, not `approved`. Store the artifact, original images, per-page OCR, attempt count, normalization count, and validation receipt in the private customer knowledge record.
7. After three failed attempts, store `manual_review` and the remaining issue list. Do not create public cards or indicators.
8. Only an operations approval may publish cards and indicators as `customer_policy_terms`. Mark them `official: false` and `reviewedCustomerUpload: true`.
9. A rollback removes only card/indicator IDs published from that customer record, changes it back to pending, and preserves original images, OCR pages, edited text, and the artifact.

The production runtime adapter is `server/customer-upload-responsibility-pipeline.service.mjs`; agent/offline execution and production upload execution must obey the same responsibility, card, indicator, evidence, retry, and review rules.

## Non-Negotiable Execution Contract

The numbered contract in this section applies to `official_exact_version`. For `customer_ocr_upload`, follow the equally non-negotiable upload contract in `Source Modes`; it ends at operations review and must not claim official approval.

Reading this file or producing a plausible prose answer is not execution. Complete every step below in order:

1. Read this file and all four internal stage skills completely.
2. Establish the exact-version official clause source on an insurer-owned or regulator-owned domain. A distributor, bank, aggregator, or reposted PDF is not primary evidence. A product brochure may supplement the overview but must not replace the clause source for responsibilities, package boundaries, formulas, or exclusions.
3. Materialize the unified artifact as a real UTF-8 JSON file and report its absolute path.
4. Resolve `PIPELINE_SKILL_DIR` to the absolute directory containing this selected `SKILL.md`. Never invoke a validator found by skill name, current working directory, or another checkout.
5. Save the downloaded official source document unchanged and extract its complete text to a UTF-8 text file. For model-assisted batch generation, run `scripts/extract_responsibility_candidates.py` to create the first-pass candidate pages and retrieval report. Retrieval may reduce context but may not decide that a responsibility is absent. Run `scripts/canonicalize_excerpts.py` after every model result. The script normalizes to a fixed point: it repeats until the artifact no longer changes, with a hard limit of three passes, and reports every pass before validation. This step may only copy/expand official source text; it may not author evidence.
6. Actually execute `scripts/validate_artifact.py` from `PIPELINE_SKILL_DIR` with the canonical artifact, official source document, extracted source text, and approved official domain. Capture its full command, exit code, stdout, and stderr.
7. If validation exits nonzero, return `partial`, `blocked`, or `rejected` with the validator issues. Never write or imply `approved`, `passed`, or `verified`.
8. Only after validation exits zero, actually execute `scripts/render_artifact.py` from the same `PIPELINE_SKILL_DIR` against the same canonical artifact file.
9. For a generation, repair, or backfill run, publish the approved canonical artifact to the development SQLite database with `scripts/publish_development_artifact.mjs`. Publication is part of completion, not an optional follow-up. A review-only or comparison-only request remains read-only unless the user asks to publish it.
10. Return an execution receipt followed by the renderer stdout verbatim. Do not add a second free-form product summary.

If local file or command execution is unavailable, return `blocked: deterministic_gate_not_executed`. Never simulate validator output.

Required execution receipt:

```text
artifactPath: <absolute path>
canonicalizerPath: <absolute PIPELINE_SKILL_DIR>/scripts/canonicalize_excerpts.py
canonicalizerExitCode: <integer>
canonicalizerStdout: <verbatim stdout>
validatorPath: <absolute PIPELINE_SKILL_DIR>/scripts/validate_artifact.py
validatorExitCode: <integer>
validatorStdout: <verbatim stdout>
validatorStderr: <verbatim stderr>
rendererPath: <absolute PIPELINE_SKILL_DIR>/scripts/render_artifact.py
rendererExitCode: <integer>
publicationMode: <development_required|read_only_review>
publisherPath: <absolute PIPELINE_SKILL_DIR>/scripts/publish_development_artifact.mjs
publisherExitCode: <integer or not_run_for_read_only_review>
publisherStdout: <verbatim stdout or not_run_for_read_only_review>
developmentDbPath: <absolute development SQLite path or not_applicable>
backupPath: <absolute backup path or not_applicable>
readbackStatus: <passed|not_applicable>
```

## Internal Stages

Apply these internal rule modules automatically. The user does not need to invoke them separately:

1. `$ocr-insurance-responsibility-inventory`
2. `$ocr-insurance-responsibility-card-builder`
3. `$ocr-insurance-indicator-mapper`
4. `$ocr-insurance-responsibility-audit`

Load all four modules before generating output. Keep their stage artifacts separate until the final audit passes.

## Required Input

- Exact insurer and product name.
- Exact-version official clause PDF/page or regulator disclosure hosted by the insurer or regulator.
- Filing code, product code, filing date, clause version, or source digest when available. Never fabricate a missing identifier merely to satisfy validation.
- Current policy fields only when a monetary calculation is requested.
- Existing database data only for comparison, never as proof of completeness.

If the exact product version or official responsibility section cannot be established, return `blocked` with evidence. Do not borrow responsibilities or formulas from a similar product.

## One-Run Workflow

### 0. Retrieve responsibility evidence for model-assisted batch runs

- Use `scripts/responsibility_retrieval_rules.json` and `scripts/extract_responsibility_candidates.py` for the first model pass.
- Retrieve by responsibility-section headings, concrete benefit-title suffixes, insurer-obligation verbs, trigger terms, formula terms, optional-selection labels, product-type keyword packs, and referenced tables.
- Run `scripts/extract_pdf_layout.py` for digital PDFs when `pdfplumber` is available. Preserve both ordinary text and `PDF_LAYOUT_PAGE_n` coordinate-layout blocks from the same official PDF. Use layout blocks to recover table columns and row membership; use ordinary text for prose clauses.
- When responsibility prose refers to `附录1`, `保险计划表`, a coefficient table, deductible schedule, limit schedule, or reimbursement table, retain the referenced table page plus adjacent table-like continuation pages. Treat repeated headers on later pages as continuation context, not new responsibilities.
- Preserve original page markers and raw extracted text. Retrieval output is evidence context, not a generated responsibility inventory.
- Always retain product-identity pages and adjacent pages around strong matches. Retain the complete responsibility chapter when its boundaries can be established.
- Treat the complete official responsibility chapter as the parent evidence block. Child page chunks, nearby definitions, and referenced tables may supplement it, but must never replace or truncate that chapter.
- Existing database responsibility text may be supplied as a recall and difference-check hint. It may identify a possible omission, but it is never official evidence, never proves completeness, and must not be copied into source excerpts. Every hinted item must be re-established from the exact-version official source or rejected.
- Never interpret no keyword match as no responsibility. When the retriever lacks responsibility signals or would retain most of the document, use the complete extracted source text immediately.
- Validate the first-pass artifact against the complete source document and complete extracted source text, never against only the candidate subset.
- On any first-pass deterministic validation failure, supply the complete source text to the model for the next repair pass. Remaining failures go to manual review; they must not be published.
- Repair validation failures evidence-first: retain every real responsibility and formula branch, replace invalid excerpts with exact official passages, expand to ordered exact `evidenceSegments` when one passage is insufficient, and copy branch conditions and evidence tokens literally from those passages. Never delete a responsibility, branch, optional group, or shared rule merely to silence a validator issue.
- For large group-medical schedules, rebuild each optional-package evidence block from the exact package label through every listed child heading. Do not cite only the first and last child or concatenate model summaries. Keep each expense child mapped to its own stable responsibility ID.
- Apply deterministic structural normalization as a fixed-point loop before validation: repeat until the artifact no longer changes, but never more than three passes. Classify a standalone responsibility whose heading is a waiting-period premium return as `waiting_period_refund`/`exclude`; keep a waiver responsibility as `waiver` when its evidence also contains a waiting-period refund outcome branch; use operands only for literal max/min comparisons; derive max/min composite bases from explicit operands; and require each branch/operand to declare its exact input basis. This normalization may organize source-backed data but may not invent a responsibility, amount, percentage, branch, or package membership.
- Before validation, deterministically split any evidence passage containing `PDF_PAGE_n` or `PDF_LAYOUT_PAGE_n` into page-specific `evidenceSegments`, including markers at the start of a passage and markers inside an existing evidence segment. When an exact formula token is present elsewhere in the complete official source, the canonicalizer may append its exact surrounding official clause to the owning rule or indicator and replace shortened token wording with that exact passage wording. It may also populate a missing branch or parent `evidenceTokens` entry only from an exact formula or already-supported child token. These repairs must copy official text verbatim and must never weaken the validator or invent semantic evidence.

### 1. Establish product identity

- Resolve the legal insurer name as `company`; keep the short brand name only in `displayCompany`.
- Resolve exact `productName`, `filingCode`, `productCode`, `filingDate`, and official source. Bind each identity field to field-level official evidence.
- When an official source does not contain a filing code, product code, or filing date, keep the value empty and mark its evidence `not_present_in_source` with the reviewed scope. Do not turn a product/risk code into a filing code by appending `号`.
- Treat an official product-page URL parameter such as `riskCode=00936000` as field-level product-code evidence. Preserve every reviewed official webpage in `reviewedSourceUrls`; do not claim `not_present_in_source` after omitting a reviewed query URL.
- Missing filing metadata does not by itself block an exact-version source identified by legal product title and source digest. Unsupported or fabricated identity metadata does block approval.
- Record `sourceUrl`, `sourceTitle`, `sourceDigest`, source page/section, and access time. Store the digest exactly as `sha256:<64 lowercase hex characters>`.
- Reject cross-version or similarly named source material.

### 2. Generate product overview and official responsibility inventory

- Describe product type, primary customer need, main protection/savings functions, and important structural limits.
- Scan the complete responsibility section twice.
- Enumerate every concrete payment, reimbursement, annuity, maturity, survival, medical, waiver, or other contractual insurance obligation.
- Split every independently named child payment or allowance into its own responsibility even when the source nests them under one parent heading. For example, `（1）特定疾病住院津贴` and `（2）一般住院津贴` require two responsibility IDs, cards, and indicator decisions.
- Split source-defined staged benefits when each stage has its own numbered heading, trigger, and payment obligation, such as `第一次` through `第六次重度疾病保险金`. Give every stage its own card and indicator, and bind the siblings with one shared conceptual `parentResponsibilityId` for display and aggregation.
- Keep formula-only age, date, table, or comparison branches inside one responsibility when the source does not give them independent responsibility headings.
- A standalone waiting-period refund may be retained as a real obligation, but mark it `responsibilityKind: waiting_period_refund` and `coverageAggregation: exclude`. When the refund is only the waiting-period outcome branch inside a waiver responsibility, preserve the whole responsibility as `waiver` and preserve both branches in its indicator instead of relabeling the whole responsibility. Never count a standalone refund as disease, death, medical, accident, or other current protection coverage.
- Mark premium-waiver obligations as `responsibilityKind: waiver`, not ordinary `benefit`.
- Do not create responsibility cards for `责任延续`, `保险金给付限额`, `补偿原则`, `免赔额`, `给付比例`, or similar cross-cutting settlement rules. Store them in `productRules` or the affected responsibility's limits.
- When a deductible, reimbursement ratio, annual/aggregate limit, compensation principle, or settlement branch applies to multiple responsibilities, define it once in `productRules` with a stable `ruleId`, exact evidence, and one structured `calculation`; add `ruleRefs` to every affected responsibility and indicator. Never duplicate the same piecewise settlement branches into each responsibility indicator.
- Keep each responsibility's own expense scope, benefit basis, and limit in its indicator. A shared rule supplies only the cross-cutting settlement layer.
- Do not create an insurance responsibility for `健康管理服务` or another non-insurance service. Store it in `productServices`, with exact source evidence, and keep it out of responsibility counts and coverage aggregation.
- Preserve exact trigger, obligation, limit, and source excerpt.
- Prefer one exact contiguous `sourceExcerpt`. When PDF columns, tables, page breaks, or separated clauses require more than one passage, use `evidenceSegments: [{sourcePage, sourceExcerpt}]`; every segment must independently be an exact contiguous substring. Never fabricate one concatenated excerpt. The combined segments must prove the trigger, obligation, formula, count, and termination rule. Model-authored `…` or `...` truncation is forbidden.
- For a table formula, copy conditions, plan names, amounts, percentages, limits, and deductibles from the same coordinate-preserved column or row. For a table continued across pages, create one exact evidence segment per page and retain the page-specific repeated header only as column context. Never stitch two pages into one claimed contiguous excerpt.
- Preserve PDF-extracted footnote markers and use the exact comparison wording found in the source. For example, do not rewrite `不超过` as `≤`, or remove a footnote number embedded in `意外伤害事故6`, inside `conditionText` or `evidenceTokens`. Mechanical canonicalization may restore whitespace, page boundaries, and embedded footnote markers, but it must never author semantic evidence.
- Build evidence-first: copy the official contiguous passage into `sourceExcerpt` before writing summaries, formulas, branches, or evidence tokens. Never reconstruct the excerpt from model-generated fields afterward.
- Store `基本责任`, `可选责任一/二`, riders, and similar labels as groups; enumerate their concrete child responsibilities separately.
- Preserve each selectable package exactly as the source defines it. Do not combine separate options because they share a section heading. For example, `第一项：高中教育金` and `第二项：深造金＋立业金` are two groups, not one three-child group.
- Give every optional group its own exact `sourcePage` and `sourceExcerpt` that contains the option label and all child responsibility headings. For multi-column PDF text whose extraction order differs from visual order, the canonicalizer may recover the smallest exact source window containing the label and every heading even when those anchors are reordered; it must not silently drop a child.
- When numbered children share a parent heading printed only once, preserve the exact parent heading followed by every numbered child heading in ordered evidence. Treat `年金 (1)平准给付 ... (2)增额给付` as source support for `年金(1)平准给付` and `年金(2)增额给付`; never fabricate a repeated `年金` before the second child.
- Preserve optional selection as `included`, `not_included`, or `unknown`.

### 3. Generate responsibility cards

- Create exactly one customer card per concrete responsibility.
- Bind the card to the inventory item using a stable `responsibilityId`.
- Do not create cards for group headings.
- Do not merge different responsibilities or split formula branches into fake responsibilities.
- Preserve cumulative payment wording exactly. `累计给付达到六次时终止` must not become `给付后终止`.
- Do not broaden `合同继续有效` into unsupported promises such as `其他权益不受影响`.
- Do not claim two responsibilities are non-duplicative unless the cited responsibility text explicitly states that relationship.
- Keep customer copy free of internal audit keys, model names, and implementation notes.

### 4. Extract and map quantitative indicators

- Give every responsibility an explicit indicator decision.
- Generate indicators whenever the source contains insured amount, premium, cash value, percentage, amount, age, date, duration, count, daily amount, expense, deductible, limit, table, or `max`/`min` comparison.
- When the formula or limit table is on a different page from the responsibility clause, preserve that separate official location in the indicator's own `sourcePage` and continuous `sourceExcerpt`; do not concatenate non-contiguous passages into one excerpt.
- Keep displayable formulas even when the current policy cannot calculate a number.
- Use `calculable` only when every `requiredInputs` key is actually present in artifact-level `currentPolicyInputs`. A formula that is mathematically simple but lacks the current policy's insured amount or premium is `display_only`, not `calculable`.
- Distinguish `insured_amount`, `annual_premium`, `first_premium`, `total_paid_premium`, `cash_value`, `actual_expense`, table values, and other bases.
- Never use premium as insured amount or replace one basis with another.
- Preserve every formula branch, percentage, age, count, timing rule, deduction, and termination effect.
- For every piecewise formula, store `branches` with a separate calculation status for each branch. A single top-level status must not hide a branch that also needs table data.
- When a piecewise branch itself compares amounts with `max/较大者` or `min/较小者`, keep the indicator-level `basisKey` and `calculationKey` as `piecewise`, leave indicator-level `operands` empty, and store explicit `operands` on that branch. Do not flatten branch-local comparison items into top-level operands.
- Distinguish condition-based piecewise formulas from comparisons. `较大者/max` and `较小者/min` are not piecewise: use an exact composite `basisKey` beginning with `max_of_` or `min_of_`, set `calculationKey` to `maximum_of_bases` or `minimum_of_bases`, and enumerate every compared input in `operands`.
- If any comparison operand uses cash value and the exact current-policy cash value is unavailable, the whole comparison is `needs_table`.
- Do not invent present-value or discounting semantics for a waiver. Terms such as `现值`, `折现`, or `present_value` require explicit support in the same responsibility source excerpt; otherwise preserve the exact scope as premiums waived from the diagnosis or event date.
- Map the exact contract term `实际交纳的保险费` to `actual_paid_premium`. Do not replace it with `total_paid_premium`; these bases are not interchangeable.
- Do not invent `effective_insured_amount` or another ambiguous basis alias. Store the exact components, such as `insured_amount_plus_accumulated_dividend_insured_amount`.
- Do not use generic aliases such as `sum_assured` or `death_formula`. Use `piecewise` at the parent and an exact `basisKey` on every branch.
- When the clause formula uses a contract-defined term such as `有效保险金额`, preserve it as `contract_defined_effective_insured_amount` instead of expanding it into a simplified sum. Attach `basisDefinition` with the exact definition page, excerpt or ordered `evidenceSegments`, and evidence tokens. In a max/min formula, use this basis on the exact operand and keep the comparison's composite `max_of_...` or `min_of_...` basis at its parent. This prevents omission of timing-dependent components such as不足整保单年度红利保险金额.
- Each branch must preserve the exact source-backed `conditionText`, `formulaText`, `basisKey`, `requiredInputs`, and `evidenceTokens`. `conditionText` and every evidence token must appear literally in that indicator's own contiguous `sourceExcerpt`; do not summarize `年满41周岁保单周年日之前` as `41岁前`. A cash-value branch without a supplied policy value is `needs_table`, even when another branch only needs claim facts.
- A branch belonging to a shared product settlement rule must be stored and evidenced once under `productRules[].calculation.branches`; referenced responsibility indicators use `ruleRefs` and must not repeat those branches.
- For optional responsibilities, retain indicators but include them in current-policy aggregation only when selected.
- Map every indicator to the same `responsibilityId` as its responsibility card.

Allowed calculation states:

- `calculable`
- `display_only`
- `needs_table`
- `needs_claim_facts`
- `not_quantitative`

### 5. Audit independently

- Re-open the official source and independently rebuild its responsibility heading checklist.
- Independently rebuild the selectable-package checklist as `officialOptionalGroupChecklist`; do not derive it from generated `optionalGroups`.
- Compare the official checklist, inventory, cards, and indicator decisions by stable ID and source location.
- Compare the exact optional group-to-child mapping. Equal optional-child sets are insufficient when the package boundaries differ.
- Validate every formula constant, operator, basis, branch, age, date, count, and limit against the same responsibility's source excerpt or exact table row.
- Reject generic-heading cards, missing optional children, duplicates, merges, wrong selections, wrong product versions, and unsupported formulas.
- Reject merged independently named child benefits, cross-cutting rules represented as benefits, and product services represented as insurance responsibilities.
- Reject staged benefit siblings without a common conceptual parent, waiting-period refunds included in normal coverage totals, truncated evidence, comparison formulas mislabeled as piecewise, and customer copy that changes cumulative counts or termination effects.
- Do not approve based only on equal counts.
- Store the independent checklist and one audit-matrix row per responsibility in the final artifact. A prose claim such as `idSetCheck: passed` is not audit evidence.

### 6. Assemble the final artifact

Return one unified artifact only after the independent audit succeeds:

```json
{
  "company": "保险公司法定全称",
  "displayCompany": "品牌简称",
  "productName": "",
  "productIdentity": {
    "filingCode": "",
    "productCode": "",
    "filingDate": "",
    "sourceUrl": "",
    "sourceDigest": "sha256:<64 lowercase hex characters>",
    "fieldEvidence": {
      "filingCode": {
        "status": "verified",
        "sourceUrl": "",
        "sourcePage": "",
        "sourceExcerpt": ""
      },
      "productCode": {
        "status": "verified",
        "sourceUrl": "",
        "sourcePage": "",
        "sourceExcerpt": ""
      },
      "filingDate": {
        "status": "not_present_in_source",
        "reviewScope": "官方条款PDF全部页面"
      }
    }
  },
  "productOverview": {
    "productType": "",
    "primaryPurpose": "",
    "mainFunctions": [],
    "importantLimits": []
  },
  "productServices": [
    {
      "serviceId": "stable-service-id",
      "title": "健康管理服务",
      "customerSummary": "",
      "sourcePage": "",
      "sourceExcerpt": ""
    }
  ],
  "productRules": [
    {
      "ruleId": "stable-rule-id",
      "ruleKind": "reimbursement_ratio",
      "title": "医疗费用给付比例",
      "affectedResponsibilityIds": [],
      "evidenceSegments": [
        { "sourcePage": "", "sourceExcerpt": "" }
      ],
      "calculation": {
        "formulaText": "",
        "normalizedFormula": "",
        "basisKey": "piecewise",
        "calculationKey": "",
        "calculationStatus": "needs_claim_facts",
        "calculationReason": "",
        "requiredInputs": [],
        "evidenceTokens": [],
        "branches": []
      }
    }
  ],
  "currentPolicyInputs": {},
  "optionalGroups": [
    {
      "groupId": "optional_1",
      "label": "第一项",
      "selectionStatus": "unknown",
      "childResponsibilityIds": [],
      "sourcePage": "",
      "sourceExcerpt": ""
    }
  ],
  "officialOptionalGroupChecklist": [
    {
      "groupId": "optional_1",
      "officialLabel": "第一项",
      "childResponsibilityIds": [],
      "sourcePage": "",
      "sourceExcerpt": ""
    }
  ],
  "officialChecklist": [
    {
      "responsibilityId": "stable-source-derived-id",
      "officialHeading": "",
      "sourcePage": "",
      "sourceExcerpt": ""
    }
  ],
  "responsibilities": [
    {
      "responsibilityId": "stable-source-derived-id",
      "liability": "",
      "groupId": null,
      "parentResponsibilityId": null,
      "responsibilityKind": "benefit",
      "coverageAggregation": "include",
      "selectionStatus": "included",
      "triggerCondition": "",
      "insurerObligation": "",
      "importantLimits": [],
      "ruleRefs": ["stable-rule-id"],
      "sourcePage": "",
      "sourceExcerpt": "",
      "card": {
        "title": "",
        "customerSummary": "",
        "benefitExplanation": ""
      },
      "indicators": [
        {
          "indicatorName": "",
          "formulaText": "",
          "normalizedFormula": "",
          "basisKey": "",
          "calculationKey": "",
          "calculationStatus": "display_only",
          "calculationEligible": false,
          "calculationReason": "",
          "requiredInputs": [],
          "ruleRefs": ["stable-rule-id"],
          "sourcePage": "",
          "sourceExcerpt": "",
          "evidenceTokens": [],
          "basisDefinition": {
            "term": "有效保险金额",
            "sourcePage": "条款定义位置",
            "sourceExcerpt": "定义原文",
            "evidenceTokens": []
          },
          "branches": [],
          "operands": []
        }
      ]
    }
  ],
  "audit": {
    "status": "approved",
    "officialChecklistCount": 0,
    "inventoryCount": 0,
    "cardCount": 0,
    "indicatorDecisionCount": 0,
    "matrix": [
      {
        "responsibilityId": "stable-source-derived-id",
        "inventory": "pass",
        "card": "pass",
        "indicatorDecision": "pass",
        "formulaEvidence": "pass",
        "selectionEvidence": "pass",
        "productVersion": "pass",
        "result": "pass",
        "issues": []
      }
    ],
    "issues": []
  },
  "publication": {
    "sqlite": "development_required_after_approval",
    "feishu": "not_requested"
  }
}
```

When `branches` or `operands` is non-empty, every entry must use these exact object shapes; strings and empty objects are forbidden:

```json
{
  "branches": [
    {
      "branchId": "stable-branch-id",
      "conditionText": "exact text present in the indicator sourceExcerpt",
      "formulaText": "exact branch formula",
      "basisKey": "exact_branch_basis",
      "calculationStatus": "display_only",
      "requiredInputs": ["exact_input_key"],
      "evidenceTokens": ["literal token in sourceExcerpt"],
      "operands": []
    }
  ],
  "operands": [
    {
      "operandId": "stable-operand-id",
      "formulaText": "exact compared amount",
      "basisKey": "exact_operand_basis",
      "requiredInputs": ["exact_input_key"],
      "evidenceTokens": ["literal token in sourceExcerpt"]
    }
  ]
}
```

Use `branches` only for mutually exclusive condition paths. Use `operands` only for `max/较大者` or `min/较小者`. Never create placeholder entries.
For a max/min operation nested inside one piecewise branch, use that branch's `operands` array with the same operand object shape. The top-level indicator must not duplicate those branch operands.

## Qualification Gate

The result is qualified only when all are true:

```text
independent official responsibility IDs == inventory responsibility IDs
inventory responsibility IDs == card responsibility IDs
inventory responsibility IDs == indicator-decision responsibility IDs
official optional group mapping == generated optional group mapping
```

Additionally require:

- exact product-version evidence;
- field-level evidence for every populated filing code, product code, and filing date;
- empty values plus `not_present_in_source` evidence for identity metadata absent from reviewed official sources;
- exact source excerpt for each responsibility;
- exact contiguous official-source evidence for every `sourceExcerpt` anywhere in the artifact;
- source URL hosted on an explicitly approved official insurer or regulator domain;
- source digest equal to the bytes of the supplied official source document;
- independently named child benefits split one-to-one;
- services and cross-cutting settlement rules excluded from responsibility counts;
- no model-authored evidence truncation;
- one card per concrete responsibility;
- one card per independently headed staged payment, with a shared conceptual parent for sibling stages;
- waiting-period refunds displayed but excluded from normal coverage aggregation;
- explicit indicator decision for every responsibility;
- source-supported formula bases and constants;
- max/min comparisons represented as comparisons with explicit operands rather than condition branches;
- branch-local max/min comparisons represented by operands on the affected piecewise branch, without duplicated top-level operands;
- no unsupported waiver present-value/discounting semantics;
- `实际交纳的保险费` mapped to `actual_paid_premium`, never `total_paid_premium`;
- exact definition evidence for every contract-defined calculation basis;
- correct optional-selection behavior;
- independent source evidence for every optional package and exact package boundaries;
- no unsupported responsibility in the product overview;
- independent audit status `approved`.

If any condition fails, return `partial`, `blocked`, or `rejected` with the audit matrix. Never label incomplete output as verified.

## Mandatory Deterministic Gate

Resolve the selected skill directory and save the unified artifact to JSON, then run:

```bash
PIPELINE_SKILL_DIR='<absolute directory containing this selected SKILL.md>'
ARTIFACT_PATH='<absolute artifact JSON path>'
SOURCE_DOCUMENT_PATH='<absolute downloaded official PDF path>'
SOURCE_TEXT_PATH='<absolute complete extracted official text path>'
OFFICIAL_DOMAIN='<insurer-owned or regulator-owned domain>'
CANONICAL_ARTIFACT_PATH='<absolute canonical artifact JSON path>'
python3 "$PIPELINE_SKILL_DIR/scripts/canonicalize_excerpts.py" \
  --artifact="$ARTIFACT_PATH" \
  --source-text="$SOURCE_TEXT_PATH" \
  --output="$CANONICAL_ARTIFACT_PATH"
python3 "$PIPELINE_SKILL_DIR/scripts/validate_artifact.py" \
  --artifact="$CANONICAL_ARTIFACT_PATH" \
  --source-document="$SOURCE_DOCUMENT_PATH" \
  --source-text="$SOURCE_TEXT_PATH" \
  --official-domain="$OFFICIAL_DOMAIN"
```

The artifact may retain `audit.status: approved` only when this exact command was executed, exits `0`, and prints `{"ok": true, ...}`. A model-authored statement that validation passed is not evidence. Never override validator failures, delete required evidence to silence them, or publish an unvalidated artifact.

Generate the user-facing result only with:

```bash
python3 "$PIPELINE_SKILL_DIR/scripts/render_artifact.py" \
  --artifact="$CANONICAL_ARTIFACT_PATH" \
  --source-document="$SOURCE_DOCUMENT_PATH" \
  --source-text="$SOURCE_TEXT_PATH" \
  --official-domain="$OFFICIAL_DOMAIN"
```

Return the execution receipt and renderer output without rewriting ages, percentages, timing boundaries, bases, optional-group relationships, formulas, or audit status. The model must not produce a second free-form summary that can diverge from the validated artifact. If the response lacks the artifact path, validator path, exit code, and verbatim validator output, it is not a completed pipeline run.

## Database Publication

Generation, repair, and backfill runs must write their approved result to the development SQLite database. Review-only and comparison-only runs must not write unless publication is explicitly requested. Production publication always requires a separate, explicit user authorization; never infer it from development publication.

The only permitted default target is the development database at `<project-root>/.runtime/local/policy-ocr.sqlite`. Do not use `<project-root>/.runtime/policy-ocr.sqlite`, `/data/policy-ocr.sqlite`, a production bundle, or Feishu as a substitute. Do not read or edit `.env.local` to discover or change this target.

After canonicalization, validation, and rendering succeed, run:

```bash
PROJECT_ROOT='<absolute OCR_insurance checkout containing .runtime/local>'
DEVELOPMENT_DB_PATH="$PROJECT_ROOT/.runtime/local/policy-ocr.sqlite"
node "$PIPELINE_SKILL_DIR/scripts/publish_development_artifact.mjs" \
  --artifact="$CANONICAL_ARTIFACT_PATH" \
  --source-document="$SOURCE_DOCUMENT_PATH" \
  --source-text="$SOURCE_TEXT_PATH" \
  --official-domain="$OFFICIAL_DOMAIN" \
  --db-path="$DEVELOPMENT_DB_PATH" \
  --write
```

Publication requirements:

- refuse publication unless the bundled deterministic validator exits `0` for the same canonical artifact and source files;
- refuse any database path outside the current checkout's `.runtime/local/` directory;
- create a timestamped SQLite backup before the first write;
- store the complete approved artifact and exact source provenance;
- replace the exact product's responsibility cards, indicators, and optional-responsibility records in one transaction;
- use stable IDs derived from `sourceDigest`, `responsibilityId`, and indicator identity;
- preserve multiple indicators and every branch/operand instead of collapsing a responsibility to one metric;
- never write `partial`, `blocked`, `rejected`, or validator-failing artifacts;
- after commit, read back the complete artifact and all stable IDs, compare counts and source digest, and report `readbackStatus: passed` only on an exact match;
- perform readback verification inside the same transaction; if it fails, roll back the transaction, retain the backup for recovery, and return `blocked: development_publication_failed`;
- include `developmentDbPath`, `backupPath`, inserted/replaced row counts, validator result, and readback result in `publisherStdout`.

Do not use `scripts/import-reviewed-responsibility-artifacts.mjs` for this unified artifact. That legacy importer can collapse multiple indicators belonging to one responsibility. Write Feishu only when explicitly requested and verify post-write readback. Database publication does not authorize restarting any environment.
