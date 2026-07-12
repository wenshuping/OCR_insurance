import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  buildDeepAnalyzeIndicatorReviewPackage,
  loadDeepAnalyzeIndicatorReviewSamples,
  renderDeepAnalyzePrompt,
} from '../scripts/export-deepanalyze-indicator-review-samples.mjs';

function makeTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepanalyze-indicator-review-'));
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
  return { dir, dbPath, db };
}

function insertKnowledge(db, row) {
  db.prepare(`
    INSERT INTO knowledge_records (id, company, product_name, url, payload)
    VALUES (?, ?, ?, ?, ?)
  `).run(row.id, row.company, row.productName, row.url || 'https://insurer.example/terms.pdf', JSON.stringify({
    id: row.id,
    company: row.company,
    productName: row.productName,
    title: `${row.productName}条款`,
    url: row.url || 'https://insurer.example/terms.pdf',
    pageText: row.pageText,
    evidenceLevel: 'insurer_official',
  }));
}

function insertIndicator(db, row) {
  db.prepare(`
    INSERT INTO insurance_indicator_records (id, company, product_name, coverage_type, liability, payload)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(row.id, row.company, row.productName, row.coverageType, row.liability, JSON.stringify(row));
}

function insertOptional(db, row) {
  db.prepare(`
    INSERT INTO optional_responsibility_records (id, company, product_name, liability, payload)
    VALUES (?, ?, ?, ?, ?)
  `).run(row.id, row.company, row.productName, row.liability, JSON.stringify({
    company: row.company,
    productName: row.productName,
    liability: row.liability,
    quantificationStatus: row.quantificationStatus,
    sourceRecordId: row.sourceRecordId,
    sourceExcerpt: row.sourceExcerpt,
  }));
}

function countRows(db) {
  return {
    knowledge: db.prepare('SELECT COUNT(*) AS count FROM knowledge_records').get().count,
    indicators: db.prepare('SELECT COUNT(*) AS count FROM insurance_indicator_records').get().count,
    optional: db.prepare('SELECT COUNT(*) AS count FROM optional_responsibility_records').get().count,
  };
}

test('exports read-only DeepAnalyze review samples from no-indicator and pending optional rows', async () => {
  const { dir, dbPath, db } = makeTempDb();
  try {
    insertKnowledge(db, {
      id: 101,
      company: '测试人寿',
      productName: '无指标医疗保险',
      pageText: '保险责任 住院医疗保险金 被保险人住院治疗，对实际发生的合理且必要的医疗费用，扣除已获补偿和免赔额后，按本合同约定的给付比例给付住院医疗保险金。',
    });
    insertKnowledge(db, {
      id: 102,
      company: '测试人寿',
      productName: '已有指标保险',
      pageText: '保险责任 身故保险金 被保险人身故，我们按基本保险金额给付身故保险金。',
    });
    insertKnowledge(db, {
      id: 103,
      company: '测试人寿',
      productName: '短文本保险',
      pageText: '保险责任。',
    });
    insertIndicator(db, {
      id: 'ind_existing',
      company: '测试人寿',
      productName: '已有指标保险',
      coverageType: '身故保障',
      liability: '身故保险金',
    });
    insertOptional(db, {
      id: 'opt_pending',
      company: '测试人寿',
      productName: '可选责任保险',
      liability: '意外伤害住院津贴保险金',
      quantificationStatus: 'pending_review',
      sourceRecordId: '101',
      sourceExcerpt: '意外伤害住院津贴保险金 被保险人因意外伤害住院治疗，我们按住院日额津贴乘以实际住院日数给付意外伤害住院津贴保险金。',
    });
    insertOptional(db, {
      id: 'opt_quantified',
      company: '测试人寿',
      productName: '已量化可选保险',
      liability: '轻症疾病保险金',
      quantificationStatus: 'quantified',
      sourceExcerpt: '轻症疾病保险金 按基本保险金额的30%给付。',
    });

    const before = countRows(db);
    const result = loadDeepAnalyzeIndicatorReviewSamples({
      dbPath,
      limit: 5,
      minExcerptLength: 20,
      maxExcerptChars: 260,
    });

    assert.equal(result.totalSamples, 2);
    assert.deepEqual(result.samples.map((sample) => sample.reviewId).sort(), [
      'no_indicator:101',
      'pending_optional:opt_pending',
    ]);
    assert.equal(result.samples.some((sample) => sample.productName === '已有指标保险'), false);
    assert.equal(result.samples.some((sample) => sample.reviewId === 'pending_optional:opt_quantified'), false);

    const outputDir = path.join(dir, 'reports');
    const summary = await buildDeepAnalyzeIndicatorReviewPackage({
      dbPath,
      outputDir,
      limit: 5,
      minExcerptLength: 20,
      maxExcerptChars: 260,
      now: new Date('2026-06-18T10:00:00.000Z'),
    });

    assert.equal(summary.sampleCount, 2);
    assert.equal(summary.dryRun, true);
    assert.equal(summary.writeTarget, 'reports_only');
    assert.deepEqual(countRows(db), before);

    const jsonlText = await fsp.readFile(summary.files.jsonlPath, 'utf8');
    const exported = jsonlText.trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(exported.map((sample) => sample.reviewId).sort(), [
      'no_indicator:101',
      'pending_optional:opt_pending',
    ]);

    const promptText = await fsp.readFile(summary.files.promptPath, 'utf8');
    assert.match(promptText, /只输出 JSON/u);
    assert.match(promptText, /可入库候选/u);
    assert.match(promptText, /deepanalyze-indicator-review-2026-06-18T10-00-00-000Z\.jsonl/u);

    const summaryText = await fsp.readFile(summary.files.summaryPath, 'utf8');
    assert.match(summaryText, /reports_only/u);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('renders prompt with source-grounded JSON instructions', () => {
  const prompt = renderDeepAnalyzePrompt({ jsonlFileName: 'samples.jsonl', sampleCount: 3 });
  assert.match(prompt, /samples\.jsonl/u);
  assert.match(prompt, /sourceQuote/u);
  assert.match(prompt, /不要写数据库/u);
  assert.match(prompt, /仍未识别/u);
});
