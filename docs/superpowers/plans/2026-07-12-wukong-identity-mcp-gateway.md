# Wukong Identity and MCP Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bind whitelisted DingTalk advisors to existing OCR Insurance accounts and expose a narrow authenticated MCP gateway.

**Architecture:** Add a channel-neutral identity domain modeled after the existing WeChat identity persistence, then mount a dedicated MCP HTTP transport whose request context resolves `corpId + dingUserId` to an active internal user. Phone numbers are used only for first-time candidate matching; all business tools receive server-resolved owner context.

**Tech Stack:** Node.js ESM, Express, SQLite payload persistence, Node test runner, TypeScript API contracts.

---

### Task 1: DingTalk identity domain

**Files:**
- Create: `server/dingtalk-advisor-identity.service.mjs`
- Test: `tests/dingtalk-advisor-identity.test.mjs`

- [ ] **Step 1: Write failing domain tests**

```js
test('unique active mobile match requires explicit confirmation', () => {
  const state = { users: [{ id: 7, mobile: '13800138000', status: 'active' }], userDingtalkIdentities: [] };
  const candidate = findAdvisorBindingCandidate(state, { mobile: '13800138000', allowedUserIds: [7] });
  assert.deepEqual(candidate, { status: 'confirmation_required', userId: 7, maskedMobile: '138****8000' });
});

test('resolve never authenticates by mobile after binding', () => {
  const identity = resolveDingtalkAdvisor({ userDingtalkIdentities: [{ corpId: 'c1', dingUserId: 'd1', userId: 7, status: 'active' }] }, { corpId: 'c1', dingUserId: 'd1' });
  assert.equal(identity.userId, 7);
});
```

- [ ] **Step 2: Run the test and verify missing-module failure**

Run: `node --test tests/dingtalk-advisor-identity.test.mjs`  
Expected: FAIL because `dingtalk-advisor-identity.service.mjs` does not exist.

- [ ] **Step 3: Implement the minimal identity state machine**

Export `findAdvisorBindingCandidate`, `createAdvisorBindingChallenge`, `confirmAdvisorBinding`, `resolveDingtalkAdvisor`, and `revokeAdvisorBinding`. Use statuses `pending`, `active`, `revoked`; challenges expire after five minutes, are single-use, and store a SHA-256 token hash rather than the raw token.

- [ ] **Step 4: Add failure cases**

Cover no match, duplicate mobile, non-whitelisted user, expired/used challenge, wrong DingTalk principal, disabled account, revoked binding, and masked responses.

- [ ] **Step 5: Run and commit**

Run: `node --test tests/dingtalk-advisor-identity.test.mjs`  
Expected: PASS.  
Commit: `git commit -m "feat: add DingTalk advisor identity binding"`

### Task 2: Persist identities and binding challenges

**Files:**
- Modify: `server/sqlite-state-store.mjs`
- Modify: `server/policy-ocr.domain.mjs`
- Test: `tests/sqlite-state-store.test.mjs`

- [ ] **Step 1: Add failing restart tests**

Create state containing `userDingtalkIdentities` and `dingtalkBindingChallenges`, persist, reopen the database, and assert active/revoked status, expiry, token hash, `corpId`, `dingUserId`, and `userId` survive exactly.

- [ ] **Step 2: Run focused persistence tests**

Run: `node --test tests/sqlite-state-store.test.mjs`  
Expected: FAIL because the new arrays are not loaded.

- [ ] **Step 3: Add dedicated SQLite tables and granular writers**

Add `user_dingtalk_identities` with a unique `(corp_id, ding_user_id)` index and `dingtalk_binding_challenges` with a unique token-hash index. Add load/upsert/delete paths and `persistDingtalkIdentityState({ identity, challenge })`; do not use full-state persistence for request-time writes.

- [ ] **Step 4: Verify restart and migration compatibility**

Run: `node --test tests/sqlite-state-store.test.mjs`  
Expected: PASS, including loading older databases where both tables begin empty.

- [ ] **Step 5: Commit**

Commit: `git commit -m "feat: persist DingTalk advisor identities"`

### Task 3: Binding and web fallback APIs

**Files:**
- Create: `server/routes/dingtalk-identity.routes.mjs`
- Modify: `server/app.mjs`
- Create: `src/api/contracts/dingtalk.ts`
- Modify: `src/api.ts`
- Test: `tests/dingtalk-identity-routes.test.mjs`

- [ ] **Step 1: Write failing route tests**

Test `POST /api/dingtalk/identity/candidate`, `POST /api/dingtalk/identity/confirm`, `POST /api/dingtalk/identity/web-bind`, and `DELETE /api/dingtalk/identity/binding`. Assert candidate responses are masked, confirmation binds only the original principal, and web binding requires an authenticated OCR Insurance session.

- [ ] **Step 2: Run the route test**

Run: `node --test tests/dingtalk-identity-routes.test.mjs`  
Expected: FAIL with 404 responses.

- [ ] **Step 3: Implement thin routes**

Routes delegate all transitions to the identity service, obtain the phone value through an injected `getDingtalkUserProfile` adapter, set `Cache-Control: no-store`, and never accept an internal `userId` as proof of identity. Export the four client calls from `src/api/contracts/dingtalk.ts` and re-export that module from `src/api.ts`.

- [ ] **Step 4: Verify security cases and contracts**

Run: `node --test tests/dingtalk-identity-routes.test.mjs && npm run typecheck`  
Expected: PASS.

- [ ] **Step 5: Commit**

Commit: `git commit -m "feat: add DingTalk advisor binding routes"`

### Task 4: Narrow MCP gateway

**Files:**
- Create: `server/wukong-mcp-gateway.service.mjs`
- Create: `server/routes/wukong-mcp.routes.mjs`
- Modify: `server/app.mjs`
- Test: `tests/wukong-mcp-gateway.test.mjs`
- Modify: `docs/harness-test-map.json`

- [ ] **Step 1: Write failing gateway tests**

Assert signed service authentication, replay-resistant `requestId`, single-chat enforcement, principal resolution, per-user rate limiting, JSON schema rejection, structured errors, and zero trust in caller-provided `familyId` ownership.

- [ ] **Step 2: Run the gateway test**

Run: `node --test tests/wukong-mcp-gateway.test.mjs`  
Expected: FAIL because gateway modules do not exist.

- [ ] **Step 3: Implement the tool registry and request context**

Define a registry whose entries have `name`, `inputSchema`, `authorize(context,input)`, and `execute(context,input)`. Initially register only `resolve_advisor_identity` and `list_accessible_families`. Build owner context from the active DingTalk binding; filter families server-side.

- [ ] **Step 4: Add audit-safe errors and harness mapping**

Return `IDENTITY_NOT_BOUND`, `IDENTITY_REVOKED`, `GROUP_CHAT_FORBIDDEN`, `REQUEST_REPLAYED`, `TOOL_NOT_ALLOWED`, and `RATE_LIMITED` without sensitive inputs. Map the new gateway/service/tests in `docs/harness-test-map.json`.

- [ ] **Step 5: Verify and commit**

Run: `npm run check && node --test tests/dingtalk-advisor-identity.test.mjs tests/dingtalk-identity-routes.test.mjs tests/wukong-mcp-gateway.test.mjs tests/sqlite-state-store.test.mjs && npm run typecheck`  
Expected: PASS.  
Commit: `git commit -m "feat: expose authenticated Wukong MCP gateway"`
