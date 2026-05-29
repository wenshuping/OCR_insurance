import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findKnowledgeRecordsForPolicy } from './policy-knowledge.service.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const runtimeDir = path.join(projectRoot, '.runtime');

const DEFAULT_SEARCH_FIELDS = ['产品名称', '标题', '摘要', '保险责任正文'];
const DEFAULT_SELECT_FIELDS = [
  '本地ID',
  '保险公司',
  '产品名称',
  '产品分类',
  '销售状态',
  '资料类型',
  '标题',
  '官方域名',
  '来源链接',
  '摘要',
  '保险责任正文',
  '质量状态',
  '质量问题',
  '解析器',
  '更新时间',
];

function trim(value) {
  return String(value || '').trim();
}

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name] || 0);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizeComparableFact(value) {
  return trim(value)
    .replace(/[（(][^）)]*[）)]/gu, '')
    .replace(/\s+/gu, '')
    .replace(/[：:]/gu, '')
    .replace(/[^\p{Script=Han}\p{Letter}\p{Number}]/gu, '')
    .trim();
}

function isFeishuLookupEnabled() {
  return !['0', 'false', 'off', 'no'].includes(trim(process.env.FEISHU_KNOWLEDGE_LOOKUP_ENABLED).toLowerCase());
}

function parseCliJson(stdout) {
  const text = trim(stdout);
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error(`飞书 CLI 没有返回 JSON：${text.slice(0, 300)}`);
  return JSON.parse(text.slice(start, end + 1));
}

function runLark(args, { timeoutMs = 12_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('lark-cli', args, {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`飞书知识库查询超时：lark-cli ${args.slice(0, 2).join(' ')}`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        try {
          resolve(parseCliJson(stdout));
        } catch (error) {
          reject(error);
        }
        return;
      }
      reject(new Error(trim([stdout, stderr].filter(Boolean).join('\n')) || `lark-cli exited ${code}`));
    });
  });
}

async function readJsonFile(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

async function defaultConfigPaths() {
  const names = await fs.readdir(runtimeDir).catch(() => []);
  return names
    .filter((name) => /^feishu-knowledge.*\.json$/u.test(name))
    .map((name) => path.join(runtimeDir, name))
    .sort((left, right) => {
      const leftGeneric = path.basename(left) === 'feishu-knowledge.json' ? 1 : 0;
      const rightGeneric = path.basename(right) === 'feishu-knowledge.json' ? 1 : 0;
      return leftGeneric - rightGeneric || left.localeCompare(right);
    });
}

async function loadFeishuKnowledgeConfigs() {
  const configuredPaths = trim(process.env.FEISHU_KNOWLEDGE_CONFIG_PATHS || process.env.FEISHU_KNOWLEDGE_CONFIG_PATH)
    .split(',')
    .map((item) => trim(item))
    .filter(Boolean)
    .map((item) => path.resolve(projectRoot, item));
  const configPaths = configuredPaths.length ? configuredPaths : await defaultConfigPaths();
  const seen = new Set();
  const configs = [];
  for (const configPath of configPaths) {
    try {
      const saved = await readJsonFile(configPath);
      const baseToken = trim(saved.baseToken || process.env.FEISHU_KNOWLEDGE_BASE_TOKEN);
      const tableId = trim(saved.tableId);
      if (!baseToken || !tableId) continue;
      const dedupeKey = `${baseToken}:${tableId}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      configs.push({
        configPath,
        identity: trim(saved.identity || process.env.FEISHU_KNOWLEDGE_AS) || 'user',
        baseToken,
        tableId,
        tableName: trim(saved.tableName),
      });
    } catch {
      continue;
    }
  }
  return configs;
}

function tableMatchesPolicy(config, policy) {
  const tableName = normalizeComparableFact(config.tableName);
  if (!tableName || tableName === '保险资料') return false;
  const target = normalizeComparableFact(`${policy.company || ''}${policy.name || policy.productName || ''}`);
  return Boolean(target && (target.includes(tableName) || tableName.includes(normalizeComparableFact(policy.company))));
}

function selectConfigsForPolicy(configs, policy) {
  const matched = configs.filter((config) => tableMatchesPolicy(config, policy));
  if (matched.length) return matched;
  if (trim(process.env.FEISHU_KNOWLEDGE_SEARCH_ALL_ON_MISS || 'true').toLowerCase() === 'false') {
    return configs.filter((config) => normalizeComparableFact(config.tableName) === '保险资料');
  }
  const maxTables = numberFromEnv('FEISHU_KNOWLEDGE_MAX_TABLES', 40);
  return configs.slice(0, maxTables);
}

function rowValue(fields, row, fieldName) {
  const index = fields.indexOf(fieldName);
  if (index < 0) return '';
  return trim(Array.isArray(row) ? row[index] : row?.fields?.[fieldName]);
}

function recordsFromPayload(payload, config) {
  const fields = Array.isArray(payload?.data?.fields) ? payload.data.fields.map(trim) : [];
  const rows = Array.isArray(payload?.data?.data) ? payload.data.data : [];
  return rows
    .map((row) => ({
      id: rowValue(fields, row, '本地ID'),
      company: rowValue(fields, row, '保险公司'),
      productName: rowValue(fields, row, '产品名称'),
      productType: rowValue(fields, row, '产品分类'),
      salesStatus: rowValue(fields, row, '销售状态'),
      materialType: rowValue(fields, row, '资料类型'),
      title: rowValue(fields, row, '标题'),
      officialDomain: rowValue(fields, row, '官方域名'),
      url: rowValue(fields, row, '来源链接'),
      snippet: rowValue(fields, row, '摘要'),
      pageText: rowValue(fields, row, '保险责任正文'),
      qualityStatus: rowValue(fields, row, '质量状态'),
      qualityReason: rowValue(fields, row, '质量问题'),
      parser: rowValue(fields, row, '解析器'),
      updatedAt: rowValue(fields, row, '更新时间'),
      official: true,
      evidenceLabel: '飞书知识库官方资料',
      evidenceLevel: 'insurer_official',
      feishuTableId: config.tableId,
      feishuTableName: config.tableName,
    }))
    .filter((record) => record.company && record.productName && record.url && record.pageText);
}

async function searchConfig(config, policy, { runLarkCommand = runLark, limit, timeoutMs } = {}) {
  const keyword = trim(policy.name || policy.productName);
  if (!keyword) return [];
  const payload = await runLarkCommand(
    [
      'base',
      '+record-search',
      '--as',
      config.identity,
      '--base-token',
      config.baseToken,
      '--table-id',
      config.tableId,
      '--json',
      JSON.stringify({
        keyword,
        search_fields: DEFAULT_SEARCH_FIELDS,
        select_fields: DEFAULT_SELECT_FIELDS,
        limit,
      }),
      '--format',
      'json',
    ],
    { timeoutMs },
  );
  return recordsFromPayload(payload, config);
}

export async function searchFeishuKnowledgeRecords({
  policy = {},
  officialDomainProfiles = [],
  maxResults = 5,
  runLarkCommand,
  timeoutMs = numberFromEnv('FEISHU_KNOWLEDGE_LOOKUP_TIMEOUT_MS', 12_000),
} = {}) {
  if (!isFeishuLookupEnabled()) return [];
  const normalizedPolicy = {
    company: trim(policy.company),
    name: trim(policy.name || policy.productName),
  };
  if (!normalizedPolicy.company || !normalizedPolicy.name) return [];
  const configs = selectConfigsForPolicy(await loadFeishuKnowledgeConfigs(), normalizedPolicy);
  if (!configs.length) return [];
  const limit = numberFromEnv('FEISHU_KNOWLEDGE_SEARCH_LIMIT', Math.max(maxResults * 3, 10));
  const candidates = [];
  for (const config of configs) {
    const records = await searchConfig(config, normalizedPolicy, { runLarkCommand, limit, timeoutMs });
    candidates.push(...records);
    const matched = findKnowledgeRecordsForPolicy({
      policy: normalizedPolicy,
      records: candidates,
      officialDomainProfiles,
      maxResults,
    });
    if (matched.length >= maxResults) return matched;
  }
  return findKnowledgeRecordsForPolicy({
    policy: normalizedPolicy,
    records: candidates,
    officialDomainProfiles,
    maxResults,
  });
}
