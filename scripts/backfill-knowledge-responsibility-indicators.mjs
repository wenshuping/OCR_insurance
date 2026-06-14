import crypto from 'node:crypto';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const DEFAULT_DB_PATH = path.join(projectRoot, '.runtime', 'local', 'policy-ocr.sqlite');
const VERSION = '2026-06-14-knowledge-responsibility-indicator-backfill';

function trim(value) {
  return String(value ?? '').trim();
}

function normalizeSpaces(value) {
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

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function sha1(value, length = 18) {
  return crypto.createHash('sha1').update(value).digest('hex').slice(0, length);
}

function limitText(value, max = 1200) {
  const text = normalizeSpaces(value);
  return text.length > max ? `${text.slice(0, max - 12)}...已截断` : text;
}

function normalizeLookupText(value) {
  return normalizeSpaces(value).replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();
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

function sourceText(payload = {}) {
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

function splitBenefitSections(text) {
  const source = normalizeSpaces(text);
  const pattern = /([\u4e00-\u9fa5A-Za-z0-9“”\-—（）()]{2,34}?(?:保险金|津贴|年金))(?:（[^）]{0,12}）)?(?=若|被保险人|本合同|自|在|=|＝|:|：)/gu;
  const matches = [];
  for (const match of source.matchAll(pattern)) {
    matches.push({
      rawLiability: match[1],
      liability: cleanLiability(match[1]),
      index: match.index || 0,
      contextStart: match.index || 0,
    });
  }
  const payoutNamePattern = /(?:给付|赔付)([\u4e00-\u9fa5A-Za-z0-9“”\-—（）()]{2,34}?(?:保险金|津贴|年金))/gu;
  for (const match of source.matchAll(payoutNamePattern)) {
    const index = (match.index || 0) + match[0].length - match[1].length;
    matches.push({
      rawLiability: match[1],
      liability: cleanLiability(match[1]),
      index,
      contextStart: Math.max(0, index - 700),
    });
  }
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
    const next = cleanMatches.slice(index + 1).find((item) => item.index > current.index + current.liability.length);
    const sectionText = source.slice(current.contextStart, next ? next.index : Math.min(source.length, current.index + 1400));
    sections.push({
      liability: current.liability,
      responsibilityScope: responsibilityScopeForSection(current.rawLiability, sectionText),
      text: sectionText,
    });
  }
  return sections.slice(0, 20);
}

function cleanLiability(value) {
  return trim(value)
    .replace(/^保险责任/u, '')
    .replace(/^页/u, '')
    .replace(/^(必选保险责任|基本保险责任|可选保险责任|必选责任|基本责任|可选责任)/u, '')
    .replace(/^[（(]?[一二三四五六七八九十\d]+[）)、.．\s]+/u, '')
    .replace(/^[一二三四五六七八九十\d]+(?=第|[“"‘])/u, '')
    .replace(/^\d+种(?=.+保险金)/u, '')
    .replace(/^[一二三四五六七八九十]+种(?=.+保险金)/u, '')
    .replace(/^(一项|一次|一处)(?=.*保险金)/u, '')
    .replace(/^(一项|一次)(?=意外|残疾|全残|中症|轻症|生存|养老|年金|重大|疾病)/u, '')
    .replace(/^限额(?=.+(?:保险金|津贴|年金))/u, '')
    .replace(/^不超过保险单载明的(?=.+(?:保险金|津贴|年金))/u, '')
    .replace(/^[\u4e00-\u9fa5A-Za-z0-9（）()]*给付限额(?=.+(?:保险金|津贴|年金))/u, '')
    .replace(/^给付(?=.+(?:保险金|津贴|年金))/u, '')
    .replace(/^[一二三四五六七八九十\d]+(?=基本|达到|航空|水陆|公共|交通|猝死|身故|身体|全残|意外|重大|中症|轻症|重症|重度|轻度|疾病|恶性|院内|护理|特定|首次|住院|门诊|医疗|养老|生存|满期|祝寿|汽车|轮船|轨道|驾乘)/u, '')
    .replace(/^第[（(]?[一二三四五六七八九十\d]+[）)]?项/u, '')
    .replace(/^(必选责任|基本责任|可选责任|一、|二、|三、|四、)/u, '')
    .replace(/["“”']/gu, '')
    .replace(/\s+/gu, '')
    .trim();
}

function liabilityLooksClean(value) {
  const text = trim(value);
  if (text.length < 3 || text.length > 34) return false;
  if (!/(?:保险金|津贴|年金)$/u.test(text)) return false;
  if (/^(保险金|基本保险金|医疗保险金|津贴保险金|年金)$/u.test(text)) return false;
  if (/^[（(]|^(按照|按不同|约定|般|准|年领方式|月领方式|金额|比例|限额|给付比例|赔付比例|下列|下的|中的|应给付|等同于|等值于|的|本附加|累计|以|相应|对应|后次|前次|本次|该项|在各项|规则|各对应|各该项|较严重项目|较严重|各项|每一项|同一项|次序|内给付|和给付次数)/u.test(text)) return false;
  if (/^达到(?!运动标准后额外给付)/u.test(text)) return false;
  if (/^(其中|上述|此次|了|条件|该保单|最重|申请书|另外一项|另一项|本条|个保单周年日|贺寿金的|当时|上期|本期|期内|期间内|期限内|年度内|保证给付期间内|保证领取期间内|范围|本主险合同|保险金的|保险金责任包括|或应给付|表中|表内|各次|各残疾项目|之和不超过|总额不超过|规则|下述|该次|该种|该类|任意一项|期间为|若按|对剩余部分|给付养老年金|免赔额和自付比例|合理且必要的医疗费用|合理且必须的医疗费用|乘以以下规定|且)/u.test(text)) return false;
  if (/^[-—]/u.test(text)) return false;
  if (/^后(?!续年金$)/u.test(text)) return false;
  if (/^过(?!敏性)/u.test(text)) return false;
  if (/^(一项|一次|一处)保险金$/u.test(text)) return false;
  if (/^比例最高|对应项|项目的/u.test(text)) return false;
  if (/^[一二三四五六七八九十\d]+倍同等金额的保险金/u.test(text)) return false;
  if (/保险金.*保险金.*保险金/u.test(text)) return false;
  if (/我们|本公司|被保险人|投保人|给付保险金|责任终止|本合同|附加险合同|约定给付/u.test(text)) return false;
  if (/申请书|条件之前|条件之日|伤残等级对应|保单周年日|周年日|金额最高|赔付金额最高|一项保险金|任意一项保险金|任何一项保险金|各对应项|各项保险金|本项责任|已符合|对应组别|本主险合同|同时给付生存保险金|赔付时需扣除|不再给付|保单账户价值及|每万元|如果未发生|给付各项|应给付|应领取|未领取|尚未给付|扣除已领取|给付比例给付|赔付比例给付|给付比例表中|相应|相类似的残疾项目|不超过您投保|所对应的|按年领取|按月领取|约定的给付比例|费用在扣除免赔额后|天数|乘以|范围\)/u.test(text)) return false;
  if (/按照|给付医疗保险金|保险有限责任公司|人寿保险|准给付|年领方式|月领方式|方式下|产品说明书|条款|发〔|保险合同|本附加合同|保险金的责任/u.test(text)) return false;
  return true;
}

function responsibilityScopeForSection(rawLiability, sectionText) {
  const marker = normalizeSpaces(`${rawLiability} ${sectionText.slice(0, 80)}`);
  return /可选(?:保险)?责任/u.test(marker) ? 'optional' : 'basic';
}

function coverageTypeFor(liability, text) {
  const direct = normalizeSpaces(liability);
  const haystack = normalizeSpaces(`${liability} ${text}`);
  if (/豁免/u.test(direct)) return '保费豁免';
  if (/损失|延误|旅行不便|接驳/u.test(direct)) return '财产损失保障';
  if (/护理/u.test(direct)) return '护理保障';
  if (/津贴|日额|每日/u.test(direct)) return '津贴保障';
  if (/意外/u.test(direct) && /身故|全残|高残|高度残疾/u.test(direct)) return '意外身故保障';
  if (/身故|全残|高残|高度残疾/u.test(direct)) return '身故保障';
  if (/手术保险金/u.test(direct) && !/意外/u.test(direct)) return '医疗保障';
  if (/门诊|住院|医疗|药品|药械|费用|报销|补偿|质子重离子/u.test(direct)) return '医疗保障';
  if (/伤残|残疾|骨折|烧伤|烧烫伤|韧带|整形手术|手术意外伤害/u.test(direct)) return '意外伤残保障';
  if (/猝死/u.test(direct)) return '意外身故保障';
  if (/恶性肿瘤|肿瘤|癌|白血病|重大疾病|重疾|中症|轻症|中度疾病|轻度疾病|特定疾病|疾病|并发症|罕见病|传染病|卵巢切除术|子宫全切术|全面保障/u.test(direct)) return '重大疾病保障';
  if (/年金|养老金|养老|养老保险金|祝寿|生存金|生存保险金|满期|教育金|高中教育|大学教育|婚嫁|立业|创业|关爱保险金|研学深造|特别保险金/u.test(direct)) return '现金流';
  if (/门诊|住院|医疗|药品|药械|费用|报销|补偿|质子重离子/u.test(haystack)) return '医疗保障';
  if (/伤残|残疾|骨折|烧伤|烧烫伤|韧带|整形手术|手术意外伤害/u.test(haystack)) return '意外伤残保障';
  if (/意外/u.test(haystack) && /身故|全残/u.test(haystack)) return '意外身故保障';
  if (/身故|全残/u.test(haystack)) return '身故保障';
  if (/手术保险金/u.test(haystack) && !/意外/u.test(haystack)) return '医疗保障';
  if (/恶性肿瘤|肿瘤|癌|白血病|重大疾病|重疾|中症|轻症|中度疾病|轻度疾病|特定疾病|疾病|卵巢切除术|子宫全切术/u.test(haystack)) return '重大疾病保障';
  if (/年金|养老金|祝寿|生存金|满期|教育金|高中教育|大学教育|婚嫁|立业|创业|特别保险金/u.test(haystack)) return '现金流';
  return '责任项';
}

function formulaFor(liability, sectionText) {
  const text = normalizeSpaces(sectionText);
  const allowance = text.match(/(?:日住院津贴额|每日津贴金额|每日给付金额|日津贴额)[^。；，,]{0,12}?(\d+(?:\.\d+)?)\s*元/u)
    || text.match(/(\d+(?:\.\d+)?)\s*元\s*\/\s*日/u);
  if (/津贴|补贴|日额/u.test(liability)) {
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
      /(?:给付天数|住院天数|实际住院天数|实际住院日数|实际住院日|实际日数|入住[^。；，,]{0,12}实际天数|重症监护住院天数)[^。；，,]{0,80}(?:日住院津贴额|日住院津贴金额|每日津贴金额|日津贴额|日津贴金额|津贴保险金日额|日重症监护住院津贴金额|意外住院日津贴金额)/u.test(text)
      || /(?:日住院津贴额|日住院津贴金额|每日津贴金额|日津贴额|日津贴金额|津贴保险金日额|日重症监护住院津贴金额|意外住院日津贴金额)[^。；，,]{0,80}(?:给付天数|住院天数|实际住院天数|实际住院日数|实际住院日|实际日数)/u.test(text)
    ) {
      return {
        value: null,
        valueText: '',
        unit: '公式',
        basis: '给付天数、日津贴额',
        formulaText: `${liability} = 给付天数 × 日津贴额`,
      };
    }
    return null;
  }
  if (/门诊|住院|医疗|药品|药械|费用|报销|补偿|质子重离子/u.test(liability)
    && /医疗费用|实际发生|合理且必要|合理且必须|给付比例|赔付比例|免赔额|补偿/u.test(text)) {
    if (/交通费用|公共交通费用|异地转诊/u.test(liability)) return null;
    const liabilityIndex = text.indexOf(liability);
    const formulaWindow = liabilityIndex >= 0 ? text.slice(liabilityIndex, liabilityIndex + 500) : text.slice(0, 500);
    const medicalPercent = explicitPercentFromText(formulaWindow);
    if (!medicalPercent) return null;
    return {
      value: Number(medicalPercent),
      valueText: medicalPercent,
      unit: '%',
      basis: '实际合理医疗费用',
      formulaText: `${liability} = (实际合理医疗费用 - 已获补偿 - 免赔额/起付金额) × ${medicalPercent}%`,
    };
  }
  if (/较高者|最大者|较大者|三项金额|两项金额|两者/u.test(text)) {
    const basis = [];
    if (/基本保险金额|基本保额/u.test(text)) basis.push('基本保险金额');
    if (/有效保险金额/u.test(text)) basis.push('有效保险金额');
    if (/现金价值/u.test(text)) basis.push('现金价值');
    if (/已交|已交纳|累计已交|保险费/u.test(text)) basis.push('已交保险费');
    if (/保单账户价值/u.test(text)) basis.push('保单账户价值');
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
  if (
    /伤残|残疾|骨折|烧伤|烧烫伤|脱位/u.test(liability)
    && !/高残|高度残疾/u.test(liability)
    && /给付比例|比例表|伤残等级|残疾等级|残疾程度|评定标准/u.test(text)
    && /基本保险金额|基本保额|保险金额|意外伤害基本保险金额|意外身故基本保险金额/u.test(text)
  ) {
    const amountBasis = /意外身故基本保险金额/u.test(text) ? '意外身故基本保险金额'
      : /意外伤害基本保险金额/u.test(text) ? '意外伤害基本保险金额'
        : /基本保险金额|基本保额/u.test(text) ? '基本保险金额'
          : '保险金额';
    const multiple = text.match(/(?:基本保险金额|基本保额|保险金额)[^。；，,]{0,8}?(\d+(?:\.\d+)?)\s*倍/u);
    const basis = multiple?.[1] ? `${amountBasis} × ${multiple[1]}` : amountBasis;
    return {
      value: null,
      valueText: '',
      unit: '公式',
      basis: `${basis}、伤残/残疾等级给付比例`,
      formulaText: `${liability} = ${basis} × 伤残/残疾等级给付比例`,
    };
  }
  const percent = text.match(/(?:基本保险金额|基本保额|保险金额|意外伤害基本保险金额|有效保险金额)[^。；，,]{0,24}?(\d+(?:\.\d+)?)\s*[％%]/u)
    || text.match(/(\d+(?:\.\d+)?)\s*[％%][^。；，,]{0,24}?(?:基本保险金额|基本保额|保险金额|有效保险金额)/u);
  if (percent?.[1] && !/医疗|门诊|住院|费用|津贴|补贴/u.test(liability)) {
    const percentValue = Number(percent[1]);
    if (!Number.isFinite(percentValue) || percentValue <= 0) return null;
    return {
      value: percentValue,
      valueText: percent[1],
      unit: '%',
      basis: /有效保险金额/u.test(text) ? '有效保险金额' : '基本保险金额',
      formulaText: `${liability} = ${/有效保险金额/u.test(text) ? '有效保险金额' : '基本保险金额'} × ${percent[1]}%`,
    };
  }
  if (/年金|养老金|养老保险金|祝寿|生存金|生存保险金|满期|教育金|高中教育|大学教育|婚嫁|立业|创业|特别保险金/u.test(liability)
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
  if (/保单账户价值/u.test(text) && /给付/u.test(text)) {
    return {
      value: null,
      valueText: '',
      unit: '公式',
      basis: '保单账户价值',
      formulaText: `${liability} = 保单账户价值`,
    };
  }
  if (/有效保险金额/u.test(text) && /给付/u.test(text)) {
    return {
      value: 100,
      valueText: '100',
      unit: '%',
      basis: '有效保险金额',
      formulaText: `${liability} = 有效保险金额 × 100%`,
    };
  }
  if (/保险金额/u.test(text) && /给付/u.test(text) && !/医疗|门诊|住院|费用|津贴|补贴/u.test(liability)) {
    return {
      value: 100,
      valueText: '100',
      unit: '%',
      basis: '保险金额',
      formulaText: `${liability} = 保险金额 × 100%`,
    };
  }
  if (/基本保险金额|基本保额|意外伤害基本保险金额/u.test(text) && /给付/u.test(text) && !/医疗|门诊|住院|费用|津贴|补贴/u.test(liability)) {
    return {
      value: 100,
      valueText: '100',
      unit: '%',
      basis: /意外伤害基本保险金额/u.test(text) ? '意外伤害基本保险金额' : '基本保险金额',
      formulaText: `${liability} = ${/意外伤害基本保险金额/u.test(text) ? '意外伤害基本保险金额' : '基本保险金额'} × 100%`,
    };
  }
  return null;
}

function conditionFromText(text) {
  const normalized = normalizeSpaces(text);
  const match = normalized.match(/(?:若|如果|自)([^。；]{6,120}?)(?:，|,|我们|本公司|按|给付)/u);
  return trim(match?.[1] || '');
}

function loadProductsWithoutIndicators(db, { minKnowledgeId = 0, companies = [], includeExistingProducts = false } = {}) {
  const rows = db.prepare(`
    SELECT id, company, product_name, url, payload
      FROM knowledge_records
     WHERE product_name IS NOT NULL AND product_name <> '' AND id >= ?
     ORDER BY company, product_name, id DESC
  `).all(minKnowledgeId);
  const indicatorKeys = new Set(db.prepare(`
    SELECT DISTINCT COALESCE(company, '') AS company, COALESCE(product_name, '') AS product_name
      FROM insurance_indicator_records
     WHERE product_name IS NOT NULL AND product_name <> ''
  `).all().map((row) => `${row.company}\u001f${row.product_name}`));
  const products = new Map();
  for (const row of rows) {
    const key = `${trim(row.company)}\u001f${trim(row.product_name)}`;
    if (!includeExistingProducts && indicatorKeys.has(key)) continue;
    const payload = parsePayload(row.payload);
    const company = trim(row.company || payload.company);
    if (companies.length && !companies.includes(company)) continue;
    const text = sourceText(payload);
    if (!responsibilityTextLooksUsable(text)) continue;
    if (!products.has(key)) {
      products.set(key, {
        company,
        productName: trim(row.product_name || payload.productName),
        productType: trim(payload.productType),
        salesStatus: trim(payload.salesStatus),
        sourceRecordIds: [],
        sourceUrls: [],
        sourceTitles: [],
        textParts: [],
      });
    }
    const product = products.get(key);
    product.productType ||= trim(payload.productType);
    product.salesStatus ||= trim(payload.salesStatus);
    product.sourceRecordIds.push(String(payload.id || row.id));
    if (trim(payload.url || row.url)) product.sourceUrls.push(trim(payload.url || row.url));
    if (trim(payload.title)) product.sourceTitles.push(trim(payload.title));
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

function buildIndicatorsForProduct(product, now) {
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
      )
    ));
    if (!duplicate) deduped.push(indicator);
  }
  return deduped.sort((a, b) => indicators.findIndex((item) => item.id === a.id) - indicators.findIndex((item) => item.id === b.id));
}

function upsertIndicators(db, indicators) {
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
      insert.run(indicator.id, indicator.company, indicator.productName, indicator.coverageType, indicator.liability, JSON.stringify(indicator));
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

export function backfillKnowledgeResponsibilityIndicators({
  dbPath = DEFAULT_DB_PATH,
  write = false,
  sampleLimit = 20,
  minKnowledgeId = 0,
  companies = [],
  includeExistingProducts = false,
} = {}) {
  const db = new DatabaseSync(dbPath);
  try {
    const products = loadProductsWithoutIndicators(db, { minKnowledgeId, companies, includeExistingProducts });
    const now = new Date().toISOString();
    const indicators = products.flatMap((product) => buildIndicatorsForProduct(product, now));
    if (write) upsertIndicators(db, indicators);
    const productKeysWithIndicators = new Set(indicators.map((indicator) => `${indicator.company}\u001f${indicator.productName}`));
    const byCoverageType = {};
    for (const indicator of indicators) byCoverageType[indicator.coverageType] = (byCoverageType[indicator.coverageType] || 0) + 1;
    return {
      dbPath,
      dryRun: !write,
      candidateProducts: products.length,
      productsWithIndicators: productKeysWithIndicators.size,
      indicatorUpserts: indicators.length,
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
  const result = backfillKnowledgeResponsibilityIndicators({
    dbPath: path.resolve(readArg('db-path', DEFAULT_DB_PATH)),
    write: hasFlag('write'),
    sampleLimit: Number(readArg('sample-limit', 20)) || 20,
    minKnowledgeId: Number(readArg('min-knowledge-id', 0)) || 0,
    companies,
    includeExistingProducts: hasFlag('include-existing-products'),
  });
  console.log(JSON.stringify(result, null, 2));
}
