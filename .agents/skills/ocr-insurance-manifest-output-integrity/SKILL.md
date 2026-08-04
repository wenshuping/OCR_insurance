---
name: ocr-insurance-manifest-output-integrity
description: Deterministically audit a locked OCR batch manifest and its selected, input, provider, artifact, and terminal outputs for sourceDigest identity integrity before canonicalization or validation. Use for batch parsing, resume/retry reconciliation, approved-artifact reuse, ordinal-shift investigations, or any run where products may be missing, duplicated, unknown, version-conflicted, or stored under the wrong output directory.
---

# OCR Insurance Manifest Output Integrity

Run the bundled identity audit before any validator, importer dry-run, model retry, or approved-artifact reuse. The audit is read-only and has no model, network, SQLite, Feishu, `.env`, or publication path.

## Identity contract

- Bind every layer by `sourceDigest` first, `sourceUrl` second, and normalized `company + productName` only as a last-resort fallback. A non-empty digest is mandatory for a releaseable row; a fallback match is an identity warning, not permission to publish.
- Treat `manifestOrder` and `selectedOrder` as display and diagnostic fields only. Never use an ordinal as a join key, never shift a row to repair a gap, and never fill a missing final row by copying the previous/last product.
- Require the same resolved digest at each layer: `selected -> input -> provider -> artifact -> terminal`. Directory names, product names, URLs, and ordinals are corroborating fields and must agree with the digest-bound manifest row.
- Treat any identity failure as `identity_blocked` or `manifest_output_identity_misaligned`, never as `validation-review`, `model-retry`, or a source failure. An approved result is reusable only after the complete identity chain passes.

## Deterministic audit

Run against a JSON fixture bundle or an immutable run directory:

```bash
python3 "$REPO/.agents/skills/ocr-insurance-manifest-output-integrity/scripts/audit_manifest_output_identity.py" \
  --manifest="$MANIFEST" --run-dir="$IMMUTABLE_RUN_DIR"
```

The command must finish before invoking a validator. Stop on a non-zero exit and preserve the JSON report. The report checks:

- manifest identity uniqueness and required digests;
- missing, duplicate, unknown, and cross-layer identity records;
- digest equality across selected/input/provider/artifact/terminal;
- non-empty digest version conflicts for the same URL or normalized product identity;
- ordinal mismatch as a diagnostic only;
- resume-last-item duplication and output-directory label versus internal identity;
- validator-before-identity-gate and blocked reuse of an otherwise approved artifact;
- terminal union equal to the full manifest and pairwise terminal-queue intersection equal to zero.

Use `--bundle` for the bundled fixture shape:

```bash
python3 "$REPO/.agents/skills/ocr-insurance-manifest-output-integrity/scripts/audit_manifest_output_identity.py" \
  --bundle="$REPO/.agents/skills/ocr-insurance-manifest-output-integrity/references/fixture-healthy.json"
```

`pass` is the only releaseable status. `identity_blocked` means a required identity/digest/version/gate precondition failed. `manifest_output_identity_misaligned` means the manifest and output sets or ordinals do not reconcile. A report may list both in `failureStatuses`.

## Batch integration order

1. Lock the immutable manifest and compute its SHA before parsing.
2. Run this audit on the selected and resumed outputs.
3. If and only if `identityGatePassed=true`, run canonicalizer, validator, and importer dry-run in their existing parse-only lanes.
4. Keep terminal queues mutually exclusive. Recompute the manifest union after every resume; do not infer completion from summary counts or successful validator/importer flags.
5. Report identity failures in the identity queue. Do not relabel them as semantic validation review or model failure.

The v2 focused regression fixture is [fixture-focused-v2.json](fixture-focused-v2.json); the clean control is [fixture-healthy.json](fixture-healthy.json). They are condensed, immutable test data derived from the 2026-08-02 v2 incident and contain no model invocation or database target.

## Tests

Run the deterministic unit tests after changing the script:

```bash
python3 "$REPO/.agents/skills/ocr-insurance-manifest-output-integrity/scripts/test_audit_manifest_output_identity.py"
```
