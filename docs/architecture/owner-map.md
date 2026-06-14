# OCR Insurance Owner Map

Date: 2026-06-02

This project remains a modular monolith with an OCR sidecar. Ownership is defined by route, feature, contract, and state area so changes can stay local without changing runtime deployment.

## Backend Owners

`server/app.mjs` is the backend shell. It creates the Express app, middleware, route context, and route mounts. Business behavior should live in the owner route or service files below.

| Owner | Public routes | Primary state | Primary files |
| --- | --- | --- | --- |
| Auth | `/api/auth/send-code`, `/api/auth/register`, `/api/auth/logout` | `users`, `sessions`, `smsCodes`, guest pending scans | `server/routes/auth.routes.mjs`, `server/sms-delivery.mjs`, `server/policy-ocr.domain.mjs` |
| Policy | `/api/policies/recognize`, `/api/policies/analyze`, `/api/policies/scan`, `/api/policies`, `/api/policies/:id`, `/api/policies/:id/report` | `policies`, `sourceRecords`, pending scans | `server/routes/policies.routes.mjs`, `server/policy-ocr.domain.mjs`, `server/policy-ocr-mapping.mjs`, `server/c-policy-analysis.service.mjs` |
| Family | `/api/family-profiles/*`, `/api/family-report-shares/*` | `familyProfiles`, `familyMembers`, `familyReportShares`, policy family bindings | `server/routes/families.routes.mjs`, `server/services/family-workflow.service.mjs`, `server/family-profile.domain.mjs` |
| Responsibility | `/api/policy-responsibilities/*` | `knowledgeRecords`, `insuranceIndicatorRecords`, `optionalResponsibilityRecords` | `server/routes/responsibilities.routes.mjs`, `server/policy-responsibility-query.mjs`, `server/policy-knowledge.service.mjs`, `server/optional-responsibility-governance.mjs` |
| Cashflow | `/api/admin/cashflow/*`, `/api/policies/:id/cash-value/*` | `policy_cashflows`, `policy_cash_values` | `server/routes/cashflow.routes.mjs`, `server/cashflow-store.mjs`, `server/cashflow-compute.mjs`, `server/cashflow-template.mjs` |
| Admin | `/api/admin/*` except cashflow subroutes | `adminSessions`, `officialDomainProfiles`, `knowledgeRecords`, OCR config, optional responsibility governance | `server/routes/admin.routes.mjs`, `server/c-policy-analysis.service.mjs`, `server/policy-knowledge.service.mjs`, `server/scrapling-policy-crawler.py` |
| WeChat | `/api/wechat/js-sdk-signature` | WeChat config only | `server/routes/wechat.routes.mjs`, `server/app.mjs` context helpers |
| Client performance | `/api/client-perf` | performance logs only | `server/routes/client-performance.routes.mjs`, `server/app.mjs` context helpers |

## Backend Rules

- Keep `createPolicyOcrApp(options)` as the only public Express app factory.
- Add new API handlers to the matching `server/routes/*.routes.mjs` owner file, not directly to `server/app.mjs`.
- Use `server/http/context.mjs` for shared route dependencies and `server/http/errors.mjs` for shared error response helpers.
- Put cross-owner orchestration in a named service file. For this slice, family share and family binding helpers live in `server/services/family-workflow.service.mjs`.
- Do not change API URLs, response shapes, SQLite tables, or deployment topology as part of ownership-only refactors.
- Cash value routes stay in the cashflow owner even though their URL starts with `/api/policies/:id`.
- Admin cashflow routes stay in the cashflow owner even though their URL starts with `/api/admin/cashflow`.

## Frontend Owners

`src/App.tsx` is the frontend shell. It selects the admin app, shared family report app, or customer app.

| Owner | Responsibility | Primary files |
| --- | --- | --- |
| App shell | Top-level app selection and shared family share page bootstrapping | `src/App.tsx` |
| Customer app | Customer auth state, guest state, policy list/dashboard, family report state, feature composition | `src/apps/customer/CustomerApp.tsx` |
| Admin app | Admin login, overview, official domain profiles, knowledge crawl, governance actions | `src/apps/admin/AdminApp.tsx` |
| Customer auth | Customer account sheet and phone verification dialog UI | `src/features/customer-auth/CustomerAccountSheet.tsx`, `src/features/customer-auth/PhoneVerificationDialog.tsx` |
| Customer navigation | Customer bottom tab navigation and customer tab type | `src/features/customer-navigation/CustomerBottomTabs.tsx` |
| Policy entry | OCR upload, recognition, manual policy form, analysis preview, save flow | `src/features/policy-entry/UploadPolicyPage.tsx` |
| Policy detail | Policy detail drawer, policy editing, report regeneration, cash value editing | `src/features/policy-detail/PolicyDetailSheet.tsx` |
| Family profile | Family profile list, member creation/update, core member assignment | `src/features/family-profile/FamilyProfileManager.tsx` |
| Family report overview | Policy-dashboard family radar overview and family planning profile storage | `src/features/family-report/FamilyCoverageOverview.tsx`, `src/features/family-report/family-planning-storage.ts` |
| Responsibility assistant | Local and remote responsibility lookup UI | `src/features/responsibility-assistant/ResponsibilityAssistant.tsx` |
| Customer cashflow | Customer cashflow detail page and annual/scenario/member cashflow tables | `src/features/cashflow/CashflowDetailPage.tsx` |
| Customer cash value | Controlled cash value upload, recognition preview, and manual editor dialog UI | `src/features/cash-value/CashValueDialog.tsx` |
| Report export | JPG export and canvas/page export utilities | `src/features/report-export/report-export.ts` |
| Admin official domains | Controlled official domain whitelist panel and form helpers | `src/features/admin-official-domain/AdminOfficialDomainPanel.tsx` |
| Admin knowledge | Controlled local knowledge crawl panel and crawl form type | `src/features/admin-knowledge/AdminKnowledgePanel.tsx` |
| Admin governance | Controlled optional responsibility governance panel | `src/features/admin-governance/AdminOptionalResponsibilityGapPanel.tsx` |
| Admin policy detail | Controlled admin policy detail drawer and report export UI | `src/features/admin-policy-detail/AdminPolicyDetail.tsx` |
| Admin shared UI | Small admin-only UI primitives | `src/features/admin-shared/AdminStatCard.tsx`, `src/features/admin-shared/TextField.tsx` |
| Report UI helpers | Policy report status/source display and shared report widgets | `src/shared/policy-report-ui.tsx` |
| Customer policy helpers | Policy form, cash value, list, and small customer UI helpers | `src/shared/customer-policy-form.ts`, `src/shared/customer-cash-value.ts`, `src/shared/customer-policy-list.tsx`, `src/shared/customer-policy-components.tsx` |
| Shared utilities | Formatting, error normalization, image processing, browser environment helpers | `src/shared/formatters.ts`, `src/shared/errors.ts`, `src/shared/image-utils.ts`, `src/shared/browser-env.ts` |

## Frontend Rules

- Keep `src/App.tsx` small. New customer workflows belong under `src/apps/customer` or `src/features/*`.
- Keep feature components behavior-focused and let `CustomerApp` own only composition and shared customer state.
- Put reusable pure helpers under `src/shared`, but split them by domain instead of creating broad catch-all modules.
- Report export should remain isolated in `src/features/report-export` because it has browser and rendering side effects.
- Preserve existing UI copy and selectors unless the task explicitly changes product behavior.

## API Contract Owners

`src/api.ts` remains a compatibility barrel for the current slice. New contract code should go into the owner contract files below, and the barrel can re-export or wrap it while older imports migrate.

| Owner | File | Route family |
| --- | --- | --- |
| Client shell | `src/api/client.ts` | request helper, auth query, generic auth endpoints, WeChat, client performance |
| Policy | `src/api/contracts/policy.ts` | `/api/policies/*` except cash value |
| Family | `src/api/contracts/family.ts` | `/api/family-profiles/*`, `/api/family-report-shares/*` |
| Responsibility | `src/api/contracts/responsibility.ts` | `/api/policy-responsibilities/*` |
| Cashflow | `src/api/contracts/cashflow.ts` | `/api/admin/cashflow/*`, `/api/policies/:id/cash-value/*` |
| Admin | `src/api/contracts/admin.ts` | `/api/admin/*` except cashflow |

## Change Checklist

Before adding or moving code:

1. Identify the owner from the public route or UI workflow.
2. Change the owner route, feature, or contract file first.
3. Keep compatibility through `server/app.mjs` mounts and `src/api.ts` exports when needed.
4. Run the focused owner test, then `npm run check`, `npm run typecheck`, and `npm run build`.
5. If a route moves, confirm route count across `server/app.mjs` and `server/routes`.
