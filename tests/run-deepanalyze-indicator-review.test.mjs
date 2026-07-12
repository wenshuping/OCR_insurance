import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  aggregateBatchResults,
  createChatPayload,
  findLatestReviewPackage,
  parseJsonFromContent,
  readJsonlSamples,
  renderProgressLine,
  resolveChatCompletionUrl,
  runDeepAnalyzeIndicatorReview,
  splitBatches,
  validateBatchParsedResult,
} from '../scripts/run-deepanalyze-indicator-review.mjs';

function makeTempReport() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepanalyze-review-run-'));
  const jsonlPath = path.join(dir, 'deepanalyze-indicator-review-2026-06-18T10-00-00-000Z.jsonl');
  const promptPath = path.join(dir, 'deepanalyze-indicator-review-2026-06-18T10-00-00-000Z-prompt.md');
  const samples = [
    {
      reviewId: 'pending_optional:one',
      reviewType: 'pending_optional_responsibility',
      company: '测试人寿',
      productName: '测试医疗保险',
      liability: '住院医疗保险金',
      excerpt: '住院医疗保险金 按实际合理医疗费用扣除已获补偿和免赔额后乘以约定给付比例给付。',
    },
    {
      reviewId: 'no_indicator:two',
      reviewType: 'no_indicator_product',
      company: '测试人寿',
      productName: '测试津贴保险',
      liability: '',
      excerpt: '住院津贴保险金=实际住院日数×住院日额津贴。',
    },
  ];
  fs.writeFileSync(jsonlPath, `${samples.map((sample) => JSON.stringify(sample)).join('\n')}\n`);
  fs.writeFileSync(promptPath, '只输出 JSON，不要写数据库。');
  return { dir, jsonlPath, promptPath };
}

test('resolves DeepAnalyze chat completion URLs', () => {
  assert.equal(resolveChatCompletionUrl({}), 'http://localhost:8000/v1/chat/completions');
  assert.equal(
    resolveChatCompletionUrl({ baseUrl: 'http://localhost:8000' }),
    'http://localhost:8000/v1/chat/completions',
  );
  assert.equal(
    resolveChatCompletionUrl({ baseUrl: 'http://localhost:8200/v1/' }),
    'http://localhost:8200/v1/chat/completions',
  );
  assert.equal(
    resolveChatCompletionUrl({ chatUrl: 'https://example.test/app/v1/chat/completions' }),
    'https://example.test/app/v1/chat/completions',
  );
});

test('splits batches and parses fenced JSON responses', () => {
  assert.deepEqual(splitBatches([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(parseJsonFromContent('```json\n{"ok":true}\n```'), { ok: true });
});

test('rejects model output with mismatched review ids', () => {
  assert.throws(
    () => validateBatchParsedResult({ items: [{ reviewId: 'wrong' }] }, ['expected']),
    /reviewId mismatch/u,
  );
});

test('uses a context-safe default completion budget for local DeepAnalyze', () => {
  const payload = createChatPayload({ prompt: '审计一条样本' });
  assert.equal(payload.max_tokens, 2000);
});

test('finds latest sample package without selecting runner raw logs', async () => {
  const { dir, jsonlPath, promptPath } = makeTempReport();
  try {
    await fsp.writeFile(path.join(dir, 'deepanalyze-indicator-review-run-2026-06-18T12-00-00-000Z-raw.jsonl'), '{}\n');
    const latest = await findLatestReviewPackage(dir);
    assert.equal(latest.jsonlPath, jsonlPath);
    assert.equal(latest.promptPath, promptPath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reads samples after offset before applying limit', async () => {
  const { dir, jsonlPath } = makeTempReport();
  try {
    const samples = await readJsonlSamples(jsonlPath, 1, 1);
    assert.equal(samples.length, 1);
    assert.equal(samples[0].reviewId, 'no_indicator:two');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runs review through a mocked DeepAnalyze-compatible chat endpoint', async () => {
  const { dir, jsonlPath, promptPath } = makeTempReport();
  const calls = [];
  const progressEvents = [];
  try {
    const fetchImpl = async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body), authorization: init.headers.Authorization });
      const request = JSON.parse(init.body);
      const hasFirstSample = request.messages[0].content.includes('pending_optional:one');
      const item = hasFirstSample
        ? {
          reviewId: 'pending_optional:one',
          decision: '可入库候选',
          reason: '医疗报销公式明确',
          candidates: [{
            coverageType: '医疗保障',
            liability: '住院医疗保险金',
            value: null,
            unit: '公式',
            basis: '实际合理医疗费用、已获补偿、免赔额、约定给付比例',
            formulaText: '住院医疗保险金 = (实际合理医疗费用 - 已获补偿 - 免赔额) × 约定给付比例',
            sourceQuote: '按实际合理医疗费用扣除已获补偿和免赔额后乘以约定给付比例给付',
            confidence: 0.88,
            ruleGap: '',
          }],
          rejectReason: '',
        }
        : {
          reviewId: 'no_indicator:two',
          decision: '可入库候选',
          reason: '津贴公式明确',
          candidates: [{
            coverageType: '医疗保障',
            liability: '住院津贴保险金',
            value: null,
            unit: '公式',
            basis: '实际住院日数、住院日额津贴',
            formulaText: '住院津贴保险金 = 实际住院日数 × 住院日额津贴',
            sourceQuote: '住院津贴保险金=实际住院日数×住院日额津贴',
            confidence: 0.9,
            ruleGap: '',
          }],
          rejectReason: '',
        };
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            choices: [{
              message: {
                content: JSON.stringify({
                  summary: {
                    totalReviewed: 1,
                    可入库候选: 1,
                    需人工补责任名: 0,
                    '疑似误识别/暂不入库': 0,
                    仍未识别: 0,
                  },
                  items: [item],
                }),
              },
            }],
          });
        },
      };
    };

    const summary = await runDeepAnalyzeIndicatorReview({
      jsonlPath,
      promptPath,
      outputDir: dir,
      chatUrl: 'http://deepanalyze.test/v1/chat/completions',
      apiKey: 'secret',
      batchSize: 1,
      now: new Date('2026-06-18T11:00:00.000Z'),
      fetchImpl,
      onProgress: (event) => progressEvents.push(event),
    });

    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, 'http://deepanalyze.test/v1/chat/completions');
    assert.equal(calls[0].authorization, 'Bearer secret');
    assert.equal(summary.completedBatches, 2);
    assert.equal(summary.failedBatches, 0);
    assert.equal(summary.resultSummary.totalReviewed, 2);
    assert.equal(summary.resultSummary.可入库候选, 2);
    assert.deepEqual(progressEvents.map((event) => event.phase), [
      'start',
      'batch_start',
      'batch_done',
      'batch_start',
      'batch_done',
      'complete',
    ]);
    assert.match(renderProgressLine(progressEvents[1]), /\[DeepAnalyze\] batch 1\/2 start/u);

    const result = JSON.parse(await fsp.readFile(summary.files.resultPath, 'utf8'));
    assert.deepEqual(result.items.map((item) => item.reviewId), ['pending_optional:one', 'no_indicator:two']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('dry run writes request payloads without calling the endpoint', async () => {
  const { dir, jsonlPath, promptPath } = makeTempReport();
  try {
    const summary = await runDeepAnalyzeIndicatorReview({
      jsonlPath,
      promptPath,
      outputDir: dir,
      batchSize: 2,
      dryRun: true,
      now: new Date('2026-06-18T12:00:00.000Z'),
      fetchImpl: async () => {
        throw new Error('fetch should not be called');
      },
    });

    assert.equal(summary.dryRun, true);
    assert.equal(summary.completedBatches, 1);
    assert.equal(summary.files.resultPath, '');
    const raw = await fsp.readFile(summary.files.rawPath, 'utf8');
    assert.match(raw, /"dryRun":true/u);
    assert.match(raw, /pending_optional:one/u);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('records a failed batch when the model mutates the review id', async () => {
  const { dir, jsonlPath, promptPath } = makeTempReport();
  try {
    const summary = await runDeepAnalyzeIndicatorReview({
      jsonlPath,
      promptPath,
      outputDir: dir,
      batchSize: 1,
      limit: 1,
      now: new Date('2026-06-18T12:30:00.000Z'),
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            choices: [{
              message: {
                content: JSON.stringify({
                  items: [{ reviewId: 'pending_optional:typo', decision: '可入库候选' }],
                }),
              },
            }],
          });
        },
      }),
    });

    assert.equal(summary.completedBatches, 0);
    assert.equal(summary.failedBatches, 1);
    assert.equal(summary.resultSummary.failedBatches, 1);
    const raw = await fsp.readFile(summary.files.rawPath, 'utf8');
    assert.match(raw, /reviewId mismatch/u);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('aggregates failed batches separately from parsed model items', () => {
  const aggregate = aggregateBatchResults([
    {
      batchIndex: 0,
      reviewIds: ['ok'],
      parsed: { items: [{ reviewId: 'ok', decision: '仍未识别' }] },
    },
    {
      batchIndex: 1,
      reviewIds: ['failed'],
      error: 'connection refused',
    },
  ]);
  assert.equal(aggregate.summary.totalReviewed, 1);
  assert.equal(aggregate.summary.仍未识别, 1);
  assert.equal(aggregate.summary.failedBatches, 1);
  assert.equal(aggregate.failures[0].reviewIds[0], 'failed');
});
