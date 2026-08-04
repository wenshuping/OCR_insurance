import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  createProductResponsibilityPipelineQueue,
} from '../server/product-responsibility-pipeline-queue.service.mjs';

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
