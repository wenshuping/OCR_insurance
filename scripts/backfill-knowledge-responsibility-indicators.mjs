import crypto from 'node:crypto';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { indicatorCalculationPayloadFields } from '../src/indicator-calculation.mjs';
import { deriveIndicatorProductKeys } from '../server/policy-derived-results.service.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const DEFAULT_DB_PATH = path.join(projectRoot, '.runtime', 'local', 'policy-ocr.sqlite');
const VERSION = '2026-06-14-knowledge-responsibility-indicator-backfill';

function trim(value) {
  return String(value ?? '').trim();
}

export function normalizeSpaces(value) {
  return trim(value)
    .normalize('NFKC')
    .replace(/\r/gu, '\n')
    .replace(/\u00a0/gu, ' ')
    .replace(/\s+/gu, ' ');
}

function parsePayload(value, fallback = {}) {
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

function parseIdList(value) {
  return uniqueStrings(String(value || '').split(','))
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item) && item > 0);
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function sha1(value, length = 18) {
  return crypto.createHash('sha1').update(value).digest('hex').slice(0, length);
}

function uniqueStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    const text = trim(value);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
}

function tableExists(db, tableName) {
  return Boolean(db.prepare('SELECT name FROM sqlite_master WHERE type = ? AND name = ?').get('table', tableName));
}

function limitText(value, max = 1200) {
  const text = normalizeSpaces(value);
  return text.length > max ? `${text.slice(0, max - 12)}...已截断` : text;
}

export function normalizeLookupText(value) {
  return normalizeSpaces(value).replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();
}

function escapeRegExp(value) {
  return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

const BENEFIT_TITLE_SUFFIX = '保\\s*险\\s*金(?!\\s*额)|补\\s*偿\\s*金|给\\s*付\\s*金|津贴|年金|满期金|生存金|祝寿金|贺寿金|贺岁金|长寿金|关爱金|教育金|婚嫁金|立业金|创业金|深造金|确诊金|慰问金|豁\\s*免\\s*保\\s*险\\s*费|豁免';
const STANDALONE_BENEFIT_TITLES = '年金|养老金|养老保险金|护理保险金|工伤补助金|失能收入保险金|失能收入损失保险金|满期金|生存金|祝寿金|贺寿金|贺岁金|长寿金|关爱金|教育金|婚嫁金|立业金|创业金|深造金|确诊金|慰问金|豁\\s*免\\s*保\\s*险\\s*费';
const CASHFLOW_TITLE_TERMS = '年金|养老金|养老|养老保险金|祝寿|贺寿|贺岁|长寿|生存金|生存保险金|满期|教育金|高中教育|大学教育|深造|婚嫁|立业|创业|关爱金|关爱保险金|研学深造|特别保险金';
const AMOUNT_BASIS_PATTERN = '有效保险金额|意外伤害基本保险金额|基本保险金额|基本保额|保险金额';
const AMOUNT_EQUALS_BASIS_PATTERN = '扩展重度疾病保险金额|重度疾病保险金额|轻度疾病保险金额|特定疾病保险金额|妊娠并发症保险金额|儿童先天性疾病保险金额|意外伤害基本保险金额|有效保险金额|基本保险金额|基本保额|保险金额';
const PAID_PREMIUM_PATTERN = '已\\s*交(?:\\s*纳)?(?:保险费|保费)|累计已\\s*交(?:保险费|保费)|已\\s*支付(?:保险费|保费)|实际\\s*交纳(?:的)?(?:保险费|保费)|所\\s*交(?:保险费|保费)|已经\\s*交\\s*付[^。；，,]{0,18}(?:保险费|保费)';

function canonicalAmountBasis(rawBasis, context = '') {
  const basis = normalizeSpaces(rawBasis);
  const compact = normalizeSpaces(context).replace(/\s+/gu, '');
  if (/基本保险金额(?:与|和)累积红利保险金额(?:二者)?之和/u.test(compact)) return '有效保险金额';
  return basis;
}

function chinesePercentToNumber(text) {
  const normalized = normalizeSpaces(text);
  if (/百分之(?:一百|百)/u.test(normalized)) return 100;
  const digitMatch = normalized.match(/百分之(\d+(?:\.\d+)?)/u);
  if (digitMatch?.[1]) return Number(digitMatch[1]);
  const values = {
    九十: 90,
    八十: 80,
    七十: 70,
    六十: 60,
    五十: 50,
    四十: 40,
    三十: 30,
    二十: 20,
    十: 10,
  };
  for (const [word, value] of Object.entries(values)) {
    if (normalized.includes(`百分之${word}`)) return value;
  }
  return null;
}

function explicitPercentFromText(text) {
  const normalized = normalizeSpaces(text);
  const percent = normalized.match(/(\d+(?:\.\d+)?)\s*[％%]/u);
  if (percent?.[1]) return percent[1];
  const chinesePercent = chinesePercentToNumber(normalized);
  return Number.isFinite(chinesePercent) && chinesePercent > 0 ? String(chinesePercent) : '';
}

function explicitMedicalPercentFromText(text) {
  const normalized = normalizeSpaces(text);
  const compact = normalized.replace(/\s+/gu, '');
  if (/未在[^。；]{0,60}(?:指定|约定)[^。；]{0,60}(?:机构|医院|药店)[^。；]{0,80}(?:\d+(?:\.\d+)?[％%]|百分之[一二三四五六七八九十百\d.]+)/u.test(compact)) {
    return '';
  }
  if (/未以[^。；]{0,80}(?:基本医疗保险|社保|公费医疗)[^。；]{0,120}(?:\d+(?:\.\d+)?[％%]|百分之[一二三四五六七八九十百\d.]+)/u.test(compact)) {
    return '';
  }
  const numericPatterns = [
    /(?:给付比例|赔付比例)\s*(\d+(?:\.\d+)?)\s*[％%](?!\s*\d)/u,
    /(?:给付比例|赔付比例)\s*(?:为|按|=|：|:)\s*(\d+(?:\.\d+)?)\s*[％%]/u,
    /(?:按|按照)\s*(\d+(?:\.\d+)?)\s*[％%][^。；，,]{0,16}?(?:比例)?(?:给付|赔付)/u,
    /(\d+(?:\.\d+)?)\s*[％%][^。；，,]{0,16}?(?:比例给付|比例赔付)/u,
  ];
  for (const pattern of numericPatterns) {
    const match = normalized.match(pattern);
    if (match?.[1]) return match[1];
  }
  const chinesePatterns = [
    /(?:给付比例|赔付比例)\s*(?:为|按|=|：|:)\s*(百分之[一二三四五六七八九十百\d.]+)/u,
    /(?:按|按照)\s*(百分之[一二三四五六七八九十百\d.]+)[^。；，,]{0,16}?(?:比例)?(?:给付|赔付)/u,
  ];
  for (const pattern of chinesePatterns) {
    const match = normalized.match(pattern);
    const value = match?.[1] ? chinesePercentToNumber(match[1]) : null;
    if (Number.isFinite(value) && value > 0) return String(value);
  }
  return '';
}

function chineseMultipleToNumber(text) {
  const normalized = normalizeSpaces(text);
  const numeric = normalized.match(/\d+(?:\.\d+)?/u);
  if (numeric?.[0]) return Number(numeric[0]);
  const values = {
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
  return values[normalized] || null;
}

function amountEqualsCondition(prefix = '') {
  const compact = normalizeSpaces(prefix).replace(/\s+/gu, '');
  const ageMatches = [
    ...compact.matchAll(/(?:若|如)?被保险人[^。；]{0,36}?(未满|已满)\s*(\d+)\s*周岁/gu),
    ...compact.matchAll(/(未满|已满)\s*(\d+)\s*周岁/gu),
  ].sort((left, right) => (left.index || 0) - (right.index || 0));
  const age = ageMatches.at(-1);
  if (age?.[1] && age?.[2]) return `${age[1]}${age[2]}周岁`;
  if (/营运汽车意外事故/u.test(compact)) return '营运汽车意外事故';
  if (/轨道交通及轮船意外事故/u.test(compact)) return '轨道交通及轮船意外事故';
  if (/航空意外事故/u.test(compact)) return '航空意外事故';
  return '';
}

function amountEqualsEntries(text = '') {
  const compact = normalizeSpaces(text).replace(/\s+/gu, '');
  const entries = [];
  const pattern = /(?:其金额|保险金的金额|年金的金额|给付金额|金额)?等于([^。；;]{0,120})/gu;
  for (const match of compact.matchAll(pattern)) {
    const rhs = match[1] || '';
    if (/^(?:以下|下列|上述)?(?:两项|三项|二者|三者|金额较大者|较大者|较高者)/u.test(rhs)) continue;
    const basisMatch = rhs.match(new RegExp(`(?:本合同|本附加合同|本主险合同|保险合同)?的?(${AMOUNT_EQUALS_BASIS_PATTERN})`, 'u'));
    if (!basisMatch?.[1]) continue;
    const basis = canonicalAmountBasis(basisMatch[1], rhs);
    const afterBasis = rhs.slice((basisMatch.index || 0) + basisMatch[0].length, (basisMatch.index || 0) + basisMatch[0].length + 36);
    const percent = explicitPercentFromText(afterBasis);
    const multipleMatch = afterBasis.match(/(?:的)?([一二两三四五六七八九十\d.]+)倍/u);
    const multipleValue = multipleMatch?.[1] ? chineseMultipleToNumber(multipleMatch[1]) : null;
    const condition = amountEqualsCondition(compact.slice(Math.max(0, (match.index || 0) - 100), match.index || 0));
    if (percent) {
      entries.push({
        value: Number(percent),
        valueText: percent,
        unit: '%',
        basis,
        condition,
        formulaTail: `${basis} × ${percent}%`,
      });
    } else if (Number.isFinite(multipleValue) && multipleValue > 0) {
      entries.push({
        value: multipleValue,
        valueText: String(multipleValue),
        unit: '倍',
        basis,
        condition,
        formulaTail: `${basis} × ${multipleValue}`,
      });
    } else {
      entries.push({
        value: 100,
        valueText: '100',
        unit: '%',
        basis,
        condition,
        formulaTail: `${basis} × 100%`,
      });
    }
  }
  return entries;
}

function amountEqualsFormula(liability, text) {
  if (/医疗|门诊|住院|费用|津贴|补贴/u.test(liability)) return null;
  const compact = normalizeSpaces(text).replace(/\s+/gu, '');
  if (!/给付|支付/u.test(compact) || !/等于/u.test(compact)) return null;
  if (/等于[^。；]{0,12}(?:以下|下列|上述)?(?:两项|三项|二者|三者|金额较大者|较大者|较高者)/u.test(compact)) return null;
  const entries = amountEqualsEntries(text);
  if (!entries.length) return null;
  const uniqueTails = [...new Set(entries.map((entry) => entry.formulaTail))];
  if (uniqueTails.length === 1) {
    const entry = entries[0];
    return {
      value: entry.value,
      valueText: entry.valueText,
      unit: entry.unit,
      basis: entry.basis,
      formulaText: `${liability} = ${entry.formulaTail}`,
    };
  }
  if (entries.every((entry) => entry.condition)) {
    return {
      value: null,
      valueText: '',
      unit: '公式',
      basis: uniqueStrings(entries.map((entry) => entry.basis)).join('、'),
      formulaText: `${liability} = 条件给付（${entries.map((entry) => `${entry.condition}：${entry.formulaTail}`).join('；')}）`,
    };
  }
  return null;
}

function parameterizedMedicalFormulaFromText(text) {
  const normalized = normalizeSpaces(text);
  const compact = normalized.replace(/\s+/gu, '');
  if (/未在[^。；]{0,60}(?:指定|约定)[^。；]{0,60}(?:机构|医院|药店)[^。；]{0,80}(?:\d+(?:\.\d+)?[％%]|百分之[一二三四五六七八九十百\d.]+)/u.test(compact)) return null;
  const hasRatio = /(?:本合同)?约定的?(?:给付比例|赔付比例|比例)|(?:给付比例|赔付比例)[^。；，,]{0,8}另有约定|[×xX*]\s*(?:给付比例|赔付比例)|(?:住院医疗|门\s*[（(]?\s*急\s*[）)]?\s*诊医疗|普通门诊|特定门诊|医疗)?(?:给付比例|赔付比例)/u.test(normalized);
  const hasContractRule = /(?:余额|剩余部分|剩余金额)[^。；]{0,24}按(?:本合同)?(?:的)?约定给付|按(?:本合同)?(?:的)?约定给付|依照(?:本合同)?(?:的)?(?:有关)?约定给付/u.test(compact);
  const hasPlanRule = /均一给付方案|分段给付方案/u.test(normalized);
  if (!hasRatio && !hasContractRule && !hasPlanRule) return null;
  if (!/医疗费用|实际(?:发生|支出)?[^。；，,]{0,60}费用|实际支出|实际发生|合理且(?:必要|必须)/u.test(normalized)
    && !/医疗费用|实际(?:发生|支出)?[^。；，,]{0,60}费用|实际支出|实际发生|合理且(?:必要|必须)/u.test(compact)) return null;
  const basis = ['实际合理医疗费用'];
  if (/补偿|给付/u.test(normalized)) basis.push('已获补偿/给付');
  if (/免赔额|起付金额|起付标准/u.test(normalized)) basis.push('免赔额');
  if (/均一给付方案|分段给付方案/u.test(normalized)) basis.push('约定给付方案');
  basis.push(hasRatio ? '约定给付比例' : '合同约定给付规则');
  return {
    value: null,
    valueText: '',
    unit: '公式',
    basis: basis.join('、'),
    formulaText: /均一给付方案|分段给付方案/u.test(normalized)
      ? '医疗费用保险金 = 实际合理医疗费用按约定均一/分段给付方案给付'
      : hasRatio
      ? '医疗费用保险金 = (实际合理医疗费用 - 已获补偿/给付 - 免赔额) × 约定给付比例'
      : '医疗费用保险金 = 实际合理医疗费用扣除已获补偿后按合同约定给付',
  };
}

export function sourceText(payload = {}) {
  return normalizeSpaces([
    payload.pageText,
    payload.responsibility,
    payload.snippet,
    payload.analysis?.report,
    ...(Array.isArray(payload.analysis?.coverageTable)
      ? payload.analysis.coverageTable.map((row) => [row.coverageType, row.scenario, row.payout, row.note].filter(Boolean).join(' '))
      : []),
  ].filter(Boolean).join('\n'));
}

function responsibilityTextLooksUsable(text) {
  return /保险责任|保险金|给付|赔付|报销|津贴|年金/u.test(text) && !/同产品官方资料已存在保险责任正文/u.test(text);
}

export function splitBenefitSections(text) {
  const source = normalizeSpaces(text);
  const pattern = new RegExp(`([\\u4e00-\\u9fa5A-Za-z0-9“”\\-—（）()\\s]{2,40}?(?:${BENEFIT_TITLE_SUFFIX})|(?:${STANDALONE_BENEFIT_TITLES}))(?:[（(][^）)]{0,12}[）)])?\\s*(?=若|如|被保险人|受益人|本合同|自|在|=|＝|:|：|计算方式|我们|本公司|投保人|[（(])`, 'gu');
  const matches = [];
  for (const match of source.matchAll(pattern)) {
    matches.push({
      rawLiability: match[1],
      liability: cleanLiability(match[1]),
      index: match.index || 0,
      contextStart: match.index || 0,
      scopeText: source.slice(Math.max(0, (match.index || 0) - 1000), Math.min(source.length, (match.index || 0) + match[0].length + 80)),
    });
  }
  const payoutNamePattern = new RegExp(`(?:给\\s*付|赔\\s*付|豁免)([\\u4e00-\\u9fa5A-Za-z0-9“”\\-—（）()\\s]{2,40}?(?:${BENEFIT_TITLE_SUFFIX})|(?:${STANDALONE_BENEFIT_TITLES}))`, 'gu');
  for (const match of source.matchAll(payoutNamePattern)) {
    const index = (match.index || 0) + match[0].length - match[1].length;
    const prefix = source.slice(Math.max(0, index - 16), index);
    if (/(?:在给付|已给付的?|已赔付的?|不再给付|不承担给付|未给付|尚未给付|扣除已给付|扣除已赔付|申请)$/u.test(prefix)) continue;
    matches.push({
      rawLiability: match[1],
      liability: cleanLiability(match[1]),
      index,
      contextStart: Math.max(0, index - 220),
      scopeText: source.slice(Math.max(0, index - 1000), Math.min(source.length, index + match[1].length + 80)),
    });
  }
  const assumeLiabilityPattern = new RegExp(`承担(?:给付)?([\\u4e00-\\u9fa5A-Za-z0-9“”\\-—（）()\\s]{2,48}?(?:${BENEFIT_TITLE_SUFFIX}))(?:的|之)?责任`, 'gu');
  for (const match of source.matchAll(assumeLiabilityPattern)) {
    const fullIndex = match.index || 0;
    const rawLiability = match[1] || '';
    const index = fullIndex + match[0].indexOf(rawLiability);
    const prefix = source.slice(Math.max(0, fullIndex - 12), fullIndex);
    if (/不(?:予)?$|不承担$/u.test(prefix)) continue;
    const articleStart = source.lastIndexOf('保险责任', fullIndex);
    matches.push({
      rawLiability,
      liability: cleanLiability(rawLiability),
      index,
      contextStart: articleStart >= 0 && fullIndex - articleStart <= 900 ? articleStart : Math.max(0, index - 220),
      scopeText: source.slice(Math.max(0, index - 1000), Math.min(source.length, index + rawLiability.length + 80)),
    });
  }
  matches.push(...genericBenefitMatches(source));
  const cleanMatches = matches
    .filter((item) => liabilityLooksClean(item.liability))
    .sort((a, b) => a.index - b.index);
  const sections = [];
  const seen = new Set();
  for (let index = 0; index < cleanMatches.length; index += 1) {
    const current = cleanMatches[index];
    const key = normalizeLookupText(current.liability);
    if (seen.has(key)) continue;
    seen.add(key);
    const next = cleanMatches.slice(index + 1).find((item) => {
      const itemKey = normalizeLookupText(item.liability);
      return item.index > current.index + current.liability.length
        && itemKey !== key
        && !key.startsWith(itemKey)
        && !itemKey.startsWith(key);
    });
    const sectionText = source.slice(
      current.contextStart,
      current.contextEnd || (next ? next.index : Math.min(source.length, current.index + 1400)),
    );
    sections.push({
      liability: current.liability,
      responsibilityScope: responsibilityScopeForSection(current.rawLiability, `${current.scopeText || ''} ${sectionText.slice(0, 120)}`),
      text: sectionText,
    });
  }
  return sections.slice(0, 20);
}

function cleanLiability(value) {
  return trim(value)
    .replace(/^保险责任\s*/u, '')
    .replace(/^第\s*[一二三四五六七八九十\d]+\s*条\s*(?:保险责任)?/u, '')
    .replace(/^\s*[页頁]/u, '')
    .replace(/第\s*\d+\s*页\s*共\s*\d+\s*页/gu, '')
    .replace(/^(必选保险责任|基本保险责任|可选保险责任|必选责任|基本责任|可选责任|基本部分|可选部分)/u, '')
    .replace(/^\s+/u, '')
    .replace(/^[（(]?[一二三四五六七八九十\d]+[）)、.．\s]+/u, '')
    .replace(/^(?:给付)?(?:符合下列约定条件的|符合以下约定条件的|符合下列条件的|符合以下条件的)(?=.+(?:保险金|津贴|年金))/u, '')
    .replace(/^.*[（(]?[一二三四五六七八九十\d]+[）)](?=[^（）()]{2,24}(?:保险金|补偿金|补助金|给付金|津贴|年金|满期金|生存金|祝寿金|贺寿金|贺岁金|长寿金|关爱金|教育金|婚嫁金|立业金|创业金|深造金|确诊金|慰问金|豁免保险费)$)/u, '')
    .replace(/^被保险人(?=.+(?:保险金|补偿金|给付金|津贴|年金|满期金|生存金|教育金|婚嫁金|立业金|创业金|深造金|确诊金|慰问金|豁免保险费)$)/u, '')
    .replace(/^[一二三四五六七八九十\d]+(?=第|[“"‘])/u, '')
    .replace(/^\d+种(?=.+保险金)/u, '')
    .replace(/^[一二三四五六七八九十]+种(?=.+保险金)/u, '')
    .replace(/^(一项|一次|一处)(?=.*保险金)/u, '')
    .replace(/^(一项|一次)(?=意外|残疾|全残|中症|轻症|生存|养老|年金|重大|疾病)/u, '')
    .replace(/^(?:一笔|两笔|三笔|四笔|五笔|首笔|每笔|当年正常)(?=.*(?:保险金|年金|生存金|满期金))/u, '')
    .replace(/^限额(?=.+(?:保险金|补偿金|津贴|年金|确诊金|慰问金))/u, '')
    .replace(/^不超过保险单载明的(?=.+(?:保险金|补偿金|津贴|年金|确诊金|慰问金))/u, '')
    .replace(/^对于(?=.+(?:保险金|补偿金|津贴|年金|确诊金|慰问金))/u, '')
    .replace(/^年免赔额给付比例(?:基本责任|可选责任)?(?:基础计划|升级计划|卓越计划)?(?=.+(?:保险金|补偿金|津贴|年金|确诊金|慰问金))/u, '')
    .replace(/^\d+(?:\.\d+)?\s*万\s*保险责任给付限额(?=.+(?:保险金|补偿金|津贴|年金|确诊金|慰问金))/u, '')
    .replace(/^\d+(?:\.\d+)?\s*万?元(?=.+(?:保险金|补偿金|津贴|年金|确诊金|慰问金))/u, '')
    .replace(/^[\u4e00-\u9fa5A-Za-z0-9（）()]*给付限额(?=.+(?:保险金|补偿金|津贴|年金|确诊金|慰问金))/u, '')
    .replace(/^(?:内|范围内|责任范围内)?按(?:本合同)?约定的?(?:给付比例|赔付比例)(?:[（(][^）)]{0,20}[）)])?给付(?=.+(?:保险金|补偿金|津贴|年金|确诊金|慰问金))/u, '')
    .replace(/^按下表所示比例给付(?=.+(?:保险金|补偿金|津贴|年金|确诊金|慰问金))/u, '')
    .replace(/^每项特定重大手术对应的(?=特定重大手术康复保险金)/u, '')
    .replace(/^保险金和(?=恶性肿瘤[-—－]+重度(?:额外|关爱|扩展)?保险金)/u, '')
    .replace(/^限\d*额和(?=.+(?:保险金|补偿金|津贴|年金|确诊金|慰问金))/u, '')
    .replace(/^[和及](?=.+(?:保险金|补偿金|津贴|年金|确诊金|慰问金))/u, '')
    .replace(/^保险费[和及](?=.+豁免保险费)/u, '')
    .replace(/^给付(?=.+(?:保险金|补偿金|津贴|年金|确诊金|慰问金))/u, '')
    .replace(/^[一二三四五六七八九十\d]+(?=基本|达到|航空|水陆|公共|交通|猝死|身故|身体|全残|意外|重大|中症|轻症|重症|重度|轻度|疾病|恶性|院内|护理|特定|首次|住院|门诊|医疗|养老|生存|满期|祝寿|汽车|轮船|轨道|驾乘)/u, '')
    .replace(/^第\s*[（(]?[一二三四五六七八九十\d]+[）)]?\s*项/u, '')
    .replace(/^(必选责任|基本责任|可选责任|一、|二、|三、|四、)/u, '')
    .replace(/^(?:年给付限额|年度给付限额|累计给付限额)?\d+(?:\.\d+)?\s*万?元(?=.+(?:保险金|补偿金|津贴|年金|确诊金|慰问金))/u, '')
    .replace(/["“”']/gu, '')
    .replace(/\s+/gu, '')
    .replace(/^按下表所示比例给付(?=.+(?:保险金|补偿金|津贴|年金|确诊金|慰问金))/u, '')
    .replace(/豁免$/u, '豁免保险费')
    .replace(/豁免保险费保险费$/u, '豁免保险费')
    .replace(/^[（(]?[一二三四五六七八九十\d]+[）)、.．]+/u, '')
    .replace(/^(?:内|范围内|责任范围内)?按(?:本合同)?约定的?(?:给付比例|赔付比例)(?:[（(][^）)]{0,20}[）)])?给付(?=.+(?:保险金|补偿金|津贴|年金|确诊金|慰问金))/u, '')
    .replace(/^\d+(?:\.\d+)?万?元/u, '')
    .replace(/^\d+(?:\.\d+)?万保险责任给付限额(?=.+(?:保险金|补偿金|津贴|年金|确诊金|慰问金))/u, '')
    .replace(/^(?:(?:基本责任|可选责任|必选责任))?[一二三四五六七八九十\d]+(?=基本|达到|航空|水陆|公共|交通|猝死|身故|身体|全残|意外|重大|中症|轻症|重症|重度|轻度|疾病|恶性|院内|护理|特定|首次|住院|门诊|医疗|养老|生存|满期|祝寿|汽车|轮船|轨道|驾乘)/u, '')
    .replace(/([\u4e00-\u9fa5])\d+(?=(?:医疗|保险|费用|津贴|门诊|住院))/gu, '$1')
    .replace(/^(?:一笔|两笔|三笔|四笔|五笔|首笔|每笔|当年正常)(?=.*(?:保险金|补偿金|津贴|年金|满期金|生存金|祝寿金|贺寿金|贺岁金|长寿金|关爱金|教育金|婚嫁金|立业金|创业金|深造金|确诊金|慰问金))/u, '')
    .replace(/^(.+?(?:保险金|补偿金|津贴|年金|满期金|生存金|祝寿金|贺寿金|贺岁金|长寿金|关爱金|教育金|婚嫁金|立业金|创业金|深造金|确诊金|慰问金))\1$/u, '$1')
    .replace(/^(.{3,20})\1$/u, '$1')
    .trim();
}

function liabilityLooksClean(value) {
  const text = trim(value);
  if ((text.length < 3 && text !== '年金') || text.length > 34) return false;
  if (genericPayoutLiability(text)) return false;
  if (!/(?:保险金|补偿金|补助金|给付金|津贴|年金|满期金|生存金|祝寿金|贺寿金|贺岁金|长寿金|关爱金|教育金|婚嫁金|立业金|创业金|深造金|确诊金|慰问金|豁免保险费)$/u.test(text)) return false;
  if (/^(保险金|基本保险金|医疗保险金|特定医疗保险金|津贴保险金)$/u.test(text)) return false;
  if (/^(每一保险期间累计给付|已达到保险单上载明的|外伤害|年度给付限额|年给付限额|累计给付限额|累计给付|扣除|已给付|已赔付)/u.test(text)) return false;
  if (/^保险费[和及].+豁免保险费$/u.test(text)) return false;
  if (/^(年免赔额给付比例|保险责任给付限额|\d+(?:\.\d+)?万保险责任给付限额)/u.test(text)) return false;
  if (/每年一次|全额理赔|最高给付限制/u.test(text)) return false;
  if (/^[（(]|^(按照|按不同|约定|般|准|年领方式|月领方式|金额|比例|限额|限制|与|给付比例|赔付比例|下列|下的|中的|应给付|等同于|等值于|的|予|本附加|累计|以|相应|对应|后次|前次|本次|该项|在各项|规则|各对应|各该项|较严重项目|较严重|各项|每一项|同一项|次序|内给付|和给付次数)/u.test(text)) return false;
  if (/^达到(?!运动标准后额外给付)/u.test(text)) return false;
  if (/^(其中|上述|此次|了|条件|该保单|最重|申请书|另外一项|另一项|本条|个保单周年日|贺寿金的|当时|上期|本期|期内|期间内|期限内|年度内|保证给付期间内|保证领取期间内|范围|本主险合同|保险金的|保险金责任包括|或应给付|表中|表内|各次|各分项|各残疾项目|之和不超过|总额不超过|规则|下述|该次|该种|该类|任意一项|期间为|若按|对剩余部分|给付养老年金|每年给付|每年给付的|每期给付|每次给付|免赔额和自付比例|合理且必要的医疗费用|合理且必须的医疗费用|医疗必要的医疗费用|乘以以下规定|且|应当赔付的|应当给付的|应给付的|每一次就诊|每次就诊|总次数|次数达到|应赔付的)/u.test(text)) return false;
  if (/^[-—]/u.test(text)) return false;
  if (/^后(?!续年金$)/u.test(text)) return false;
  if (/^过(?!敏性)/u.test(text)) return false;
  if (/^(一项|一次|一处|其他|本项)保险金$/u.test(text)) return false;
  if (/^比例最高|对应项|项目的/u.test(text)) return false;
  if (/^(分别以|时应扣除|额累计达到|个合同生效日|上限为|日及其后|日后的)/u.test(text)) return false;
  if (/保险金[（(]若[有选][）)][和或]|保险金若您选择|该类型下|交清增额保险对应|对应的(?:身故保险金|养老年金|满期保险金|保险金)|对应身故保险金|保险单上载明的该项交通工具对应|对应日按基本保险金/u.test(text)) return false;
  if (/^[一二三四五六七八九十\d]+倍同等金额的保险金/u.test(text)) return false;
  if (/保险金.+保险金/u.test(text)) return false;
  if (/我们|本公司|被保险人|投保人|给付保险金|责任终止|本合同|附加险合同|约定给付/u.test(text)) return false;
  if (/申请书|条件之前|条件之日|伤残等级对应|保单周年日|周年日|金额最高|赔付金额最高|一项保险金|任意一项保险金|任何一项保险金|各对应项|各项保险金|本项责任|已符合|对应组别|本主险合同|同时给付生存保险金|赔付时需扣除|不再给付|保单账户价值及|每万元|如果未发生|给付各项|应给付|应当给付|应领取|未领取|尚未给付|扣除已领取|给付比例给付|赔付比例给付|给付比例表中|相应|相类似的残疾项目|不超过您投保|所对应的|按年领取|按月领取|约定的给付比例|费用在扣除免赔额后|天数|乘以|无单项限额|范围\)/u.test(text)) return false;
  if (/按照|给付以下保险金|给付医疗保险金|保险有限责任公司|人寿保险|准给付|年领方式|月领方式|方式下|产品说明书|条款|发〔|保险合同|本附加合同|保险金的责任/u.test(text)) return false;
  return true;
}

function responsibilityScopeForSection(rawLiability, sectionText) {
  const rawMarker = normalizeSpaces(rawLiability);
  if (/基本(?:保险)?责任|基本部分|必选(?:保险)?责任|必选部分/u.test(rawMarker)) return 'basic';
  if (/可选(?:保险)?责任|可选部分/u.test(rawMarker)) return 'optional';
  const marker = normalizeSpaces(sectionText);
  const compact = marker.replace(/\s+/gu, '');
  const liabilityKey = normalizeSpaces(cleanLiability(rawLiability) || rawLiability).replace(/\s+/gu, '');
  const liabilityIndex = liabilityKey ? compact.indexOf(liabilityKey) : -1;
  const markerText = liabilityIndex >= 0 ? compact.slice(0, liabilityIndex) : compact.slice(0, 600);
  const lastBasic = Math.max(
    markerText.lastIndexOf('基本责任'),
    markerText.lastIndexOf('基本保险责任'),
    markerText.lastIndexOf('基本部分'),
    markerText.lastIndexOf('必选责任'),
    markerText.lastIndexOf('必选保险责任'),
    markerText.lastIndexOf('必选部分'),
  );
  const lastOptional = Math.max(
    markerText.lastIndexOf('可选责任'),
    markerText.lastIndexOf('可选保险责任'),
    markerText.lastIndexOf('可选部分'),
  );
  if (lastBasic >= 0 || lastOptional >= 0) return lastOptional > lastBasic ? 'optional' : 'basic';
  return 'basic';
}

export function coverageTypeFor(liability, text) {
  const direct = normalizeSpaces(liability);
  const haystack = normalizeSpaces(`${liability} ${text}`);
  if (/豁免/u.test(direct)) return '保费豁免';
  if (/损失|延误|旅行不便|接驳/u.test(direct)) return '财产损失保障';
  if (/护理/u.test(direct)) return '护理保障';
  if (/账户价值/u.test(haystack) && /离职保险金|退休保险金/u.test(direct)) return '现金流';
  if (/津贴|补贴|日额|每日|慰问金/u.test(direct)) return '津贴保障';
  if (/非意外/u.test(direct) && /身故|全残|高残|高度残疾/u.test(direct)) return '身故保障';
  if (/意外/u.test(direct) && /身故|全残|高残|高度残疾/u.test(direct)) return '意外身故保障';
  if (/身故|全残|高残|高度残疾/u.test(direct) && /意外伤害/u.test(haystack) && !/非意外|疾病|等待期/u.test(haystack)) return '意外身故保障';
  if (/身故|全残|高残|高度残疾/u.test(direct)) return '身故保障';
  if (/手术保险金/u.test(direct) && !/意外/u.test(direct)) return '医疗保障';
  if (/门诊|住院|医疗|药品|药械|费用|报销|补偿|质子重离子/u.test(direct)) return '医疗保障';
  if (/伤残|残疾|骨折|烧伤|烧烫伤|韧带|整形手术|手术意外伤害/u.test(direct)) return '意外伤残保障';
  if (/猝死/u.test(direct)) return '意外身故保障';
  if (/重大手术|特定重大手术|康复保险金/u.test(direct)) return '重大疾病保障';
  if (/恶性肿瘤|肿瘤|癌|白血病|重大疾病|重疾|中症|轻症|中度疾病|轻度疾病|特定疾病|疾病|并发症|罕见病|传染病|卵巢切除术|子宫全切术|全面保障/u.test(direct)) return '重大疾病保障';
  if (new RegExp(CASHFLOW_TITLE_TERMS, 'u').test(direct)) return '现金流';
  if (/门诊|住院|医疗|药品|药械|费用|报销|补偿|质子重离子/u.test(haystack)) return '医疗保障';
  if (/伤残|残疾|骨折|烧伤|烧烫伤|韧带|整形手术|手术意外伤害/u.test(haystack)) return '意外伤残保障';
  if (/意外/u.test(haystack) && /身故|全残/u.test(haystack)) return '意外身故保障';
  if (/身故|全残/u.test(haystack)) return '身故保障';
  if (/手术保险金/u.test(haystack) && !/意外/u.test(haystack)) return '医疗保障';
  if (/重大手术|特定重大手术|康复保险金/u.test(haystack)) return '重大疾病保障';
  if (/恶性肿瘤|肿瘤|癌|白血病|重大疾病|重疾|中症|轻症|中度疾病|轻度疾病|特定疾病|疾病|卵巢切除术|子宫全切术/u.test(haystack)) return '重大疾病保障';
  if (new RegExp(CASHFLOW_TITLE_TERMS, 'u').test(haystack)) return '现金流';
  return '责任项';
}

function accountValueLooksScopedToLiability(liability, text) {
  const liabilityIndex = text.indexOf(liability);
  const window = liabilityIndex >= 0 ? text.slice(Math.max(0, liabilityIndex - 220), liabilityIndex + 420) : text.slice(0, 420);
  if (!/账户价值/u.test(window)) return false;
  const compact = window.replace(/\s+/gu, '');
  const liabilityPattern = escapeRegExp(liability.replace(/\s+/gu, ''));
  if (new RegExp(`账户价值[^。；]{0,90}给付${liabilityPattern}`, 'u').test(compact)) return true;
  if (new RegExp(`给付${liabilityPattern}[^。；]{0,90}账户价值`, 'u').test(compact)) return true;
  if (/身故|全残|高残|高度残疾/u.test(liability) && /身故|全残|高残|高度残疾/u.test(compact) && /账户价值[^。；]{0,90}给付保险金/u.test(compact)) return true;
  if (/按(?:当时|其|个人账户已归属被保险人部分的)?(?:个人账户|保单账户)?账户价值给付/u.test(compact)) return true;
  return /账户|离职|退休|养老|年金/u.test(liability)
    && /账户价值[^。；]{0,90}给付|给付[^。；]{0,90}账户价值/u.test(compact);
}

function payoutLiabilityFromClause(compact) {
  const payoutPattern = /给付([^。；]{2,40}?(?:保险金(?!额)|补偿金))/gu;
  for (const payout of compact.matchAll(payoutPattern)) {
    const prefix = compact.slice(Math.max(0, payout.index - 12), payout.index);
    if (/(?:已给付|已赔付|尚未给付|不再给付|不承担给付|扣除|扣除已|已)$/u.test(prefix)) continue;
    const rawLiability = payout[1].includes('给付')
      ? payout[1].replace(/^.*给付/u, '')
      : payout[1];
    const liability = cleanLiability(rawLiability
      .replace(/^(?:该|本项|各项|一项|各类|相应)/u, ''));
    if (liabilityLooksClean(liability)) return liability;
  }
  return '';
}

function genericPayoutLiability(value) {
  return /^(?:保险金|医疗保险金|补偿金|给付金)$/u.test(trim(value));
}

function compensationHeadingToLiability(heading = '') {
  const cleaned = cleanLiability(heading.replace(/[：:]\s*$/u, ''));
  if (!cleaned || genericPayoutLiability(cleaned)) return '';
  if (/(?:保险金|补偿金|补助金|给付金|津贴)$/u.test(cleaned)) return liabilityLooksClean(cleaned) ? cleaned : '';
  if (/补偿$/u.test(cleaned)) {
    const liability = `${cleaned}金`;
    return liabilityLooksClean(liability) ? liability : '';
  }
  if (/给付$/u.test(cleaned)) {
    const liability = `${cleaned}补偿金`;
    return liabilityLooksClean(liability) ? liability : '';
  }
  return '';
}

function compensationLiabilityFromClause(clause = '') {
  const compact = normalizeSpaces(clause).replace(/\s+/gu, '');
  if (!/给付补偿金/u.test(compact)) return '';
  const heading = [...compact.matchAll(/(?:^|[（(]?[一二三四五六七八九十\d]+[）)]?)([^:：。；（）()]{2,24}?(?:给付|补偿))[:：]/gu)].at(-1)?.[1] || '';
  const headingLiability = compensationHeadingToLiability(heading);
  if (headingLiability) return headingLiability;
  if (/每日住院给付|每日住院给付基本保险金额/u.test(compact) && /住院日数/u.test(compact)) return '每日住院给付补偿金';
  if (/手术费/u.test(compact)) return '手术费补偿金';
  if (/住院费用|实际住院费用/u.test(compact)) return '住院费用补偿金';
  return '';
}

function genericLiabilityFromClause(clause = '') {
  const target = normalizeSpaces(clause);
  const compact = target.replace(/\s+/gu, '');
  if (!/给付[^。；]{0,40}(?:保险金(?!额)|补偿金|补助金)|给付[^。；]{0,16}护理保险金/u.test(compact)) return '';
  const compensationLiability = compensationLiabilityFromClause(target);
  if (compensationLiability) return compensationLiability;
  const payoutLiability = payoutLiabilityFromClause(compact);
  if (payoutLiability && !genericPayoutLiability(payoutLiability)) return payoutLiability;
  if (/身故|死亡/u.test(compact)) {
    if (/身体全残/u.test(compact)) return '身故或身体全残保险金';
    if (/全残|高残|高度残疾/u.test(compact)) return '身故或全残保险金';
    return '身故保险金';
  }
  if (/身体全残/u.test(compact)) return '身体全残保险金';
  if (/全残|高残|高度残疾/u.test(compact)) return '全残保险金';
  if (/特定疾病/u.test(compact)) return '特定疾病保险金';
  if (/重大疾病|重疾/u.test(compact)) return '重大疾病保险金';
  if (/恶性肿瘤|癌症|癌/u.test(compact)) return '恶性肿瘤保险金';
  if (/意外/u.test(compact) && /伤残|残疾/u.test(compact)) return '意外伤残保险金';
  if (/意外/u.test(compact) && /烧伤|烧烫伤/u.test(compact)) return '意外烧伤保险金';
  if (/护理服务|失能|日常生活能力|护理保险金/u.test(compact) && /护理/u.test(compact)) return '护理保险金';
  if (/工伤/u.test(compact) && /补助金/u.test(compact)) return '工伤补助金';
  if (/节育手术|节育并发症/u.test(compact) && /给付比例|保险金额/u.test(compact)) return '节育并发症保险金';
  if (/输血/u.test(compact) && /(?:病原体|感染)/u.test(compact)) return '病原体感染保险金';
  if (/伙食补偿金额/u.test(compact)) return '伙食补偿金';
  if (/误工补偿金额/u.test(compact)) return '误工补偿金';
  if (/护理补偿金额/u.test(compact)) return '护理补偿金';
  if (/重症监护/u.test(compact) && /日定额给付金额|实际入住重症监护病房日数|重症监护病房日数/u.test(compact)) return '重症监护津贴保险金';
  if (/生活津贴给付日数|日生活津贴标准/u.test(compact)) return '生活津贴保险金';
  if (/住院日定额给付金额|日定额给付标准|实际住院(?:天数|日数)|住院日数|住院天数/u.test(compact) && !/医疗费用|合规医疗费用|住院医疗费用/u.test(compact)) {
    return /意外/u.test(compact) && !/疾病|等待期/u.test(compact) ? '意外伤害住院津贴保险金' : '住院津贴保险金';
  }
  if (/住院/u.test(compact) && /医疗费用|合规医疗费用/u.test(compact) && /疾病|等待期|生效(?:九十|90|三十|30)日/u.test(compact)) return '住院医疗保险金';
  if (/意外伤害/u.test(compact) && /医疗费用|合规医疗费用/u.test(compact)) return '意外伤害医疗保险金';
  if (/住院/u.test(compact) && /医疗费用|合规医疗费用/u.test(compact)) return '住院医疗保险金';
  if (/门诊/u.test(compact) && /医疗费用|合规医疗费用/u.test(compact)) return '门诊医疗保险金';
  if (/疾病/u.test(compact) && /医疗费用|合规医疗费用/u.test(compact)) return '疾病医疗保险金';
  if (/医疗费用|合规医疗费用|医药费用/u.test(compact)) return '医疗费用保险金';
  return '';
}

function amountBackedPayoutLiabilityFromClause(clause = '') {
  const compact = normalizeSpaces(clause).replace(/\s+/gu, '');
  if (!/(?:给付等值于|每月给付等值于|所应给付的).{0,160}(?:基本保险金额|基本保额|保险金额)/u.test(compact)
    && !/(?:保险金|年金|津贴)等值于.{0,80}(?:基本保险金额|基本保额|保险金额)/u.test(compact)) return '';
  const afterBasis = compact.match(new RegExp(`(?:给付等值于|每月给付等值于)[^。；]{0,120}(?:${AMOUNT_BASIS_PATTERN})的?([^。；]{2,34}?(?:保险金(?!额)|年金|津贴))`, 'u'));
  const beforeBasis = compact.match(/所应给付的([^。；]{2,34}?(?:保险金(?!额)|年金|津贴))等值于/u)
    || compact.match(/([^。；]{2,34}?(?:保险金(?!额)|年金|津贴))等值于[^。；]{0,80}(?:基本保险金额|基本保额|保险金额)/u);
  const rawLiability = afterBasis?.[1] || beforeBasis?.[1] || '';
  const liability = cleanLiability(rawLiability.replace(/予.*$/u, ''));
  return liabilityLooksClean(liability) ? liability : '';
}

function expenseCompensationLiabilityFromClause(clause = '') {
  const compact = normalizeSpaces(clause).replace(/\s+/gu, '');
  if (!/(?:实际住院费用|实际医疗费用|实际医药费用|合理的实际[^。；]{0,12}费用)[^。；]{0,120}给付/u.test(compact)) return '';
  const match = compact.match(/给付([^。；]{2,34}?(?:住院费用补偿|医疗费用补偿|医药费用补偿))予?/u);
  if (!match?.[1]) return '';
  const liability = cleanLiability(`${match[1]}金`);
  return liabilityLooksClean(liability) ? liability : '';
}

function untitledInsurancePaymentLiability(clause = '') {
  const compact = normalizeSpaces(clause).replace(/\s+/gu, '');
  if (!/(?:计算和支付保险金|支付保险金|给付保险金)/u.test(compact)) return '';
  if (/意外事故/u.test(compact) && /住院/u.test(compact) && /住院日数/u.test(compact) && /基本保险金额/u.test(compact)) {
    return '意外住院津贴保险金';
  }
  return '';
}

function genericBenefitMatches(source = '') {
  const matches = [];
  const clausePattern = /(^|[\n。；;])([^。\n；;]{8,620}?给\s*付\s*[^。\n；;]{0,40}?(?:保险\s*金(?!\s*额)|补\s*偿\s*金|补\s*助\s*金)[^。\n；;]{0,100})/gu;
  for (const match of source.matchAll(clausePattern)) {
    const clause = normalizeSpaces(match[2]);
    const liability = genericLiabilityFromClause(clause);
    if (!liability) continue;
    const index = (match.index || 0) + match[1].length;
    matches.push({
      rawLiability: liability,
      liability,
      index,
      contextStart: index,
      scopeText: clause,
    });
  }
  const amountBackedPayoutPattern = /(^|[\n。；;])([^。\n；;]{8,620}?(?:给付等值于|每月给付等值于|所应给付的)[^。\n；;]{0,220}?(?:保险金(?!额)|年金|津贴)[^。\n；;]{0,120})/gu;
  for (const match of source.matchAll(amountBackedPayoutPattern)) {
    const clause = normalizeSpaces(match[2]);
    const liability = amountBackedPayoutLiabilityFromClause(clause);
    if (!liability) continue;
    const index = (match.index || 0) + match[1].length;
    matches.push({
      rawLiability: liability,
      liability,
      index,
      contextStart: index,
      scopeText: clause,
    });
  }
  const expenseCompensationPattern = /(^|[\n。；;])([^。\n；;]{8,620}?(?:实际住院费用|实际医疗费用|实际医药费用|合理的实际[^。\n；;]{0,12}费用)[^。\n；;]{0,160}?给付[^。\n；;]{2,34}?(?:住院费用补偿|医疗费用补偿|医药费用补偿)予?[^。\n；;]{0,120})/gu;
  for (const match of source.matchAll(expenseCompensationPattern)) {
    const clause = normalizeSpaces(match[2]);
    const liability = expenseCompensationLiabilityFromClause(clause);
    if (!liability) continue;
    const index = (match.index || 0) + match[1].length;
    matches.push({
      rawLiability: liability,
      liability,
      index,
      contextStart: index,
      scopeText: clause,
    });
  }
  const untitledInsurancePaymentPattern = /(^|[\n。；;])([^。\n；;]{8,620}?(?:计算和支付保险金|支付保险金|给付保险金)[^。\n；;]{0,220})/gu;
  for (const match of source.matchAll(untitledInsurancePaymentPattern)) {
    const clause = normalizeSpaces(match[2]);
    const liability = untitledInsurancePaymentLiability(clause);
    if (!liability || !liabilityLooksClean(liability)) continue;
    const index = (match.index || 0) + match[1].length;
    matches.push({
      rawLiability: liability,
      liability,
      index,
      contextStart: index,
      scopeText: clause,
    });
  }
  const waiverPattern = /(^|[\n。；;])([^。\n；;]{8,620}?(?:豁\s*免|免\s*予\s*收\s*取)[^。\n；;]{0,260}?(?:保险费|保费)[^。\n；;]{0,120})/gu;
  for (const match of source.matchAll(waiverPattern)) {
    const clause = normalizeSpaces(match[2]);
    const compact = clause.replace(/\s+/gu, '');
    if (/不(?:承担|予)[^。；]{0,40}豁免(?:保险费|保费)/u.test(compact)) continue;
    let liability = '';
    if (/重大疾病|重疾/u.test(compact)) liability = '重大疾病豁免保险费';
    else if (/特定疾病/u.test(compact)) liability = '特定疾病豁免保险费';
    else if (/意外伤害/u.test(compact) && /身故/u.test(compact) && /身体高度残疾|高度残疾|高残|全残/u.test(compact)) liability = '意外身故或身体高度残疾豁免保险费';
    else if (/身故/u.test(compact) && /身体高度残疾|高度残疾|高残|全残/u.test(compact)) liability = '身故或身体高度残疾豁免保险费';
    else if (/身体高度残疾|高度残疾|高残|全残/u.test(compact)) liability = '身体高度残疾豁免保险费';
    else if (/身故/u.test(compact)) liability = '身故豁免保险费';
    if (!liability || !liabilityLooksClean(liability)) continue;
    const index = (match.index || 0) + match[1].length;
    matches.push({
      rawLiability: liability,
      liability,
      index,
      contextStart: index,
      scopeText: clause,
    });
  }
  return matches;
}

function conditionalEarlyLateAmountFormula(liability, text) {
  if (!/身故|全残|重大疾病|重疾|手术/u.test(liability)) return null;
  const normalized = normalizeSpaces(text);
  const compact = normalized.replace(/\s+/gu, '');
  if (/重大疾病/u.test(liability)
    && /一次性交付保险费的[^。；]{0,80}(?:基本保险金额|基本保额)[^。；]{0,160}分期交付保险费的[^。；]{0,120}(?:交费年度数|交费年数|缴费年度数)/u.test(compact)) {
    return {
      value: null,
      valueText: '',
      unit: '公式',
      basis: '基本保险金额、交费年度数、交费方式',
      formulaText: `${liability} = 条件给付（一次性交费：基本保险金额；分期交费：基本保险金额 × 确诊时交费年度数）`,
    };
  }
  if (/身故/u.test(liability)
    && /年满十八周岁[^。；]{0,40}前身故[^。；]{0,80}(?:所交保险费|已交保险费|本附加合同所交保险费)/u.test(compact)) {
    return {
      value: null,
      valueText: '',
      unit: '公式',
      basis: '已交保险费、年龄、是否已给付重大疾病保险金',
      formulaText: `${liability} = 条件给付（未满18周岁且未给付重大疾病保险金：已交保险费）`,
    };
  }
  const hasEarlyRefund = /(?:一年内|1年内|等待期)[^。；]{0,260}初始?基本保险金额[^。；]{0,40}10[％%][^。；]{0,180}无息返还所交保险费/u.test(compact)
    || /初始?基本保险金额[^。；]{0,40}10[％%][^。；]{0,180}无息返还所交保险费/u.test(compact);
  const hasEffectiveAmount = /有效保险金额[^。；]{0,24}给付|给付[^。；]{0,24}有效保险金额/u.test(compact);
  if (!hasEarlyRefund || !hasEffectiveAmount) return null;
  return {
    value: null,
    valueText: '',
    unit: '公式',
    basis: '初始基本保险金额、有效保险金额、所交保险费、合同生效时间/事故原因',
    formulaText: `${liability} = 条件给付（早期约定情形：初始基本保险金额 × 10% + 无息返还所交保险费；后续/意外约定情形：有效保险金额）`,
  };
}

function dayCountAmountFormula(liability, text) {
  if (!/(住院|重病监护|重症监护|住院收入|失能收入|手术|特定流感)/u.test(liability)) return null;
  if (!/(保险金|给付金|补偿金|收入保险金|津贴)$/u.test(liability)) return null;
  if (/津贴|补贴|日额/u.test(liability)) return null;
  const compact = normalizeSpaces(text).replace(/\s+/gu, '');
  if (!/(给付|补偿|赔付|支付)/u.test(compact)) return null;
  const dayCountTerms = '给付天数|给付日数|住院天数|实际住院天数|实际住院日数|实际住院日|实际日数|住院日数|实际住院日|入住[^。；，,]{0,16}(?:天数|日数)|重病监护[^。；，,]{0,16}(?:天数|日数)|重症监护[^。；，,]{0,16}(?:天数|日数)|失能[^。；，,]{0,20}实际日数|丧失职业运动能力[^。；，,]{0,20}实际日数';
  const dailyAmountTerms = '每日住院给付基本保险金额|住院津贴日额|住院日额津贴|日住院津贴额|日津贴额|日津贴金额|日住院津贴|每日住院津贴金额|每日津贴金额|日定额给付金额|住院日定额给付金额';
  const amountTerms = `${dailyAmountTerms}|月给付标准|基本保险金额|基本保额|保险金额`;
  const hasDayAmountFormula = new RegExp(`(?:${dayCountTerms})[^。；]{0,120}(?:乘以|×|x|X|\\*)[^。；]{0,80}(?:${amountTerms})`, 'u').test(compact)
    || new RegExp(`(?:${amountTerms})[^。；]{0,80}(?:乘以|×|x|X|\\*)[^。；]{0,120}(?:${dayCountTerms})`, 'u').test(compact)
    || new RegExp(`(?:${dayCountTerms})[^。；]{0,140}(?:与|和)[^。；]{0,100}(?:${amountTerms})[^。；]{0,20}乘积`, 'u').test(compact)
    || new RegExp(`(?:${amountTerms})[^。；]{0,100}(?:与|和)[^。；]{0,140}(?:${dayCountTerms})[^。；]{0,20}乘积`, 'u').test(compact)
    || /(?:五十日|50日|五十天|50天)[^。；]{0,30}(?:乘以|×|x|X|\*)[^。；]{0,50}(?:每日住院津贴金额|日津贴额|日津贴金额|住院津贴日额)/u.test(compact)
    || /月给付金额[^。；]{0,20}月给付标准[^。；]{0,12}(?:乘以|×|x|X|\*)[^。；]{0,12}给付比例/u.test(compact);
  if (!hasDayAmountFormula) return null;
  const basis = /月给付标准/u.test(compact) ? '月给付标准、给付比例、实际日数'
    : /每日住院给付基本保险金额/u.test(compact) ? '每日住院给付基本保险金额'
    : /每日住院津贴金额/u.test(compact) ? '每日住院津贴金额'
    : /日住院津贴/u.test(compact) ? '日住院津贴'
    : /住院日额津贴/u.test(compact) ? '住院日额津贴'
    : /住院津贴日额/u.test(compact) ? '住院津贴日额'
    : /日住院津贴额|日津贴额|日津贴金额|日定额给付金额|住院日定额给付金额/u.test(compact) ? '日津贴额'
      : /基本保险金额|基本保额/u.test(compact) ? '基本保险金额'
        : '保险金额';
  const formulaText = /月给付标准/u.test(compact)
    ? `${liability} = 月给付标准 × 给付比例 × 给付月数/实际日数`
    : /(?:五十日|50日|五十天|50天)/u.test(compact)
      ? `${liability} = 50日 × ${basis}`
      : `${liability} = 给付天数 × ${basis}`;
  return {
    value: null,
    valueText: '',
    unit: '公式',
    basis: `给付天数、${basis}`,
    formulaText,
  };
}

export function formulaFor(liability, sectionText) {
  const fullText = normalizeSpaces(sectionText);
  const currentLiabilityIndex = fullText.indexOf(liability);
  const compactLiability = normalizeLookupText(liability);
  const compactPrefixHasLiability = normalizeLookupText(fullText.slice(0, 120)).includes(compactLiability);
  const conditionalFormula = conditionalEarlyLateAmountFormula(liability, fullText);
  if (conditionalFormula) return conditionalFormula;
  if (currentLiabilityIndex >= 0) {
    const leadWindow = fullText.slice(Math.max(0, currentLiabilityIndex - 260), currentLiabilityIndex + liability.length + 260);
    const compactLeadWindow = leadWindow.replace(/\s+/gu, '');
    const paidPremiumBeforeLiability = compactLeadWindow.match(new RegExp(`(?:按|按照)([^。；]{0,160}?已交(?:纳)?(?:保险费|保费)(?:[^。；]{0,80}?已交(?:纳)?(?:保险费|保费))?(?:之和)?)[^。；]{0,24}?(\\d+(?:\\.\\d+)?)[％%][^。；]{0,24}?给付${escapeRegExp(liability)}`, 'u'));
    if (paidPremiumBeforeLiability?.[1] && paidPremiumBeforeLiability?.[2] && !/医疗|门诊|住院|费用|津贴|补贴/u.test(liability)) {
      const percentValue = Number(paidPremiumBeforeLiability[2]);
      if (Number.isFinite(percentValue) && percentValue > 0) {
        const basis = normalizeSpaces(paidPremiumBeforeLiability[1])
          .replace(/^.*?(?=已交(?:纳)?(?:保险费|保费))/u, '');
        return {
          value: percentValue,
          valueText: paidPremiumBeforeLiability[2],
          unit: '%',
          basis,
          formulaText: `${liability} = ${basis} × ${paidPremiumBeforeLiability[2]}%`,
        };
      }
    }
    const amountPercentBeforeLiability = compactLeadWindow.match(new RegExp(`(?:按|按照)[^。；]{0,120}?((?:${AMOUNT_BASIS_PATTERN}))[^。；]{0,24}?(\\d+(?:\\.\\d+)?)[％%][^。；]{0,24}?给付${escapeRegExp(liability)}`, 'u'));
    if (amountPercentBeforeLiability?.[1] && amountPercentBeforeLiability?.[2] && !/医疗|门诊|住院|费用|津贴|补贴/u.test(liability)) {
      const percentValue = Number(amountPercentBeforeLiability[2]);
      if (Number.isFinite(percentValue) && percentValue > 0) {
        const basis = /基本责任.{0,18}保险金额/u.test(leadWindow) && amountPercentBeforeLiability[1] !== '有效保险金额'
          ? '基本责任保险金额'
          : canonicalAmountBasis(amountPercentBeforeLiability[1], leadWindow);
        return {
          value: percentValue,
          valueText: amountPercentBeforeLiability[2],
          unit: '%',
          basis,
          formulaText: `${liability} = ${basis} × ${amountPercentBeforeLiability[2]}%`,
        };
      }
    }
    const equivalentAmountPercentBeforeLiability = compactLeadWindow.match(new RegExp(`给付等值于[^。；]{0,80}?((?:${AMOUNT_BASIS_PATTERN}))(\\d+(?:\\.\\d+)?)[％%][^。；]{0,24}?${escapeRegExp(liability)}`, 'u'));
    if (equivalentAmountPercentBeforeLiability?.[1] && equivalentAmountPercentBeforeLiability?.[2] && !/医疗|门诊|住院|费用|津贴|补贴/u.test(liability)) {
      const percentValue = Number(equivalentAmountPercentBeforeLiability[2]);
      if (Number.isFinite(percentValue) && percentValue > 0) {
        const basis = canonicalAmountBasis(equivalentAmountPercentBeforeLiability[1], leadWindow);
        return {
          value: percentValue,
          valueText: equivalentAmountPercentBeforeLiability[2],
          unit: '%',
          basis,
          formulaText: `${liability} = ${basis} × ${equivalentAmountPercentBeforeLiability[2]}%`,
        };
      }
    }
    const equivalentAmountBeforeLiability = compactLeadWindow.match(new RegExp(`给付等值于[^。；]{0,80}?(?:本合同|本附加合同)?((?:${AMOUNT_BASIS_PATTERN}))的?${escapeRegExp(liability)}`, 'u'));
    if (equivalentAmountBeforeLiability?.[1] && !/医疗|门诊|住院|费用|津贴|补贴/u.test(liability)) {
      const basis = canonicalAmountBasis(equivalentAmountBeforeLiability[1], leadWindow);
      return {
        value: 100,
        valueText: '100',
        unit: '%',
        basis,
        formulaText: `${liability} = ${basis} × 100%`,
      };
    }
    const liabilityEquivalentAmount = compactLeadWindow.match(new RegExp(`${escapeRegExp(liability)}等值于[^。；]{0,80}?((?:${AMOUNT_BASIS_PATTERN})|保险单年度的保险金额)`, 'u'));
    if (liabilityEquivalentAmount?.[1] && !/医疗|门诊|住院|费用|津贴|补贴/u.test(liability)) {
      const basis = liabilityEquivalentAmount[1] === '保险单年度的保险金额'
        ? '保险单年度保险金额'
        : canonicalAmountBasis(liabilityEquivalentAmount[1], leadWindow);
      return {
        value: 100,
        valueText: '100',
        unit: '%',
        basis,
        formulaText: `${liability} = ${basis} × 100%`,
      };
    }
    const paidPremiumBeforeLiabilityNoPercent = compactLeadWindow.match(new RegExp(`(?:按|按照)[^。；]{0,120}(?:${PAID_PREMIUM_PATTERN})[^。；]{0,36}给付${escapeRegExp(liability)}`, 'u'));
    if (paidPremiumBeforeLiabilityNoPercent && !/医疗|门诊|住院|费用|津贴|补贴/u.test(liability)) {
      return {
        value: null,
        valueText: '',
        unit: '公式',
        basis: '已交保险费',
        formulaText: `${liability} = 已交保险费`,
      };
    }
  }
  const scopedText = currentLiabilityIndex >= 0 && !compactPrefixHasLiability
    ? fullText.slice(Math.max(0, currentLiabilityIndex - 700), currentLiabilityIndex + 1800)
    : fullText;
  const exclusionIndex = scopedText.search(/保险金给付限制|给付限制|责任免除|免除责任|除外责任|我们不保什么/u);
  const text = exclusionIndex > 60 ? scopedText.slice(0, exclusionIndex) : scopedText;
  if (/(保险金给付限制|给付限制|已给付|已赔付|已领取)/u.test(scopedText.slice(0, 260)) && /降低为|降为|减少为/u.test(scopedText.slice(0, 360))) {
    return null;
  }
  const dayCountFormula = dayCountAmountFormula(liability, text);
  if (dayCountFormula) return dayCountFormula;
  if (/意外住院津贴保险金/u.test(liability)) {
    const compact = text.replace(/\s+/gu, '');
    if (/住院日数[^。；]{0,40}免赔日数[^。；]{0,80}(?:乘以|×|x|X|\*)[^。；]{0,40}基本保险金额/u.test(compact)
      || /(?:乘以|×|x|X|\*)基本保险金额/u.test(compact) && /住院日数/u.test(compact)) {
      return {
        value: null,
        valueText: '',
        unit: '公式',
        basis: '住院日数、免赔日数、基本保险金额',
        formulaText: `${liability} = (住院日数 - 免赔日数) × 基本保险金额`,
      };
    }
  }
  if (/豁免/u.test(liability)) {
    const compact = text.replace(/\s+/gu, '');
    const positivePattern = /豁免[^。；]{0,180}(?:以后|之后|后续|续期|剩余|余下|未交|应交|应付未付|各期)[^。；]{0,140}(?:保险费|保费)|(?:以后|之后|后续|续期|剩余|余下|未交|应交|应付未付|各期)[^。；]{0,140}(?:保险费|保费)[^。；]{0,80}豁免|免予收取[^。；]{0,180}(?:保险费|保费)/u;
    const positiveWaiver = positivePattern.test(compact);
    if (!positiveWaiver) return null;
    const positiveIndex = compact.search(positivePattern);
    const liabilityIndex = compact.indexOf(liability.replace(/\s+/gu, ''));
    const afterLiability = liabilityIndex >= 0 ? compact.slice(liabilityIndex + liability.replace(/\s+/gu, '').length) : compact;
    const actionPattern = /免予收取[^。；]{0,180}(?:保险费|保费)|豁免[^。；]{0,180}(?:以后|之后|后续|续期|剩余|余下|未交|应交|应付未付|各期)[^。；]{0,140}(?:保险费|保费)|(?:以后|之后|后续|续期|剩余|余下|未交|应交|应付未付|各期)[^。；]{0,140}(?:保险费|保费)[^。；]{0,80}豁免/u;
    const actionIndexAfterLiability = afterLiability.search(actionPattern);
    const actionIndex = actionIndexAfterLiability >= 0 ? compact.length - afterLiability.length + actionIndexAfterLiability : positiveIndex;
    const rejectedIndex = compact.search(/不(?:承担|予)[^。；]{0,30}豁免保险费/u);
    if (rejectedIndex >= 0 && rejectedIndex < actionIndex) return null;
    const actionWindow = actionIndexAfterLiability >= 0
      ? afterLiability.slice(actionIndexAfterLiability, actionIndexAfterLiability + 260)
      : compact.slice(positiveIndex, positiveIndex + 260);
    const positiveWindow = actionWindow.split(/[。；]/u)[0] || actionWindow;
    const hasMainContractPremium = /主合同[^。；]{0,120}(?:保险费|保费)|(?:保险费|保费)[^。；]{0,120}主合同/u.test(positiveWindow);
    const hasAttachedContractPremium = /(?:附加合同|其他人身保险合同)[^。；]{0,120}(?:保险费|保费)|(?:保险费|保费)[^。；]{0,120}(?:附加合同|其他人身保险合同)/u.test(positiveWindow);
    const basis = hasMainContractPremium && hasAttachedContractPremium
      ? '主合同及符合约定附加合同后续应交保险费'
      : hasMainContractPremium
        ? '主合同后续应交保险费'
        : '后续应交保险费';
    return {
      value: null,
      valueText: '',
      unit: '公式',
      basis,
      formulaText: `${liability} = 豁免后续应交保险费`,
    };
  }
  if (/综合医疗保险金/u.test(liability) && /账户余额/u.test(text) && /给付/u.test(text)) {
    const compact = text.replace(/\s+/gu, '');
    const accountBasis = /公共综合医疗保险金/u.test(liability) || /公共账户/u.test(compact.slice(0, 360))
      ? '公共账户余额'
      : /个人综合医疗保险金/u.test(liability) || /个人账户/u.test(compact.slice(0, 360))
        ? '个人账户余额'
        : '';
    const accountBalanceLimitPattern = accountBasis === '个人账户余额'
      ? /累计给付金额[^。；]{0,48}以[^。；]{0,80}个人账户[^。；]{0,16}账户余额[^。；]{0,12}为限/u
      : /累计给付金额[^。；]{0,48}以[^。；]{0,80}公共账户[^。；]{0,16}账户余额[^。；]{0,12}为限/u;
    if (accountBasis && accountBalanceLimitPattern.test(compact)) {
      return {
        value: null,
        valueText: '',
        unit: '公式',
        basis: `${accountBasis}、约定给付标准`,
        formulaText: `${liability} = min(约定给付金额, ${accountBasis})`,
      };
    }
  }
  if (/津贴|补贴|日额/u.test(liability)) {
    const dailyAllowanceTerms = '日住院津贴额|日住院津贴金额|日住院津贴|每日津贴金额|每日给付金额|日津贴额|日津贴金额|津贴保险金日额|日重症监护住院津贴金额|意外住院日津贴金额|住院日额津贴|住院日定额给付金额|日定额给付标准|重症监护日定额给付金额|日生活津贴标准|一般住院日额津贴|恶性肿瘤住院日额津贴|重症监护日额津贴';
    const dayCountTerms = '给付天数|给付日数|住院天数|实际住院天数|实际住院日数|实际住院日|实际入住日数|实际日数|住院日数|实际入住重症监护病房日数|重症监护病房日数|入住[^。；，,]{0,12}实际天数|重症监护住院天数|生活津贴给付日数';
    const allowanceText = text.replace(/给付保险金/gu, `给付${liability}`);
    const compactText = text.replace(/\s+/gu, '');
    const compactAllowanceText = allowanceText.replace(/\s+/gu, '');
    const unitAllowance = text.match(/(?:每日给付额|每日津贴金额|每日给付金额|日住院津贴额|日津贴额|日津贴金额|日额津贴)[^。；，,]{0,30}?(\d+(?:\.\d+)?)\s*元\s*\/\s*(?:保险)?单位\s*\/\s*(?:天|日)/u)
      || text.match(/(\d+(?:\.\d+)?)\s*元\s*\/\s*(?:保险)?单位\s*\/\s*(?:天|日)/u);
    if (unitAllowance?.[1] && /保险单位数|单位数/u.test(text)) {
      return {
        value: Number(unitAllowance[1]),
        valueText: unitAllowance[1],
        unit: '元/单位/日',
        basis: '给付天数、每单位日津贴额、保险单位数',
        formulaText: `${liability} = 给付天数 × 每单位日津贴额 ${unitAllowance[1]} 元 × 保险单位数`,
      };
    }
    const allowance = text.match(/(?:每日给付额|每日津贴金额|每日给付金额|日住院津贴额|日津贴额|日津贴金额|日额津贴)[^。；，,]{0,30}?(\d+(?:\.\d+)?)\s*元\s*\/\s*(?:天|日)/u)
      || text.match(/(?:日住院津贴额|每日津贴金额|每日给付金额|日津贴额)[^。；，,]{0,12}?(\d+(?:\.\d+)?)\s*元/u)
      || text.match(/(\d+(?:\.\d+)?)\s*元\s*\/\s*(?:天|日)/u);
    if (allowance?.[1]) {
      return {
        value: Number(allowance[1]),
        valueText: allowance[1],
        unit: '元/日',
        basis: '给付天数',
        formulaText: `${liability} = 给付天数 × 日津贴额 ${allowance[1]} 元`,
      };
    }
    if (
      /(?:实际住院天数|实际住院日数|实际日数|住院日数|住院天数|给付天数|给付日数)[^。；]{0,100}(?:乘以|×|x|X|\*)[^。；]{0,60}(?:基本保险金额|基本保额|保险金额)/u.test(compactText)
      || /(?:基本保险金额|基本保额|保险金额)[^。；]{0,60}(?:乘以|×|x|X|\*)[^。；]{0,100}(?:实际住院天数|实际住院日数|实际日数|住院日数|住院天数|给付天数|给付日数)/u.test(compactText)
      || /(?:实际住院天数|实际住院日数|实际日数|住院日数)[^。；]{0,100}(?:乘以|×|x|X|\*)[^。；]{0,80}(?:基本保险金额|基本保额|保险金额)/u.test(compactAllowanceText)
    ) {
      const basis = /住院津贴基本保险金额/u.test(text) ? '住院津贴基本保险金额'
        : /基本保险金额|基本保额/u.test(text) ? '基本保险金额'
          : '保险金额';
      return {
        value: null,
        valueText: '',
        unit: '公式',
        basis: `给付天数、${basis}`,
        formulaText: `${liability} = 给付天数 × ${basis}`,
      };
    }
    if (
      new RegExp(`(?:${dayCountTerms})[^。；]{0,100}(?:乘以|×|x|X|\\*)[^。；]{0,60}(?:${dailyAllowanceTerms})`, 'u').test(compactText)
      || new RegExp(`(?:${dailyAllowanceTerms})[^。；]{0,60}(?:乘以|×|x|X|\\*)[^。；]{0,100}(?:${dayCountTerms})`, 'u').test(compactText)
      || new RegExp(`(?:${dailyAllowanceTerms})[^。；]{0,80}(?:与|和)[^。；]{0,120}(?:${dayCountTerms})[^。；]{0,20}乘积`, 'u').test(compactText)
      || new RegExp(`(?:${dayCountTerms})[^。；]{0,120}(?:与|和)[^。；]{0,80}(?:${dailyAllowanceTerms})[^。；]{0,20}乘积`, 'u').test(compactText)
      || new RegExp(`(?:${dayCountTerms})[^。；]{0,100}(?:乘以|×|x|X|\\*)[^。；]{0,60}(?:${dailyAllowanceTerms})`, 'u').test(compactAllowanceText)
      || new RegExp(`(?:${dailyAllowanceTerms})[^。；]{0,60}(?:乘以|×|x|X|\\*)[^。；]{0,100}(?:${dayCountTerms})`, 'u').test(compactAllowanceText)
    ) {
      const basis = /日生活津贴标准/u.test(compactText) ? '日生活津贴标准'
        : /住院日额津贴/u.test(compactText) ? '住院日额津贴'
        : /日住院津贴/u.test(compactText) ? '日住院津贴'
          : '日津贴额';
      const dayDeduct = text.match(/扣减\s*(\d+)\s*日/u);
      return {
        value: null,
        valueText: '',
        unit: '公式',
        basis: `给付天数、${basis}${dayDeduct?.[1] ? `、疾病住院扣减${dayDeduct[1]}日` : ''}`,
        formulaText: `${liability} = 给付天数 × ${basis}`,
      };
    }
    return null;
  }
  if (/补偿金/u.test(liability)
    && /补偿金额[^。；]{0,40}给付|给付[^。；]{0,40}补偿(?:金)?|住院费用补偿|医疗费用补偿|医药费用补偿/u.test(text)) {
    const compact = text.replace(/\s+/gu, '');
    if (/每日住院给付补偿金/u.test(liability)
      && /每日住院给付基本保险金额[^。；]{0,80}(?:乘以|×|x|X|\*)[^。；]{0,40}住院日数|住院日数[^。；]{0,80}(?:乘以|×|x|X|\*)[^。；]{0,40}每日住院给付基本保险金额/u.test(compact)) {
      return {
        value: null,
        valueText: '',
        unit: '公式',
        basis: '住院日数、每日住院给付基本保险金额',
        formulaText: `${liability} = 住院日数 × 每日住院给付基本保险金额`,
      };
    }
    if (/手术费补偿金/u.test(liability) && /实际手术费|手术费/u.test(compact)) {
      return {
        value: null,
        valueText: '',
        unit: '公式',
        basis: '实际合理手术费、手术费基本保险金额、已获补偿',
        formulaText: `${liability} = min(实际合理手术费 - 已获补偿, 手术费基本保险金额)`,
      };
    }
    if (/住院费用补偿金/u.test(liability) && /实际住院费用|住院费用/u.test(compact)) {
      return {
        value: null,
        valueText: '',
        unit: '公式',
        basis: '实际合理住院费用、基本保险金额、已获补偿',
        formulaText: `${liability} = min(实际合理住院费用 - 已获补偿, 基本保险金额)`,
      };
    }
    return {
      value: null,
      valueText: '',
      unit: '公式',
      basis: '约定补偿金额',
      formulaText: `${liability} = 约定补偿金额`,
    };
  }
  if (/门诊|住院|医疗|药品|药械|费用|报销|补偿|质子重离子/u.test(liability)
    && /医疗费用|实际发生|合理且必要|合理且必须|给付比例|赔付比例|免赔额|补偿/u.test(text)) {
    if (/交通费用|公共交通费用|异地转诊|救护车|住宿费用|转运|遗体|灵柩|亲属/u.test(liability)) return null;
    const liabilityIndex = text.indexOf(liability);
    const formulaWindow = liabilityIndex >= 0 ? text.slice(Math.max(0, liabilityIndex - 700), liabilityIndex + 500) : text.slice(0, 1200);
    const medicalPercent = explicitMedicalPercentFromText(formulaWindow);
    if (!medicalPercent) {
      const parameterizedWindow = liabilityIndex >= 0 ? text.slice(Math.max(0, liabilityIndex - 700), liabilityIndex + 1800) : text.slice(0, 1800);
      const parameterized = parameterizedMedicalFormulaFromText(parameterizedWindow);
      if (!parameterized) return null;
      const formulaText = parameterized.formulaText
        ? parameterized.formulaText.replace(/^医疗费用保险金\s*=/u, `${liability} =`)
        : `${liability} = (实际合理医疗费用 - 已获补偿/给付 - 免赔额) × 约定给付比例`;
      return {
        ...parameterized,
        formulaText,
      };
    }
    return {
      value: Number(medicalPercent),
      valueText: medicalPercent,
      unit: '%',
      basis: '实际合理医疗费用',
      formulaText: `${liability} = (实际合理医疗费用 - 已获补偿 - 免赔额/起付金额) × ${medicalPercent}%`,
    };
  }
  if (
    /身故/u.test(liability)
    && /意外/u.test(text)
    && /给付限额|保险金额|基本保险金额|基本保额/u.test(text)
    && /扣除[^。；]{0,60}已给付[^。；]{0,60}(?:伤残|残疾)保险金[^。；]{0,60}余额/u.test(text)
  ) {
    const basis = /基本保险金额|基本保额/u.test(text) ? '基本保险金额'
      : /保险金额/u.test(text) ? '保险金额'
        : '给付限额';
    return {
      value: null,
      valueText: '',
      unit: '公式',
      basis: `${basis}、已给付伤残保险金`,
      formulaText: `${liability} = ${basis} - 已给付伤残保险金`,
    };
  }
  if (/较高者|较高值|最大者|较大者|较大值|三项金额|两项金额|两项中的较大|两者/u.test(text)) {
    const maxIndex = text.search(/较高者|较高值|最大者|较大者|较大值|三项金额|两项金额|两项中的较大|两者/u);
    const maxWindow = maxIndex >= 0 ? text.slice(maxIndex, maxIndex + 520) : text;
    const footnoteIndex = maxWindow.search(/。\s*\d+(?:保单年度|本合同|现金价值|保险费|周岁|累计已给付)/u);
    const maxText = footnoteIndex > 60 ? maxWindow.slice(0, footnoteIndex + 1) : maxWindow;
    if (/累积红利|红利基本保险金额|保单红利|分红[^）)]{0,80}(?:现金价值|保险金额|给付|较大|较高)/u.test(maxText)) return null;
    const paidPremiumPercentInMax = maxText.match(/(?:已支付|已交|已交纳)(?:的)?(?:保险费|保费)[^。；，,]{0,16}?(\d+(?:\.\d+)?)\s*[％%]/u);
    if (paidPremiumPercentInMax?.[1] && /现金价值/u.test(maxText) && !/医疗|门诊|住院|费用|津贴|补贴/u.test(liability)) {
      const percentValue = Number(paidPremiumPercentInMax[1]);
      if (Number.isFinite(percentValue) && percentValue > 0) {
        const cashBasis = /现金价值\s*之\s*和/u.test(maxText) ? '主险及附加险现金价值之和' : '现金价值';
        return {
          value: null,
          valueText: '',
          unit: '公式',
          basis: `已交保险费 × ${paidPremiumPercentInMax[1]}%、${cashBasis}`,
          formulaText: `${liability} = max(已交保险费 × ${paidPremiumPercentInMax[1]}%, ${cashBasis})`,
        };
      }
    }
    const basis = [];
    if (/基本保险金额|基本保额/u.test(maxText)) basis.push('基本保险金额');
    if (/有效保险金额/u.test(maxText)) basis.push('有效保险金额');
    if (/现金价值/u.test(maxText)) basis.push('现金价值');
    if (/已交|已交纳|累计已交|保险费/u.test(maxText)) {
      basis.push(/已(?:交|支付)(?:的)?(?:保险费|保费)的一定比例|已支付的保险费比例表|已交(?:纳)?(?:保险费|保费)[^。；]{0,20}对应比例/u.test(maxText)
        ? '已交保险费 × 对应比例'
        : '已交保险费');
    }
    if (/账户价值/u.test(maxText)) basis.push(/个人账户|账户已归属/u.test(maxText) ? '个人账户价值' : '保单账户价值');
    if (/剩余保险期间/u.test(maxText) && /基本保险金额|基本保额/u.test(maxText) && /十分之一|1\/10|10%/u.test(maxText)) {
      basis.push('剩余保险期间 × 基本保险金额 / 10');
    }
    if (basis.length >= 2) {
      return {
        value: null,
        valueText: '',
        unit: '公式',
        basis: basis.join('、'),
        formulaText: `${liability} = max(${basis.join(', ')})`,
      };
    }
  }
  const equalsFormula = amountEqualsFormula(liability, text);
  if (equalsFormula) return equalsFormula;
  const injuryText = currentLiabilityIndex >= 0
    ? fullText.slice(Math.max(0, currentLiabilityIndex - 420), currentLiabilityIndex + 700)
    : text;
  if (
    /伤残|残疾|骨折|烧伤|烧烫伤|脱位/u.test(liability)
    && !/高残|高度残疾/u.test(liability)
    && /给付\s*比例|比例表|伤残等级|残疾等级|残疾程度|评定标准/u.test(injuryText)
    && /基本保险金额|基本保额|保险金额|意外伤害基本保险金额|意外身故基本保险金额/u.test(injuryText)
  ) {
    const amountBasis = /意外身故基本保险金额/u.test(injuryText) ? '意外身故基本保险金额'
      : /意外伤害基本保险金额/u.test(injuryText) ? '意外伤害基本保险金额'
        : /基本保险金额|基本保额/u.test(injuryText) ? '基本保险金额'
          : '保险金额';
    const multiple = injuryText.match(/(?:基本保险金额|基本保额|保险金额)[^。；，,]{0,8}?(\d+(?:\.\d+)?)\s*倍/u);
    const basis = multiple?.[1] ? `${amountBasis} × ${multiple[1]}` : amountBasis;
    const ratioBasis = /烧伤|烧烫伤/u.test(liability) ? '烧伤给付比例'
      : /骨折/u.test(liability) ? '骨折给付比例'
        : '伤残/残疾等级给付比例';
    return {
      value: null,
      valueText: '',
      unit: '公式',
      basis: `${basis}、${ratioBasis}`,
      formulaText: `${liability} = ${basis} × ${ratioBasis}`,
    };
  }
  if (/年金|养老金|养老保险金/u.test(liability)
    && /领取计划|按年领取|按月领取/u.test(text)
    && /基本保险金额|基本保额/u.test(text)) {
    const rates = [...text.matchAll(/(?:基本保险金额|基本保额)的?\s*(\d+(?:\.\d+)?)\s*[％%]/gu)]
      .map((match) => match[1]);
    if (new Set(rates).size > 1) {
      return {
        value: null,
        valueText: '',
        unit: '公式',
        basis: '基本保险金额、领取计划/领取频率对应比例',
        formulaText: `${liability} = 基本保险金额 × 约定领取比例`,
      };
    }
  }
  const amountMultiple = text.match(/(有效保险金额|意外伤害基本保险金额|基本保险金额|基本保额|保险金额)[^。；，,]{0,16}?(\d+(?:\.\d+)?)\s*倍[^。；，,]{0,30}?给付/u);
  if (amountMultiple?.[1] && amountMultiple?.[2] && !/医疗|门诊|住院|费用|津贴|补贴/u.test(liability)) {
    const multipleValue = Number(amountMultiple[2]);
    if (Number.isFinite(multipleValue) && multipleValue > 0) {
      const basis = canonicalAmountBasis(amountMultiple[1], text);
      return {
        value: multipleValue,
        valueText: amountMultiple[2],
        unit: '倍',
        basis,
        formulaText: `${liability} = ${basis} × ${amountMultiple[2]}`,
      };
    }
  }
  const percent = text.match(/(?:有效保险金额|意外伤害基本保险金额|基本保险金额|基本保额|保险金额)[^。；，,]{0,24}?(\d+(?:\.\d+)?)\s*[％%]/u)
    || text.match(/(\d+(?:\.\d+)?)\s*[％%][^。；，,]{0,24}?(?:有效保险金额|意外伤害基本保险金额|基本保险金额|基本保额|保险金额)/u);
  if (percent?.[1] && !/医疗|门诊|住院|费用|津贴|补贴/u.test(liability)) {
    const percentValue = Number(percent[1]);
    if (!Number.isFinite(percentValue) || percentValue <= 0) return null;
    const basis = canonicalAmountBasis(/有效保险金额/u.test(text) ? '有效保险金额' : '基本保险金额', text);
    return {
      value: percentValue,
      valueText: percent[1],
      unit: '%',
      basis,
      formulaText: `${liability} = ${basis} × ${percent[1]}%`,
    };
  }
  const dailyAmountMultiple = text.match(/日额保险金额\s*[×xX*]\s*(\d+(?:\.\d+)?)/u)
    || text.match(/日额保险金额[^。；，,]{0,12}?(\d+(?:\.\d+)?)\s*倍/u);
  if (dailyAmountMultiple?.[1] && /康复保险金|津贴保险金|手术保险金/u.test(liability)) {
    return {
      value: Number(dailyAmountMultiple[1]),
      valueText: dailyAmountMultiple[1],
      unit: '倍',
      basis: '日额保险金额',
      formulaText: `${liability} = 日额保险金额 × ${dailyAmountMultiple[1]}`,
    };
  }
  const accountPercent = text.match(/账户价值[^。；，,]{0,30}?(\d+(?:\.\d+)?)\s*[％%]/u)
    || text.match(/(\d+(?:\.\d+)?)\s*[％%][^。；，,]{0,30}?账户价值/u);
  if (accountPercent?.[1] && /账户价值/u.test(text) && /给付/u.test(text) && accountValueLooksScopedToLiability(liability, text)) {
    const percentValue = Number(accountPercent[1]);
    if (!Number.isFinite(percentValue) || percentValue <= 0) return null;
    const basis = /个人账户|账户已归属/u.test(text) ? '个人账户价值' : '保单账户价值';
    return {
      value: percentValue,
      valueText: accountPercent[1],
      unit: '%',
      basis,
      formulaText: `${liability} = ${basis} × ${accountPercent[1]}%`,
    };
  }
  if (new RegExp(CASHFLOW_TITLE_TERMS, 'u').test(liability)
    && /养老年金领取金额|年金领取金额|生存年金领取金额|特别年金领取金额/u.test(text)) {
    const basis = text.match(/特别年金领取金额/u) ? '特别年金领取金额'
      : text.match(/生存年金领取金额/u) ? '生存年金领取金额'
        : text.match(/养老年金领取金额/u) ? '养老年金领取金额'
          : '年金领取金额';
    return {
      value: null,
      valueText: '',
      unit: '公式',
      basis,
      formulaText: `${liability} = 保险单载明的${basis}`,
    };
  }
  if (new RegExp(CASHFLOW_TITLE_TERMS, 'u').test(liability)
    && /(?:保险合同|保险单|本合同|合同)载明的(?:年金)?领取金额/u.test(text)) {
    const basis = text.match(/((?:保险合同|保险单|本合同|合同)载明的(?:年金)?领取金额)/u)?.[1] || '保险合同载明的领取金额';
    return {
      value: null,
      valueText: '',
      unit: '公式',
      basis,
      formulaText: `${liability} = ${basis}`,
    };
  }
  if (/账户价值/u.test(text) && /给付/u.test(text) && accountValueLooksScopedToLiability(liability, text)) {
    const basis = /个人账户|账户已归属/u.test(text) ? '个人账户价值' : '保单账户价值';
    return {
      value: null,
      valueText: '',
      unit: '公式',
      basis,
      formulaText: `${liability} = ${basis}`,
    };
  }
  if (/账户资金余额/u.test(text) && /给付/u.test(text) && /身故|全残|年金|养老金|养老保险金/u.test(liability)) {
    const basis = /个人账户资金余额/u.test(text) ? '个人账户资金余额' : '账户资金余额';
    return {
      value: null,
      valueText: '',
      unit: '公式',
      basis,
      formulaText: `${liability} = ${basis}`,
    };
  }
  if (/护理保险金/u.test(liability)
    && /护理服务|失能|日常生活能力/u.test(text)
    && /按照?本合同的约定给付|本公司按照?本合同|依本合同的约定给付/u.test(text.replace(/\s+/gu, ''))) {
    if (new RegExp(`${escapeRegExp(liability)}金额`, 'u').test(text)) {
      return {
        value: null,
        valueText: '',
        unit: '公式',
        basis: `${liability}金额、约定护理服务给付标准`,
        formulaText: `${liability} = 条款约定给付，累计以${liability}金额为限`,
      };
    }
    return {
      value: null,
      valueText: '',
      unit: '公式',
      basis: '约定护理服务给付标准',
      formulaText: `${liability} = 条款约定给付`,
    };
  }
  if (/工伤补助金/u.test(liability)
    && /工伤|职工工伤|职业病/u.test(text)
    && /本人工资|职工月平均工资|给付倍数/u.test(text)
    && /给付/u.test(text)) {
    return {
      value: null,
      valueText: '',
      unit: '公式',
      basis: '条款表、工伤等级、本人工资、职工月平均工资、给付倍数',
      formulaText: `${liability} = 条件给付（按工伤等级、本人工资/职工月平均工资与给付倍数确定）`,
    };
  }
  if (/节育并发症保险金/u.test(liability)
    && /节育并发症/u.test(text)
    && /保险金额|给付比例/u.test(text)
    && /给付/u.test(text)) {
    return {
      value: null,
      valueText: '',
      unit: '公式',
      basis: '保险金额、节育并发症等级、给付比例表',
      formulaText: `${liability} = 保险金额 × 节育并发症等级对应给付比例`,
    };
  }
  const tableRatioFormula = new RegExp(`${escapeRegExp(liability)}\\s*[=＝]\\s*(?:本合同)?(?:基本保险金额|基本保额|保险金额)\\s*[×xX*]\\s*${escapeRegExp(liability)}比例`, 'u');
  if (new RegExp(CASHFLOW_TITLE_TERMS, 'u').test(liability) && tableRatioFormula.test(text)) {
    const basis = /基本保险金额|基本保额/u.test(text) ? '基本保险金额' : '保险金额';
    return {
      value: null,
      valueText: '',
      unit: '公式',
      basis: `${basis}、${liability}比例`,
      formulaText: `${liability} = ${basis} × ${liability}比例`,
    };
  }
  const hasPaidPremium = new RegExp(PAID_PREMIUM_PATTERN, 'u').test(text);
  const hasRatioWord = /给付比例|赔付比例|对应比例|一定比例|约定比例|比例表/u.test(text);
  if (hasPaidPremium && hasRatioWord && /给付/u.test(text) && !/医疗|门诊|住院|费用|津贴|补贴/u.test(liability)) {
    return {
      value: null,
      valueText: '',
      unit: '公式',
      basis: '已交保险费、给付比例',
      formulaText: `${liability} = 已交保险费 × 对应给付比例`,
    };
  }
  const paidPremiumPercent = text.match(/(?:按|按照)[^。；，,]{0,80}?(首次交纳的?[^。；，,]{0,40}?(?:保险费|保费)|已交(?:纳)?[^。；，,]{0,40}?(?:保险费|保费)|所交[^。；，,]{0,40}?(?:保险费|保费)|已经交付[^。；，,]{0,40}?(?:保险费|保费)|实际交纳[^。；，,]{0,40}?(?:保险费|保费))[^。；，,]{0,16}?(\d+(?:\.\d+)?)\s*[％%][^。；，,]{0,40}?给付/u);
  if (paidPremiumPercent?.[1] && paidPremiumPercent?.[2]
    && new RegExp(`${CASHFLOW_TITLE_TERMS}|关爱金`, 'u').test(liability)
    && !/医疗|门诊|住院|费用|津贴|补贴/u.test(liability)) {
    const percentValue = Number(paidPremiumPercent[2]);
    if (Number.isFinite(percentValue) && percentValue > 0) {
      const basis = normalizeSpaces(paidPremiumPercent[1]);
      return {
        value: percentValue,
        valueText: paidPremiumPercent[2],
        unit: '%',
        basis,
        formulaText: `${liability} = ${basis} × ${paidPremiumPercent[2]}%`,
      };
    }
  }
  if (hasPaidPremium
    && /等待期|生效之日起[^。；]{0,30}(?:日|天|年)内/u.test(text)
    && /给付(?:保险金|保险|身故保险金|重大疾病保险金|特定疾病保险金|恶性肿瘤保险金)?/u.test(text)
    && /身故|疾病|恶性肿瘤|癌|重疾|重大疾病|特定疾病/u.test(liability)
    && !/医疗|门诊|住院|费用|津贴|补贴/u.test(liability)) {
    return {
      value: null,
      valueText: '',
      unit: '公式',
      basis: '已交保险费、等待期/早期约定',
      formulaText: `${liability} = 条件给付（等待期/早期约定情形：退还已交保险费）`,
    };
  }
  if (hasPaidPremium
    && /给付/u.test(text)
    && /所\s*交(?:保险费|保费)|已经\s*交付[^。；，,]{0,18}(?:保险费|保费)/u.test(text)
    && /身故|全残|满期|生存|祝寿|教育|婚嫁|立业|关爱|年金/u.test(liability)
    && !/医疗|门诊|住院|费用|津贴|补贴/u.test(liability)
    && !/现金价值|较高者|较高值|最大者|较大者|较大值|两者|三者|两项|三项|扣除|差额|余额|之和|加|乘以|计付|保险费期数|给付比例|赔付比例|对应比例|一定比例|约定比例|比例表|\d+(?:\.\d+)?\s*[％%]|百分之|\d+(?:\.\d+)?\s*倍/u.test(text)) {
    return {
      value: null,
      valueText: '',
      unit: '公式',
      basis: '已交保险费',
      formulaText: `${liability} = 已交保险费`,
    };
  }
  const paidPremiumLooksComplete = /满期|生存|祝寿|教育|婚嫁|立业|关爱|年金/u.test(liability)
    || !/基本保险金额|基本保额|保险金额|有效保险金额|现金价值|周岁|等待期|意外|疾病/u.test(text);
  if (hasPaidPremium
    && /给付/u.test(text)
    && paidPremiumLooksComplete
    && !/现金价值|较高者|较高值|最大者|较大者|较大值|两者|三者|两项|三项|扣除|差额|余额|之和|加|乘以|计付|保险费期数|给付比例|赔付比例|对应比例|一定比例|约定比例|比例表|\d+(?:\.\d+)?\s*[％%]|百分之|\d+(?:\.\d+)?\s*倍|医疗|门诊|住院|费用|津贴|补贴/u.test(text)
    && !/医疗|门诊|住院|费用|津贴|补贴/u.test(liability)) {
    return {
      value: null,
      valueText: '',
      unit: '公式',
      basis: '已交保险费',
      formulaText: `${liability} = 已交保险费`,
    };
  }
  if (/现金价值/u.test(text)
    && /给付/u.test(text)
    && !/已交|保险费|较高者|较高值|最大者|较大者|较大值|两者|三者|两项|三项|扣除|差额|余额|之和|加|乘以|给付比例|赔付比例|对应比例|一定比例|约定比例|比例表|\d+(?:\.\d+)?\s*[％%]|百分之|\d+(?:\.\d+)?\s*倍|医疗|门诊|住院|费用|津贴|补贴/u.test(text)
    && !/医疗|门诊|住院|费用|津贴|补贴/u.test(liability)) {
    return {
      value: null,
      valueText: '',
      unit: '公式',
      basis: '现金价值',
      formulaText: `${liability} = 现金价值`,
    };
  }
  if (/有效保险金额/u.test(text) && /(?:按|按照)[^。；，,]{0,32}有效保险金额[^。；，,]{0,24}给付/u.test(text)) {
    return {
      value: 100,
      valueText: '100',
      unit: '%',
      basis: '有效保险金额',
      formulaText: `${liability} = 有效保险金额 × 100%`,
    };
  }
  if (/基本保险金额|基本保额|意外伤害基本保险金额/u.test(text)
    && /(?:按|按照)[^。；，,]{0,32}(?:基本保险金额|基本保额|意外伤害基本保险金额)[^。；，,]{0,24}给付|给付等值于(?:本合同)?(?:基本保险金额|基本保额|意外伤害基本保险金额)|(?:基本保险金额|基本保额|意外伤害基本保险金额)[^。；，,]{0,8}[×xX*]\s*100\s*[％%]/u.test(text)
    && !/医疗|门诊|住院|费用|津贴|补贴/u.test(liability)) {
    return {
      value: 100,
      valueText: '100',
      unit: '%',
      basis: /意外伤害基本保险金额/u.test(text) ? '意外伤害基本保险金额' : '基本保险金额',
      formulaText: `${liability} = ${/意外伤害基本保险金额/u.test(text) ? '意外伤害基本保险金额' : '基本保险金额'} × 100%`,
    };
  }
  if (/保险金额/u.test(text)
    && /(?:按|按照)[^。；，,]{0,32}保险金额[^。；，,]{0,24}给付|保险金额[^。；，,]{0,8}[×xX*]\s*100\s*[％%]/u.test(text)
    && !/医疗|门诊|住院|费用|津贴|补贴/u.test(liability)) {
    return {
      value: 100,
      valueText: '100',
      unit: '%',
      basis: '保险金额',
      formulaText: `${liability} = 保险金额 × 100%`,
    };
  }
  return null;
}

export function conditionFromText(text) {
  const normalized = normalizeSpaces(text);
  const match = normalized.match(/(?:若|如果|自)([^。；]{6,120}?)(?:，|,|我们|本公司|按|给付)/u);
  return trim(match?.[1] || '');
}

function loadProductsWithoutIndicators(db, {
  minKnowledgeId = 0,
  companies = [],
  includeExistingProducts = false,
  knowledgeIds = [],
} = {}) {
  const targetIds = [...new Set((Array.isArray(knowledgeIds) ? knowledgeIds : [])
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item) && item > 0))];
  const idFilter = targetIds.length ? `AND id IN (${targetIds.map(() => '?').join(', ')})` : '';
  const rows = db.prepare(`
    SELECT id, company, product_name, url, payload
      FROM knowledge_records
     WHERE product_name IS NOT NULL AND product_name <> '' AND id >= ? ${idFilter}
     ORDER BY company, product_name, id DESC
  `).all(minKnowledgeId, ...targetIds);
  const indicatorKeys = new Set(db.prepare(`
    SELECT DISTINCT COALESCE(company, '') AS company, COALESCE(product_name, '') AS product_name
      FROM insurance_indicator_records
     WHERE product_name IS NOT NULL AND product_name <> ''
  `).all().map((row) => `${row.company}\u001f${row.product_name}`));
  const products = new Map();
  for (const row of rows) {
    const payload = parsePayload(row.payload);
    const company = trim(row.company || payload.company);
    const productName = trim(row.product_name || payload.productName);
    const key = `${company}\u001f${productName}`;
    if (!includeExistingProducts && indicatorKeys.has(key)) continue;
    if (companies.length && !companies.includes(company)) continue;
    const text = sourceText(payload);
    if (/同产品官方资料已存在保险责任正文/u.test(text)) continue;
    const textLooksUsable = responsibilityTextLooksUsable(text);
    if (!textLooksUsable && !products.has(key)) continue;
    if (!products.has(key)) {
      products.set(key, {
        company,
        productName,
        productType: trim(payload.productType),
        salesStatus: trim(payload.salesStatus),
        sourceRecordIds: [],
        sourceUrls: [],
        sourceTitles: [],
        textParts: [],
        productiveSourceCount: 0,
      });
    }
    const product = products.get(key);
    product.productType ||= trim(payload.productType);
    product.salesStatus ||= trim(payload.salesStatus);
    const sourceRecordId = String(payload.id || row.id);
    const sourceUrl = trim(payload.url || row.url);
    const sourceTitle = trim(payload.title);
    const sourceCanBuildIndicators = textLooksUsable
      ? buildIndicatorsForProduct({
        ...product,
        sourceText: text,
        sourceRecordId,
        sourceUrl,
        sourceTitle: sourceTitle || product.productName,
      }, '1970-01-01T00:00:00.000Z').length > 0
      : false;
    const combinedCanBuildIndicators = product.textParts.length
      ? buildIndicatorsForProduct({
        ...product,
        sourceText: `${text}\n${product.textParts.join('\n')}`.slice(0, 24000),
        sourceRecordId,
        sourceUrl,
        sourceTitle: sourceTitle || product.productName,
      }, '1970-01-01T00:00:00.000Z').length > 0
      : false;
    if (sourceCanBuildIndicators || combinedCanBuildIndicators) {
      const insertAt = product.productiveSourceCount || 0;
      product.sourceRecordIds.splice(insertAt, 0, sourceRecordId);
      if (sourceUrl) product.sourceUrls.splice(insertAt, 0, sourceUrl);
      if (sourceTitle) product.sourceTitles.splice(insertAt, 0, sourceTitle);
      product.textParts.splice(insertAt, 0, text);
      product.productiveSourceCount = insertAt + 1;
      continue;
    }
    product.sourceRecordIds.push(sourceRecordId);
    if (sourceUrl) product.sourceUrls.push(sourceUrl);
    if (sourceTitle) product.sourceTitles.push(sourceTitle);
    product.textParts.push(text);
  }
  return [...products.values()].map((product) => ({
    ...product,
    sourceText: product.textParts.join('\n').slice(0, 24000),
    sourceRecordId: product.sourceRecordIds[0] || '',
    sourceUrl: product.sourceUrls[0] || '',
    sourceTitle: product.sourceTitles[0] || product.productName,
  }));
}

export function buildIndicatorsForProduct(product, now) {
  const indicators = [];
  const seen = new Set();
  for (const section of splitBenefitSections(product.sourceText)) {
    const formula = formulaFor(section.liability, section.text);
    if (!formula) continue;
    const coverageType = coverageTypeFor(section.liability, section.text);
    const key = [coverageType, section.liability, formula.formulaText].map(normalizeLookupText).join('\u001f');
    if (seen.has(key)) continue;
    seen.add(key);
    const id = `ind_knowledge_auto_${sha1([product.company, product.productName, coverageType, section.liability, formula.formulaText].join('\u001f'))}`;
    indicators.push({
      id,
      company: product.company,
      productName: product.productName,
      productType: product.productType,
      salesStatus: product.salesStatus,
      coverageType,
      liability: section.liability,
      value: formula.value,
      valueText: formula.valueText,
      unit: formula.unit,
      basis: formula.basis,
      formulaText: formula.formulaText,
      condition: conditionFromText(section.text),
      responsibilityScope: section.responsibilityScope,
      quantificationStatus: 'quantified',
      extractionMethod: '知识库责任规则抽取',
      sourceRecordId: product.sourceRecordId,
      sourceUrl: product.sourceUrl,
      sourceTitle: product.sourceTitle,
      sourceExcerpt: limitText(section.text, 1200),
      sourceEvidenceLevel: product.sourceUrl ? 'official_excerpt' : 'local_excerpt',
      version: VERSION,
      updatedAt: now,
    });
  }
  const deduped = [];
  for (const indicator of [...indicators].sort((a, b) => b.liability.length - a.liability.length)) {
    const formulaTail = indicator.formulaText.replace(new RegExp(`^${indicator.liability.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\s*=\\s*`, 'u'), '');
    const duplicate = deduped.some((existing) => (
      existing.coverageType === indicator.coverageType
      && existing.formulaText.replace(new RegExp(`^${existing.liability.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\s*=\\s*`, 'u'), '') === formulaTail
      && (
        existing.liability === `${indicator.liability}保险金`
        || indicator.liability === `${existing.liability}保险金`
        || (
          normalizeLookupText(existing.liability).startsWith(normalizeLookupText(indicator.liability))
          && /(?:保险金|确诊金|慰问金)$/u.test(existing.liability)
          && indicator.liability.length >= 4
        )
        || (
          normalizeLookupText(indicator.liability).startsWith(normalizeLookupText(existing.liability))
          && /(?:保险金|确诊金|慰问金)$/u.test(indicator.liability)
          && existing.liability.length >= 4
        )
        || (
          indicator.liability === '豁免保险费'
          && existing.liability !== indicator.liability
          && /豁免保险费$/u.test(existing.liability)
        )
      )
    ));
    if (!duplicate) deduped.push(indicator);
  }
  return deduped.sort((a, b) => indicators.findIndex((item) => item.id === a.id) - indicators.findIndex((item) => item.id === b.id));
}

export function upsertIndicators(db, indicators) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS insurance_indicator_records (
      id TEXT PRIMARY KEY,
      company TEXT,
      product_name TEXT,
      coverage_type TEXT,
      liability TEXT,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_insurance_indicator_records_company ON insurance_indicator_records(company);
    CREATE INDEX IF NOT EXISTS idx_insurance_indicator_records_product_name ON insurance_indicator_records(product_name);
    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  const insert = db.prepare(`
    INSERT INTO insurance_indicator_records (id, company, product_name, coverage_type, liability, payload)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      company = excluded.company,
      product_name = excluded.product_name,
      coverage_type = excluded.coverage_type,
      liability = excluded.liability,
      payload = excluded.payload
  `);
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const indicator of indicators) {
      const payload = {
        ...indicator,
        ...indicatorCalculationPayloadFields(indicator),
      };
      insert.run(payload.id, payload.company, payload.productName, payload.coverageType, payload.liability, JSON.stringify(payload));
    }
    db.prepare(`
      INSERT INTO app_meta (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run('knowledge_responsibility_indicators_updated_at', new Date().toISOString());
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function ensureIndicatorRefreshTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS product_indicator_versions (
      product_key TEXT PRIMARY KEY,
      version INTEGER NOT NULL DEFAULT 0,
      batch_id TEXT,
      updated_at TEXT,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS indicator_update_batches (
      id TEXT PRIMARY KEY,
      created_at TEXT,
      product_keys TEXT NOT NULL DEFAULT '[]',
      changed_product_key_count INTEGER NOT NULL DEFAULT 0,
      affected_policy_count INTEGER NOT NULL DEFAULT 0,
      payload TEXT NOT NULL
    );
  `);
}

function policyDerivedProductKeys(row = {}) {
  const payload = parsePayload(row.payload, {});
  return uniqueStrings([
    ...parsePayload(row.product_keys, []),
    ...(Array.isArray(payload.productKeys) ? payload.productKeys : []),
  ]);
}

export function affectedDerivedRows(db, productKeys) {
  const changedKeys = new Set(uniqueStrings(productKeys));
  if (!changedKeys.size || !tableExists(db, 'policy_derived_results')) return [];
  return db.prepare('SELECT policy_id, product_keys, payload FROM policy_derived_results ORDER BY policy_id ASC')
    .all()
    .map((row) => ({
      policyId: Number(row.policy_id || 0),
      productKeys: policyDerivedProductKeys(row),
      payload: parsePayload(row.payload, {}),
    }))
    .filter((row) => row.policyId && row.productKeys.some((key) => changedKeys.has(key)));
}

export function markAffectedDerivedRowsStale(db, productKeys, now) {
  const rows = affectedDerivedRows(db, productKeys);
  if (!rows.length) return [];
  const update = db.prepare(`
    UPDATE policy_derived_results
    SET status = ?, stale_reason = ?, updated_at = ?, payload = ?
    WHERE policy_id = ?
  `);
  for (const row of rows) {
    update.run(
      'stale',
      'indicator_updated',
      now,
      JSON.stringify({
        ...row.payload,
        policyId: row.policyId,
        productKeys: row.productKeys,
        status: 'stale',
        staleReason: 'indicator_updated',
        updatedAt: now,
      }),
      row.policyId,
    );
  }
  return rows.map((row) => row.policyId);
}

export function recordIndicatorRefreshBatch(db, { productKeys, affectedPolicyCount, now }) {
  const keys = uniqueStrings(productKeys);
  if (!keys.length) return '';
  ensureIndicatorRefreshTables(db);
  const batchId = `indicator_update_${sha1(`${now}\u001f${keys.join('\u001f')}`, 24)}`;
  const selectVersion = db.prepare('SELECT payload FROM product_indicator_versions WHERE product_key = ?');
  const upsertVersion = db.prepare(`
    INSERT INTO product_indicator_versions (product_key, version, batch_id, updated_at, payload)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(product_key) DO UPDATE SET
      version = excluded.version,
      batch_id = excluded.batch_id,
      updated_at = excluded.updated_at,
      payload = excluded.payload
  `);
  for (const productKey of keys) {
    const current = parsePayload(selectVersion.get(productKey)?.payload, {});
    const version = (Number(current.version || 0) || 0) + 1;
    const payload = { productKey, version, batchId, updatedAt: now };
    upsertVersion.run(productKey, version, batchId, now, JSON.stringify(payload));
  }
  const batch = {
    id: batchId,
    productKeys: keys,
    changedProductKeyCount: keys.length,
    affectedPolicyCount,
    createdAt: now,
  };
  db.prepare(`
    INSERT INTO indicator_update_batches (id, created_at, product_keys, changed_product_key_count, affected_policy_count, payload)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      created_at = excluded.created_at,
      product_keys = excluded.product_keys,
      changed_product_key_count = excluded.changed_product_key_count,
      affected_policy_count = excluded.affected_policy_count,
      payload = excluded.payload
  `).run(
    batch.id,
    batch.createdAt,
    JSON.stringify(batch.productKeys),
    batch.changedProductKeyCount,
    batch.affectedPolicyCount,
    JSON.stringify(batch),
  );
  return batchId;
}

export function backfillKnowledgeResponsibilityIndicators({
  dbPath = DEFAULT_DB_PATH,
  write = false,
  sampleLimit = 20,
  minKnowledgeId = 0,
  companies = [],
  includeExistingProducts = false,
  knowledgeIds = [],
} = {}) {
  const db = new DatabaseSync(dbPath);
  try {
    const products = loadProductsWithoutIndicators(db, { minKnowledgeId, companies, includeExistingProducts, knowledgeIds });
    const now = new Date().toISOString();
    const indicators = products.flatMap((product) => buildIndicatorsForProduct(product, now));
    const changedProductKeys = uniqueStrings(indicators.flatMap((indicator) => deriveIndicatorProductKeys(indicator)));
    const affectedPolicyCount = affectedDerivedRows(db, changedProductKeys).length;
    let indicatorUpdateBatchId = '';
    if (write) {
      upsertIndicators(db, indicators);
      db.exec('BEGIN IMMEDIATE');
      try {
        const affectedPolicyIds = markAffectedDerivedRowsStale(db, changedProductKeys, now);
        indicatorUpdateBatchId = recordIndicatorRefreshBatch(db, {
          productKeys: changedProductKeys,
          affectedPolicyCount: affectedPolicyIds.length,
          now,
        });
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
    const productKeysWithIndicators = new Set(indicators.map((indicator) => `${indicator.company}\u001f${indicator.productName}`));
    const byCoverageType = {};
    for (const indicator of indicators) byCoverageType[indicator.coverageType] = (byCoverageType[indicator.coverageType] || 0) + 1;
    return {
      dbPath,
      dryRun: !write,
      candidateProducts: products.length,
      productsWithIndicators: productKeysWithIndicators.size,
      indicatorUpserts: indicators.length,
      changedProductKeys,
      changedProductKeyCount: changedProductKeys.length,
      affectedPolicyCount,
      indicatorUpdateBatchId,
      skippedProducts: products.length - productKeysWithIndicators.size,
      byCoverageType,
      samples: indicators.slice(0, sampleLimit).map((indicator) => ({
        id: indicator.id,
        company: indicator.company,
        productName: indicator.productName,
        coverageType: indicator.coverageType,
        liability: indicator.liability,
        formulaText: indicator.formulaText,
      })),
    };
  } finally {
    db.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const companies = readArg('companies', '')
    .split(',')
    .map((item) => trim(item))
    .filter(Boolean);
  const knowledgeIds = parseIdList(readArg('knowledge-ids', ''));
  const result = backfillKnowledgeResponsibilityIndicators({
    dbPath: path.resolve(readArg('db-path', DEFAULT_DB_PATH)),
    write: hasFlag('write'),
    sampleLimit: Number(readArg('sample-limit', 20)) || 20,
    minKnowledgeId: Number(readArg('min-knowledge-id', 0)) || 0,
    companies,
    includeExistingProducts: hasFlag('include-existing-products'),
    knowledgeIds,
  });
  console.log(JSON.stringify(result, null, 2));
}
