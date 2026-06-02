# Architecture

## Overview

OCR Insurance is a local full-stack insurance policy OCR product. It combines a React/Vite frontend, a Node/Express application API, a local OCR service, and Node test-runner coverage for policy, cashflow, family report, OCR, and persistence behavior.

## Runtime Stacks

Development and local production are intentionally separate.

Development:

- Frontend: `http://localhost:3014`
- API: `http://localhost:4207`
- OCR: `http://localhost:4109`
- Data: `.runtime/local/`
- SMS: mock mode, code `123456`

Local production:

- Frontend: `http://localhost:3013`
- API: `http://localhost:4206`
- OCR: `http://localhost:4105`
- Data: `.runtime/`
- Config: `.env.local`

Codex work should default to development and should not touch local production without explicit user approval.

## Module Boundaries

`src/` contains the frontend:

- `src/apps/` holds app shells such as customer and admin experiences.
- `src/features/` holds feature-focused UI and client workflows.
- `src/api/` holds API clients and contracts.
- `src/shared/` holds shared frontend utilities and reusable UI helpers.
- Engine files such as `cashflow-engine.mjs`, `family-report-engine.mjs`, and `policy-validity.mjs` hold domain calculations shared with tests.

`server/` contains the application API:

- `server/index.mjs` starts the API service.
- `server/app.mjs` wires the Express app.
- `server/routes/` contains route modules.
- `server/services/` contains workflow services.
- Domain modules handle cashflow, policy OCR mapping, responsibility queries, family profiles, SMS, WeChat, Feishu knowledge, and SQLite persistence.

`ocr-service/` contains OCR-specific service code:

- `ocr-service/index.mjs` starts the OCR service.
- `ocr-service/router.mjs` and `app.mjs` expose OCR endpoints.
- Field schema, matching, fuzzy matching, config, and scan parsing stay in this boundary.
- Platform OCR helpers live under `ocr-service/scripts/`.

`tests/` contains Node test-runner tests:

- Tests are named by behavior or module.
- Prefer adding focused regression tests near the behavior being changed.
- Use existing test style before introducing new test helpers.

`scripts/` contains local operations, crawlers, data repair, sync, and harness wrappers. Harness scripts should be thin wrappers around existing npm commands.

## Data Flow

Typical policy OCR flow:

1. The frontend uploads policy images or PDFs through API clients.
2. `server/` receives policy workflows and calls OCR runtime/client modules.
3. `ocr-service/` extracts and normalizes policy fields.
4. `server/` maps OCR output into policy domain records, responsibility data, cashflow, and family reports.
5. SQLite-backed stores persist local application state.
6. The frontend renders policy details, family reports, responsibilities, and exports.

## Change Guidance

- UI state and rendering belong in `src/`.
- API request handling belongs in `server/routes/`.
- Reusable business workflows belong in `server/services/` or focused domain modules.
- OCR extraction, matching, and scan parsing belong in `ocr-service/`.
- Shared calculations should stay in engine/domain modules with tests.
- Do not move responsibilities across boundaries unless the task is explicitly about architecture.
