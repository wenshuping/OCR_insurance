# Canonical Product ID Design

Date: 2026-06-01

## Goal

Make product recognition stable after OCR by introducing a product-level internal id, `canonicalProductId`.

The system currently recognizes and stores official product names, but downstream responsibility matching still mostly depends on `company + productName`. That is fragile for products with near-identical names, such as:

- `新华人寿保险股份有限公司多倍保障重大疾病保险（智享版）`
- `新华人寿保险股份有限公司多倍保障重大疾病保险（智赢版）`
- `新华人寿保险股份有限公司多倍保障重大疾病保险（庆典版）`

After this change, OCR can still use product-name matching to find the official product, but once a product is matched, all responsibility, optional responsibility, indicator, and report matching should prefer `canonicalProductId`.

## Selected Approach

Use a derived stable id and add it progressively to existing payloads.

Do not add a new `insurance_products` table in this iteration. The product id is derived from normalized insurer and official product name:

```text
canonicalProductId = product_<hash(normalizedCompany + normalizedOfficialProductName)>
```

The id is not a `knowledge_records.id`.

`knowledge_records.id` identifies a source material row. One product can have multiple source rows, such as a terms PDF and a product manual. These rows must share the same `canonicalProductId` when they describe the same official product.

## Data Model

Add `canonicalProductId` to payload-level objects first. No table schema migration is required for this design because the current SQLite store persists full payload JSON for these objects.

Fields:

- `knowledge_records.payload.canonicalProductId`
- `insurance_indicator_records.payload.canonicalProductId`
- `optional_responsibility_records.payload.canonicalProductId`
- `policies.payload.canonicalProductId`
- `policies.payload.plans[].canonicalProductId`

For runtime objects, expose the same field as:

- `knowledgeRecord.canonicalProductId`
- `coverageIndicator.canonicalProductId`
- `optionalResponsibility.canonicalProductId`
- `policy.canonicalProductId`
- `policy.plans[].canonicalProductId`

The original `company`, `productName`, `name`, and `matchedProductName` fields remain. They are still needed for display, search, manual review, and backward compatibility.

## ID Generation Rule

The id source must be the official product name, not raw OCR text.

Allowed sources:

- `knowledgeRecord.productName`
- `insuranceIndicatorRecord.productName`
- `optionalResponsibilityRecord.productName`
- `plan.matchedProductName`
- a manually selected local official product suggestion

Disallowed sources:

- raw OCR product text before local product matching
- user-entered fuzzy product text that has not been matched to a local official product
- a source material id such as `knowledge_records.id`

Normalization must be shared by all call sites. At minimum it should:

- trim whitespace;
- normalize full-width and half-width variants;
- remove internal whitespace;
- preserve version words and parenthetical editions such as `（智享版）`, `（智赢版）`, and `（庆典版）`;
- normalize insurer aliases consistently with existing company matching, while still using the canonical company value selected by the match.

## OCR Entry Flow

OCR completion stays on the policy entry page.

Flow:

```text
OCR text
  -> raw plan extraction
  -> local official product match
  -> matchedProductName + canonicalProductId
  -> main-plan optional responsibility review
  -> user confirms selected / not selected / unknown
  -> save policy
```

When OCR matches a product:

- the main plan receives `matchedProductName`;
- the main plan receives `canonicalProductId`;
- the policy `name` displays the official product name;
- the policy-level `canonicalProductId` mirrors the main plan id;
- optional responsibilities are loaded from the matched main product.

The optional responsibility confirmation UI belongs to the main product area, not to rider or linked-account cards.

Deleting a rider must not delete main-product optional responsibilities. Optional responsibilities are refreshed only when the main product changes, meaning the main plan's `canonicalProductId` changes.

## Manual Selection Flow

Manual local product selection must also return `canonicalProductId`.

Product suggestion and product match payloads should include:

- `company`;
- `productName`;
- `canonicalProductId`;
- existing score, source count, and evidence fields.

When a user selects a product candidate:

- update `formData.company`;
- update `formData.name`;
- update main plan `matchedProductName`;
- update main plan `canonicalProductId`;
- refresh main-product optional responsibilities.

If a user manually edits the main product name after selecting a candidate, clear both `matchedProductName` and `canonicalProductId` until a new official product is selected.

## Backend Matching

Indicator and optional responsibility matching should prefer `canonicalProductId`.

Target flow:

```text
policy main plan canonicalProductId
  -> optional responsibility records with same canonicalProductId
  -> indicator records with same canonicalProductId
  -> selectedCoverageIndicators()
  -> scenarioEntries / cashflow / family report
```

Matching priority:

1. Match by `canonicalProductId` when both sides have it.
2. For historical records without ids, derive an in-memory id from strict `company + official productName`.
3. Fall back to the existing strict `company + productName` key only when the id cannot be derived.

Do not use loose OCR text to derive a new id during report calculation. If the policy cannot be matched to an official product, the report should behave as it does today and avoid pulling unrelated indicators.

## Optional Responsibility Rules

Optional responsibilities remain visible by default and excluded from calculations by default.

An optional indicator enters calculations only when all conditions are true:

- policy and indicator have the same `canonicalProductId`;
- the indicator has the same `optionalResponsibilityId` as the selected optional responsibility;
- the policy selection status is `selected`;
- the indicator `quantificationStatus` is `quantified`.

If a user selects an optional responsibility that does not have quantified indicators, it must be shown as a report gap and must not enter coverage amount, cashflow, or scenario calculations.

## Migration And Backfill

Use a progressive backfill.

Steps:

1. Add a shared `canonicalProductId` utility.
2. On read, derive missing ids for knowledge, indicator, optional responsibility, policy, and plan objects when official product names are available.
3. Add a backfill script that writes the derived ids into existing payloads.
4. Keep existing name-based fields unchanged.
5. Keep strict name fallback until all active records have ids.

Backfill scope:

- `knowledge_records`
- `insurance_indicator_records`
- `optional_responsibility_records`
- `policies`
- `policies.payload.plans[]`

The script must be idempotent. Running it twice should produce no semantic changes.

## Tests

Unit tests:

- `智享版`, `智赢版`, and `庆典版` generate different `canonicalProductId` values.
- The same official product in `knowledge_records`, `insurance_indicator_records`, and `optional_responsibility_records` generates the same id.
- Raw OCR text without an official match does not create a product id.
- Product suggestions and product matches return `canonicalProductId`.
- Editing a matched main product clears both `matchedProductName` and `canonicalProductId`.

Flow tests:

- OCR-recognized main plan persists `canonicalProductId`.
- Optional responsibilities appear in the main product confirmation section.
- Deleting a rider does not remove main-product optional responsibilities.
- Changing the main product refreshes optional responsibilities.
- Selecting `可选责任一` or `可选责任二` uses id-based matching to include only that product's quantified optional indicators.
- Similar product names with different ids do not share indicators.

Regression tests:

- Historical policies without ids still calculate by strict official product name fallback.
- Selected but unquantified optional responsibilities appear as report gaps.
- Unselected optional responsibilities do not enter report totals.

## Acceptance Criteria

For `新华人寿保险股份有限公司多倍保障重大疾病保险（智享版）`:

1. OCR completion stays on the policy entry page.
2. The main plan shows the matched official product.
3. The main plan has `canonicalProductId`.
4. The main product area shows `可选责任一` and `可选责任二`.
5. Deleting a rider does not remove those optional responsibilities.
6. Selecting `可选责任一` includes only the quantified indicators for `可选责任一`.
7. Selecting `可选责任二` includes only the quantified indicators for `可选责任二`.
8. The report does not use indicators from `智赢版`, `庆典版`, or any other similar product.

## Non-Goals

This iteration does not add a product master table.

This iteration does not change official-source crawling, indicator extraction, or optional responsibility quantification rules except for adding and using `canonicalProductId`.

This iteration does not use raw OCR product text as a stable product identity.
