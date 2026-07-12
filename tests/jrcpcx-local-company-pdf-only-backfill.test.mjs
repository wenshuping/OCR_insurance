import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  buildLocalCompanyInventory,
  buildLocalCompanyPdfOnlyReport,
  buildLocalCompanyQueries,
  writeLocalCompanyPdfOnlyArtifacts,
} from '../scripts/jrcpcx-local-company-pdf-only-backfill.mjs';

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function parseSimpleCsv(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n');
  const headers = lines[0].replace(/^\ufeff/u, '').split(',');
  return lines.slice(1).map((line) => {
    const values = line.split(',');
    return Object.fromEntries(headers.map((header, index) => [header, values[index] || '']));
  });
}

test('buildLocalCompanyInventory includes local human-insurance companies and excludes property-only companies', () => {
  const records = [
    {
      id: 1,
      company: '阳光人寿保险股份有限公司',
      productName: '阳光人寿重大疾病保险',
      productType: '健康保险-疾病保险',
      url: 'https://example.test/sunshine',
      pdfLocalPath: '/tmp/sunshine.pdf',
    },
    {
      id: 2,
      company: '某财产保险股份有限公司',
      productName: '机动车商业保险',
      productType: '财产保险类',
      url: 'https://example.test/property',
    },
    {
      id: 3,
      company: '友邦人寿保险有限公司',
      productName: '友邦附加意外伤害保险',
      productType: '',
      pageText: '保险责任包括意外身故保险金。',
      url: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=aia&t=1',
      pdfLocalPath: '/tmp/aia.pdf',
    },
  ];

  const inventory = buildLocalCompanyInventory(records);

  assert.equal(inventory.length, 3);
  assert.deepEqual(
    inventory.map((row) => [row.company, row.included, row.excludeReason]),
    [
      ['阳光人寿保险股份有限公司', true, ''],
      ['友邦人寿保险有限公司', true, ''],
      ['某财产保险股份有限公司', false, 'property_insurance_only'],
    ],
  );
  assert.equal(inventory[0].localKnowledgeRecordCount, 1);
  assert.equal(inventory[1].localJrcpcxClauseUrlCount, 1);
  assert.equal(inventory[1].localPdfPathCount, 1);
});

test('buildLocalCompanyQueries creates human-insurance status shards for included companies only', () => {
  const inventory = [
    { company: '阳光人寿保险股份有限公司', included: true },
    { company: '某财产保险股份有限公司', included: false, excludeReason: 'property_insurance_only' },
  ];

  const queries = buildLocalCompanyQueries(inventory);

  assert.deepEqual(
    queries.map((row) => [row.deptName, row.productTypeLabel, row.productTermLabel, row.productStateLabel]),
    [
      ['阳光人寿保险股份有限公司', '人身保险类', '全部', '在售'],
      ['阳光人寿保险股份有限公司', '人身保险类', '全部', '停售'],
      ['阳光人寿保险股份有限公司', '人身保险类', '全部', '停用'],
    ],
  );
});

test('property-only rows with generic responsibility text are excluded from inventory and queries', () => {
  const inventory = buildLocalCompanyInventory([
    {
      id: 4,
      company: '某财产保险股份有限公司',
      productName: '机动车商业保险',
      productType: '财产保险类',
      pageText: '保险责任包括车辆损失保险责任。',
    },
  ]);

  assert.deepEqual(
    inventory.map((row) => [row.company, row.included, row.excludeReason]),
    [['某财产保险股份有限公司', false, 'property_insurance_only']],
  );
  assert.deepEqual(buildLocalCompanyQueries(inventory), []);
});

test('buildLocalCompanyInventory counts JRCPCX clause URL after non-JRCPCX source URL candidates', () => {
  const inventory = buildLocalCompanyInventory([
    {
      id: 5,
      company: '友邦人寿保险有限公司',
      productName: '友邦终身寿险',
      productType: '人身保险类',
      url: 'https://example.test/non-jrcpcx-detail',
      pdfOriginalUrl: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=aia-clause&t=1',
    },
  ]);

  assert.equal(inventory.length, 1);
  assert.equal(inventory[0].included, true);
  assert.equal(inventory[0].localJrcpcxClauseUrlCount, 1);
});

test('property product evidence overrides human words in company names', () => {
  const inventory = buildLocalCompanyInventory([
    {
      id: 6,
      company: '中国人寿财产保险股份有限公司',
      productName: '机动车商业保险',
      productType: '财产保险类',
      pageText: '保险责任包括车辆损失保险责任。',
    },
  ]);

  assert.deepEqual(
    inventory.map((row) => [row.company, row.included, row.excludeReason]),
    [['中国人寿财产保险股份有限公司', false, 'property_insurance_only']],
  );
  assert.deepEqual(buildLocalCompanyQueries(inventory), []);
});

test('buildLocalCompanyInventory preserves local and submitted company names from rows', () => {
  const inventory = buildLocalCompanyInventory([
    {
      id: 7,
      company: '友邦保险有限公司上海分公司',
      localCompanyName: '友邦上海本地名称',
      submittedDeptName: '友邦人寿保险有限公司',
      productName: '友邦附加意外伤害保险',
      productType: '人身保险类',
    },
  ]);

  assert.equal(inventory.length, 1);
  assert.equal(inventory[0].company, '友邦保险有限公司上海分公司');
  assert.equal(inventory[0].localCompanyName, '友邦上海本地名称');
  assert.equal(inventory[0].submittedDeptName, '友邦人寿保险有限公司');
});

test('generic responsibility text alone does not create human-insurance evidence', () => {
  const inventory = buildLocalCompanyInventory([
    {
      id: 8,
      company: '某保险股份有限公司',
      productName: '综合保障计划',
      productType: '',
      pageText: '保险责任包括合同约定的保障责任。',
    },
  ]);

  assert.deepEqual(
    inventory.map((row) => [row.company, row.included, row.excludeReason]),
    [['某保险股份有限公司', false, 'no_human_insurance_evidence']],
  );
});

test('buildLocalCompanyInventory counts JRCPCX clause URL from clauseUrl candidate', () => {
  const inventory = buildLocalCompanyInventory([
    {
      id: 9,
      company: '友邦人寿保险有限公司',
      productName: '友邦终身寿险',
      productType: '人身保险类',
      clauseUrl: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=aia-clause-url&t=1',
    },
  ]);

  assert.equal(inventory.length, 1);
  assert.equal(inventory[0].localJrcpcxClauseUrlCount, 1);
});

test('buildLocalCompanyInventory counts JRCPCX clause URL from normalized and source candidates', () => {
  const inventory = buildLocalCompanyInventory([
    {
      id: 10,
      company: '友邦人寿保险有限公司',
      productName: '友邦终身寿险',
      productType: '人身保险类',
      normalizedClauseUrl: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=aia-normalized',
    },
    {
      id: 11,
      company: '友邦人寿保险有限公司',
      productName: '友邦定期寿险',
      productType: '人身保险类',
      payload: {
        source_knowledge_url: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=aia-source&t=1',
      },
    },
  ]);

  assert.equal(inventory.length, 1);
  assert.equal(inventory[0].localJrcpcxClauseUrlCount, 2);
});

test('buildLocalCompanyInventory counts unique JRCPCX clause URLs across all row candidates', () => {
  const inventory = buildLocalCompanyInventory([
    {
      id: 12,
      company: '友邦人寿保险有限公司',
      productName: '友邦终身寿险',
      productType: '人身保险类',
      clauseUrl: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=aia-duplicate&t=1',
      normalizedClauseUrl: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=aia-duplicate&t=2',
      pdfOriginalUrl: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=aia-pdf&t=1',
      payload: {
        sourceKnowledgeUrl: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=aia-source&t=1',
      },
    },
  ]);

  assert.equal(inventory.length, 1);
  assert.equal(inventory[0].localJrcpcxClauseUrlCount, 3);
});

test('buildLocalCompanyInventory counts every supported JRCPCX URL candidate variant', () => {
  const cases = [
    { label: 'top-level url', field: 'url' },
    { label: 'top-level clauseUrl', field: 'clauseUrl' },
    { label: 'top-level clause_url', field: 'clause_url' },
    { label: 'top-level normalizedClauseUrl', field: 'normalizedClauseUrl' },
    { label: 'top-level normalized_clause_url', field: 'normalized_clause_url' },
    { label: 'top-level pdfOriginalUrl', field: 'pdfOriginalUrl' },
    { label: 'top-level pdf_original_url', field: 'pdf_original_url' },
    { label: 'top-level sourceKnowledgeUrl', field: 'sourceKnowledgeUrl' },
    { label: 'top-level source_knowledge_url', field: 'source_knowledge_url' },
    { label: 'payload url', payloadField: 'url' },
    { label: 'payload clauseUrl', payloadField: 'clauseUrl' },
    { label: 'payload clause_url', payloadField: 'clause_url' },
    { label: 'payload normalizedClauseUrl', payloadField: 'normalizedClauseUrl' },
    { label: 'payload normalized_clause_url', payloadField: 'normalized_clause_url' },
    { label: 'payload pdfOriginalUrl', payloadField: 'pdfOriginalUrl' },
    { label: 'payload pdf_original_url', payloadField: 'pdf_original_url' },
    { label: 'payload sourceKnowledgeUrl', payloadField: 'sourceKnowledgeUrl' },
    { label: 'payload source_knowledge_url', payloadField: 'source_knowledge_url' },
  ];

  for (const [index, candidate] of cases.entries()) {
    const url = `https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=url-candidate-${index}&t=1`;
    const row = {
      id: 100 + index,
      company: '友邦人寿保险有限公司',
      productName: '友邦终身寿险',
      productType: '人身保险类',
    };
    if (candidate.field) row[candidate.field] = url;
    if (candidate.payloadField) row.payload = { [candidate.payloadField]: url };

    const inventory = buildLocalCompanyInventory([row]);

    assert.equal(inventory.length, 1, candidate.label);
    assert.equal(inventory[0].localJrcpcxClauseUrlCount, 1, candidate.label);
  }
});

test('buildLocalCompanyPdfOnlyReport writes dynamic company PDF manifests', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jrcpcx-local-company-report-'));
  const pdfPath = path.join(dir, 'existing.pdf');
  fs.writeFileSync(pdfPath, '%PDF-1.4\n% local company existing pdf\n');
  const pdfSha256 = sha256File(pdfPath);
  const inventory = [
    {
      company: '阳光人寿保险股份有限公司',
      localCompanyName: '阳光人寿保险股份有限公司',
      submittedDeptName: '阳光人寿保险股份有限公司',
      included: true,
    },
  ];

  const report = buildLocalCompanyPdfOnlyReport({
    generatedAt: '2026-06-21T08:00:00.000Z',
    inventory,
    crawlResult: {
      products: [
        {
          company: '阳光人寿保险股份有限公司',
          productName: '阳光人寿重大疾病保险',
          productType: '健康保险-疾病保险',
          productState: '停售',
          detailUrl: 'https://inspdinfo.iachina.cn/lifeIns/detail?data=sunshine',
          clauseUrl: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=sunshine',
          clauseFileName: 'sunshine_TERMS.PDF',
        },
      ],
      records: [
        {
          company: '阳光人寿保险股份有限公司',
          productName: '阳光人寿重大疾病保险',
          productType: '健康保险-疾病保险',
          salesStatus: '停售',
          industryCode: '阳光人寿〔2020〕疾病保险001号',
          detailUrl: 'https://inspdinfo.iachina.cn/lifeIns/detail?data=sunshine',
          clauseUrl: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=sunshine&t=2',
          clauseFileName: 'sunshine_TERMS.PDF',
          skippedExisting: true,
          skippedReason: 'existing_url',
        },
      ],
    },
    localPdfRecords: [
      {
        id: 101,
        company: '阳光人寿保险股份有限公司',
        productName: '阳光人寿重大疾病保险',
        url: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=sunshine&t=1',
        pdfLocalPath: pdfPath,
        pdfSha256,
        pdfBytes: fs.statSync(pdfPath).size,
        pdfContentType: 'application/pdf',
        pdfArchivedAt: '2026-06-18T12:00:00Z',
      },
    ],
  });

  assert.equal(report.schemaVersion, 'jrcpcx-local-company-pdf-only/v1');
  assert.equal(report.summary.localCompanyCount, 1);
  assert.equal(report.summary.existingPdfManifestCount, 1);
  assert.equal(report.existingPdfManifest[0].localCompanyName, '阳光人寿保险股份有限公司');
  assert.equal(report.existingPdfManifest[0].submittedDeptName, '阳光人寿保险股份有限公司');
  assert.equal(report.existingPdfManifest[0].pdfLocalPath, pdfPath);
});

test('buildLocalCompanyPdfOnlyReport uses localCompanyName keys for every byCompany map', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jrcpcx-local-company-summary-'));
  const pdfPath = path.join(dir, 'downloaded.pdf');
  fs.writeFileSync(pdfPath, '%PDF-1.4\n% local company downloaded pdf\n');
  const report = buildLocalCompanyPdfOnlyReport({
    generatedAt: '2026-06-21T08:00:00.000Z',
    inventory: [
      {
        company: '友邦保险有限公司上海分公司',
        localCompanyName: '友邦上海本地名称',
        submittedDeptName: '友邦人寿保险有限公司',
        included: true,
      },
    ],
    crawlResult: {
      products: [
        {
          company: '友邦人寿保险有限公司',
          productName: '友邦终身寿险',
          productType: '人身保险类',
          salesStatus: '在售',
          detailUrl: 'https://inspdinfo.iachina.cn/lifeIns/detail?data=aia-local',
          clauseUrl: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=aia-local&t=1',
        },
      ],
      records: [
        {
          company: '友邦人寿保险有限公司',
          productName: '友邦终身寿险',
          productType: '人身保险类',
          salesStatus: '在售',
          detailUrl: 'https://inspdinfo.iachina.cn/lifeIns/detail?data=aia-local',
          clauseUrl: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=aia-local&t=1',
          pdfLocalPath: pdfPath,
          pdfSha256: sha256File(pdfPath),
          pdfBytes: fs.statSync(pdfPath).size,
        },
      ],
    },
  });

  for (const map of Object.values(report.summary.byCompany)) {
    assert.equal(Object.hasOwn(map, '友邦人寿保险有限公司'), false);
  }
  assert.equal(report.summary.byCompany.catalog['友邦上海本地名称'], 1);
  assert.equal(report.summary.byCompany.downloaded['友邦上海本地名称'], 1);
  assert.equal(report.summary.byCompany.uniqueCandidateMaterials['友邦上海本地名称'], 1);
});

test('writeLocalCompanyPdfOnlyArtifacts writes aggregate and dynamic per-company files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jrcpcx-local-company-artifacts-'));
  const report = {
    schemaVersion: 'jrcpcx-local-company-pdf-only/v1',
    generatedAt: '2026-06-21T08:00:00.000Z',
    companyInventory: [
      { company: '阳光人寿保险股份有限公司', included: true },
    ],
    summary: {
      localCompanyCount: 1,
      includedCompanyCount: 1,
      excludedCompanyCount: 0,
      catalogRowCount: 0,
      downloadedCount: 0,
      existingPdfManifestCount: 0,
      blockedCount: 0,
      byCompany: {},
    },
    catalog: [
      {
        localCompanyName: '阳光人寿保险股份有限公司',
        submittedDeptName: '阳光人寿保险股份有限公司',
        company: '阳光人寿保险股份有限公司',
        productName: '阳光人寿重大疾病保险',
        productType: '健康保险-疾病保险',
        salesStatus: '停售',
        detailUrl: 'https://inspdinfo.iachina.cn/lifeIns/detail?data=sunshine-csv',
        clauseUrl: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=sunshine-csv&t=9',
        clauseFileName: 'sunshine_csv_TERMS.PDF',
      },
    ],
    downloaded: [],
    skippedExisting: [
      {
        status: 'skipped_existing',
        reason: 'existing_url',
        localCompanyName: '阳光人寿保险股份有限公司',
        submittedDeptName: '阳光人寿保险股份有限公司',
        issuerFullName: '阳光人寿保险股份有限公司',
        productName: '阳光人寿重大疾病保险',
        existingUrl: 'https://local.example/knowledge/sunshine',
        actualPdfSha256: 'actual-sha256',
      },
    ],
    existingPdfManifest: [
      {
        status: 'skipped_existing',
        reason: 'existing_url',
        localCompanyName: '阳光人寿保险股份有限公司',
        submittedDeptName: '阳光人寿保险股份有限公司',
        issuerFullName: '阳光人寿保险股份有限公司',
        productName: '阳光人寿重大疾病保险',
        existingUrl: 'https://local.example/knowledge/sunshine',
        actualPdfSha256: 'actual-sha256',
      },
    ],
    blocked: [],
  };

  const files = writeLocalCompanyPdfOnlyArtifacts({
    report,
    outputDir: dir,
    batchName: 'jrcpcx-local-company-pdf-only-test',
    pretty: true,
  });

  assert.equal(fs.existsSync(files.aggregate.summaryJson), true);
  assert.equal(fs.existsSync(files.aggregate.existingPdfManifestCsv), true);
  assert.equal(fs.existsSync(files.byCompany['阳光人寿保险股份有限公司'].summaryJson), true);

  const catalogRows = parseSimpleCsv(files.aggregate.catalogCsv);
  assert.equal(catalogRows[0].issuerFullName, '阳光人寿保险股份有限公司');
  assert.equal(catalogRows[0].productState, '停售');
  assert.equal(catalogRows[0].normalizedClauseUrl, 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=sunshine-csv');

  const manifestRows = parseSimpleCsv(files.aggregate.existingPdfManifestCsv);
  assert.equal(manifestRows[0].existingUrl, 'https://local.example/knowledge/sunshine');
  assert.equal(manifestRows[0].actualPdfSha256, 'actual-sha256');
});

test('CLI query-file mode writes inventory and queries from read-only SQLite', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jrcpcx-local-company-query-'));
  const dbPath = path.join(dir, 'policy-ocr.sqlite');
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
      .run(1, '阳光人寿保险股份有限公司', '阳光人寿重大疾病保险', 'https://example.test/sunshine', JSON.stringify({
        company: '阳光人寿保险股份有限公司',
        productName: '阳光人寿重大疾病保险',
        productType: '健康保险-疾病保险',
        pageText: '保险责任包括重大疾病保险金。',
        pdfLocalPath: '/tmp/sunshine.pdf',
      }));
    db.prepare('INSERT INTO knowledge_records (id, company, product_name, url, payload) VALUES (?, ?, ?, ?, ?)')
      .run(2, '某财产保险股份有限公司', '机动车商业保险', 'https://example.test/property', JSON.stringify({
        company: '某财产保险股份有限公司',
        productName: '机动车商业保险',
        productType: '财产保险类',
      }));
  } finally {
    db.close();
  }

  const result = spawnSync(process.execPath, [
    'scripts/jrcpcx-local-company-pdf-only-backfill.mjs',
    '--mode=query-file',
    `--db-path=${dbPath}`,
    `--output-dir=${dir}`,
    '--batch-name=jrcpcx-local-company-pdf-only-test',
    '--pretty',
  ], {
    cwd: path.resolve('.'),
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.summary.localCompanyCount, 2);
  assert.equal(output.summary.includedCompanyCount, 1);
  assert.equal(output.summary.excludedCompanyCount, 1);
  assert.equal(output.summary.queryCount, 3);
  assert.equal(fs.existsSync(output.files.inventoryJson), true);
  assert.equal(fs.existsSync(output.files.inventoryCsv), true);
  assert.equal(fs.existsSync(output.files.queriesJson), true);
  assert.equal(fs.existsSync(output.files.queriesCsv), true);
  const queries = JSON.parse(fs.readFileSync(output.files.queriesJson, 'utf8')).queries;
  assert.equal(queries.length, 3);
  assert.equal(queries[0].deptName, '阳光人寿保险股份有限公司');

  const readOnlyDb = new DatabaseSync(dbPath, { readOnly: true });
  try {
    assert.equal(readOnlyDb.prepare('SELECT COUNT(*) AS count FROM knowledge_records').get().count, 2);
  } finally {
    readOnlyDb.close();
  }
});

test('CLI pdf-only mode writes dynamic manifests and leaves SQLite unchanged', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jrcpcx-local-company-pdf-cli-'));
  const dbPath = path.join(dir, 'policy-ocr.sqlite');
  const inputPath = path.join(dir, 'crawl.json');
  const inventoryPath = path.join(dir, 'inventory.json');
  const pdfPath = path.join(dir, 'existing.pdf');
  fs.writeFileSync(pdfPath, '%PDF-1.4\n% existing local company pdf\n');
  const pdfSha256 = sha256File(pdfPath);
  const clauseUrl = 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=local-cli&t=1';

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
      .run(1, '阳光人寿保险股份有限公司', '阳光人寿重大疾病保险', clauseUrl, JSON.stringify({
        company: '阳光人寿保险股份有限公司',
        productName: '阳光人寿重大疾病保险',
        productType: '健康保险-疾病保险',
        url: clauseUrl,
        pdfLocalPath: pdfPath,
        pdfSha256,
        pdfBytes: fs.statSync(pdfPath).size,
        pdfContentType: 'application/pdf',
        pdfArchivedAt: '2026-06-18T12:00:00Z',
      }));
  } finally {
    db.close();
  }

  fs.writeFileSync(inventoryPath, `${JSON.stringify({
    inventory: [
      {
        company: '阳光人寿保险股份有限公司',
        localCompanyName: '阳光人寿保险股份有限公司',
        submittedDeptName: '阳光人寿保险股份有限公司',
        included: true,
      },
    ],
  })}\n`);

  fs.writeFileSync(inputPath, `${JSON.stringify({
    generatedAt: '2026-06-21T08:00:00.000Z',
    records: [
      {
        company: '阳光人寿保险股份有限公司',
        productName: '阳光人寿重大疾病保险',
        productType: '健康保险-疾病保险',
        productState: '停售',
        industryCode: '阳光人寿〔2020〕疾病保险001号',
        detailUrl: 'https://inspdinfo.iachina.cn/lifeIns/detail?data=local-cli',
        clauseUrl: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=local-cli&t=2',
        clauseFileName: 'local_cli_TERMS.PDF',
        skippedExisting: true,
        skippedReason: 'existing_url',
      },
    ],
  })}\n`);

  const result = spawnSync(process.execPath, [
    'scripts/jrcpcx-local-company-pdf-only-backfill.mjs',
    '--mode=pdf-only',
    `--input=${inputPath}`,
    `--inventory=${inventoryPath}`,
    `--db-path=${dbPath}`,
    `--output-dir=${dir}`,
    '--batch-name=jrcpcx-local-company-pdf-only-cli-test',
    '--pretty',
  ], {
    cwd: path.resolve('.'),
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.summary.existingPdfManifestCount, 1);
  assert.equal(output.validation.ok, true);
  assert.equal(fs.existsSync(output.files.aggregate.existingPdfManifestJson), true);
  const manifest = JSON.parse(fs.readFileSync(output.files.aggregate.existingPdfManifestJson, 'utf8'));
  assert.equal(manifest[0].pdfLocalPath, pdfPath);

  const readOnlyDb = new DatabaseSync(dbPath, { readOnly: true });
  try {
    assert.equal(readOnlyDb.prepare('SELECT COUNT(*) AS count FROM knowledge_records').get().count, 1);
  } finally {
    readOnlyDb.close();
  }
});
