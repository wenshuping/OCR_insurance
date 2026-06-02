# SQLite Cash Store Decoupling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decouple `policy_cashflows` and `policy_cash_values` from the legacy full-state `persist(state)` path so cash tables are owned only by `server/cashflow-store.mjs`.

**Architecture:** Keep `server/sqlite-state-store.mjs` as the legacy boot/load/full-state persist layer, but stop letting it delete or restore cash tables. Keep `server/cashflow-store.mjs` as the sole write boundary for `policy_cashflows` and `policy_cash_values`. Keep `server/app.mjs` orchestration for explicit create/update/delete/admin recompute flows, but remove the persist-after-every-write cashflow recompute workaround.

**Tech Stack:** Node.js ESM, Express, `node:sqlite` `DatabaseSync`, Node test runner, existing cashflow/cash-value stores.

---

## Scope Notes

This plan implements Phase 1 only from `docs/superpowers/specs/2026-06-02-sqlite-cash-store-decoupling-design.md`.

It does not convert `policies`, family profiles, knowledge records, or indicators to repositories.

The current checkout has unrelated uncommitted changes in several application files. Before implementation, use `git status --short` and stage only files listed in each task.

## Files

- Modify: `tests/sqlite-state-store.test.mjs`
  - Broaden the cash persistence test so it covers both `policy_cash_values` and `policy_cashflows`.
  - Verify rows survive ordinary `persist(state)` and reload.
- Modify: `server/sqlite-state-store.mjs`
  - Stop deleting cash tables in `clearDbOwnedTables()`.
  - Remove the cash value read/restore workaround from `persist(state)`.
  - Keep schema creation for cash tables.
- Modify: `server/app.mjs`
  - Remove the `persist()` wrapper that calls `recomputeAllCashflow()` after every state save.
  - Keep startup/admin recompute and explicit policy create/update/delete cash store writes.

## Task 1: Add Failing Persistence Coverage

**Files:**
- Modify: `tests/sqlite-state-store.test.mjs`
- Test: `tests/sqlite-state-store.test.mjs`

- [ ] **Step 1: Update test imports**

In `tests/sqlite-state-store.test.mjs`, replace this import:

```js
import { createCashValueStore } from '../server/cashflow-store.mjs';
```

with:

```js
import { createCashflowStore, createCashValueStore } from '../server/cashflow-store.mjs';
```

- [ ] **Step 2: Replace the existing cash value persist test**

Replace the test named:

```js
test('sqlite state store can persist after cash values have been saved', async () => {
```

with this complete test:

```js
test('sqlite state store leaves cash stores untouched across persist and reload', async () => {
  const dir = await makeTempDir();
  const dbPath = path.join(dir, 'policy-ocr.sqlite');
  const state = {
    users: [{ id: 1, mobile: '18616135811', createdAt: '2026-05-01T00:00:00.000Z', updatedAt: '2026-05-01T00:00:00.000Z' }],
    policies: [{ id: 3, userId: 1, guestId: '', company: '新华保险', name: '盛世荣耀', insured: '温舒萍', createdAt: '2026-05-01T00:03:00.000Z', updatedAt: '2026-05-01T00:03:00.000Z' }],
    nextId: 4,
  };

  const store = await createSqliteStateStore({ dbPath });
  await store.persist(state);

  const cashValueStore = createCashValueStore(store.db);
  const cashflowStore = createCashflowStore(store.db);
  cashValueStore.replaceValues(3, [
    { policyYear: 1, age: 30, cashValue: 8500 },
    { policyYear: 2, age: 31, cashValue: 19200 },
  ]);
  cashflowStore.replaceEntries(3, [
    { year: 2026, age: 30, amount: 1000, cumulative: 1000, liability: '生存金', calcText: '第1年给付1000' },
    { year: 2027, age: 31, amount: 2000, cumulative: 3000, liability: '生存金', calcText: '第2年给付2000' },
  ]);

  state.policies[0].updatedAt = '2026-05-01T00:04:00.000Z';
  await store.persist(state);

  assert.deepEqual(cashValueStore.getValues(3), [
    { policyYear: 1, age: 30, cashValue: 8500, source: 'ocr' },
    { policyYear: 2, age: 31, cashValue: 19200, source: 'ocr' },
  ]);
  assert.deepEqual(cashflowStore.getEntries(3).map((entry) => ({
    year: entry.year,
    age: entry.age,
    amount: entry.amount,
    cumulative: entry.cumulative,
    liability: entry.liability,
    calcText: entry.calcText,
  })), [
    { year: 2026, age: 30, amount: 1000, cumulative: 1000, liability: '生存金', calcText: '第1年给付1000' },
    { year: 2027, age: 31, amount: 2000, cumulative: 3000, liability: '生存金', calcText: '第2年给付2000' },
  ]);

  store.close();

  const reopened = await createSqliteStateStore({ dbPath });
  const reloadedCashValueStore = createCashValueStore(reopened.db);
  const reloadedCashflowStore = createCashflowStore(reopened.db);

  assert.deepEqual(reloadedCashValueStore.getValues(3), [
    { policyYear: 1, age: 30, cashValue: 8500, source: 'ocr' },
    { policyYear: 2, age: 31, cashValue: 19200, source: 'ocr' },
  ]);
  assert.deepEqual(reloadedCashflowStore.getEntries(3).map((entry) => ({
    year: entry.year,
    age: entry.age,
    amount: entry.amount,
    cumulative: entry.cumulative,
    liability: entry.liability,
    calcText: entry.calcText,
  })), [
    { year: 2026, age: 30, amount: 1000, cumulative: 1000, liability: '生存金', calcText: '第1年给付1000' },
    { year: 2027, age: 31, amount: 2000, cumulative: 3000, liability: '生存金', calcText: '第2年给付2000' },
  ]);

  reopened.close();
});
```

- [ ] **Step 3: Run the focused test and verify it fails**

Run:

```bash
node --test tests/sqlite-state-store.test.mjs --test-name-pattern="cash stores"
```

Expected before implementation:

```text
not ok ... sqlite state store leaves cash stores untouched across persist and reload
```

The failure should show that `cashflowStore.getEntries(3)` is empty after `store.persist(state)` because `clearDbOwnedTables()` still deletes `policy_cashflows`.

- [ ] **Step 4: Commit the failing test**

Only commit if the test fails for the expected reason.

```bash
git add tests/sqlite-state-store.test.mjs
git commit -m "test: cover cash stores across full-state persist"
```

## Task 2: Stop Full-State Persist From Owning Cash Tables

**Files:**
- Modify: `server/sqlite-state-store.mjs`
- Test: `tests/sqlite-state-store.test.mjs`

- [ ] **Step 1: Remove cash tables from `clearDbOwnedTables()`**

In `server/sqlite-state-store.mjs`, find `function clearDbOwnedTables(db)`.

Change it from:

```js
function clearDbOwnedTables(db) {
  db.exec(`
    DELETE FROM policy_cash_values;
    DELETE FROM policy_cashflows;
    DELETE FROM family_report_shares;
    DELETE FROM family_members;
    DELETE FROM family_profiles;
    DELETE FROM users;
    DELETE FROM sessions;
    DELETE FROM admin_sessions;
    DELETE FROM sms_codes;
    DELETE FROM policies;
    DELETE FROM pending_scans;
    DELETE FROM source_records;
    DELETE FROM knowledge_records;
    DELETE FROM insurance_indicator_records;
    DELETE FROM optional_responsibility_records;
    DELETE FROM official_domain_profiles;
    DELETE FROM state_documents;
  `);
}
```

to:

```js
function clearDbOwnedTables(db) {
  db.exec(`
    DELETE FROM family_report_shares;
    DELETE FROM family_members;
    DELETE FROM family_profiles;
    DELETE FROM users;
    DELETE FROM sessions;
    DELETE FROM admin_sessions;
    DELETE FROM sms_codes;
    DELETE FROM policies;
    DELETE FROM pending_scans;
    DELETE FROM source_records;
    DELETE FROM knowledge_records;
    DELETE FROM insurance_indicator_records;
    DELETE FROM optional_responsibility_records;
    DELETE FROM official_domain_profiles;
    DELETE FROM state_documents;
  `);
}
```

- [ ] **Step 2: Remove unused cash value preservation helpers**

Delete these functions from `server/sqlite-state-store.mjs`:

```js
function readCashValueRows(db) {
  return db.prepare(`
    SELECT policy_id, policy_year, age, cash_value, source
      FROM policy_cash_values
     ORDER BY policy_id ASC, policy_year ASC
  `).all();
}
```

and:

```js
function restoreCashValueRows(db, rows, state) {
  if (!Array.isArray(rows) || !rows.length) return;
  const policyIds = new Set(
    normalizeArray(state.policies)
      .map((policy) => Number(policy?.id))
      .filter((id) => Number.isFinite(id)),
  );
  if (!policyIds.size) return;

  const insertCashValue = db.prepare(`
    INSERT INTO policy_cash_values (policy_id, policy_year, age, cash_value, source)
    VALUES (?, ?, ?, ?, ?)
  `);
  const seen = new Set();
  for (const row of rows) {
    const policyId = Number(row.policy_id);
    const policyYear = Number(row.policy_year);
    const cashValue = Number(row.cash_value);
    if (!policyIds.has(policyId) || !Number.isFinite(policyYear) || !Number.isFinite(cashValue)) continue;

    const key = `${policyId}\u001f${policyYear}`;
    if (seen.has(key)) continue;
    seen.add(key);
    insertCashValue.run(
      policyId,
      policyYear,
      Number.isFinite(Number(row.age)) ? Number(row.age) : null,
      cashValue,
      String(row.source || 'ocr'),
    );
  }
}
```

- [ ] **Step 3: Simplify `persist(state)`**

In `server/sqlite-state-store.mjs`, change this block inside `async function persist(state)`:

```js
    try {
      const cashValueRows = readCashValueRows(db);
      clearDbOwnedTables(db);
      insertRows(db, nextState);
      restoreCashValueRows(db, cashValueRows, nextState);
      setMeta(db, 'next_id', String(nextState.nextId));
      setMeta(db, 'state_initialized_at', initializedAt || now);
      setMeta(db, 'updated_at', now);
```

to:

```js
    try {
      clearDbOwnedTables(db);
      insertRows(db, nextState);
      setMeta(db, 'next_id', String(nextState.nextId));
      setMeta(db, 'state_initialized_at', initializedAt || now);
      setMeta(db, 'updated_at', now);
```

- [ ] **Step 4: Run the focused test and verify it passes**

Run:

```bash
node --test tests/sqlite-state-store.test.mjs --test-name-pattern="cash stores"
```

Expected:

```text
ok ... sqlite state store leaves cash stores untouched across persist and reload
```

- [ ] **Step 5: Run the full SQLite state store tests**

Run:

```bash
node --test tests/sqlite-state-store.test.mjs
```

Expected:

```text
fail 0
```

- [ ] **Step 6: Commit the state store change**

```bash
git add server/sqlite-state-store.mjs tests/sqlite-state-store.test.mjs
git commit -m "refactor: keep cash stores outside full-state persist"
```

## Task 3: Remove App-Level Persist Recompute Workaround

**Files:**
- Modify: `server/app.mjs`
- Test: `tests/policy-ocr-flow.test.mjs`
- Test: `tests/sqlite-state-store.test.mjs`

- [ ] **Step 1: Replace the persist wrapper**

In `server/app.mjs`, find this block:

```js
  const rawPersist = typeof options.persist === 'function' ? options.persist : async () => undefined;
  const adminPassword = resolveAdminPassword(options);
  const performanceLogger = createPerformanceLogger(options);

  // Wrapped persist: after every state save, recompute all cashflow entries
  // because clearDbOwnedTables() wipes policy_cashflows on each persist.
  const persist = async (s) => {
    const result = await rawPersist(s);
    if (typeof recomputeAllCashflow === 'function') {
      try { recomputeAllCashflow(); } catch { /* non-fatal */ }
    }
    return result;
  };
```

Replace it with:

```js
  const persist = typeof options.persist === 'function' ? options.persist : async () => undefined;
  const adminPassword = resolveAdminPassword(options);
  const performanceLogger = createPerformanceLogger(options);
```

This removes the app-level after-persist cashflow recompute.

- [ ] **Step 2: Update the cashflow recompute comment**

In `server/app.mjs`, find this comment:

```js
  /**
   * Recompute cashflow entries for ALL policies.
   * Called after persist() to restore cashflow data that was wiped by clearDbOwnedTables.
   */
```

Replace it with:

```js
  /**
   * Recompute cashflow entries for all policies.
   * Used on startup and by the admin recompute endpoint to rebuild derived rows.
   */
```

- [ ] **Step 3: Confirm explicit policy create/update/delete writes remain**

Do not change these existing behaviors in `server/app.mjs`.

Policy creation must still contain:

```js
      const result = computeAndStoreCashflow(policy);
      cashflowEntries = result.cashflowEntries;
      scenarioEntries = result.scenarioEntries;
      totalCashflow = result.totalCashflow;
```

Policy update must still contain:

```js
      const result = computeAndStoreCashflow(policy);
      cashflowEntries = result.cashflowEntries;
      scenarioEntries = result.scenarioEntries;
      totalCashflow = result.totalCashflow;
```

Policy delete must still contain:

```js
      cashflowStore.replaceEntries(policyId, []);
      cashValueStore.deleteValues(policyId);
```

- [ ] **Step 4: Run focused tests**

Run:

```bash
node --test tests/sqlite-state-store.test.mjs tests/policy-ocr-flow.test.mjs --test-name-pattern="cash stores|cash value|delete|cashflow|policy save"
```

Expected:

```text
fail 0
```

If the test-name pattern matches more tests than expected, that is acceptable. All matched tests must pass.

- [ ] **Step 5: Commit the app cleanup**

```bash
git add server/app.mjs
git commit -m "refactor: remove persist cashflow recompute workaround"
```

## Task 4: Full Verification

**Files:**
- No new source changes expected.

- [ ] **Step 1: Run syntax check**

```bash
npm run check
```

Expected:

```text
node --check server/*.mjs && node --check ocr-service/*.mjs && node --check tests/*.test.mjs
```

Command exits with status 0.

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```

Expected:

```text
tsc --noEmit
```

Command exits with status 0.

- [ ] **Step 3: Run full test suite**

```bash
npm test
```

Expected:

```text
tests 431
fail 0
```

The exact test count may increase by one if the updated test is counted differently. The required result is `fail 0`.

- [ ] **Step 4: Inspect for accidental cash table ownership**

Run:

```bash
rg -n "policy_cashflows|policy_cash_values|readCashValueRows|restoreCashValueRows|recomputeAllCashflow" server/sqlite-state-store.mjs server/app.mjs tests/sqlite-state-store.test.mjs
```

Expected:

```text
server/sqlite-state-store.mjs: ensureCashflowTable and ensureCashValueTable imports/usages remain
server/app.mjs: recomputeAllCashflow remains for startup/admin only
tests/sqlite-state-store.test.mjs: cash store preservation test references both tables through stores
```

There must be no `DELETE FROM policy_cashflows`, no `DELETE FROM policy_cash_values`, no `readCashValueRows`, and no `restoreCashValueRows`.

- [ ] **Step 5: Confirm git scope**

Run:

```bash
git status --short
```

Expected staged/committed files for this slice:

```text
server/sqlite-state-store.mjs
server/app.mjs
tests/sqlite-state-store.test.mjs
```

Unrelated pre-existing dirty files may still appear. Do not include them in this slice.

## Task 5: Final Integration Commit If Needed

**Files:**
- Modify only if previous task commits were skipped or squashed.

- [ ] **Step 1: Check whether implementation commits already exist**

Run:

```bash
git log --oneline -5
```

Expected if using the per-task commits above:

```text
refactor: remove persist cashflow recompute workaround
refactor: keep cash stores outside full-state persist
test: cover cash stores across full-state persist
```

- [ ] **Step 2: If per-task commits were not made, make one scoped commit**

Only run this if Tasks 1-3 were not already committed.

```bash
git add server/sqlite-state-store.mjs server/app.mjs tests/sqlite-state-store.test.mjs
git commit -m "refactor: decouple cash stores from full-state persist"
```

- [ ] **Step 3: Report completion**

Report:

```text
Implemented Phase 1 cash store decoupling.
Verified with npm run check, npm run typecheck, and npm test.
Cash tables are no longer cleared by full-state persist.
```

Also report any unrelated dirty files that remain.

## Self-Review

- Spec coverage: The plan covers tests, state-store ownership changes, app-level persist cleanup, verification, and commit scope from the approved spec.
- Placeholder scan: No red-flag placeholder language or vague "add tests" steps remain; test and code snippets are included where edits are required.
- Type consistency: The plan uses existing names from the codebase: `createSqliteStateStore`, `createCashflowStore`, `createCashValueStore`, `cashflowStore.replaceEntries`, `cashValueStore.replaceValues`, `cashValueStore.deleteValues`, and `recomputeAllCashflow`.
