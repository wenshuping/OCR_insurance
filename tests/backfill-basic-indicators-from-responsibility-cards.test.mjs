import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  buildBasicIndicatorsFromResponsibilityCards,
  cardRejectReason,
  loadIndicatorCoverageSummary,
} from '../scripts/backfill-basic-indicators-from-responsibility-cards.mjs';

function makeTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'basic-indicators-from-cards-'));
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
    CREATE TABLE product_responsibility_cards (
      id TEXT PRIMARY KEY,
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
    CREATE TABLE policy_derived_results (
      policy_id INTEGER PRIMARY KEY,
      product_keys TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'ready',
      stale_reason TEXT,
      generated_at TEXT,
      updated_at TEXT,
      payload TEXT NOT NULL
    );
    CREATE TABLE product_indicator_versions (
      product_key TEXT PRIMARY KEY,
      version INTEGER NOT NULL DEFAULT 0,
      batch_id TEXT,
      updated_at TEXT,
      payload TEXT NOT NULL
    );
    CREATE TABLE indicator_update_batches (
      id TEXT PRIMARY KEY,
      created_at TEXT,
      product_keys TEXT NOT NULL DEFAULT '[]',
      changed_product_key_count INTEGER NOT NULL DEFAULT 0,
      affected_policy_count INTEGER NOT NULL DEFAULT 0,
      payload TEXT NOT NULL
    );
  `);
  db.close();
  return { dir, dbPath };
}

function insertKnowledge(db, row) {
  db.prepare(`
    INSERT INTO knowledge_records (id, company, product_name, url, payload)
    VALUES (?, ?, ?, ?, ?)
  `).run(row.id, row.company, row.productName, row.url, JSON.stringify({
    id: row.id,
    company: row.company,
    productName: row.productName,
    url: row.url,
    pageText: row.pageText || `${row.productName}保险责任条款`,
  }));
}

function insertCard(db, row) {
  const payload = {
    id: row.id,
    company: row.company,
    productName: row.productName,
    title: row.title,
    category: row.category,
    cashflowTreatment: row.cashflowTreatment,
    calculationStatus: row.calculationStatus,
    calculationReason: row.calculationReason,
    responsibilityScope: row.responsibilityScope || 'basic',
    selectionStatus: row.selectionStatus || '',
    sourceUrl: row.sourceUrl,
    sourceTitle: row.sourceTitle || `${row.productName}条款`,
    sourceExcerpt: row.sourceExcerpt,
    triggerCondition: row.triggerCondition || '',
    payoutSummary: row.payoutSummary || '',
    plainSummary: row.plainSummary || '',
  };
  db.prepare(`
    INSERT INTO product_responsibility_cards (
      id, company, product_name, title, category, cashflow_treatment,
      calculation_status, calculation_reason, responsibility_scope,
      selection_status, source_url, payload
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id,
    row.company,
    row.productName,
    row.title,
    row.category,
    row.cashflowTreatment,
    row.calculationStatus,
    row.calculationReason || '',
    payload.responsibilityScope,
    payload.selectionStatus,
    row.sourceUrl,
    JSON.stringify(payload),
  );
}

function insertIndicator(db, row) {
  const payload = {
    id: row.id,
    company: row.company,
    productName: row.productName,
    coverageType: row.coverageType,
    liability: row.liability,
    formulaText: row.formulaText || `${row.liability} = 按官方条款给付`,
    basis: row.basis || '官方条款',
    sourceUrl: row.sourceUrl,
    sourceExcerpt: row.sourceExcerpt,
    reviewVersion: row.reviewVersion,
    extractionMethod: row.extractionMethod,
    indicatorCheckStatus: row.indicatorCheckStatus,
  };
  db.prepare(`
    INSERT INTO insurance_indicator_records (id, company, product_name, coverage_type, liability, payload)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(row.id, row.company, row.productName, row.coverageType, row.liability, JSON.stringify(payload));
}

function seedDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  try {
    const sourceUrl = 'https://official.example.com/product-a.pdf';
    insertKnowledge(db, {
      id: 1,
      company: '测试保险',
      productName: '无指标医疗保险',
      url: sourceUrl,
    });
    insertCard(db, {
      id: 'card_a_1',
      company: '测试保险',
      productName: '无指标医疗保险',
      title: '住院医疗费用保险金',
      category: '医疗保障',
      cashflowTreatment: 'claim_contingent',
      calculationStatus: 'claim_contingent',
      sourceUrl,
      sourceExcerpt: '保险责任 住院医疗费用保险金 被保险人住院治疗的，本公司对实际合理医疗费用按约定比例给付保险金。',
      triggerCondition: '被保险人住院治疗',
      payoutSummary: '按实际合理医疗费用、免赔额、赔付比例和责任限额给付',
    });

    insertKnowledge(db, {
      id: 2,
      company: '测试保险',
      productName: '只有脏责任卡保险',
      url: 'https://official.example.com/product-b.pdf',
    });
    insertCard(db, {
      id: 'card_b_1',
      company: '测试保险',
      productName: '只有脏责任卡保险',
      title: '诉讼时效受益人向我们请求给付保险金',
      category: '其他',
      cashflowTreatment: 'not_cashflow',
      calculationStatus: 'needs_review',
      sourceUrl: 'https://official.example.com/product-b.pdf',
      sourceExcerpt: '诉讼时效 受益人向我们请求给付保险金的诉讼时效期间为五年。',
    });

    insertKnowledge(db, {
      id: 3,
      company: '测试保险',
      productName: '已有旧指标保险',
      url: 'https://official.example.com/product-c.pdf',
    });
    insertCard(db, {
      id: 'card_c_1',
      company: '测试保险',
      productName: '已有旧指标保险',
      title: '身故保险金',
      category: '人寿保障',
      cashflowTreatment: 'claim_contingent',
      calculationStatus: 'claim_contingent',
      sourceUrl: 'https://official.example.com/product-c.pdf',
      sourceExcerpt: '保险责任 身故保险金 被保险人身故的，本公司按基本保险金额给付身故保险金。',
    });
    insertIndicator(db, {
      id: 'legacy_c_1',
      company: '测试保险',
      productName: '已有旧指标保险',
      coverageType: '人寿保障',
      liability: '身故保险金',
      sourceUrl: 'https://official.example.com/product-c.pdf',
      sourceExcerpt: '被保险人身故的，本公司按基本保险金额给付身故保险金。',
    });

    insertKnowledge(db, {
      id: 4,
      company: '测试保险',
      productName: '已人工复核指标保险',
      url: 'https://official.example.com/product-d.pdf',
    });
    insertIndicator(db, {
      id: 'reviewed_d_1',
      company: '测试保险',
      productName: '已人工复核指标保险',
      coverageType: '人寿保障',
      liability: '身故保险金',
      reviewVersion: '2026-06-23-reviewed-responsibility-artifact-import',
      sourceUrl: 'https://official.example.com/product-d.pdf',
      sourceExcerpt: '被保险人身故的，本公司按基本保险金额给付身故保险金。',
    });
  } finally {
    db.close();
  }
}

function indicatorRows(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(`
      SELECT company, product_name, liability, payload
        FROM insurance_indicator_records
       ORDER BY product_name, liability
    `).all().map((row) => ({
      ...row,
      payload: JSON.parse(row.payload),
    }));
  } finally {
    db.close();
  }
}

test('cardRejectReason rejects administrative responsibility-card fragments', () => {
  assert.equal(cardRejectReason({
    title: '诉讼时效受益人向我们请求给付保险金',
    cashflowTreatment: 'not_cashflow',
    sourceUrl: 'https://official.example.com/product.pdf',
    sourceExcerpt: '诉讼时效 受益人向我们请求给付保险金的诉讼时效期间为五年。',
  }), 'administrative_or_rule_title');
});

test('card title gate rejects fragments but allows scoped benefit headings', () => {
  assert.equal(cardRejectReason({
    title: '6)保险金',
    cashflowTreatment: 'claim_contingent',
    sourceUrl: 'https://official.example.com/product.pdf',
    sourceExcerpt: '本公司对住院医疗费用每日最高给付额为人民币20元。',
  }), 'generic_or_rule_title');

  assert.equal(cardRejectReason({
    title: '以被保险人死亡为给付保险金',
    cashflowTreatment: 'claim_contingent',
    sourceUrl: 'https://official.example.com/product.pdf',
    sourceExcerpt: '以被保险人死亡为给付保险金条件的，必须经被保险人同意并认可保险金额。',
  }), 'administrative_or_rule_title');

  assert.equal(cardRejectReason({
    title: '5%的主合同基本保险金',
    cashflowTreatment: 'claim_contingent',
    sourceUrl: 'https://official.example.com/product.pdf',
    sourceExcerpt: '5%的主合同基本保险金额并转移至本附加合同医疗账户，医疗给付金申请时须提供诊断书和费用单据。',
  }), 'sentence_fragment_title');

  assert.equal(cardRejectReason({
    title: '基本责任 【医疗意外身故保险金',
    cashflowTreatment: 'claim_contingent',
    sourceUrl: 'https://official.example.com/product.pdf',
    sourceExcerpt: '保险责任 医疗意外身故保险金 被保险人因医疗意外导致身故的，本公司按保险金额给付医疗意外身故保险金。',
  }), '');
});

test('dry-run builds basic indicators only for products missing any indicator', () => {
  const { dir, dbPath } = makeTempDb();
  try {
    seedDb(dbPath);
    const result = buildBasicIndicatorsFromResponsibilityCards({
      dbPath,
      now: '2026-06-29T00:00:00.000Z',
    });

    assert.equal(result.dryRun, true);
    assert.equal(result.targetProductsSelected, 2);
    assert.equal(result.targetProductsMissingAnyIndicator, 2);
    assert.equal(result.targetProductsWithExistingVersionIndicators, 0);
    assert.equal(result.productsWithGeneratedIndicators, 2);
    assert.equal(result.candidateIndicators, 2);
    assert.equal(result.indicatorUpserts, 0);
    assert.equal(result.fallbackIndicators, 1);
    assert.equal(result.byIndicatorCheckStatus.basic_from_responsibility_card, 1);
    assert.equal(result.byIndicatorCheckStatus.needs_llm_responsibility_parse, 1);
    assert.equal(result.coverageSummary.before.productsMissingAnyIndicators, 2);
    assert.equal(result.coverageSummary.after.productsMissingAnyIndicators, 2);
    assert.match(result.coverageSummary.before.note, /缺指标只统计 productsMissingAnyIndicators/u);
    assert.equal(indicatorRows(dbPath).length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('write mode fills missing-any-indicator products and keeps reviewed coverage separate', () => {
  const { dir, dbPath } = makeTempDb();
  try {
    seedDb(dbPath);
    const result = buildBasicIndicatorsFromResponsibilityCards({
      dbPath,
      write: true,
      now: '2026-06-29T00:00:00.000Z',
    });

    assert.equal(result.dryRun, false);
    assert.equal(result.indicatorUpserts, 2);
    assert.equal(result.prunedGeneratedIndicators, 0);
    assert.equal(result.coverageSummary.before.productsMissingAnyIndicators, 2);
    assert.equal(result.coverageSummary.after.productsMissingAnyIndicators, 0);
    assert.equal(result.coverageSummary.after.productsWithAnyIndicators, 4);
    assert.equal(result.coverageSummary.after.productsWithReviewedIndicators, 1);
    assert.equal(result.coverageSummary.after.productsLegacyOrBasicOnlyIndicators, 3);

    const rows = indicatorRows(dbPath);
    const byProduct = new Map(rows.map((row) => [row.product_name, row]));
    const medical = byProduct.get('无指标医疗保险')?.payload;
    const fallback = byProduct.get('只有脏责任卡保险')?.payload;
    const legacyRows = rows.filter((row) => row.product_name === '已有旧指标保险');

    assert.equal(rows.length, 4);
    assert.equal(medical.liability, '住院医疗费用保险金');
    assert.equal(medical.indicatorCheckStatus, 'basic_from_responsibility_card');
    assert.equal(medical.calculationKey, 'medical_formula');
    assert.equal(medical.calculationEligible, false);
    assert.equal(fallback.liability, '保险责任基础指标');
    assert.equal(fallback.indicatorCheckStatus, 'needs_llm_responsibility_parse');
    assert.equal(fallback.calculationKey, 'not_calculable');
    assert.equal(legacyRows.length, 1);

    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM indicator_update_batches').get().count, 1);
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM product_indicator_versions').get().count, 2);
      const summary = loadIndicatorCoverageSummary(db);
      assert.equal(summary.productsMissingAnyIndicators, 0);
      assert.equal(summary.productsWithReviewedIndicators, 1);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('write mode refreshes prior generated rows for the same version', () => {
  const { dir, dbPath } = makeTempDb();
  try {
    seedDb(dbPath);
    const first = buildBasicIndicatorsFromResponsibilityCards({
      dbPath,
      write: true,
      now: '2026-06-29T00:00:00.000Z',
    });
    const second = buildBasicIndicatorsFromResponsibilityCards({
      dbPath,
      write: true,
      now: '2026-06-29T00:30:00.000Z',
    });

    assert.equal(first.indicatorUpserts, 2);
    assert.equal(second.targetProductsMissingAnyIndicator, 0);
    assert.equal(second.targetProductsWithExistingVersionIndicators, 2);
    assert.equal(second.prunedGeneratedIndicators, 2);
    assert.equal(second.indicatorUpserts, 2);
    assert.equal(indicatorRows(dbPath).length, 4);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('basic indicator basis prefers insured amount over incidental premium deductions', () => {
  const { dir, dbPath } = makeTempDb();
  try {
    const db = new DatabaseSync(dbPath);
    try {
      const sourceUrl = 'https://official.example.com/group-term-life.pdf';
      insertKnowledge(db, {
        id: 10,
        company: '测试保险',
        productName: '团体定期寿险',
        url: sourceUrl,
      });
      insertCard(db, {
        id: 'card_life_1',
        company: '测试保险',
        productName: '团体定期寿险',
        title: '身故保险金',
        category: '人寿保障',
        cashflowTreatment: 'claim_contingent',
        calculationStatus: 'claim_contingent',
        sourceUrl,
        sourceExcerpt: '被保险人身故的，本公司将给付等值于基本保险金额的身故保险金，并从给付的保险金中扣除任何欠缴的保险费。',
      });
    } finally {
      db.close();
    }

    buildBasicIndicatorsFromResponsibilityCards({
      dbPath,
      write: true,
      now: '2026-06-29T00:00:00.000Z',
    });

    const rows = indicatorRows(dbPath);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].payload.basis, '基本保险金额或保险单载明金额');
    assert.equal(rows[0].payload.calculationKey, 'basic_amount');
    assert.equal(rows[0].payload.formulaText, '身故保险金 = 按基本保险金额或保险单载明金额给付');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('basic indicator generation accepts waiver premium responsibilities', () => {
  const { dir, dbPath } = makeTempDb();
  try {
    const db = new DatabaseSync(dbPath);
    try {
      const sourceUrl = 'https://official.example.com/waiver.pdf';
      insertKnowledge(db, {
        id: 11,
        company: '测试保险',
        productName: '附加豁免保险费疾病保险',
        url: sourceUrl,
      });
      insertCard(db, {
        id: 'card_waiver_1',
        company: '测试保险',
        productName: '附加豁免保险费疾病保险',
        title: '豁免保险费',
        category: '豁免',
        cashflowTreatment: 'waiver_only',
        calculationStatus: 'waiver_only',
        sourceUrl,
        sourceExcerpt: '保险责任 若被保险人经医院确诊患有合同约定疾病，本公司将豁免本附加合同后续应交保险费。',
      });
    } finally {
      db.close();
    }

    buildBasicIndicatorsFromResponsibilityCards({
      dbPath,
      write: true,
      now: '2026-06-29T00:05:00.000Z',
    });

    const rows = indicatorRows(dbPath);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].payload.liability, '豁免保险费');
    assert.equal(rows[0].payload.indicatorCheckStatus, 'basic_from_responsibility_card');
    assert.equal(rows[0].payload.calculationStatus, 'waiver_only');
    assert.equal(rows[0].payload.calculationKey, 'not_calculable');
    assert.equal(rows[0].payload.formulaText, '豁免保险费 = 豁免后续应交保险费');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
