import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { createCashflowStore, ensureCashflowTable } from '../server/cashflow-store.mjs';

const TEST_DB_DIR = path.resolve('.runtime');
const TEST_DB_PATH = path.join(TEST_DB_DIR, 'test-cashflow-store.sqlite');

let db;

function seedPoliciesTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS policies (
      id INTEGER PRIMARY KEY,
      user_id INTEGER,
      guest_id TEXT,
      company TEXT,
      name TEXT,
      insured TEXT,
      created_at TEXT,
      updated_at TEXT,
      payload TEXT NOT NULL
    );
  `);
  db.prepare(`
    INSERT OR IGNORE INTO policies (id, user_id, guest_id, company, name, insured, created_at, updated_at, payload)
    VALUES (1, 1, '', 'TestCo', 'Product A', 'Insured A', '', '', '{}');
  `).run();
  db.prepare(`
    INSERT OR IGNORE INTO policies (id, user_id, guest_id, company, name, insured, created_at, updated_at, payload)
    VALUES (2, 1, '', 'TestCo', 'Product B', 'Insured B', '', '', '{}');
  `).run();
}

async function openTestDb() {
  await fs.mkdir(TEST_DB_DIR, { recursive: true });
  db = new DatabaseSync(TEST_DB_PATH);
  seedPoliciesTable();
}

async function closeAndRemoveTestDb() {
  if (db) {
    db.close();
    db = null;
  }
  try {
    await fs.unlink(TEST_DB_PATH);
  } catch { /* ignore */ }
  try {
    await fs.unlink(`${TEST_DB_PATH}-wal`);
  } catch { /* ignore */ }
  try {
    await fs.unlink(`${TEST_DB_PATH}-shm`);
  } catch { /* ignore */ }
}

describe('cashflow-store', () => {
  after(async () => {
    await closeAndRemoveTestDb();
  });

  describe('ensureCashflowTable', () => {
    beforeEach(async () => {
      await closeAndRemoveTestDb();
      await openTestDb();
    });

    it('creates the policy_cashflows table and index', () => {
      ensureCashflowTable(db);
      const tableInfo = db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'policy_cashflows'"
      ).get();
      assert.ok(tableInfo, 'policy_cashflows table should exist');

      const indexInfo = db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_cashflows_policy'"
      ).get();
      assert.ok(indexInfo, 'idx_cashflows_policy index should exist');
    });

    it('is idempotent (calling twice does not error)', () => {
      ensureCashflowTable(db);
      ensureCashflowTable(db);
      const tableInfo = db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'policy_cashflows'"
      ).get();
      assert.ok(tableInfo);
    });
  });

  describe('createCashflowStore', () => {
    beforeEach(async () => {
      await closeAndRemoveTestDb();
      await openTestDb();
    });

    it('creates the table and allows insert/query', () => {
      const store = createCashflowStore(db);
      assert.ok(store, 'store should be returned');
      assert.equal(typeof store.getEntries, 'function');
      assert.equal(typeof store.replaceEntries, 'function');
      assert.equal(typeof store.getAllPolicyIds, 'function');
      assert.equal(typeof store.getStatus, 'function');

      // Verify the table exists
      const tableInfo = db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'policy_cashflows'"
      ).get();
      assert.ok(tableInfo, 'policy_cashflows table should exist after createCashflowStore');
    });
  });

  describe('replaceEntries', () => {
    let store;

    beforeEach(async () => {
      await closeAndRemoveTestDb();
      await openTestDb();
      store = createCashflowStore(db);
    });

    it('clears old rows before inserting new ones', () => {
      const firstBatch = [
        { year: 2026, age: 30, amount: 1000, cumulative: 1000, liability: 'maturity', calcText: 'calc 1' },
        { year: 2027, age: 31, amount: 2000, cumulative: 3000, liability: 'maturity', calcText: 'calc 2' },
      ];
      store.replaceEntries(1, firstBatch);

      let entries = store.getEntries(1);
      assert.equal(entries.length, 2);

      const secondBatch = [
        { year: 2028, age: 32, amount: 5000, cumulative: 5000, liability: 'death', calcText: 'calc 3' },
      ];
      store.replaceEntries(1, secondBatch);

      entries = store.getEntries(1);
      assert.equal(entries.length, 1, 'old rows should be cleared');
      assert.equal(entries[0].year, 2028);
      assert.equal(entries[0].liability, 'death');
    });

    it('does not affect entries of other policy_ids', () => {
      store.replaceEntries(1, [
        { year: 2026, age: 30, amount: 1000, cumulative: 1000, liability: 'maturity', calcText: 'calc 1' },
      ]);
      store.replaceEntries(2, [
        { year: 2026, age: 25, amount: 500, cumulative: 500, liability: 'death', calcText: 'calc 2' },
      ]);

      // Replace policy 1 entries
      store.replaceEntries(1, [
        { year: 2027, age: 31, amount: 2000, cumulative: 2000, liability: 'maturity', calcText: 'new calc' },
      ]);

      // Policy 2 should be unchanged
      const entries2 = store.getEntries(2);
      assert.equal(entries2.length, 1);
      assert.equal(entries2[0].year, 2026);
      assert.equal(entries2[0].amount, 500);
    });
  });

  describe('getEntries', () => {
    let store;

    beforeEach(async () => {
      await closeAndRemoveTestDb();
      await openTestDb();
      store = createCashflowStore(db);
    });

    it('returns empty array for unknown policy_id', () => {
      const entries = store.getEntries(999);
      assert.ok(Array.isArray(entries));
      assert.equal(entries.length, 0);
    });

    it('returns entries ordered by year ASC', () => {
      store.replaceEntries(1, [
        { year: 2030, age: 34, amount: 5000, cumulative: 15000, liability: 'maturity', calcText: 'later' },
        { year: 2026, age: 30, amount: 1000, cumulative: 1000, liability: 'maturity', calcText: 'first' },
        { year: 2028, age: 32, amount: 3000, cumulative: 6000, liability: 'death', calcText: 'middle' },
      ]);

      const entries = store.getEntries(1);
      assert.equal(entries.length, 3);
      assert.equal(entries[0].year, 2026);
      assert.equal(entries[1].year, 2028);
      assert.equal(entries[2].year, 2030);
    });

    it('maps calc_text to camelCase calcText', () => {
      store.replaceEntries(1, [
        { year: 2026, age: 30, amount: 1000, cumulative: 1000, liability: 'maturity', calcText: 'some formula' },
      ]);

      const entries = store.getEntries(1);
      assert.equal(entries[0].calcText, 'some formula');
      assert.equal(entries[0].year, 2026);
      assert.equal(entries[0].age, 30);
      assert.equal(entries[0].amount, 1000);
      assert.equal(entries[0].cumulative, 1000);
      assert.equal(entries[0].liability, 'maturity');
    });

    it('handles entries with null calcText', () => {
      store.replaceEntries(1, [
        { year: 2026, age: 30, amount: 1000, cumulative: 1000, liability: 'maturity', calcText: null },
      ]);

      const entries = store.getEntries(1);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].calcText, null);
    });
  });

  describe('getStatus', () => {
    let store;

    beforeEach(async () => {
      await closeAndRemoveTestDb();
      await openTestDb();
      store = createCashflowStore(db);
    });

    it('returns correct counts', () => {
      let status = store.getStatus();
      assert.equal(status.totalEntries, 0);
      assert.equal(status.totalPolicies, 0);

      store.replaceEntries(1, [
        { year: 2026, age: 30, amount: 1000, cumulative: 1000, liability: 'maturity', calcText: 'a' },
        { year: 2027, age: 31, amount: 2000, cumulative: 3000, liability: 'death', calcText: 'b' },
      ]);
      store.replaceEntries(2, [
        { year: 2026, age: 25, amount: 500, cumulative: 500, liability: 'maturity', calcText: 'c' },
      ]);

      status = store.getStatus();
      assert.equal(status.totalEntries, 3);
      assert.equal(status.totalPolicies, 2);
    });
  });

  describe('getAllPolicyIds', () => {
    let store;

    beforeEach(async () => {
      await closeAndRemoveTestDb();
      await openTestDb();
      store = createCashflowStore(db);
    });

    it('returns distinct policy IDs', () => {
      let ids = store.getAllPolicyIds();
      assert.ok(Array.isArray(ids));
      assert.equal(ids.length, 0);

      store.replaceEntries(1, [
        { year: 2026, age: 30, amount: 1000, cumulative: 1000, liability: 'maturity', calcText: 'a' },
        { year: 2027, age: 31, amount: 2000, cumulative: 3000, liability: 'death', calcText: 'b' },
      ]);
      store.replaceEntries(2, [
        { year: 2026, age: 25, amount: 500, cumulative: 500, liability: 'maturity', calcText: 'c' },
      ]);

      ids = store.getAllPolicyIds();
      assert.equal(ids.length, 2);
      assert.ok(ids.includes(1));
      assert.ok(ids.includes(2));
    });
  });
});
