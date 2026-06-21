import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  TARGET_COMPANIES,
  backupSqliteFile,
  buildCoverageGapReport,
  buildDefaultArtifactPath,
  buildPdfOnlyReport,
  buildInsertReport,
  buildInsertPlan,
  buildJrcpcxQueriesFromGap,
  buildKnowledgeRecordFromJrcpcx,
  buildSuggestedReadableName,
  buildSqliteBackupPath,
  companyConfigForIssuer,
  eligibleForAutoInsert,
  normalizeClauseUrl,
  validatePdfOnlyReport,
  writePdfOnlyArtifacts,
} from '../scripts/jrcpcx-major-company-gap-backfill.mjs';

const pdfFixturePath = path.join(os.tmpdir(), 'jrcpcx-major-company-gap-fixture.pdf');

function ensurePdfFixture() {
  fs.writeFileSync(pdfFixturePath, '%PDF-1.4\n% test fixture\n');
  return pdfFixturePath;
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

test('target company config maps major life insurers to Feishu configs', () => {
  assert.equal(TARGET_COMPANIES.length, 8);
  assert.equal(companyConfigForIssuer('中国人寿保险股份有限公司').localCompany, '中国人寿');
  assert.equal(companyConfigForIssuer('泰康人寿保险有限责任公司').localCompany, '泰康人寿');
  assert.equal(companyConfigForIssuer('新华人寿保险股份有限公司').localCompany, '新华保险');
  assert.equal(companyConfigForIssuer('阳光人寿保险股份有限公司').localCompany, '阳光人寿');
  assert.equal(companyConfigForIssuer('中国人民人寿保险股份有限公司').localCompany, '人保寿险');
  assert.equal(companyConfigForIssuer('友邦人寿保险有限公司').localCompany, '友邦人寿');
  assert.equal(companyConfigForIssuer('中国太平洋人寿保险股份有限公司').localCompany, '太保寿险');
  assert.equal(companyConfigForIssuer('太平人寿保险有限公司').localCompany, '中国太平');
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
        queryDeptName: '中国人寿保险股份有限公司',
        productName: '国寿养老年金保险',
        productState: '停售',
        productType: '人身保险类',
      },
      {
        queryDeptName: '泰康人寿保险有限责任公司',
        productName: '泰康健康人生重大疾病保险',
        productState: '停售',
        productType: '人身保险类',
      },
      {
        queryDeptName: '新华人寿保险股份有限公司',
        productName: '新华吉庆有余两全保险',
        productState: '停售',
        productType: '人身保险类',
      },
      {
        queryDeptName: '友邦人寿保险有限公司',
        productName: '友邦附加意外伤害保险',
        productState: '停售',
        productType: '人身保险类',
      },
      {
        queryDeptName: '中国太平洋人寿保险股份有限公司',
        productName: '太保寿险附加住院补贴医疗保险',
        productState: '停售',
        productType: '人身保险类',
      },
      {
        queryDeptName: '太平人寿保险有限公司',
        productName: '太平团体年金保险',
        productState: '停售',
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
      ['中国人寿保险股份有限公司', '国寿养老年金保险', '停售'],
      ['泰康人寿保险有限责任公司', '泰康健康人生重大疾病保险', '停售'],
      ['新华人寿保险股份有限公司', '新华吉庆有余两全保险', '停售'],
      ['友邦人寿保险有限公司', '友邦附加意外伤害保险', '停售'],
      ['中国太平洋人寿保险股份有限公司', '太保寿险附加住院补贴医疗保险', '停售'],
      ['太平人寿保险有限公司', '太平团体年金保险', '停售'],
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

test('buildSuggestedReadableName removes unsafe filename characters', () => {
  assert.equal(
    buildSuggestedReadableName({
      company: '阳光人寿保险股份有限公司',
      productName: '阳光/附加:意外?伤害保险',
      detailFields: { 产品条款文字编码: '阳光人寿〔2020〕意外伤害保险001号' },
    }),
    '阳光人寿保险股份有限公司__阳光_附加_意外_伤害保险__阳光人寿〔2020〕意外伤害保险001号.pdf',
  );
});

test('buildPdfOnlyReport records downloaded PDF metadata for later extraction', () => {
  const pdfPath = ensurePdfFixture();
  const pdfSha256 = sha256File(pdfPath);
  const report = buildPdfOnlyReport({
    generatedAt: '2026-06-21T08:00:00.000Z',
    crawlResult: {
      records: [
        {
          company: '阳光人寿保险股份有限公司',
          productName: '阳光人寿附加意外伤害保险',
          productType: '人身保险类',
          salesStatus: '停售',
          detailUrl: 'https://inspdinfo.iachina.cn/lifeIns/detail?data=1',
          clauseUrl: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?t=1&info=abc',
          clauseFileName: 'abc_TERMS.PDF',
          pdfOriginalUrl: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?t=1&info=abc',
          pdfLocalPath: pdfPath,
          pdfSha256,
          pdfBytes: fs.statSync(pdfPath).size,
          pdfContentType: 'application/pdf',
          pdfArchivedAt: '2026-06-21T08:00:01Z',
          detailFields: { 产品条款文字编码: '阳光人寿〔2020〕意外伤害保险001号' },
          responsibilityDeferred: true,
          futureExtractionStatus: 'pending',
        },
      ],
      detailResults: [],
    },
  });

  assert.equal(report.summary.downloadedCount, 1);
  assert.equal(report.summary.skippedExistingCount, 0);
  assert.equal(report.summary.blockedCount, 0);
  assert.equal(report.summary.byCompany.downloaded['阳光人寿保险股份有限公司'], 1);
  assert.equal(report.downloaded[0].issuerFullName, '阳光人寿保险股份有限公司');
  assert.equal(report.downloaded[0].normalizedClauseUrl, 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=abc');
  assert.equal(report.downloaded[0].pdfFileName, path.basename(pdfPath));
  assert.equal(report.downloaded[0].clauseFileName, 'abc_TERMS.PDF');
  assert.equal(report.downloaded[0].futureExtractionStatus, 'pending');
  assert.equal(report.downloaded[0].responsibilityDeferred, true);
  assert.match(report.downloaded[0].suggestedReadableName, /阳光人寿保险股份有限公司__阳光人寿附加意外伤害保险/u);
});

test('buildPdfOnlyReport dedupes catalog and downloaded variants for same detail material', () => {
  const pdfPath = ensurePdfFixture();
  const detailUrl = 'https://inspdinfo.iachina.cn/lifeIns/detail?data=dedupe';
  const report = buildPdfOnlyReport({
    generatedAt: '2026-06-21T08:00:00.000Z',
    crawlResult: {
      products: [
        {
          company: '太平人寿保险有限公司',
          productName: '太平团体年金保险',
          productType: '人身保险类',
          salesStatus: '停售',
          detailUrl,
          detailFields: { 产品条款文字编码: '太平人寿〔2020〕团体年金保险001号' },
        },
      ],
      records: [
        {
          company: '太平人寿保险有限公司',
          productName: '太平团体年金保险',
          productType: '人身保险类',
          salesStatus: '停售',
          detailUrl,
          clauseUrl: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=taiping-dedupe',
          clauseFileName: 'taiping_dedupe_TERMS.PDF',
          pdfLocalPath: pdfPath,
          pdfSha256: sha256File(pdfPath),
          pdfBytes: fs.statSync(pdfPath).size,
          pdfContentType: 'application/pdf',
          pdfArchivedAt: '2026-06-21T08:00:01Z',
          detailFields: { 产品条款文字编码: '太平人寿〔2020〕团体年金保险001号' },
        },
      ],
    },
  });

  assert.equal(report.summary.uniqueCandidateMaterialCount, 1);
  assert.equal(report.summary.byCompany.uniqueCandidateMaterials['太平人寿保险有限公司'], 1);
});

test('buildPdfOnlyReport separates skipped-existing reasons and blocked rows', () => {
  const report = buildPdfOnlyReport({
    generatedAt: '2026-06-21T08:00:00.000Z',
    crawlResult: {
      records: [
        {
          company: '中国人民人寿保险股份有限公司',
          productName: '人保寿险示例年金保险',
          productType: '人身保险类',
          salesStatus: '停售',
          detailUrl: 'https://inspdinfo.iachina.cn/lifeIns/detail?data=2',
          clauseUrl: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=old',
          clauseFileName: 'old_TERMS.PDF',
          existingUrl: 'https://local.example/knowledge/old',
          qualityStatus: 'represented_local_url',
        },
        {
          company: '中国人民人寿保险股份有限公司',
          productName: '人保寿险示例年金保险哈希重复',
          productType: '人身保险类',
          salesStatus: '停售',
          detailUrl: 'https://inspdinfo.iachina.cn/lifeIns/detail?data=2-hash',
          clauseUrl: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=old-hash',
          clauseFileName: 'old_hash_TERMS.PDF',
          skippedExisting: true,
          skippedReason: 'existing_hash',
          existingHash: 'hash123',
          skippedExistingEvidence: { pdfSha256: 'hash123' },
        },
        {
          company: '中国人民人寿保险股份有限公司',
          productName: '人保寿险示例年金保险批内重复',
          productType: '人身保险类',
          salesStatus: '停售',
          detailUrl: 'https://inspdinfo.iachina.cn/lifeIns/detail?data=2-dup',
          clauseUrl: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=old-dup',
          clauseFileName: 'old_dup_TERMS.PDF',
          skipReason: 'duplicate_plan_url',
          duplicateOf: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=old',
        },
      ],
      detailResults: [
        {
          ok: false,
          code: 'JRCPCX_CLAUSE_PDF_FETCH_FAILED',
          message: 'html response',
          productName: '人保寿险失败示例',
          company: '中国人民人寿保险股份有限公司',
          detailUrl: 'https://inspdinfo.iachina.cn/lifeIns/detail?data=3',
        },
      ],
    },
  });

  assert.equal(report.summary.downloadedCount, 0);
  assert.equal(report.summary.skippedExistingCount, 3);
  assert.equal(report.summary.blockedCount, 1);
  assert.equal(report.summary.representedUrlCount, 1);
  assert.equal(report.summary.representedHashCount, 1);
  assert.equal(report.summary.byCompany.skippedExisting['中国人民人寿保险股份有限公司'], 3);
  assert.equal(report.summary.byCompany.blocked['中国人民人寿保险股份有限公司'], 1);
  assert.deepEqual(report.skippedExisting.map((row) => row.reason), ['existing_url', 'existing_hash', 'duplicate_plan_url']);
  assert.equal(report.skippedExisting[0].existingUrl, 'https://local.example/knowledge/old');
  assert.deepEqual(report.skippedExisting[1].skipEvidence, { pdfSha256: 'hash123' });
  assert.equal(report.skippedExisting[1].existingHash, 'hash123');
  assert.equal(report.skippedExisting[2].duplicateOf, 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=old');
  assert.equal(report.blocked[0].reason, 'JRCPCX_CLAUSE_PDF_FETCH_FAILED');
});

test('buildPdfOnlyReport enriches skipped-existing rows with local PDF manifest records', () => {
  const pdfPath = ensurePdfFixture();
  const pdfSha256 = sha256File(pdfPath);
  const report = buildPdfOnlyReport({
    generatedAt: '2026-06-21T08:00:00.000Z',
    localPdfRecords: [
      {
        id: 514164,
        company: '中国人寿保险股份有限公司',
        productName: '国寿附加旅行综合医疗保险',
        url: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=life-medical&t=111',
        pdfLocalPath: pdfPath,
        pdfSha256,
        pdfBytes: fs.statSync(pdfPath).size,
        pdfOriginalUrl: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=life-medical&t=111',
        pdfContentType: 'application/pdf',
        pdfArchivedAt: '2026-06-18T12:05:30Z',
      },
    ],
    crawlResult: {
      records: [
        {
          company: '中国人寿保险股份有限公司',
          productName: '国寿附加旅行综合医疗保险',
          productType: '健康保险-医疗保险',
          salesStatus: '在售',
          detailUrl: 'https://inspdinfo.iachina.cn/lifeIns/detail?data=life-medical',
          clauseUrl: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?t=222&info=life-medical',
          clauseFileName: 'life_medical_TERMS.PDF',
          skippedExisting: true,
          skippedReason: 'existing_url',
        },
      ],
    },
  });

  assert.equal(report.summary.skippedExistingCount, 1);
  assert.equal(report.summary.existingPdfManifestCount, 1);
  assert.equal(report.summary.existingPdfPathExistsCount, 1);
  assert.equal(report.summary.missingExistingPdfPathCount, 0);
  assert.equal(report.summary.missingExistingPdfFileCount, 0);
  assert.equal(report.summary.existingPdfSha256MismatchCount, 0);
  assert.equal(report.summary.byCompany.existingPdfManifest['中国人寿保险股份有限公司'], 1);
  assert.equal(report.existingPdfManifest[0].pdfLocalPath, pdfPath);
  assert.equal(report.existingPdfManifest[0].pdfFileName, path.basename(pdfPath));
  assert.equal(report.existingPdfManifest[0].pdfSha256, pdfSha256);
  assert.equal(report.existingPdfManifest[0].pdfSha256MatchesFile, true);
  assert.equal(report.existingPdfManifest[0].sourceKnowledgeRecordId, 514164);
});

test('validatePdfOnlyReport verifies PDF signature, sha256, and required metadata', () => {
  const pdfPath = ensurePdfFixture();
  const nonPdfPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jrcpcx-non-pdf-')), 'not-pdf.pdf');
  fs.writeFileSync(nonPdfPath, 'not a pdf\n');
  const validRow = buildPdfOnlyReport({
    crawlResult: {
      records: [
        {
          company: '阳光人寿保险股份有限公司',
          productName: '阳光人寿附加意外伤害保险',
          productType: '人身保险类',
          salesStatus: '停售',
          detailUrl: 'https://inspdinfo.iachina.cn/lifeIns/detail?data=7',
          clauseUrl: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=valid',
          clauseFileName: 'valid_TERMS.PDF',
          pdfLocalPath: pdfPath,
          pdfSha256: sha256File(pdfPath),
          pdfBytes: fs.statSync(pdfPath).size,
          pdfContentType: 'application/pdf',
          pdfArchivedAt: '2026-06-21T08:00:01Z',
          detailFields: { 产品条款文字编码: '阳光人寿〔2020〕意外伤害保险007号' },
        },
      ],
    },
  }).downloaded[0];
  const invalidMetadataRow = {
    ...validRow,
    pdfSha256: 'badsha',
    clauseFileName: '',
    pdfContentType: '',
    pdfArchivedAt: '',
    productType: '',
    productState: '',
    industryCode: '',
    detailUrl: '',
    normalizedClauseUrl: '',
    pdfOriginalUrl: '',
    suggestedReadableName: '',
    responsibilityDeferred: false,
  };
  const nonPdfRow = {
    ...validRow,
    productName: '阳光人寿非 PDF 示例',
    pdfLocalPath: nonPdfPath,
    pdfSha256: sha256File(nonPdfPath),
    pdfBytes: fs.statSync(nonPdfPath).size,
  };

  const validation = validatePdfOnlyReport({ downloaded: [invalidMetadataRow, nonPdfRow] });
  const reasons = validation.issues.map((issue) => issue.reason);

  assert.equal(validation.ok, false);
  assert.match(reasons.join(','), /pdf_sha256_mismatch/u);
  assert.match(reasons.join(','), /missing_product_type/u);
  assert.match(reasons.join(','), /missing_product_state/u);
  assert.match(reasons.join(','), /missing_industry_code/u);
  assert.match(reasons.join(','), /missing_detail_url/u);
  assert.match(reasons.join(','), /missing_clause_file_name/u);
  assert.match(reasons.join(','), /missing_pdf_original_url/u);
  assert.match(reasons.join(','), /missing_pdf_content_type/u);
  assert.match(reasons.join(','), /missing_pdf_archived_at/u);
  assert.match(reasons.join(','), /missing_suggested_readable_name/u);
  assert.match(reasons.join(','), /missing_normalized_clause_url/u);
  assert.match(reasons.join(','), /responsibility_not_deferred/u);
  assert.match(reasons.join(','), /pdf_file_signature_mismatch/u);
});

test('validatePdfOnlyReport catches missing PDF files', () => {
  const missingPdfPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jrcpcx-missing-pdf-')), 'missing.pdf');
  const report = buildPdfOnlyReport({
    crawlResult: {
      records: [
        {
          company: '友邦人寿保险有限公司',
          productName: '友邦附加意外伤害保险',
          productType: '人身保险类',
          salesStatus: '停售',
          detailUrl: 'https://inspdinfo.iachina.cn/lifeIns/detail?data=4',
          clauseUrl: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=missing',
          clauseFileName: 'missing_TERMS.PDF',
          pdfLocalPath: missingPdfPath,
          pdfSha256: 'missing123',
          pdfBytes: 10,
        },
      ],
    },
  });

  const validation = validatePdfOnlyReport(report);

  assert.equal(validation.ok, false);
  assert.equal(validation.missingPdfPathCount, 1);
  assert.match(validation.issues[0].reason, /pdf_file_not_found/u);
});

test('writePdfOnlyArtifacts writes aggregate and per-company JSON and CSV files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jrcpcx-pdf-only-artifacts-'));
  const pdfPath = ensurePdfFixture();
  const pdfSha256 = sha256File(pdfPath);
  const report = buildPdfOnlyReport({
    generatedAt: '2026-06-21T08:00:00.000Z',
    crawlResult: {
      products: [
        {
          company: '太平人寿保险有限公司',
          productName: '太平团体年金保险',
          productType: '人身保险类',
          salesStatus: '停售',
          detailUrl: 'https://inspdinfo.iachina.cn/lifeIns/detail?data=5',
          clauseUrl: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=taiping',
          clauseFileName: 'taiping_TERMS.PDF',
        },
      ],
      records: [
        {
          company: '太平人寿保险有限公司',
          productName: '太平团体年金保险',
          productType: '人身保险类',
          salesStatus: '停售',
          detailUrl: 'https://inspdinfo.iachina.cn/lifeIns/detail?data=5',
          clauseUrl: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=taiping',
          clauseFileName: 'taiping_TERMS.PDF',
          pdfLocalPath: pdfPath,
          pdfSha256,
          pdfBytes: fs.statSync(pdfPath).size,
          pdfContentType: 'application/pdf',
          pdfArchivedAt: '2026-06-21T08:00:01Z',
        },
        {
          company: '太平人寿保险有限公司',
          productName: '太平团体年金保险哈希已存在',
          productType: '人身保险类',
          salesStatus: '停售',
          detailUrl: 'https://inspdinfo.iachina.cn/lifeIns/detail?data=5-hash',
          clauseUrl: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=taiping-hash',
          clauseFileName: 'taiping_hash_TERMS.PDF',
          skippedExisting: true,
          reason: 'existing_hash',
          existingHash: pdfSha256,
        },
      ],
      unresolvedTruncatedShards: [
        {
          company: '太平人寿保险有限公司',
          productName: '太平截断示例',
          reason: 'truncated_catalog_shard',
        },
      ],
    },
  });

  assert.equal(report.summary.catalogRowCount, 1);
  assert.equal(report.summary.uniqueCandidateMaterialCount, 2);
  assert.equal(report.summary.representedHashCount, 1);
  assert.equal(report.summary.unresolvedTruncatedShardCount, 1);
  assert.equal(report.summary.byCompany.uniqueCandidateMaterials['太平人寿保险有限公司'], 2);
  assert.equal(report.summary.byCompany.unresolvedTruncatedShards['太平人寿保险有限公司'], 1);

  const files = writePdfOnlyArtifacts({
    report,
    outputDir: dir,
    batchName: 'jrcpcx-major-company-pdf-only-test',
  });

  assert.equal(fs.existsSync(files.aggregate.summaryJson), true);
  assert.equal(fs.existsSync(files.aggregate.catalogJson), true);
  assert.equal(fs.existsSync(files.aggregate.catalogCsv), true);
  assert.equal(fs.existsSync(files.aggregate.downloadedCsv), true);
  assert.equal(fs.existsSync(files.aggregate.existingPdfManifestJson), true);
  assert.equal(fs.existsSync(files.aggregate.existingPdfManifestCsv), true);
  assert.equal(fs.existsSync(files.byCompany['太平人寿保险有限公司'].catalogJson), true);
  assert.equal(fs.existsSync(files.byCompany['太平人寿保险有限公司'].catalogCsv), true);
  assert.equal(fs.existsSync(files.byCompany['太平人寿保险有限公司'].downloadedJson), true);
  assert.equal(fs.existsSync(files.byCompany['太平人寿保险有限公司'].existingPdfManifestJson), true);
  assert.equal(JSON.parse(fs.readFileSync(files.byCompany['太平人寿保险有限公司'].summaryJson, 'utf8')).representedHashCount, 1);
  assert.match(fs.readFileSync(files.aggregate.downloadedCsv, 'utf8'), /太平团体年金保险/u);
  assert.match(fs.readFileSync(files.aggregate.catalogCsv, 'utf8'), /taiping_TERMS\.PDF/u);
});

test('CLI pdf-only mode writes artifact output without touching SQLite', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jrcpcx-pdf-only-cli-'));
  const inputPath = path.join(dir, 'crawl.json');
  fs.writeFileSync(inputPath, `${JSON.stringify({
    generatedAt: '2026-06-21T08:00:00.000Z',
    records: [
      {
        company: '太平人寿保险有限公司',
        productName: '太平团体年金保险',
        productType: '人身保险类',
        salesStatus: '停售',
        detailUrl: 'https://inspdinfo.iachina.cn/lifeIns/detail?data=6',
        clauseUrl: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=taiping-cli',
        clauseFileName: 'taiping_cli_TERMS.PDF',
        pdfLocalPath: ensurePdfFixture(),
        pdfSha256: sha256File(pdfFixturePath),
        pdfBytes: fs.statSync(pdfFixturePath).size,
        pdfContentType: 'application/pdf',
        pdfArchivedAt: '2026-06-21T08:00:01Z',
        detailFields: { 产品条款文字编码: '太平人寿〔2020〕团体年金保险006号' },
      },
    ],
  })}\n`);

  const result = spawnSync(process.execPath, [
    'scripts/jrcpcx-major-company-gap-backfill.mjs',
    '--mode=pdf-only',
    `--input=${inputPath}`,
    `--output-dir=${dir}`,
    '--batch-name=jrcpcx-major-company-pdf-only-cli-test',
    '--pretty',
  ], {
    cwd: path.resolve('.'),
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.summary.downloadedCount, 1);
  assert.equal(output.validation.ok, true);
  assert.equal(fs.existsSync(output.files.aggregate.summaryJson), true);
  assert.equal(fs.existsSync(output.files.aggregate.downloadedCsv), true);
});

test('CLI pdf-only mode enriches skipped-existing manifest from read-only SQLite', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jrcpcx-pdf-only-cli-db-'));
  const dbPath = path.join(dir, 'policy-ocr.sqlite');
  const inputPath = path.join(dir, 'crawl.json');
  const pdfPath = path.join(dir, 'existing.pdf');
  fs.writeFileSync(pdfPath, '%PDF-1.4\n% existing fixture\n');
  const pdfSha256 = sha256File(pdfPath);
  const clauseUrl = 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=cli-db-existing&t=111';
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
    `);
    db.prepare('INSERT INTO knowledge_records (id, company, product_name, url, payload) VALUES (?, ?, ?, ?, ?)')
      .run(1, '中国人寿保险股份有限公司', '国寿附加旅行综合医疗保险', clauseUrl, JSON.stringify({
        company: '中国人寿保险股份有限公司',
        productName: '国寿附加旅行综合医疗保险',
        url: clauseUrl,
        pdfLocalPath: pdfPath,
        pdfSha256,
        pdfBytes: fs.statSync(pdfPath).size,
        pdfOriginalUrl: clauseUrl,
        pdfContentType: 'application/pdf',
        pdfArchivedAt: '2026-06-18T12:05:30Z',
      }));
  } finally {
    db.close();
  }

  fs.writeFileSync(inputPath, `${JSON.stringify({
    generatedAt: '2026-06-21T08:00:00.000Z',
    records: [
      {
        company: '中国人寿保险股份有限公司',
        productName: '国寿附加旅行综合医疗保险',
        productType: '健康保险-医疗保险',
        salesStatus: '在售',
        industryCode: '中国人寿〔2026〕医疗保险39号',
        detailUrl: 'https://inspdinfo.iachina.cn/lifeIns/detail?data=cli-db-existing',
        clauseUrl: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?t=222&info=cli-db-existing',
        clauseFileName: 'cli_db_existing_TERMS.PDF',
        skippedExisting: true,
        skippedReason: 'existing_url',
      },
    ],
  })}\n`);

  const result = spawnSync(process.execPath, [
    'scripts/jrcpcx-major-company-gap-backfill.mjs',
    '--mode=pdf-only',
    `--input=${inputPath}`,
    `--output-dir=${dir}`,
    '--batch-name=jrcpcx-major-company-pdf-only-cli-db-test',
    `--db-path=${dbPath}`,
    '--pretty',
  ], {
    cwd: path.resolve('.'),
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.summary.skippedExistingCount, 1);
  assert.equal(output.summary.existingPdfManifestCount, 1);
  assert.equal(output.summary.existingPdfPathExistsCount, 1);
  assert.equal(output.summary.missingExistingPdfPathCount, 0);
  assert.equal(output.validation.ok, true);
  const manifest = JSON.parse(fs.readFileSync(output.files.aggregate.existingPdfManifestJson, 'utf8'));
  assert.equal(manifest[0].pdfLocalPath, pdfPath);
  assert.equal(manifest[0].pdfSha256, pdfSha256);
  assert.equal(manifest[0].sourceKnowledgeRecordId, 1);
  const readOnlyDb = new DatabaseSync(dbPath, { readOnly: true });
  try {
    assert.equal(readOnlyDb.prepare('SELECT COUNT(*) AS count FROM knowledge_records').get().count, 1);
  } finally {
    readOnlyDb.close();
  }
});
