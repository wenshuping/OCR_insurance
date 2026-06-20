import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const DEFAULT_REPORT_DIR = path.join(projectRoot, 'reports', 'deepanalyze-indicator-review');
const DEFAULT_CHAT_URL = 'http://localhost:8000/v1/chat/completions';
const DEFAULT_MODEL = 'DeepAnalyze-8B';
const DEFAULT_MAX_TOKENS = 2000;
const DECISIONS = ['可入库候选', '需人工补责任名', '疑似误识别/暂不入库', '仍未识别'];

function trim(value) {
  return String(value ?? '').trim();
}

function readArg(name, fallback = '') {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function toPositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function toNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeBaseUrl(value) {
  return trim(value).replace(/\/+$/u, '');
}

export function resolveChatCompletionUrl({ chatUrl = '', baseUrl = '' } = {}) {
  if (trim(chatUrl)) return trim(chatUrl);
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) return DEFAULT_CHAT_URL;
  if (normalized.endsWith('/chat/completions')) return normalized;
  if (normalized.endsWith('/v1')) return `${normalized}/chat/completions`;
  return `${normalized}/v1/chat/completions`;
}

export async function findLatestReviewPackage(reportDir = DEFAULT_REPORT_DIR) {
  const entries = await fs.readdir(reportDir, { withFileTypes: true });
  const jsonlFiles = entries
    .filter((entry) => entry.isFile() && /^deepanalyze-indicator-review-(?!run-).+\.jsonl$/u.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (!jsonlFiles.length) {
    throw new Error(`No DeepAnalyze review JSONL files found in ${reportDir}`);
  }
  const jsonlPath = path.join(reportDir, jsonlFiles.at(-1));
  const promptPath = jsonlPath.replace(/\.jsonl$/u, '-prompt.md');
  return { jsonlPath, promptPath };
}

export async function readJsonlSamples(jsonlPath, limit = 0, offset = 0) {
  const text = await fs.readFile(jsonlPath, 'utf8');
  const samples = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid JSONL at ${jsonlPath}:${index + 1}: ${error.message}`);
      }
    });
  const start = Math.max(0, offset);
  return limit > 0 ? samples.slice(start, start + limit) : samples.slice(start);
}

export function splitBatches(items, batchSize) {
  const size = Math.max(1, batchSize);
  const batches = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

export function buildBatchPrompt({ basePrompt = '', samples = [], batchIndex = 0, batchCount = 1 } = {}) {
  const jsonl = samples.map((sample) => JSON.stringify(sample)).join('\n');
  return `${trim(basePrompt)}

## 本轮待复核 JSONL

这是第 ${batchIndex + 1}/${batchCount} 批。下面直接给出本批样本，请只审计这些样本，不要尝试读取文件系统，不要写数据库。

\`\`\`jsonl
${jsonl}
\`\`\`
`;
}

export function createChatPayload({
  model = DEFAULT_MODEL,
  prompt = '',
  temperature = 0.1,
  maxTokens = DEFAULT_MAX_TOKENS,
} = {}) {
  return {
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature,
    max_tokens: maxTokens,
  };
}

function stripMarkdownFence(value) {
  const text = trim(value);
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/u);
  return fenced ? fenced[1].trim() : text;
}

export function parseJsonFromContent(content = '') {
  const unfenced = stripMarkdownFence(content);
  try {
    return JSON.parse(unfenced);
  } catch {
    const start = unfenced.indexOf('{');
    const end = unfenced.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('Model response did not contain a JSON object');
    return JSON.parse(unfenced.slice(start, end + 1));
  }
}

export function validateBatchParsedResult(parsed = {}, reviewIds = []) {
  if (!Array.isArray(parsed?.items)) {
    throw new Error('Model response JSON missing items array');
  }
  const expected = reviewIds.map(trim).filter(Boolean);
  const actual = parsed.items.map((item) => trim(item?.reviewId)).filter(Boolean);
  const unexpected = actual.filter((reviewId) => !expected.includes(reviewId));
  const missing = expected.filter((reviewId) => !actual.includes(reviewId));
  if (unexpected.length || missing.length) {
    throw new Error(
      `Model response reviewId mismatch: missing ${missing.join(', ') || 'none'}; unexpected ${unexpected.join(', ') || 'none'}`,
    );
  }
  return parsed;
}

function countByDecision(items = []) {
  const counts = Object.fromEntries(DECISIONS.map((decision) => [decision, 0]));
  for (const item of items) {
    if (Object.hasOwn(counts, item?.decision)) counts[item.decision] += 1;
  }
  return counts;
}

export function aggregateBatchResults(batchResults = []) {
  const items = [];
  const failures = [];
  for (const result of batchResults) {
    if (result.parsed?.items && Array.isArray(result.parsed.items)) {
      items.push(...result.parsed.items);
    } else {
      failures.push({
        batchIndex: result.batchIndex,
        reviewIds: result.reviewIds,
        error: result.error || 'Missing parsed items',
      });
    }
  }
  return {
    summary: {
      totalReviewed: items.length,
      ...countByDecision(items),
      failedBatches: failures.length,
    },
    items,
    failures,
  };
}

async function postChatCompletion({
  fetchImpl = globalThis.fetch,
  chatUrl,
  apiKey = '',
  payload,
  timeoutMs = 120000,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is not available in this Node runtime');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (trim(apiKey)) headers.Authorization = `Bearer ${apiKey}`;
    const response = await fetchImpl(chatUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`DeepAnalyze request failed: HTTP ${response.status} ${text.slice(0, 500)}`);
    }
    return JSON.parse(text);
  } finally {
    clearTimeout(timeout);
  }
}

function responseContent(responseJson = {}) {
  return trim(responseJson.choices?.[0]?.message?.content || responseJson.choices?.[0]?.delta?.content || '');
}

function formatError(error) {
  const message = trim(error?.message) || String(error);
  const cause = trim(error?.cause?.message);
  const code = trim(error?.cause?.code);
  const details = [cause, code].filter((part) => part && !message.includes(part));
  return details.length ? `${message}: ${details.join(' ')}` : message;
}

function emitProgress(onProgress, event) {
  if (typeof onProgress === 'function') onProgress(event);
}

function formatDurationMs(durationMs) {
  if (!Number.isFinite(durationMs)) return '';
  if (durationMs >= 1000) return `${(durationMs / 1000).toFixed(1)}s`;
  return `${Math.max(0, Math.round(durationMs))}ms`;
}

function formatBatchPosition(event = {}) {
  const current = Number.isInteger(event.batchIndex) ? event.batchIndex + 1 : '?';
  const total = Number.isInteger(event.batchCount) ? event.batchCount : '?';
  return `${current}/${total}`;
}

export function renderProgressLine(event = {}) {
  if (event.phase === 'start') {
    return `[DeepAnalyze] start: ${event.sampleCount} samples, ${event.batchCount} batches, batchSize=${event.batchSize}, maxTokens=${event.maxTokens}`;
  }
  if (event.phase === 'batch_start') {
    const reviewIds = Array.isArray(event.reviewIds) ? event.reviewIds.join(', ') : '';
    return `[DeepAnalyze] batch ${formatBatchPosition(event)} start: ${reviewIds}`;
  }
  if (event.phase === 'batch_done') {
    const duration = formatDurationMs(event.durationMs);
    const suffix = event.dryRun ? ' dryRun' : ` items=${event.itemsCount ?? 0}`;
    return `[DeepAnalyze] batch ${formatBatchPosition(event)} done${duration ? ` in ${duration}` : ''}:${suffix}`;
  }
  if (event.phase === 'batch_failed') {
    const duration = formatDurationMs(event.durationMs);
    return `[DeepAnalyze] batch ${formatBatchPosition(event)} failed${duration ? ` in ${duration}` : ''}: ${event.error}`;
  }
  if (event.phase === 'complete') {
    return `[DeepAnalyze] complete: attempted=${event.attemptedBatches}, completed=${event.completedBatches}, failed=${event.failedBatches}`;
  }
  return '';
}

function outputPaths(outputDir, stamp) {
  const base = path.join(outputDir, `deepanalyze-indicator-review-run-${stamp}`);
  return {
    rawPath: `${base}-raw.jsonl`,
    resultPath: `${base}-result.json`,
    summaryPath: `${base}-summary.json`,
  };
}

export async function runDeepAnalyzeIndicatorReview({
  jsonlPath = '',
  promptPath = '',
  outputDir = DEFAULT_REPORT_DIR,
  chatUrl = DEFAULT_CHAT_URL,
  apiKey = '',
  model = DEFAULT_MODEL,
  limit = 0,
  offset = 0,
  batchSize = 5,
  temperature = 0.1,
  maxTokens = DEFAULT_MAX_TOKENS,
  timeoutMs = 120000,
  dryRun = false,
  now = new Date(),
  fetchImpl = globalThis.fetch,
  onProgress = null,
} = {}) {
  let resolvedJsonlPath = jsonlPath;
  let resolvedPromptPath = promptPath;
  if (!resolvedJsonlPath || !resolvedPromptPath) {
    const latest = await findLatestReviewPackage(outputDir);
    resolvedJsonlPath ||= latest.jsonlPath;
    resolvedPromptPath ||= latest.promptPath;
  }

  const [basePrompt, samples] = await Promise.all([
    fs.readFile(resolvedPromptPath, 'utf8'),
    readJsonlSamples(resolvedJsonlPath, limit, offset),
  ]);
  const batches = splitBatches(samples, batchSize);
  const stamp = now.toISOString().replace(/[:.]/gu, '-');
  await fs.mkdir(outputDir, { recursive: true });
  const paths = outputPaths(outputDir, stamp);

  emitProgress(onProgress, {
    phase: 'start',
    sampleCount: samples.length,
    batchCount: batches.length,
    batchSize,
    maxTokens,
    chatUrl,
    model,
    dryRun,
  });

  const batchResults = [];
  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index];
    const prompt = buildBatchPrompt({
      basePrompt,
      samples: batch,
      batchIndex: index,
      batchCount: batches.length,
    });
    const payload = createChatPayload({ model, prompt, temperature, maxTokens });
    const reviewIds = batch.map((sample) => sample.reviewId);
    const startedAt = Date.now();
    emitProgress(onProgress, {
      phase: 'batch_start',
      batchIndex: index,
      batchCount: batches.length,
      reviewIds,
    });
    if (dryRun) {
      batchResults.push({ batchIndex: index, reviewIds, request: payload, dryRun: true });
      emitProgress(onProgress, {
        phase: 'batch_done',
        batchIndex: index,
        batchCount: batches.length,
        reviewIds,
        durationMs: Date.now() - startedAt,
        dryRun: true,
      });
      continue;
    }
    try {
      const responseJson = await postChatCompletion({
        fetchImpl,
        chatUrl,
        apiKey,
        payload,
        timeoutMs,
      });
      const content = responseContent(responseJson);
      const parsed = validateBatchParsedResult(parseJsonFromContent(content), reviewIds);
      batchResults.push({
        batchIndex: index,
        reviewIds,
        content,
        parsed,
      });
      emitProgress(onProgress, {
        phase: 'batch_done',
        batchIndex: index,
        batchCount: batches.length,
        reviewIds,
        durationMs: Date.now() - startedAt,
        itemsCount: Array.isArray(parsed?.items) ? parsed.items.length : 0,
      });
    } catch (error) {
      const formattedError = formatError(error);
      batchResults.push({
        batchIndex: index,
        reviewIds,
        error: formattedError,
      });
      emitProgress(onProgress, {
        phase: 'batch_failed',
        batchIndex: index,
        batchCount: batches.length,
        reviewIds,
        durationMs: Date.now() - startedAt,
        error: formattedError,
      });
      break;
    }
  }

  const aggregate = dryRun ? null : aggregateBatchResults(batchResults);
  const rawJsonl = batchResults.map((result) => JSON.stringify(result)).join('\n');
  await fs.writeFile(paths.rawPath, rawJsonl ? `${rawJsonl}\n` : '', 'utf8');
  if (aggregate) await fs.writeFile(paths.resultPath, `${JSON.stringify(aggregate, null, 2)}\n`, 'utf8');
  const summary = {
    dryRun,
    writeTarget: 'reports_only',
    chatUrl,
    model,
    jsonlPath: resolvedJsonlPath,
    promptPath: resolvedPromptPath,
    sampleCount: samples.length,
    offset,
    batchSize,
    attemptedBatches: batchResults.length,
    completedBatches: batchResults.filter((result) => result.parsed || result.dryRun).length,
    failedBatches: batchResults.filter((result) => result.error).length,
    resultSummary: aggregate?.summary || null,
    files: {
      ...paths,
      resultPath: aggregate ? paths.resultPath : '',
    },
  };
  await fs.writeFile(paths.summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  emitProgress(onProgress, {
    phase: 'complete',
    attemptedBatches: summary.attemptedBatches,
    completedBatches: summary.completedBatches,
    failedBatches: summary.failedBatches,
  });
  return summary;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const outputDir = path.resolve(readArg('output-dir', DEFAULT_REPORT_DIR));
  const chatUrl = resolveChatCompletionUrl({
    chatUrl: readArg('chat-url', process.env.DEEPANALYZE_CHAT_URL || ''),
    baseUrl: readArg('base-url', process.env.DEEPANALYZE_BASE_URL || ''),
  });
  const result = await runDeepAnalyzeIndicatorReview({
    jsonlPath: readArg('input', ''),
    promptPath: readArg('prompt', ''),
    outputDir,
    chatUrl,
    apiKey: process.env.DEEPANALYZE_API_KEY || '',
    model: readArg('model', process.env.DEEPANALYZE_MODEL || DEFAULT_MODEL),
    limit: toPositiveInteger(readArg('limit', '0'), 0),
    offset: toPositiveInteger(readArg('offset', '0'), 0),
    batchSize: toPositiveInteger(readArg('batch-size', '5'), 5),
    temperature: toNumber(readArg('temperature', '0.1'), 0.1),
    maxTokens: toPositiveInteger(readArg('max-tokens', String(DEFAULT_MAX_TOKENS)), DEFAULT_MAX_TOKENS),
    timeoutMs: toPositiveInteger(readArg('timeout-ms', '120000'), 120000),
    dryRun: hasFlag('dry-run'),
    onProgress: (event) => {
      const line = renderProgressLine(event);
      if (line) console.error(line);
    },
  });
  console.log(JSON.stringify(result, null, 2));
}
