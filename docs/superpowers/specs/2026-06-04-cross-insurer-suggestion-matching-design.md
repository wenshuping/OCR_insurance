# Cross-Insurer Suggestion Matching Design

## Summary

This design extends insurance company and product suggestion matching so the responsibility assistant, manual policy entry, and policy edit flows all behave consistently across insurers, not only for New China Life.

The target behavior is:

- Company suggestions work for configured aliases such as `新华`, `新华人寿`, and `新华保险`
- Company suggestions also work for insurers that do not yet have a fully curated alias list by using conservative generic normalization
- Product suggestions stay scoped to the selected insurer and support fuzzy product-name matching such as `健康无忧重疾` matching `新华人寿保险股份有限公司健康无忧A款重大疾病保险`
- The backend becomes the single source of truth for suggestion ranking, while the frontend only requests and displays ranked results

The design intentionally stays scoped to suggestion dropdown behavior. It does not change responsibility query fallback, OCR extraction, Feishu lookup strategy, or broader policy-analysis behavior.

## Goals

- Make company and product dropdown suggestions behave consistently across supported insurers
- Reuse existing insurer alias configuration where available
- Add a generic fallback layer so newly seen insurers can still match reasonably
- Prevent frontend-side filtering from hiding valid backend suggestion candidates
- Keep product suggestions constrained to the selected insurer to reduce false positives

## Non-Goals

- No cross-insurer product recommendation mode
- No redesign of the responsibility result cards or local-match card ranking
- No changes to online responsibility-query retry behavior
- No refactor of OCR field extraction or policy mapping logic unrelated to suggestions
- No speculative admin workflow redesign for maintaining insurer aliases

## Current Context

The codebase already contains a strong insurer metadata foundation:

- [server/c-policy-analysis.service.mjs](/Users/wenshuping/Documents/OCR_insurance/server/c-policy-analysis.service.mjs) defines default insurer aliases and company aliases for many insurers
- [server/policy-knowledge.service.mjs](/Users/wenshuping/Documents/OCR_insurance/server/policy-knowledge.service.mjs) already contains insurer alias matching and product fuzzy scoring used by knowledge matching
- [server/routes/responsibilities.routes.mjs](/Users/wenshuping/Documents/OCR_insurance/server/routes/responsibilities.routes.mjs) exposes company and product suggestion endpoints
- [src/apps/customer/CustomerApp.tsx](/Users/wenshuping/Documents/OCR_insurance/src/apps/customer/CustomerApp.tsx), [src/features/responsibility-assistant/ResponsibilityAssistant.tsx](/Users/wenshuping/Documents/OCR_insurance/src/features/responsibility-assistant/ResponsibilityAssistant.tsx), [src/features/policy-entry/UploadPolicyPage.tsx](/Users/wenshuping/Documents/OCR_insurance/src/features/policy-entry/UploadPolicyPage.tsx), and [src/features/policy-detail/PolicyDetailSheet.tsx](/Users/wenshuping/Documents/OCR_insurance/src/features/policy-detail/PolicyDetailSheet.tsx) render suggestion dropdowns

The recent bug pattern was:

- Backend local product matching could already find correct New China candidates after alias support was added
- Suggestion endpoints and frontend dropdown filtering still relied too heavily on direct substring checks
- Valid candidates were therefore lost before reaching the user

## Recommended Approach

Use a two-layer insurer matching design:

1. Configured insurer alias matching as the high-confidence layer
2. Conservative generic normalization as the fallback layer

Then apply product fuzzy matching only inside the selected insurer candidate set.

This is preferred over a configuration-only design because it covers more insurers without waiting for manual alias curation, and preferred over a pure generic-matching design because it preserves precision where curated insurer metadata already exists.

## Matching Model

### 1. Company Suggestion Matching

Company matching should use a ranked, layered model:

- `alias_exact`
  Exact match against `company`, `aliases`, or `companyAliases`
- `alias_prefix`
  Prefix or containment match against configured aliases
- `normalized_exact`
  Exact match after generic normalization
- `normalized_contains`
  Containment match after generic normalization
- `generic_fuzzy`
  Conservative low-priority fallback for short or noisy insurer inputs

Generic normalization should remove legal and category suffixes that frequently prevent matches while preserving the identifying core:

- `保险股份有限公司`
- `保险有限责任公司`
- `保险有限公司`
- `股份有限公司`
- `有限责任公司`
- `有限公司`
- selected insurer category words such as `人寿`, `财产`, `养老`, `健康` when they only serve as suffix patterns

This layer must remain conservative. It should not aggressively widen short ambiguous inputs.

### 2. Product Suggestion Matching

Product matching should always happen inside an insurer-scoped candidate pool:

- Step 1: resolve the selected company through the company matching model
- Step 2: collect products only from knowledge records and policy records that belong to the resolved insurer candidate set
- Step 3: rank products by exact, contains, prefix, and fuzzy product-name score

The existing `scoreProductNameMatch(...)` style fuzzy scoring is the intended basis for ranking. Product suggestions should not introduce an unrelated second scoring model.

### 3. Insurer Scope Rule

Product suggestions must remain insurer-scoped by default.

This means:

- If the selected company resolves to `中国平安`, products from `中国太平` are not shown
- If the selected company resolves through aliases such as `新华人寿 -> 新华保险`, products under the resolved insurer are eligible
- There is no default cross-insurer fallback for product suggestions

This rule is the main precision guardrail in the design.

## Ranking and Filtering

### Company Ranking

Company suggestions should be ordered by:

1. alias exact
2. alias prefix or alias contains
3. normalized exact
4. normalized contains
5. generic fuzzy
6. record frequency or suggestion-supporting evidence count
7. stable locale sort as final tie-breaker

### Product Ranking

Product suggestions should be ordered by:

1. insurer scope confidence
2. exact product-name match
3. prefix or contains product-name match
4. fuzzy product-name score
5. official knowledge priority when all else is close
6. record frequency or source count
7. stable locale sort as final tie-breaker

### Thresholds

The backend should suppress very weak fuzzy candidates rather than returning long noisy lists.

Initial guidance:

- Company one-character inputs should be handled more conservatively than longer inputs
- Product fuzzy candidates should require a minimum score floor
- Configured alias hits always outrank generic fallback hits

The exact threshold values belong in implementation detail, but the design intent is explicit: coverage should increase without turning the dropdown into a low-quality catch-all.

## API Design

### Company Suggestions

Endpoint:

- `GET /api/policy-responsibilities/company-suggestions?q=...&limit=...`

Behavior:

- Accept the raw user query
- Resolve and rank company candidates on the backend
- Return already ranked suggestions

Suggested response fields:

- `company`
- `recordCount`
- `matchType`

### Product Suggestions

Endpoint:

- `GET /api/policy-responsibilities/product-suggestions?company=...&q=...&limit=...`

Behavior:

- Resolve the selected insurer using the company matching model
- Search only within the resolved insurer scope
- Rank product candidates on the backend
- Return already ranked suggestions

Suggested response fields:

- `company`
- `productName`
- `canonicalProductId` when official and available
- `recordCount`
- `matchType`

## Frontend Design

The frontend should stop acting as a second matcher.

### Request Timing

- Company suggestions should be requested live once the company input has content
- Product suggestions should be requested only when a company input exists
- The existing debounce pattern can remain

### Display Behavior

- Show up to about eight suggestions by default
- Keep the main line as company name or product name
- Keep supporting information lightweight, such as record count
- Do not show raw similarity percentages in dropdowns for now

The design intentionally hides raw numeric scores because the main user need is finding the right suggestion quickly, not interpreting a score.

### Frontend Responsibility Boundary

Frontend responsibilities:

- decide when to request
- show loading and empty states
- render the backend-ranked suggestions
- allow selection

Frontend should not:

- recalculate insurer matching
- re-filter by `indexOf(...)`
- re-sort with a different heuristic than the backend

This boundary prevents a repeat of the earlier bug where the backend found valid candidates but the UI removed them.

## Error Handling and Safety

- Empty company input returns no product suggestions
- Weak or ambiguous inputs may return fewer suggestions rather than low-quality ones
- Missing alias config must not break matching because generic normalization remains available as fallback
- Product suggestion expansion must not silently widen into other insurers

If a company cannot be confidently resolved:

- company suggestions may still return candidates
- product suggestions should remain conservative rather than guessing across insurers

## Implementation Boundaries

The implementation should remain surgical.

Primary backend files:

- [server/policy-knowledge.service.mjs](/Users/wenshuping/Documents/OCR_insurance/server/policy-knowledge.service.mjs)
- [server/app.mjs](/Users/wenshuping/Documents/OCR_insurance/server/app.mjs)
- [server/routes/responsibilities.routes.mjs](/Users/wenshuping/Documents/OCR_insurance/server/routes/responsibilities.routes.mjs)

Primary frontend files:

- [src/apps/customer/CustomerApp.tsx](/Users/wenshuping/Documents/OCR_insurance/src/apps/customer/CustomerApp.tsx)
- [src/features/responsibility-assistant/ResponsibilityAssistant.tsx](/Users/wenshuping/Documents/OCR_insurance/src/features/responsibility-assistant/ResponsibilityAssistant.tsx)
- [src/features/policy-entry/UploadPolicyPage.tsx](/Users/wenshuping/Documents/OCR_insurance/src/features/policy-entry/UploadPolicyPage.tsx)
- [src/features/policy-detail/PolicyDetailSheet.tsx](/Users/wenshuping/Documents/OCR_insurance/src/features/policy-detail/PolicyDetailSheet.tsx)
- [src/shared/customer-policy-components.tsx](/Users/wenshuping/Documents/OCR_insurance/src/shared/customer-policy-components.tsx)

Out of scope:

- responsibility online-query retry logic
- Feishu search precedence
- OCR mapping rules
- policy analysis prompt behavior

## Test Plan

### Backend Tests

Add or maintain focused coverage for:

- configured alias company match
  - `新华人寿 -> 新华保险`
- generic normalized company match
  - legal-suffix differences still resolve correctly
- insurer-scoped product suggestions
  - products do not leak across insurers
- fuzzy product-name match inside resolved insurer scope
  - `健康无忧重疾 -> 健康无忧A款重大疾病保险`
- one-character conservative behavior
  - very short inputs do not explode into noisy matches

### Frontend Regression Coverage

The key frontend regression to guard against is simple:

- valid backend-ranked suggestions must not be filtered out again on the client

The project does not need a heavyweight UI test harness for this design if backend tests remain strong and the frontend logic is kept intentionally thin.

### Verification Commands

Implementation verification should follow project rules:

- `npm run check`
- `npm run typecheck`
- `npm test`
- `npm run build`

## Risks and Mitigations

### Risk: Higher coverage increases false positives

Mitigations:

- keep product suggestions insurer-scoped
- keep alias hits above generic fallback hits
- apply minimum fuzzy thresholds
- treat one-character inputs conservatively

### Risk: Alias metadata quality varies by insurer

Mitigations:

- use generic normalization as fallback
- continue to support admin-maintained alias enrichment over time
- preserve deterministic ranking so curated aliases always improve behavior

### Risk: Frontend and backend matching diverge again

Mitigations:

- backend owns ranking and filtering
- frontend remains display-only for suggestions
- avoid introducing parallel client-side matching heuristics

## Success Criteria

The design is successful when:

- insurer suggestions work consistently for both curated aliases and reasonable uncurated company variants
- product suggestions return relevant same-insurer candidates for partial or noisy product input
- the responsibility assistant, manual entry form, and policy edit dialog all behave consistently
- users can find the expected insurer and product from the dropdown without needing a special insurer-specific fix
