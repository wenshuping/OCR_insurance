# OCR Insurance Project Instructions

## First Reads

Before code changes, read the nearest `AGENTS.md` plus these project docs when relevant:

- `README.md` for local development and production commands.
- `docs/architecture.md` for module boundaries.
- `docs/harness.md` for verification and safety rules.
- Existing specs or plans under `docs/superpowers/` when continuing planned work.

## Coding Standard

Use the global `karpathy-guidelines` skill for every code-writing, code-review, debugging, or refactoring task.

Project rules:

- Make surgical changes and keep every changed line tied to the request.
- Prefer existing project patterns over new abstractions.
- Keep business logic out of React components when it belongs in `server/`, `ocr-service/`, or engine modules.
- Keep route handlers thin; put reusable behavior in domain or service modules.
- Keep Node backend and OCR modules as ESM `.mjs` unless the task explicitly requires otherwise.
- Do not add dependencies when existing Node, React, or local utilities are enough.
- Add or update focused tests for changed domain behavior when practical.

## Local Environment Safety

Default to the development stack:

- Start development: `npm run local:dev`
- Stop development: `npm run local:dev:stop`
- Check status: `npm run local:status`

Do not start, stop, restart, or modify local production unless the user explicitly asks:

- `npm run local:prod`
- `npm run local:prod:stop`
- `npm run local:prod:status`

Do not edit these without explicit user approval:

- `.env.local`
- `.runtime/`
- production SMS, WeChat, Aliyun, or deployment secrets
- generated production data

Development assumes mock SMS unless the user says otherwise. The development verification code documented in `README.md` is `123456`.

## Verification

Use targeted verification while developing:

- Frontend `src/` changes: `npm run typecheck` and `npm run build`.
- API or domain `server/` changes: `npm run check` and `npm test`.
- OCR `ocr-service/` changes: `npm run check` and `npm test`.
- Tests-only changes: `npm test`.
- Config or cross-boundary changes: `npm run check`, `npm run typecheck`, `npm test`, and `npm run build`.

For insurance responsibility analysis, OCR field extraction, family reports, cashflow, policy validity, SMS, WeChat, or SQLite persistence, also run the nearest focused test when practical.

If verification cannot be run, say exactly which command was skipped and why.
