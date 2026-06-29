# Customer Responsibility Summary Design

## Context

The project already has machine-facing insurance responsibility data:

- `product_responsibility_cards` split official product responsibilities into structured cards.
- `insurance_indicator_records` keeps quantification hints, calculation status, and source evidence.
- The responsibility assistant currently renders `analysis.coverageTable`, while policy detail pages can render `responsibilityCards`.

Those records are useful for matching, calculation, audit, and source traceability, but they are too internal for customer-facing UI. Terms such as `claim_contingent`, `needs_table`, calculation keys, indicator check status, and formula fragments should not be shown to customers.

The new feature adds a durable customer-facing summary layer. It does not rewrite the existing responsibility cards or indicators.

## Goals

- Generate a customer-readable responsibility summary for a product the first time it is requested.
- Save the generated summary to SQLite as durable business data.
- Read the saved summary from SQLite on later requests for the same product.
- Use DeepSeek on the backend for generation.
- Use the same summary shape in the responsibility assistant first, then reuse it later in family policy and single policy product responsibility views.
- Keep internal responsibility cards and indicators available for calculation and audit, but hidden from customer-facing summary UI.

## Non-Goals

- Do not batch-generate summaries for all products up front.
- Do not rewrite all existing responsibility cards or indicator records.
- Do not expose internal calculation metadata to customers.
- Do not calculate exact claim amounts inside the customer summary. Exact amount calculation remains the responsibility of existing indicator and cashflow logic.
- Do not sync this new table to Feishu in the first slice.

## Data Model

Add a SQLite table named `product_customer_responsibility_summaries`.

Suggested columns:

- `id TEXT PRIMARY KEY`
- `product_key TEXT NOT NULL`
- `company TEXT`
- `product_name TEXT`
- `summary_version TEXT NOT NULL`
- `status TEXT NOT NULL`
- `headline TEXT`
- `summary_json TEXT NOT NULL`
- `source_urls_json TEXT NOT NULL DEFAULT '[]'`
- `source_digest TEXT`
- `model_provider TEXT`
- `model_name TEXT`
- `generated_at TEXT`
- `updated_at TEXT`
- `payload TEXT NOT NULL`

Indexes:

- unique lookup on `product_key, summary_version`
- lookup on `company, product_name`
- lookup on `status`

`product_key` should follow the existing product key convention where possible, such as `company_product:<company>:<productName>`.

This table is the durable product summary store. The backend should only return rows whose status means the summary is ready for customer display. Failed generation attempts should stay in logs or a separate review path, not in this table as customer-visible records.

## Summary JSON Shape

Store the customer summary as structured JSON rather than only markdown. This lets the responsibility assistant and policy detail pages share one component while still allowing layout-specific rendering.

```json
{
  "company": "新华保险",
  "productName": "新华人寿保险股份有限公司盛世荣耀终身寿险（分红型）",
  "headline": "这是一份以身故或身体全残保障为主的终身寿险。",
  "mainResponsibilities": [
    {
      "title": "身故或身体全残保险金",
      "plainText": "发生身故或身体全残时，保险公司按条款约定给付保险金。",
      "howItPays": "金额会结合出险时间、年龄、已交保费、基本保额和保单年度计算。",
      "requiredPolicyFields": ["基本保险金额", "已交保险费", "缴费期间", "出险年龄", "保单年度"]
    }
  ],
  "notices": [
    "这不是医疗报销型产品。",
    "具体金额需要结合保单信息计算。"
  ],
  "requiredPolicyFields": ["基本保险金额", "已交保险费", "缴费期间", "出险年龄", "保单年度"],
  "sourceUrls": ["https://static-cdn.newchinalife.com/ncl/pdf/example.pdf"]
}
```

The frontend should not render `summary_version`, `source_digest`, `model_provider`, internal indicator keys, or model audit metadata in customer views.

## Backend Flow

Add a backend service, for example `server/product-customer-responsibility-summary.service.mjs`, with these responsibilities:

1. Normalize the input company and product name.
2. Resolve the best official product match using existing knowledge matching utilities.
3. Look up a ready summary in `product_customer_responsibility_summaries`.
4. If a ready summary exists for the current `summary_version` and source digest, return it with source `database`.
5. If no ready summary exists, gather generation context:
   - product identity;
   - visible responsibility cards;
   - linked indicator records;
   - official knowledge snippets and source URLs.
6. Build a compact DeepSeek prompt that asks for JSON only.
7. Validate the model JSON:
   - required fields are present;
   - no internal fields such as `calculationKey`, `claim_contingent`, `needs_table`, `indicatorCheckStatus`;
   - every responsibility title is backed by a responsibility card or official source excerpt;
   - notices do not invent exclusions or benefits not present in the source context.
8. Save the summary row in SQLite.
9. Return the saved summary with source `generated`.

If DeepSeek fails or validation fails, return a controlled error state and do not show internal responsibility cards to the customer as a fallback.

## API

Add an endpoint:

```text
POST /api/policy-responsibilities/customer-summary
```

Request:

```json
{
  "company": "新华保险",
  "productName": "盛世荣耀终身寿险（分红型）"
}
```

Response:

```json
{
  "ok": true,
  "source": "database",
  "summary": {
    "company": "新华保险",
    "productName": "新华人寿保险股份有限公司盛世荣耀终身寿险（分红型）",
    "headline": "这是一份以身故或身体全残保障为主的终身寿险。",
    "mainResponsibilities": [],
    "notices": [],
    "requiredPolicyFields": [],
    "sourceUrls": []
  }
}
```

`source` is either:

- `generated`: DeepSeek generated and the backend saved the row during this request.
- `database`: the backend read an existing row from SQLite.

## DeepSeek Prompt Inputs

Do not send the whole database. Send only the matched product context:

- product company and normalized product name;
- product type if known;
- visible responsibility cards with title, category, customer-safe summary fields, and official excerpts;
- relevant indicators with liability, formula text, basis, and calculation status translated into customer-safe wording;
- official source URLs and short excerpts.

The prompt must instruct DeepSeek:

- output JSON only;
- write for insurance customers, not internal auditors;
- do not mention internal field names or status values;
- do not invent benefits;
- if exact amount cannot be calculated without policy fields, list the missing fields.

## Frontend Flow

Create a shared customer summary component, for example `CustomerResponsibilitySummaryCard`.

The component renders:

- product name;
- headline;
- main responsibility sections;
- required policy fields;
- notices;
- official source links.

The component receives only the customer summary shape. It should not accept raw responsibility cards, indicators, or calculation metadata.

First integration target:

- `src/features/responsibility-assistant/ResponsibilityAssistant.tsx`
- After a product is selected or queried, call the customer-summary endpoint.
- Show a loading state while the summary is generated.
- Show `source=generated` and `source=database` only as non-customer debugging data if needed; do not surface it prominently to customers.

Later reuse target:

- policy detail / family policy product responsibility views.
- They can call the same endpoint with the policy's recognized company and product name, then render the same component.

## Error Handling

If no matching product exists:

- show the existing no-match experience and product suggestions.

If responsibility cards or official excerpts are missing:

- return a clear backend status such as `needs_source_review`;
- frontend shows a customer-safe message that this product needs further responsibility review.

If DeepSeek fails:

- do not write a row to `product_customer_responsibility_summaries`;
- log enough backend detail to debug or retry later;
- frontend shows a retry-safe message.

If validation fails:

- do not display the invalid model output;
- do not write a row to `product_customer_responsibility_summaries`;
- return `needs_review` with a short reason for logs/admin use.

## Versioning and Regeneration

Use a `summary_version` string to control regeneration when the schema, prompt, or display standard changes.

Use `source_digest` to detect underlying data changes. The digest can be computed from:

- responsibility card titles and source excerpts;
- indicator liabilities and formula text;
- official source URLs.

If the digest changes, the backend should treat the saved summary as stale and regenerate on the next request.

## Testing

Focused backend tests:

- first request generates and writes a summary row;
- second request returns the same summary from SQLite without calling DeepSeek;
- validation rejects model output containing internal metadata;
- generation input includes responsibility cards, indicators, and official snippets for a known product;
- missing responsibility source returns a safe status instead of raw cards.

Focused frontend tests:

- responsibility assistant renders customer summary instead of raw `coverageTable`;
- loading state appears during summary generation;
- failed summary generation shows a safe message;
- source links still render.

Verification commands:

```bash
npm run check
node --test tests/policy-responsibility-query.test.mjs
node --test tests/responsibility-card-standardizer.test.mjs
```

For frontend contract or UI changes:

```bash
npm run typecheck
npm run build
```

## Rollout

1. Add the durable summary table and service.
2. Add the customer-summary API.
3. Add the shared customer summary component.
4. Wire the responsibility assistant to the new API and component.
5. Verify with a known product such as `新华人寿保险股份有限公司盛世荣耀终身寿险（分红型）`.
6. Later wire policy detail and family policy product responsibility views to the same API and component.
