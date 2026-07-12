# Wukong Privacy and PoC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove with synthetic/redacted policies that Wukong policy intake is isolated, temporary attachments are cleaned, model egress is governed, and real-policy mode cannot activate accidentally.

**Architecture:** Put channel attachments through a dedicated intake boundary with signature validation, task-scoped temporary storage, immutable audit events, and deletion verification. Route all customer-data model calls through one policy engine and make the enterprise mode default to `test_redacted_only`.

**Tech Stack:** Node.js ESM, Express, filesystem isolation, existing DeepSeek privacy gateway, SQLite audit payloads, Node test runner.

---

### Task 1: Enterprise channel policy

**Files:**
- Create: `server/dingtalk-enterprise-policy.service.mjs`
- Modify: `server/app.mjs`
- Test: `tests/dingtalk-enterprise-policy.test.mjs`

- [ ] **Step 1: Write failing policy tests**

Assert default mode is `disabled`; test mode accepts only configured test corp IDs, whitelisted users, direct messages, and synthetic/redacted classification; `raw_allowed` requires an explicit approved policy record and cannot be enabled by request input or prompt text.

- [ ] **Step 2: Run test**

Run: `node --test tests/dingtalk-enterprise-policy.test.mjs`  
Expected: FAIL because the service does not exist.

- [ ] **Step 3: Implement closed-by-default policy resolution**

Export `resolveDingtalkEnterprisePolicy` and `assertDingtalkPolicyOperationAllowed`. Read injected configuration, not chat content. Return structured denial reasons without secrets.

- [ ] **Step 4: Verify and commit**

Run: `node --test tests/dingtalk-enterprise-policy.test.mjs`  
Expected: PASS.  
Commit: `git commit -m "feat: add DingTalk enterprise privacy policy"`

### Task 2: Attachment intake and verified cleanup

**Files:**
- Create: `server/channel-attachment-intake.service.mjs`
- Create: `server/channel-attachment-cleanup.service.mjs`
- Test: `tests/channel-attachment-intake.test.mjs`

- [ ] **Step 1: Write failing intake tests**

Cover PDF/JPEG/PNG signatures, MIME mismatch, size/page/count limits, duplicate hash, sanitized filename, per-task directory, missing/expired download credential, successful immediate deletion, failed deletion quarantine, and TTL cleanup.

- [ ] **Step 2: Run test**

Run: `node --test tests/channel-attachment-intake.test.mjs`  
Expected: FAIL because intake modules do not exist.

- [ ] **Step 3: Implement streaming intake**

Stream to a task-scoped randomly named file while hashing and enforcing size. Validate magic bytes before handing a stable document reference to the policy import service. Never expose the path to Wukong.

- [ ] **Step 4: Implement cleanup receipts**

Return `{ documentId, sha256, deletedAt, cleanupStatus }`; on deletion failure move to quarantine, emit a security event, and prevent downstream model egress. TTL cleanup processes only managed task directories.

- [ ] **Step 5: Verify and commit**

Run: `node --test tests/channel-attachment-intake.test.mjs`  
Expected: PASS.  
Commit: `git commit -m "feat: securely ingest and clean channel attachments"`

### Task 3: Unified customer-data egress gate

**Files:**
- Create: `server/customer-data-egress-policy.service.mjs`
- Modify: `server/deepseek-privacy-gateway.mjs`
- Modify: `server/family-sales-chat.service.mjs`
- Modify: `server/c-policy-analysis.service.mjs`
- Test: `tests/customer-data-egress-policy.test.mjs`
- Test: `tests/deepseek-privacy-integration.test.mjs`

- [ ] **Step 1: Write failing policy tests**

Test `local_only` zero egress, `redacted_only` field allowlists per task, recursive scanning of messages/tool arguments/attachment references, P2/P3 tokenization, blocked raw OCR/image/path, and fallback to local/manual review after a failed scan.

- [ ] **Step 2: Run tests**

Run: `node --test tests/customer-data-egress-policy.test.mjs tests/deepseek-privacy-integration.test.mjs`  
Expected: FAIL because calls are not uniformly governed.

- [ ] **Step 3: Implement one egress decision API**

Export `prepareCustomerDataEgress({ taskType, destination, policy, payload, directIdentifiers })`. Return an allowed sanitized payload plus a safe manifest, or a typed denial. Existing model callers must use this API before fetch.

- [ ] **Step 4: Verify no bypass**

Search: `rg -n "fetchImpl\(|/chat/completions|responses" server` and document every customer-data caller in the test map. Focused tests must prove blocked payloads never reach the injected fetch stub.

- [ ] **Step 5: Verify and commit**

Run: `node --test tests/customer-data-egress-policy.test.mjs tests/deepseek-privacy-gateway.test.mjs tests/deepseek-privacy-integration.test.mjs tests/family-sales-review.test.mjs`  
Expected: PASS.  
Commit: `git commit -m "feat: enforce customer data model egress policy"`

### Task 4: Append-only channel audit and safe logging

**Files:**
- Create: `server/channel-security-audit.service.mjs`
- Modify: `server/sqlite-state-store.mjs`
- Test: `tests/channel-security-audit.test.mjs`
- Test: `tests/sqlite-state-store.test.mjs`

- [ ] **Step 1: Write failing audit tests**

Record identity, attachment, cleanup, model-route, field-action, Agent-call, and formal-save events. Assert events contain request/task/actor/action/result/policy version but no raw file, URL, token, phone, ID number, policy number, OCR, prompt, or model response.

- [ ] **Step 2: Add append-only SQLite storage**

Create `channel_security_audit_events`; expose append and filtered admin-read functions only. Do not expose update/delete through business routes.

- [ ] **Step 3: Add log redaction regression test**

Capture application logs from representative failures and scan for seeded secrets/direct identifiers. Expected match count: zero.

- [ ] **Step 4: Verify and commit**

Run: `node --test tests/channel-security-audit.test.mjs tests/sqlite-state-store.test.mjs`  
Expected: PASS.  
Commit: `git commit -m "feat: add channel security audit trail"`

### Task 5: Synthetic end-to-end PoC harness

**Files:**
- Create: `tests/fixtures/wukong-policy-poc/manifest.json`
- Create: `tests/wukong-policy-poc.test.mjs`
- Modify: `docs/harness-test-map.json`
- Modify: `docs/superpowers/specs/2026-07-11-hermes-dingtalk-agent-target-architecture.md`
- Modify: `docs/superpowers/specs/2026-07-11-agent-temporal-memory-engine-design.md`
- Modify: `docs/superpowers/specs/2026-07-11-dingtalk-policy-upload-privacy-design.md`

- [ ] **Step 1: Build a synthetic fixture manifest**

List synthetic files, expected recognized fields, expected masked channel fields, selected family/member, product option, and expected final policy. Mark every fixture `synthetic: true`; do not commit real customer documents.

- [ ] **Step 2: Write end-to-end test**

Drive identity confirmation, direct-chat attachment intake, OCR task, field/product/member actions, Sales Champion, Insurance Expert, final save, web resume, cleanup receipt, audit query, and replayed save. Assert one formal policy, no cross-family data, and no seeded identifier in Wukong responses/logs/egress captures.

- [ ] **Step 3: Run complete verification**

Run: `npm run check && npm run typecheck && npm test && npm run build && npm run harness:audit`  
Expected: all product checks and tests PASS; harness audit has no newly unmapped changed files or unsafe persistence fallback.

- [ ] **Step 4: Update design status truthfully**

Mark implemented requirements and remaining real-enterprise manual checks. Replace Hermes-as-channel statements with the approved Wukong architecture while retaining Hermes only as a future option. Do not mark real-policy mode approved without a recorded security decision.

- [ ] **Step 5: Commit**

Commit: `git commit -m "test: complete synthetic Wukong policy PoC"`

### Task 6: Manual test-enterprise acceptance

**Files:**
- Create: `docs/wukong-poc-runbook.md`

- [ ] **Step 1: Write exact runbook**

Include prerequisites, test corp ID, 1–3 advisor whitelist procedure, binding/unbinding, direct-message upload, group rejection, multi-page completion, cross-channel resume, Agent evidence checks, cleanup/audit queries, rollback, and incident contacts. Reference secret names only; never put values in the document.

- [ ] **Step 2: Execute with synthetic/redacted documents**

Record pass/fail evidence for every acceptance item and the software version/commit. Any identity leak, group acceptance, cleanup failure, cross-family access, duplicate save, or model-egress violation is release-blocking.

- [ ] **Step 3: Keep real-policy mode disabled**

After PoC, verify the effective enterprise policy remains `test_redacted_only`. Opening `raw_allowed` requires a separate approved security change and is not part of this implementation plan.

- [ ] **Step 4: Commit runbook and non-sensitive results**

Commit: `git commit -m "docs: add Wukong PoC acceptance runbook"`
