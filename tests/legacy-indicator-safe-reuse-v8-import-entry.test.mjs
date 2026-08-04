import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { importReviewedResponsibilityArtifacts } from '../scripts/import-reviewed-responsibility-artifacts.mjs';

const repoRoot = '/Volumes/OCR_ARCHIVE/OCR_insurance/.worktrees/dev-agent-semantic-integration';
const importerPath = path.join(repoRoot, 'scripts/import-reviewed-responsibility-artifacts.mjs');

function makeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-indicator-safe-reuse-v8-'));
  const dbPath = path.join(dir, 'policy-ocr.sqlite');
  const db = new DatabaseSync(dbPath);
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
  db.close();
  return { dir, dbPath };
}

function makeArtifact() {
  const sourceDigest = 'sha256:v8-approved-source';
  const sourceUrl = 'https://official.example.test/v8-approved.pdf';
  const evidence = (text) => [{
    label: 'responsibility_body',
    page: 7,
    exactText: text,
  }];
  return {
    company: '固定树测试保险公司',
    productName: '正式入口字段无损回归产品',
    sourceDigest,
    sourceUrl,
    sourceRecords: [{
      sourceRecordId: 'official-v8-1',
      sourceUrl,
      sourceTitle: '正式入口字段无损回归产品条款',
    }],
    audit: { status: 'approved' },
    responsibilities: [
      {
        responsibilityId: 'R-standalone',
        liability: '独立责任',
        card: { title: '独立责任' },
        sourceDigest,
        responsibilitySourceDigest: sourceDigest,
        sourceUrl,
        sourceExcerpt: '责任层回退文本不应覆盖指标证据。',
        indicators: [{
          indicatorName: '独立指标',
          responsibilityId: 'R-standalone',
          sourceDigest,
          responsibilitySourceDigest: sourceDigest,
          formulaText: 'policy.amount',
          normalizedFormula: 'policy.amount',
          basisDefinition: {
            key: 'contract_defined_effective_insured_amount',
            formulaText: '基本保险金额 + 累积红利保险金额',
          },
          requiredInputDetails: [{
            key: 'manualFormulaInputs',
            label: '官方保单年度累积红利保险金额',
          }],
          requiredInputs: ['policy.amount'],
          operands: ['policy.amount'],
          branches: [{ branchId: 'standalone', result: 'policy.amount' }],
          evidenceSegments: evidence('独立指标官方证据'),
          provenance: { source: 'approved_artifact', locator: 'page:7' },
          sourceExcerpt: '指标自己的证据文本。',
          indicatorCheckStatus: 'accepted_unified_pipeline',
        }],
      },
      {
        responsibilityId: 'R-parent',
        liability: '主责任',
        card: { title: '主责任' },
        sourceDigest,
        responsibilitySourceDigest: sourceDigest,
        sourceUrl,
        sourceExcerpt: '主责任官方证据。',
        indicators: [{
          indicatorName: '主责任分支指标',
          responsibilityId: 'R-parent',
          parentResponsibilityId: 'R-parent',
          branchId: 'branch-a',
          sourceDigest,
          responsibilitySourceDigest: sourceDigest,
          formulaText: 'max(policy.amount, policy.minimum)',
          normalizedFormula: 'max(policy.amount, policy.minimum)',
          requiredInputs: ['policy.amount', 'policy.minimum'],
          operands: ['policy.amount', 'policy.minimum'],
          branches: [{
            branchId: 'branch-a',
            condition: '满足主责任条件',
            result: 'max(policy.amount, policy.minimum)',
            operands: ['policy.amount', 'policy.minimum'],
          }],
          evidenceSegments: evidence('主责任分支官方证据'),
          provenance: { source: 'approved_artifact', locator: 'page:7#branch-a' },
          sourceExcerpt: '分支指标自己的证据文本。',
          indicatorCheckStatus: 'accepted_unified_pipeline',
        }],
      },
    ],
  };
}

test('formal deterministic shape preserves standalone and nested indicator semantics without legacy orphans', () => {
  const { dir, dbPath } = makeDb();
  const artifactPath = path.join(dir, 'approved.json');
  const artifact = makeArtifact();
  fs.writeFileSync(artifactPath, JSON.stringify(artifact));
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare('INSERT INTO knowledge_records (id, company, product_name, url, payload) VALUES (?, ?, ?, ?, ?)').run(
      1,
      artifact.company,
      artifact.productName,
      artifact.sourceUrl,
      JSON.stringify({ title: '旧 knowledge orphan', liability: '旧知识责任' }),
    );
    db.prepare('INSERT INTO optional_responsibility_records (id, company, product_name, liability, payload) VALUES (?, ?, ?, ?, ?)').run(
      'optional-orphan',
      artifact.company,
      artifact.productName,
      '旧 optional orphan',
      JSON.stringify({ liability: '旧 optional orphan' }),
    );
  } finally {
    db.close();
  }

  try {
    const result = importReviewedResponsibilityArtifacts({
      artifacts: [artifactPath],
      dbPath,
      write: true,
      now: '2026-08-01T00:00:00.000Z',
    });
    assert.equal(result.ok, true);
    assert.equal(result.acceptedResponsibilities, 2);
    assert.equal(result.materializedProducts, 1);
    assert.equal(result.materializedCards, 2);
    assert.equal(result.strictAlignment.strictAlignedProducts, 1);
    assert.deepEqual(result.strictAlignment.products[0].reasonCodes, []);

    const readDb = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const cards = readDb.prepare('SELECT title, payload FROM product_responsibility_cards WHERE company = ? AND product_name = ? ORDER BY title').all(artifact.company, artifact.productName).map((row) => ({
        title: row.title,
        payload: JSON.parse(row.payload),
      }));
      const records = readDb.prepare('SELECT payload FROM insurance_indicator_records WHERE company = ? AND product_name = ? ORDER BY id').all(artifact.company, artifact.productName).map((row) => JSON.parse(row.payload));
      assert.deepEqual(cards.map((card) => card.title), ['主责任', '独立责任']);
      assert.equal(records.length, 2);
      for (const indicator of [...records, ...cards.flatMap((card) => card.payload.indicators)]) {
        assert.match(indicator.responsibilityId, /^R-/u);
        assert.equal(indicator.sourceDigest, artifact.sourceDigest);
        assert.equal(indicator.responsibilitySourceDigest, artifact.sourceDigest);
        assert.equal(indicator.evidenceSegments[0].exactText.endsWith('官方证据'), true);
        assert.equal(indicator.sourceExcerpt.includes('官方证据'), true);
        assert.deepEqual(indicator.provenance.source, 'approved_artifact');
        assert.equal(typeof indicator.formulaText, 'string');
        assert.equal(typeof indicator.normalizedFormula, 'string');
        assert.ok(Array.isArray(indicator.requiredInputs));
        assert.ok(Array.isArray(indicator.operands));
        assert.ok(Array.isArray(indicator.branches));
      }
      const standalone = records.find((indicator) => indicator.liability === '独立责任');
      assert.equal(standalone.basisDefinition.key, 'contract_defined_effective_insured_amount');
      assert.equal(standalone.requiredInputDetails[0].key, 'manualFormulaInputs');
      const branch = cards.find((card) => card.title === '主责任').payload.indicators[0];
      assert.equal(branch.parentResponsibilityId, 'R-parent');
      assert.equal(branch.branchId, 'branch-a');
      assert.equal(cards.some((card) => /旧/u.test(card.title)), false);
    } finally {
      readDb.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI refuses any write that lacks a fixed-tree execution gate', () => {
  const { dir, dbPath } = makeDb();
  const artifactPath = path.join(dir, 'approved.json');
  fs.writeFileSync(artifactPath, JSON.stringify(makeArtifact()));
  try {
    assert.throws(
      () => execFileSync(process.execPath, [
        importerPath,
        `--db-path=${dbPath}`,
        `--artifacts=${artifactPath}`,
        '--sample-limit=10',
        '--write',
        '--isolated-clone',
      ], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }),
      (error) => /execution-gate/u.test(`${error.stderr || ''}${error.stdout || ''}`),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
