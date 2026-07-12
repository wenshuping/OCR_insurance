# Wukong Policy Intake Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete a resumable multi-attachment policy intake and idempotent formal-save flow shared by Wukong and the web app.

**Architecture:** Extend the existing `agentPolicyImportTasks` state rather than create a parallel workflow. Store attachment/document metadata and state transitions in OCR Insurance, expose masked interactions through MCP, and reuse the existing policy save domain after final confirmation.

**Tech Stack:** Node.js ESM, Express, existing OCR scanner/analyzer, SQLite state documents, React/TypeScript contracts, Node test runner.

---

### Task 1: Multi-attachment task state

**Files:**
- Modify: `server/agent-policy-import.service.mjs`
- Test: `tests/agent-policy-import.test.mjs`

- [ ] **Step 1: Add failing tests**

Test `appendAgentPolicyImportDocuments` with two images, duplicate SHA-256 hashes, maximum count, task closure, and optimistic `stateVersion`. Assert public context contains document count/status but no data URL, OCR text, path, phone, ID number, or full policy number.

- [ ] **Step 2: Run focused test**

Run: `node --test tests/agent-policy-import.test.mjs`  
Expected: FAIL because append support is absent.

- [ ] **Step 3: Implement document and processing states**

Add document statuses `received`, `scanning`, `recognized`, `failed`, `removed`; task statuses `uploading`, `recognizing`, `field_completion`, `candidate_selection`, `member_binding`, `final_confirmation`, `saving`, `completed`, `cancelled`, `failed`. Preserve legacy task reads by normalizing missing arrays/statuses.

- [ ] **Step 4: Verify**

Run: `node --test tests/agent-policy-import.test.mjs`  
Expected: PASS.

- [ ] **Step 5: Commit**

Commit: `git commit -m "feat: support multi-file policy import tasks"`

### Task 2: Append/scan routes and MCP tools

**Files:**
- Modify: `server/routes/families.routes.mjs`
- Modify: `server/wukong-mcp-gateway.service.mjs`
- Modify: `src/api/contracts/family.ts`
- Test: `tests/agent-policy-import.test.mjs`

- [ ] **Step 1: Add failing end-to-end tests**

Cover `append_policy_import_files`, `get_policy_import`, and `apply_policy_import_action`; verify family/owner isolation, hash dedupe, stale version rejection, OCR failure persistence, product options enforcement, and web retrieval of a Wukong-created task.

- [ ] **Step 2: Run tests and observe missing tools**

Run: `node --test tests/agent-policy-import.test.mjs tests/wukong-mcp-gateway.test.mjs`  
Expected: FAIL with unregistered tools or unsupported multiple files.

- [ ] **Step 3: Add thin route/service integration**

Use the existing `recognizePolicyInput`; merge recognized documents deterministically, retaining per-field evidence. Persist after each state transition and roll back in-memory mutation when persistence fails.

- [ ] **Step 4: Add product/member interactions**

Every select interaction carries server-generated option IDs and `stateVersion`. Reject arbitrary IDs. List only members from the task family and require explicit applicant/insured selection when name matching is ambiguous.

- [ ] **Step 5: Verify and commit**

Run: `npm run check && npm run typecheck && node --test tests/agent-policy-import.test.mjs tests/wukong-mcp-gateway.test.mjs`  
Expected: PASS.  
Commit: `git commit -m "feat: expose resumable policy intake tools"`

### Task 3: Idempotent formal save

**Files:**
- Create: `server/agent-policy-import-finalize.service.mjs`
- Modify: `server/routes/families.routes.mjs`
- Modify: `server/wukong-mcp-gateway.service.mjs`
- Test: `tests/agent-policy-import-finalize.test.mjs`

- [ ] **Step 1: Write failing finalize tests**

Test incomplete task, missing permission, absent final confirmation, duplicate `requestId`, simulated timeout after save, conflicting product option, and successful save that records one policy ID and one immutable event.

- [ ] **Step 2: Run test**

Run: `node --test tests/agent-policy-import-finalize.test.mjs`  
Expected: FAIL because finalize service does not exist.

- [ ] **Step 3: Implement deterministic finalize service**

Validate task version/owner/family/status, reserve the idempotency key, call the existing policy creation domain once, store `formalPolicyId`, transition to `completed`, and make retries return the original result.

- [ ] **Step 4: Register `finalize_policy_import`**

The MCP response contains masked summary, task ID, policy ID, and completion time only. It never returns raw scan data.

- [ ] **Step 5: Verify and commit**

Run: `node --test tests/agent-policy-import-finalize.test.mjs tests/agent-policy-import.test.mjs tests/policy-ocr-flow.test.mjs`  
Expected: PASS.  
Commit: `git commit -m "feat: finalize policy imports idempotently"`

### Task 4: Cross-channel review entry

**Files:**
- Modify: `src/api/contracts/family.ts`
- Modify: `src/apps/customer/CustomerApp.tsx`
- Test: `tests/customer-ui-style.test.mjs`

- [ ] **Step 1: Add failing UI contract test**

Assert the customer app recognizes `policyImportTaskId`, loads the same task, renders current version, and never hydrates raw OCR into browser storage.

- [ ] **Step 2: Run test**

Run: `node --test tests/customer-ui-style.test.mjs`  
Expected: FAIL because the task review entry is absent.

- [ ] **Step 3: Add minimal review entry**

Reuse existing policy-entry components; add only task loading, current interaction rendering, and final confirmation. Keep OCR/business logic in server modules.

- [ ] **Step 4: Verify and commit**

Run: `npm run typecheck && npm run build && node --test tests/customer-ui-style.test.mjs tests/agent-policy-import.test.mjs`  
Expected: PASS; Vite chunk-size warning is acceptable if unchanged.  
Commit: `git commit -m "feat: resume policy imports across channels"`
