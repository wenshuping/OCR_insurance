# Optional Responsibility Quantification Governance Design

Date: 2026-05-31

## Goal

Build a governance loop for insurance products that have optional responsibilities. The system must not silently ignore optional coverage, and it must not count optional coverage unless the policy confirms it was selected and the responsibility has quantified indicators.

The selected approach is a governance loop:

- Detect every optional responsibility from official terms and local knowledge records.
- Track whether each optional responsibility has been quantified.
- Let the user confirm whether the policy selected each optional responsibility.
- Include only selected and quantified optional indicators in family reports, coverage amounts, cashflow, and scenario calculations.
- Surface gaps when an optional responsibility is selected but not quantified.

## Core Principle

Optional responsibilities are visible by default and excluded from calculations by default.

An optional indicator enters calculations only when all conditions are true:

- The policy-level selection status is `selected`.
- The indicator has `responsibilityScope = optional`.
- The indicator has `quantificationStatus = quantified`.

If an optional responsibility is selected but not quantified, the UI and reports must show the gap explicitly.

## Data Model

### optionalResponsibilities

Each product can have one or more optional responsibility records.

Fields:

- `id`: stable identifier for the product responsibility.
- `company`: insurer name.
- `productName`: official product name.
- `liability`: canonical optional section, such as `可选责任一` or `可选责任二`.
- `title`: display name when it differs from `liability`.
- `sourceExcerpt`: official terms excerpt proving the responsibility exists.
- `quantificationStatus`: `quantified`, `pending_review`, or `not_quantifiable`.
- `quantificationReason`: short reason when status is not `quantified`.
- `indicatorIds`: structured indicator ids mapped to this optional responsibility.

### coverageIndicators / insuranceIndicatorRecords

Existing structured indicators remain the quantification source. Optional indicators must add:

- `responsibilityScope`: `basic` or `optional`.
- `optionalResponsibilityId`: links the indicator to the optional responsibility record.
- `quantificationStatus`: mirrors whether the indicator is usable for calculation.

Basic indicators keep existing behavior. Optional indicators without a confirmed selected status must not enter calculations.

## Recognition And Quantification Flow

Source flow:

```text
Official terms / local knowledge records
  -> optional responsibility scanner
  -> optionalResponsibilities
  -> indicator extractor
  -> insuranceIndicatorRecords
  -> quantification status update
```

Steps:

1. Detect optional responsibility sections from terms.
   Examples: `可选责任一`, `可选责任二`, `可选择投保`, `基本责任和可选责任`, `不含可选责任`.

2. Create or update `optionalResponsibilities`.
   A product with optional wording must have a visible optional responsibility record even if no indicator can be extracted yet.

3. Extract quantifiable indicators from each optional section.
   Extracted fields should include `coverageType`, `liability`, `condition`, `value`, `unit`, `basis`, `formulaText`, and `sourceExcerpt`.

4. Set quantification status.
   - `quantified`: all required fields exist for the calculation path that uses the indicator.
   - `pending_review`: the optional responsibility exists, but indicators are missing or incomplete.
   - `not_quantifiable`: the responsibility should be shown as information only and not calculated.

5. Preserve manual review.
   Manual selection and manual quantification decisions must not be overwritten by later automatic extraction unless the user explicitly triggers a refresh.

## Product Examples

For `新华人寿保险股份有限公司多倍保障重大疾病保险（智享版）`:

- The terms show optional sections such as `可选责任一`.
- The policy OCR can say the policy includes `基本责任和可选责任一`.
- The product should expose `可选责任一` in the entry flow.
- If the optional section is quantified into light illness, medium illness, waiver, or related indicators, those indicators join calculations only after the policy selection is `selected`.
- If the indicators are incomplete, the policy and family report show that `可选责任一` is selected but not quantified.

## Frontend Entry Flow

After responsibility generation, the entry page shows an optional responsibility confirmation panel.

Each item displays:

- optional responsibility name;
- official excerpt;
- selection controls: `已投保`, `未投保`, `不确定`;
- quantification status;
- warning text when selected but not quantified.

When the user marks an unquantified responsibility as selected, show:

```text
该可选责任已确认投保，但尚未完成指标量化，暂不进入家庭报告计算。
```

The user should not need to understand indicator internals. The user only confirms whether the policy selected the optional responsibility.

## Policy Detail And Family Report

Policy detail keeps the optional responsibility confirmation panel so a user can correct selection status later.

Family reports must include a gap section for selected optional responsibilities that are not quantified. The gap section should list:

- insured person;
- policy name;
- optional responsibility;
- quantification status;
- reason or missing fields.

Reports must not silently drop a selected but unquantified optional responsibility.

## Admin Governance

Add an admin list for optional responsibility quantification gaps.

Columns:

- insurer;
- product name;
- optional responsibility;
- quantification status;
- missing fields;
- official excerpt;
- recent policy count;
- actions.

Actions:

- view official terms;
- trigger re-extraction;
- mark as not quantifiable;
- later, attach or edit indicators.

This first version should focus on visibility and repeatable tracking. It does not need a complex indicator editor if extraction and review can produce the same state.

## Calculation Rules

Coverage, family report, cashflow, and scenario calculation should use selected indicators only.

Rules:

- Basic indicators are selected by default.
- Optional indicators are excluded unless their parent optional responsibility is `selected`.
- Optional indicators with `quantificationStatus != quantified` are excluded.
- Selected but unquantified optional responsibilities are emitted as report gaps.
- Manual `not_selected` always excludes indicators.
- Manual `unknown` excludes indicators and remains visible.

## Error Handling

If extraction detects optional wording but no clear section title:

- create a `pending_review` responsibility with the best available title;
- keep the official excerpt;
- avoid adding calculated indicators.

If a product has wording such as `基本责任，不含可选责任`:

- do not create a selected optional responsibility;
- optionally record evidence that the policy excludes optional responsibilities.

If a product has a selected optional responsibility but no official knowledge record:

- show a data gap;
- do not calculate it from OCR text alone.

## Testing And Acceptance Criteria

### Terms Recognition

- Products with `可选责任一` or `可选责任二` generate optional responsibility records.
- Products that say `不含可选责任` do not create selected optional responsibilities.
- Mentions such as `如投保可选责任一` do not get mistaken for section headers unless an actual optional section exists.

### Indicator Extraction

- Optional section benefits such as light illness, medium illness, waiver, death benefit, nursing benefit, or annuity payout become optional indicators when formula fields are complete.
- Optional indicators include `optionalResponsibilityId`.
- Incomplete extraction results in `pending_review`, not `quantified`.

### Entry And Report Behavior

- Selected and quantified optional indicators enter calculations.
- Not selected optional indicators are excluded.
- Unknown optional indicators are excluded.
- Selected but unquantified optional responsibilities appear as gaps in policy detail and family reports.

### Admin Governance

- Admin can list all `pending_review` optional responsibilities.
- Admin can filter or sort by insurer, product, optional responsibility, and recent policy count.
- Re-extraction or manual not-quantifiable decisions update status without losing source evidence.

## Out Of Scope For First Implementation

- A full visual indicator editing studio.
- Rebuilding all historical reports automatically.
- Using OCR-only policy text as the source of official formulas.
- Counting selected but unquantified optional responsibilities in calculations.
