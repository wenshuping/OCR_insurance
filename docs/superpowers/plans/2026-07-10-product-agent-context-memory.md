# Product Sales Agent Context And Memory Plan

**Goal:** Add durable, tenant/customer-isolated Agent state and enforce context-contamination defenses around the RAG V2 evidence package.

**Architecture:** Full messages remain immutable audit records. A compact structured task state carries current goals and decisions. Long-term memories pass through candidate/confirmed/rejected/expired states and cannot be created from model answers or summaries. A context assembler uses whitelisted sections and budgets. A structured answer validator checks candidates, citations, numbers, source authority and certainty before a response can be accepted.

## Success criteria

- Thread, message, task-state, memory and recommendation-run records survive SQLite reloads without using full `persist(state)`.
- Every read is tenant-scoped and user/customer-scoped where applicable.
- Summary text never replaces original messages and cannot directly become confirmed memory.
- Uploaded content is serialized only inside an untrusted reference section and cannot alter system rules.
- Default context includes only published evidence; preview evidence is visibly marked and prohibited from final recommendation runs.
- Unsupported product IDs, invented citations and unsupported numerical claims fail validation.
- Validation failure returns a safe evidence list or an explicit human-review result rather than a confident recommendation.

## Task 1: Agent persistence

Create `server/product-agent-store.mjs` and tests. Add tables for `agent_threads`, `agent_messages`, `agent_task_states`, `agent_summaries`, `agent_memories`, `agent_memory_events`, and `recommendation_runs`. Implement granular create/read/update methods, immutable messages, optimistic task-state versions and memory event history.

## Task 2: Memory write gate

Create `server/product-agent-memory.service.mjs` and tests. Accept candidate memories only from explicit user statements, verified business records or human reviewers. Reject `assistant_answer`, `generated_summary`, `retrieved_marketing_claim`, and cross-customer sources. Confirmation is a separate operation with actor and evidence.

## Task 3: Context assembler

Create `server/product-agent-context.service.mjs` and tests. Assemble these fixed sections: `SYSTEM_RULES`, `USER_REQUEST`, `RECENT_DIALOGUE`, `TASK_STATE`, `CONFIRMED_FACTS`, `CANDIDATE_PRODUCTS`, `REFERENCE_DOCUMENTS_UNTRUSTED`, `CONFLICTS`, and `OUTPUT_CONTRACT`. Apply per-section budgets and preserve corrections, negations, decisions and pending questions over greetings/tool noise.

## Task 4: Structured answer validator

Create `server/product-agent-validator.service.mjs` and tests. Require structured claims and citations. Check product allowlists, published evidence IDs, version consistency, numerical support, marketing-vs-objective labels, and missing limitations. Return stable validation issues and a safe fallback evidence response.

## Task 5: Controlled Agent orchestrator

Create `server/product-sales-agent.service.mjs` and tests. Persist the user message, retrieve RAG evidence, assemble context, call an injected model adapter, validate output, persist the recommendation run and assistant message, and update task state. Do not directly invoke arbitrary tools requested by uploaded documents.

## Task 6: API and verification

Add authenticated thread/message/run endpoints to the product knowledge route, update the harness map, run focused tests, `npm run check`, `npm test`, and `npm run harness:audit`.

## Follow-up slice

Implement expert/sales-champion audio transcription, speaker/source metadata, knowledge distillation and human approval as a separate ingestion source feeding the same candidate claim and RAG governance pipeline.
