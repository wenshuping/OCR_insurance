import crypto from 'node:crypto';

const DEFAULT_MAX_CONCURRENCY = 4;
const DEFAULT_EVIDENCE_LIMIT = 6_000;

const DOMAIN_DEFINITIONS = [
  {
    domain: 'universal_life',
    label: '万能账户',
    identity: /万能型|万能保险|万能账户/u,
    evidence: /最低保证利率|保证利率|结算利率|初始费用|保单管理费|风险保险费|保单账户价值|账户价值|部分领取|退保手续费/u,
  },
  {
    domain: 'incremental_whole_life',
    label: '增额终身寿险',
    identity: /增额终身寿|增额寿/u,
    evidence: /有效保险金额|有效保额|保单年度系数|基本保险金额.{0,80}(?:递增|增长|复利)/u,
  },
  {
    domain: 'annuity',
    label: '年金保险',
    identity: /年金保险|养老年金|教育年金/u,
    evidence: /年金|养老金|祝寿金|生存保险金|领取日|领取方式|按年领取|按月领取/u,
  },
  {
    domain: 'endowment',
    label: '两全保险',
    identity: /两全保险/u,
    evidence: /满期保险金|满期生存保险金|生存保险金/u,
  },
  {
    domain: 'participating_life',
    label: '分红保险',
    identity: /分红型|分红保险/u,
    evidence: /保单红利|红利分配|累积红利|红利保险金额|红利不保证/u,
  },
  {
    domain: 'critical_illness',
    label: '重大疾病保险',
    identity: /重大疾病保险|重疾险/u,
    evidence: /重大疾病|重度疾病|中度疾病|轻度疾病|疾病分组|给付次数|间隔期|豁免保险费/u,
  },
  {
    domain: 'medical',
    label: '医疗保险',
    identity: /医疗保险|医疗险/u,
    evidence: /医疗保险金|住院|门诊|免赔额|赔付比例|报销比例|医疗费用|医院范围/u,
  },
  {
    domain: 'accident',
    label: '意外伤害保险',
    identity: /意外伤害保险|意外险/u,
    evidence: /意外身故|意外伤残|意外医疗|伤残等级|交通工具意外|航空意外/u,
  },
  {
    domain: 'long_term_care',
    label: '长期护理保险',
    identity: /长期护理保险|护理保险/u,
    evidence: /护理保险金|长期护理状态|失能状态|护理状态|给付期间/u,
  },
  {
    domain: 'term_life',
    label: '定期寿险',
    identity: /定期寿险|定期人寿/u,
    evidence: /身故保险金|全残保险金|保险期间/u,
  },
  {
    domain: 'ordinary_whole_life',
    label: '终身寿险',
    identity: /终身寿险|终身人寿/u,
    evidence: /身故保险金|全残保险金|终身/u,
  },
  {
    domain: 'rider',
    label: '附加险',
    identity: /附加[^\n]{0,40}(?:保险|险)/u,
    evidence: /主险|附加合同|本附加险|本附加合同/u,
  },
  {
    domain: 'group',
    label: '团体保险',
    identity: /团体[^\n]{0,40}(?:保险|险)/u,
    evidence: /团体保险|投保单位|团体成员/u,
  },
];

function text(value) {
  return String(value ?? '').trim();
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function unique(values) {
  return [...new Set(array(values).map(text).filter(Boolean))];
}

function recordUrl(record = {}) {
  return text(record.sourceUrl || record.source_url || record.officialUrl || record.url || record.fileUrl);
}

function recordDigest(record = {}) {
  return text(record.sourceDigest || record.source_digest || record.responsibilitySourceDigest);
}

function planVersionIdentity(value = '') {
  try {
    const url = new URL(text(value));
    const planCode = text(url.searchParams.get('planCode'));
    const versionNo = text(url.searchParams.get('versionNo'));
    return planCode && versionNo ? `${planCode}:${versionNo}` : '';
  } catch {
    return '';
  }
}

export function selectBoundOfficialSourceRecords(records = [], identity = {}) {
  const candidates = array(records);
  const sourceDigest = text(identity?.sourceDigest);
  if (sourceDigest) {
    const digestMatches = candidates.filter((record) => recordDigest(record) === sourceDigest);
    if (!digestMatches.length) return [];
    const planVersions = unique(digestMatches.map((record) => planVersionIdentity(recordUrl(record))));
    return planVersions.length === 1
      ? candidates.filter((record) => planVersionIdentity(recordUrl(record)) === planVersions[0])
      : digestMatches;
  }

  const sourceUrl = text(identity?.sourceUrl);
  if (sourceUrl) {
    const exactMatches = candidates.filter((record) => recordUrl(record) === sourceUrl);
    if (exactMatches.length) {
      const planVersion = planVersionIdentity(sourceUrl);
      return planVersion
        ? candidates.filter((record) => planVersionIdentity(recordUrl(record)) === planVersion)
        : exactMatches;
    }
  }

  const planVersion = text(identity?.planCode) && text(identity?.versionNo)
    ? `${text(identity.planCode)}:${text(identity.versionNo)}`
    : planVersionIdentity(sourceUrl);
  if (planVersion) {
    return candidates.filter((record) => planVersionIdentity(recordUrl(record)) === planVersion);
  }
  return sourceUrl ? [] : candidates;
}

export function wholeDocumentTextFromRecord(record = {}) {
  const payload = typeof record.payload === 'string'
    ? (() => { try { return JSON.parse(record.payload); } catch { return {}; } })()
    : (record.payload && typeof record.payload === 'object' ? record.payload : {});
  return text(
    record.fullText
      || record.full_text
      || record.officialText
      || record.official_text
      || record.pageText
      || record.text
      || record.content
      || payload.fullText
      || payload.full_text
      || payload.officialText
      || payload.official_text
      || payload.pageText
      || payload.text,
  );
}

function materialFamilyKey(record = {}) {
  const urlValue = recordUrl(record);
  try {
    const url = new URL(urlValue);
    const planCode = text(url.searchParams.get('planCode'));
    const versionNo = text(url.searchParams.get('versionNo'));
    if (planCode && versionNo) return `plan:${url.hostname}:${planCode}:${versionNo}`;
  } catch {}
  const digest = recordDigest(record);
  return digest ? `digest:${digest}` : (urlValue ? `url:${urlValue}` : 'unversioned');
}

function explicitVersionKey(record = {}) {
  const direct = text(record.versionNo || record.version_no || record.version || record.filingCode || record.filing_code);
  if (direct) return `version:${direct}`;
  try {
    const url = new URL(recordUrl(record));
    const planCode = text(url.searchParams.get('planCode'));
    const versionNo = text(url.searchParams.get('versionNo'));
    return planCode && versionNo ? `plan:${url.hostname}:${planCode}:${versionNo}` : '';
  } catch {
    return '';
  }
}

function normalizedDocumentText(records = []) {
  return array(records)
    .map(wholeDocumentTextFromRecord)
    .filter(Boolean)
    .join('\n\n')
    .normalize('NFKC')
    .replace(/\r/gu, '\n')
    .replace(/[ \t]+/gu, ' ')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

function documentDigest(records = []) {
  const payload = array(records).map((record) => ({
    familyKey: materialFamilyKey(record),
    sourceDigest: recordDigest(record),
    sourceUrl: recordUrl(record),
    textDigest: crypto.createHash('sha256').update(wholeDocumentTextFromRecord(record)).digest('hex'),
  }));
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function navigationOnly(value) {
  const content = text(value);
  if (!content) return true;
  const compact = content.replace(/\s+/gu, '');
  if (/^(?:目录|阅读指引|条款目录|页码)/u.test(compact)) return true;
  const numberedHeadings = content.match(/(?:^|\s)\d+(?:\.\d+)+\s*[^。；;]{1,24}/gu) || [];
  return numberedHeadings.length >= 3 && !/(?:本合同|我们|本公司|按|为|不得|可以|应当)[^。；;]{8,}/u.test(content);
}

function candidateChunks(fullText, pattern) {
  const paragraphs = fullText
    .split(/\n{2,}|(?<=[。；;！？!?])\s*(?=第?[一二三四五六七八九十百千万\d])/u)
    .map((value) => text(value).replace(/\s+/gu, ' '))
    .filter((value) => value.length >= 8 && !navigationOnly(value));
  return paragraphs
    .filter((value) => pattern.test(value))
    .map((value) => ({
      value,
      score: Math.min(value.length, 1_500)
        + (/(?:本合同|我们|本公司|投保人|被保险人)/u.test(value) ? 600 : 0)
        + (/\d+(?:\.\d+)?\s*%|人民币|元|倍|日|年/u.test(value) ? 300 : 0)
        + (/第\s*[一二三四五六七八九十百千万\d]+\s*条/u.test(value) ? 300 : 0),
    }))
    .sort((left, right) => right.score - left.score)
    .map((item) => item.value);
}

function evidenceForDomain(fullText, definition, limit = DEFAULT_EVIDENCE_LIMIT) {
  const chunks = unique(candidateChunks(fullText, definition.evidence));
  const selected = [];
  let length = 0;
  for (const chunk of chunks) {
    if (length && length + chunk.length > limit) continue;
    selected.push(chunk);
    length += chunk.length;
    if (length >= limit) break;
  }
  return selected.join('\n\n');
}

export function buildWholeDocumentProductProfile({ company = '', productName = '', records = [] } = {}) {
  const normalizedRecords = array(records).filter((record) => wholeDocumentTextFromRecord(record) || recordUrl(record));
  const familyKeys = unique(normalizedRecords.map(materialFamilyKey).filter((key) => key !== 'unversioned'));
  const explicitVersionKeys = unique(normalizedRecords.map(explicitVersionKey));
  const fullText = normalizedDocumentText(normalizedRecords);
  const identityText = `${text(productName)}\n${fullText}`;
  const domains = DOMAIN_DEFINITIONS
    .filter((definition) => definition.identity.test(identityText))
    .map((definition) => definition.domain);
  const evidencePackets = domains.map((domain, index) => {
    const definition = DOMAIN_DEFINITIONS.find((item) => item.domain === domain);
    const evidenceText = evidenceForDomain(fullText, definition);
    return {
      evidencePacketId: `domain:${domain}:${index + 1}`,
      domain,
      label: definition.label,
      sourceDigest: unique(normalizedRecords.map(recordDigest))[0] || '',
      sourceUrls: unique(normalizedRecords.map(recordUrl)),
      materialFamilyKey: familyKeys.length === 1 ? familyKeys[0] : '',
      evidenceText,
      missingEvidence: !evidenceText,
    };
  });
  return {
    company: text(company),
    productName: text(productName),
    domains,
    evidencePackets,
    materialFamilyKeys: familyKeys,
    versionConflict: explicitVersionKeys.length > 1,
    explicitVersionKeys,
    documentDigest: documentDigest(normalizedRecords),
    documentTextAvailable: Boolean(fullText),
  };
}

export function buildDomainWorkerPlan(profile = {}) {
  if (profile.versionConflict) return [];
  const packets = new Map(array(profile.evidencePackets).map((packet) => [packet.domain, packet]));
  return unique(profile.domains).map((domain) => ({
    role: `${domain}_domain_worker`,
    domain,
    evidencePacket: packets.get(domain) || null,
  }));
}

export function buildDomainWorkerPrompt({ product = {}, worker = {} } = {}) {
  return [
    '你是保险产品领域解释 worker。只输出合法 JSON，不要 Markdown。',
    `领域：${worker.domain}`,
    `产品：${text(product.company)} / ${text(product.productName)}`,
    '只能使用给定官方证据，不得新增、删除或改名保险责任。',
    '输出：{"domain":"","purposeFacts":[],"functionFacts":[],"attentionFacts":[],"sourceRefs":[]}',
    'purposeFacts 用于“产品主要做什么”；functionFacts 用于账户、领取、分红等产品功能；attentionFacts 用于限制和不确定性。',
    '若证据不足，对应数组返回空数组。不得根据产品名猜测利率、费用、责任或收益。',
    '官方证据：',
    text(worker.evidencePacket?.evidenceText),
  ].join('\n');
}

function normalizeWorkerOutput(worker, value) {
  const source = value && typeof value === 'object' ? value : {};
  const deterministicFunctionFacts = worker.domain === 'universal_life'
    ? unique(text(worker.evidencePacket?.evidenceText)
        .split(/\n{2,}/u)
        .filter((item) => /最低保证利率|保证利率|结算利率|初始费用|保单管理费|风险保险费|部分领取|退保手续费|账户价值/u.test(item))
        .map((item) => item.replace(/\s+/gu, ' ').slice(0, 500)))
    : [];
  return {
    role: worker.role,
    domain: worker.domain,
    status: 'passed',
    purposeFacts: unique(source.purposeFacts),
    functionFacts: unique([...array(source.functionFacts), ...deterministicFunctionFacts]),
    attentionFacts: unique(source.attentionFacts),
    sourceRefs: unique(source.sourceRefs),
  };
}

export async function runDomainEvidenceWorkers({
  product = {},
  plan = [],
  generateWorker,
  maxConcurrency = DEFAULT_MAX_CONCURRENCY,
} = {}) {
  if (typeof generateWorker !== 'function' || !array(plan).length) return [];
  const workers = array(plan);
  const results = [];
  const concurrency = Math.max(1, Math.min(Number(maxConcurrency) || DEFAULT_MAX_CONCURRENCY, DEFAULT_MAX_CONCURRENCY));
  for (let start = 0; start < workers.length; start += concurrency) {
    const batch = workers.slice(start, start + concurrency);
    const settled = await Promise.allSettled(batch.map(async (worker) => {
      const value = await generateWorker({
        prompt: buildDomainWorkerPrompt({ product, worker }),
        company: product.company,
        productName: product.productName,
        domain: worker.domain,
      });
      return normalizeWorkerOutput(worker, value);
    }));
    settled.forEach((item, index) => {
      if (item.status === 'fulfilled') results.push(item.value);
      else results.push({
        role: batch[index].role,
        domain: batch[index].domain,
        status: 'failed',
        errorCode: text(item.reason?.code) || 'domain_worker_failed',
      });
    });
  }
  return results;
}

function blockByKey(blocks, key) {
  return array(blocks).find((block) => text(block?.blockKey) === key);
}

function mergeBlockContent(blocks, key, lines) {
  if (!lines.length) return array(blocks);
  const definitions = {
    productPurpose: { title: '产品主要做什么', order: 1 },
    productFunctions: { title: '产品功能/权益', order: 3 },
    attentionNotes: { title: '注意事项', order: 4 },
  };
  const definition = definitions[key];
  const existing = blockByKey(blocks, key) || { blockKey: key, ...definition };
  const content = unique([text(existing.content), ...lines]).join('\n');
  const next = array(blocks).filter((block) => text(block?.blockKey) !== key);
  next.push({ ...existing, blockKey: key, title: text(existing.title) || definition.title, enabled: true, editable: existing.editable !== false, order: existing.order || definition.order, content });
  return next.sort((left, right) => Number(left.order || 0) - Number(right.order || 0));
}

export function mergeDomainWorkerResults(summary = {}, workerResults = []) {
  const passed = array(workerResults).filter((worker) => worker.status === 'passed');
  const failed = array(workerResults).filter((worker) => worker.status !== 'passed');
  let contentBlocks = array(summary.contentBlocks);
  contentBlocks = mergeBlockContent(contentBlocks, 'productPurpose', unique(passed.flatMap((worker) => worker.purposeFacts)));
  contentBlocks = mergeBlockContent(contentBlocks, 'productFunctions', unique(passed.flatMap((worker) => worker.functionFacts)));
  contentBlocks = mergeBlockContent(contentBlocks, 'attentionNotes', unique(passed.flatMap((worker) => worker.attentionFacts)));
  return {
    ...summary,
    contentBlocks,
    domainWorkers: array(workerResults).map((worker) => ({ role: worker.role, domain: worker.domain, status: worker.status, errorCode: worker.errorCode || '' })),
    domainWorkerFailures: failed.map((worker) => ({ domain: worker.domain, errorCode: worker.errorCode || 'domain_worker_failed' })),
  };
}
