import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  createProductResponsibilityPipelineQueue,
  routeProductResponsibilitySkills,
} from '../server/product-responsibility-pipeline-queue.service.mjs';

test('product responsibility pipeline routes every product family to domain skills before parsing', () => {
  const cases = [
    ['测试两全保险（万能型）', 'universal_life', ['ocr-insurance-universal-account-responsibility', 'ocr-insurance-endowment-responsibility']],
    ['测试养老年金保险', 'annuity', ['ocr-insurance-annuity-responsibility']],
    ['测试重大疾病保险', 'critical_illness', ['ocr-insurance-critical-illness-responsibility']],
    ['测试医疗保险', 'medical', ['ocr-insurance-medical-health-responsibility']],
    ['测试意外伤害保险', 'accident', ['ocr-insurance-accident-responsibility']],
    ['测试长期护理保险', 'long_term_care', ['ocr-insurance-long-term-care-responsibility']],
    ['测试定期寿险', 'term_life', ['ocr-insurance-term-life-responsibility']],
    ['测试增额终身寿险', 'incremental_whole_life', ['ocr-insurance-incremental-whole-life-responsibility']],
  ];

  for (const [productName, expectedCategory, expectedSkills] of cases) {
    const routing = routeProductResponsibilitySkills({ productName });
    assert.equal(routing.productCategory, expectedCategory, productName);
    assert.deepEqual(routing.domainSkills, expectedSkills, productName);
  }
});

test('product responsibility pipeline queue deduplicates repeated clicks and publishes once', async () => {
  const db = new DatabaseSync(':memory:');
  let calls = 0;
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  const queue = createProductResponsibilityPipelineQueue({
    db,
    runJob: async () => {
      calls += 1;
      await wait;
      return { status: 'published', artifactPath: '/tmp/artifact.json' };
    },
  });
  const input = {
    company: '新华保险',
    productName: '学生平安意外伤害保险',
    sourceUrl: 'https://example.test/terms.pdf',
  };

  const first = await queue.enqueue(input);
  const second = await queue.enqueue(input);

  assert.equal(first.id, second.id);
  assert.equal(first.payload.productCategory, 'accident');
  assert.deepEqual(first.payload.domainSkills, ['ocr-insurance-accident-responsibility']);
  assert.equal(calls, 1);
  assert.equal(second.status, 'processing');
  release();
  await queue.drain();
  const completed = queue.getByProductKey(first.productKey);
  assert.equal(completed.status, 'published');
  assert.equal(completed.artifactPath, '/tmp/artifact.json');
  assert.equal(completed.attempts, 1);
  db.close();
});

test('product responsibility pipeline queue preserves manual review state', async () => {
  const db = new DatabaseSync(':memory:');
  const queue = createProductResponsibilityPipelineQueue({
    db,
    runJob: async () => ({ status: 'manual_review', lastError: '公式证据未通过校验' }),
  });

  const job = await queue.enqueue({ company: '测试保险', productName: '测试产品' });
  await queue.drain();
  const completed = queue.getByProductKey(job.productKey);
  assert.equal(completed.status, 'manual_review');
  assert.match(completed.lastError, /公式证据/u);
  db.close();
});

test('product responsibility pipeline retries an exhausted failed job after a pipeline upgrade', async () => {
  const db = new DatabaseSync(':memory:');
  const queue = createProductResponsibilityPipelineQueue({
    db,
    runJob: async () => ({ status: 'published', artifactPath: '/tmp/upgraded-artifact.json' }),
  });
  db.prepare(`
    INSERT INTO product_responsibility_pipeline_jobs
      (product_key, company, product_name, status, attempts, last_error, payload, created_at, updated_at)
    VALUES (?, ?, ?, 'failed', 3, 'python not found', '{}', ?, ?)
  `).run(
    'company_product:测试保险:测试医疗保险',
    '测试保险',
    '测试医疗保险',
    '2026-08-01T00:00:00.000Z',
    '2026-08-01T00:00:00.000Z',
  );

  await queue.enqueue({ company: '测试保险', productName: '测试医疗保险' });
  await queue.drain();

  const completed = queue.getByProductKey('company_product:测试保险:测试医疗保险');
  assert.equal(completed.status, 'published');
  assert.equal(completed.attempts, 1);
  assert.equal(completed.payload.pipelineVersion, 'v3-independent-domain-skill-workers');
  db.close();
});

test('product responsibility pipeline republishes a completed job after a pipeline upgrade', async () => {
  const db = new DatabaseSync(':memory:');
  const queue = createProductResponsibilityPipelineQueue({
    db,
    runJob: async () => ({ status: 'published', artifactPath: '/tmp/v3-artifact.json' }),
  });
  db.prepare(`
    INSERT INTO product_responsibility_pipeline_jobs
      (product_key, company, product_name, status, attempts, artifact_path, payload, created_at, updated_at)
    VALUES (?, ?, ?, 'published', 1, '/tmp/v2-artifact.json', ?, ?, ?)
  `).run(
    'company_product:测试保险:测试两全保险（万能型）',
    '测试保险',
    '测试两全保险（万能型）',
    JSON.stringify({ pipelineVersion: 'v2-domain-skills-runtime' }),
    '2026-08-06T00:00:00.000Z',
    '2026-08-06T00:00:00.000Z',
  );

  await queue.enqueue({ company: '测试保险', productName: '测试两全保险（万能型）' });
  await queue.drain();

  const completed = queue.getByProductKey('company_product:测试保险:测试两全保险（万能型）');
  assert.equal(completed.status, 'published');
  assert.equal(completed.attempts, 1);
  assert.equal(completed.artifactPath, '/tmp/v3-artifact.json');
  assert.equal(completed.payload.pipelineVersion, 'v3-independent-domain-skill-workers');
  db.close();
});

test('product responsibility pipeline queue prepares the customer summary after publishing', async () => {
  const db = new DatabaseSync(':memory:');
  const prepared = [];
  const queue = createProductResponsibilityPipelineQueue({
    db,
    runJob: async () => ({ status: 'published', artifactPath: '/tmp/artifact.json' }),
    afterPublished: async (job) => {
      prepared.push(`${job.company}:${job.productName}`);
    },
  });

  const job = await queue.enqueue({ company: '测试保险', productName: '自动摘要产品' });
  await queue.drain();

  assert.deepEqual(prepared, ['测试保险:自动摘要产品']);
  assert.equal(queue.getByProductKey(job.productKey).status, 'published');
  db.close();
});
