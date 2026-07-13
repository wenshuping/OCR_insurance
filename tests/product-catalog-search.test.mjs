import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { listProductCatalogCompanies, searchProductCatalog } from '../server/product-catalog-search.mjs';

function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE knowledge_records (company TEXT, product_name TEXT, payload TEXT NOT NULL);
    CREATE TABLE insurance_indicator_records (company TEXT, product_name TEXT);
    CREATE TABLE product_responsibility_cards (company TEXT, product_name TEXT);
    CREATE TABLE optional_responsibility_records (company TEXT, product_name TEXT);
    CREATE TABLE product_customer_responsibility_summaries (company TEXT, product_name TEXT, status TEXT);
    CREATE TABLE insurance_products (company TEXT, official_name TEXT, status TEXT);
    CREATE TABLE product_documents (source_authority TEXT, review_status TEXT, payload TEXT NOT NULL);
  `);
  return db;
}

test('shared product catalog keeps internal candidates in admin and approved candidates in public search', () => {
  const db = makeDb();
  try {
    const insertKnowledge = db.prepare('INSERT INTO knowledge_records (company, product_name, payload) VALUES (?, ?, ?)');
    insertKnowledge.run('新华保险', '新华人寿保险股份有限公司医药无忧医疗保险', JSON.stringify({ sourceKind: 'insurer_official' }));
    insertKnowledge.run('新华保险', '新华人寿保险股份有限公司医药安欣（易核版）医疗保险', JSON.stringify({ sourceKind: 'insurer_official' }));
    insertKnowledge.run('新华保险', '新华人寿保险股份有限公司医药安欣（易核版）医疗保险', JSON.stringify({ sourceKind: 'insurer_official' }));
    insertKnowledge.run('新华保险', '外部医药安欣线索', JSON.stringify({ sourceKind: 'open_web_reference', materialType: 'external_reference' }));
    insertKnowledge.run('新华保险', '未发布医药安欣内部资料', JSON.stringify({ sourceKind: 'admin_product_material', reviewStatus: 'pending', globalSearchable: false }));
    db.prepare('INSERT INTO insurance_indicator_records (company, product_name) VALUES (?, ?)').run('新华保险', '待审核医药安欣指标产品');
    db.prepare('INSERT INTO product_customer_responsibility_summaries (company, product_name, status) VALUES (?, ?, ?)').run('新华保险', '新华安欣客户责任产品', 'ready');
    db.prepare('INSERT INTO insurance_products (company, official_name, status) VALUES (?, ?, ?)').run('新华保险', '新华安欣正式登记产品', 'active');
    db.prepare('INSERT INTO insurance_products (company, official_name, status) VALUES (?, ?, ?)').run('新华保险', '新华安欣草稿产品', 'draft');
    db.prepare('INSERT INTO product_documents (source_authority, review_status, payload) VALUES (?, ?, ?)').run(
      'company_material',
      'published',
      JSON.stringify({ company: '新华保险', productNames: ['医药安欣（易核版）医疗保险', '附加长期护理保险'] }),
    );
    db.prepare('INSERT INTO product_documents (source_authority, review_status, payload) VALUES (?, ?, ?)').run(
      'company_material',
      'quarantined',
      JSON.stringify({ company: '新华保险', productNames: ['医药安欣内部待审核产品'] }),
    );

    const admin = searchProductCatalog({ db, company: '新华保险', query: '医药安欣', visibility: 'admin' });
    const publicResults = searchProductCatalog({ db, company: '新华保险', query: '医药安欣', visibility: 'public' });

    assert.equal(admin.some((item) => item.productName === '待审核医药安欣指标产品'), true);
    assert.equal(admin.some((item) => item.productName === '外部医药安欣线索'), true);
    assert.equal(publicResults.some((item) => item.productName.includes('医药无忧')), true);
    assert.equal(publicResults.some((item) => item.productName === '新华安欣客户责任产品'), true);
    assert.equal(publicResults.some((item) => item.productName === '新华安欣正式登记产品'), true);
    assert.equal(publicResults.some((item) => item.productName === '待审核医药安欣指标产品'), false);
    assert.equal(publicResults.some((item) => item.productName === '外部医药安欣线索'), false);
    assert.equal(publicResults.some((item) => item.productName === '未发布医药安欣内部资料'), false);
    assert.equal(publicResults.some((item) => item.productName === '新华安欣草稿产品'), false);
    assert.equal(publicResults.some((item) => item.productName === '医药安欣（易核版）医疗保险'), false);
    assert.equal(publicResults.some((item) => item.productName === '医药安欣内部待审核产品'), false);
    assert.equal(admin.some((item) => item.productName === '医药安欣内部待审核产品'), true);
    assert.equal(publicResults.filter((item) => item.productName.includes('医药安欣（易核版）医疗保险')).length, 1);
    assert.equal(publicResults.some((item) => item.productName === '新华人寿保险股份有限公司医药安欣（易核版）医疗保险'), true);
    assert.deepEqual(listProductCatalogCompanies({ db, visibility: 'public' }).map((item) => item.company), ['新华保险']);
  } finally {
    db.close();
  }
});
