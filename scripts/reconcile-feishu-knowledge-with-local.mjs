import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const runtimeDir = path.join(projectRoot, '.runtime');
const statePath = path.resolve(process.env.POLICY_OCR_APP_STATE_PATH || path.join(runtimeDir, 'state.json'));

const FIELD_NAMES = [
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

const CONFIG_BY_COMPANY = new Map([
  ['百年人寿', 'feishu-knowledge-aeon-life.json'],
  ['财信人寿', 'feishu-knowledge-caixin-life.json'],
  ['大都会人寿', 'feishu-knowledge-metlife.json'],
  ['工银安盛', 'feishu-knowledge-icbc-axa.json'],
  ['光大永明人寿', 'feishu-knowledge-sunlife-everbright.json'],
  ['国富人寿', 'feishu-knowledge-guofu-life.json'],
  ['国华人寿', 'feishu-knowledge-guohua-life.json'],
  ['合众人寿', 'feishu-knowledge-union-life.json'],
  ['建信人寿', 'feishu-knowledge-ccb-life.json'],
  ['交银人寿', 'feishu-knowledge-bocomm-life.json'],
  ['利安人寿', 'feishu-knowledge-lian-life.json'],
  ['陆家嘴国泰人寿', 'feishu-knowledge-cathay-life.json'],
  ['民生人寿', 'feishu-knowledge-minsheng-life.json'],
  ['农银人寿', 'feishu-knowledge-abc-life.json'],
  ['人保寿险', 'feishu-knowledge-picc-life.json'],
  ['太保寿险', 'feishu-knowledge-cpic-life.json'],
  ['泰康人寿', 'feishu-knowledge-taikang.json'],
  ['新华保险', 'feishu-knowledge.json'],
  ['信泰人寿', 'feishu-knowledge-xintai.json'],
  ['幸福人寿', 'feishu-knowledge-happy-life.json'],
  ['阳光人寿', 'feishu-knowledge-sunshine-life.json'],
  ['友邦人寿', 'feishu-knowledge-aia.json'],
  ['长城人寿', 'feishu-knowledge-greatwall-life.json'],
  ['招商仁和', 'feishu-knowledge-cmrh-life.json'],
  ['中国平安', 'feishu-knowledge-ping-an.json'],
  ['中国人寿', 'feishu-knowledge-china-life.json'],
  ['中国太平', 'feishu-knowledge-china-taiping.json'],
  ['中宏人寿', 'feishu-knowledge-manulife-sinochem.json'],
  ['中华人寿', 'feishu-knowledge-china-united-life.json'],
  ['中英人寿', 'feishu-knowledge-aviva-cofco.json'],
  ['中邮人寿', 'feishu-knowledge-china-post-life.json'],
]);

function readArg(name, fallback = '') {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function trim(value) {
  return String(value || '').trim();
}

function comparable(value) {
  return trim(value).replace(/\s+/gu, ' ');
}

function limitText(value, max = 9000) {
  const text = trim(value).replace(/\r\n?/gu, '\n');
  if (text.length <= max) return text;
  return `${text.slice(0, max - 18)}\n...已截断同步展示`;
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function parseCliJson(stdout) {
  const text = String(stdout || '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error(`lark-cli did not return JSON: ${text.slice(0, 300)}`);
  return JSON.parse(text.slice(start, end + 1));
}

function sleepMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isRetryableLarkError(text) {
  return /800004135|limited|rate.?limit|too many|too frequent|频率|限流|timeout|timed out|i\/o timeout|EOF|ECONNRESET|ETIMEDOUT|429|502|503|504/iu.test(
    text,
  );
}

function runLark(args, { retries = 8, maxBuffer = 80 * 1024 * 1024 } = {}) {
  let lastError = '';
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const result = spawnSync('lark-cli', args, {
      cwd: projectRoot,
      encoding: 'utf8',
      maxBuffer,
      timeout: 90_000,
    });
    if (result.status === 0) return parseCliJson(result.stdout);
    lastError = [result.stdout, result.stderr].filter(Boolean).join('\n');
    if (attempt < retries && isRetryableLarkError(lastError)) {
      sleepMs(Math.min(60_000, attempt * 8_000));
      continue;
    }
    break;
  }
  throw new Error(lastError.slice(0, 2000) || `lark-cli ${args.join(' ')} failed`);
}

function contentKey(row) {
  return [row.company, row.productName, row.materialType, row.url].map(comparable).join('\u0001');
}

function loadLocalRecords() {
  const state = readJson(statePath, {});
  return (Array.isArray(state.knowledgeRecords) ? state.knowledgeRecords : [])
    .map((record) => ({
      id: trim(record.id),
      company: trim(record.company),
      productName: trim(record.productName),
      productType: trim(record.productType),
      salesStatus: trim(record.salesStatus),
      materialType: trim(record.materialType || record.sourceType),
      title: trim(record.title),
      officialDomain: trim(record.officialDomain),
      url: trim(record.url),
      snippet: trim(record.snippet),
      pageText: limitText(record.pageText, Number(readArg('page-text-max', '9000')) || 9000),
      qualityStatus: trim(record.qualityStatus),
      qualityReason: trim(record.qualityReason),
      parser: trim(record.parser),
      updatedAt: trim(record.updatedAt || record.lastFetchedAt || record.discoveredAt),
    }))
    .filter((record) => record.id && record.company && record.productName && record.materialType && record.url);
}

function loadConfigs() {
  return fs
    .readdirSync(runtimeDir)
    .filter((name) => /^feishu-knowledge.*\.json$/u.test(name))
    .sort()
    .map((fileName) => {
      const saved = readJson(path.join(runtimeDir, fileName), {});
      return {
        fileName,
        configPath: path.join(runtimeDir, fileName),
        identity: trim(saved.identity || process.env.FEISHU_KNOWLEDGE_AS) || 'user',
        baseToken: trim(saved.baseToken || process.env.FEISHU_KNOWLEDGE_BASE_TOKEN),
        tableId: trim(saved.tableId),
        tableName: trim(saved.tableName),
      };
    })
    .filter((config) => config.baseToken && config.tableId);
}

function fieldsToLocalRecord(row, config, recordId) {
  return {
    id: trim(row[0]),
    company: trim(row[1]),
    productName: trim(row[2]),
    productType: trim(row[3]),
    salesStatus: trim(row[4]),
    materialType: trim(row[5]),
    title: trim(row[6]),
    officialDomain: trim(row[7]),
    url: trim(row[8]),
    snippet: trim(row[9]),
    pageText: trim(row[10]).replace(/\r\n?/gu, '\n'),
    qualityStatus: trim(row[11]),
    qualityReason: trim(row[12]),
    parser: trim(row[13]),
    updatedAt: trim(row[14]),
    recordId,
    configFileName: config.fileName,
    tableName: config.tableName,
  };
}

function feishuFields(record) {
  return {
    本地ID: record.id,
    保险公司: record.company,
    产品名称: record.productName,
    产品分类: record.productType,
    销售状态: record.salesStatus,
    资料类型: record.materialType,
    标题: record.title,
    官方域名: record.officialDomain,
    来源链接: record.url,
    摘要: limitText(record.snippet, 1200),
    保险责任正文: record.pageText,
    质量状态: record.qualityStatus,
    质量问题: limitText(record.qualityReason, 1200),
    解析器: record.parser,
    更新时间: record.updatedAt,
  };
}

function differs(local, remote) {
  const checks = [
    ['id', 'id'],
    ['company', 'company'],
    ['productName', 'productName'],
    ['productType', 'productType'],
    ['salesStatus', 'salesStatus'],
    ['materialType', 'materialType'],
    ['title', 'title'],
    ['officialDomain', 'officialDomain'],
    ['url', 'url'],
    ['snippet', 'snippet', 1200],
    ['pageText', 'pageText'],
    ['qualityStatus', 'qualityStatus'],
    ['qualityReason', 'qualityReason', 1200],
    ['parser', 'parser'],
    ['updatedAt', 'updatedAt'],
  ];
  for (const [localKey, remoteKey, maxLen] of checks) {
    const left = maxLen ? limitText(local[localKey], maxLen) : trim(local[localKey]);
    const right = trim(remote[remoteKey]).replace(/\r\n?/gu, '\n');
    if (left !== right) return true;
  }
  return false;
}

function readRemoteTable(config) {
  let offset = 0;
  const records = [];
  while (true) {
    const payload = runLark([
      'base',
      '+record-list',
      '--as',
      config.identity,
      '--base-token',
      config.baseToken,
      '--table-id',
      config.tableId,
      ...FIELD_NAMES.flatMap((field) => ['--field-id', field]),
      '--limit',
      '200',
      '--offset',
      String(offset),
      '--format',
      'json',
    ]);
    const data = payload?.data || {};
    const rows = data.data || [];
    const recordIds = data.record_id_list || [];
    for (let index = 0; index < rows.length; index += 1) {
      records.push(fieldsToLocalRecord(Array.isArray(rows[index]) ? rows[index] : [], config, recordIds[index] || ''));
    }
    if (!data.has_more || rows.length === 0) break;
    offset += rows.length;
    sleepMs(250);
  }
  return records;
}

function countByCompany(rows) {
  const counts = new Map();
  for (const row of rows) counts.set(row.company || '未知', (counts.get(row.company || '未知') || 0) + 1);
  return [...counts]
    .sort((left, right) => right[1] - left[1])
    .map(([company, count]) => ({ company, count }));
}

function buildPlan({ localRows, remoteRows, configs, errors }) {
  const localByKey = new Map(localRows.map((record) => [contentKey(record), record]));
  const configByName = new Map(configs.map((config) => [config.fileName, config]));
  const remoteByKey = new Map();
  const deletes = [];
  const updates = [];
  const creates = [];
  const remoteDuplicateKeys = new Map();

  for (const remote of remoteRows) {
    const key = contentKey(remote);
    if (!localByKey.has(key)) {
      deletes.push({ reason: 'remote_not_in_local', remote });
      continue;
    }
    if (remoteByKey.has(key)) {
      const first = remoteByKey.get(key);
      remoteDuplicateKeys.set(key, (remoteDuplicateKeys.get(key) || 1) + 1);
      deletes.push({ reason: 'duplicate_content_key', remote, keptRecordId: first.recordId, keptConfigFileName: first.configFileName });
      continue;
    }
    remoteByKey.set(key, remote);
  }

  const matchedConfigCountByCompany = new Map();
  for (const [key, remote] of remoteByKey) {
    const local = localByKey.get(key);
    if (!local) continue;
    const perCompany = matchedConfigCountByCompany.get(local.company) || new Map();
    perCompany.set(remote.configFileName, (perCompany.get(remote.configFileName) || 0) + 1);
    matchedConfigCountByCompany.set(local.company, perCompany);
    if (differs(local, remote)) {
      updates.push({
        local,
        remote: {
          recordId: remote.recordId,
          configFileName: remote.configFileName,
          tableName: remote.tableName,
          id: remote.id,
          company: remote.company,
          productName: remote.productName,
          materialType: remote.materialType,
          url: remote.url,
        },
      });
    }
  }

  function targetConfigFor(local) {
    const counted = matchedConfigCountByCompany.get(local.company);
    if (counted?.size) {
      const [fileName] = [...counted].sort((left, right) => right[1] - left[1])[0];
      const config = configByName.get(fileName);
      if (config) return config;
    }
    const mapped = CONFIG_BY_COMPANY.get(local.company);
    return mapped ? configByName.get(mapped) : null;
  }

  const missingTargetConfig = [];
  for (const [key, local] of localByKey) {
    if (remoteByKey.has(key)) continue;
    const config = targetConfigFor(local);
    if (!config) {
      missingTargetConfig.push(local);
      continue;
    }
    creates.push({
      local,
      target: {
        configFileName: config.fileName,
        tableName: config.tableName,
      },
    });
  }

  return {
    createdAt: new Date().toISOString(),
    statePath,
    basis: 'local knowledgeRecords are the source of truth; match key is company + productName + materialType + url; all writable Feishu fields are reconciled from local',
    counts: {
      localRows: localRows.length,
      localUniqueContentKeys: localByKey.size,
      remoteRows: remoteRows.length,
      remoteUniqueContentKeys: new Set(remoteRows.map(contentKey)).size,
      remoteDuplicateContentKeyCount: remoteDuplicateKeys.size,
      configs: configs.length,
      configErrors: errors.length,
      creates: creates.length,
      updates: updates.length,
      deletes: deletes.length,
      missingTargetConfig: missingTargetConfig.length,
    },
    byCompany: {
      creates: countByCompany(creates.map((item) => item.local)).slice(0, 50),
      updates: countByCompany(updates.map((item) => item.local)).slice(0, 50),
      deletes: countByCompany(deletes.map((item) => item.remote)).slice(0, 50),
    },
    configErrors: errors,
    missingTargetConfig: missingTargetConfig.slice(0, 100),
    samples: {
      creates: creates.slice(0, 20),
      updates: updates.slice(0, 20),
      deletes: deletes.slice(0, 20),
    },
    operations: {
      creates,
      updates,
      deletes,
    },
  };
}

function readAllRemote(configs) {
  const remoteRows = [];
  const errors = [];
  for (const config of configs) {
    try {
      const rows = readRemoteTable(config);
      remoteRows.push(...rows);
      console.error(`[feishu-reconcile] read ${config.fileName} rows=${rows.length}`);
      sleepMs(600);
    } catch (error) {
      const message = String(error?.message || error).slice(0, 1000);
      errors.push({ configFileName: config.fileName, tableName: config.tableName, message });
      console.error(`[feishu-reconcile] read failed ${config.fileName}: ${message.slice(0, 180)}`);
      sleepMs(1000);
    }
  }
  return { remoteRows, errors };
}

function groupByConfig(items, selector) {
  const groups = new Map();
  for (const item of items) {
    const fileName = selector(item);
    if (!groups.has(fileName)) groups.set(fileName, []);
    groups.get(fileName).push(item);
  }
  return groups;
}

function upsertRecord(config, fields, recordId = '') {
  const args = [
    'base',
    '+record-upsert',
    '--as',
    config.identity,
    '--base-token',
    config.baseToken,
    '--table-id',
    config.tableId,
    '--json',
    JSON.stringify(fields),
  ];
  if (recordId) args.push('--record-id', recordId);
  runLark(args, { retries: 8, maxBuffer: 20 * 1024 * 1024 });
}

function deleteRecords(config, recordIds) {
  for (let index = 0; index < recordIds.length; index += 100) {
    const chunk = recordIds.slice(index, index + 100);
    runLark([
      'base',
      '+record-delete',
      '--as',
      config.identity,
      '--base-token',
      config.baseToken,
      '--table-id',
      config.tableId,
      '--json',
      JSON.stringify({ record_id_list: chunk }),
      '--yes',
    ]);
    sleepMs(500);
  }
}

function applyPlan(plan, configs) {
  const configByName = new Map(configs.map((config) => [config.fileName, config]));
  const results = {
    startedAt: new Date().toISOString(),
    created: 0,
    updated: 0,
    deleted: 0,
    failures: [],
  };

  const deleteGroups = groupByConfig(plan.operations.deletes, (item) => item.remote.configFileName);
  for (const [fileName, items] of deleteGroups) {
    const config = configByName.get(fileName);
    if (!config) {
      results.failures.push({ phase: 'delete', fileName, message: 'missing config' });
      continue;
    }
    const recordIds = items.map((item) => item.remote.recordId).filter(Boolean);
    if (!recordIds.length) continue;
    try {
      deleteRecords(config, recordIds);
      results.deleted += recordIds.length;
      console.error(`[feishu-reconcile] deleted ${results.deleted}/${plan.counts.deletes}`);
    } catch (error) {
      results.failures.push({ phase: 'delete', fileName, message: String(error?.message || error).slice(0, 1000) });
      throw error;
    }
  }

  for (const [index, item] of plan.operations.updates.entries()) {
    const config = configByName.get(item.remote.configFileName);
    if (!config) {
      results.failures.push({ phase: 'update', fileName: item.remote.configFileName, id: item.local.id, message: 'missing config' });
      continue;
    }
    try {
      upsertRecord(config, feishuFields(item.local), item.remote.recordId);
      results.updated += 1;
      if (results.updated % 50 === 0 || index + 1 === plan.operations.updates.length) {
        console.error(`[feishu-reconcile] updated ${results.updated}/${plan.counts.updates}`);
      }
      sleepMs(120);
    } catch (error) {
      results.failures.push({ phase: 'update', id: item.local.id, message: String(error?.message || error).slice(0, 1000) });
      throw error;
    }
  }

  for (const [index, item] of plan.operations.creates.entries()) {
    const config = configByName.get(item.target.configFileName);
    if (!config) {
      results.failures.push({ phase: 'create', fileName: item.target.configFileName, id: item.local.id, message: 'missing config' });
      continue;
    }
    try {
      upsertRecord(config, feishuFields(item.local));
      results.created += 1;
      if (results.created % 50 === 0 || index + 1 === plan.operations.creates.length) {
        console.error(`[feishu-reconcile] created ${results.created}/${plan.counts.creates}`);
      }
      sleepMs(120);
    } catch (error) {
      results.failures.push({ phase: 'create', id: item.local.id, message: String(error?.message || error).slice(0, 1000) });
      throw error;
    }
  }
  results.finishedAt = new Date().toISOString();
  return results;
}

function main() {
  const apply = hasFlag('apply');
  const verifyOnly = hasFlag('verify-only');
  const localRows = loadLocalRecords();
  const configs = loadConfigs();
  const { remoteRows, errors } = readAllRemote(configs);
  const plan = buildPlan({ localRows, remoteRows, configs, errors });
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const planPath = path.join(runtimeDir, `feishu-local-knowledge-reconcile-plan-${stamp}.json`);
  const summaryPath = path.join(runtimeDir, `feishu-local-knowledge-reconcile-summary-${stamp}.json`);

  if (plan.counts.missingTargetConfig > 0) {
    plan.blocked = true;
    plan.blockReason = 'Some local records do not have a target Feishu config';
  }
  writeJson(planPath, plan);

  const summary = {
    planPath,
    createdAt: plan.createdAt,
    apply,
    verifyOnly,
    counts: plan.counts,
    byCompany: plan.byCompany,
    configErrors: plan.configErrors,
    blocked: Boolean(plan.blocked),
    blockReason: plan.blockReason || '',
  };

  if (verifyOnly) {
    writeJson(summaryPath, summary);
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  if (plan.blocked) {
    writeJson(summaryPath, summary);
    console.log(JSON.stringify(summary, null, 2));
    process.exitCode = 2;
    return;
  }

  if (apply) {
    summary.result = applyPlan(plan, configs);
    writeJson(summaryPath, summary);
  } else {
    summary.dryRun = true;
    writeJson(summaryPath, summary);
  }

  console.log(JSON.stringify(summary, null, 2));
}

main();
