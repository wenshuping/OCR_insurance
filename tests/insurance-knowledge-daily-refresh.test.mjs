import assert from 'node:assert/strict';
import test from 'node:test';
import {
  discoverCompanyJobs,
  parseSyncPlan,
  selectCompanyJobs,
} from '../scripts/refresh-insurance-knowledge-daily.mjs';

test('daily insurance refresh discovers all canonical crawler adapters', () => {
  const jobs = discoverCompanyJobs();
  const keys = new Set(jobs.map((job) => job.key));

  assert.ok(jobs.length >= 60);
  assert.ok(keys.has('china-life'));
  assert.ok(keys.has('new-china'));
  assert.ok(keys.has('ping-an'));
  assert.ok(keys.has('sunshine-life'));
  assert.equal(keys.has('ping-an-cloak'), false);
  assert.equal(keys.has('ping-an-missing'), false);
  assert.equal(jobs.find((job) => job.key === 'ping-an').scriptFile, 'crawl-ping-an-cloak-knowledge.mjs');
  assert.equal(jobs.find((job) => job.key === 'cathay-life').scriptFile, 'crawl-cathay-life-cloak-knowledge.mjs');
  assert.equal(jobs.find((job) => job.key === 'china-post-life').timeoutMs, 5 * 60 * 1000);
});

test('daily rotation covers every discovered company without duplicate jobs', () => {
  const jobs = discoverCompanyJobs();
  const batchSize = 10;
  const batchCount = Math.ceil(jobs.length / batchSize);
  const covered = new Set();

  for (let day = 0; day < batchCount; day += 1) {
    const date = new Date(Date.UTC(2026, 0, 1 + day)).toISOString().slice(0, 10);
    const selection = selectCompanyJobs(jobs, { batchSize, date });
    assert.equal(selection.mode, 'rotation');
    assert.ok(selection.jobs.length <= batchSize);
    for (const job of selection.jobs) {
      assert.equal(covered.has(job.key), false);
      covered.add(job.key);
    }
  }

  assert.equal(covered.size, jobs.length);
});

test('explicit company selection preserves request order and rejects unknown keys', () => {
  const jobs = discoverCompanyJobs();
  const selection = selectCompanyJobs(jobs, { companies: 'taikang,china-life' });

  assert.deepEqual(selection.jobs.map((job) => job.key), ['taikang', 'china-life']);
  assert.throws(
    () => selectCompanyJobs(jobs, { companies: 'not-an-insurer' }),
    /unknown company key: not-an-insurer/u,
  );
});

test('Feishu dry-run plan ignores warnings after the JSON payload', () => {
  const output = [
    '[feishu] dry-run 未写入飞书，待同步计划如下：',
    '{"count":2,"duplicateKeyCount":0}',
    '(node:123) ExperimentalWarning: SQLite is an experimental feature',
  ].join('\n');

  assert.deepEqual(parseSyncPlan(output), { count: 2, duplicateKeyCount: 0 });
});
