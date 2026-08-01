---
name: ocr-insurance-responsibility-merge
description: Cross-merge replaceable model insurance-responsibility proposals against exact-version official evidence and emit one importer-compatible reviewed JSONL artifact. Use when bounded model branches have separately extracted liability names, customer-facing limits, and calculation metadata, and a capability-routed merge model must resolve conflicts, reject unsupported claims, preserve tiered formulas, enforce canonical OCR_insurance fields, and run dry-run validation without writing SQLite.
---

# OCR Insurance Responsibility Merge

Merge one insurance product at a time. Treat model outputs as proposals and the
official source manifest plus clause evidence as the only authority.

## Required Inputs

Obtain all of these before merging:

- Exact `company` and `productName`.
- A `source_ready` manifest from
  `$ocr-insurance-official-source-acquisition`.
- Official source URL or official document identity.
- Official responsibility-section text with page or line evidence.
- Local candidate-assistant packet and run metadata when that optional stage was
  used.
- Candidate-model source-extraction result.
- Candidate-model customer-summary and limits result.
- Candidate-model calculation-field result.

If the manifest is missing, the official text is unreadable, or the evidence does
not identify the exact product/version, stop with a blocker. Do not merge by
model consensus.

Read [references/merge-contract.md](references/merge-contract.md) before creating
the output artifact.
Read [references/formula-rule-packs.md](references/formula-rule-packs.md) before
classifying formulas, cashflow treatment, or model-routing risk.

## Workflow

1. Lock the responsibility scope.
   - Locate the actual responsibility chapter, not the table of contents.
   - Include waiting-period and shared payment restrictions that directly change
     a responsibility.
   - Keep exclusions, claims procedures, surrender value, policy loans, and
     general contract rules outside the accepted responsibility list.

2. Build the official responsibility list independently.
   - Accept only a named or clearly separable covered event/condition plus an
     insurer obligation to pay, reimburse, waive, or provide a benefit.
   - Use the official title when present.
   - Preserve an exact `sourceExcerpt` that supports the trigger, obligation, and
     formula. Do not silently correct the source wording.
   - Treat local page, title, and span candidates as proposals only. A local
     model cannot veto deterministic or official evidence.

3. Compare each model proposal with the official list.
   - Match normalized titles, then verify substance.
   - Use model details only when the official excerpt supports them.
   - Reject majority voting. Two agreeing model outputs do not override the
     official source.
   - Record every material correction in `mergeAudit`.

4. Construct customer-facing fields.
   - Keep `customerSummary`, `triggerCondition`, `insurerObligation`, and
     `importantLimits` understandable without internal calculation terminology.
   - Do not put `basisKey`, `calculationKey`, `needs_table`, validation status, or
     model disagreement into customer-facing fields.
   - Do not copy the entire exclusions chapter into `importantLimits`.
   - Require every important limit to appear in that responsibility's
     `sourceExcerpt` or page-specific evidence segments.

5. Construct calculation fields.
   - Select rules from the clause's obligation and formula shape, not from the
     product name. One product may use disease, annuity, life, medical, and
     accident packs together.
   - Preserve `max(...)`, age bands, policy-year bands, benefit stages, caps, and
     multiple formula branches exactly.
   - Never collapse a tiered formula to one percentage or one amount.
   - Set `cashflowTreatment` to `scheduled_cashflow` only for contractually
     scheduled payments; use `claim_contingent` for insured-event benefits and
     `waiver_only` for premium waiver.
   - Use `manual_formula` when repository-supported deterministic keys cannot
     represent the full formula.
   - For `manual_formula`, provide explicit `requiredInputs`.
   - Use only canonical inputs listed in the merge contract. Never invent a
     plausible field such as `policy.totalPaidPremium` or
     `insured.ageAtClaim`.
   - Use `manualFormulaInputs` with a named missing operand when the contract
     requires an event-date cumulative premium that current policy fields cannot
     derive exactly.
   - Write `basis` as the formula's calculation basis, not as the covered event
     or trigger condition.
   - Use `basisKey: cash_value` when cash value is a material basis and
     `calculationKey: manual_formula` when the repository cannot represent the
     complete expression.
   - When a concrete result cannot be calculated, omit `value`; do not use zero,
     a guessed amount, or a representative percentage.
   - Use `calculationEligible: false` and explain the missing inputs in
     `calculationReason`.

6. Emit exactly one JSON object followed by a newline.
   - Save as JSONL at the user-specified path.
   - If no output path is specified, use a unique file under `/tmp`.
   - Do not overwrite official text or candidate branch outputs.
   - Do not write `.runtime`, SQLite, or Feishu unless the user explicitly asks.

7. Run the importer dry-run:

```bash
node scripts/import-reviewed-responsibility-artifacts.mjs \
  --db-path=.runtime/local/policy-ocr.sqlite \
  --artifacts='<merged.jsonl>' \
  --sample-limit=5
```

Require all of these:

```text
ok == true
validationIssueCount == 0
acceptedResponsibilities == expected official responsibility count
validationFailures is empty
all requiredInputs belong to the canonical dictionary
every important limit is covered by official evidence
```

Fix the artifact and rerun if any condition fails. A successful dry-run validates
shape and required fields; it does not prove source fidelity, so perform one
final excerpt-to-field comparison before reporting success.

## Model Routing

- Programmatically auto-merge responsibilities whose official title, offsets,
  numeric coverage, formula branch count, and canonical inputs all pass.
- Complexity alone is not an escalation reason. Keep complete tables and
  multi-branch or `max`/`min` formulas deterministic when their structure is
  provable, using `manual_formula` when necessary.
- Use the configured verifier model only for unresolved responsibility
  ownership, branch scope, proposal conflict, or formula/table interpretation.
- Send the verifier one responsibility packet plus its applicable shared
  clauses, not the full document.
- Route missing pages, truncated clauses, unreadable OCR numbers, and damaged
  table structure back to source repair rather than a stronger model.
- Use the configured high-capability reviewer only after verification still
  leaves a semantic or package-boundary conflict. Source/version and evidence
  defects remain source-repair blockers.
- Select each role by measured capability and price. Keep provider names and
  model IDs in run metadata, never in the stable workflow schema.
- Do not retry the same model with unchanged evidence.
- Regenerate final evidence from official section offsets after every model
  response, then rerun all deterministic gates.

## Final Response

Report:

- Output JSONL path.
- Official responsibility count and accepted titles.
- Material model-proposal conflicts corrected.
- Dry-run result.
- Whether any database or runtime file was written.

Do not claim import completion from a dry-run.
