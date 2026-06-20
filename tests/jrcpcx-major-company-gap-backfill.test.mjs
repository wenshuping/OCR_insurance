import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  TARGET_COMPANIES,
  backupSqliteFile,
  buildCoverageGapReport,
  buildDefaultArtifactPath,
  buildInsertReport,
  buildInsertPlan,
  buildJrcpcxQueriesFromGap,
  buildKnowledgeRecordFromJrcpcx,
  buildSqliteBackupPath,
  companyConfigForIssuer,
  eligibleForAutoInsert,
  normalizeClauseUrl,
} from '../scripts/jrcpcx-major-company-gap-backfill.mjs';

const pdfFixturePath = path.join(os.tmpdir(), 'jrcpcx-major-company-gap-fixture.pdf');

function ensurePdfFixture() {
  fs.writeFileSync(pdfFixturePath, '%PDF-1.4\n% test fixture\n');
  return pdfFixturePath;
}

test('target company config maps 阳光 and 人保 to Feishu configs', () => {
  assert.equal(TARGET_COMPANIES.length, 2);
  assert.equal(companyConfigForIssuer('阳光人寿保险股份有限公司').localCompany, '阳光人寿');
  assert.equal(companyConfigForIssuer('中国人民人寿保险股份有限公司').localCompany, '人保寿险');
  assert.equal(companyConfigForIssuer('中国平安人寿保险股份有限公司'), null);
});

test('buildJrcpcxQueriesFromGap keeps only target human-insurance candidates', () => {
  const queries = buildJrcpcxQueriesFromGap({
    missingCandidates: [
      {
        queryDeptName: '阳光人寿保险股份有限公司',
        productName: '阳光人寿附加意外伤害保险',
        productState: '停用',
        productType: '人身保险类',
      },
      {
        queryDeptName: '中国人民人寿保险股份有限公司',
        productName: '人保寿险康乐年华两全保险',
        productState: '在售',
        productType: '人身保险类',
      },
      {
        queryDeptName: '中国平安人寿保险股份有限公司',
        productName: '平安示例',
        productState: '停售',
        productType: '人身保险类',
      },
      {
        queryDeptName: '阳光人寿保险股份有限公司',
        productName: '阳光财产示例',
        productState: '停售',
        productType: '财产保险类',
      },
    ],
  });

  assert.deepEqual(
    queries.map((row) => [row.deptName, row.productName, row.productStateLabel]),
    [
      ['阳光人寿保险股份有限公司', '阳光人寿附加意外伤害保险', '停用'],
      ['中国人民人寿保险股份有限公司', '人保寿险康乐年华两全保险', '在售'],
    ],
  );
});

test('eligibleForAutoInsert accepts target company human-insurance rows with PDF evidence', () => {
  const result = eligibleForAutoInsert({
    company: '阳光人寿保险股份有限公司',
    productName: '阳光人寿附加意外伤害保险',
    productType: '人身保险类',
    detailUrl: 'https://inspdinfo.iachina.cn/lifeIns/detail?data=1',
    clauseUrl: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=abc',
    pdfLocalPath: ensurePdfFixture(),
    pdfSha256: 'abc123',
    pageText: '保险责任 意外身故保险金',
    qualityStatus: 'valid_complete',
  });

  assert.equal(result.eligible, true);
  assert.deepEqual(result.reasons, []);
});

test('eligibleForAutoInsert rejects non-target issuer and property insurance', () => {
  const base = {
    productName: '示例产品',
    detailUrl: 'https://inspdinfo.iachina.cn/lifeIns/detail?data=1',
    clauseUrl: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=abc',
    pdfLocalPath: ensurePdfFixture(),
    pdfSha256: 'abc123',
    pageText: '保险责任 示例责任',
    qualityStatus: 'valid_complete',
  };

  assert.deepEqual(eligibleForAutoInsert({ ...base, company: '中国平安人寿保险股份有限公司', productType: '人身保险类' }).reasons, ['issuer_not_target']);
  assert.deepEqual(eligibleForAutoInsert({ ...base, company: '阳光人寿保险股份有限公司', productType: '财产保险类' }).reasons, ['not_human_insurance']);
});

test('buildInsertPlan skips normalized existing clause URLs', () => {
  const plan = buildInsertPlan({
    insertable: [
      {
        company: '中国人民人寿保险股份有限公司',
        productName: '人保寿险示例年金保险',
        productType: '人身保险类',
        detailUrl: 'https://inspdinfo.iachina.cn/lifeIns/detail?data=2',
        clauseUrl: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?t=222&info=old',
        pdfLocalPath: ensurePdfFixture(),
        pdfSha256: 'old123',
        pageText: '保险责任 年金给付',
        qualityStatus: 'valid_partial',
      },
    ],
    existingUrls: ['https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=old&t=111'],
  });

  assert.equal(plan.recordsToInsert.length, 0);
  assert.equal(plan.skipped[0].reason, 'existing_url');
});

test('buildInsertPlan skips duplicate normalized clause URLs inside same batch', () => {
  const base = {
    company: '中国人民人寿保险股份有限公司',
    productType: '人身保险类',
    pdfLocalPath: ensurePdfFixture(),
    pdfSha256: 'abc123',
    pageText: '保险责任 年金给付',
    qualityStatus: 'valid_partial',
  };
  const plan = buildInsertPlan({
    insertable: [
      {
        ...base,
        productName: '人保寿险示例年金保险',
        detailUrl: 'https://inspdinfo.iachina.cn/lifeIns/detail?data=1',
        clauseUrl: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?t=111&info=dup',
      },
      {
        ...base,
        productName: '人保寿险示例年金保险重复条款',
        detailUrl: 'https://inspdinfo.iachina.cn/lifeIns/detail?data=2',
        clauseUrl: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=dup&t=222',
      },
    ],
  });

  assert.equal(plan.recordsToInsert.length, 1);
  assert.equal(plan.skipped.length, 1);
  assert.equal(plan.skipped[0].reason, 'duplicate_plan_url');
});

test('coverage report skips non-target and non-human rows out of manual review', () => {
  const base = {
    productName: '示例产品',
    detailUrl: 'https://inspdinfo.iachina.cn/lifeIns/detail?data=1',
    clauseUrl: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=abc',
    pdfLocalPath: ensurePdfFixture(),
    pdfSha256: 'abc123',
    pageText: '保险责任 示例责任',
    qualityStatus: 'valid_complete',
  };
  const report = buildCoverageGapReport({
    detailRows: [
      { ...base, company: '中国平安人寿保险股份有限公司', productType: '人身保险类' },
      {
        ...base,
        company: '阳光人寿保险股份有限公司',
        productName: '阳光财产示例',
        productType: '财产保险类',
        detailUrl: 'https://inspdinfo.iachina.cn/lifeIns/detail?data=2',
        clauseUrl: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=property',
      },
    ],
  });

  assert.equal(report.summary.skippedCount, 2);
  assert.equal(report.summary.manualReviewCount, 0);
  assert.deepEqual(report.skipped.map((row) => row.reason), ['issuer_not_target', 'not_human_insurance']);
});

test('insert report includes per-company planned and inserted id ranges', () => {
  const report = buildInsertReport({
    recordsToInsert: [
      { company: '阳光人寿保险股份有限公司', productName: '阳光示例', url: 'https://example.com/sunshine' },
      { company: '阳光人寿保险股份有限公司', productName: '阳光示例二', url: 'https://example.com/sunshine-2' },
      { company: '中国人民人寿保险股份有限公司', productName: '人保示例', url: 'https://example.com/picc' },
    ],
    saved: [
      { id: 101, company: '阳光人寿保险股份有限公司', productName: '阳光示例', url: 'https://example.com/sunshine' },
      { id: 103, company: '阳光人寿保险股份有限公司', productName: '阳光示例二', url: 'https://example.com/sunshine-2' },
    ],
  });

  assert.deepEqual(report.byCompany['阳光人寿保险股份有限公司'], {
    plannedCount: 2,
    insertedCount: 2,
    insertedMinId: 101,
    insertedMaxId: 103,
  });
  assert.deepEqual(report.byCompany['中国人民人寿保险股份有限公司'], {
    plannedCount: 1,
    insertedCount: 0,
    insertedMinId: null,
    insertedMaxId: null,
  });
});

test('backup and default artifact paths use major-company gap stamp names', () => {
  const generatedAt = '2026-06-21T12:34:56.789Z';
  assert.equal(
    buildSqliteBackupPath('/tmp/policy-ocr.sqlite', generatedAt),
    '/tmp/policy-ocr.sqlite.backup-before-jrcpcx-major-company-gap-2026-06-21T12-34-56-789Z',
  );
  assert.equal(
    path.basename(buildDefaultArtifactPath('query-file', generatedAt)),
    'jrcpcx-major-company-gap-2026-06-21T12-34-56-789Z-queries.json',
  );
  assert.equal(
    path.basename(buildDefaultArtifactPath('coverage', generatedAt)),
    'jrcpcx-major-company-gap-2026-06-21T12-34-56-789Z-coverage-gap.json',
  );
  assert.equal(
    path.basename(buildDefaultArtifactPath('insert-plan', generatedAt)),
    'jrcpcx-major-company-gap-2026-06-21T12-34-56-789Z-insert-plan.json',
  );
  assert.equal(
    path.basename(buildDefaultArtifactPath('insert-report', generatedAt)),
    'jrcpcx-major-company-gap-2026-06-21T12-34-56-789Z-insert-report.json',
  );
});

test('backupSqliteFile copies database and SQLite sidecars next to source DB', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jrcpcx-major-company-backup-'));
  const dbPath = path.join(dir, 'policy-ocr.sqlite');
  const generatedAt = '2026-06-21T12:34:56.789Z';
  fs.writeFileSync(dbPath, 'db');
  fs.writeFileSync(`${dbPath}-wal`, 'wal');
  fs.writeFileSync(`${dbPath}-shm`, 'shm');

  const backupPath = backupSqliteFile(dbPath, generatedAt);

  assert.equal(
    backupPath,
    `${dbPath}.backup-before-jrcpcx-major-company-gap-2026-06-21T12-34-56-789Z`,
  );
  assert.equal(fs.readFileSync(backupPath, 'utf8'), 'db');
  assert.equal(fs.readFileSync(`${backupPath}-wal`, 'utf8'), 'wal');
  assert.equal(fs.readFileSync(`${backupPath}-shm`, 'utf8'), 'shm');
});

test('CLI insert dry-run fails read-only when SQLite DB is missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jrcpcx-major-company-dryrun-'));
  const coveragePath = path.join(dir, 'coverage.json');
  const dbPath = path.join(dir, 'missing-policy-ocr.sqlite');
  const outputPath = path.join(dir, 'insert-plan.json');
  fs.writeFileSync(coveragePath, `${JSON.stringify({ insertable: [] })}\n`);

  const result = spawnSync(process.execPath, [
    'scripts/jrcpcx-major-company-gap-backfill.mjs',
    '--mode=insert',
    `--coverage-path=${coveragePath}`,
    `--db-path=${dbPath}`,
    `--output=${outputPath}`,
  ], {
    cwd: path.resolve('.'),
    encoding: 'utf8',
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SQLite DB not found/u);
  assert.equal(fs.existsSync(dbPath), false);
});

test('buildKnowledgeRecordFromJrcpcx maps official evidence fields', () => {
  const record = buildKnowledgeRecordFromJrcpcx({
    company: '阳光人寿保险股份有限公司',
    productName: '阳光人寿附加意外伤害保险',
    productType: '人身保险类',
    salesStatus: '停用',
    detailUrl: 'https://inspdinfo.iachina.cn/lifeIns/detail?data=1',
    clauseUrl: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?t=111&info=abc',
    pdfLocalPath: ensurePdfFixture(),
    pdfSha256: 'abc123',
    pageText: '保险责任 意外身故保险金',
    qualityStatus: 'valid_complete',
    detailFields: { 产品条款文字编码: '阳光人寿〔2020〕意外伤害保险001号' },
  });

  assert.equal(record.company, '阳光人寿保险股份有限公司');
  assert.equal(record.url, 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=abc');
  assert.equal(record.seedSourceUrl, 'https://inspdinfo.iachina.cn/lifeIns/detail?data=1');
  assert.equal(record.sourceType, 'pdf');
  assert.equal(record.materialType, 'terms');
  assert.equal(record.officialDomain, 'inspdinfo.iachina.cn');
  assert.equal(record.responsibilityQualityStatus, 'valid_complete');
  assert.equal(record.versionNo, '阳光人寿〔2020〕意外伤害保险001号');
});

test('normalizeClauseUrl removes volatile t parameter and sorts params', () => {
  assert.equal(
    normalizeClauseUrl('https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?t=2&info=abc&data=1'),
    'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?data=1&info=abc',
  );
});
