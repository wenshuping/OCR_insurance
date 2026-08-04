import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  crawlOfficialKnowledge,
  extractCrossInsuranceFieldEvidenceText,
  extractFocusedResponsibilityText,
  extractPdfTextWithPython,
  normalizeKnowledgeProductType,
  normalizeKnowledgeRecord,
} from '../server/policy-knowledge.service.mjs';
import { createSqliteStateStore } from '../server/sqlite-state-store.mjs';

const bundledPython = path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3');

function buildEncryptedPdfFixture() {
  const result = spawnSync(bundledPython, ['-c', [
    'import io, sys',
    'from reportlab.pdfgen import canvas',
    'from reportlab.pdfbase import pdfmetrics',
    'from reportlab.pdfbase.cidfonts import UnicodeCIDFont',
    'from pypdf import PdfReader, PdfWriter',
    "pdfmetrics.registerFont(UnicodeCIDFont('STSong-Light'))",
    'plain = io.BytesIO()',
    'document = canvas.Canvas(plain)',
    "document.setFont('STSong-Light', 12)",
    "document.drawString(72, 750, '测试万能保险 第五条 保险责任 身故保险金')",
    "document.drawString(72, 720, '第十条 本合同设置万能账户，最低保证利率为年利率2%。')",
    'document.save()',
    'writer = PdfWriter()',
    'writer.append_pages_from_reader(PdfReader(io.BytesIO(plain.getvalue())))',
    "writer.encrypt('', algorithm='AES-256-R5')",
    'encrypted = io.BytesIO()',
    'writer.write(encrypted)',
    'sys.stdout.buffer.write(encrypted.getvalue())',
  ].join('\n')], { encoding: null, maxBuffer: 2 * 1024 * 1024 });
  assert.equal(result.status, 0, String(result.stderr || 'encrypted fixture generation failed'));
  assert.match(result.stdout.subarray(0, 5).toString('latin1'), /^%PDF-/u);
  return result.stdout;
}

test('normalizeKnowledgeRecord upgrades generic health type to critical illness when product text is explicit', () => {
  const record = normalizeKnowledgeRecord({
    id: 379,
    company: '新华保险',
    productName: '新华人寿保险股份有限公司i他男性特定疾病保险',
    productType: '健康险',
    title: '保险条款',
    pageText: '保险责任包括特定重大疾病保险金、特定轻症疾病保险金、特定重度恶性肿瘤保险金。',
    url: 'https://www.newchinalife.com/products/ithe-male-ci',
  });

  assert.equal(record?.productType, '重疾险');
});

test('normalizeKnowledgeRecord preserves historical official seed trace fields', () => {
  const record = normalizeKnowledgeRecord({
    company: '中国平安',
    productName: '平安智富人生终身寿险（万能型，B，2004）',
    title: '平安智富人生终身寿险（万能型，B，2004）条款',
    url: 'https://life.pingan.com/ilife-home/product/getPlanClausePdf?planCode=893&versionNo=893-2&attachmentType=1',
    planCode: '893',
    versionNo: '893-2',
    catalogStatus: 'missing_from_getProductList',
    seedSource: '平安官网保单E服务FAQ：万能险智富人生892/893',
    seedSourceUrl: 'https://www.pingan.com/campaign/efuwu/questions.jsp',
  });

  assert.equal(record?.planCode, '893');
  assert.equal(record?.versionNo, '893-2');
  assert.equal(record?.catalogStatus, 'missing_from_getProductList');
  assert.equal(record?.seedSourceUrl, 'https://www.pingan.com/campaign/efuwu/questions.jsp');
});

test('normalizeKnowledgeRecord preserves archived PDF metadata', () => {
  const record = normalizeKnowledgeRecord({
    company: '中国平安',
    productName: '平安康泰终身保险（甲）（9906）',
    title: '平安康泰终身保险（甲）（9906）条款',
    url: 'https://life.pingan.com/ilife-home/product/getPlanClausePdf?planCode=738&versionNo=738-1&attachmentType=1',
    pageText: '保险责任 被保险人身故，我们按约定给付身故保险金。',
    sourceType: 'pdf',
    pages: 12,
    bytes: 2048,
    contentType: 'application/pdf',
    pdfLocalPath: '/tmp/policy-material-pdfs/ab/cd/sample.pdf',
    pdfSha256: 'abcd'.repeat(16),
    pdfBytes: 2048,
    pdfOriginalUrl: 'https://life.pingan.com/ilife-home/product/getPlanClausePdf?planCode=738&versionNo=738-1&attachmentType=1',
    pdfArchivedAt: '2026-06-18T00:00:00Z',
  });

  assert.equal(record?.pages, 12);
  assert.equal(record?.bytes, 2048);
  assert.equal(record?.contentType, 'application/pdf');
  assert.equal(record?.pdfLocalPath, '/tmp/policy-material-pdfs/ab/cd/sample.pdf');
  assert.equal(record?.pdfSha256, 'abcd'.repeat(16));
  assert.equal(record?.pdfBytes, 2048);
  assert.equal(record?.pdfArchivedAt, '2026-06-18T00:00:00Z');
});

test('normalizeKnowledgeRecord preserves extraction method audit metadata', () => {
  const record = normalizeKnowledgeRecord({
    company: '新华保险',
    productName: '新华人寿保险股份有限公司健乐增额终身重大疾病保险（分红型）',
    title: '健乐增额终身重大疾病保险（分红型）条款',
    url: 'https://static-cdn.newchinalife.com/ncl/pdf/20240423/29e90f47-6d61-445a-a48f-1e0441821df3.pdf',
    pageText: '保险责任 被保险人初次患重大疾病，本公司按有效保险金额给付重大疾病保险金。',
    sourceType: 'pdf',
    parser: 'scrapling_new_china_disclosure',
    extractionMethod: 'macos_vision',
  });

  assert.equal(record?.extractionMethod, 'macos_vision');
});

test('focused responsibility text keeps an atomic parameter definition used by a payout formula', () => {
  const pageText = extractFocusedResponsibilityText([
    '保险责任 在本合同保险期间内，我们承担下列保险责任：',
    '1.养老年金 被保险人生存，我们按确定的每年或每月领取金额给付养老年金。',
    '按年领取的，每年领取金额为基本保险金额；按月领取的，每月领取金额为基本保险金额×月领折算系数。',
    '上述月领折算系数的数值为0.085。',
    '2.身故保险金 被保险人身故，我们按约定给付身故保险金。',
    '责任免除 投保人故意伤害被保险人。',
  ].join(''));

  assert.match(pageText, /月领折算系数的数值为0\.085/u);
});

test('PDF field evidence keeps supported fields across insurance types without requiring every field', () => {
  const evidence = extractCrossInsuranceFieldEvidenceText([
    '第十条 最低保证利率为年利率2%，结算利率按月公布。',
    '第十一条 本责任年度免赔额为1万元，赔付比例为80%，限二级及以上医院。',
    '第十二条 重大疾病分为六组，最多给付六次，相邻两次给付间隔期为180日，并豁免后续保险费。',
    '第十三条 意外伤残按伤残等级对应的给付比例给付，航空意外另行给付。',
    '第十四条 当年度有效保险金额等于基本保险金额×(1+3%)^(n-1)。',
    '第十五条 年金可按年领取或按月领取，月领折算系数为0.085，期满给付满期保险金。',
  ].join('\n'));

  assert.match(evidence, /最低保证利率/u);
  assert.match(evidence, /年度免赔额/u);
  assert.match(evidence, /重大疾病分为六组/u);
  assert.match(evidence, /伤残等级/u);
  assert.match(evidence, /有效保险金额/u);
  assert.match(evidence, /月领折算系数/u);
});

test('official crawl fetches the policy-bound PDF before catalog discovery and records its digest', async () => {
  const productName = '测试优选终身寿险（万能型）';
  const sourceText = [
    productName,
    '第五条 保险责任 被保险人身故，我们按合同约定给付身故保险金。',
    '第十条 本合同设置万能账户，最低保证利率为年利率2%。',
    '第十一条 结算利率按月公布，部分领取须符合合同约定。',
  ].join('\n');
  const utf16 = Buffer.alloc(2 + sourceText.length * 2);
  utf16.writeUInt16BE(0xfeff, 0);
  Array.from(sourceText).forEach((character, index) => utf16.writeUInt16BE(character.charCodeAt(0), 2 + index * 2));
  const pdf = Buffer.from(`%PDF-1.4\n/ActualText <${utf16.toString('hex')}>\n%%EOF`, 'latin1');
  let fetchCalls = 0;
  const records = await crawlOfficialKnowledge({
    policy: {
      company: '测试人寿',
      name: productName,
      boundSources: [{ title: `${productName}条款`, url: 'https://official.test/terms?id=v1', official: true }],
    },
    officialDomainProfiles: [{ aliases: ['测试人寿'], officialDomains: ['official.test'] }],
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Response(pdf, { status: 200, headers: { 'content-type': 'application/pdf' } });
    },
  });

  assert.equal(fetchCalls, 1);
  assert.equal(records.length, 1);
  assert.equal(records[0].parser, 'bound_official_pdf');
  assert.match(records[0].sourceDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(records[0].sourceAcquisition.strategy, 'bound_official_pdf');
  assert.match(records[0].pageText, /最低保证利率为年利率2%/u);
  assert.match(records[0].pageText, /结算利率按月公布/u);
});

test('official crawl falls back to catalog discovery when the bound PDF identity does not match', async () => {
  const productName = '测试安心医疗保险';
  const pdfFor = (content) => {
    const utf16 = Buffer.alloc(2 + content.length * 2);
    utf16.writeUInt16BE(0xfeff, 0);
    Array.from(content).forEach((character, index) => utf16.writeUInt16BE(character.charCodeAt(0), 2 + index * 2));
    return Buffer.from(`%PDF-1.4\n/ActualText <${utf16.toString('hex')}>\n%%EOF`, 'latin1');
  };
  const boundUrl = 'https://official.test/bound.pdf';
  const discoveredUrl = 'https://official.test/discovered.pdf';
  const wrongPdf = pdfFor('其他产品保险条款 第五条 保险责任 被保险人身故，按约定给付。');
  const correctPdf = pdfFor(`${productName} 第五条 保险责任 住院医疗费用扣除1万元免赔额后按80%报销。`);
  let boundFetches = 0;
  let catalogFetches = 0;
  const records = await crawlOfficialKnowledge({
    policy: {
      company: '测试人寿',
      name: productName,
      boundSources: [{ url: boundUrl, official: true }],
    },
    officialDomainProfiles: [{ aliases: ['测试人寿'], officialDomains: ['official.test'] }],
    fetchImpl: async (url) => {
      if (String(url) === boundUrl) {
        boundFetches += 1;
        return new Response(wrongPdf, { status: 200, headers: { 'content-type': 'application/pdf' } });
      }
      if (String(url) === discoveredUrl) {
        catalogFetches += 1;
        return new Response(correctPdf, { status: 200, headers: { 'content-type': 'application/pdf' } });
      }
      catalogFetches += 1;
      return new Response(`<a href="${discoveredUrl}">${productName}保险条款</a>`, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    },
  });

  assert.equal(boundFetches, 1);
  assert.ok(catalogFetches > 0);
  assert.equal(records[0].parser, 'generic_official_links');
  assert.equal(records[0].url, discoveredUrl);
  assert.match(records[0].pageText, /1万元免赔额/u);
});

test('AES encrypted PDF extraction falls back from a dependency failure to bundled Python', async () => {
  const encryptedPdf = buildEncryptedPdfFixture();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'policy-pdf-python-'));
  const dependencyFailurePython = path.join(tempDir, 'python3');
  await fs.writeFile(
    dependencyFailurePython,
    '#!/bin/sh\necho "DependencyError: cryptography>=3.1 is required for AES algorithm" >&2\nexit 1\n',
    { mode: 0o755 },
  );
  try {
    const result = await extractPdfTextWithPython(encryptedPdf, {
      pythonCandidates: [dependencyFailurePython, bundledPython],
    });
    assert.equal(result.status, 'extracted');
    assert.deepEqual(result.attempts.map((attempt) => attempt.code), ['dependency_missing', 'extracted']);
    assert.match(result.text, /测试万能保险/u);
    assert.match(result.text, /最低保证利率为年利率2%/u);
    const records = await crawlOfficialKnowledge({
      policy: {
        company: '测试人寿',
        name: '测试万能保险',
        boundSources: [{ url: 'https://official.test/encrypted.pdf', official: true }],
      },
      officialDomainProfiles: [{ aliases: ['测试人寿'], officialDomains: ['official.test'] }],
      fetchImpl: async () => new Response(encryptedPdf, {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      }),
      pdfPythonCandidates: [dependencyFailurePython, bundledPython],
    });
    assert.equal(records.length, 1);
    assert.equal(records[0].sourceAcquisition.strategy, 'bound_official_pdf');
    assert.match(records[0].pageText, /最低保证利率为年利率2%/u);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('bound encrypted PDF reports extraction unavailable instead of silently returning no source', async () => {
  const encryptedPdf = buildEncryptedPdfFixture();
  await assert.rejects(
    crawlOfficialKnowledge({
      policy: {
        company: '测试人寿',
        name: '测试万能保险',
        boundSources: [{ url: 'https://official.test/encrypted.pdf', official: true }],
      },
      officialDomainProfiles: [{ aliases: ['测试人寿'], officialDomains: ['official.test'] }],
      fetchImpl: async () => new Response(encryptedPdf, {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      }),
      pdfPythonCandidates: ['/definitely/missing/policy-pdf-python'],
    }),
    (error) => {
      assert.equal(error.code, 'POLICY_OFFICIAL_PDF_EXTRACTION_UNAVAILABLE');
      assert.equal(error.extractionCode, 'pdf_extraction_unavailable');
      return true;
    },
  );
});

test('normalizeKnowledgeProductType keeps specific disease insurance separate from critical illness', () => {
  assert.equal(
    normalizeKnowledgeProductType({
      company: '新华保险',
      productName: '新华人寿保险股份有限公司i她A款女性特定疾病保险',
      productType: '健康险',
    }),
    '疾病保险',
  );
});

test('normalizeKnowledgeProductType converts generic aliases and invalid placeholders', () => {
  assert.equal(
    normalizeKnowledgeProductType({
      company: '中国人寿',
      productName: '国寿鑫益年年年金保险（分红型）',
      productType: '',
    }),
    '年金险',
  );
  assert.equal(
    normalizeKnowledgeProductType({
      company: '中国人寿',
      productName: '国寿鑫安盈两全保险',
      productType: 'P2',
    }),
    '两全保险',
  );
  assert.equal(
    normalizeKnowledgeProductType({
      company: '新华保险',
      productName: '新华人寿保险股份有限公司康护无忧护理保险',
      productType: '健康险',
    }),
    '护理险',
  );
  assert.equal(
    normalizeKnowledgeProductType({
      company: '新华保险',
      productName: '新华人寿保险股份有限公司附加安欣意外伤害医疗保险',
      productType: '健康险',
    }),
    '医疗险',
  );
});

test('sqlite state store normalizes loaded knowledge record product types', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'policy-knowledge-normalization-'));
  const dbPath = path.join(dir, 'policy-ocr.sqlite');
  const store = await createSqliteStateStore({ dbPath });

  await store.persist({
    users: [],
    sessions: [],
    adminSessions: [],
    smsCodes: [],
    policies: [],
    pendingScans: [],
    sourceRecords: [],
    knowledgeRecords: [
      {
        id: 379,
        company: '新华保险',
        productName: '新华人寿保险股份有限公司i他男性特定疾病保险',
        productType: '健康险',
        title: '保险条款',
        pageText: '保险责任包括特定重大疾病保险金、特定轻症疾病保险金、特定重度恶性肿瘤保险金。',
        url: 'https://www.newchinalife.com/products/ithe-male-ci',
      },
    ],
    insuranceIndicatorRecords: [],
    optionalResponsibilityRecords: [],
    officialDomainProfiles: [],
    familyProfiles: [],
    familyMembers: [],
    familyReportShares: [],
    nextId: 380,
  });

  const loaded = await store.load();
  assert.equal(loaded.knowledgeRecords[0]?.productType, '重疾险');

  store.close();
});
