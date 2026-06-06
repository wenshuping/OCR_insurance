# Harness Audit Gate Design

## Goal

Turn the project harness from mostly written guidance into a default, executable safety gate. The first implementation slice adds a read-only audit script and wires it into the existing full check path, so high-risk harness rules fail during `scripts/check.sh` instead of depending only on memory.

The design intentionally stays lightweight. It should improve safety for local development and local production data without adding git hooks, changing runtime behavior, or auto-modifying databases.

## Problem

`docs/harness.md` currently mixes hard commands with soft process rules. Some rules already have enforcement through code or tests, but several important rules remain reminders:

- do not accidentally change production-sensitive files such as `.env.local` or `.runtime/`;
- do not leave durable responsibility data only in temporary JSON, pending scan drafts, or frontend state;
- keep optional responsibility records deduped and backed by table rows;
- make sure documented harness commands and focused tests still exist;
- review repair/backfill scripts that default to the production SQLite path.

When a rule exists only in documentation, it can be skipped under pressure. The recent optional responsibility issue showed the failure mode: a rule was written down, but it did not become an execution point until a code boundary and a test were added.

## Scope

Add one new script:

- `scripts/harness-audit.mjs`

Wire it into one existing script:

- `scripts/check.sh`

Add focused tests for the audit behavior:

- `tests/harness-audit.test.mjs`

Update harness documentation only where needed to describe the new default gate.

## Non-Goals

This design does not add:

- git hooks;
- automatic fixes;
- automatic production database rewrites;
- automatic service start, stop, or restart;
- production DB audit by default;
- a broad cleanup of existing repair, crawl, or backfill scripts.

The first version is a read-only gate. Any future automatic repair or stronger production protection should be designed separately.

## Command Shape

The primary command is:

```bash
node scripts/harness-audit.mjs
```

`scripts/check.sh` should run it before the expensive quality gate steps:

```bash
node scripts/harness-audit.mjs
npm run check
npm run typecheck
npm test
npm run build
```

The audit should print a compact report with sections:

- `passed`
- `failed`
- `warnings`
- `skipped`

If any failure exists, the script exits with status `1`. Warnings and skipped checks do not fail the command.

## Checks

### 1. Production-Sensitive File Changes

The audit reads `git status --porcelain` and fails when tracked or untracked changes touch production-sensitive paths:

- `.env.local`
- `.runtime/policy-ocr.sqlite`
- `.runtime/policy-ocr-config.json`
- `.runtime/sms-delivery-config.json`
- `.runtime/feishu-*.json`
- `.runtime/*secret*`
- `.runtime/*credential*`
- `.runtime/*token*`

Allowed runtime paths should remain narrow and explicit:

- `.runtime/local/**` for development data;
- `.runtime/logs/**`;
- `.runtime/pids/**`;
- `.runtime/tmp/**`;
- `.runtime/backups/**`;
- test databases whose names start with `test-` or are created by existing tests.

The audit is conservative: when a changed `.runtime/` path is not clearly allowed, it should fail and ask for explicit review.

### 2. Harness Execution Points

The audit verifies that documented commands and files still exist:

- `scripts/check.sh`
- `scripts/test.sh`
- `scripts/dev.sh`
- npm scripts `check`, `typecheck`, `test`, and `build`
- focused optional responsibility test files:
  - `tests/policy-ocr-mapping.test.mjs`
  - `tests/policy-optional-responsibility.test.mjs`
  - `tests/optional-responsibility-governance.test.mjs`
  - `tests/customer-policy-form.test.mjs`
  - `tests/policy-ocr-flow.test.mjs`

It should also verify that `scripts/check.sh` invokes `scripts/harness-audit.mjs`, preventing future edits from silently removing the gate.

### 3. Optional Responsibility SQLite Audit

By default, this check reads the development database:

```text
.runtime/local/policy-ocr.sqlite
```

If the file does not exist, the check is skipped with a clear message. Missing local development data should not block a clean checkout.

When the database exists, the audit runs read-only queries against:

- `optional_responsibility_records`
- `insurance_indicator_records`

Failures:

- duplicate optional responsibility semantic rows by `company + product_name + liability`;
- `optional_responsibility_records.payload.sourceExcerpt` empty for rows that are not explicitly `not_quantifiable`;
- product names that look like clause fragments, such as `确定，在本合同`;
- optional indicators whose `payload.optionalResponsibilityId` points to no row in `optional_responsibility_records`.

The audit should report counts and representative rows, not full payloads.

### 4. High-Risk Script Defaults

The audit scans `scripts/*.mjs` for scripts that default to the production database:

```text
.runtime/policy-ocr.sqlite
```

The first version should warn, not fail, unless a script both:

- defaults to the production database; and
- appears to write without any recognizable safety control such as `dryRun`, `--dry-run`, `--write`, `readOnly`, backup creation, or an explicit write flag.

The check should be intentionally simple and transparent. It is better to produce a small actionable warning list than to invent a brittle static analyzer.

## Data Flow

```text
scripts/check.sh
  -> node scripts/harness-audit.mjs
      -> git status read
      -> package.json read
      -> docs/harness.md read
      -> scripts/*.mjs read
      -> optional read-only SQLite queries on .runtime/local/policy-ocr.sqlite
  -> npm run check
  -> npm run typecheck
  -> npm test
  -> npm run build
```

No step writes application state or runtime data.

## Error Handling

The audit should avoid noisy stack traces for expected failure modes. It should print a short failure summary and the exact check that failed.

Expected non-fatal cases:

- development DB missing;
- git unavailable;
- optional DB table missing in a fresh or old local database.

Expected fatal cases:

- sensitive production path changed;
- required harness command missing;
- `scripts/check.sh` no longer invokes the audit;
- optional responsibility table has semantic duplicates, bad product names, missing linked records, or blank durable excerpts.

## Test Plan

Add unit-style tests around exported audit helpers, not just the CLI.

Test cases:

- sensitive path detection fails for `.env.local`;
- allowed runtime temp paths do not fail;
- missing development DB produces a skipped result;
- duplicate optional responsibility rows fail;
- blank optional responsibility excerpt fails;
- indicator pointing to a missing optional responsibility fails;
- required npm script or harness script missing fails;
- `scripts/check.sh` without `harness-audit` fails.

Run commands:

```bash
node --test tests/harness-audit.test.mjs
npm run check
```

Because `npm test` currently has known unrelated `customer-ui-style.test.mjs` failures, implementation reporting should distinguish new harness failures from existing UI test failures.

## Rollout

1. Add `scripts/harness-audit.mjs` in read-only mode.
2. Add focused tests.
3. Wire the audit into `scripts/check.sh`.
4. Run the focused test.
5. Run `npm run check`.
6. Run `npm test` and report any pre-existing failures separately.

The audit should start with conservative failures and warnings. If a warning proves consistently important and low-noise, it can become a failure in a later design.

## Success Criteria

- `scripts/check.sh` fails when a production-sensitive file is modified.
- `scripts/check.sh` fails when required harness execution points are missing.
- `scripts/check.sh` fails when local development optional responsibility records have duplicates, blank durable excerpts, bad product names, or broken optional indicator links.
- Missing `.runtime/local/policy-ocr.sqlite` skips the DB audit without failing.
- The audit is read-only and does not start, stop, or restart services.
