# Temporal Sales Memory Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete governed temporal sales memory with immutable events, explicit advisor actions, skill-aware retrieval, and a shared web/Wukong interface.

**Architecture:** Evolve `family_sales_memories` in place and add an append-only event table. Domain functions own every state transition; routes and MCP tools call the same functions. Current answers retrieve only confirmed, temporally valid, skill-relevant memories.

**Tech Stack:** Node.js ESM, SQLite, Express, React/TypeScript, Node test runner.

---

### Task 1: Complete memory transition domain

**Files:**
- Modify: `server/family-sales-memory.service.mjs`
- Test: `tests/family-sales-review.test.mjs`

- [ ] **Step 1: Add failing transition tests**

Cover `confirm`, `reject`, `supersede`, `complete`, `expire`, and `restore`. Assert illegal transitions fail, supersede closes the old valid interval, todo completion leaves history, and every action returns an event payload with previous/next state and reason.

- [ ] **Step 2: Run focused tests**

Run: `node --test tests/family-sales-review.test.mjs`  
Expected: FAIL because explicit transition functions are absent.

- [ ] **Step 3: Implement one deterministic transition function**

Export `applyFamilySalesMemoryAction({ memory, action, actor, reason, replacement, now })`. Validate the status/action matrix; never physically delete. Keep legacy `active` readable as confirmed during migration, but never create new `active` records.

- [ ] **Step 4: Tighten automatic confirmation**

Only low-risk display/contact-format preferences may auto-confirm. Objection, todo, correction, strategy, budget, health, income, debt, family responsibility, and purchase intent remain candidates unless explicitly confirmed.

- [ ] **Step 5: Verify and commit**

Run: `node --test tests/family-sales-review.test.mjs`  
Expected: PASS.  
Commit: `git commit -m "feat: complete temporal memory transitions"`

### Task 2: Immutable memory events and SQLite migration

**Files:**
- Modify: `server/sqlite-state-store.mjs`
- Modify: `server/policy-ocr.domain.mjs`
- Test: `tests/sqlite-state-store.test.mjs`

- [ ] **Step 1: Add failing persistence tests**

Persist a confirmed memory, supersede it, reopen SQLite, and assert both memories plus ordered `proposed`, `confirmed`, and `superseded` events survive. Verify legacy payloads normalize without data loss.

- [ ] **Step 2: Add `family_sales_memory_events`**

Create append-only rows with `id`, `memory_id`, `event_type`, `actor_type`, `actor_id`, `source_message_id`, `previous_status`, `next_status`, `reason`, `created_at`, and payload. Add granular append/upsert functions; no route can update an event.

- [ ] **Step 3: Verify and commit**

Run: `node --test tests/sqlite-state-store.test.mjs tests/family-sales-review.test.mjs`  
Expected: PASS.  
Commit: `git commit -m "feat: persist temporal memory event history"`

### Task 3: Memory APIs and MCP actions

**Files:**
- Modify: `server/routes/families.routes.mjs`
- Modify: `server/wukong-mcp-gateway.service.mjs`
- Modify: `src/api/contracts/family.ts`
- Test: `tests/family-sales-memory-routes.test.mjs`

- [ ] **Step 1: Write failing API tests**

Cover list, confirm, reject, supersede, complete, and history endpoints. Assert owner/family isolation, mandatory reasons for reject/supersede, stale version rejection, immutable event order, and masked content.

- [ ] **Step 2: Implement thin routes and shared MCP actions**

Expose `get_sales_memories` and `apply_memory_action` through the same domain methods. Do not let Wukong send `ownerUserId`, status, timestamps, or event IDs.

- [ ] **Step 3: Verify and commit**

Run: `npm run typecheck && node --test tests/family-sales-memory-routes.test.mjs tests/wukong-mcp-gateway.test.mjs`  
Expected: PASS.  
Commit: `git commit -m "feat: add governed sales memory APIs"`

### Task 4: Skill-aware temporal retrieval

**Files:**
- Modify: `server/agent-skill-router.service.mjs`
- Modify: `server/family-sales-memory.service.mjs`
- Modify: `server/family-sales-chat.service.mjs`
- Test: `tests/agent-skill-router.test.mjs`
- Test: `tests/family-sales-review.test.mjs`

- [ ] **Step 1: Add failing retrieval tests**

For objection handling, product comparison, materials follow-up, and sales review, assert only mapped kinds/keys are returned; future, expired, superseded, rejected, completed, and conflicted memories are excluded from deterministic conclusions.

- [ ] **Step 2: Implement retrieval policy**

Return `{ memoryKinds, memoryKeys, includeOpenTodos, includeConflicts, limit }` from the skill router. Filter owner/family, `asOf`, status, subject, and policy before scoring recency/confirmation/task relevance.

- [ ] **Step 3: Verify token bound and commit**

Run: `node --test tests/agent-skill-router.test.mjs tests/family-sales-review.test.mjs`  
Expected: PASS and no context exceeds the existing 20-memory bound.  
Commit: `git commit -m "feat: retrieve sales memories by skill"`

### Task 5: Web memory sidebar

**Files:**
- Create: `src/features/family-profile/FamilySalesMemoryPanel.tsx`
- Modify: `src/features/family-profile/FamilyProfileManager.tsx`
- Test: `tests/customer-ui-style.test.mjs`

- [ ] **Step 1: Add failing UI assertions**

Require sections for current, awaiting confirmation/conflict, open todos, and history; require confirm, reject, replace, and complete actions; forbid rendering raw identifiers.

- [ ] **Step 2: Implement the panel with existing API contracts**

Keep state transitions server-side. Show memory text, status, effective time, compact source reference, and action errors. Refresh after every successful action.

- [ ] **Step 3: Verify and commit**

Run: `npm run typecheck && npm run build && node --test tests/customer-ui-style.test.mjs tests/family-sales-memory-routes.test.mjs`  
Expected: PASS.  
Commit: `git commit -m "feat: add family sales memory review panel"`
