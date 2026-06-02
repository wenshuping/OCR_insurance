# Frontend Owner Second Pass Design

Date: 2026-06-02

## Goal

Continue the owner-based frontend refactor after the first architecture slice. This pass reduces the remaining concentration in `CustomerApp.tsx` and performs low-risk panel extraction from `AdminApp.tsx`.

This is a behavior-preserving structure change. It does not change UI copy, API URLs, response shapes, customer workflows, admin workflows, routing, or deployment topology.

## Current State

The first project boundary optimization slice is complete:

- `src/App.tsx` is now a small app shell.
- Backend routes are split by owner.
- API contracts are split under `src/api/contracts/*` while `src/api.ts` remains a compatibility barrel.
- Main frontend features for policy entry, policy detail, family profile, responsibility assistant, and report export are already extracted.
- `docs/architecture/owner-map.md` documents backend, frontend, and API contract owners.

The largest remaining frontend ownership concentration is:

- `src/apps/customer/CustomerApp.tsx`: about 3044 lines.
- `src/apps/admin/AdminApp.tsx`: about 1230 lines.

`CustomerApp.tsx` still owns many page-level and dialog-level UI blocks directly, including account dialogs, bottom navigation, family coverage/report UI, cashflow tables, and the cash value upload/edit dialog. `AdminApp.tsx` still contains several independent admin panels that can be moved without changing admin state ownership.

## Non-Goals

This design intentionally does not include:

- Introducing React Router or changing navigation behavior.
- Introducing Redux, Zustand, context-heavy state management, or server state libraries.
- Reworking visual design or UI copy.
- Changing API contracts, endpoint URLs, or backend route behavior.
- Continuing the `src/api.ts` contract split.
- Moving admin API calls into admin panel components in this pass.
- Deeply refactoring policy entry, policy detail, family profile, or responsibility assistant features already extracted in the previous slice.

## Recommended Approach

Use UI owner extraction first, then introduce hooks only when the moved boundary proves a real need.

The rejected alternatives were:

- Extract state hooks first. This could create clean state boundaries, but it would touch many call sites at once and make behavior regressions harder to isolate.
- Convert customer workflows into page-like route modules. This would make the final shape clear, but the app does not currently use a route framework, so it would be more design churn than this refactor needs.

The chosen approach is lower risk:

1. Move coherent UI blocks into feature components.
2. Keep cross-feature state and API orchestration in `CustomerApp` and `AdminApp`.
3. Add hooks only if props become hard to manage or repeated API/loading/error logic appears after extraction.

## Target Structure

```text
src/apps/customer/CustomerApp.tsx
src/apps/admin/AdminApp.tsx

src/features/customer-auth/
src/features/customer-navigation/
src/features/family-report/
src/features/cashflow/
src/features/cash-value/

src/features/admin-shared/
src/features/admin-ocr-config/
src/features/admin-official-domain/
src/features/admin-knowledge/
src/features/admin-governance/
src/features/admin-policy-detail/
```

`CustomerApp.tsx` remains the customer composition shell. It owns identity, selected entities, active tab, shared customer messages, and cross-feature coordination.

`AdminApp.tsx` remains the admin composition shell. It owns admin token, overview loading, query filtering, selected user/policy state, and all admin API actions for this pass.

## Customer Owner Design

### Customer Auth

Create `src/features/customer-auth/`.

Move:

- `CustomerAccountSheet`
- `PhoneVerificationDialog`
- customer session storage helpers for token/mobile keys where practical

`CustomerApp` keeps the actual authentication state and API handlers:

- `token`
- `mobile`
- `authMobile`
- `authCode`
- `authMessage`
- `authLoading`
- `handleSendAuthCode`
- `handleVerifyAuthCode`
- `handleCustomerLogout`

The extracted components receive controlled values, loading flags, messages, and callbacks.

### Customer Navigation

Create `src/features/customer-navigation/`.

Move:

- `CustomerBottomTabs`
- `CustomerTab` type if it is not needed elsewhere

This is a pure UI extraction. It should be one of the first implementation steps because it has little business risk.

### Cashflow

Create `src/features/cashflow/`.

Move:

- `CashflowDetailPage`
- `CashflowAnnualTable`
- `ScenarioDetailTable`
- `MemberAnnualSummaryTable`

These components render cashflow and scenario data. They can import cashflow types and formatting helpers, but they should not call APIs or mutate policy state.

`CustomerApp` continues to own:

- `cashflowMember`
- selected family policy filtering
- computed family report and cashflow input selection

### Family Report

Create `src/features/family-report/`.

Move:

- `FamilyCoverageOverview`
- family planning local storage helpers:
  - `FAMILY_PLANNING_PROFILE_KEY`
  - `normalizePlanningProfile`
  - `readFamilyPlanningProfile`
  - `saveFamilyPlanningProfile`

The family report feature may wrap report-related UI affordances, but `CustomerApp` continues to own:

- `selectedFamilyId`
- `showFamilyReport`
- `familyPlanningProfile`
- `openFamilyReport`
- `handleShareFamilyReport`
- the call to `buildFamilyReport`

This keeps family workflow coordination in one place while removing report UI and browser storage details from the shell.

### Cash Value

Create `src/features/cash-value/`.

Move the cash value upload, scan result, and manual row editor dialog into:

```text
src/features/cash-value/CashValueDialog.tsx
```

The first version should remain controlled by `CustomerApp`:

- `cashValueDialogOpen`
- `cashValuePolicyId`
- `cashValueScanResult`
- `cashValueEditRows`
- `cashValueLoading`
- `cashValueMessage`
- scan file handler
- confirm handler
- row edit/add/remove handlers

The component may own its local file input ref because the ref is purely presentational. It should not call `scanCashValue` or `confirmCashValue` directly in this pass.

If props become difficult to manage during implementation, a follow-up hook such as `useCashValueDialog` can be proposed in a separate slice. It is not required by this design.

## Admin Owner Design

Admin panel extraction should be conservative. Panels remain controlled by `AdminApp`, and API calls stay in `AdminApp`.

Create:

```text
src/features/admin-shared/
src/features/admin-ocr-config/
src/features/admin-official-domain/
src/features/admin-knowledge/
src/features/admin-governance/
src/features/admin-policy-detail/
```

Move:

- `TextField` and shared small admin UI pieces to `features/admin-shared`.
- `AdminOcrModePanel` to `features/admin-ocr-config`.
- `AdminOfficialDomainPanel` and official domain form helpers to `features/admin-official-domain`.
- `AdminKnowledgePanel` and knowledge crawl form type/helpers to `features/admin-knowledge`.
- `AdminOptionalResponsibilityGapPanel` to `features/admin-governance`.
- `AdminPolicyDetail` to `features/admin-policy-detail`.

`AdminStatCard` may move to `admin-shared` if it keeps `AdminApp` clearer. Otherwise it can remain in `AdminApp` as a small local component.

`AdminApp` continues to own:

- `adminToken`
- `overview`
- `ocrConfig`
- `officialDomainProfiles`
- `knowledgeRecords`
- filters and selected admin user/policy
- loading/saving/crawling flags
- all admin API calls
- 401 handling and token clearing

## Data Flow

Customer data flow remains:

```text
CustomerApp
  -> policy-entry / policy-detail / family-profile / responsibility-assistant
  -> customer-auth / customer-navigation / family-report / cashflow / cash-value
  -> src/api.ts compatibility exports
```

The following state stays in `CustomerApp` because it crosses feature boundaries:

- `token`
- `mobile`
- `guestId`
- `policies`
- `familyProfiles`
- `selectedPolicy`
- `selectedFamilyId`
- `activeTab`
- `message`

Admin data flow remains:

```text
AdminApp owns token/loading/query/overview/API actions
  -> controlled admin feature panels
  -> src/api.ts compatibility exports
```

Feature components should not import each other through `apps/*`. Shared pure helpers belong in `src/shared` or the owning feature folder.

## Error Handling

Do not introduce a new error handling framework.

Customer API handlers continue to catch errors inside `CustomerApp` and update existing state such as:

- `message`
- `authMessage`
- `cashValueMessage`
- loading flags

Extracted customer components display the error/loading state they receive and invoke callbacks. They do not swallow exceptions or own cross-feature retry behavior.

Admin API handlers continue to catch errors inside `AdminApp`. This preserves the current 401 handling, token clearing, and message updates. Extracted admin panels display the state they receive and call callbacks such as `onRefresh`, `onSave`, `onDelete`, and `onCrawl`.

## Implementation Order

### Slice 1: Low-risk customer UI

Move:

- `CustomerBottomTabs`
- `CustomerAccountSheet`
- `PhoneVerificationDialog`

Run `npm run typecheck` after the slice.

### Slice 2: Cashflow read UI

Move:

- `CashflowDetailPage`
- `CashflowAnnualTable`
- `ScenarioDetailTable`
- `MemberAnnualSummaryTable`

Run `npm run typecheck` and `npm run build` after the slice.

### Slice 3: Family report UI and storage helpers

Move:

- `FamilyCoverageOverview`
- family planning storage helpers

Keep `buildFamilyReport` orchestration in `CustomerApp`.

Run `npm run typecheck` and `node --test tests/customer-ui-style.test.mjs` after the slice.

### Slice 4: Cash value dialog

Move:

- cash value dialog JSX
- cash value row editor UI

Keep scanning, confirmation, and policy refresh handlers in `CustomerApp`.

Run `npm run typecheck`, `npm run build`, and `node --test tests/customer-ui-style.test.mjs` after the slice.

### Slice 5: Admin panels

Move controlled admin panels and shared admin UI helpers into owner feature directories.

Run `npm run typecheck`, `npm run build`, and `node --test tests/customer-ui-style.test.mjs` after the slice.

## Final Verification

After all slices:

```bash
npm run check
npm run typecheck
npm run build
npm run test
```

If a local stack is already running, perform browser smoke checks for:

- customer policy entry page
- policy detail sheet
- family report page
- cashflow detail page
- cash value dialog
- admin OCR config panel
- admin official domain panel
- admin knowledge panel

If the local stack is not running, do not make browser verification a blocker for this behavior-preserving refactor. Report that it was not run.

## Success Criteria

This pass is successful when:

- `CustomerApp.tsx` is reduced from about 3044 lines toward about 1400-1900 lines.
- `AdminApp.tsx` is reduced from about 1230 lines toward about 500-800 lines.
- New feature files have clear owners and generally stay below 800 lines.
- Cross-feature state remains centralized where it is actually shared.
- Extracted feature components are controlled by their app shell unless they only own local UI refs.
- UI copy, selectors, API URLs, response shapes, and route counts remain unchanged.
- Full verification passes.

## Risks and Controls

Risk: moving UI changes behavior through missed props or stale callbacks.

Control: move one owner at a time, keep components controlled, and run typecheck after each slice.

Risk: `CustomerApp` remains large because extracted components need too many props.

Control: finish the UI extraction first, then only introduce a hook when the new boundary proves it is needed.

Risk: admin panels start owning API behavior inconsistently.

Control: keep admin API calls and 401 handling in `AdminApp` for this pass.

Risk: tests tied to source text fail after file moves.

Control: update tests only to follow the new owner files, not to weaken behavior assertions.

Risk: unrelated generated graph files are accidentally committed.

Control: stage only the design or implementation slice files explicitly.
