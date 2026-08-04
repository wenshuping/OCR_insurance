import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { resolveIndicatorAmountFromCalculation } from '../src/indicator-calculation.mjs';
import {
  createStaticResponsibilityHandoff,
  importStaticResponsibilityHandoff,
} from '../scripts/static-responsibility-handoff.mjs';

const sourceUrl = 'https://insurer.example.com/terms.pdf';

function sourceDigest(index) {
  return `sha256:${String(index).padStart(64, 'a').slice(-64)}`;
}

function createDb(dbPath, { oldTargetRows = false, conflictingTarget = false } = {}) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE product_responsibility_cards (
        id TEXT PRIMARY KEY,
        product_key TEXT NOT NULL,
        company TEXT,
        product_name TEXT,
        title TEXT,
        category TEXT,
        cashflow_treatment TEXT,
        calculation_status TEXT,
        calculation_reason TEXT,
        responsibility_scope TEXT,
        selection_status TEXT,
        source_url TEXT,
        generated_at TEXT,
        updated_at TEXT,
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
    `);
    if (oldTargetRows || conflictingTarget) {
      const digest = conflictingTarget ? 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' : sourceDigest(1);
      db.prepare(`
        INSERT INTO product_responsibility_cards (
          id, product_key, company, product_name, title, category, cashflow_treatment,
          calculation_status, calculation_reason, responsibility_scope, selection_status,
          source_url, generated_at, updated_at, payload
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'old-card-1', 'company_product:测试保险公司1:测试产品1', '测试保险公司1', '测试产品1', '旧责任', '现金流',
        'scheduled_cashflow', 'display_only', '', 'basic_or_unspecified', 'selected', sourceUrl,
        '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', JSON.stringify({
          sourceUrl,
          sourceDigest: digest,
          indicators: [{ id: 'old-indicator-1', liability: '旧责任', sourceUrl, sourceDigest: digest }],
        }),
      );
      db.prepare(`
        INSERT INTO insurance_indicator_records (id, company, product_name, coverage_type, liability, payload)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('old-indicator-1', '测试保险公司1', '测试产品1', '现金流', '旧责任', JSON.stringify({ sourceUrl, sourceDigest: digest }));
    }
  } finally {
    db.close();
  }
}

function scopeProducts() {
  return Array.from({ length: 9 }, (_value, index) => ({
    order: index + 1,
    numericId: null,
    company: `测试保险公司${index + 1}`,
    productName: `测试产品${index + 1}`,
    sourceDigest: sourceDigest(index + 1),
    sourceUrl,
    expectedCards: 1,
    expectedIndicators: 1,
  }));
}

function seedSourceRows(dbPath, products) {
  const db = new DatabaseSync(dbPath);
  try {
    const insertCard = db.prepare(`
      INSERT INTO product_responsibility_cards (
        id, product_key, company, product_name, title, category, cashflow_treatment,
        calculation_status, calculation_reason, responsibility_scope, selection_status,
        source_url, generated_at, updated_at, payload
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertIndicator = db.prepare(`
      INSERT INTO insurance_indicator_records (id, company, product_name, coverage_type, liability, payload)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const product of products) {
      const indicatorId = `indicator-${product.order}`;
      const indicator = {
        id: indicatorId,
        company: product.company,
        productName: product.productName,
        liability: '满期保险金',
        formulaText: '有效保险金额 × 100%',
        basisDefinition: {
          formulaText: '基本保险金额 + 累计红利保险金额',
          sourceUrl,
        },
        calculationEligible: false,
        calculationReason: '缺少当前保单的有效保险金额输入值',
        sourceUrl,
        sourceDigest: product.sourceDigest,
      };
      const card = {
        sourceUrl,
        sourceDigest: product.sourceDigest,
        indicators: [indicator],
      };
      insertIndicator.run(indicatorId, product.company, product.productName, '现金流', '满期保险金', JSON.stringify(indicator));
      insertCard.run(
        `card-${product.order}`,
        `company_product:${product.company}:${product.productName}`,
        product.company,
        product.productName,
        '满期保险金',
        '现金流',
        'scheduled_cashflow',
        'display_only',
        '',
        'basic_or_unspecified',
        'selected',
        sourceUrl,
        '2026-08-01T00:00:00.000Z',
        '2026-08-01T00:00:00.000Z',
        JSON.stringify(card),
      );
    }
  } finally {
    db.close();
  }
}

function writeScope(scopePath, products) {
  fs.writeFileSync(scopePath, `${JSON.stringify({
    format: 'policy-ocr-static-responsibility-scope-v1',
    products,
  }, null, 2)}\n`);
}

test('static responsibility handoff replaces only the nine source-verified product rows', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'static-responsibility-handoff-'));
  const sourceDbPath = path.join(directory, 'source.sqlite');
  const targetDbPath = path.join(directory, 'target.sqlite');
  const scopePath = path.join(directory, 'scope.json');
  const handoffPath = path.join(directory, 'handoff.json');
  const backupDir = path.join(directory, 'backups');
  const products = scopeProducts();
  try {
    fs.mkdirSync(backupDir);
    createDb(sourceDbPath);
    createDb(targetDbPath, { oldTargetRows: true });
    seedSourceRows(sourceDbPath, products);
    writeScope(scopePath, products);

    const exported = createStaticResponsibilityHandoff({ sourceDbPath, scopePath, outputPath: handoffPath });
    assert.equal(exported.ok, true);
    assert.equal(exported.cardCount, 9);
    assert.equal(exported.indicatorCount, 9);

    const dryRun = await importStaticResponsibilityHandoff({ handoffPath, dbPath: targetDbPath });
    assert.equal(dryRun.ok, true);
    assert.equal(dryRun.dryRun, true);
    assert.equal(dryRun.preflight.products[0].existingCards, 1);
    assert.deepEqual(dryRun.modifiedTables, []);

    const written = await importStaticResponsibilityHandoff({
      handoffPath,
      dbPath: targetDbPath,
      backupDir,
      write: true,
    });
    assert.equal(written.ok, true);
    assert.equal(written.readback.validationIssueCount, 0);
    assert.deepEqual(written.modifiedTables, ['product_responsibility_cards', 'insurance_indicator_records']);
    assert.equal(fs.existsSync(written.backup.path), true);

    const target = new DatabaseSync(targetDbPath, { readOnly: true });
    try {
      assert.equal(target.prepare('SELECT COUNT(*) AS count FROM product_responsibility_cards').get().count, 9);
      assert.equal(target.prepare('SELECT COUNT(*) AS count FROM insurance_indicator_records').get().count, 9);
      const firstCard = target.prepare('SELECT title, payload FROM product_responsibility_cards WHERE company = ? AND product_name = ?').get('测试保险公司1', '测试产品1');
      assert.equal(firstCard.title, '满期保险金');
      assert.equal(JSON.parse(firstCard.payload).indicators[0].basisDefinition.formulaText, '基本保险金额 + 累计红利保险金额');
      const firstIndicator = target.prepare('SELECT payload FROM insurance_indicator_records WHERE company = ? AND product_name = ?').get('测试保险公司1', '测试产品1');
      const calculation = resolveIndicatorAmountFromCalculation(JSON.parse(firstIndicator.payload), { baseAmount: 89877 });
      assert.equal(calculation.isMinimumEstimate, true);
      assert.equal(calculation.minimumAmount, 89877);
    } finally {
      target.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('static responsibility handoff blocks a competing target source digest without writing', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'static-responsibility-version-conflict-'));
  const sourceDbPath = path.join(directory, 'source.sqlite');
  const targetDbPath = path.join(directory, 'target.sqlite');
  const scopePath = path.join(directory, 'scope.json');
  const handoffPath = path.join(directory, 'handoff.json');
  const products = scopeProducts();
  try {
    createDb(sourceDbPath);
    createDb(targetDbPath, { conflictingTarget: true });
    seedSourceRows(sourceDbPath, products);
    writeScope(scopePath, products);
    assert.equal(createStaticResponsibilityHandoff({ sourceDbPath, scopePath, outputPath: handoffPath }).ok, true);

    const result = await importStaticResponsibilityHandoff({ handoffPath, dbPath: targetDbPath });
    assert.equal(result.ok, false);
    assert.equal(result.validationIssues.some((issue) => issue.includes('1:version_conflict:source_digest')), true);
    const target = new DatabaseSync(targetDbPath, { readOnly: true });
    try {
      assert.equal(target.prepare('SELECT title FROM product_responsibility_cards WHERE company = ? AND product_name = ?').get('测试保险公司1', '测试产品1').title, '旧责任');
    } finally {
      target.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
