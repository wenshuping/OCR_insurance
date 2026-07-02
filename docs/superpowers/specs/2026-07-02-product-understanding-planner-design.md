# Product Understanding Planner Design

## Context

The customer responsibility summary flow already has a structured local RAG layer:

1. Match product materials by company and product name.
2. Resolve official responsibility sources.
3. Extract structured `sourceSections`, including responsibility items, supplement sections, source references, and evidence gaps.
4. Route the product through local category rules.
5. Build a category-specific DeepSeek prompt.
6. Save the generated customer summary in SQLite.

Recent testing showed that the main problem is not only whether the final model can write insurance responsibilities. The upstream prompt also needs a better understanding of what the product is for, which evidence matters, which items are true insurance responsibilities, which items are product functions, and what customers should pay attention to.

This design adds a lightweight model-powered Planner before final summary generation. The Planner improves evidence organization and prompt direction, but does not act as a quality gate.

## Goals

- Help the final DeepSeek summary understand:
  - what the insurance product mainly does;
  - which insurance responsibilities matter;
  - which product functions or rights are present in official materials;
  - what needs attention, such as non-guaranteed dividends, cash value tables, account risks, or missing details.
- Use the Planner only when useful by default, while providing a switch to compare all products with and without Planner.
- Keep local structured RAG as the primary evidence source.
- Keep generated customer content organized as configurable blocks.
- Preserve the current customer API compatibility during the first implementation.
- Keep failures debuggable through generation run records and logs.

## Non-Goals

- Do not build a vector database in this phase.
- Do not replace official-source matching with semantic vector search.
- Do not let the Planner generate final customer copy.
- Do not let the Planner decide whether the final result passes or fails.
- Do not restore semantic quality gates in this phase.
- Do not build the admin editing UI in the first implementation.
- Do not implement cross-product marketing analysis in the first implementation.

## Selected Approach

Use a hybrid approach:

```text
official local sources
→ structured local RAG
→ local category routing
→ optional DeepSeek Planner
→ final DeepSeek summary prompt
→ minimal renderability check
→ cache customer summary
```

The Planner runs only for complex or uncertain products by default. A runtime switch can force Planner on for every product or turn it off entirely for A/B testing.

## Planner Switch

Add a Planner mode setting with three values:

- `auto`: default. Run Planner only when local signals say it is useful.
- `all`: run Planner for every product, including simple products.
- `off`: skip Planner for every product and use the current local routing plus category template.

The setting should be readable from environment/config first, and later can be exposed in an admin/debug setting without changing the Planner API.

Suggested names:

```text
RESPONSIBILITY_PLANNER_MODE=auto|all|off
RESPONSIBILITY_PLANNER_MODEL=deepseek-v4-flash
```

All model calls in this feature use DeepSeek. The Planner defaults to `deepseek-v4-flash` because it only produces structured planning metadata. The final summary keeps existing routing: Flash for simple products, Pro for complex products.

For manual testing, generation run payloads should record:

```json
{
  "plannerMode": "auto",
  "plannerUsed": true,
  "plannerModel": "deepseek-v4-flash",
  "plannerReason": "complex_product"
}
```

This allows direct comparison:

- `off`: current behavior without Planner;
- `auto`: only complex products use Planner;
- `all`: every product uses Planner.

## Planner Trigger Rules

When mode is `auto`, run Planner if any of these are true:

- Local category routing is uncertain or has conflicting signals.
- Product category is one of:
  - participating life;
  - annuity;
  - critical illness;
  - universal life;
  - investment-linked;
  - endowment;
  - long-term care.
- Official responsibility text is long.
- The structured evidence contains signals such as:
  - dividend, participating, cumulative dividend sum assured;
  - optional responsibilities;
  - annuity领取日 / 保单周年日 / 可选责任;
  - disease grouping, multiple disease payments, waiver, care benefits;
  - account value, settlement rate, guaranteed rate, fees, investment risk;
  - compound growth formula;
  - "二者较大者", "三者最大者", or similar comparison formulas.
- Product name and official text point to different categories, such as a name that looks like whole life but contains annuity领取 rules.

When mode is `all`, always call Planner after source extraction.

When mode is `off`, never call Planner.

If the Planner fails, times out, or returns malformed JSON, the service logs the failure and falls back to local routing and the existing category prompt.

## Planner Input

The Planner receives compact structured evidence, not the full raw database:

```json
{
  "product": {
    "company": "新华保险",
    "productName": "产品名"
  },
  "localRouting": {
    "productCategory": "annuity",
    "categoryLabel": "年金保险",
    "featureTags": ["participating"],
    "modelTier": "pro"
  },
  "sourceSections": {
    "sourceInventory": [],
    "coverageSections": [],
    "responsibilityItems": [],
    "supplementSections": [],
    "gaps": []
  },
  "cards": [],
  "indicators": []
}
```

The input must remain bounded. It should reuse the existing prompt compaction helpers where practical, especially for source sections, responsibility items, and source references.

## Planner Output

The Planner must return JSON only:

```json
{
  "plannerVersion": "product-understanding-planner-v1",
  "productCategory": "annuity",
  "categoryLabel": "年金保险（分红型）",
  "confidence": "high",
  "recommendedTemplate": "annuity_participating",
  "productPurposeFocus": [
    "长期领取年金",
    "兼顾身故保障",
    "参与分红但红利不保证"
  ],
  "responsibilityFocus": [
    "年金领取规则",
    "身故保险金"
  ],
  "functionFocus": [
    "红利",
    "保单贷款",
    "减保"
  ],
  "attentionFocus": [
    "红利不保证",
    "具体领取金额需结合合同和保单"
  ],
  "evidenceNeeds": [
    "保险责任正文",
    "红利分配条款",
    "保单贷款/减保条款"
  ],
  "missingOrUnclear": [
    "红利具体分配方式需要核验"
  ],
  "notesForFinalPrompt": [
    "只写官方资料明确出现的产品功能",
    "不要把红利写成确定保险责任"
  ]
}
```

Planner output is advisory. The final prompt may use it to choose language and focus, but it cannot override official evidence or invent missing product features.

## Customer Summary Content Blocks

The generated customer summary should be organized around configurable blocks. The default blocks are:

1. `productPurpose`: 产品主要做什么
2. `responsibilities`: 主要保险责任
3. `productFunctions`: 产品功能/权益
4. `attentionNotes`: 注意事项

Each block should support future editing and visibility control:

```json
{
  "blockKey": "productPurpose",
  "title": "产品主要做什么",
  "enabled": true,
  "editable": true,
  "order": 1,
  "content": "这个产品主要用于..."
}
```

For the first implementation, the backend should persist this block structure but also keep the existing frontend-compatible fields:

- `headline`
- `mainResponsibilities`
- `notices`
- `requiredPolicyFields`
- `sourceUrls`

The frontend can keep rendering the current shape in the first phase. A later admin/editor phase can expose block-level switches, ordering, and manual edits.

## Final Summary Prompt

The final DeepSeek prompt receives:

- product identity;
- local routing result;
- Planner output when used;
- structured RAG source sections;
- cards and indicators as supporting evidence;
- content block schema;
- explicit instruction that product functions must only come from official evidence.

The target customer-facing content is:

- what this insurance mainly does;
- main insurance responsibilities;
- product functions or rights;
- attention notes, including non-guaranteed benefits and details that require policy data or tables.

The final prompt should not ask DeepSeek to judge whether the evidence is good enough. It should write from the evidence it receives and put unclear items into attention notes or missing details.

## Persistence and Cache Version

Introduce a new summary version, for example:

```text
customer-summary-v24-planner-blocks
```

The summary row payload should include:

- `sourceDigest`
- `sourceSectionsDigest`
- local routing result
- `plannerMode`
- `plannerUsed`
- `plannerModel`
- Planner input digest
- Planner output
- final prompt digest or preview
- content blocks
- final model name
- quality gate result from the minimal renderability check

Cache reads should continue to require matching product key, summary version, and source digest. Planner mode should be included in payload and run records for debugging. The first implementation can use a version bump to avoid old-cache contamination; it does not need a separate cache row per Planner mode unless A/B tests need side-by-side persisted outputs for the same product.

## Logging and Run Records

Add structured logs:

```text
[customer-responsibility-planner] skipped/simple_product
[customer-responsibility-planner] called model=deepseek-v4-flash mode=auto
[customer-responsibility-planner] parsed category=annuity template=annuity_participating
[customer-responsibility-summary] called model=deepseek-v4-pro plannerUsed=true
[customer-responsibility-summary] generated blocks=4 responsibilities=2
```

Run records should make it clear whether a result came from:

- no Planner;
- Planner success;
- Planner failure with fallback;
- Planner disabled;
- Planner forced for all products.

## Failure Handling

- No official sources: keep returning `needs_source_review`.
- Source extraction incomplete: keep returning `needs_extraction_review`.
- Planner failure: log and continue without Planner.
- Planner malformed JSON: log and continue without Planner.
- Final DeepSeek empty or malformed: use the existing official retry flow.
- Final output still not renderable: return `needs_model_review`.
- Semantic content is not blocked by local quality rules in this phase.

## Testing

Focused tests should cover:

- Simple ordinary whole life with `plannerMode=auto` skips Planner.
- Participating annuity with `plannerMode=auto` calls Planner and includes product purpose, functions, and attention notes.
- Critical illness with disease grouping calls Planner.
- `plannerMode=all` calls Planner for a simple product.
- `plannerMode=off` never calls Planner.
- Planner failure falls back to local routing and still generates if final DeepSeek succeeds.
- Planner output is stored in payload/run records.
- New block structure is persisted while old customer summary fields remain available.
- Old summary version does not satisfy the new version.

Verification should include:

```bash
node --test tests/product-customer-responsibility-summary.test.mjs
node --test tests/responsibility-summary-templates.test.mjs
npm run check
```

Because this changes server/domain behavior, full `npm test` should be run before completion. Existing unrelated failures should be reported separately if they remain.

## Future Phase: Vector Search

Do not build vector search in this phase. The current user flow already supplies company and product name, so exact product matching plus structured official-section extraction is more reliable.

Vector search becomes useful later for:

- fuzzy product search;
- cross-product marketing analysis;
- similar-product comparison;
- question answering across products;
- finding all products with a particular responsibility or feature.

When that phase begins, the Planner can reuse the same evidence-needs output to form vector retrieval queries.
