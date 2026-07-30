# Universal-Account Extraction Contract

## Evidence order

1. Exact substantive clause in the current official terms PDF.
2. Exact approved customer policy terms when that is the product-specific
   source in scope.
3. Official insurer disclosure that explicitly identifies the same product and
   version.

Do not use a contents page, a term glossary, a product brochure, a nearby
product, or a model-generated statement as final numeric evidence.

## Field contract

| Customer field | Required evidence | Examples |
| --- | --- | --- |
| 最低保证利率 | Clause title plus exact annual rate | `最低保证利率为年利率 2%` |
| 账户结算 | Settlement cadence and calculation method | Monthly published rate; daily compounding |
| 初始费用 | Charge basis and rate/tiers when stated | Single premium 3%; additional premium 3% |
| 保单管理费 | Charge cadence and amount/rate | Monthly deduction; 0 yuan per month |
| 部分领取/退保手续费 | Formula, tier table, limits | `部分领取金额 × 手续费率`; policy-year tiers |
| 领取/退保条件 | Eligibility, timing, amount/frequency and remaining-account limits | Partial withdrawal only after the stated period; minimum account value |
| 账户价值 | Definition and applicable formula | Account value plus/minus stated items |

## Acceptance gates

- A rate/fee percentage displayed to a customer must be an exact numeric token
  in the selected source article.
- If a source says the settlement rate is not lower than the guaranteed rate,
  but does not state the guarantee's number, display the rule without inventing
  a number and route the product to source review.
- Preserve every stated fee tier and limit when they materially change the
  customer outcome. Do not compress a tier table into one invented rate.
- Record initial charges for single-premium and additional-premium payments as
  separate fields. If one is absent from the official terms, leave that field
  absent and explain the evidence gap; do not copy the other charge.
- A partial-withdrawal or surrender condition is not proved by a fee table
  alone. Preserve the separate eligibility, amount, frequency, and remaining-
  account restrictions when the source states them.
- Exclude reading-guide, contents, glossary and duplicate-heading text from
  the customer block.
- Do not enable `productFunctions` when none of the account fields is supported
  by evidence.

## Data and readback checklist

- Check exact company, product name, source URL and source digest.
- Confirm stored `pageText` contains the final displayed rate/fee token.
- Confirm the account record, approved responsibility artifact, responsibility
  cards, indicators, and customer summary all use the same exact source digest
  and source evidence. A source URL match with a digest mismatch is a version
  conflict, not a successful readback.
- Confirm responsibility-card and indicator payloads preserve
  `formulaText`, `normalizedFormula`, `requiredInputs`, `operands`, `branches`,
  and `responsibilitySourceDigest` when present. Confirm ordinary cards and
  indicators remain unchanged unless they are explicitly in the authorized
  write scope.
- Query the customer-summary endpoint and verify its rendered block matches
  the stored official evidence.
