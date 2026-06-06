# Project Harness

## Goal

The harness keeps development fast while protecting local production data and configuration. Use targeted verification for normal work and full verification for config, cross-boundary, or release-sensitive changes.

## Safe Defaults

Use development commands by default:

```bash
npm run local:dev
npm run local:dev:stop
npm run local:status
```

The safe wrapper is:

```bash
./scripts/dev.sh
./scripts/dev.sh stop
./scripts/dev.sh status
```

Do not run local production commands unless the user explicitly asks:

```bash
npm run local:prod
npm run local:prod:stop
npm run local:prod:status
```

Do not edit these without explicit user approval:

- `.env.local`
- `.runtime/`
- production SMS, WeChat, Aliyun, or deployment secrets
- generated production data

## Persistence Rules

Persist application, user, OCR, policy, responsibility, family report, cashflow, and workflow data through the database-backed stores. Do not use run-time temporary files, generated JSON/CSV files, or scratch files under locations such as `run/`, `.runtime/`, or `/tmp` as an intermediate or alternate source of truth.

Temporary files are allowed only for disposable process artifacts such as pids, logs, upload scratch space, caches, or transient OCR inputs. When a workflow produces durable data, write it directly into the database through the existing persistence layer; do not park it in a run file first and import it later.

## Verification Matrix

| Change area | Required checks |
| --- | --- |
| Frontend `src/` UI or client API | `npm run typecheck`, `npm run build` |
| API or domain `server/` code | `npm run check`, `npm test` |
| OCR `ocr-service/` code | `npm run check`, `npm test` |
| Tests only | `npm test` |
| `package.json`, `tsconfig.json`, `vite.config.ts`, or runtime config | `npm run check`, `npm run typecheck`, `npm test`, `npm run build` |
| Cross-boundary changes across `src/`, `server/`, and `ocr-service/` | `npm run check`, `npm run typecheck`, `npm test`, `npm run build` |
| Documentation only | No code verification unless docs change commands, architecture, or safety rules |

Run the full quality gate with:

```bash
./scripts/check.sh
```

Run all tests with:

```bash
./scripts/test.sh
```

Run focused tests with:

```bash
./scripts/test.sh tests/policy-ocr-flow.test.mjs
```

## High-Risk Areas

When changing any of these areas, look for the closest focused test and run it when practical:

- insurance responsibility analysis
- OCR field extraction and matching
- family report logic
- cashflow calculation or persistence
- policy validity
- SMS behavior
- WeChat behavior
- SQLite persistence
- local stack scripts or ports

## OCR Optional Responsibility Guardrails

When changing policy OCR product matching, plan filtering, optional responsibility extraction, optional responsibility id generation, or related backfill/repair scripts, guard against historical ids turning into duplicate confirmation cards.

Required checks:

- Do not use arbitrary OCR text fragments as product names. Product names must come from an accepted official product match, a main plan match, a policy name that passed product filtering, or a knowledge record product/title. Clause fragments such as `确定，在本合同` must not become plan or optional responsibility product names.
- Treat `optionalResponsibilityId` as a stable historical link, not as the only duplicate key. Merge UI/review candidates by semantic key first: `canonicalProductId` when present, otherwise `company + productName`, plus `liability`.
- Historical optional responsibility rows may have ids generated from older seeds. Do not assume two different `opt_*` ids mean two different responsibilities until product and liability have been compared.
- Existing optional responsibility records must be preserved for indicator links, but new rebuild/backfill logic must not create an additional row or review card for the same product and liability.
- Optional responsibility product knowledge must be persisted in `optional_responsibility_records`; do not leave durable optional responsibility content only in policy payloads, pending scan drafts, frontend state, or analysis JSON. Any route that persists newly recognized policy/knowledge state must run optional responsibility governance before writing SQLite.
- OCR evidence such as `基本责任和可选责任一` should set selection status for `可选责任一`; it should not create a rider product or a generic duplicated optional responsibility.
- Similar products such as `多倍保障重大疾病保险（智享版）` and `多倍保障重大疾病保险（智赢版）` must stay separate, but each product should show each `可选责任一/二` only once.

Before completing these changes, run a focused duplicate inspection against the development database when practical:

```sql
SELECT company, product_name, liability, COUNT(*) AS count, group_concat(id, ' | ') AS ids
FROM optional_responsibility_records
GROUP BY company, product_name, liability
HAVING COUNT(*) > 1;
```

For OCR review regressions, include a case where the policy page contains both the official product name and clause text like `可选责任一经确定，在本合同保险期间内不得变更`. The expected result is:

- the matched product remains the official main product;
- no plan/rider is created from `确定，在本合同`;
- `可选责任一` and `可选责任二` are not duplicated;
- selected optional indicators still link through their historical `optionalResponsibilityId`.

Closest focused tests:

```bash
node --test tests/policy-ocr-mapping.test.mjs
node --test tests/policy-optional-responsibility.test.mjs
node --test tests/optional-responsibility-governance.test.mjs
node --test tests/customer-policy-form.test.mjs
node --test tests/policy-ocr-flow.test.mjs --test-name-pattern "recognize persists optional responsibility governance records to sqlite table"
```

## Completion Rules

Before saying work is complete:

- State which verification commands ran.
- State any verification command that was skipped and why.
- Mention if local production was intentionally untouched.
- Keep unrelated untracked or modified files out of commits and summaries unless they affect the task.
