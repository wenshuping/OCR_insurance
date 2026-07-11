# Wukong Domain Agents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose Sales Champion and Insurance Expert as narrow, evidence-preserving MCP tools without exposing their private tools or raw customer data.

**Architecture:** Add one adapter per domain Agent. Each adapter receives server-resolved owner/task references, assembles its own authorized context, invokes existing Agent services, validates output, and returns a channel-safe envelope.

**Tech Stack:** Node.js ESM, existing family sales chat and policy analysis services, MCP gateway registry, Node test runner.

---

### Task 1: Shared domain-Agent envelope

**Files:**
- Create: `server/domain-agent-tool-contract.service.mjs`
- Test: `tests/domain-agent-tool-contract.test.mjs`

- [ ] **Step 1: Write failing contract tests**

Assert `buildDomainAgentEnvelope` preserves `answer`, `evidence`, `limitations`, `missingInformation`, `taskId`, and `agent`, while recursively removing ID numbers, mobile numbers, raw OCR, data URLs, storage paths, hidden prompts, and tool traces.

- [ ] **Step 2: Run test**

Run: `node --test tests/domain-agent-tool-contract.test.mjs`  
Expected: FAIL because the contract module does not exist.

- [ ] **Step 3: Implement schema validation and recursive sanitization**

Reject envelopes without a known agent (`sales_champion` or `insurance_expert`) or string answer. Evidence entries must have a safe label and source/version reference; never return internal prompt or chain-of-thought fields.

- [ ] **Step 4: Verify and commit**

Run: `node --test tests/domain-agent-tool-contract.test.mjs`  
Expected: PASS.  
Commit: `git commit -m "feat: add domain agent tool contract"`

### Task 2: Sales Champion tool adapter

**Files:**
- Create: `server/sales-champion-tool.service.mjs`
- Modify: `server/family-sales-chat.service.mjs`
- Modify: `server/wukong-mcp-gateway.service.mjs`
- Test: `tests/sales-champion-tool.test.mjs`

- [ ] **Step 1: Write failing adapter tests**

Test owner/family isolation, optional `policyImportTaskId`, masked import context, confirmed-memory-only context, skill routing, timeout behavior, and rejection of raw family facts supplied by the caller.

- [ ] **Step 2: Run test**

Run: `node --test tests/sales-champion-tool.test.mjs`  
Expected: FAIL because the adapter is absent.

- [ ] **Step 3: Implement `askSalesChampionTool`**

Accept `{ question, familyRef, policyImportTaskId?, requestId }`; resolve the family and task from internal owner context, then call the existing sales-chat service. Return the shared safe envelope and a structured `AGENT_TIMEOUT` without mutating task or memory.

- [ ] **Step 4: Register `ask_sales_champion` and verify**

Run: `node --test tests/sales-champion-tool.test.mjs tests/family-sales-review.test.mjs tests/wukong-mcp-gateway.test.mjs`  
Expected: PASS.

- [ ] **Step 5: Commit**

Commit: `git commit -m "feat: expose Sales Champion as a tool"`

### Task 3: Insurance Expert tool adapter

**Files:**
- Create: `server/insurance-expert-tool.service.mjs`
- Modify: `server/wukong-mcp-gateway.service.mjs`
- Test: `tests/insurance-expert-tool.test.mjs`

- [ ] **Step 1: Write failing adapter tests**

Test task/family isolation, policy version/evidence preservation, missing evidence, high-risk limitations, timeout behavior, and guarantee that task raw scan/OCR is not returned to the gateway.

- [ ] **Step 2: Run test**

Run: `node --test tests/insurance-expert-tool.test.mjs`  
Expected: FAIL because the adapter is absent.

- [ ] **Step 3: Implement `askInsuranceExpertTool`**

Accept `{ question, policyRef?, policyImportTaskId?, requestId }`; resolve authorized facts internally, call the existing analyzer, pass the result through `sanitizeStoredPolicyAnalysis`, then produce the shared envelope with evidence and limitations.

- [ ] **Step 4: Register and verify**

Run: `node --test tests/insurance-expert-tool.test.mjs tests/policy-analysis-prompt.test.mjs tests/wukong-mcp-gateway.test.mjs`  
Expected: PASS.

- [ ] **Step 5: Commit**

Commit: `git commit -m "feat: expose Insurance Expert as a tool"`

### Task 4: Tool permission and regression gate

**Files:**
- Modify: `server/agent-skill-router.service.mjs`
- Modify: `docs/harness-test-map.json`
- Test: `tests/agent-skill-router.test.mjs`
- Test: `tests/wukong-mcp-gateway.test.mjs`

- [ ] **Step 1: Add failing permission tests**

Assert Wukong can call only the two public Agent entries and intake/memory tools; it cannot enumerate or call terminal, file, SQL, underlying evidence search, policy mutation, hidden prompt, or the other Agent's private tools.

- [ ] **Step 2: Implement explicit allowlists**

Make allowlists deterministic by channel and tool name; model-selected skills never grant permissions absent from the server allowlist.

- [ ] **Step 3: Run cross-boundary verification**

Run: `npm run check && node --test tests/domain-agent-tool-contract.test.mjs tests/sales-champion-tool.test.mjs tests/insurance-expert-tool.test.mjs tests/agent-skill-router.test.mjs tests/wukong-mcp-gateway.test.mjs && npm test`  
Expected: focused and full suites PASS.

- [ ] **Step 4: Commit**

Commit: `git commit -m "test: enforce Wukong domain agent boundaries"`
