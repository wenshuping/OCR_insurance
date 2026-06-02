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

## Completion Rules

Before saying work is complete:

- State which verification commands ran.
- State any verification command that was skipped and why.
- Mention if local production was intentionally untouched.
- Keep unrelated untracked or modified files out of commits and summaries unless they affect the task.
