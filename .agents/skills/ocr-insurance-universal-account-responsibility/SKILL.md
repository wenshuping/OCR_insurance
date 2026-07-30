---
name: ocr-insurance-universal-account-responsibility
description: Parse, repair, and verify universal-account or investment-linked insurance responsibilities from official policy terms. Use when a product needs customer-facing minimum guaranteed interest, account settlement, account fees, partial-withdrawal fees, account value formulas, or when responsibility cards omit those fields despite official terms being available.
---

# Universal-Account Responsibility Parsing

Read [references/contract.md](references/contract.md) before changing code,
SQLite, or published responsibility cards.

## Scope and Safety

- Use only official insurer terms, an approved customer policy terms source, or
  a source whose provenance is already verified. Do not infer a rate or fee
  from a product name, marketing copy, or a similar product.
- Keep the account supplement, ordinary responsibilities, and customer summary
  on one exact source version. Every displayed account fact must carry the same
  `sourceDigest` and source evidence as the approved product artifact; a
  matching URL without a matching digest is a version conflict.
- Treat each product version independently. The same product name may have a
  different minimum guaranteed rate or fee table in a later version.
- Preserve the existing approved responsibility cards and indicators unless an
  authorized review or backfill explicitly replaces them.
- For any SQLite write, first identify the exact database, make a backup, scope
  the update to the exact company/product/source digest, and read it back.
- Never publish or bulk-backfill merely because a parser succeeds. Use a
  digest-pinned manifest and source-backed acceptance gates.

## Workflow

1. Confirm the product is universal-account or investment-linked from the
   official terms, not only a name keyword. Locate the exact official PDF and
   retain URL, digest, version and page/character evidence.
2. Build the ordinary insurance-responsibility inventory first. Then extract
   the account supplement separately; do not let account definitions replace
   death, maturity, survival, medical, or accident responsibilities.
3. Prefer the substantive article body (`第 X 条`) over a contents page,
   reading guide, glossary, or an earlier repeated heading. For duplicate
   headings, select the final substantive article and stop at the next article.
4. Extract only source-backed account functions. Keep the exact percentage,
   tier, period, formula, and limit when present:
   - minimum guaranteed annual interest rate;
   - settlement rate and settlement cadence/method, when the official terms
     state them;
   - initial charges separately for single-premium and additional-premium
     payments;
   - policy-management fee and risk/other stated account fees;
   - partial-withdrawal and surrender charges, including policy-year tiers,
     minimum/maximum amounts, frequency, and remaining-account limits;
   - account-value rules and the conditions for withdrawal or surrender.
   Missing evidence is an explicit omission or blocker; never fill it from a
   marketing page, another version, or a common industry rate.
5. Persist the bounded source text with the knowledge record. The source text
   must contain the numerical rule used by the card; a bare heading such as
   “最低保证利率” is insufficient.
6. For a published responsibility-card fast path, read the matching product's
   approved cards and its scoped knowledge records. Render account functions
   deterministically from those official records; do not call a model when
   cards already exist.
7. Run the gates in the reference, then test the customer-summary API. Verify
   that `productFunctions` is enabled only when it has concrete content and
   that it contains no contents-page or reading-guide text.
8. If an authorized SQLite update is requested, write the scoped knowledge,
   approved responsibility artifact, responsibility cards, indicators, and
   customer summary through the existing project flow. Do not use ad-hoc SQL
   to repair one projection. Read back all three projections by exact
   company+productName+sourceDigest before accepting the update.

## Required Customer Output

Use `contentBlocks.productFunctions` for the customer-facing supplement. Show
only sections supported by the actual policy version:

- `最低保证利率` — exact annual rate or a precise statement that the terms do
  not state one.
- `账户结算` — settlement frequency, published rate and compounding method.
- `账户费用` — initial charges for single/additional premium, policy-management
  and risk/other fees, plus partial-withdrawal or surrender fees and applicable
  tiers/limits.
- `领取/退保条件` — only the source-backed conditions and limits for partial
  withdrawal or surrender.

Keep this compact and readable. Do not expose internal state, model routing,
raw OCR confidence, database IDs, or a generic dictionary definition as the
customer explanation.

## Implementation Boundaries

- Keep source selection and article extraction in the knowledge/source layer.
- Keep responsibility-card rendering in the customer-summary service; route
  handlers should only supply scoped records.
- The approved responsibility artifact is the authority for ordinary
  responsibilities; account fields belong in the account/product-functions
  supplement unless an official clause defines a separate payable
  responsibility. Indicators must retain `formulaText`, `normalizedFormula`,
  `requiredInputs`, `operands`, `branches`, `sourceUrl`, and
  `responsibilitySourceDigest` when those fields exist.
- Make the quality gate reject a universal product when official source text
  contains rate/settlement/fee evidence but the output hides or omits the
  product-functions block.
- Bump the customer-summary cache version when the output contract changes so
  stale summaries cannot mask the correction.

## Verification

Run focused tests that cover all of the following:

1. A contents-page heading and a later article body with a different numeric
   rate: retain the article body number.
2. A fast-path card response: return `source: database`, no model invocation,
   and the enabled product-functions block.
3. A fee rule with a numeric rate or tier: preserve the numeric value.
4. A universal source with relevant account terms but no rendered account block:
   fail the quality gate.
5. Exact readback: the knowledge payload/source text, responsibility-card
   payload, indicator payload, and customer summary all reference the same
   product identity and source digest; formulas/required inputs/operands/
   branches are preserved, and absent official fields remain absent.

For code changes, run `npm run check`, `npm test`, `npm run typecheck`, and
`npm run build`. The closest repository tests are
`tests/responsibility-section-extractor.test.mjs`,
`tests/responsibility-summary-templates.test.mjs`,
`tests/product-customer-responsibility-summary.test.mjs`,
`tests/import-reviewed-responsibility-artifacts.test.mjs`, and
`tests/materialize-product-responsibility-cards.test.mjs`.

For an authorized development data repair, use a clone/dry-run first, then
call the real customer-summary API after exact readback; do not accept a unit
test, importer `ok`, or `PRAGMA quick_check` alone.
