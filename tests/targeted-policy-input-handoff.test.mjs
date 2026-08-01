import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  createTargetedPolicyInputHandoff,
  importTargetedPolicyInputHandoff,
} from '../scripts/targeted-policy-input-handoff.mjs';

const company = '测试保险公司';
const productName = '测试两全保险';
const sourceUrl = 'https://insurer.example.com/policy.pdf';

function createDb(dbPath, { includeInputs, userId = 88 } = {}) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE policies (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL,
        company TEXT NOT NULL,
        name TEXT NOT NULL,
        updated_at TEXT,
        payload TEXT NOT NULL
      );
      CREATE TABLE source_records (
        id INTEGER PRIMARY KEY,
        policy_id INTEGER NOT NULL REFERENCES policies(id),
        product_name TEXT NOT NULL,
        url TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE product_responsibility_cards (
        id TEXT PRIMARY KEY,
        company TEXT NOT NULL,
        product_name TEXT NOT NULL,
        title TEXT NOT NULL,
        source_url TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE TABLE insurance_indicator_records (
        id TEXT PRIMARY KEY,
        company TEXT NOT NULL,
        product_name TEXT NOT NULL,
        liability TEXT NOT NULL,
        payload TEXT NOT NULL
      );
    `);
    const payload = includeInputs ? {
      unrelated: 'preserve-me',
      amount: 100000,
      firstPremium: 10000,
      paymentPeriod: '10年交',
      date: '2025-01-01',
      insuredBirthday: '2000-01-01',
      plans: [{ name: productName, amount: 100000, premium: 10000 }],
      responsibilities: [{ title: '满期保险金' }],
      optionalResponsibilities: [],
    } : { unrelated: 'preserve-me' };
    db.prepare('INSERT INTO policies (id, user_id, company, name, updated_at, payload) VALUES (?, ?, ?, ?, ?, ?)')
      .run(1001, userId, company, productName, '2025-01-01T00:00:00.000Z', JSON.stringify(payload));
    db.prepare('INSERT INTO source_records (id, policy_id, product_name, url, payload) VALUES (?, ?, ?, ?, ?)')
      .run(1, 1001, productName, sourceUrl, '{}');
    db.prepare('INSERT INTO product_responsibility_cards (id, company, product_name, title, source_url, payload) VALUES (?, ?, ?, ?, ?, ?)')
      .run('card-1', company, productName, '满期保险金', sourceUrl, JSON.stringify({ sourceUrl }));
    db.prepare('INSERT INTO insurance_indicator_records (id, company, product_name, liability, payload) VALUES (?, ?, ?, ?, ?)')
      .run('indicator-1', company, productName, '满期保险金', JSON.stringify({ sourceUrl }));
  } finally {
    db.close();
  }
}

function writeScope(scopePath) {
  fs.writeFileSync(scopePath, `${JSON.stringify({
    format: 'policy-ocr-targeted-policy-input-scope-v1',
    products: [{
      order: 1,
      numericId: null,
      cardCompany: company,
      cardProductName: productName,
      cardSourceUrl: sourceUrl,
      policySourceProductNames: [productName],
      policySourceUrls: [sourceUrl],
      expectedPolicyCount: 1,
    }],
  }, null, 2)}\n`);
}

test('targeted policy input handoff patches only approved calculation inputs after exact target identity preflight', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'targeted-policy-input-handoff-'));
  const sourceDbPath = path.join(directory, 'source.sqlite');
  const targetDbPath = path.join(directory, 'target.sqlite');
  const scopePath = path.join(directory, 'scope.json');
  const handoffPath = path.join(directory, 'handoff.json');
  const backupDir = path.join(directory, 'backups');
  try {
    fs.mkdirSync(backupDir);
    createDb(sourceDbPath, { includeInputs: true });
    createDb(targetDbPath, { includeInputs: false });
    writeScope(scopePath);

    const exported = createTargetedPolicyInputHandoff({ sourceDbPath, scopePath, outputPath: handoffPath });
    assert.equal(exported.ok, true);
    assert.equal(exported.productCount, 1);
    assert.equal(exported.policyCount, 1);
    assert.equal(exported.products[0].inputPresence[0].amount, true);

    const dryRun = await importTargetedPolicyInputHandoff({ handoffPath, dbPath: targetDbPath });
    assert.equal(dryRun.ok, true);
    assert.equal(dryRun.dryRun, true);
    assert.equal(dryRun.validationIssueCount, 0);
    assert.deepEqual(dryRun.preflight.entries[0].changes.sort(), [
      'amount', 'date', 'firstPremium', 'insuredBirthday', 'optionalResponsibilities', 'paymentPeriod', 'plans', 'responsibilities',
    ]);

    const written = await importTargetedPolicyInputHandoff({ handoffPath, dbPath: targetDbPath, backupDir, write: true });
    assert.equal(written.ok, true);
    assert.equal(written.dryRun, false);
    assert.equal(written.modifiedTables.join(','), 'policies');
    assert.equal(written.readback.foreignKeyIssueCount, 0);
    assert.equal(written.readback.quickCheck, 'ok');
    assert.equal(fs.existsSync(written.backup.path), true);

    const target = new DatabaseSync(targetDbPath, { readOnly: true });
    try {
      const payload = JSON.parse(target.prepare('SELECT payload FROM policies WHERE id = 1001').get().payload);
      assert.equal(payload.unrelated, 'preserve-me');
      assert.equal(payload.amount, 100000);
      assert.equal(payload.firstPremium, 10000);
      assert.equal(payload.insuredBirthday, '2000-01-01');
      assert.equal(payload.plans[0].amount, 100000);
    } finally {
      target.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('targeted policy input handoff refuses a target policy with a different owner', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'targeted-policy-input-handoff-identity-'));
  const sourceDbPath = path.join(directory, 'source.sqlite');
  const targetDbPath = path.join(directory, 'target.sqlite');
  const scopePath = path.join(directory, 'scope.json');
  const handoffPath = path.join(directory, 'handoff.json');
  try {
    createDb(sourceDbPath, { includeInputs: true, userId: 88 });
    createDb(targetDbPath, { includeInputs: false, userId: 99 });
    writeScope(scopePath);
    assert.equal(createTargetedPolicyInputHandoff({ sourceDbPath, scopePath, outputPath: handoffPath }).ok, true);

    const dryRun = await importTargetedPolicyInputHandoff({ handoffPath, dbPath: targetDbPath });
    assert.equal(dryRun.ok, false);
    assert.equal(dryRun.validationIssues.some((issue) => issue.endsWith('target_user_id_mismatch')), true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
