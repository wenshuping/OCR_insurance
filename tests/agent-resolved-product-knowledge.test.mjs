import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { createAgentProductKnowledgeService } from '../server/agent-resolved-product-knowledge.service.mjs';
import { mergeOfficialDomainProfiles } from '../server/c-policy-analysis.service.mjs';

function database() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE product_customer_responsibility_summaries (
      id TEXT PRIMARY KEY,
      company TEXT,
      product_name TEXT,
      status TEXT,
      headline TEXT,
      summary_json TEXT,
      source_urls_json TEXT,
      updated_at TEXT
    );
    CREATE TABLE knowledge_records (
      id INTEGER PRIMARY KEY, company TEXT, product_name TEXT, url TEXT, payload TEXT
    );
  `);
  return db;
}

function insert(db, overrides = {}) {
  const row = {
    id: 'summary-1',
    company: '新华人寿保险股份有限公司',
    productName: '康健无忧两全保险',
    status: 'ready',
    headline: '兼顾身故与满期责任',
    summaryJson: JSON.stringify({
      headline: '兼顾身故与满期责任',
      mainResponsibilities: [
        { title: '身故保险金', plainText: '符合约定时按条款给付身故保险金。' },
        { title: '满期保险金', plainText: '保险期间届满且生存时按条款给付。' },
      ],
      sourceUrls: ['https://www.newchinalife.com/product/terms'],
    }),
    sourceUrlsJson: JSON.stringify(['https://www.newchinalife.com/product/terms']),
    updatedAt: '2026-07-14T00:00:00.000Z',
    ...overrides,
  };
  db.prepare(`
    INSERT INTO product_customer_responsibility_summaries (
      id, company, product_name, status, headline, summary_json, source_urls_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(row.id, row.company, row.productName, row.status, row.headline,
    row.summaryJson, row.sourceUrlsJson, row.updatedAt);
}

function service(db) {
  return createAgentProductKnowledgeService({
    db,
    officialDomainProfiles: mergeOfficialDomainProfiles(),
  });
}

const product = {
  canonicalProductId: 'product-1',
  company: '新华人寿保险股份有限公司',
  officialName: '康健无忧两全保险',
};

test('ready exact product summary returns bounded responsibilities with official evidence', async (t) => {
  const db = database();
  t.after(() => db.close());
  insert(db);

  const result = await service(db).search({
    question: '主要保什么', scope: 'public_read_only', product,
    queryAspects: ['main_responsibilities'],
  });

  assert.match(result.answer, /兼顾身故与满期责任/u);
  assert.match(result.answer, /### 责任明细（2项）/u);
  assert.match(result.answer, /1\. \*\*身故保险金\*\*/u);
  assert.match(result.answer, /身故保险金/u);
  assert.match(result.answer, /满期保险金/u);
  assert.deepEqual(result.sources, [{
    verified: true,
    title: '兼顾身故与满期责任',
    url: 'https://www.newchinalife.com/product/terms',
    provenance: 'verified_product_summary',
  }]);
});

test('resolved product responsibility uses the complete responsibility assistant output contract', async (t) => {
  const db = database();
  t.after(() => db.close());
  insert(db, {
    summaryJson: JSON.stringify({
      headline: '完整责任摘要',
      contentBlocks: [
        { blockKey: 'productPurpose', title: '产品主要做什么', content: '提供身故保障。', enabled: true, order: 1 },
        { blockKey: 'responsibilities', title: '主要保险责任', content: '核心为身故保险金。', enabled: true, order: 2 },
      ],
      mainResponsibilities: [{
        title: '身故保险金', plainText: '被保险人身故时按约定给付。',
        triggerCondition: '被保险人身故', howItPays: '给付金额 = 基本保险金额',
        calculationStatus: 'claim_contingent', sourceRefs: ['src_1'],
        requiredPolicyFields: ['基本保险金额'],
      }],
      notices: ['具体金额以合同为准。'],
      requiredPolicyFields: ['基本保险金额'],
      sourceUrls: ['https://www.newchinalife.com/product/terms'],
    }),
  });

  const result = await service(db).search({
    question: '保险责任', scope: 'public_read_only', product,
    queryAspects: ['main_responsibilities'],
  });

  assert.match(result.answer, /### 产品主要做什么\n提供身故保障/u);
  assert.match(result.answer, /### 主要保险责任\n核心为身故保险金/u);
  assert.match(result.answer, /### 责任明细（1项）/u);
  assert.match(result.answer, /1\. \*\*身故保险金\*\*/u);
  assert.match(result.answer, /触发条件：被保险人身故/u);
  assert.match(result.answer, /calculationStatus: claim_contingent/u);
  assert.match(result.answer, /来源：src_1/u);
  assert.match(result.answer, /计算所需保单信息：基本保险金额/u);
  assert.match(result.answer, /### 注意事项/u);
});

test('a main policy summary expands an explicitly referenced rider from official terms', async (t) => {
  const db = database();
  t.after(() => db.close());
  insert(db, {
    company: '新华保险',
    productName: '新华人寿保险股份有限公司康健无忧两全保险',
    headline: '满期生存和身故保障的两全保险',
    summaryJson: JSON.stringify({
      headline: '满期生存和身故保障的两全保险',
      mainResponsibilities: [{
        title: '满期生存保险金',
        plainText: '满期时给付主险与附加康健无忧重大疾病保险合同实际交纳的保险费之和。',
      }],
      notices: [
        '附加康健无忧重大疾病保险需另行核对。',
        '本保险的路由分类曾被标记为其他险种。',
        '某项责任来源未提及，视为无。',
      ],
      sourceUrls: ['https://static-cdn.newchinalife.com/main.pdf'],
    }),
    sourceUrlsJson: JSON.stringify(['https://static-cdn.newchinalife.com/main.pdf']),
  });
  db.prepare('INSERT INTO knowledge_records VALUES (1, ?, ?, ?, ?)').run(
    '新华保险',
    '新华人寿保险股份有限公司附加康健无忧重大疾病保险',
    'https://static-cdn.newchinalife.com/rider.pdf',
    JSON.stringify({
      evidenceLevel: 'insurer_official',
      title: '附加康健无忧重大疾病保险条款',
      pageText: '轻症疾病保险金：等待期后按基本保险金额的20%给付。重大疾病保险金：符合约定时按基本保险金额给付。',
    }),
  );
  const result = await createAgentProductKnowledgeService({
    db,
    officialDomainProfiles: mergeOfficialDomainProfiles(),
  }).search({
    question: '完整保险责任',
    scope: 'public_read_only',
    product: {
      canonicalProductId: 'product-1',
      company: '新华保险',
      officialName: '新华人寿保险股份有限公司康健无忧两全保险',
    },
    queryAspects: ['main_responsibilities'],
  });

  assert.match(result.answer, /关联附加险责任（不属于两全主险责任）/u);
  assert.match(result.answer, /轻症疾病保险金/u);
  assert.match(result.answer, /重大疾病保险金/u);
  assert.match(result.answer, /20%/u);
  assert.doesNotMatch(result.answer, /路由分类|来源未提及，视为无|需另行核对/u);
  assert.equal(result.sources.some((source) => source.url.endsWith('/rider.pdf')), true);
});

test('a ready official record may still have no factual answer text', async (t) => {
  const db = database();
  t.after(() => db.close());
  insert(db, {
    headline: '',
    summaryJson: JSON.stringify({
      headline: '', mainResponsibilities: [],
      sourceUrls: ['https://www.newchinalife.com/product/terms'],
    }),
  });
  const result = await service(db).search({
    scope: 'public_read_only', product, queryAspects: ['main_responsibilities'],
  });
  assert.equal(result.answer, '');
  assert.equal(result.sources.length, 1);
});

test('unsupported product aspects never reuse the general responsibility headline as evidence', async (t) => {
  const db = database();
  t.after(() => db.close());
  insert(db);

  for (const queryAspects of [['waiting_period'], ['exclusions'], ['renewal'], ['reimbursement_ratio']]) {
    const result = await service(db).search({
      question: '这个产品的具体条款是什么',
      scope: 'public_read_only',
      product,
      queryAspects,
    });
    assert.deepEqual(result, { answer: '', sources: [] }, queryAspects[0]);
  }
});

test('sales guidance may reuse verified responsibilities without inventing unsupported product facts', async (t) => {
  const db = database();
  t.after(() => db.close());
  insert(db);

  const result = await service(db).search({
    question: '客户更适合哪个', scope: 'public_read_only', product,
    queryAspects: ['sales_guidance'],
  });

  assert.match(result.answer, /身故保险金/u);
  assert.match(result.answer, /满期保险金/u);
  assert.equal(result.sources.length, 1);
  assert.doesNotMatch(result.answer, /等待期|续保/u);
});

test('non-array and unspecified query aspects fail closed while responsibility arrays remain supported', async (t) => {
  const db = database();
  t.after(() => db.close());
  insert(db);

  for (const queryAspects of [
    'main_responsibilities',
    { 0: 'main_responsibilities', length: 1 },
    { aspect: 'main_responsibilities' },
    null,
  ]) {
    assert.deepEqual(await service(db).search({
      scope: 'public_read_only', product, queryAspects,
    }), { answer: '', sources: [] });
  }

  assert.deepEqual(await service(db).search({
    scope: 'public_read_only', product, queryAspects: [],
  }), { answer: '', sources: [] });

  const result = await service(db).search({
    scope: 'public_read_only', product, queryAspects: ['main_responsibilities'],
  });
  assert.match(result.answer, /身故保险金/u);
  assert.equal(result.sources.length, 1);
});

test('non-official URLs never become verified sources', async (t) => {
  const db = database();
  t.after(() => db.close());
  insert(db, {
    sourceUrlsJson: JSON.stringify(['https://example.com/copied-terms']),
    summaryJson: JSON.stringify({
      headline: '外部摘要',
      mainResponsibilities: [{ title: '责任', plainText: '内容' }],
      sourceUrls: ['https://example.com/copied-terms'],
    }),
  });

  const result = await service(db).search({
    question: '主要保什么', scope: 'public_read_only', product,
    queryAspects: ['main_responsibilities'],
  });

  assert.deepEqual(result.sources, []);
});

test('official domain profiles are reloaded for every search', async (t) => {
  const db = database();
  t.after(() => db.close());
  insert(db, { sourceUrlsJson: JSON.stringify(['https://old.example/terms']) });
  let domains = ['old.example'];
  let loads = 0;
  const dynamic = createAgentProductKnowledgeService({
    db,
    async loadOfficialDomainProfiles() {
      loads += 1;
      return [{ company: product.company, aliases: [product.company], officialDomains: domains }];
    },
  });

  const first = await dynamic.search({
    scope: 'public_read_only', product, queryAspects: ['main_responsibilities'],
  });
  assert.equal(first.sources.length, 1);
  domains = ['new.example'];
  const second = await dynamic.search({
    scope: 'public_read_only', product, queryAspects: ['main_responsibilities'],
  });
  assert.deepEqual(second.sources, []);
  assert.equal(loads, 2);
});

test('non-ready status and exact product mismatch return no result', async (t) => {
  const db = database();
  t.after(() => db.close());
  insert(db, { status: 'pending' });

  for (const queriedProduct of [product, { ...product, officialName: '另一产品' }]) {
    const result = await service(db).search({
      question: '主要保什么', scope: 'public_read_only', product: queriedProduct,
      queryAspects: ['main_responsibilities'],
    });
    assert.deepEqual(result, { answer: '', sources: [] });
  }
});

test('missing columns, malformed or invalid schemas, and oversized JSON fail closed', async (t) => {
  const malformed = database();
  t.after(() => malformed.close());
  insert(malformed, { summaryJson: '{not-json' });
  assert.deepEqual(await service(malformed).search({
    question: '主要保什么', scope: 'public_read_only', product,
    queryAspects: ['main_responsibilities'],
  }), { answer: '', sources: [] });

  const invalidSchema = database();
  t.after(() => invalidSchema.close());
  insert(invalidSchema, {
    summaryJson: JSON.stringify({ headline: '摘要', mainResponsibilities: '不是数组' }),
  });
  assert.deepEqual(await service(invalidSchema).search({
    question: '主要保什么', scope: 'public_read_only', product,
    queryAspects: ['main_responsibilities'],
  }), { answer: '', sources: [] });

  const oversized = database();
  t.after(() => oversized.close());
  insert(oversized, { summaryJson: JSON.stringify({ headline: 'x'.repeat(300_000) }) });
  assert.deepEqual(await service(oversized).search({
    question: '主要保什么', scope: 'public_read_only', product,
    queryAspects: ['main_responsibilities'],
  }), { answer: '', sources: [] });

  const incomplete = new DatabaseSync(':memory:');
  t.after(() => incomplete.close());
  incomplete.exec('CREATE TABLE product_customer_responsibility_summaries (company TEXT, product_name TEXT)');
  assert.deepEqual(await service(incomplete).search({
    question: '主要保什么', scope: 'public_read_only', product,
    queryAspects: ['main_responsibilities'],
  }), { answer: '', sources: [] });
});
