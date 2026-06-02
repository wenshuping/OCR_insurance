# SQLite Cash Store Decoupling Design

## Summary

The current SQLite state store still uses a legacy full-state snapshot persist model. Most application state is held in memory, then `persist(state)` clears database-owned tables and reinserts rows from JSON payloads. This was useful while the product was moving fast, but it creates write amplification and makes independent tables harder to reason about.

This design only addresses the first low-risk slice: decouple `policy_cashflows` and `policy_cash_values` from full-state persist. These tables already have dedicated store APIs in `server/cashflow-store.mjs`, so they should be owned by those APIs rather than by `server/sqlite-state-store.mjs`.

## Goals

- Keep `policy_cashflows` intact when `persist(state)` runs.
- Keep `policy_cash_values` intact when `persist(state)` runs.
- Remove the need for `sqlite-state-store.mjs` to read and restore cash value rows around full-state persist.
- Remove the app-level workaround that recomputes all cashflows after every persist.
- Preserve existing API behavior for policy list, policy detail, cash value scan/confirm, policy create/update/delete, and admin cashflow recompute.
- Add tests proving cashflow and cash value rows survive ordinary full-state persist and reload.

## Non-Goals

- Do not convert `policies` to a repository in this phase.
- Do not convert `family_profiles`, `family_members`, or `family_report_shares` to repositories in this phase.
- Do not change knowledge, indicator, or optional responsibility persistence.
- Do not introduce an ORM.
- Do not split `server/app.mjs` routes.
- Do not change API response shapes.
- Do not clean `.runtime` backup files.

## Current Behavior

Current write path:

```text
state mutation
  -> persist(state)
      -> clearDbOwnedTables()
          -> deletes policy_cashflows
          -> deletes policy_cash_values
      -> insertRows(state)
      -> restoreCashValueRows()
  -> app-layer persist wrapper runs recomputeAllCashflow()
```

This creates two special cases:

- `policy_cash_values` must be read before table clearing and restored after state rows are reinserted.
- `policy_cashflows` must be regenerated after every persist because `clearDbOwnedTables()` deletes it.

Those special cases show that cash data no longer belongs inside the full-state snapshot boundary.

## Target Behavior

Target write path:

```text
state mutation
  -> persist(state)
      -> clears and reinserts only legacy state-owned tables
      -> does not touch policy_cashflows
      -> does not touch policy_cash_values

cashflow change
  -> cashflowStore.replaceEntries(policyId, entries)

cash value change
  -> cashValueStore.replaceValues(policyId, rows)

policy delete
  -> cashflowStore.replaceEntries(policyId, [])
  -> cashValueStore.deleteValues(policyId)
  -> remove policy from state
  -> persist(state)
```

The invariant is: `policy_cashflows` and `policy_cash_values` are local SQL tables owned by `cashflow-store.mjs`; they are not state snapshot tables.

## Module Responsibilities

### `server/sqlite-state-store.mjs`

Still responsible for:

- Creating the SQLite schema, including cashflow and cash value tables.
- Loading legacy state-owned tables at boot.
- Persisting legacy state-owned tables through `persist(state)`.
- Maintaining `nextId`, `app_meta`, and `state_documents`.

No longer responsible for:

- Deleting `policy_cashflows` during full-state persist.
- Deleting `policy_cash_values` during full-state persist.
- Reading and restoring cash value rows around full-state persist.
- Triggering or assuming cashflow recomputation.

### `server/cashflow-store.mjs`

Responsible for all direct writes to:

- `policy_cashflows`
- `policy_cash_values`

The existing store APIs remain the persistence boundary:

- `cashflowStore.replaceEntries(policyId, entries)`
- `cashflowStore.getEntries(policyId)`
- `cashflowStore.getStatus()`
- `cashValueStore.replaceValues(policyId, rows)`
- `cashValueStore.getValues(policyId)`
- `cashValueStore.deleteValues(policyId)`

### `server/app.mjs`

Still responsible for orchestration:

- Compute and store cashflows after policy creation.
- Recompute and store cashflows after relevant policy updates.
- Delete cashflow and cash value rows when a policy is deleted.
- Run `recomputeAllCashflow()` on startup unless explicitly disabled.
- Expose `/api/admin/cashflow/recompute` and `/api/admin/cashflow/status`.

No longer responsible for:

- Wrapping every `persist(state)` call to recompute all cashflows.

`recomputeAllCashflow()` remains useful for startup recovery and admin-driven rebuilds. It is no longer a correctness patch for ordinary persist.

## Implementation Plan

### Task 1: Add persistence tests

Modify `tests/sqlite-state-store.test.mjs`.

Add coverage that:

- Creates a store and persists a state with at least one policy.
- Writes `policy_cash_values` through `createCashValueStore(store.db)`.
- Writes `policy_cashflows` through `createCashflowStore(store.db)`.
- Calls `store.persist(state)` after mutating ordinary state fields.
- Verifies cash value rows still exist.
- Verifies cashflow rows still exist.
- Closes and reopens the store.
- Verifies both tables remain readable through their dedicated stores after reload.

The existing test named around cash values surviving persist should be kept but broadened to include cashflows and reload behavior.

### Task 2: Adjust full-state persist ownership

Modify `server/sqlite-state-store.mjs`.

Changes:

- Remove `DELETE FROM policy_cash_values;` from `clearDbOwnedTables()`.
- Remove `DELETE FROM policy_cashflows;` from `clearDbOwnedTables()`.
- Remove `readCashValueRows()` if it is no longer used.
- Remove `restoreCashValueRows()` if it is no longer used.
- Remove calls to read and restore cash value rows inside `persist(state)`.
- Keep `ensureCashflowTable(db)` and `ensureCashValueTable(db)` in `createSchema(db)`.

After this change, `persist(state)` should only rewrite legacy state-owned tables.

### Task 3: Remove app-level persist workaround

Modify `server/app.mjs`.

Changes:

- Remove the wrapper that calls `recomputeAllCashflow()` after every `rawPersist(s)`.
- Use `rawPersist` directly as `persist`.
- Keep `computeAndStoreCashflow(policy)` for policy create/update flows.
- Keep `recomputeAllCashflow()` for startup and admin recompute.
- Keep explicit delete cleanup:
  - `cashflowStore.replaceEntries(policyId, [])`
  - `cashValueStore.deleteValues(policyId)`

### Task 4: Verify behavior

Run:

```bash
npm run check
npm run typecheck
npm test
```

Acceptance criteria:

- Syntax and type checks pass.
- Full test suite passes.
- A normal `persist(state)` does not delete `policy_cashflows`.
- A normal `persist(state)` does not delete `policy_cash_values`.
- Policy creation and update still return cashflow entries where applicable.
- Policy delete still clears cashflow and cash value rows for the deleted policy.
- API response shapes do not change.

### Task 5: Commit

Commit only the files in this slice:

- `server/sqlite-state-store.mjs`
- `server/app.mjs`
- `tests/sqlite-state-store.test.mjs`

Suggested commit message:

```text
refactor: decouple cash stores from full-state persist
```

## Follow-Up Roadmap

### Phase 2: Policy Repository

Goal: move policy create, update, delete, list, and owner lookup to local SQL writes.

Possible module: `server/policy-repository.mjs`.

Initial API:

- `insertPolicy(policy)`
- `updatePolicy(policy)`
- `deletePolicy(policyId)`
- `listPoliciesByOwner(owner)`
- `findPolicyByIdForOwner(policyId, owner)`

`state.policies` can remain as a compatibility cache during migration. SQL should become the factual write path for migrated routes.

### Phase 3: Family Repository

Goal: move family profiles, family members, and family report shares out of full-state persist.

Possible module: `server/family-repository.mjs`.

Scope:

- Family creation.
- Member creation/update.
- Core member switching.
- Share snapshot creation and lookup.
- Owner-scoped validation at repository boundaries.

`server/family-profile.domain.mjs` should remain the pure domain rule module.

### Phase 4: Knowledge and Indicator Upserts

Goal: reduce large full-state rewrites for crawler and indicator synchronization data.

Scope:

- `knowledge_records`
- `insurance_indicator_records`
- `optional_responsibility_records`
- `official_domain_profiles`

Direction:

- Add batch upsert APIs.
- Keep dry-run paths for crawler and repair scripts.
- Add idempotency, skip-existing, and failure recovery tests.

## Risks and Controls

- Risk: cashflow rows for deleted policies may become orphaned if policy delete cleanup regresses.
  - Control: keep explicit delete cleanup and test it at app or store level.

- Risk: startup no longer repairs missing cashflow rows caused by older data.
  - Control: keep startup `recomputeAllCashflow()` and admin recompute.

- Risk: full-state persist and local stores drift in ownership expectations.
  - Control: document that cash tables are not state-owned and assert this in tests.

- Risk: future developers add cash tables back into `clearDbOwnedTables()`.
  - Control: test ordinary persist preserving both cash tables.

## Decision

Proceed with Phase 1 only. It is a low-risk architecture cleanup that removes a known workaround and establishes the repository direction without changing the larger policy or family persistence model.
