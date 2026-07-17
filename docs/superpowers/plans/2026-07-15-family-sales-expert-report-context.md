# Family Sales Expert Report Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make C-side sales advice reuse a fresh structured insurance-expert report and use lightweight, scoped context instead of sending all household policy data on every model call.

**Architecture:** Add a focused expert-report contract module that owns stable input versions, unknown-value semantics, structured result validation, and indicator grouping. The existing policy-analysis service continues to produce the customer Markdown report but returns it inside a validated JSON envelope with structured findings; a small orchestration service reuses or regenerates that report before sales generation. Sales review and chat then consume the structured expert result plus bounded sales memory and topic-specific context.

**Tech Stack:** Node.js ESM, Express routes, DeepSeek chat completions, existing JSON-payload SQLite persistence, React/TypeScript customer UI, Node test runner.

---

## File structure

- Create `server/family-policy-analysis-contract.service.mjs`: normalize expert inputs, preserve unknown values, group unrecognized indicators, compute `expertInputVersion`, validate the model JSON envelope, and expose safe structured findings.
- Create `server/family-policy-analysis-orchestrator.service.mjs`: ensure one fresh expert report per owner/family/input version, share in-flight work, and persist the current report without duplicating route logic.
- Create `server/family-sales-context.service.mjs`: build sales-review summary context, lightweight chat context, deterministic topic selection, and bounded topic packs.
- Modify `server/family-policy-analysis-report.service.mjs`: use the contract, request the Markdown-plus-structured JSON envelope, replace fixed quantitative-gap requirements with qualitative assessment rules, and retain privacy/evidence rules.
- Modify `server/family-report-record.service.mjs`: preserve or invalidate nested expert reports by `expertInputVersion` rather than timestamps or policy IDs alone.
- Modify `server/family-report-regeneration.service.mjs`: require a fresh expert report before generating a sales review and bind the resulting review to that report/version.
- Modify `server/family-sales-review.service.mjs`: consume compact expert-backed input rather than rebuilding all policy/evidence data for the model.
- Modify `server/family-sales-chat.service.mjs`: replace full `familyInput` and long Markdown injection with the lightweight sales context and one bounded topic pack.
- Modify `server/routes/families.routes.mjs`: compose the orchestrator, share an in-flight expert task between expert-report and sales-review requests, persist new fields, and return stable status/error responses.
- Modify `src/api/contracts/family.ts`: add optional expert-version/status fields without breaking existing clients.
- Modify `src/apps/customer/CustomerApp.tsx`: show expert-analysis waiting/regeneration progress while the sales request remains a single user action.
- Modify focused tests under `tests/`; no SQLite schema migration is required because family reports and sales reviews are stored as JSON payloads.

### Task 1: Expert input semantics and stable version

**Files:**
- Create: `server/family-policy-analysis-contract.service.mjs`
- Modify: `server/family-policy-analysis-report.service.mjs:257-323`
- Test: `tests/family-policy-analysis-report.test.mjs`

- [ ] **Step 1: Write failing tests for unknown financial values, grouped indicators, and stable versions**

Add imports for `buildExpertPlanningProfile`, `groupExpertCoverageIndicators`, and `computeExpertInputVersion`, then add tests equivalent to:

```js
test('expert input preserves unknown planning values instead of coercing them to zero', () => {
  assert.deepEqual(buildExpertPlanningProfile({ debt: 0, annualIncome: '' }), {
    annualIncome: { status: 'unknown', value: null },
    annualExpense: { status: 'unknown', value: null },
    debt: { status: 'confirmed', value: 0 },
    educationGoal: { status: 'unknown', value: null },
    parentSupportGoal: { status: 'unknown', value: null },
    availableAssets: { status: 'unknown', value: null },
    premiumBudget: { status: 'unknown', value: null },
  });
});

test('expert indicators retain all unrecognized names without repeated empty fields', () => {
  const groups = groupExpertCoverageIndicators([{ memberRef: '{{member_2}}', category: 'accident', item: '意外医疗', status: 'not_identified' }, { memberRef: '{{member_2}}', category: 'accident', item: '猝死', status: 'not_identified' }]);
  assert.deepEqual(groups[0].notIdentifiedItems, ['意外医疗', '猝死']);
  assert.equal(JSON.stringify(groups).includes('sourceUrl'), false);
});

test('expert input version is stable and changes for insurance facts but not sales memory', () => {
  const base = { family: { notes: '稳健' }, members: [{ id: 1, notes: '经济支柱' }], policies: [{ id: 2, amount: 300000 }], indicators: [] };
  assert.equal(computeExpertInputVersion(base), computeExpertInputVersion(structuredClone(base)));
  assert.notEqual(computeExpertInputVersion(base), computeExpertInputVersion({ ...base, policies: [{ id: 2, amount: 500000 }] }));
  assert.equal(computeExpertInputVersion({ ...base, salesMemory: ['A'] }), computeExpertInputVersion({ ...base, salesMemory: ['B'] }));
});
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `node --test --test-name-pattern='expert input preserves|expert indicators retain|expert input version' tests/family-policy-analysis-report.test.mjs`  
Expected: FAIL because the contract module and exports do not exist.

- [ ] **Step 3: Implement the contract helpers**

Use `node:crypto` SHA-256 over recursively key-sorted JSON. Include only normalized family/member notes and identity-free roles, planning fields, policy facts, indicator statuses, and evidence verification references. Export `buildExpertPlanningProfile(profile = {})`, `groupExpertCoverageIndicators(indicators = [])`, and `computeExpertInputVersion(input = {})`; the last function returns `sha256:` followed by the lowercase hexadecimal digest.

Update `buildFamilyPolicyAnalysisInput(...)` to call `buildExpertPlanningProfile(...)`, attach grouped indicators, and set `expertInputVersion` after the complete privacy-safe expert input is built. Do not include sales chat or sales memory in the version source.

- [ ] **Step 4: Run focused tests**

Run: `node --test --test-name-pattern='expert input preserves|expert indicators retain|expert input version|family policy analysis prompt' tests/family-policy-analysis-report.test.mjs`  
Expected: PASS.

- [ ] **Step 5: Commit the contract slice**

```bash
git add server/family-policy-analysis-contract.service.mjs server/family-policy-analysis-report.service.mjs tests/family-policy-analysis-report.test.mjs
git commit -m "feat: add versioned expert report input contract"
```

### Task 2: Markdown plus structured expert output

**Files:**
- Modify: `server/family-policy-analysis-contract.service.mjs`
- Modify: `server/family-policy-analysis-report.service.mjs:326-455`
- Test: `tests/family-policy-analysis-report.test.mjs`

- [ ] **Step 1: Write failing prompt and response-contract tests**

Add a fixture containing `markdownContent`, `structuredResult`, and `expertInputVersion`. Assert that the prompt asks for qualitative assessments and no longer requires fixed multipliers, a 40% gap section, or three quantified packages:

```js
assert.match(prompt, /confirmed_gap|likely_insufficient|needs_verification|currently_reasonable/u);
assert.match(prompt, /当前已录入保单中未发现/u);
assert.match(prompt, /暂按未配置关注，需核对合同/u);
assert.doesNotMatch(prompt, /缺口分析篇幅不少于全文 40%|年收入5-10倍|基础版、标准版、完善版/u);
assert.deepEqual(result.structuredResult.priorityFindings[0].assessment, 'likely_insufficient');
assert.match(result.markdownContent, /报告结论摘要/u);
```

Also assert that malformed structured output throws `FAMILY_POLICY_ANALYSIS_INVALID_RESULT` and is never returned as a complete report.

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `node --test --test-name-pattern='qualitative|structured expert|invalid expert' tests/family-policy-analysis-report.test.mjs`  
Expected: FAIL because the current service accepts Markdown-only content.

- [ ] **Step 3: Add strict envelope parsing and qualitative prompt rules**

Export `parseFamilyPolicyAnalysisEnvelope(rawContent, expectedVersion)`. It returns exactly `{ markdownContent, structuredResult, expertInputVersion }` and throws an error carrying code `FAMILY_POLICY_ANALYSIS_INVALID_RESULT` for missing Markdown, an assessment outside the four allowed values, a finding without a valid fact/indicator/policy reference, or a version mismatch.

Request `response_format: { type: 'json_object' }`. Preserve the current eight Markdown headings inside `markdownContent`, but replace fixed quantitative requirements with:

```text
优先做定性保障判断。可以判断保障缺失、责任不完整、保额偏低、成员配置失衡或保费结构不合理。
家庭责任资料不完整时不得输出精确缺口金额，也不得把未知值当成0。
没有关联保单或指标时写“当前已录入保单中未发现”；存在相关保单但责任未识别时写“暂按未配置关注，需核对合同”。
```

Return `{ status: 'complete', content: markdownContent, markdownContent, structuredResult, expertInputVersion, model, generatedAt }` so existing callers using `content` remain compatible during migration.

- [ ] **Step 4: Run the full expert-report test file**

Run: `node --test tests/family-policy-analysis-report.test.mjs`  
Expected: PASS, including retry behavior with JSON-envelope fixtures.

- [ ] **Step 5: Commit structured expert output**

```bash
git add server/family-policy-analysis-contract.service.mjs server/family-policy-analysis-report.service.mjs tests/family-policy-analysis-report.test.mjs
git commit -m "feat: return structured family policy findings"
```

### Task 3: Fresh expert report orchestration and request deduplication

**Files:**
- Create: `server/family-policy-analysis-orchestrator.service.mjs`
- Modify: `server/family-report-record.service.mjs`
- Modify: `server/routes/families.routes.mjs:700-710,1485-1545`
- Test: `tests/family-policy-analysis-report.test.mjs`
- Test: `tests/policy-ocr-flow.test.mjs`

- [ ] **Step 1: Write failing orchestrator tests**

Cover fresh reuse, stale regeneration, concurrent deduplication, failure, and a late old-version completion. Use a deferred promise to prove two callers share one generator call:

```js
const first = orchestrator.ensureFresh({ family, owner, explicitRefresh: false });
const second = orchestrator.ensureFresh({ family, owner, explicitRefresh: false });
assert.equal(generateCalls, 1);
resolveGeneration(makeExpertResult('version-a'));
assert.equal((await first).report.id, (await second).report.id);
```

Assert that an explicit expert-page refresh regenerates even for the same input version, while a sales prerequisite never forces a refresh of an already fresh report.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `node --test --test-name-pattern='expert orchestrator|concurrent expert|explicit expert refresh' tests/family-policy-analysis-report.test.mjs`  
Expected: FAIL because the orchestrator does not exist.

- [ ] **Step 3: Implement `createFamilyPolicyAnalysisOrchestrator(deps)`**

Use an app-scoped `Map` keyed by owner, family, version, and refresh generation. Expose:

```js
return {
  currentInputVersion({ family, owner }),
  ensureFresh({ family, owner, explicitRefresh: false }),
  getStatus({ family, owner }),
};
```

Persist nested reports as:

```js
{
  status: 'complete',
  content: result.markdownContent,
  structuredResult: result.structuredResult,
  expertInputVersion: result.expertInputVersion,
  model: result.model,
  generatedAt: result.generatedAt,
}
```

Always re-check the current version before making a completed task the current report. Keep the existing nested JSON payload so no SQLite DDL migration is needed.

- [ ] **Step 4: Route both expert generation and reads through the orchestrator**

The expert-report POST uses `explicitRefresh: true`. Client serialization may expose `status`, `generatedAt`, and `expertInputVersion`, but must not expose the internal structured result on the customer report endpoint unless an existing authenticated consumer requires it.

- [ ] **Step 5: Run expert and route tests**

Run: `node --test tests/family-policy-analysis-report.test.mjs tests/policy-ocr-flow.test.mjs`  
Expected: PASS.

- [ ] **Step 6: Commit orchestration**

```bash
git add server/family-policy-analysis-orchestrator.service.mjs server/family-report-record.service.mjs server/routes/families.routes.mjs tests/family-policy-analysis-report.test.mjs tests/policy-ocr-flow.test.mjs
git commit -m "feat: reuse fresh family policy expert reports"
```

### Task 4: Expert-backed sales review context

**Files:**
- Create: `server/family-sales-context.service.mjs`
- Modify: `server/family-report-regeneration.service.mjs:25-54`
- Modify: `server/family-sales-review.service.mjs:957-1117`
- Modify: `server/routes/families.routes.mjs:1178-1212`
- Test: `tests/family-sales-review.test.mjs`
- Test: `tests/policy-ocr-flow.test.mjs`

- [ ] **Step 1: Write failing context-boundary tests**

Assert that sales generation calls `ensureFresh(...)`, binds the expert IDs, and sends only expert-backed context:

```js
assert.equal(savedReview.expertReportId, 77);
assert.equal(savedReview.expertInputVersion, 'sha256:abc');
assert.deepEqual(modelInput.expertFindings, expertReport.structuredResult);
assert.equal('officialEvidence' in modelInput, false);
assert.equal('financialFacts' in modelInput, false);
assert.equal(JSON.stringify(modelInput).includes('完整专家 Markdown'), false);
```

Add cases for fresh reuse, stale expert regeneration before sales, and expert failure preventing sales generation.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `node --test --test-name-pattern='expert-backed sales|sales waits for expert|sales stops when expert fails' tests/family-sales-review.test.mjs tests/policy-ocr-flow.test.mjs`  
Expected: FAIL because sales currently builds full `familyInput` directly.

- [ ] **Step 3: Implement `buildExpertBackedSalesReviewContext(...)`**

Return only:

```js
{
  generatedAt,
  expertReportId,
  expertInputVersion,
  family: { coreMemberRef, notes, planningSummary },
  members: minimalMemberIndex,
  policyIndex: referencedPolicies,
  expertFindings: structuredResult,
  salesMemoryContext,
  salesChatContext,
}
```

Keep member privacy tokens. Include only policies referenced by expert findings plus minimal IDs/names needed to resolve selected chat content. Remove the sales prompt rules that ask the model to redo complete insurance analysis; make it convert expert findings into up to three sales opportunities, one meeting objective, and next actions.

- [ ] **Step 4: Ensure the report before sales generation**

Inject the orchestrator into `createFamilyReportRegenerationService(...)`. In `regenerateSalesReview(...)`, await `ensureFresh({ explicitRefresh: false })`, build compact context, generate the review, and persist `expertReportId`, `expertInputVersion`, and a structured sales summary.

- [ ] **Step 5: Run focused and full sales-review tests**

Run: `node --test tests/family-sales-review.test.mjs tests/policy-ocr-flow.test.mjs`  
Expected: PASS.

- [ ] **Step 6: Commit expert-backed sales reviews**

```bash
git add server/family-sales-context.service.mjs server/family-report-regeneration.service.mjs server/family-sales-review.service.mjs server/routes/families.routes.mjs tests/family-sales-review.test.mjs tests/policy-ocr-flow.test.mjs
git commit -m "feat: generate sales advice from expert findings"
```

### Task 5: Lightweight sales chat with one scoped topic pack

**Files:**
- Modify: `server/family-sales-context.service.mjs`
- Modify: `server/family-sales-chat.service.mjs:80-219`
- Modify: `server/routes/families.routes.mjs:621-649`
- Test: `tests/family-sales-review.test.mjs`

- [ ] **Step 1: Write failing lightweight-context tests**

Add fixtures for “帮我改成微信话术”, “孩子的意外险怎么聊”, and “这张医疗险续保怎么样”. Assert:

```js
assert.deepEqual(selectSalesTopicPack('帮我改成微信话术', indexes), null);
assert.equal(selectSalesTopicPack('孩子的意外险怎么聊', indexes).type, 'member_coverage');
assert.equal(selectSalesTopicPack('这张医疗险续保怎么样', indexes).type, 'policy_indicators');
assert.equal('familyInput' in chatContext, false);
assert.equal(JSON.stringify(chatContext).includes('完整销售 Markdown'), false);
assert.ok(JSON.stringify(chatContext).length < 12000);
```

Also assert that an ambiguous question does not fall back to all-family details.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `node --test --test-name-pattern='lightweight sales chat|sales topic pack|ambiguous sales question' tests/family-sales-review.test.mjs`  
Expected: FAIL because chat currently injects `familyInput`, the full sales review, and up to 8,000 characters of the expert report.

- [ ] **Step 3: Implement deterministic topic selection and bounded packs**

Export `selectSalesTopicPack(question, { members, policies, activeOpportunity })`, returning either `null` or one `{ type, memberRefs, policyRefs, category }` descriptor. Export `buildLightweightSalesChatContext({ salesReview, expertReport, memories, history, question, topicPack })`, returning the bounded JSON object passed to the chat prompt.

Selection priority is explicit member/product/category mention, last explicit target, then active sales opportunity. A script-only request gets no insurance topic pack. An unresolved target gets only the summary and a request to clarify, never all-family detail.

- [ ] **Step 4: Replace full chat context assembly**

Remove `familyInput`, `latestSalesReview.content`, and `familyPolicyAnalysisReport.content` from the default chat payload. Include the structured sales summary, relevant expert findings, confirmed memories, at most the existing last 12 messages, and one bounded topic pack. Keep identity and privacy guards unchanged.

- [ ] **Step 5: Add context telemetry without sensitive content**

Record stage, expert reuse flag, selected member/policy counts, pack type, confirmed/unrecognized counts, estimated input size, and truncated section names. Do not log prompt text, names, policy numbers, or reasoning.

- [ ] **Step 6: Run sales chat tests**

Run: `node --test tests/family-sales-review.test.mjs tests/family-sales-memory-routes.test.mjs`  
Expected: PASS.

- [ ] **Step 7: Commit lightweight chat context**

```bash
git add server/family-sales-context.service.mjs server/family-sales-chat.service.mjs server/routes/families.routes.mjs tests/family-sales-review.test.mjs tests/family-sales-memory-routes.test.mjs
git commit -m "feat: scope family sales chat context"
```

### Task 6: C-side progress, compatibility, and full verification

**Files:**
- Modify: `src/api/contracts/family.ts:150-190,363-485`
- Modify: `src/apps/customer/CustomerApp.tsx:1868-1960,3784-4065`
- Test: `tests/customer-ui-style.test.mjs`
- Test: `tests/sqlite-state-store.test.mjs`

- [ ] **Step 1: Write failing client and persistence compatibility tests**

Assert that an expert report and sales review with new fields round-trip through SQLite JSON payload persistence. Add UI source assertions for the progress labels:

```js
assert.match(customerSource, /正在更新保障分析/u);
assert.match(customerSource, /正在生成或更新保单专家报告/u);
assert.match(customerSource, /正在生成销售建议/u);
```

Assert existing records without `structuredResult`, `expertReportId`, or `expertInputVersion` still deserialize and are treated as stale rather than crashing.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `node --test --test-name-pattern='expert report version round trip|expert-backed sales progress|legacy expert report' tests/sqlite-state-store.test.mjs tests/customer-ui-style.test.mjs`  
Expected: FAIL until compatibility and progress states are implemented.

- [ ] **Step 3: Extend client contracts additively**

Add optional fields so legacy payloads remain valid:

```ts
expertInputVersion?: string;
expertReportId?: number;
structuredSummary?: FamilySalesReviewSummary;
status?: 'waiting_for_expert' | 'generating' | 'complete' | 'failed' | 'stale';
```

Do not expose the expert `structuredResult` through the customer API unless the UI renders it.

- [ ] **Step 4: Show the chained generation phases**

Keep one “销售建议” click. While the synchronous request awaits expert refresh and sales generation, rotate or update the existing progress message through the three approved phases. On expert failure, show the server message and retain the stale report visually marked as stale; do not silently reuse it.

- [ ] **Step 5: Run frontend and persistence checks**

Run: `npm run typecheck && npm run build && node --test tests/customer-ui-style.test.mjs tests/sqlite-state-store.test.mjs`  
Expected: all commands PASS.

- [ ] **Step 6: Run project-required cross-boundary verification**

Run: `npm run check && npm run typecheck && npm test && npm run build`  
Expected: all commands PASS. If the full suite exposes unrelated pre-existing failures, record the exact failing tests and also run `node --test tests/family-policy-analysis-report.test.mjs tests/family-sales-review.test.mjs tests/policy-ocr-flow.test.mjs tests/family-sales-memory-routes.test.mjs tests/sqlite-state-store.test.mjs tests/customer-ui-style.test.mjs` to verify the changed behavior.

- [ ] **Step 7: Commit compatibility and UI progress**

```bash
git add src/api/contracts/family.ts src/apps/customer/CustomerApp.tsx tests/customer-ui-style.test.mjs tests/sqlite-state-store.test.mjs
git commit -m "feat: show expert-backed sales generation progress"
```

## Completion criteria

- A fresh expert report is reused for sales advice without another expert call.
- A missing or stale expert report is generated and saved before sales advice.
- Concurrent expert and sales clicks share one expert generation for the same family/version.
- Policy, member, notes, planning, indicator, or verified-evidence changes invalidate the expert version; sales memory does not.
- Unknown household financial values stay `unknown + null`, never implicit zero.
- Expert output supports qualitative gaps without forced exact amounts.
- “No recorded policy evidence” and “related policy responsibility not identified” use the approved two-level wording.
- Sales review binds its expert report/version and does not receive full policy/evidence payloads.
- Ordinary sales chat input is at least 60% smaller than the current fixture and loads no unrelated member details.
- Existing privacy, amount verification, family isolation, sales memory, selected-message recalculation, and legacy JSON records continue to work.
