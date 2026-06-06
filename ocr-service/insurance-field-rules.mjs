import { POLICY_FIELD_SCHEMA } from './insurance-field-schema.mjs';
import {
  findBestFuzzyMatch,
  matchesFuzzyPhrase,
  stripFuzzyPrefix,
} from './fuzzy-matching.mjs';

const BENEFIT_TABLE_HEADER_LABELS = [
  '基本',
  '基本保险金额',
  '保险金额',
  '保险期间',
  '交费方式',
  '缴费方式',
  '保险费约定支付日',
  '保险费',
  '保障计划份数',
  '交费期间',
  '缴费期间',
  '保险费交费日期',
  '交费期满日',
  '首期',
];

function fuzzyLabelThreshold(label) {
  return Array.from(compactText(label)).length <= 4 ? 0.68 : 0.72;
}

export function escapeRegExp(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function cleanupFieldText(value) {
  return String(value || '')
    .replace(/[：﹕]/g, ':')
    .replace(/[|｜]/g, ' ')
    .replace(/^[：:\-=\s]+/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function compactText(value) {
  return cleanupFieldText(value).replace(/\s+/g, '');
}

export function buildLooseLabelPattern(label) {
  return Array.from(String(label || ''))
    .map((char) => `${escapeRegExp(char)}\\s*`)
    .join('');
}

export function lineHasFieldLabel(line, field) {
  const aliases = POLICY_FIELD_SCHEMA[field]?.aliases || [];
  const text = compactText(line);
  if (aliases.some((alias) => new RegExp(buildLooseLabelPattern(alias), 'i').test(text))) return true;
  return aliases.some((alias) => findBestFuzzyMatch(text, [alias], { minScore: fuzzyLabelThreshold(alias) }));
}

export function stripFieldLabels(value, fieldKeys = Object.keys(POLICY_FIELD_SCHEMA)) {
  let text = compactText(value);
  for (const field of fieldKeys) {
    for (const alias of POLICY_FIELD_SCHEMA[field]?.aliases || []) {
      text = text.replace(new RegExp(`^${buildLooseLabelPattern(alias)}[:：]?`, 'i'), '');
    }
  }
  const aliases = fieldKeys.flatMap((field) => POLICY_FIELD_SCHEMA[field]?.aliases || []);
  text = stripFuzzyPrefix(text, aliases, { minScore: 0.68 });
  return text;
}

export function looksLikeCompanyLogoLine(line, company = '') {
  const text = compactText(line);
  const compactCompany = compactText(company);
  if (!text || !compactCompany || !text.includes(compactCompany)) return false;
  const remainder = text.replace(compactCompany, '');
  if (!remainder) return true;
  if (Array.from(remainder).length > 12) return false;
  return /^(?:[a-z0-9]+|心|囗|口|图|标)+$/iu.test(remainder);
}

export function isBenefitTableHeaderLine(line) {
  const text = compactText(line);
  if (
    /^(?:基本|保险金额\/?|基本保险金额\/?|保险期间|交费方式|缴费方式|保险费约定支付日|保险费|\/?保障计划\/份数|\/?交费期间(?:（续期)?|\/?缴费期间(?:（续期)?|保险费交费日期）?|\/?交费期满日|首期)$/u.test(
      text,
    )
  ) {
    return true;
  }
  return BENEFIT_TABLE_HEADER_LABELS.some((label) => matchesFuzzyPhrase(text, label, { minScore: fuzzyLabelThreshold(label) }));
}

export function isStructuralNoiseLine(line) {
  const text = compactText(line);
  if (!text) return true;
  return /^(保险单|基本内容|保险利益表|特别约定[:：]?|本栏空白|保险单说明[:：]?|保单制作日期[:：]?.*|保险公司签章|保险合同专用章|业务员[:：].*|业务员编号[:：]?.*|保单签发地[:：].*|服务电话[:：]?.*|第\d+页共\d+页|\*此码仅.*|币值单位[:：]?.*|保险合同号[:：]?.*|证件号码|受益顺序|受益份额|身故保险金受益人)$/.test(
    text,
  );
}

export function isProductDescriptorLine(line) {
  const text = compactText(line);
  if (!text) return false;
  return /^(?:终身|定期|两全|养老年金|年金|医疗|长期医疗|短期医疗|意外|意外伤害|疾病|重大疾病|重疾|护理|失能|豁免|增额终身)?(?:寿险|保险|年金保险|两全保险|医疗保险|意外伤害保险|疾病保险|重大疾病保险|重疾保险|护理保险)(?:（[^）]+）|\([^)]*\))?$/.test(
    text,
  );
}

export function isProductNameNoiseLine(line, company = '') {
  const text = compactText(line);
  if (!text) return true;
  if (looksLikeCompanyLogoLine(text, company)) return true;
  if (isBenefitTableHeaderLine(text) || isStructuralNoiseLine(text)) return true;
  if (/^(?:主险明细|附加险明细|险种性质|子险种名称|加费(?:（元）|\(元\))?|标准保费(?:（元）|\(元\))?|保单(?:号|生效日|期满日)|交费期满日|每期交费日|出生日期|证件名称|与被保险人关系受益份额)/u.test(text)) {
    return true;
  }
  if (/^(投保人|被保险人|客户号码|保险期限|缴费年期|缴费方式|保险金额|保险费)/.test(text)) return true;
  if (/客户号码|第一顺位|第二顺位|受益人|联系电话|邮政编码|保险合同号|合同号/.test(text)) return true;
  if (/^(每年\d{1,2}月\d{1,2}日|至20\d{2}年\d{1,2}月\d{1,2}日(?:零时)?|[¥￥]?\d+(?:\.\d+)?元?|\/\d+年|\/20\d{2}年)/.test(text)) {
    return true;
  }
  if (!/[一-龥A-Za-z]/.test(text)) return true;
  return false;
}

export function isNonMoneyIdentifierLine(line) {
  const text = compactText(line);
  if (!text) return true;
  if (isStructuralNoiseLine(text)) return true;
  if (/(?:业务员|服务电话|客服电话|客服热线|联系电话|电话|手机号|手机号码|保险合同号|合同号|保单号|证件号码|证件号|身份证|客户号码|客户号|邮政编码|业务员编号|员工号|编号|编码)/u.test(text)) {
    return true;
  }
  if (/第\d+页共\d+页/u.test(text)) return true;
  return false;
}

export function normalizeAmountText(value) {
  const raw = compactText(value);
  if (isNonMoneyIdentifierLine(raw)) return '';
  if (/年\d{1,2}月\d{1,2}日|20\d{2}年\d{1,2}月\d{1,2}日/.test(raw)) return '';
  const text = raw
    .replace(/^每年/, '')
    .replace(/[,，]/g, '')
    .replace(/[¥￥元圆]/g, '');
  const matched = text.match(/(\d+(?:\.\d+)?)(万|亿)?/);
  if (!matched) return '';
  const base = Number(matched[1]);
  if (!Number.isFinite(base)) return '';
  const unit = matched[2] || '';
  const multiplier = unit === '亿' ? 100000000 : unit === '万' ? 10000 : 1;
  return String(Math.round(base * multiplier));
}

export function isPremiumAmountLine(line) {
  const text = compactText(line);
  if (!normalizeAmountText(text)) return false;
  if (isNonMoneyIdentifierLine(text)) return false;
  if (/^(?:每年|首期|首年)?\d+(?:\.\d{1,2})?元$/u.test(text)) return true;
  if (/^(?:每年|首期|首年)?[¥￥]\d+(?:\.\d{1,2})?$/u.test(text)) return true;
  if (/^(?:每年|首期|首年)?\d{1,7}\.\d{1,2}$/u.test(text)) return true;
  if (/(?:保险费|保费|总保费|首期|首年|合计).*?[¥￥]?\d/u.test(text)) return true;
  return false;
}

export function normalizePaymentModeText(value) {
  const text = compactText(value).replace(/^(?:交费方式|缴费方式)[:：]?/u, '');
  if (/^(年交|年缴)$/.test(text)) return '年交';
  if (/^(月交|月缴)$/.test(text)) return '月交';
  if (/^(季交|季缴)$/.test(text)) return '季交';
  if (/^(半年交|半年缴)$/.test(text)) return '半年交';
  if (/^(趸交|一次交清|一次性交清|一次性交费|一次性缴清)$/.test(text)) return '趸交';
  return '';
}

export function normalizePaymentPeriodText(value) {
  const text = compactText(value)
    .replace(/^(?:交费期间|缴费期间|交费年期|缴费年期|交费年限|缴费年限)[:：]?/u, '')
    .replace(/^\/+/, '');
  const matched = text.match(/^(\d{1,2})年$/);
  if (matched?.[1]) return `${matched[1]}年`;
  if (/^至20\d{2}年\d{1,2}月\d{1,2}日/.test(text)) return text;
  return '';
}

export function normalizeCoveragePeriodText(value) {
  const text = compactText(value).replace(/^\/+/, '');
  if (text === '终身') return '终身';
  const ageMatched = text.match(/(?:保至|保障至|至)?(\d{2,3})周?岁/);
  if (ageMatched?.[1]) return `至${ageMatched[1]}岁`;
  if (/^至20\d{2}年\d{1,2}月\d{1,2}日/.test(text)) return text;
  if (/^\d{1,2}年$/.test(text)) return text;
  return '';
}

export function normalizeProductNameText(value) {
  const text = stripFieldLabels(value, ['name']);
  if (!text || text.length <= 2) return '';
  if (isProductNameNoiseLine(text)) return '';
  return text;
}
