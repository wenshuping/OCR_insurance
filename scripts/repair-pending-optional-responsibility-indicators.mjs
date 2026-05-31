import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const runtimeDir = path.join(projectRoot, '.runtime');
const DEFAULT_DB_PATHS = [
  path.join(runtimeDir, 'policy-ocr.sqlite'),
  path.join(runtimeDir, 'local', 'policy-ocr.sqlite'),
];
const VERSION = '2026-05-31-pending-optional-responsibility-repair';

function trim(value) {
  return String(value ?? '').trim();
}

function normalizeOneLine(value) {
  return trim(value)
    .normalize('NFKC')
    .replace(/\r/gu, '\n')
    .replace(/\u00a0/gu, ' ')
    .replace(/\s+/gu, ' ');
}

function compactText(value) {
  return normalizeOneLine(value).replace(/\s+/gu, '');
}

function parsePayload(value, fallback = {}) {
  if (value && typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function readArg(name, fallback = '') {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function sha1(value, length = 18) {
  return crypto.createHash('sha1').update(value).digest('hex').slice(0, length);
}

function sqlString(value) {
  return `'${String(value).replace(/'/gu, "''")}'`;
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function backupSqlite(dbPath) {
  if (!(await exists(dbPath))) return [];
  const backupDir = path.join(path.dirname(dbPath), 'backups');
  await fs.mkdir(backupDir, { recursive: true });
  const label = dbPath.includes(`${path.sep}local${path.sep}`) ? 'local-policy-ocr' : 'policy-ocr';
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const backupBase = path.join(backupDir, `${label}-before-pending-optional-repair-${stamp}.sqlite`);
  const copied = [];
  for (const suffix of ['', '-wal', '-shm']) {
    const source = `${dbPath}${suffix}`;
    if (!(await exists(source))) continue;
    const target = `${backupBase}${suffix}`;
    await fs.copyFile(source, target);
    copied.push(target);
  }
  return copied;
}

function normalizeOptionalRow(row = {}) {
  const payload = parsePayload(row.payload);
  return {
    id: trim(row.id),
    company: trim(row.company || payload.company),
    productName: trim(row.product_name || row.productName || payload.productName),
    liability: trim(row.liability || payload.liability),
    payload,
  };
}

function normalizeKnowledgeRow(row = {}) {
  const payload = parsePayload(row.payload);
  return {
    id: trim(row.id || payload.id),
    company: trim(row.company || payload.company),
    productName: trim(row.product_name || row.productName || payload.productName || payload.title),
    url: trim(row.url || payload.url),
    title: trim(row.title || payload.title || row.product_name || payload.productName),
    payload,
  };
}

function knowledgeText(record = {}) {
  const payload = record.payload || {};
  const pageTexts = Array.isArray(payload.pages)
    ? payload.pages.map((page) => [page?.pageText, page?.text, page?.content].filter(Boolean).join('\n'))
    : [];
  return [
    record.pageText,
    record.text,
    record.content,
    record.body,
    record.snippet,
    payload.pageText,
    payload.text,
    payload.content,
    payload.body,
    payload.snippet,
    payload.responsibility,
    payload.analysis?.report,
    ...(Array.isArray(payload.analysis?.coverageTable)
      ? payload.analysis.coverageTable.map((item) => [item.coverageType, item.scenario, item.payout, item.note].filter(Boolean).join(' '))
      : []),
    ...pageTexts,
  ].map(trim).filter(Boolean).join('\n');
}

function sourceFields(record = {}) {
  return {
    sourceRecordId: trim(record.id || record.payload?.id),
    sourceUrl: trim(record.url || record.payload?.url),
    sourceTitle: trim(record.title || record.payload?.title || record.productName || record.payload?.productName),
  };
}

function optionalSuffix(liability = '') {
  return trim(liability).replace(/^可选(?:保险)?责任/u, '').trim();
}

function optionalBenefitHeadingScore(after = '') {
  const compact = compactText(after.slice(0, 180));
  if (/^(?:中|经确定|可以|可选择|为本合同可选择|为本合同可选择的部分|可以选择|可以与|未在保险单上载明|未投保)/u.test(compact)) return -35;
  if (/^[:：]?(?:[（(]?\d+[）)]|[一二三四五六七八九十]+[、.．])?[一-龥A-Za-z0-9（）()\-—“”]{2,42}(?:保险金|津贴|补贴|豁免保险费|豁免)/u.test(compact)) return 45;
  if (/^[:：]?[^。；]{0,80}(?:保险金|津贴|补贴|豁免保险费|豁免)/u.test(compact) && !/^[:：]?[^。；]{0,80}(?:基本责任|基本保险责任)/u.test(compact)) return 20;
  return 0;
}

function findOptionalStart(text = '', liability = '') {
  const source = normalizeOneLine(text);
  const suffix = optionalSuffix(liability);
  const matches = [...source.matchAll(/可选(?:保险)?责任\s*(?:[（(]?\s*[一二三四五六七八九十\d]+\s*[）)]?)?/gu)];
  if (!matches.length) return -1;
  let best = { index: -1, score: -1000 };
  for (const match of matches) {
    const token = trim(match[0]);
    if (suffix && !token.includes(suffix)) continue;
    const before = source.slice(Math.max(0, match.index - 32), match.index);
    const after = source.slice(match.index, match.index + 180);
    const context = source.slice(match.index, match.index + 900);
    const compactContext = compactText(context);
    let score = 0;
    if (suffix && token.includes(suffix)) score += 80;
    score += optionalBenefitHeadingScore(after.slice(token.length));
    if (!suffix && /(?:\d+[.．])+\d*\s*$|[（(][一二三四五六七八九十\d]+[）)]\s*$/u.test(before)) score += 45;
    if (/合同生效后.{0,30}可以选择本可选责任作为合同项下的保险责任/u.test(after)) score += 80;
    if (/按(?:照)?.{0,100}(?:基本保险金额|基本保额|保险金额|保险金金额)(?:向.{0,50})?给付.{0,40}(?:保险金|津贴|补贴|教育金|祝寿金|关爱金|年金|生存金)/u.test(compactContext)) score += 160;
    if (/基本(?:保险)?责任.{0,80}$/u.test(before)) score += 25;
    if (/(?:保险金|津贴|豁免|医疗|身故|全残)/u.test(after)) score += 15;
    if (/保险利益演示|演示项目|累计保险费|累积生息账户|当年红利/u.test(source.slice(Math.max(0, match.index - 120), match.index + 220))) score -= 110;
    if (/分为.{0,30}可选(?:保险)?责任|可选择的部分|可以与本公司约定|任意一项/u.test(after)
      || (/可以选择/u.test(after) && !/合同生效后.{0,30}可以选择本可选责任作为合同项下的保险责任/u.test(after))) score -= 45;
    if (/^可选(?:保险)?责任\s*[一二三四五六七八九十\d]*\s*(?:中|经确定)/u.test(after)) score -= 80;
    if (!suffix && /可选(?:保险)?责任.{0,140}基本(?:保险)?责任/u.test(after)) score -= 45;
    if (/中的[“"]?\s*$|除[“"]?\s*$/u.test(before)) score -= 80;
    if (after.slice(token.length).search(/可选(?:保险)?责任\s*(?:[（(]?\s*[一二三四五六七八九十\d]+\s*[）)]?)?/u) >= 0) {
      const nextOptional = after.slice(token.length).search(/可选(?:保险)?责任\s*(?:[（(]?\s*[一二三四五六七八九十\d]+\s*[）)]?)?/u);
      if (nextOptional < 140) score -= 70;
    }
    if (match.index > 80) score += 5;
    if (score > best.score) best = { index: match.index, score };
  }
  if (best.score < (suffix ? 25 : 12)) return -1;
  return best.index;
}

function findOptionalBoundary(source = '', start = 0, liability = '') {
  const suffix = optionalSuffix(liability);
  const tail = source.slice(start + 8);
  const patterns = [
    /(?:\d+[.．])?\s*您享有的其他重要权益/u,
    /保险利益演示/u,
    /案例演示/u,
    /责任免除/u,
    /释义/u,
    /保险责任的终止/u,
    /保险金申请/u,
    /如何申请领取保险金/u,
  ];
  if (suffix) {
    patterns.unshift(/可选(?:保险)?责任\s*[一二三四五六七八九十\d]+/u);
  }
  const indexes = patterns
    .map((pattern) => {
      const index = tail.search(pattern);
      return index >= 160 ? start + 8 + index : -1;
    })
    .filter((index) => index > start);
  return indexes.length ? Math.min(...indexes) : Math.min(source.length, start + 6000);
}

function expandedOptionalSection(row = {}, knowledgeById = new Map()) {
  const payload = row.payload || {};
  const sourceRecordId = trim(payload.sourceRecordId);
  const knowledge = sourceRecordId ? knowledgeById.get(sourceRecordId) : null;
  const existing = normalizeOneLine(payload.sourceExcerpt);
  const text = normalizeOneLine(knowledgeText(knowledge));
  if (!text) return { section: existing, source: null, reason: 'source_text_missing' };
  const start = findOptionalStart(text, row.liability);
  if (start < 0) return { section: existing, source: knowledge, reason: 'optional_section_missing' };
  const end = findOptionalBoundary(text, start, row.liability);
  const section = trim(text.slice(start, end));
  if (section.length >= 120 && clauseHasBenefitFormula(section)) {
    return { section, source: knowledge, reason: 'expanded_from_knowledge' };
  }
  if (section.length >= Math.max(existing.length, 40) && clauseHasBenefitFormula(section)) {
    return { section, source: knowledge, reason: 'expanded_from_knowledge' };
  }
  if (section.length >= Math.max(existing.length, 120)) {
    return { section, source: knowledge, reason: 'expanded_from_knowledge' };
  }
  return { section: existing || section, source: knowledge, reason: 'kept_existing_excerpt' };
}

function cleanLiability(value = '') {
  const cleaned = trim(value)
    .replace(/\s+/gu, '')
    .replace(/^[（(]?[一二三四五六七八九十\d]+[）)、.．]*/u, '')
    .replace(/^(?:\d+[.．])+\d*[.．]?/u, '')
    .replace(/^(?:可选(?:保险)?责任[一二三四五六七八九十\d]*[:：]?|基本(?:保险)?责任[:：]?)/u, '')
    .replace(/^(?:同时包括|包括|我们|本公司|公司|给付|按|按照|并|额外|仍|将|向|则|该项|中的)/u, '')
    .replace(/^的/u, '')
    .trim();
  const midpoint = Math.floor(cleaned.length / 2);
  if (cleaned.length > 3 && cleaned.length % 2 === 0 && cleaned.slice(0, midpoint) === cleaned.slice(midpoint)) {
    return cleaned.slice(0, midpoint);
  }
  return cleaned;
}

function liabilityFromClause(clause = '', fallback = '') {
  const text = normalizeOneLine(clause);
  const compact = compactText(text);
  const paidMatches = [...compact.matchAll(/给付([一-龥A-Za-z0-9（）()\-—“”]{2,42}?(?:保险金|津贴|补贴|豁免保险费|豁免|教育金|祝寿金|关爱金|年金|生存金))/gu)];
  if (paidMatches.length) {
    const liability = cleanLiability(paidMatches.at(-1)[1]);
    if (liability && !/本合同可选责任|给付条件|保险金受益人|保险金申请|保险金金额/u.test(liability)) return liability;
  }
  const heading = compact.match(/(?:可选(?:保险)?责任[一二三四五六七八九十\d]*[:：]?)?([一-龥A-Za-z0-9（）()\-—“”]+?(?:保险金|津贴|补贴|豁免保险费|豁免|教育金|祝寿金|关爱金|年金|生存金))/u);
  if (heading?.[1]) {
    const liability = cleanLiability(heading[1]);
    if (liability && !/本合同可选责任|给付条件|保险金受益人|保险金申请|保险金金额|同时包括|包括/u.test(liability)) return liability;
  }
  const candidates = [...compact.matchAll(/[一-龥A-Za-z0-9（）()\-—“”]{2,42}(?:保险金|津贴|补贴|豁免保险费|豁免|教育金|祝寿金|关爱金|年金|生存金)/gu)]
    .map((match) => cleanLiability(match[0]))
    .filter((value) => value && !/本合同可选责任|保险金受益人|保险金申请|保险金金额|基本保险金$/u.test(value));
  if (candidates.length) return candidates.at(-1);
  return cleanLiability(fallback) || '可选保险责任';
}

function leadingLiabilityFromClause(clause = '', fallback = '') {
  const compact = compactText(clause);
  const direct = compact.match(/^(?:可选(?:保险)?责任[一二三四五六七八九十\d]*[:：]?(?:\d+(?:[.．]\d+)*[.．]?)?|[（(]?[一二三四五六七八九十\d]+[）)、.．]?|[一二三四五六七八九十]+[、.．])?([一-龥A-Za-z0-9（）()\-—“”]{2,42}?(?:保险金|津贴|补贴|豁免保险费|豁免|教育金|祝寿金|关爱金|年金|生存金))/u);
  if (direct?.[1]) {
    const liability = cleanLiability(direct[1]);
    if (liability && !/基本责任|基本保险责任|必选责任|保险责任$|基本保险金额|基本保额|保险金额|乘以|×|\d+(?:\.\d+)?%/u.test(liability)) return liability;
  }
  const heading = compact.match(/(?:^|[。；;:：])(?:[（(]?[一二三四五六七八九十\d]+[）)、.．]?)?([一-龥A-Za-z0-9（）()\-—“”]{2,42}?(?:保险金|津贴|补贴|豁免保险费|豁免|教育金|祝寿金|关爱金|年金|生存金))/u);
  if (heading?.[1]) {
    const liability = cleanLiability(heading[1]);
    if (liability && !/基本责任|基本保险责任|必选责任|保险责任$/u.test(liability)) return liability;
  }
  return liabilityFromClause(clause, fallback);
}

function classifyCoverageType(liability = '', clause = '') {
  const text = `${liability} ${clause}`;
  if (/救援|转运|常住地|国籍所在居住地|后事|亲属|遗体|灵柩|骨灰|火化|安葬/u.test(text)) return '救援服务';
  if (/医疗|门诊|住院|津贴|补贴|救护车|护理/u.test(text)) return '医疗保障';
  if (/轻度疾病|中度疾病|重度疾病|重大疾病|恶性肿瘤|癌|特定疾病|疾病/u.test(text)) return '疾病保障';
  if (/身故|全残|残疾|伤残|猝死/u.test(text)) return '人寿保障';
  if (/年金|生存|满期|领取/u.test(text)) return '现金流';
  if (/豁免|次数|种数|等待期/u.test(text)) return '规则参数';
  if (/意外/u.test(text)) return '意外保障';
  return '保险责任';
}

function normalizeBasis(value = '') {
  return trim(value)
    .replace(/^的/u, '')
    .replace(/^(?:我们|本公司|公司|还将按|将按|按|按照|给付|向)/u, '')
    .replace(/本合同项下/u, '本合同项下')
    .trim();
}

function numericChinese(value = '') {
  const text = trim(value);
  if (/^\d+$/u.test(text)) return Number(text);
  const digits = {
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10,
  };
  if (digits[text]) return digits[text];
  const ten = text.match(/^([一二两三四五六七八九])?十([一二两三四五六七八九])?$/u);
  if (ten) return (ten[1] ? digits[ten[1]] : 1) * 10 + (ten[2] ? digits[ten[2]] : 0);
  return null;
}

function extractExactFormula(text = '') {
  const normalized = normalizeOneLine(text);
  const match = normalized.match(/([一-龥A-Za-z0-9（）()\-—“”\s]{2,50}(?:保险金|津贴|补贴|教育金|祝寿金|关爱金|年金|生存金))\s*[=＝]\s*([^。；;]+)/u);
  if (!match) return null;
  const liability = cleanLiability(match[1]);
  const formula = trim(`${liability} = ${match[2].replace(/\s+/gu, ' ')}`);
  return {
    liability,
    value: null,
    unit: '公式',
    basis: /日额|每日津贴/u.test(formula) ? '津贴日额' : /医疗费用|免赔额|报销/u.test(formula) ? '合理医疗费用' : '条款公式',
    formulaText: formula,
  };
}

function extractPercentOrAmountFormula(clause = '') {
  const text = normalizeOneLine(clause);
  const compact = compactText(text);
  const disabilityBaseRatio = compact.match(/以([^。；，,]{0,60}?(?:基本保险金额|基本保额|保险金额|保险金金额))为基数.{0,40}按.{0,36}(?:伤残|残疾).{0,24}(?:给付比例|比例)/u);
  if (disabilityBaseRatio) {
    const basis = normalizeBasis(disabilityBaseRatio[1] || '保险金额');
    return {
      liability: leadingLiabilityFromClause(text),
      value: null,
      unit: '公式',
      basis,
      formulaText: `${basis} × 伤残等级对应给付比例`,
    };
  }
  const disabilityRatio = compact.match(/([^。；，,]{0,42}?(?:基本保险金额|基本保额|保险金额|保险金金额)).{0,24}(?:乘以|×|x|X).{0,40}(?:伤残|残疾).{0,24}(?:比例|给付比例)/u);
  if (disabilityRatio) {
    const basis = normalizeBasis(disabilityRatio[1] || '保险金额');
    const leading = leadingLiabilityFromClause(text);
    const liability = (/伤残|残疾/u.test(leading) ? leading : '') || [...compact.matchAll(/[一-龥A-Za-z0-9（）()\-—“”]{2,42}?(?:伤残|残疾)[一-龥A-Za-z0-9（）()\-—“”]{0,12}保险金/gu)]
      .map((match) => cleanLiability(match[0]))
      .filter(Boolean)
      .at(0);
    return {
      liability,
      value: null,
      unit: '公式',
      basis,
      formulaText: `${basis} × 伤残等级对应给付比例`,
    };
  }
  const reverseDisabilityRatio = compact.match(/(?:伤残|残疾).{0,80}(?:给付比例|比例).{0,24}(?:乘以|×|x|X)([^。；，,]{0,52}?(?:基本保险金额|基本保额|保险金额|保险金金额))/u);
  if (reverseDisabilityRatio) {
    const basis = normalizeBasis(reverseDisabilityRatio[1] || '保险金额');
    return {
      liability: leadingLiabilityFromClause(text),
      value: null,
      unit: '公式',
      basis,
      formulaText: `${basis} × 伤残等级对应给付比例`,
    };
  }
  const equalPayout = compact.match(/按(?:照)?([^。；，,]{2,80}?(?:保险金金额|基本保险金额|基本保额|保险金额|保险费|保费|现金价值))[，,、]?(?:[^。；，,]{0,24})?(?:另行)?等额给付([^。；，,]{2,52}?(?:保险金|津贴|补贴|祝寿金|关爱金|年金|生存金))/u);
  if (equalPayout) {
    const basis = normalizeBasis(equalPayout[1]);
    const liability = cleanLiability(equalPayout[2]) || leadingLiabilityFromClause(text);
    return {
      liability,
      value: 100,
      unit: '%',
      basis,
      formulaText: `${liability} = ${basis} × 100%`,
    };
  }
  const directNamedAmount = compact.match(/按(?:照)?([^。；，,]{0,80}?(?:基本保险金额|基本保额|保险金额|保险金金额|已支付的保险费|实际交纳的保险费|实际交纳的可选责任的保险费|所交保险费|保险费|保费|现金价值))(?:向[^。；，,]{0,44}?)?给付([^。；，,]{2,52}?(?:保险金|津贴|补贴|祝寿金|关爱金|年金|生存金))/u);
  const directContext = directNamedAmount ? compact.slice(Math.max(0, directNamedAmount.index - 80), directNamedAmount.index + 160) : '';
  if (directNamedAmount && !/退还|无息退还|返还|等待期.{0,80}(?:退还|返还|所交保险费|保险费)/u.test(directContext)) {
    const basis = normalizeBasis(directNamedAmount[1]);
    const liability = cleanLiability(directNamedAmount[2]) || leadingLiabilityFromClause(text);
    return {
      liability,
      value: 100,
      unit: '%',
      basis,
      formulaText: `${liability} = ${basis} × 100%`,
    };
  }
  const percent = compact.match(/按(?:照)?([^。；，,]{0,42}?(?:基本保险金额|基本保额|保险金额|保险金金额|日额))(?:的)?(\d+(?:\.\d+)?)%/u)
    || compact.match(/([^。；，,]{0,42}?(?:基本保险金额|基本保额|保险金额|保险金金额|日额))(?:的)?(\d+(?:\.\d+)?)%/u);
  if (percent) {
    const basis = normalizeBasis(percent[1] || '基本保险金额');
    return {
      liability: leadingLiabilityFromClause(text),
      value: Number(percent[2]),
      unit: '%',
      basis,
      formulaText: `${basis} × ${percent[2]}%`,
    };
  }
  const multiple = compact.match(/按(?:照)?([^。；，,]{0,42}?(?:基本保险金额|基本保额|保险金额|保险金金额))(?:的)?(\d+(?:\.\d+)?)倍/u)
    || compact.match(/([^。；，,]{0,42}?(?:基本保险金额|基本保额|保险金额|保险金金额))(?:的)?(\d+(?:\.\d+)?)倍/u);
  if (multiple) {
    const basis = normalizeBasis(multiple[1] || '基本保险金额');
    return {
      liability: leadingLiabilityFromClause(text),
      value: Number(multiple[2]),
      unit: '倍',
      basis,
      formulaText: `${basis} × ${multiple[2]}倍`,
    };
  }
  if (/实际(?:住院)?(?:日数|天数).{0,20}(?:乘以|×|x|X).{0,20}日额|日额.{0,20}(?:乘以|×|x|X).{0,20}(?:日数|天数)/u.test(compact)) {
    return null;
  }
  const fullAmount = compact.match(/(?:按(?:照)?|给付|向[^。；，,]{0,24}给付)([^。；，,]{0,52}?(?:基本保险金额|基本保额|保险金额|保险金金额|日额))(?:给付|向|，|。|;|；|$)/u);
  if (fullAmount && !/乘以|给付比例|赔付比例/u.test(fullAmount[1]) && !/退还|返还|等待期内不承担/u.test(compact.slice(Math.max(0, fullAmount.index - 60), fullAmount.index + 120))) {
    const basis = normalizeBasis(fullAmount[1] || '基本保险金额');
    return {
      liability: leadingLiabilityFromClause(text),
      value: 100,
      unit: '%',
      basis,
      formulaText: `${basis} × 100%`,
    };
  }
  const amountEquals = compact.match(/(?:金额为|其金额为)([^。；，,]{0,32}?(?:基本保险金额|基本保额|保险金额|保险金金额|日额))/u);
  if (amountEquals) {
    const basis = normalizeBasis(amountEquals[1] || '基本保险金额');
    return {
      liability: leadingLiabilityFromClause(text),
      value: 100,
      unit: '%',
      basis,
      formulaText: `${basis} × 100%`,
    };
  }
  return null;
}

function extractMaxFormula(clause = '') {
  const text = normalizeOneLine(clause);
  const compact = compactText(text);
  if (!/(?:较大者|最大者|较大值)/u.test(compact) || !/给付/u.test(compact)) return null;
  const liability = leadingLiabilityFromClause(text);
  if (!liability || !/(保险金|津贴|补贴|祝寿金|关爱金|年金|生存金)/u.test(liability)) return null;
  const introIndex = compact.search(/(?:以下|下列)[一二两三四\d]+(?:项|者)?(?:中|的)?(?:金额)?(?:较大者|最大者|较大值)/u);
  if (introIndex < 0) return null;
  const numbered = [...compact.slice(introIndex).matchAll(/[（(]([1-9一二三四五六七八九十])[）)]([^（()。；;]{2,120})[。；;]?/gu)]
    .map((match) => normalizeBasis(match[2]))
    .filter((value) => /(基本保险金额|基本保额|保险金额|保险金金额|保险费|保费|现金价值)/u.test(value));
  const unique = [...new Set(numbered)];
  if (unique.length < 2) return null;
  return {
    liability,
    value: null,
    unit: '公式',
    basis: unique.join('、'),
    formulaText: `${liability} = max(${unique.join(', ')})`,
  };
}

function extractDirectNamedAmountFormulas(clause = '') {
  const compact = compactText(clause);
  const formulas = [];
  const seen = new Set();
  const pattern = /按(?:照)?([^。；，,]{0,80}?(?:基本保险金额|基本保额|保险金额|保险金金额|已支付的保险费|实际交纳的保险费|实际交纳的可选责任的保险费|所交保险费|保险费|保费|现金价值))(?:向[^。；，,]{0,44}?)?给付([^。；，,]{2,52}?(?:保险金|津贴|补贴|祝寿金|关爱金|年金|生存金))/gu;
  for (const match of compact.matchAll(pattern)) {
    const context = compact.slice(Math.max(0, (match.index ?? 0) - 80), (match.index ?? 0) + 180);
    if (/退还|无息退还|返还|等待期.{0,80}(?:退还|返还|所交保险费|保险费)/u.test(context)) continue;
    const basis = normalizeBasis(match[1]);
    const liability = cleanLiability(match[2]);
    if (!liability || /受益人/u.test(liability)) continue;
    const key = `${liability}\u001f${basis}`;
    if (seen.has(key)) continue;
    seen.add(key);
    formulas.push({
      clause: compact.slice(Math.max(0, (match.index ?? 0) - 120), Math.min(compact.length, (match.index ?? 0) + 260)),
      formula: {
        liability,
        value: 100,
        unit: '%',
        basis,
        formulaText: `${liability} = ${basis} × 100%`,
      },
    });
  }
  return formulas;
}

function extractMedicalFormula(clause = '') {
  const text = normalizeOneLine(clause);
  const compact = compactText(text);
  if (!/医疗|门诊|住院|救护车|护理/u.test(compact)) return null;
  const hasFormulaTerms = /免赔|报销|补偿|赔偿|给付比例|赔付比例|剩余金额|实际支出|医疗费用/u.test(compact);
  if (!hasFormulaTerms || !/给付/u.test(compact)) return null;
  const exact = extractExactFormula(text);
  if (exact) return exact;
  const liability = leadingLiabilityFromClause(text);
  if (!/医疗|门诊|住院|救护车|护理|齿科|药品|紧急费用|体检/u.test(liability)
    && /^可选(?:保险)?责任/u.test(compact)
      && !/^可选(?:保险)?责任[一二三四五六七八九十\d]*[:：]?[^。；]{0,80}(?:医疗|门诊|住院|救护车|护理|齿科|药品|紧急费用|体检)/u.test(compact)) {
    return null;
  }
  const percent = compact.match(/按(?:其余额|剩余金额|[^。；，,]{0,24}费用|[^。；，,]{0,24}金额)的?(\d+(?:\.\d+)?)%给付/u);
  if (!percent) {
    return null;
  }
  return {
    liability,
    value: Number(percent[1]),
    unit: '%',
    basis: /救护车/u.test(liability) ? '救护车费用' : /护理/u.test(liability) ? '护理费用' : '合理且必要医疗费用',
    formulaText: `医疗保险金 = (合理且必要医疗费用 - 已获补偿/报销费用 - 免赔额) × ${percent[1]}%`,
  };
}

function extractCumulativeBasicAmountLimitFormulas(clause = '') {
  const text = normalizeOneLine(clause);
  const compact = compactText(text);
  const formulas = [];
  const seen = new Set();
  const patterns = [
    /累计给付(?:的)?([^。；，,]{2,52}?(?:保险金|津贴|补贴|年金|生存金|教育金|祝寿金|关爱金))以([^。；，,]{0,52}?(?:基本保险金额|基本保额|保险金额|保险金金额))为限/gu,
    /累计给付(?:的)?([^。；，,]{2,52}?(?:保险金|津贴|补贴|年金|生存金|教育金|祝寿金|关爱金))达到([^。；，,]{0,52}?(?:基本保险金额|基本保额|保险金额|保险金金额))时/gu,
    /累计给付(?:的)?([^。；，,]{2,70}?(?:费用|费))达到([^。；，,]{0,70}?(?:保险金额|保险金金额|基本保险金额|基本保额))时/gu,
    /给付(?:的)?([^。；，,]{2,70}?(?:费用|费))达到([^。；，,]{0,70}?(?:保险金额|保险金金额|基本保险金额|基本保额))时/gu,
  ];
  for (const pattern of patterns) {
    for (const limit of compact.matchAll(pattern)) {
      const liability = cleanLiability(limit[1] || leadingLiabilityFromClause(text));
      const basis = normalizeBasis(limit[2] || '基本保险金额');
      if (!liability || /基本保险金额|基本保额|保险金额|保险金金额/u.test(liability)) continue;
      const key = `${liability}\u001f${basis}`;
      if (seen.has(key)) continue;
      seen.add(key);
      formulas.push({
        liability,
        value: 100,
        unit: '%',
        basis,
        formulaText: `${liability}累计给付上限 = ${basis}`,
        condition: '累计给付上限',
      });
    }
  }
  return formulas;
}

function parseCurrencyAmount(value = '', unit = '') {
  const numeric = Number(String(value).replace(/,/gu, ''));
  if (!Number.isFinite(numeric)) return null;
  return /万/u.test(unit) ? numeric * 10000 : numeric;
}

function extractCurrencyLimitFormulas(clause = '') {
  const compact = compactText(clause);
  const formulas = [];
  const seen = new Set();
  const pattern = /([^。；，,]{1,32}?(?:费用|费))以(\d{1,3}(?:,\d{3})*|\d+(?:\.\d+)?)(万?元)(?:人民币)?为限/gu;
  for (const match of compact.matchAll(pattern)) {
    const liability = cleanLiability(match[1]);
    const value = parseCurrencyAmount(match[2], match[3]);
    if (!liability || value === null) continue;
    const key = `${liability}\u001f${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    formulas.push({
      liability: `${liability}上限`,
      value,
      unit: '元',
      basis: '人民币',
      formulaText: `${liability}上限 = ${value}元`,
      condition: '费用上限',
      coverageType: '救援服务',
    });
  }
  return formulas;
}

function extractMaximumLimitFormula(clause = '') {
  const text = normalizeOneLine(clause);
  const compact = compactText(text);
  const match = compact.match(/(?:该项保险责任的)?(?:最高给付限额|给付限额|基本保险金额)为(\d{1,3}(?:,\d{3})*|\d+(?:\.\d+)?)(万?)(?:元)?/u);
  if (!match) return null;
  const value = parseCurrencyAmount(match[1], `${match[2] || ''}元`);
  if (value === null) return null;
  const liability = leadingLiabilityFromClause(text);
  const optionalLabel = compact.match(/可选(?:保险)?责任[一二三四五六七八九十\d]*/u)?.[0];
  const limitLiability = /保险金|津贴|补贴|祝寿金|关爱金|年金|生存金/u.test(liability)
    ? liability
    : `${optionalLabel || cleanLiability(liability) || '可选责任'}给付限额`;
  return {
    liability: limitLiability,
    value,
    unit: '元',
    basis: '条款载明最高给付限额',
    formulaText: `${limitLiability} = ${value}元`,
    condition: '最高给付限额',
  };
}

function extractOptionalSavingsFormulas(section = '') {
  const text = normalizeOneLine(section);
  const compact = compactText(text);
  const formulas = [];
  const birthday = compact.match(/祝寿金被保险人于([^。；，,]{2,48})生存[^。；]{0,100}?按([^。；，,]{0,80}?可选责任的保险金额)给付祝寿金/u);
  if (birthday) {
    const basis = normalizeBasis(birthday[2]);
    formulas.push({
      clause: text.slice(Math.max(0, text.indexOf('祝寿金') - 20), Math.min(text.length, text.indexOf('祝寿金') + 320)),
      formula: {
        liability: '祝寿金',
        value: 100,
        unit: '%',
        basis,
        formulaText: `祝寿金 = ${basis} × 100%`,
        condition: trim(birthday[1]),
        coverageType: '现金流',
      },
    });
  }

  const death = compact.match(/身故或身体全残保险金被保险人在领取祝寿金之前身故或身体全残[^。；]{0,260}?以下二者之较大者与([^。；，,]{0,80}?可选责任的累积红利保险金额对应的现金价值)二者之和给付身故或身体全残保险金[^（(]{0,120}[（(]1[）)]([^。；，,]{0,80}?可选责任的保险费)[；;。]?[（(]2[）)]([^。；，,]{0,100}?可选责任的基本保险金额对应的现金价值)的(\d+(?:\.\d+)?)倍/u);
  if (death) {
    const dividendCashValue = normalizeBasis(death[1]);
    const paidPremium = normalizeBasis(death[2]);
    const basicCashValue = normalizeBasis(death[3]);
    const multiple = Number(death[4]);
    formulas.push({
      clause: text.slice(Math.max(0, text.indexOf('身故或身体全残保险金') - 20), Math.min(text.length, text.indexOf('身故或身体全残保险金') + 520)),
      formula: {
        liability: '身故或身体全残保险金',
        value: null,
        unit: '公式',
        basis: `${paidPremium}、${basicCashValue}、${dividendCashValue}`,
        formulaText: `身故或身体全残保险金 = max(${paidPremium}, ${basicCashValue} × ${multiple}倍) + ${dividendCashValue}`,
        condition: '领取祝寿金之前身故或身体全残',
        coverageType: '人寿保障',
      },
    });
  }

  return formulas;
}

function optionalTableExcerpt(section = '') {
  const text = normalizeOneLine(section);
  const starts = [...text.matchAll(/可选(?:保险)?责任/gu)];
  for (let i = starts.length - 1; i >= 0; i -= 1) {
    const start = starts[i].index ?? -1;
    if (start < 0) continue;
    const rest = text.slice(start);
    if (!/年限额|给付限额|不设单项最高限额|％|%/u.test(rest.slice(0, 900))) continue;
    const endMatch = rest.match(/(?:注[:：]上表|三[、.．]\s*责任免除|责任免除|健康管理服务)/u);
    return trim(rest.slice(0, endMatch?.index ?? 1200));
  }
  return '';
}

function extractOptionalTableFormulas(section = '') {
  const table = optionalTableExcerpt(section);
  if (!table) return [];
  const compact = compactText(table);
  const formulas = [];
  const seen = new Set();
  const add = (formula) => {
    const liability = cleanLiability(formula.liability);
    if (!liability) return;
    const key = [liability, formula.value, formula.unit, formula.condition].join('\u001f');
    if (seen.has(key)) return;
    seen.add(key);
    formulas.push({
      clause: table,
      formula: {
        ...formula,
        liability,
      },
    });
  };

  const annualLimitAndRatioPattern = /(?:[一二三四五六七八九十]+[、.．])?([一-龥A-Za-z0-9（）()\-—“”]{2,42}?保险金)年限额(\d{1,3}(?:,\d{3})*|\d+(?:\.\d+)?)(万?元)(\d+(?:\.\d+)?)\s*[％%]/gu;
  for (const match of compact.matchAll(annualLimitAndRatioPattern)) {
    const liability = match[1];
    const amount = parseCurrencyAmount(match[2], match[3]);
    const ratio = Number(match[4]);
    if (amount !== null) {
      add({
        liability,
        value: amount,
        unit: '元',
        basis: '条款载明年限额',
        formulaText: `${cleanLiability(liability)}年限额 = ${amount}元`,
        condition: '年限额',
      });
    }
    if (Number.isFinite(ratio)) {
      add({
        liability,
        value: ratio,
        unit: '%',
        basis: '条款载明给付比例',
        formulaText: `${cleanLiability(liability)}给付比例 = ${ratio}%`,
        condition: '给付比例',
      });
    }
  }

  const benefitAnnualLimitPattern = /(?:[一二三四五六七八九十]+[、.．])?([一-龥A-Za-z0-9（）()\-—“”]{2,42}?保险金)保险金年限额(\d{1,3}(?:,\d{3})*|\d+(?:\.\d+)?)(万?元)/gu;
  for (const match of compact.matchAll(benefitAnnualLimitPattern)) {
    const liability = match[1];
    const amount = parseCurrencyAmount(match[2], match[3]);
    if (amount === null) continue;
    add({
      liability,
      value: amount,
      unit: '元',
      basis: '条款载明年限额',
      formulaText: `${cleanLiability(liability)}年限额 = ${amount}元`,
      condition: '年限额',
    });
  }

  const feeRatioPattern = /(?:^|(?<=[％%元]))([一-龥A-Za-z0-9（）()\-—“”]{2,42}?(?:医疗费|费用))不设单项最高限额(\d+(?:\.\d+)?)\s*[％%]/gu;
  for (const match of compact.matchAll(feeRatioPattern)) {
    const liability = match[1];
    const ratio = Number(match[2]);
    if (!Number.isFinite(ratio)) continue;
    add({
      liability,
      value: ratio,
      unit: '%',
      basis: '条款载明给付比例',
      formulaText: `${cleanLiability(liability)}给付比例 = ${ratio}%`,
      condition: '给付比例',
      coverageType: '医疗保障',
    });
  }

  return formulas;
}

function extractAllowanceFormula(clause = '') {
  const text = normalizeOneLine(clause);
  const compact = compactText(text);
  if (!/津贴|补贴|日额|每日/u.test(compact)) return null;
  const exact = extractExactFormula(text);
  if (exact && /日数|天数|日额|每日/u.test(exact.formulaText)) return exact;
  const basicAmountDailyRate = compact.match(/实际(?:住院)?(?:日数|天数).{0,24}(?:乘以|×|x|X).{0,36}([^。；，,]{0,30}?(?:基本保险金额|基本保额|保险金额|保险金金额))(?:的)?(\d+(?:\.\d+)?)%/u)
    || compact.match(/([^。；，,]{0,30}?(?:基本保险金额|基本保额|保险金额|保险金金额))(?:的)?(\d+(?:\.\d+)?)%.{0,36}(?:乘以|×|x|X).{0,24}实际(?:住院)?(?:日数|天数)/u);
  if (basicAmountDailyRate) {
    const basis = normalizeBasis(basicAmountDailyRate[1] || '基本保险金额');
    return {
      liability: leadingLiabilityFromClause(text),
      value: Number(basicAmountDailyRate[2]),
      unit: '%',
      basis,
      formulaText: `津贴保险金 = ${basis} × ${basicAmountDailyRate[2]}% × 实际住院日数`,
    };
  }
  if (/实际(?:住院)?(?:日数|天数).*?(?:乘以|×|x|X).*?日额|(?:住院)?日数扣除.*?日额.*?乘积|日额.*?(?:乘以|×|x|X).*?(?:日数|天数)/u.test(compact)) {
    const hasDeductible = /免赔|扣除|-\d+日|-免赔日数/u.test(compact);
    return {
      liability: leadingLiabilityFromClause(text),
      value: null,
      unit: '公式',
      basis: '津贴日额',
      formulaText: hasDeductible
        ? '津贴保险金 = (实际住院日数 - 免赔日数) × 津贴日额'
        : '津贴保险金 = 实际住院日数 × 津贴日额',
    };
  }
  return null;
}

function extractWaiverFormula(clause = '') {
  const compact = compactText(clause);
  if (!/豁免/u.test(compact) || !/保险费/u.test(compact)) return null;
  return {
    liability: /豁免保险费/u.test(compact) ? '豁免保险费' : liabilityFromClause(clause, '豁免保险费'),
    value: null,
    unit: '公式',
    basis: '后续应交保险费',
    formulaText: '豁免后续应交保险费',
  };
}

function extractCountIndicators(clause = '') {
  const text = normalizeOneLine(clause);
  const compact = compactText(text);
  const records = [];
  for (const match of compact.matchAll(/(轻度疾病|中度疾病|重大疾病|重度疾病|特定疾病|少儿特定重大疾病|恶性肿瘤[^，。；]{0,8})共(\d+)种/gu)) {
    records.push({
      liability: `${match[1]}种数`,
      value: Number(match[2]),
      unit: '种',
      basis: '疾病定义数量',
      formulaText: '',
      coverageType: '疾病保障',
    });
  }
  for (const match of compact.matchAll(/(?:累计)?给付次数以([一二两三四五六七八九十\d]+)次为限|最多给付([一二两三四五六七八九十\d]+)次/gu)) {
    const value = numericChinese(match[1] || match[2]);
    if (!value) continue;
    records.push({
      liability: '责任给付次数上限',
      value,
      unit: '次',
      basis: liabilityFromClause(text),
      formulaText: '',
      coverageType: '规则参数',
    });
  }
  return records;
}

function splitBenefitClauses(section = '') {
  const text = normalizeOneLine(section);
  const split = text
    .replace(/((?:[（(]?\d+[）)]|[一二三四五六七八九十]+[、.．]|(?:\d+[.．])+\d*)\s*[一-龥A-Za-z0-9（）()\-—“”]{2,40}(?:保险金|津贴|补贴|豁免保险费|豁免|教育金|祝寿金|关爱金|年金|生存金))/gu, '\n$1')
    .replace(/(可选(?:保险)?责任\s*[一二三四五六七八九十\d]*[:：]?)/gu, '\n$1')
    .split(/\n+|(?=（\d+）)|(?=[。；;]\s*(?:[（(]?\d+[）)]|[一二三四五六七八九十]+[、.．]))/u)
    .map((item) => trim(item.replace(/^[。；;]\s*/u, '')))
    .filter((item) => item.length >= 24 && /保险金|津贴|补贴|教育金|祝寿金|关爱金|年金|生存金|给付|豁免|医疗费用|费用|为限/u.test(item));
  return split.length ? split : [text].filter(Boolean);
}

function isGenericOptionalIntro(row = {}, section = '') {
  if (optionalSuffix(row.liability)) return false;
  const compact = compactText(section.slice(0, 500));
  if (/^可选(?:保险)?责任.{0,80}合同生效后.{0,40}作为合同项下的保险责任/u.test(compact)) return false;
  if (/^可选(?:保险)?责任[一二三四五六七八九十\d]*[:：]?.{0,80}(?:保险金|津贴|补贴|豁免保险费|豁免|教育金|祝寿金|关爱金|年金|生存金)/u.test(compact)) return false;
  if (/^可选(?:保险)?责任.{0,160}(?:祝寿金|身故或身体全残保险金)/u.test(compact)) return false;
  if (/^可选(?:保险)?责任/u.test(compact)
    && /按(?:照)?.{0,100}(?:基本保险金额|基本保额|保险金额|保险金金额)(?:向.{0,50})?给付.{0,40}(?:保险金|津贴|补贴|教育金|祝寿金|关爱金|年金|生存金)/u.test(compact)) {
    return false;
  }
  if (/^可选(?:保险)?责任.{0,420}基本(?:保险)?责任/u.test(compact)) return true;
  if (/^可选(?:保险)?责任[,，]?您需要交纳/u.test(compact)) return true;
  if (/^可选(?:保险)?责任(?:可以|为本合同可选择|为本合同可选择的部分|可以与|未在保险单上载明|未投保)/u.test(compact)) return true;
  if (/^可选(?:保险)?责任.{0,120}(?:基本责任|必选责任)/u.test(compact)
    && !/^可选(?:保险)?责任[:：]?[一-龥A-Za-z0-9（）()\-—“”]{2,42}(?:保险金|津贴|补贴|豁免保险费|豁免)/u.test(compact)) {
    return true;
  }
  return false;
}

function clauseHasBenefitFormula(clause = '') {
  const compact = compactText(clause);
  if (/等待期.{0,80}(?:不承担|退还|返还).{0,40}(?:保险费|保费)/u.test(compact) && !/(?:保险金|津贴|豁免保险费).{0,120}(?:基本保险金额|保险金额|日额|给付比例|赔付比例|=|＝|乘以|×)/u.test(compact)) {
    return false;
  }
  return /基本保险金额|基本保额|保险金额|保险金金额|保险费|保费|现金价值|给付比例|赔付比例|免赔额|实际支出|日额|每日|年限额|最高给付限额|不设单项最高限额|较大者|最大者|等额|[％%]|=|＝|乘以|×|豁免|\d{1,3}(?:,\d{3})*万?元(?:人民币)?为限/u.test(compact);
}

function indicatorIdFor({ row, liability, formulaText = '', condition = '', ordinal = 0 } = {}) {
  return `ind_opt_repair_${sha1([VERSION, row.company, row.productName, row.id, liability, formulaText, condition, ordinal].join('\u001f'))}`;
}

function buildIndicator({ row, source, section, clause, formula, ordinal = 0 }) {
  const rawLiability = formula.liability || liabilityFromClause(clause, row.liability);
  const liability = /^可选(?:保险)?责任[一二三四五六七八九十\d]*给付限额$/u.test(rawLiability)
    ? rawLiability
    : cleanLiability(rawLiability);
  const coverageType = formula.coverageType || classifyCoverageType(liability, clause);
  const sourceInfo = source ? sourceFields(source) : {};
  const now = new Date().toISOString();
  const condition = trim(formula.condition || '');
  const indicator = {
    id: indicatorIdFor({ row, liability, formulaText: formula.formulaText, condition, ordinal }),
    version: VERSION,
    company: row.company,
    productName: row.productName,
    coverageType,
    liability,
    value: formula.value ?? null,
    valueText: formula.value === undefined || formula.value === null ? '' : String(formula.value),
    unit: trim(formula.unit),
    basis: trim(formula.basis),
    formulaText: trim(formula.formulaText),
    condition,
    extractionMethod: 'pending_optional_responsibility_rule_repair',
    responsibilityScope: 'optional',
    optionalResponsibilityId: row.id,
    quantificationStatus: 'quantified',
    sourceRecordId: trim(sourceInfo.sourceRecordId || row.payload?.sourceRecordId),
    sourceUrl: trim(sourceInfo.sourceUrl || row.payload?.sourceUrl),
    sourceTitle: trim(sourceInfo.sourceTitle || row.payload?.sourceTitle),
    sourceExcerpt: trim(clause || section).slice(0, 900),
    sourceEvidenceLevel: trim(sourceInfo.sourceRecordId || row.payload?.sourceRecordId) ? 'official_terms' : '',
    updatedAt: now,
  };
  return indicator;
}

function extractIndicatorsForRow(row = {}, section = '', source = null) {
  if (isGenericOptionalIntro(row, section)) return [];
  const clauses = splitBenefitClauses(section);
  const indicators = [];
  let ordinal = 0;
  for (const { clause, formula } of extractOptionalSavingsFormulas(section)) {
    indicators.push(buildIndicator({ row, source, section, clause, formula, ordinal: ordinal += 1 }));
  }
  const sectionMaxFormula = extractMaxFormula(section);
  if (sectionMaxFormula) {
    indicators.push(buildIndicator({ row, source, section, clause: section, formula: sectionMaxFormula, ordinal: ordinal += 1 }));
  }
  for (const { clause, formula } of extractDirectNamedAmountFormulas(section)) {
    indicators.push(buildIndicator({ row, source, section, clause, formula, ordinal: ordinal += 1 }));
  }
  for (const { clause, formula } of extractOptionalTableFormulas(section)) {
    indicators.push(buildIndicator({ row, source, section, clause, formula, ordinal: ordinal += 1 }));
  }
  for (const clause of clauses) {
    if (!clauseHasBenefitFormula(clause)) continue;
    const countIndicators = extractCountIndicators(clause);
    for (const formula of countIndicators) {
      indicators.push(buildIndicator({ row, source, section, clause, formula, ordinal: ordinal += 1 }));
    }
    const exact = extractExactFormula(clause);
    const formulas = exact
      ? [exact]
      : [
          extractMaxFormula(clause),
          extractPercentOrAmountFormula(clause),
          ...extractCumulativeBasicAmountLimitFormulas(clause),
          ...extractCurrencyLimitFormulas(clause),
          extractMaximumLimitFormula(clause),
          extractMedicalFormula(clause),
          extractAllowanceFormula(clause),
          extractWaiverFormula(clause),
        ].filter(Boolean);
    for (const formula of formulas) {
      indicators.push(buildIndicator({ row, source, section, clause, formula, ordinal: ordinal += 1 }));
    }
  }
  const unique = new Map();
  for (const indicator of indicators) {
    const key = [indicator.liability, indicator.value, indicator.unit, indicator.basis, indicator.formulaText].map(compactText).join('\u001f');
    if (!unique.has(key)) unique.set(key, indicator);
  }
  return [...unique.values()].filter((indicator) => {
    const text = compactText(indicator.sourceExcerpt);
    if (!indicator.liability || !indicator.unit) return false;
    if (/等待期退费|退还已交|不承担原保险金/u.test(indicator.formulaText)) return false;
    if (/基本保险金|基本保险金额|达到|数额之和|金额以|给付以|与本公司约定|比例给付/u.test(indicator.liability)) return false;
    if (/^可选责任[:：]?\d+[^。；]{0,120}(?:等待期|犹豫期|保险区域)/u.test(text)) return false;
    if (/保障表|保障计划表|保险保障表/u.test(text) && !/[=＝]/u.test(text) && !/[=＝]/u.test(indicator.formulaText)) return false;
    if (/(?:基本责任|基本保险责任|必选责任)/u.test(text)
      && !/^可选(?:保险)?责任[一二三四五六七八九十\d]*[:：]?[一-龥A-Za-z0-9（）()\-—“”]{2,42}(?:保险金|津贴|补贴|豁免保险费|豁免)/u.test(text)) {
      return false;
    }
    return /(保险金|津贴|补贴|豁免|祝寿金|年金|生存金|教育金|种数|次数上限|费用|费上限|给付限额|限额)/u.test(indicator.liability)
      || /(保险金|津贴|补贴|豁免|祝寿金|年金|生存金|教育金|疾病共|给付次数|费用达到|最高给付限额|以\d+(?:,\d+)*元人民币为限)/u.test(text);
  });
}

function unresolvedReason(row = {}, section = '', reason = '') {
  const compact = compactText(section || row.payload?.sourceExcerpt);
  if (!compact) return reason || 'source_excerpt_missing';
  if (compact.length < 120) return 'source_excerpt_too_short';
  if (/可选择的部分|可以选择|承担以下保险责任/u.test(compact) && !/(?:保险金|津贴|豁免).{0,80}(?:给付|基本保险金额|保险金额|赔付比例|给付比例|日额|=|＝)/u.test(compact)) {
    return 'optional_intro_without_benefit_formula';
  }
  if (/等待期/u.test(compact) && !/(?:保险金|津贴|豁免).{0,120}(?:基本保险金额|保险金额|日额|给付比例|赔付比例|=|＝|乘以|×)/u.test(compact)) {
    return 'waiting_period_without_benefit_formula';
  }
  return reason || 'no_calculable_formula';
}

function loadRows(db) {
  return {
    optionalRows: db.prepare(`
      SELECT id, company, product_name, liability, payload
        FROM optional_responsibility_records
       WHERE json_extract(payload, '$.quantificationStatus') = 'pending_review'
       ORDER BY company, product_name, liability, id
    `).all().map(normalizeOptionalRow),
    knowledgeRows: db.prepare('SELECT id, company, product_name, url, payload FROM knowledge_records').all().map(normalizeKnowledgeRow),
  };
}

export function buildPendingOptionalResponsibilityRepairPlan({ optionalRows = [], knowledgeRows = [], now = new Date().toISOString() } = {}) {
  const knowledgeById = new Map(knowledgeRows.map((row) => [trim(row.id), row]));
  const indicatorUpserts = [];
  const optionalUpdates = [];
  const unresolved = [];
  const reasonCounts = {};
  const productCounts = new Map();

  for (const row of optionalRows) {
    const { section, source, reason } = expandedOptionalSection(row, knowledgeById);
    const indicators = extractIndicatorsForRow(row, section, source);
    if (!indicators.length) {
      const unresolvedItem = {
        id: row.id,
        company: row.company,
        productName: row.productName,
        liability: row.liability,
        reason: unresolvedReason(row, section, reason),
        sourceRecordId: trim(row.payload?.sourceRecordId),
        excerptLength: trim(section || row.payload?.sourceExcerpt).length,
        excerpt: trim(section || row.payload?.sourceExcerpt).slice(0, 240),
      };
      unresolved.push(unresolvedItem);
      reasonCounts[unresolvedItem.reason] = (reasonCounts[unresolvedItem.reason] || 0) + 1;
      continue;
    }
    const existingIds = Array.isArray(row.payload?.indicatorIds)
      ? row.payload.indicatorIds.map(trim).filter(Boolean)
      : [];
    const indicatorIds = [...new Set([...existingIds, ...indicators.map((indicator) => indicator.id)])];
    const sourceInfo = source ? sourceFields(source) : {};
    const payload = {
      ...row.payload,
      indicatorIds,
      quantificationStatus: 'quantified',
      quantificationReason: '',
      sourceExcerpt: trim(section || row.payload?.sourceExcerpt).slice(0, 4000),
      sourceRecordId: trim(sourceInfo.sourceRecordId || row.payload?.sourceRecordId),
      sourceUrl: trim(sourceInfo.sourceUrl || row.payload?.sourceUrl),
      sourceTitle: trim(sourceInfo.sourceTitle || row.payload?.sourceTitle),
      sourceEvidenceLevel: trim(sourceInfo.sourceRecordId || row.payload?.sourceRecordId) ? 'official_terms' : row.payload?.sourceEvidenceLevel,
      governanceReasons: [...new Set([...(Array.isArray(row.payload?.governanceReasons) ? row.payload.governanceReasons : []), 'quantify_pending_optional_responsibility'])],
      updatedAt: now,
    };
    optionalUpdates.push({
      row: {
        ...row,
        payload,
      },
      indicatorIds,
      indicatorCount: indicators.length,
    });
    indicatorUpserts.push(...indicators.map((indicator) => ({ ...indicator, updatedAt: now })));
    const productKey = `${row.company}|${row.productName}`;
    productCounts.set(productKey, (productCounts.get(productKey) || 0) + 1);
  }

  const uniqueIndicators = [...new Map(indicatorUpserts.map((indicator) => [indicator.id, indicator])).values()];
  return {
    summary: {
      pendingInput: optionalRows.length,
      optionalRecordUpdates: optionalUpdates.length,
      indicatorUpserts: uniqueIndicators.length,
      unresolved: unresolved.length,
      resolvedProducts: productCounts.size,
      reasonCounts,
      unresolvedSample: unresolved.slice(0, 20),
      resolvedSample: optionalUpdates.slice(0, 20).map((item) => ({
        id: item.row.id,
        company: item.row.company,
        productName: item.row.productName,
        liability: item.row.liability,
        indicatorCount: item.indicatorCount,
        indicatorIds: item.indicatorIds,
      })),
    },
    indicatorUpserts: uniqueIndicators,
    optionalUpdates,
    unresolved,
  };
}

function applyPlan(db, plan, now = new Date().toISOString()) {
  const upsertIndicator = db.prepare(`
    INSERT INTO insurance_indicator_records (id, company, product_name, coverage_type, liability, payload)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      company = excluded.company,
      product_name = excluded.product_name,
      coverage_type = excluded.coverage_type,
      liability = excluded.liability,
      payload = excluded.payload
  `);
  const updateOptional = db.prepare(`
    UPDATE optional_responsibility_records
       SET company = ?, product_name = ?, liability = ?, payload = ?
     WHERE id = ?
  `);
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const indicator of plan.indicatorUpserts) {
      upsertIndicator.run(
        indicator.id,
        indicator.company,
        indicator.productName,
        indicator.coverageType,
        indicator.liability,
        JSON.stringify(indicator),
      );
    }
    for (const { row } of plan.optionalUpdates) {
      updateOptional.run(row.company, row.productName, row.liability, JSON.stringify(row.payload), row.id);
    }
    for (const [key, value] of [
      ['pending_optional_responsibility_indicators_repaired_at', now],
      ['insurance_indicator_records_updated_at', now],
      ['optional_responsibility_records_updated_at', now],
      ['updated_at', now],
    ]) {
      db.prepare(`
        INSERT INTO app_meta (key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(key, value);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function countPending(db) {
  return db.prepare(`
    SELECT COUNT(*) AS count
      FROM optional_responsibility_records
     WHERE json_extract(payload, '$.quantificationStatus') = 'pending_review'
  `).get().count;
}

export function repairPendingOptionalResponsibilityIndicators({ dbPath, dryRun = false, now = new Date().toISOString() } = {}) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout = 10000');
  try {
    const beforePending = countPending(db);
    const plan = buildPendingOptionalResponsibilityRepairPlan({ ...loadRows(db), now });
    if (!dryRun) applyPlan(db, plan, now);
    const afterPending = dryRun ? beforePending - plan.optionalUpdates.length : countPending(db);
    return {
      dbPath,
      dryRun,
      beforePending,
      afterPending,
      summary: plan.summary,
      samples: {
        indicators: plan.indicatorUpserts.slice(0, 20).map((indicator) => ({
          id: indicator.id,
          productName: indicator.productName,
          liability: indicator.liability,
          value: indicator.value,
          unit: indicator.unit,
          basis: indicator.basis,
          formulaText: indicator.formulaText,
          optionalResponsibilityId: indicator.optionalResponsibilityId,
        })),
        optionalUpdates: plan.optionalUpdates.slice(0, 20).map((item) => ({
          id: item.row.id,
          productName: item.row.productName,
          liability: item.row.liability,
          indicatorCount: item.indicatorCount,
        })),
        unresolved: plan.unresolved.slice(0, 20),
      },
    };
  } finally {
    db.close();
  }
}

async function main() {
  const explicitDbPath = trim(readArg('db-path'));
  const dbPaths = explicitDbPath
    ? [path.resolve(explicitDbPath)]
    : DEFAULT_DB_PATHS;
  const dryRun = hasFlag('dry-run');
  const now = new Date().toISOString();
  const backups = dryRun ? {} : Object.fromEntries(await Promise.all(dbPaths.map(async (dbPath) => [dbPath, await backupSqlite(dbPath)])));
  const results = dbPaths.map((dbPath) => repairPendingOptionalResponsibilityIndicators({ dbPath, dryRun, now }));
  const report = {
    ok: true,
    dryRun,
    generatedAt: now,
    dbPaths,
    backups,
    results,
  };
  const outputDir = path.join(projectRoot, 'outputs');
  await fs.mkdir(outputDir, { recursive: true });
  const reportPath = path.join(outputDir, `pending-optional-responsibility-repair-${now.replace(/[:.]/gu, '-')}.json`);
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ ...report, reportPath }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
