# Project Harness Design

## Purpose

This project needs a local harness that makes Codex fast without making it reckless. The harness should protect the local production stack and real configuration first, then use targeted verification so ordinary changes do not always require a full quality gate.

The chosen approach is production protection plus targeted verification.

## Current Project Shape

The repository is a full-stack OCR insurance product:

- `src/` contains the React/Vite frontend.
- `server/` contains the Node/Express API for auth, policies, families, cashflow, responsibilities, WeChat, and admin routes.
- `ocr-service/` contains the local OCR service, OCR field matching, fuzzy matching, config, and scan parsing.
- `tests/` contains Node test runner coverage for domain logic, OCR flows, config, SMS, stores, cashflow, and frontend ownership/style checks.
- `docs/superpowers/specs/` and `docs/superpowers/plans/` hold design and implementation planning history.

The project already has the core commands needed for a harness:

- `npm run local:dev`
- `npm run local:dev:stop`
- `npm run local:dev:status`
- `npm run local:status`
- `npm run check`
- `npm run typecheck`
- `npm test`
- `npm run build`

## Harness Files

The implementation should add or update these project-level harness files:

- `AGENTS.md`: project-specific Codex instructions.
- `docs/architecture.md`: concise architecture map and module boundaries.
- `docs/harness.md`: verification matrix and operating rules.
- `scripts/check.sh`: full quality gate.
- `scripts/dev.sh`: safe development stack entrypoint.
- `scripts/test.sh`: test entrypoint with optional focused modes.

These files should stay small and practical. They are not a replacement for README; they are operational instructions for humans and Codex working in the repository.

## Production Protection Rules

The harness must make development safe around the local production environment.

Default actions should use the development stack:

- Start: `npm run local:dev`
- Stop: `npm run local:dev:stop`
- Status: `npm run local:status`

Codex should not start, stop, restart, or modify the production stack unless the user explicitly asks:

- `npm run local:prod`
- `npm run local:prod:stop`
- `npm run local:prod:status`

Codex should not edit these without explicit user approval:

- `.env.local`
- `.runtime/`
- production SMS, WeChat, Aliyun, or deployment secrets
- generated production data

Development should assume mock SMS unless the user says otherwise. The README-documented development code is `123456`.

## Verification Matrix

The harness should prefer targeted verification during normal work:

| Change area | Required checks |
| --- | --- |
| `src/` frontend UI or client API | `npm run typecheck`, `npm run build` |
| `server/` API or domain logic | `npm run check`, `npm test` |
| `ocr-service/` OCR parsing, config, or matching | `npm run check`, `npm test` |
| `tests/` only | `npm test` |
| `package.json`, `tsconfig.json`, `vite.config.ts`, or shared runtime config | `npm run check`, `npm run typecheck`, `npm test`, `npm run build` |
| Cross-boundary changes across `src/`, `server/`, and `ocr-service/` | `npm run check`, `npm run typecheck`, `npm test`, `npm run build` |
| Documentation only | no code verification required unless docs change commands or architecture rules |

If the changed code touches insurance responsibility analysis, OCR field extraction, family report logic, cashflow, policy validity, SMS, WeChat, or SQLite persistence, Codex should also look for the nearest relevant test and run it directly when practical before or alongside `npm test`.

## Coding Behavior

Project coding should follow the global Karpathy Guidelines:

- Think before coding and surface assumptions.
- Prefer the simplest implementation that solves the request.
- Make surgical changes only.
- Define verifiable success criteria and verify the result.

Additional project-specific behavior:

- Keep business logic out of React components when it already belongs in `server/`, `ocr-service/`, or engine modules.
- Keep route handlers thin; prefer domain or service modules for reusable logic.
- Preserve existing local development and production port separation.
- Do not convert `.mjs` server modules to a new module system as part of unrelated work.
- Do not introduce new dependencies when existing Node, React, or project utilities are enough.
- Keep tests near the behavior they protect, using the existing Node test runner style.

## Script Design

`scripts/dev.sh` should be a safe wrapper around development-only commands:

- Default action: start the dev stack.
- `status`: run `npm run local:status`.
- `stop`: run `npm run local:dev:stop`.
- It should not call production commands.

`scripts/check.sh` should run the full quality gate:

1. `npm run check`
2. `npm run typecheck`
3. `npm test`
4. `npm run build`

`scripts/test.sh` should provide a simple test entrypoint:

- With no arguments, run `npm test`.
- With arguments, pass through to `node --test` so focused test files can be run.

The scripts should use POSIX shell where practical and avoid project-specific machine paths.

## Success Criteria

The harness is successful when:

- A new Codex session can read project rules from `AGENTS.md`.
- Humans and Codex can find architecture boundaries in `docs/architecture.md`.
- `docs/harness.md` clearly tells which verification commands to run for each change type.
- Development helper scripts start and verify the dev workflow without touching local production.
- Full verification is available through one command.
- The implementation does not modify secrets, runtime data, generated outputs, or unrelated code.
