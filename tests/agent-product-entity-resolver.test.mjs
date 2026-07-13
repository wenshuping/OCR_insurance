import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { createAgentProductEntityResolver } from '../server/agent-product-entity-resolver.service.mjs';

function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE knowledge_records (company TEXT, product_name TEXT, payload TEXT NOT NULL);
    CREATE TABLE insurance_products (
      canonical_product_id TEXT,
      company TEXT,
      official_name TEXT,
      status TEXT,
      payload TEXT NOT NULL DEFAULT '{}'
    );
  `);
  return db;
}

function addPublicKnowledge(db, company, productName) {
  db.prepare('INSERT INTO knowledge_records (company, product_name, payload) VALUES (?, ?, ?)').run(
    company,
    productName,
    JSON.stringify({ sourceKind: 'insurer_official' }),
  );
}

function addProduct(db, {
  canonicalProductId = '',
  company,
  officialName,
  status = 'active',
  payload = {},
}) {
  db.prepare(`
    INSERT INTO insurance_products (canonical_product_id, company, official_name, status, payload)
    VALUES (?, ?, ?, ?, ?)
  `).run(canonicalProductId, company, officialName, status, JSON.stringify(payload));
}

const XINHUA_PROFILES = [{
  company: '新华保险',
  aliases: ['新华人寿保险股份有限公司', '新华人寿'],
  companyAliases: ['新华保险'],
}];

test('resolves an insurer-scoped short product mention to the active canonical product', () => {
  const db = makeDb();
  try {
    const officialName = '新华人寿保险股份有限公司康健无忧两全保险';
    addPublicKnowledge(db, '新华保险', officialName);
    addProduct(db, {
      canonicalProductId: 'product-kjwy',
      company: '新华保险',
      officialName,
    });

    const resolver = createAgentProductEntityResolver({ db, officialDomainProfiles: XINHUA_PROFILES });
    assert.deepEqual(resolver.resolve({
      mentions: [
        { type: 'insurer', rawText: '新华人寿保险股份有限公司' },
        { type: 'product', rawText: '康健无忧两全保险' },
      ],
    }), {
      status: 'resolved',
      entity: {
        canonicalProductId: 'product-kjwy',
        company: '新华保险',
        officialName,
        matchType: 'company_scoped_normalized',
        confidence: 1,
      },
      candidates: [],
    });
  } finally {
    db.close();
  }
});

test('returns ambiguity instead of choosing a shared short name across companies', () => {
  const db = makeDb();
  try {
    addProduct(db, {
      canonicalProductId: 'product-a',
      company: '甲保险',
      officialName: '甲人寿保险股份有限公司康健无忧两全保险',
    });
    addProduct(db, {
      canonicalProductId: 'product-b',
      company: '乙保险',
      officialName: '乙人寿保险股份有限公司康健无忧两全保险',
    });

    const result = createAgentProductEntityResolver({ db }).resolve({
      mentions: [{ type: 'product', rawText: '康健无忧两全保险' }],
    });

    assert.equal(result.status, 'ambiguous');
    assert.equal(result.entity, null);
    assert.equal(result.candidates.length, 2);
    assert.deepEqual(new Set(result.candidates.map((candidate) => candidate.canonicalProductId)), new Set(['product-a', 'product-b']));
  } finally {
    db.close();
  }
});

test('orders equal-confidence candidates by deterministic match precedence', () => {
  const db = makeDb();
  try {
    const productText = 'abcdefghijklmnopqrstuvwxy';
    addProduct(db, {
      canonicalProductId: 'product-normalized',
      company: '丙保险',
      officialName: `丙人寿保险股份有限公司${productText}`,
    });
    addProduct(db, {
      canonicalProductId: 'product-alias',
      company: '乙保险',
      officialName: '乙人寿保险股份有限公司另一款长期保险',
      payload: { aliases: [productText], aliasReviewStatus: 'approved' },
    });
    addProduct(db, {
      canonicalProductId: 'product-fuzzy',
      company: '丁保险',
      officialName: 'nopqrstuvwxyabcdefghijklm',
    });
    addProduct(db, {
      canonicalProductId: 'product-exact',
      company: '甲保险',
      officialName: productText,
    });

    const result = createAgentProductEntityResolver({ db }).resolve({
      mentions: [{ type: 'product', rawText: productText }],
    });

    assert.equal(result.status, 'ambiguous');
    assert.deepEqual(result.candidates.map((candidate) => candidate.matchType), [
      'exact_official_name',
      'approved_alias',
      'company_scoped_normalized',
      'unique_high_confidence',
    ]);
    assert.equal(result.candidates.every((candidate) => candidate.confidence === 1), true);
  } finally {
    db.close();
  }
});

test('reuses only the bounded fields of an already confirmed active product', () => {
  const db = makeDb();
  try {
    const resolver = createAgentProductEntityResolver({ db });
    assert.deepEqual(resolver.resolve({
      activeProduct: {
        canonicalProductId: ' product-current ',
        company: ' 新华保险 ',
        officialName: ' 康健无忧两全保险 ',
        matchType: 'exact_official_name',
        confidence: 1,
        secret: 'must-not-leak',
      },
    }), {
      status: 'resolved',
      entity: {
        canonicalProductId: 'product-current',
        company: '新华保险',
        officialName: '康健无忧两全保险',
        matchType: 'exact_official_name',
        confidence: 1,
      },
      candidates: [],
    });
    assert.deepEqual(resolver.resolve(), { status: 'missing', entity: null, candidates: [] });
  } finally {
    db.close();
  }
});

test('reuses an active product only when an explicit insurer resolves to the same company', () => {
  const db = makeDb();
  try {
    addProduct(db, {
      canonicalProductId: 'product-current',
      company: '新华保险',
      officialName: '新华人寿保险股份有限公司康健无忧两全保险',
    });
    addProduct(db, {
      canonicalProductId: 'product-other',
      company: '甲保险',
      officialName: '甲人寿保险股份有限公司其他保险',
    });
    const resolver = createAgentProductEntityResolver({ db, officialDomainProfiles: XINHUA_PROFILES });
    const activeProduct = {
      canonicalProductId: 'product-current',
      company: '新华保险',
      officialName: '新华人寿保险股份有限公司康健无忧两全保险',
      matchType: 'company_scoped_normalized',
      confidence: 1,
    };

    assert.equal(resolver.resolve({
      mentions: [{ type: 'insurer', rawText: '新华人寿保险股份有限公司' }],
      activeProduct,
    }).status, 'resolved');
    assert.deepEqual(resolver.resolve({
      mentions: [{ type: 'insurer', rawText: '甲保险' }],
      activeProduct,
    }), { status: 'not_found', entity: null, candidates: [] });
    assert.deepEqual(resolver.resolve({
      mentions: [{ type: 'insurer', rawText: '不存在保险公司' }],
      activeProduct,
    }), { status: 'not_found', entity: null, candidates: [] });
  } finally {
    db.close();
  }
});

test('returns not_found for unresolved explicit insurers and unmatched products', () => {
  const db = makeDb();
  try {
    addProduct(db, {
      canonicalProductId: 'product-kjwy',
      company: '新华保险',
      officialName: '新华人寿保险股份有限公司康健无忧两全保险',
    });
    const resolver = createAgentProductEntityResolver({ db, officialDomainProfiles: XINHUA_PROFILES });

    assert.deepEqual(resolver.resolve({ mentions: [
      { type: 'insurer', rawText: '不存在保险公司' },
      { type: 'product', rawText: '康健无忧两全保险' },
    ] }), { status: 'not_found', entity: null, candidates: [] });
    assert.deepEqual(resolver.resolve({
      mentions: [{ type: 'product', rawText: '完全不存在的产品' }],
    }), { status: 'not_found', entity: null, candidates: [] });
  } finally {
    db.close();
  }
});

test('does not invent a canonical id when only public knowledge has the product', () => {
  const db = makeDb();
  try {
    addPublicKnowledge(db, '新华保险', '新华人寿保险股份有限公司康健无忧两全保险');
    const result = createAgentProductEntityResolver({ db }).resolve({
      mentions: [{ type: 'product', rawText: '康健无忧两全保险' }],
    });

    assert.equal(result.status, 'resolved');
    assert.equal(result.entity.canonicalProductId, '');
    assert.equal(result.entity.officialName, '新华人寿保险股份有限公司康健无忧两全保险');
  } finally {
    db.close();
  }
});

test('accepts only explicitly approved product aliases', () => {
  const db = makeDb();
  try {
    addProduct(db, {
      canonicalProductId: 'product-approved',
      company: '新华保险',
      officialName: '新华人寿保险股份有限公司康健无忧两全保险',
      payload: { aliases: ['康无忧'], aliasReviewStatus: 'approved' },
    });
    addProduct(db, {
      canonicalProductId: 'product-pending',
      company: '新华保险',
      officialName: '新华人寿保险股份有限公司医药无忧医疗保险',
      payload: { aliases: ['医无忧'], aliasReviewStatus: 'pending' },
    });
    const resolver = createAgentProductEntityResolver({ db });

    const approved = resolver.resolve({ mentions: [{ type: 'product', rawText: '康无忧' }] });
    assert.equal(approved.status, 'resolved');
    assert.equal(approved.entity.canonicalProductId, 'product-approved');
    assert.equal(approved.entity.matchType, 'approved_alias');
    assert.equal(approved.entity.confidence, 1);
    const pending = resolver.resolve({ mentions: [{ type: 'product', rawText: '医无忧' }] });
    assert.notEqual(pending.status, 'resolved');
    assert.equal(pending.candidates.some((candidate) => candidate.matchType === 'approved_alias'), false);
  } finally {
    db.close();
  }
});

test('does not resolve disabled or non-public catalog rows', () => {
  const db = makeDb();
  try {
    addProduct(db, {
      canonicalProductId: 'product-disabled',
      company: '新华保险',
      officialName: '新华人寿保险股份有限公司停用保险',
      status: 'disabled',
      payload: { aliases: ['停用险'], aliasReviewStatus: 'approved' },
    });
    addPublicKnowledge(db, '新华保险', '外部参考保险');
    db.prepare('UPDATE knowledge_records SET payload = ? WHERE product_name = ?').run(
      JSON.stringify({ sourceKind: 'open_web_reference', materialType: 'external_reference' }),
      '外部参考保险',
    );
    const resolver = createAgentProductEntityResolver({ db });

    assert.deepEqual(resolver.resolve({ mentions: [{ type: 'product', rawText: '停用险' }] }), {
      status: 'not_found', entity: null, candidates: [],
    });
    assert.deepEqual(resolver.resolve({ mentions: [{ type: 'product', rawText: '外部参考保险' }] }), {
      status: 'not_found', entity: null, candidates: [],
    });
  } finally {
    db.close();
  }
});

test('requires a database', () => {
  assert.throws(() => createAgentProductEntityResolver(), TypeError);
});
