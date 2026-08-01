# Unified Routing Matrix

## Ownership and delegated Skills

| Source-backed responsibility semantics | `ownerProfile` | Delegated Skill | Typical `paymentProfile` |
| --- | --- | --- | --- |
| Actual eligible medical expense reimbursement without accident causation | `medical_health` | `$ocr-insurance-medical-health-responsibility` | `medical_reimbursement` |
| Medical fixed payment or hospital allowance without accident causation | `medical_health` | `$ocr-insurance-medical-health-responsibility` | `fixed_benefit`, `daily_allowance` |
| Disease tier, critical-illness payment, or disease-linked waiver | `critical_illness` | `$ocr-insurance-critical-illness-responsibility` | `lump_sum`, `waiver`, `max_min_comparison` |
| Accident death/disability, accident medical, accident allowance, or accident extra payment | `accident` | `$ocr-insurance-accident-responsibility` | `lump_sum`, `disability_table`, `medical_reimbursement`, `daily_allowance` |
| Finite-period death/total-disability obligation without maturity payment | `term_life` | `$ocr-insurance-term-life-responsibility` | `lump_sum`, `max_min_comparison` |
| Recurring survival/education/pension payment | `annuity` | `$ocr-insurance-annuity-responsibility` | `annuity` |
| ADL/cognitive/care-state or disability-income obligation | `long_term_care` | `$ocr-insurance-long-term-care-responsibility` | `lump_sum`, `periodic_care`, `waiver`, `medical_reimbursement` |
| Finite maturity-survival plus in-term death/total-disability obligation | `endowment` | `$ocr-insurance-endowment-responsibility` | `scheduled_maturity`, `lump_sum`, `max_min_comparison` |
| Lifetime death obligation without proven effective-sum-assured growth | `whole_life` | general pipeline plus whole-life boundary review | `lump_sum`, `max_min_comparison` |
| Lifetime death obligation with proven annual effective-sum-assured growth and responsibility linkage | `incremental_whole_life` | `$ocr-insurance-incremental-whole-life-responsibility` | `lump_sum`, `max_min_comparison` |
| Separately headed account-value payment obligation | owning payable domain; `universal_account` only if account is the obligation | `$ocr-insurance-universal-account-responsibility` as supplement | `account` |

## Composition precedence

Apply semantic evidence, not product-name precedence:

1. Accident causation owns accident medical and accident allowance.
2. Care-state triggers own care cash payments; actual-expense reimbursement
   remains medical only when no accident/care ownership clause governs it.
3. A separately headed accident extra inside endowment remains `accident`;
   maturity and ordinary in-term death roles remain `endowment`.
4. Universal-annuity scheduled payments remain `annuity`; guaranteed interest,
   settlement, fees, withdrawals, and account value are `productFunctions`.
5. Critical-illness waivers remain `critical_illness` with payment `waiver`.
6. If exact evidence still supports two owners, do not apply precedence. Emit
   `owner_conflict` and `manual_review`.

## Product labels and topology

Product labels may include several of:

```text
medical, critical_illness, accident, term_life, annuity, long_term_care,
endowment, universal_account, participating, whole_life,
incremental_whole_life
```

Labels select candidate profiles only. The locked responsibility packet decides
ownership.

`standalone|rider|group|bundle_component` is orthogonal:

| Topology | Required product-scope evidence | Parser effect |
| --- | --- | --- |
| `standalone` | contract's own effect and termination | none |
| `rider` | main-contract dependency and linkage | retain relationship; use same owner matrix |
| `group` | member eligibility/entry/exit and limit ownership | retain member scope; use same owner matrix |
| `bundle_component` | plan-to-filed-component mapping and component digest | inventory each filed component; use same owner matrix |

Never infer an approved topology from `附加`, `团体`, `学平`, or `学生` alone.
Those strings may form a forward-test stratum but leave the topology evidence
gate in review.

## Model route

Choose one route for the immutable product manifest:

| Route | Deterministic conditions |
| --- | --- |
| `deepseek-standard` | source-complete simple term life, ordinary annuity, or another product with few responsibilities, one formula branch, no table/max-min/ownership dispute, and no prior validation failure |
| `luna-complex` | any medical, critical illness, accident, long-term care, multi-responsibility, multi-branch, complex cashflow, table, max/min, topology/owner ambiguity, or historical validation failure |

Routing rules:

- Medical, critical illness, accident, and long-term care route to Luna even
  when the current responsibility count is small.
- Ordinary annuity can use DeepSeek only when it has simple fixed/ratio
  payments and no guarantee, option, growth, account, or complex branch.
- Simple term life can use DeepSeek only when no max/min, cash value, decreasing
  schedule, group/rider/bundle conflict, or multiple branch exists.
- A product has one primary route. A verifier sees only the bounded conflict
  packet and does not restart another full parse.
- Disable Gemini and DianJin.
- DeepSeek failure writes `model_retry` with `route=deepseek-standard`. It never
  silently enters Luna.

## Terminal routing

| First failing layer | Terminal status |
| --- | --- |
| acquisition still in progress or current byte/SHA proof absent | `source_pending` |
| official source inaccessible, damaged, unofficial, unreadable, or unproven | `source_blocked` |
| same identity has conflicting digests/versions | `version_conflict` |
| source ready but inventory/packets not built | `parse_pending` |
| deterministic artifact gate fails | `validation_review` |
| selected provider fails | `model_retry` |
| irreducible owner or responsibility ambiguity | `manual_review` |
| artifact passes but projection differs | `materializer_blocked` |
| release-gated artifact has not been imported | `approved` or `import_pending` according to release state |
| authorized import and exact readback pass | `imported` |
