import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { createCashValueStore, ensureCashValueTable } from '../server/cashflow-store.mjs';

const TEST_DB_DIR = path.resolve('.runtime');
const TEST_DB_PATH = path.join(TEST_DB_DIR, 'test-cash-value-store.sqlite');

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
  try { await fs.unlink(TEST_DB_PATH); } catch { /* ignore */ }
  try { await fs.unlink(`${TEST_DB_PATH}-wal`); } catch { /* ignore */ }
  try { await fs.unlink(`${TEST_DB_PATH}-shm`); } catch { /* ignore */ }
}

describe('cash-value-store', () => {
  after(async () => {
    await closeAndRemoveTestDb();
  });

  describe('ensureCashValueTable', () => {
    beforeEach(async () => {
      await closeAndRemoveTestDb();
      await openTestDb();
    });

    it('creates the policy_cash_values table and index', () => {
      ensureCashValueTable(db);
      const tableInfo = db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'policy_cash_values'"
      ).get();
      assert.ok(tableInfo, 'policy_cash_values table should exist');

      const indexInfo = db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_cash_values_policy'"
      ).get();
      assert.ok(indexInfo, 'idx_cash_values_policy index should exist');
    });
  });

  describe('createCashValueStore', () => {
    let store;

    beforeEach(async () => {
      await closeAndRemoveTestDb();
      await openTestDb();
      store = createCashValueStore(db);
    });

    it('replaceValues inserts rows and getValues reads them back', () => {
      const rows = [
        { policyYear: 1, age: 30, cashValue: 8500 },
        { policyYear: 2, age: 31, cashValue: 19200 },
        { policyYear: 3, age: null, cashValue: 31800 },
      ];
      store.replaceValues(1, rows);

      const result = store.getValues(1);
      assert.equal(result.length, 3);
      assert.equal(result[0].policyYear, 1);
      assert.equal(result[0].age, 30);
      assert.equal(result[0].cashValue, 8500);
      assert.equal(result[0].source, 'ocr');
      assert.equal(result[2].age, null);
    });

    it('replaceValues overwrites previous data for same policy', () => {
      store.replaceValues(1, [
        { policyYear: 1, age: 30, cashValue: 8500 },
      ]);
      store.replaceValues(1, [
        { policyYear: 1, age: 30, cashValue: 9000 },
        { policyYear: 2, age: 31, cashValue: 20000 },
      ]);

      const result = store.getValues(1);
      assert.equal(result.length, 2);
      assert.equal(result[0].cashValue, 9000);
    });

    it('getValues returns empty array for policy with no cash values', () => {
      const result = store.getValues(999);
      assert.deepEqual(result, []);
    });

    it('replaceValues accepts source parameter', () => {
      store.replaceValues(1, [
        { policyYear: 1, age: 30, cashValue: 8500, source: 'vision_llm' },
      ]);
      const result = store.getValues(1);
      assert.equal(result[0].source, 'vision_llm');
    });

    it('replaceValues does not affect entries of other policy_ids', () => {
      store.replaceValues(1, [
        { policyYear: 1, age: 30, cashValue: 8500 },
      ]);
      store.replaceValues(2, [
        { policyYear: 1, age: 25, cashValue: 5000 },
      ]);

      store.replaceValues(1, [
        { policyYear: 1, age: 30, cashValue: 9000 },
        { policyYear: 2, age: 31, cashValue: 20000 },
      ]);

      const result1 = store.getValues(1);
      assert.equal(result1.length, 2);
      assert.equal(result1[0].cashValue, 9000);

      const result2 = store.getValues(2);
      assert.equal(result2.length, 1);
      assert.equal(result2[0].cashValue, 5000);
    });

    it('deleteValues removes rows for one policy only', () => {
      store.replaceValues(1, [
        { policyYear: 1, age: 30, cashValue: 8500 },
        { policyYear: 2, age: 31, cashValue: 19200 },
      ]);
      store.replaceValues(2, [
        { policyYear: 1, age: 25, cashValue: 5000 },
      ]);

      store.deleteValues(1);

      assert.deepEqual(store.getValues(1), []);
      assert.equal(store.getValues(2).length, 1);
    });
  });
});
