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

This is a hard harness rule. `npm run harness:audit` fails changed durable data workflows such as crawlers, backfills, repairs, refills, recoveries, quantifiers, and refreshers when they do not show SQLite write evidence. It also fails workflows that write source data to temporary JSON/CSV/NDJSON/state files instead of the SQL persistence layer.

Route handlers for user operations must not call naked `persist(state)`. Use the narrow SQLite persistence method for the mutation, such as `persistPendingScan`, `persistPolicyScanSave`, or another focused store method. This is a hard gate: compatibility fallbacks to full-state persistence are not allowed in route modules.

For newly crawled or extracted insurance data, completion requires:

- write through the existing SQLite-backed store or service;
- include persistence evidence such as `dbPath`, `savedRecordCount`, and row ids/counts when practical;
- verify the result with a SQL read, not just a crawler response, console output, Feishu sync, or temporary file.

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

The full gate now starts with a non-mutating harness audit:

```bash
npm run harness:audit
```

The audit checks production-sensitive changed paths, required harness execution points, focused test mappings in `docs/harness-test-map.json`, read-only optional responsibility data quality in the development SQLite database, and scripts that default to the production SQLite path.

Run all tests with:

```bash
./scripts/test.sh
```

Run focused tests with:

```bash
./scripts/test.sh tests/policy-ocr-flow.test.mjs
```

## Insurance Agent Responsibility Boundaries

The following ownership rules are hard harness constraints for insurance and sales conversations. A fallback, performance optimization, or channel-specific implementation must not bypass them.

### Hermes owns conversation semantics only

Hermes may:

- identify intent, entities, missing information, and contextual references such as `这个`、`它`、`第3个`、`和赢家版对比`;
- resolve a follow-up against prior conversation state or ask a precise clarification when the reference remains ambiguous;
- select the appropriate domain agent and pass the resolved user request, entities, and conversation context to it;
- manage ordinary non-domain conversation.

Hermes must not:

- answer insurance or sales questions from its own model knowledge;
- determine insurance responsibilities, product type, exclusions, waiting periods, limits, benefit calculations, claims, underwriting, product suitability, or comparison conclusions;
- rewrite, summarize, compress, enrich, or regenerate a professional agent's conclusion;
- replace a failed domain-agent call with a generic insurance answer;
- invent a product identity, product fact, or comparison target when context and controlled product data do not establish it.

### Natural-language-first execution flow

The customer-facing contract is natural conversation, not a form and not an internal enum schema. Every insurance or sales turn must follow this sequence:

1. Preserve the customer's original question. Normalization may remove transport noise, but it must not rewrite `有什么优势` into `保险责任`, `推荐哪个` into `产品列表`, or otherwise change the requested dimension.
2. Load safe recent conversation state and currently verified entities before interpretation.
3. Hermes resolves pronouns, omitted subjects, short aliases, corrections, candidate numbers, and comparison roles. For example, after a verified product answer, `他有什么优势` should resolve `他` to that product without asking for its formal name again.
4. If the referenced entity is still ambiguous or absent, ask one focused clarification or present controlled candidates. Do not guess, start an unrelated search, or return generic help text.
5. Route the original question, resolved entities, and safe context to the owning domain agent. Controlled fields such as `intent` and `queryAspects` are machine-readable hints; they are not customer input requirements and must not replace the original question.
6. The owning domain agent determines the professional subtask from the original question and evidence. A product fact or evidence-based advantage belongs to `insurance_expert`; customer recommendation, positioning, objection handling, or sales action belongs to `sales_champion`.
7. The domain agent retrieves authoritative data, fuses approved uploaded material where applicable, and produces the complete professional result with sources and limitations.
8. Hermes does not regenerate that result. The channel and UI only preserve and render it as cards, Markdown, links, or safely split messages.

This flow is mandatory for both contextual and context-free questions. Internal schema design must never force a customer to know a formal product name, agent name, intent name, query-aspect enum, or tool operation.

### Semantic hints are not routing authority

- `intent`, `queryAspects`, requested steps, and similar model-produced fields are bounded hints, not domain conclusions.
- Missing optional semantic hints must not reject an otherwise understandable natural-language question.
- A missing or unknown product aspect must not default to `main_responsibilities`, `coverage_report`, `chat`, or another convenient existing workflow.
- When a semantic hint conflicts with the original question, the original question is authoritative. The domain agent must interpret the requested professional dimension; a gateway or cached-summary shortcut must not override it.
- Backend keyword or regular-expression rules must not be the primary mechanism for deciding whether a customer asks about advantages, responsibilities, suitability, comparison, claims, underwriting, or sales guidance. Controlled local rules are limited to security, validation, explicit candidate selection, and safe high-confidence transport signals.
- Product-specific names, aliases, examples, and expected answers must not be embedded in routing code. Resolve products through controlled catalog metadata and verified conversation state.
- Fast paths and cached responsibility summaries may be used only after the request is explicitly established as a responsibility query. Exact product resolution alone is not permission to return a responsibility card.
- Hermes or provider failure may perform only the bounded Hermes retry. If Hermes remains unavailable, times out, fails authentication, opens its circuit, or returns invalid output, the turn must return an explicit semantic-service-unavailable response. It must not call Direct interpretation, keyword classification, a domain agent, or another semantic fallback, and it must not commit inferred entities or assistant output into conversation context.

### `insurance_expert` owns insurance professional work

Route insurance-domain analysis to `insurance_expert`, including but not limited to:

- insurance responsibilities, clauses, coverage scope, exclusions, waiting periods, limits, calculation rules, cash value dependencies, and product classification;
- single-product explanation and complete responsibility extraction;
- multi-product responsibility and benefit comparison;
- claims, underwriting, policy interpretation, evidence assessment, and professional family coverage analysis;
- fusion of official product knowledge with user-uploaded product materials and retrieved evidence.

If this behavior is missing, incomplete, slow, or incorrect, fix the insurance expert prompt, tool, domain service, entity resolver, RAG/evidence pipeline, or focused tests. Do not patch Hermes, a DingTalk gateway, a React component, or a response formatter with insurance-domain conclusions.

### `sales_champion` owns sales professional work

Route sales-domain analysis to `sales_champion`, including but not limited to:

- customer-needs analysis, product recommendation and suitability explanation;
- sales plans, customer communication scripts, objection handling, follow-up, and conversion guidance;
- product positioning and customer-facing comparison from a sales perspective.

If this behavior needs improvement, fix the sales champion prompt, tool, domain service, context, or focused tests. Hermes may clarify the customer's meaning, but it must not produce the sales recommendation itself.

Open-ended customer-needs analysis and product recommendation do not require a pre-existing family record. They must route to `sales_champion` with an open consultation context. Family authorization is required only when the request actually reads a named/current family's records or generated reports. The sales champion may ask for missing goals or constraints, but the semantic router must not replace that consultation with a generic family-selection prompt.

Sales consultation follow-ups must receive the bounded, server-owned recent conversation history. Open consultation uses that conversation history directly; family-scoped consultation may combine it with the reauthorized family sales thread. Never trust client-supplied history, expose internal context field names, or silently discard the prior answer when the customer supplies requested details.

Domain-agent wrapper timeouts must not be shorter than the normal response window of the professional generator they wrap. Sales champion execution must allow the configured sales-chat model enough time to finish instead of converting a still-running expert response into a generic routing failure.

### Gateways and UI own transport and rendering only

DingTalk, HTTP routes, channel gateways, and frontend components may format transport output, render cards or Markdown, split messages, show progress, and preserve safe links. They must not make insurance or sales judgments.

Professional agent output must be preserved without lossy model regeneration. Message splitting, card conversion, and length limits must retain the complete professional result, including responsibility details, calculation information, qualifications, and source citations. A rendering fallback must not silently downgrade an existing responsibility card to incomplete free text.

### Context, fallback, and product matching rules

- With conversation context, Hermes resolves references and candidate selections first, then routes the resolved request to the responsible domain agent.
- Without sufficient context, the system may search controlled product knowledge or the web when allowed, present relevant candidates, or ask a focused clarification. It must not guess a product.
- User-uploaded material is retrieved and fused inside the insurance expert's product-knowledge path. Hermes only carries the user's intent and resolved references.
- A Hermes timeout, unavailable client, invalid session, or provider failure must not reclassify or execute the request. After the bounded Hermes retry is exhausted, return semantic service unavailable without routing to a domain agent or mutating the conversation task.
- Product comparison requires resolved identities and evidence for every compared product. The insurance expert must produce actual comparison dimensions, differences, advantages, limitations, and applicable scenarios; listing two products separately is not a completed comparison.
- Fixes must be general domain behavior. Do not hard-code literal product names, aliases, or one-off answers in Hermes, routing, gateway, or UI code. Any unavoidable special handling must come from controlled product metadata or contract semantics and include a regression test.

### Required review and verification

Before completing changes to Hermes, semantic routing, conversation context, insurance/sales agent tools, product knowledge, responsibility generation, or DingTalk delivery:

1. Identify the owning layer: Hermes semantics, `insurance_expert`, `sales_champion`, or transport/rendering.
2. Verify insurance professional requests reach `insurance_expert` and sales professional requests reach `sales_champion`.
3. Verify Hermes and channel code neither fabricate nor regenerate professional conclusions.
4. Test both contextual and context-free phrasing, including pronouns, short aliases, numeric candidate selection, and corrections.
5. Test the Hermes unavailable/timeout path and confirm the domain task and resolved entities are preserved.
6. For insurance responsibilities and product comparisons, verify completeness, meaningful analysis, source citations, card shape, and long-message tail preservation.
7. Add or update the closest focused regression tests and map new high-risk domain files in `docs/harness-test-map.json` when applicable.

The regression set must include these conversational behaviors when the affected path is changed:

- explicit product question followed by `他有什么优势`: reuse the verified product, reach the insurance expert, and answer advantages rather than replaying the responsibility card;
- the same follow-up with no active product: ask a focused product clarification instead of guessing;
- Hermes supplies a correct optional aspect: preserve it through the gateway without replacing it;
- Hermes omits an optional aspect: preserve the original question and let the domain agent interpret it instead of defaulting to responsibilities;
- Hermes supplies a hint that conflicts with the original question: the original question wins and the professional agent handles the requested dimension;
- a responsibility query: preserve the existing complete responsibility card, responsibility count, calculations, limitations, and citations;
- a recommendation or customer-fit query: route professional sales reasoning to `sales_champion`, while insurance facts and underwriting limitations remain sourced from `insurance_expert`;
- long professional output: preserve the final section and all source citations after DingTalk message splitting;
- Hermes unavailable, timeout, invalid session, or provider failure: return semantic service unavailable, do not invoke Direct/keyword/domain fallbacks, and do not commit a guessed task or entity.

Closest focused tests include:

```bash
node --test tests/agent-conversation-runtime.test.mjs
node --test tests/agent-product-entity-resolver.test.mjs
node --test tests/agent-question-router.test.mjs
node --test tests/agent-semantic-conversation.test.mjs
node --test tests/insurance-expert-tool.test.mjs
node --test tests/sales-champion-tool.test.mjs
node --test tests/dingtalk-agent-gateway.test.mjs
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

For mapped high-risk files, `npm run harness:audit` runs the focused tests automatically before the broader quality gate. Add new mappings to `docs/harness-test-map.json` when a new domain file or test area becomes part of a high-risk workflow.

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
