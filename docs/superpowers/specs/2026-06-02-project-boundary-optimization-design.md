# Project Boundary Optimization Design

Date: 2026-06-02

## Goal

Improve development speed and architecture clarity in `OCR_insurance` by turning the current large application entry files into well-owned backend routes/services and frontend feature modules.

This is a behavior-preserving architecture refactor. It does not change product behavior, API URLs, database tables, UI design, or deployment topology.

## Current State

The project is a modular monolith with an OCR sidecar:

```text
React app
  -> src/api.ts
  -> Express API server
       -> SQLite state store
       -> policy / family / cashflow / knowledge domain modules
       -> OCR service sidecar
       -> crawler / Feishu / admin scripts
```

The current structure has good foundations:

- OCR service already has a clear sidecar boundary.
- Domain modules exist for policy OCR, family profile, cashflow, knowledge, and governance.
- Graphify found no import cycles in the current graph.
- Existing tests cover key policy, family, cashflow, responsibility, OCR, and UI behavior.

The main architecture problem is not the technology stack. The problem is ownership concentration:

- `server/app.mjs` is the central Express file for auth, admin, policy, family, share, responsibility, cashflow, WeChat, OCR workflow, and report generation.
- `src/App.tsx` is the central frontend file for customer app, admin app, policy entry, policy details, family profile, family report, responsibility assistant, PDF export, JPG export, canvas rendering, and UI helpers.
- `src/api.ts` carries broad client API functions and many shared data contracts in one file.
- SQLite state ownership is implicit: route handlers and services can reason across many state areas without a clear owner boundary.

## Non-Goals

This design intentionally does not include:

- Migrating SQLite to Postgres.
- Splitting into distributed microservices.
- Changing public API URLs or response shapes.
- Reworking the UI design.
- Introducing Redux, Zustand, or another state management framework.
- Replacing the local stack scripts.
- Changing insurer crawler behavior.

## Architecture Overview

The first optimization slice should keep the runtime shape stable:

```text
React feature modules
  -> grouped API contracts/client
  -> Express app shell
       -> owner route modules
       -> owner workflow services
       -> existing domain modules
       -> existing SQLite store
       -> existing OCR service sidecar
```

The key change is file and responsibility ownership, not runtime distribution.

## Backend Design

`createPolicyOcrApp(options)` remains the single Express app factory. It should become an app shell that creates shared context and mounts owner route modules.

Proposed backend structure:

```text
server/app.mjs
server/http/context.mjs
server/http/errors.mjs
server/routes/auth.routes.mjs
server/routes/admin.routes.mjs
server/routes/policies.routes.mjs
server/routes/families.routes.mjs
server/routes/responsibilities.routes.mjs
server/routes/cashflow.routes.mjs
server/routes/wechat.routes.mjs
server/services/policy-workflow.service.mjs
server/services/family-workflow.service.mjs
```

`server/app.mjs` should be responsible for:

- Express app creation.
- JSON/body middleware.
- Shared performance logging.
- Shared context creation.
- Route module mounting.
- Final error handling.

It should not directly own policy scan orchestration, family binding, admin knowledge crawling, cash value confirmation, or responsibility query implementation.

### Backend Owners

Auth owner:

```text
Routes:
  /api/auth/*

State:
  users
  sessions
  adminSessions
  smsCodes

Responsibilities:
  SMS code send/verify
  user registration
  logout
  admin session validation helpers
```

Policy owner:

```text
Routes:
  /api/policies/*

State:
  policies
  sourceRecords

Responsibilities:
  recognize
  analyze
  scan
  list/detail/update/delete
  report generation
  policy family binding orchestration
```

Family owner:

```text
Routes:
  /api/family-profiles/*
  /api/family-report-shares/*

State:
  familyProfiles
  familyMembers
  familyReportShares

Responsibilities:
  family profile creation/listing
  family member creation/update
  core member assignment
  share snapshot creation and read
```

Responsibility owner:

```text
Routes:
  /api/policy-responsibilities/*

State:
  knowledgeRecords
  insuranceIndicatorRecords
  optionalResponsibilityRecords

Responsibilities:
  responsibility query
  local draft
  company/product suggestions
  matches
```

Admin owner:

```text
Routes:
  /api/admin/*

State:
  adminSessions
  officialDomainProfiles
  knowledgeRecords
  optionalResponsibilityRecords
  OCR config via OCR service

Responsibilities:
  admin login/overview
  OCR config management
  official domain profile management
  knowledge record inspection
  governance actions
```

Cashflow owner:

```text
Routes:
  /api/admin/cashflow/*
  /api/policies/:id/cash-value/*

State:
  policy_cashflows
  policy_cash_values

Responsibilities:
  cashflow recompute/status
  cash value scan/confirm/delete coordination
```

WeChat owner:

```text
Routes:
  /api/wechat/*

Responsibilities:
  JS SDK signature
  WeChat config validation
```

## Frontend Design

`src/App.tsx` should become an app entry and routing shell. It should not continue to own all UI, API actions, export utilities, and feature workflows.

Proposed frontend structure:

```text
src/App.tsx
src/apps/customer/CustomerApp.tsx
src/apps/admin/AdminApp.tsx
src/apps/shared/auth/
src/features/policy-entry/
src/features/policy-detail/
src/features/family-profile/
src/features/family-report/
src/features/responsibility-assistant/
src/features/report-export/
src/features/cashflow/
src/features/admin-knowledge/
src/features/admin-ocr-config/
src/features/admin-governance/
```

First-pass extraction order:

1. Move low-risk pure utilities:
   - formatters
   - error helpers
   - color conversion helpers
   - image compression helpers
   - PDF/JPG/export helpers

2. Move report export:
   - PDF render target creation
   - canvas rendering
   - image export
   - PDF preview/download helpers

3. Move page-level components:
   - `CustomerApp`
   - `AdminApp`
   - `FamilyProfileManager`
   - `PolicyDetailSheet`
   - `UploadPolicyPage`
   - `ResponsibilityAssistant`

4. Move feature actions into hooks only where useful:
   - `usePolicyEntry`
   - `usePolicyList`
   - `useFamilyProfiles`
   - `useAdminKnowledge`

This design does not require a new state management library. Local React state can remain local. Shared feature state should be introduced only when a feature already has repeated API/loading/error logic.

## API Contracts

`src/api.ts` should be split by owner:

```text
src/api/client.ts
src/api/contracts/policy.ts
src/api/contracts/family.ts
src/api/contracts/admin.ts
src/api/contracts/responsibility.ts
src/api/contracts/cashflow.ts
```

The initial contract work should focus on request/response naming consistency and high-risk request validation. It does not need to generate all client types from server schemas in the first slice.

High-risk endpoints that should gain or keep explicit validation:

```text
policy scan/analyze/update
family create/member/core/share
cash-value scan/confirm
admin governance actions
responsibility query/matches
```

Where server-side validation is added, use the existing `zod` dependency and keep validation close to the route owner.

## State Ownership

SQLite remains the single local database. `server/sqlite-state-store.mjs` remains the storage implementation.

Ownership should be documented and reflected in route/service placement:

```text
Auth:
  users, sessions, adminSessions, smsCodes

Policy:
  policies, sourceRecords

Family:
  familyProfiles, familyMembers, familyReportShares

Knowledge:
  knowledgeRecords, insuranceIndicatorRecords, optionalResponsibilityRecords, officialDomainProfiles

Cashflow:
  policy_cashflows, policy_cash_values

OCR runtime:
  OCR service config, OCR health/config APIs, scan runtime selection
```

Route handlers should not become cross-owner business logic hubs. When a workflow crosses owners, put the orchestration into a service with a clear name, such as `policy-workflow.service.mjs` or `family-workflow.service.mjs`.

## Data Flow

The policy scan flow should stay behavior-compatible while gaining a clearer owner path:

```text
client upload/manual input
  -> policy route
  -> policy workflow service
  -> OCR runtime / OCR service sidecar
  -> policy normalization
  -> responsibility analysis / knowledge matching
  -> family binding
  -> policy persistence
  -> cashflow/cash value persistence
  -> report generation
```

The family report flow should stay:

```text
family profile + members + policies
  -> family/report feature UI
  -> family report engine
  -> report export feature
```

The knowledge ingestion flow should stay:

```text
insurer crawler scripts
  -> policy knowledge service
  -> knowledge records / indicators / optional responsibility records
  -> responsibility query and policy analysis
```

## Testing Strategy

This is a behavior-preserving refactor, so verification focuses on regression protection.

Required full checks after each completed slice:

```bash
npm run check
npm run typecheck
npm run build
npm run test
```

Owner-specific tests to preserve and run while moving related code:

```text
tests/policy-ocr-flow.test.mjs
tests/family-profile-domain.test.mjs
tests/family-report-engine.test.mjs
tests/cashflow-store.test.mjs
tests/policy-responsibility-query.test.mjs
tests/customer-ui-style.test.mjs
```

When a visible UI workflow is moved, also verify in browser against the actual active local stack. Use `npm run local:status` first to avoid testing the wrong dev/prod port or worktree.

## Phased Implementation

Phase 1: backend route shell.

- Create route modules and shared route context.
- Move routes from `server/app.mjs` by owner.
- Keep route URLs and response payloads unchanged.
- Keep `createPolicyOcrApp(options)` as the public app factory.
- Run full checks.

Phase 2: frontend pure utilities and report export.

- Move pure helpers from `src/App.tsx`.
- Move report export/PDF/JPG/canvas utilities into `features/report-export`.
- Keep UI behavior unchanged.
- Run typecheck/build/tests.

Phase 3: frontend app and feature modules.

- Extract `CustomerApp` and `AdminApp`.
- Extract page-level policy, family, responsibility, and admin components.
- Add small feature hooks only where repeated API/loading/error logic exists.
- Run full checks and browser verification for moved workflows.

Phase 4: API contract grouping.

- Split `src/api.ts` by owner.
- Add or preserve explicit request validation for high-risk endpoints.
- Keep old exported names temporarily if needed to avoid large frontend churn.
- Run full checks.

Phase 5: ownership documentation.

- Add a short owner map document for backend routes, frontend features, API contracts, and SQLite state areas.
- Update this design or create a follow-up implementation note if any owner changed during implementation.

## Success Criteria

The first optimization effort is successful when:

- `server/app.mjs` is primarily an app shell and route mounting file.
- Backend route modules are grouped by owner.
- `src/App.tsx` is primarily an app shell instead of a full product implementation file.
- Major frontend features have clear directories.
- API contracts are grouped by owner.
- SQLite state ownership is explicit.
- Existing product behavior remains unchanged.
- `npm run check`, `npm run typecheck`, `npm run build`, and `npm run test` pass.

Target file-size outcomes are directional, not hard blockers:

- `src/App.tsx` should move toward less than 1500 lines.
- `server/app.mjs` should move toward less than 800 lines.
- Newly created feature/route files should generally stay below 800-1200 lines unless the file is a stable pure engine with focused tests.

## Risks and Controls

Risk: behavior changes during code movement.

Control: move one owner at a time, keep URLs and responses stable, and run targeted tests after each slice.

Risk: route modules still mutate shared state in unclear ways.

Control: pass a named context object to route modules and put cross-owner orchestration in named services.

Risk: frontend extraction creates import spaghetti.

Control: feature modules may import shared API/contracts/utilities, but shared utilities should not import feature modules.

Risk: existing dirty worktree creates accidental commits.

Control: implementation commits must stage only files in the active slice and leave unrelated dirty files untouched.

Risk: graph output becomes stale.

Control: after large refactor commits, run `graphify update .` or rebuild the graph as a follow-up verification task.

