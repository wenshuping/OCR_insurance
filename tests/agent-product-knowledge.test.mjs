import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { createAgentProductKnowledgeService } from '../server/agent-product-knowledge.service.mjs';
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
    )
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
  assert.match(result.answer, /身故保险金/u);
  assert.match(result.answer, /满期保险金/u);
  assert.deepEqual(result.sources, [{
    verified: true,
    title: '兼顾身故与满期责任',
    url: 'https://www.newchinalife.com/product/terms',
    provenance: 'verified_product_summary',
  }]);
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

test('non-array query aspects fail closed while empty and responsibility arrays remain supported', async (t) => {
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

  for (const queryAspects of [[], ['main_responsibilities']]) {
    const result = await service(db).search({
      scope: 'public_read_only', product, queryAspects,
    });
    assert.match(result.answer, /身故保险金/u);
    assert.equal(result.sources.length, 1);
  }
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

  const first = await dynamic.search({ scope: 'public_read_only', product });
  assert.equal(first.sources.length, 1);
  domains = ['new.example'];
  const second = await dynamic.search({ scope: 'public_read_only', product });
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
