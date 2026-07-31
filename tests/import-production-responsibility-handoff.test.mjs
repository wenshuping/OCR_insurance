import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { importProductionResponsibilityHandoff } from '../scripts/import-production-responsibility-handoff.mjs';

function sha256(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function createDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE knowledge_records (
        id INTEGER PRIMARY KEY,
        company TEXT,
        product_name TEXT,
        url TEXT,
        payload TEXT NOT NULL
      );
      CREATE TABLE insurance_indicator_records (
        id TEXT PRIMARY KEY,
        company TEXT,
        product_name TEXT,
        coverage_type TEXT,
        liability TEXT,
        payload TEXT NOT NULL
      );
      CREATE TABLE optional_responsibility_records (
        id TEXT PRIMARY KEY,
        company TEXT,
        product_name TEXT,
        liability TEXT,
        payload TEXT NOT NULL
      );
    `);
  } finally {
    db.close();
  }
}

test('production responsibility handoff converts a complete semantic artifact without a scratch import file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'production-responsibility-handoff-'));
  const dbPath = path.join(dir, 'policy-ocr.sqlite');
  const artifactPath = path.join(dir, 'artifact.json');
  const manifestPath = path.join(dir, 'manifest.json');
  const mismatchedManifestPath = path.join(dir, 'mismatched-manifest.json');
  const company = '测试保险公司';
  const productName = '测试满期两全保险';
  const sourceUrl = 'https://insurer.example.com/terms.pdf';
  const sourceDigest = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  try {
    createDb(dbPath);
    fs.writeFileSync(artifactPath, `${JSON.stringify({
      company,
      productName,
      productIdentity: { sourceUrl, sourceDigest },
      responsibilities: [{
        liability: '满期保险金',
        triggerCondition: '被保险人生存至保险期间届满日',
        insurerObligation: '按基本保险金额的50%给付满期保险金，合同终止。',
        sourceExcerpt: '满期保险金：被保险人生存至保险期间届满日，按基本保险金额的50%给付满期保险金。',
        card: {
          title: '满期保险金',
          customerSummary: '保险期满仍生存，按基本保险金额的50%给付满期保险金。',
        },
        indicators: [{
          indicatorName: '满期保险金金额',
          formulaText: '满期保险金 = 基本保险金额 × 50%',
          normalizedFormula: 'benefit_amount = basic_insured_amount * 0.5',
          basisKey: 'basic_amount',
          calculationKey: 'percentage_of_basis',
          calculationStatus: 'display_only',
          calculationEligible: false,
          calculationReason: '需要保单基本保险金额。',
          requiredInputs: ['basic_insured_amount'],
          sourceExcerpt: '满期保险金：被保险人生存至保险期间届满日，按基本保险金额的50%给付满期保险金。',
        }],
      }],
    }, null, 2)}\n`);
    fs.writeFileSync(manifestPath, `${JSON.stringify({
      products: [{
        order: 1,
        company,
        productName,
        numericId: null,
        sourceDigest,
        sourceUrl,
        artifactPath: 'artifact.json',
        artifactSha256: sha256(artifactPath),
        expectedCards: 1,
        expectedIndicators: 1,
      }],
    }, null, 2)}\n`);

    const dryRun = importProductionResponsibilityHandoff({ manifestPath, dbPath });
    assert.equal(dryRun.ok, true);
    assert.equal(dryRun.dryRun, true);
    assert.equal(dryRun.validationIssueCount, 0);
    assert.equal(dryRun.imported.acceptedResponsibilities, 1);
    assert.equal(dryRun.targetPreflight.products[0].existingCards, 0);

    fs.writeFileSync(mismatchedManifestPath, `${JSON.stringify({
      products: [{
        order: 1,
        company,
        productName,
        sourceDigest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        sourceUrl,
        artifactPath: 'artifact.json',
        artifactSha256: sha256(artifactPath),
        expectedCards: 1,
        expectedIndicators: 1,
      }],
    }, null, 2)}\n`);
    const mismatched = importProductionResponsibilityHandoff({ manifestPath: mismatchedManifestPath, dbPath });
    assert.equal(mismatched.ok, false);
    assert.equal(mismatched.validationIssues.some((issue) => issue.includes('source_digest_mismatch')), true);

    const written = importProductionResponsibilityHandoff({ manifestPath, dbPath, write: true });
    assert.equal(written.ok, true);
    assert.equal(written.readback.validationIssueCount, 0);

    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const indicator = db.prepare(`
        SELECT payload FROM insurance_indicator_records
         WHERE company = ? AND product_name = ? AND liability = ?
      `).get(company, productName, '满期保险金');
      const payload = JSON.parse(indicator.payload);
      assert.equal(payload.sourceDigest, sourceDigest);
      assert.equal(payload.normalizedFormula, 'benefit_amount = basic_insured_amount * 0.5');
      assert.deepEqual(payload.requiredInputs, ['basic_insured_amount']);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
