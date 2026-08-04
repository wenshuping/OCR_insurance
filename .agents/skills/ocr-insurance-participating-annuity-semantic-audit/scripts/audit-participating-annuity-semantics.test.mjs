import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { auditParticipatingAnnuitySemantics } from './audit-participating-annuity-semantics.mjs';

function fixtureDb({ indicator, indicators = null, artifact = null }) {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE insurance_indicator_records (
      id TEXT PRIMARY KEY, company TEXT, product_name TEXT, coverage_type TEXT, liability TEXT, payload TEXT NOT NULL
    );
    CREATE TABLE product_responsibility_cards (
      id TEXT PRIMARY KEY, product_key TEXT, company TEXT, product_name TEXT, title TEXT, payload TEXT NOT NULL
    );
    CREATE TABLE product_responsibility_artifacts (
      id TEXT PRIMARY KEY, company TEXT, product_name TEXT, source_digest TEXT, source_url TEXT, payload TEXT NOT NULL
    );
    CREATE TABLE indicator_definitions (id TEXT PRIMARY KEY);
  `);
  const rows = indicators || [indicator];
  const insert = db.prepare(`
    INSERT INTO insurance_indicator_records (id, company, product_name, coverage_type, liability, payload)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const row of rows) {
    insert.run(row.id, row.company, row.productName, '年金保障', row.liability, JSON.stringify(row));
  }
  if (artifact) {
    db.prepare(`
      INSERT INTO product_responsibility_artifacts (id, company, product_name, source_digest, source_url, payload)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('artifact-1', indicator.company, indicator.productName, artifact.sourceDigest, artifact.sourceUrl, JSON.stringify(artifact));
  }
  return db;
}

const base = {
  id: 'indicator-1',
  company: '示例人寿',
  productName: '示例年金保险（分红型）',
  liability: '生存保险金',
  formulaText: '生存保险金 = 该保单生效对应日基本责任保险金额 × 9%',
  sourceExcerpt: '年度红利以增加保险金额的形式实现。',
  sourceDigest: 'sha256:example',
  sourceUrl: 'https://example.test/manual.pdf',
};

test('flags an anniversary amount silently collapsed into initial basic amount', () => {
  const db = fixtureDb({
    indicator: { ...base, basisKey: 'basic_amount', calculationKey: 'basic_amount', calculationEligible: true },
  });
  try {
    const report = auditParticipatingAnnuitySemantics(db);
    assert.equal(report.summary.byCode.ANNIVERSARY_BASIC_AMOUNT_COLLAPSED, 1);
  } finally {
    db.close();
  }
});

test('accepts an artifact-backed anniversary amount that remains table dependent', () => {
  const db = fixtureDb({
    indicator: {
      ...base,
      basisKey: 'policy_anniversary_basic_amount',
      calculationKey: 'schedule_or_policy_table',
      calculationEligible: false,
    },
    artifact: {
      sourceDigest: 'sha256:example',
      sourceUrl: 'https://example.test/manual.pdf',
      acceptedResponsibilities: [{ responsibilityId: 'R01' }],
      blockers: [],
      mergeAudit: { officialEvidence: '年度红利以增加保险金额的形式实现。' },
    },
  });
  try {
    const report = auditParticipatingAnnuitySemantics(db);
    assert.equal(report.summary.issues, 0);
  } finally {
    db.close();
  }
});

test('does not match a static basis after a predicate mentioning the anniversary', () => {
  const db = fixtureDb({
    indicator: {
      ...base,
      formulaText: '生存保险金 = 基本责任保险金额 × 9%',
      sourceExcerpt: '被保险人生存至保单生效对应日，本公司按基本责任保险金额给付生存保险金。',
      basisKey: 'basic_amount',
      calculationKey: 'basic_amount',
      calculationEligible: true,
    },
  });
  try {
    const report = auditParticipatingAnnuitySemantics(db);
    assert.equal(report.summary.byCode?.ANNIVERSARY_BASIC_AMOUNT_COLLAPSED || 0, 0);
    assert.equal(report.summary.byCode?.DUPLICATE_ANNIVERSARY_BASIC_AMOUNT_PHRASE || 0, 0);
  } finally {
    db.close();
  }
});

test('flags a repeated anniversary noun phrase in a generated formula', () => {
  const db = fixtureDb({
    indicator: {
      ...base,
      formulaText: '生存保险金 = 保单生效对应日保单生效对应日基本责任保险金额 × 9%',
      basisKey: 'policy_anniversary_basic_amount',
      calculationKey: 'schedule_or_policy_table',
      calculationEligible: false,
    },
  });
  try {
    const report = auditParticipatingAnnuitySemantics(db);
    assert.equal(report.summary.byCode.DUPLICATE_ANNIVERSARY_BASIC_AMOUNT_PHRASE, 1);
  } finally {
    db.close();
  }
});

test('does not call distinct structured branches duplicate atomic indicators', () => {
  const first = {
    ...base,
    id: 'indicator-branch-1',
    liability: '身故保险金',
    formulaText: 'piecewise',
    condition: '被保险人在保险期间内身故',
    basisKey: 'piecewise',
    calculationKey: 'maximum_of_bases',
    calculationEligible: false,
    branches: [{ branchId: 'under_18', conditionText: '未满18周岁', formulaText: '现金价值', basisKey: 'cash_value' }],
  };
  const second = {
    ...first,
    id: 'indicator-branch-2',
    branches: [{ branchId: 'over_18', conditionText: '已满18周岁', formulaText: '已交保费与现金价值较大者', basisKey: 'max_of_bases' }],
  };
  const db = fixtureDb({ indicator: first, indicators: [first, second] });
  try {
    const report = auditParticipatingAnnuitySemantics(db);
    assert.equal(report.summary.byCode?.DUPLICATE_ATOMIC_INDICATOR || 0, 0);
  } finally {
    db.close();
  }
});

test('flags a lost cumulative dividend component only from the same responsibility evidence', () => {
  const db = fixtureDb({
    indicator: {
      ...base,
      formulaText: '生存保险金 = 基本保险金额 × 9%',
      sourceExcerpt: '生存保险金按基本保险金额加累积红利保险金额的合计给付。',
      basisKey: 'basic_amount',
      calculationKey: 'basic_amount',
      calculationEligible: true,
    },
  });
  try {
    const report = auditParticipatingAnnuitySemantics(db);
    assert.equal(report.summary.byCode.DIVIDEND_COMPONENT_LOST, 1);
    assert.equal(report.summary.scopeReconciliation.union, 1);
    assert.equal(report.summary.queueIntersectionCount, 0);
  } finally {
    db.close();
  }
});

test('keeps product-level queues mutually exclusive and exposes legitimate static findings', () => {
  const db = fixtureDb({
    indicator: {
      ...base,
      formulaText: '生存保险金 = 基本责任保险金额 × 9%',
      sourceExcerpt: '生存至保单生效对应日，本公司按基本责任保险金额给付。',
      basisKey: 'basic_amount',
      calculationKey: 'basic_amount',
      calculationEligible: true,
    },
  });
  try {
    const report = auditParticipatingAnnuitySemantics(db);
    assert.equal(report.summary.queueCounts.already_correct, 1);
    assert.equal(report.summary.queueIntersectionCount, 0);
    assert.equal(report.products[0].findings[0].kind, 'legitimate_static_amount');
  } finally {
    db.close();
  }
});
