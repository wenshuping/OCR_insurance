---
name: ocr-insurance-incremental-whole-life-responsibility
description: Extract and verify incremental whole-life insurance responsibilities only when the official source proves the annual effective-sum-assured growth rule and its use in the death or total-disability benefit formula. Use for evidence-led responsibility cards, indicators, and customer summaries; never infer from a product name or marketing claim.
---

# Incremental Whole-Life Responsibility

Use this Skill for products described as 增额终身寿险 or similar only after the
official terms prove both the growth rule and the responsibility relationship.
The product label, sales copy, “复利”, “3.5%”, or a model conclusion alone is
not evidence.

## Hard safety boundary

- Use one exact company, productName, product key, source URL, source version,
  and `sourceDigest` per reviewed product.
- Resolve identity in this order: `sourceDigest` -> `sourceUrl` -> exact
  canonical product key. A URL or name match with a different digest is a
  version conflict. Do not merge it into the current product.
- Use only the same official source chain for the growth rule and the benefit
  clause. Do not combine a terms PDF with a different brochure, another
  version, or a similar product.
- Do not full-scan the production database to find a candidate. Query only the
  authorized exact company+productName/canonical key/digest set. Do not delete,
  rewrite, or materialize non-target products.
- Do not call a model, network source, Feishu, or ECS for a parse-only or
  readback task. If the official source/evidence is not already proven, stop as
  source-blocked and use the official-source acquisition workflow separately.

## Three deterministic gates

Accept the incremental-whole-life classification only if all three gates pass.

### Gate 1: explicit annual growth rule

The same official source chain must contain one of these equivalent forms:

1. `基本保险金额 × (1+r%)^(n-1)` explicitly defines the annual effective
   insurance amount; or
2. the first policy year effective insurance amount equals the basic insurance
   amount and every later year equals the prior year's effective insurance
   amount multiplied by `(1+r%)`, with one single explicit `r`.

Record the exact clause/article/page evidence, operands, year convention, and
the single value of `r`. If the source gives multiple rates for different
purposes, do not select one by plausibility; classify the product as blocked
until the clause role is explicit.

### Gate 2: responsibility linkage

The same source chain must state that the annual effective insurance amount is
used in a death or total-disability benefit. The clause must also show the
comparison or payment rule, such as a condition-specific comparison among
paid premiums, cash value, and effective insurance amount. Keep age bands,
payment-period branches, policy-year conditions, `max`/`min`, and termination
conditions inside the one official responsibility; do not turn formula
branches into invented separate responsibilities.

### Gate 3: semantic role separation

The artifact and customer wording must state that `r` is an insurance-amount
growth factor used in the benefit basis. It is not a guaranteed investment
return, cash-value growth rate, settlement rate, or customer yield. The
customer summary must expose uncertainty and required inputs when the exact
benefit cannot be calculated from the stored policy.

## Evidence and output contract

The approved artifact must retain, at minimum:

- exact `company`, `productName`, canonical product key, `sourceUrl`, and
  `sourceDigest`;
- `sourceExcerpt`/page evidence for Gate 1 and Gate 2;
- the unchanged formula text and a structured `normalizedFormula`;
- `operands` including the effective insurance amount and `r`;
- `branches` for age/payment-year/policy-year conditions;
- `requiredInputs`, `calculationEligible`, `calculationStatus`, and a reason
  for any unavailable calculation;
- customer-safe `customerSummary`, `triggerCondition`,
  `insurerObligation`, and `importantLimits` without internal audit terms.

Persist these fields through the existing responsibility artifact importer,
standardizer, and materializer. The corresponding responsibility card payload
and `insurance_indicator_records.payload` must retain `formulaText`,
`normalizedFormula`, `requiredInputs`, `operands`, `branches`, source URL, and
`responsibilitySourceDigest` when present. The customer responsibility summary
must use the same source digest and must not call the growth factor a yield.

## Verification workflow

1. Validate the official artifact and its exact source identity. For the
   artifact shape and deterministic dry-run, use
   `scripts/import-reviewed-responsibility-artifacts.mjs` and its focused test
   `tests/import-reviewed-responsibility-artifacts.test.mjs`.
2. Replay on an isolated development clone/database. Use
   `scripts/materialize-product-responsibility-cards.mjs` and
   `tests/materialize-product-responsibility-cards.test.mjs`; compare the
   artifact with both card nested indicators and
   `insurance_indicator_records.payload`.
3. Verify customer wording and category behavior with
   `server/product-customer-responsibility-summary.service.mjs`,
   `tests/product-customer-responsibility-summary.test.mjs`, and
   `tests/responsibility-summary-templates.test.mjs`.
4. Before any authorized production write, create a verifiable target-DB
   backup and SHA, ensure one SQLite writer, then apply only the exact target
   product set. Read back each product's knowledge/source identity, card
   payload, indicator payload, formula/inputs/operands/branches, and customer
   summary. Run foreign-key and integrity checks. A passing importer, card
   count, or `quick_check` alone is insufficient.
5. Preserve the backup and a per-product receipt with before/after counts,
   source digest, SHA, and rollback path. On any product or projection gate
   failure, roll back or isolate the complete authorized batch; never repair
   production with ad-hoc SQL.

For a knowledge-only ECS transfer, use the existing
`scripts/production-data-bundle.mjs` knowledge-bundle path only after a
target-scoped incremental package has been constructed and inspected. The
normal full database bundle is not an acceptable production sync mechanism for
this Skill.

## Success criteria

- Both formula gates and semantic role separation pass from one official source
  digest.
- Artifact, card, indicator, and customer-summary projections agree exactly on
  identity and structured formula fields.
- No non-target product row changes; no full production replacement occurs.
- Clone dry-run, focused tests, backup/SHA, serial write, exact readback, FK,
  integrity, and rollback receipt are all present before claiming completion.
