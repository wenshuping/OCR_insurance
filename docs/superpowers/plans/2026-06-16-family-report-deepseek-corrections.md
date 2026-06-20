# Family Report DeepSeek Corrections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let DeepSeek-backed family report quality checks produce persisted, labeled correction recommendations, auto-apply low-risk medical corrections, and show both corrected and not-corrected findings in the admin report issue view.

**Architecture:** Add a focused correction layer next to the existing family report record service. DeepSeek returns `issues` and `corrections`; server code validates corrections, persists them, rebuilds the report with trusted corrections, and exposes correction labels in admin APIs. The family report engine remains deterministic and only receives trusted corrections as calculation context.

**Tech Stack:** Node ESM, Express routes, SQLite state store, React/TypeScript admin UI, Node test runner.

---

### Task 1: Correction Contract and Normalization

**Files:**
- Modify: `server/family-report-quality.service.mjs`
- Test: `tests/family-report-quality.test.mjs`

- [ ] Extend the DeepSeek prompt to request `issues` and `corrections`.
- [ ] Normalize `corrections` with allowed actions, dimensions, risk levels, refs, evidence, confidence, and linked `issueIndex`.
- [ ] Return `{ issues, corrections }` while keeping array compatibility for existing callers.
- [ ] Add tests for parsing corrections and for no-key skip behavior.

### Task 2: Correction Persistence and Admin Labels

**Files:**
- Modify: `server/policy-ocr.domain.mjs`
- Modify: `server/sqlite-state-store.mjs`
- Modify: `server/family-report-record.service.mjs`
- Modify: `server/family-profile.domain.mjs`
- Modify: `scripts/production-data-bundle.mjs`
- Test: `tests/sqlite-state-store.test.mjs`
- Test: `tests/production-data-bundle.test.mjs`

- [ ] Add `familyReportCorrections` state and SQLite `family_report_corrections`.
- [ ] Persist and load corrections with report state.
- [ ] Archive corrections when report/family data is invalidated.
- [ ] Add append/list helpers and derive every issue's `correctionStatus`, `correctionLabel`, `correctionReason`, and `correctionId`.
- [ ] Include corrections in production data bundles.

### Task 3: Apply Trusted Corrections to Reports

**Files:**
- Modify: `src/family-report-engine.mjs`
- Modify: `src/family-report-engine.d.mts`
- Modify: `server/routes/families.routes.mjs`
- Test: `tests/family-report-engine.test.mjs`
- Test: `tests/policy-ocr-flow.test.mjs`

- [ ] Add optional `corrections` to `buildFamilyReport`.
- [ ] Apply trusted `medical` `exclude_amount` / `mark_unquantifiable` corrections to medical radar contributions by policy/member.
- [ ] During report generation, call DeepSeek, persist issues/corrections, rebuild the report with auto-applied and accepted corrections, and persist final state.
- [ ] Ensure DeepSeek failures keep the code report and label the failure as not corrected.

### Task 4: Admin API and UI

**Files:**
- Modify: `server/routes/admin.routes.mjs`
- Modify: `src/api/contracts/admin.ts`
- Modify: `src/apps/admin/AdminApp.tsx`
- Test: `tests/customer-ui-style.test.mjs`
- Test: `tests/policy-ocr-flow.test.mjs`

- [ ] Expose correction counts on report issue summaries.
- [ ] Expose correction labels on issue details.
- [ ] Add accept/reject endpoints for pending corrections.
- [ ] Render correction labels, reason, and counts in the admin "报告问题" view.

### Task 5: Verification

**Files:**
- Test-only verification across touched modules.

- [ ] Run focused tests for DeepSeek quality, family report engine, SQLite persistence, production bundle, policy OCR flow, and admin UI source assertions.
- [ ] Run required checks: `npm run check`, `npm run typecheck`, `npm test`, and `npm run build`.
