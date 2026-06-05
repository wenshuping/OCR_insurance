import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { hasConfiguredOcrServiceBaseUrl, scanInsurancePolicyOverHttp } from './client.mjs';
import { parseCashValueTable, parseCashValueText } from './cash-value-parser.mjs';
import { findBestFuzzyMatch, matchesFuzzyPhrase } from './fuzzy-matching.mjs';
import { extractPolicyPlansFromLines, matchPolicyFieldsFromLines } from './insurance-field-matcher.mjs';
import {
  OCR_PROVIDER_BAIDU_PRIVATE,
  OCR_PROVIDER_LOCAL,
  OCR_PROVIDER_MLX_QWEN25_VL_LOCAL,
  OCR_PROVIDER_OLLAMA_VISION_LOCAL,
  OCR_PROVIDER_PADDLE_LOCAL,
  OCR_PROVIDER_PADDLEOCR_VL_LOCAL,
  OCR_PROVIDER_PDF_EXTRACT_KIT_LOCAL,
  resolveEffectivePolicyOcrProvider,
} from './ocr-config.service.mjs';
import { parsePolicyBasicInfoFromLayoutBoxes } from './policy-basic-info-layout-parser.mjs';
import { mergePolicyLayoutScanResult } from './policy-layout-merge.mjs';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OCR_SCRIPTS_DIR = path.resolve(__dirname, 'scripts');
const OCR_SWIFT_SCRIPT = path.join(OCR_SCRIPTS_DIR, 'policy_ocr_vision.swift');
const OCR_PADDLE_SCRIPT = path.join(OCR_SCRIPTS_DIR, 'policy_ocr_paddle.py');
const OCR_PDF_EXTRACT_KIT_SCRIPT = path.join(OCR_SCRIPTS_DIR, 'policy_ocr_pdf_extract_kit.py');
const LOCAL_PADDLE_VENV_PYTHON = path.resolve(__dirname, '../.runtime/paddleocr-venv/bin/python');
const DEFAULT_MAX_SCAN_BYTES = 12 * 1024 * 1024;
const DEFAULT_MLX_MAX_IMAGE_DIMENSION = 1800;
const OCR_POSTPROCESSOR_NONE = 'none';
const OCR_POSTPROCESSOR_OLLAMA_QWEN = 'ollama_qwen_local';
let paddleWarmupPromise = null;

export function resolveLocalOcrScriptPaths() {
  return {
    visionScriptPath: OCR_SWIFT_SCRIPT,
    paddleScriptPath: OCR_PADDLE_SCRIPT,
    pdfExtractKitScriptPath: OCR_PDF_EXTRACT_KIT_SCRIPT,
  };
}

function assertOcrScriptExists(scriptPath) {
  if (!existsSync(scriptPath)) {
    throw new Error('POLICY_OCR_PROVIDER_NOT_READY');
  }
}

const COMPANY_ALIASES = [
  { value: '新华保险', patterns: [/NCI\s*新华保险/i, /新华(?:人寿)?保险(?:股份有限公司|有限责任公司)?/] },
  {
    value: '中国平安保险',
    patterns: [
      /中国平安(?:人寿|健康|养老)?(?:保险)?(?:股份有限公司|有限责任公司)?/,
      /平安人寿(?:保险)?(?:股份有限公司)?/,
      /平安保险/,
      /PING\s*AN(?:\s+INSURANCE\s+COMPANY\s+OF\s+CHINA(?:,?\s*LTD\.?)?)?/i,
    ],
  },
  { value: '中国人寿保险', patterns: [/中国人寿(?:保险)?(?:股份有限公司)?/, /国寿(?:保险)?/] },
  { value: '中国太平洋保险', patterns: [/中国太平洋(?:人寿|健康)?保险(?:股份有限公司|有限责任公司)?/, /太平洋保险/, /太保寿险/, /中国太保/] },
  { value: '太平人寿', patterns: [/中国太平人寿保险(?:股份有限公司|有限责任公司)?/, /太平人寿/] },
  { value: '中国太平', patterns: [/中国太平保险集团(?:有限责任公司)?/, /中国太平(?!人寿)/, /太平保险集团/] },
  { value: '泰康保险', patterns: [/泰康人寿保险(?:有限责任公司|股份有限公司)?/, /泰康(?:人寿|养老|在线)?保险/, /泰康保险/] },
  { value: '友邦保险', patterns: [/友邦人寿保险(?:有限公司|股份有限公司)?/, /友邦保险/] },
  { value: '阳光保险', patterns: [/阳光人寿保险(?:股份有限公司|有限责任公司)?/, /阳光保险/] },
  { value: '人保寿险', patterns: [/中国人民人寿保险股份有限公司/, /人保寿险/, /中国人保寿险/] },
  { value: '人保健康', patterns: [/中国人民健康保险股份有限公司/, /人保健康/] },
  { value: '中邮保险', patterns: [/中邮人寿保险股份有限公司/, /中邮保险/, /中邮人寿/] },
  { value: '招商信诺', patterns: [/招商信诺人寿保险(?:有限公司|股份有限公司)?/, /招商信诺/] },
  { value: '中信保诚', patterns: [/中信保诚人寿保险(?:有限公司|股份有限公司)?/, /信诚人寿/, /中信保诚/] },
  { value: '工银安盛', patterns: [/工银安盛人寿保险(?:有限公司|股份有限公司)?/, /工银安盛/] },
  { value: '建信人寿', patterns: [/建信人寿保险(?:有限公司|股份有限公司)?/, /建信人寿/] },
  { value: '农银人寿', patterns: [/农银人寿保险(?:股份有限公司|有限公司)?/, /农银人寿/] },
  { value: '大家保险', patterns: [/大家人寿保险(?:股份有限公司|有限责任公司)?/, /大家保险/, /大家人寿/] },
  { value: '华夏保险', patterns: [/华夏人寿保险(?:股份有限公司|有限责任公司)?/, /华夏保险/] },
  { value: '富德生命人寿', patterns: [/富德生命人寿保险(?:股份有限公司|有限责任公司)?/, /富德生命人寿/, /生命人寿/] },
  { value: '国华人寿', patterns: [/国华人寿保险(?:股份有限公司|有限责任公司)?/, /国华人寿/] },
  { value: '百年人寿', patterns: [/百年人寿保险(?:股份有限公司|有限责任公司)?/, /百年人寿/] },
  { value: '信泰保险', patterns: [/信泰人寿保险(?:股份有限公司|有限责任公司)?/, /信泰保险/, /信泰人寿/] },
  { value: '中英人寿', patterns: [/中英人寿保险(?:有限公司|股份有限公司)?/, /中英人寿/] },
  { value: '陆家嘴国泰人寿', patterns: [/陆家嘴国泰人寿保险(?:有限责任公司|股份有限公司)?/, /国泰人寿/, /陆家嘴国泰人寿/] },
];

const LABELS = {
  company: ['投保公司', '保险公司', '承保公司', '公司名称', '承保机构', '保险机构', '承保单位', '保险公司全称'],
  name: ['产品名称', '险种名称', '保险名称', '合同名称', '产品计划', '主险名称', '保险产品名称', '险种计划', '险种/名称', '保险险种'],
  applicant: ['投保人名称', '投保人', '投保人姓名', '要保人', '要保人姓名'],
  insured: ['被保险人', '被保险人姓名', '受保人', '受保人姓名', '被保人'],
  beneficiary: ['身故保险金受益人', '身故受益人', '受益人'],
  date: ['投保日期', '合同成立日期', '合同成立日', '承保日期', '合同生效日期', '合同生效日', '生效日期', '生效时间', '保险起期', '起保日期', '起保日', '保险合同成立及生效日'],
  paymentPeriod: ['交费方式', '交费期间', '缴费期间', '交费年期', '缴费年期', '交费年限', '缴费年限', '交费期限', '缴费期限'],
  coveragePeriod: ['保险期间', '保障期间', '保险期限', '保障期限', '保险责任期间', '合同期限'],
  amount: ['基本保险金额', '保额', '保险金额', '基本保额'],
  firstPremium: [
    '首期保险费',
    '首期保费',
    '首年保费',
    '标准保险费',
    '保险费',
    '首期应交保险费',
    '首期应交保费',
    '首次保费',
    '首次保险费',
    '首年应交保费',
    '首年应交保险费',
    '总保费',
    '总保费(人民币)',
    '总保险费',
  ],
};

const AUXILIARY_SPLIT_LABELS = ['客户号码', '保险险种', '保险期限', '缴费年期', '缴费方式', '保险金额(元)', '保险费(元)'];

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

const ALL_LABELS = [...Object.values(LABELS).flat(), ...AUXILIARY_SPLIT_LABELS]
  .flat()
  .sort((a, b) => b.length - a.length);

function escapeRegExp(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildLooseLabelPattern(text) {
  return Array.from(String(text || ''))
    .map((char) => `${escapeRegExp(char)}\\s*`)
    .join('');
}

function normalizeOcrText(raw) {
  return String(raw || '')
    .replace(/\r/g, '\n')
    .replace(/[：﹕]/g, ':')
    .replace(/\u3000/g, ' ')
    .replace(/([一-龥A-Za-z])[ \t]+(?=[一-龥A-Za-z])/g, '$1')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function splitRecognizedLines(raw) {
  const text = normalizeOcrText(raw);
  if (!text) return [];
  const unionPattern = ALL_LABELS.map(buildLooseLabelPattern).join('|');
  const withExplicitBreaks = text.replace(new RegExp(`(?<!^)(?=(${unionPattern}))`, 'g'), '\n');
  return withExplicitBreaks
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function cleanupFieldValue(text) {
  return String(text || '')
    .replace(/^[：:\-=\s]+/, '')
    .replace(/[|｜]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function compactLine(text) {
  return cleanupFieldValue(text).replace(/\s+/g, '');
}

function normalizeIdNumber(value) {
  const text = String(value || '')
    .normalize('NFKC')
    .replace(/[^\dXx]/g, '')
    .toUpperCase();
  const matched18 = text.match(/\d{17}[\dX]/);
  if (matched18) return matched18[0];
  const matched15 = text.match(/\d{15}/);
  return matched15?.[0] || '';
}

function isValidDateParts(year, month, day) {
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return (
    date.getUTCFullYear() === Number(year) &&
    date.getUTCMonth() + 1 === Number(month) &&
    date.getUTCDate() === Number(day)
  );
}

function birthdayFromIdNumber(value) {
  const idNumber = normalizeIdNumber(value);
  if (idNumber.length === 18) {
    const year = idNumber.slice(6, 10);
    const month = idNumber.slice(10, 12);
    const day = idNumber.slice(12, 14);
    return isValidDateParts(year, month, day) ? `${year}-${month}-${day}` : '';
  }
  if (idNumber.length === 15) {
    const shortYear = Number(idNumber.slice(6, 8));
    const year = String(shortYear >= 30 ? 1900 + shortYear : 2000 + shortYear);
    const month = idNumber.slice(8, 10);
    const day = idNumber.slice(10, 12);
    return isValidDateParts(year, month, day) ? `${year}-${month}-${day}` : '';
  }
  return '';
}

function extractInsuredIdentity(lines, insuredName = '') {
  const normalizedInsured = compactLine(insuredName);
  const labelPattern = /^(?:证件号码|证件号|身份证号码|身份证号|居民身份证号码|居民身份证号)[:：]?/u;
  const candidates = [];
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index] || '';
    const line = compactLine(rawLine);
    const idNumber = normalizeIdNumber(line);
    if (!idNumber) continue;
    let score = 0;
    if (labelPattern.test(line)) score += 5;
    const previousWindow = lines.slice(Math.max(0, index - 3), index).map(compactLine).join(' ');
    const nextWindow = lines.slice(index + 1, index + 4).map(compactLine).join(' ');
    if (/被保险人|被保人|受保人/u.test(previousWindow) || /被保险人|被保人|受保人/u.test(line)) score += 6;
    if (/投保人|要保人/u.test(previousWindow) || /投保人|要保人/u.test(line)) score -= 3;
    if (normalizedInsured && (previousWindow.includes(normalizedInsured) || line.includes(normalizedInsured) || nextWindow.includes(normalizedInsured))) {
      score += 4;
    }
    candidates.push({ idNumber, score, index });
  }
  candidates.sort((left, right) => right.score - left.score || right.index - left.index);
  const insuredIdNumber = candidates[0]?.idNumber || '';
  return {
    insuredIdNumber,
    insuredBirthday: birthdayFromIdNumber(insuredIdNumber),
  };
}

function fuzzyLabelThreshold(label) {
  return Array.from(compactLine(label)).length <= 4 ? 0.68 : 0.72;
}

function findFuzzyLabelMatch(line, labels) {
  const text = compactLine(line);
  if (!text) return null;
  let best = null;
  for (const label of labels || []) {
    const match = findBestFuzzyMatch(text, [label], { minScore: fuzzyLabelThreshold(label) });
    if (match && (!best || match.score > best.score)) best = match;
  }
  return best;
}

function extractByLabels(lines, labels, stopLabels = []) {
  const orderedLabels = [...labels].sort((a, b) => b.length - a.length);
  const escapedStops = stopLabels.map(buildLooseLabelPattern).join('|');
  for (const label of orderedLabels) {
    const escapedLabel = buildLooseLabelPattern(label);
    const patterns = [
      new RegExp(
        `^${escapedLabel}\\s*[:：]?\\s*(.+?)${escapedStops ? `(?=\\s*(?:${escapedStops})\\s*[:：]?\\s*|$)` : '$'}`,
        'i'
      ),
      new RegExp(
        `(?:^|[\\s|｜])${escapedLabel}\\s*[:：]?\\s*(.+?)${escapedStops ? `(?=\\s*(?:${escapedStops})\\s*[:：]?\\s*|$)` : '$'}`,
        'i'
      ),
    ];
    for (const line of lines) {
      for (const pattern of patterns) {
        const matched = line.match(pattern);
        if (matched?.[1]) {
          const cleaned = cleanupFieldValue(matched[1]);
          if (cleaned) return cleaned;
        }
      }
    }
  }
  return '';
}

function formatDateValue(value) {
  const matched = String(value || '').match(/(20\d{2})[年./-](\d{1,2})[月./-](\d{1,2})/);
  if (!matched) return '';
  const year = matched[1];
  const month = matched[2].padStart(2, '0');
  const day = matched[3].padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function extractPreferredDate(lines) {
  const dateGroups = [
    ['合同生效日期', '合同生效日', '生效日期', '生效时间', '保险起期', '起保日期', '起保日', '保险合同成立及生效日'],
    ['投保日期', '合同成立日期', '合同成立日'],
    ['承保日期'],
  ];

  for (const group of dateGroups) {
    const rawValue = extractByLabels(lines, group);
    const formatted = formatDateValue(rawValue);
    if (formatted) return formatted;
  }
  return '';
}

function matchCompanyAlias(value) {
  const text = compactLine(value);
  if (!text) return '';
  const matched = COMPANY_ALIASES.find((item) => item.patterns.some((pattern) => pattern.test(text)));
  return matched?.value || '';
}

function parseAmountValue(value) {
  const text = String(value || '')
    .replace(/[,，\s]/g, '')
    .replace(/[¥￥元圆]/g, '')
    .trim();
  if (!text) return '';
  const matched = text.match(/(\d+(?:\.\d+)?)(万|亿)?/);
  if (!matched) return '';
  const base = Number(matched[1]);
  if (!Number.isFinite(base)) return '';
  const unit = matched[2] || '';
  const multiplier = unit === '亿' ? 100000000 : unit === '万' ? 10000 : 1;
  return String(Math.round(base * multiplier));
}

function findCompanyAlias(text) {
  return matchCompanyAlias(normalizeOcrText(text));
}

function isNonCompanyPlaceholder(value) {
  return /^(保险单|保险合同|合同|保险利益表|基本内容|保险单说明|特别约定|投保单|批单)$/.test(compactLine(value));
}

function normalizeCompanyName(value) {
  const text = cleanupFieldValue(value);
  if (isNonCompanyPlaceholder(text)) return '';
  return matchCompanyAlias(text) || text;
}

function looksLikeCompanyName(value) {
  const text = compactLine(value);
  if (!text) return false;
  const alias = matchCompanyAlias(text);
  if (!alias) return /(?:股份有限公司|有限责任公司|保险集团)/.test(text);
  const compactAlias = compactLine(alias);
  return compactAlias === text || compactAlias.includes(text) || /(?:股份有限公司|有限责任公司|保险集团)/.test(text);
}

function looksLikeCompanyLogoLine(value) {
  const text = compactLine(value);
  const alias = matchCompanyAlias(text);
  if (!text || !alias) return false;
  const compactAlias = compactLine(alias);
  const remainder = text.replace(compactAlias, '');
  if (!remainder) return true;
  if (Array.from(remainder).length > 12) return false;
  return /^(?:[a-z0-9]+|心|囗|口|图|标)+$/iu.test(remainder);
}

function isGenericPolicyLine(text) {
  const line = compactLine(text);
  if (!line) return true;
  return /^(保险单|基本内容|保险利益表|特别约定|本栏空白|身故保险金受益人|被保险人的法定继承人|证件号码|受益顺序|受益份额|币值单位[:：]?.*|保险合同号[:：]?.*|关爱人生每一天|基本保险金额\/保险金额|\/保障计划\/份数|保险期间|交费方式|保险费约定支付日|\/交费期间.*|\/交费期满日|保险费|基本保险金额|保险金额)$/.test(
    line
  );
}

function isPolicyNameStructuralBoundary(text) {
  const line = compactLine(text);
  if (!line) return true;
  return /^(保险利益表|保险期间|交费方式|保险费约定支付日|\/交费期间.*|\/交费期满日|特别约定[:：]?|本栏空白|保险单说明[:：]?|保单制作日期[:：]?.*|保险公司签章[:：]?|业务员[:：].*|保单签发地[:：].*|第\d+页共\d+页|\*此码仅.*)$/.test(
    line
  );
}

function isPolicyProductDescriptor(text) {
  const line = compactLine(text);
  if (!line) return false;
  return /^(?:终身|定期|两全|养老年金|年金|医疗|长期医疗|短期医疗|意外|意外伤害|疾病|重大疾病|重疾|护理|失能|豁免|增额终身)?(?:寿险|保险|年金保险|两全保险|医疗保险|意外伤害保险|疾病保险|重大疾病保险|重疾保险|护理保险)(?:（[^）]+）|\([^)]*\))?$/.test(
    line
  );
}

function normalizeNameValue(value) {
  let text = compactLine(value).replace(/^(产品名称|险种名称|保险名称|合同名称|主险名称|名称|保险险种)[:：]?/, '');
  text = text
    .replace(/(?:\s*\/\s*)?(?:保险单说明[:：]?|保单制作日期[:：]?.*|保险公司签章[:：]?|业务员[:：].*|保单签发地[:：].*|第\d+页共\d+页|\*此码仅.*|特别约定[:：]?|本栏空白).*$/, '')
    .trim();
  const segments = text
    .split(/\s*\/\s*/)
    .map((segment) => compactLine(segment))
    .filter(Boolean);
  if (segments.length > 1) {
    const kept = [];
    for (const segment of segments) {
      if (isPolicyNameStructuralBoundary(segment) || isGenericPolicyLine(segment)) break;
      if (isPolicyProductDescriptor(segment)) {
        if (!kept.length) {
          kept.push(segment);
        }
        break;
      }
      kept.push(segment);
    }
    if (kept.length) {
      text = kept.join(' / ');
    }
  }
  if (!text) return '';
  if (text.length <= 2) return '';
  if (isGenericPolicyLine(text)) return '';
  if (isPolicyNameStructuralBoundary(text)) return '';
  if (/^(投保人|被保险人|客户号码|保险期限|缴费年期|缴费方式|保险金额|保险费)/.test(text)) return '';
  if (/保险单$/.test(text)) return '';
  if (looksLikeCompanyName(text) || looksLikeCompanyLogoLine(text)) return '';
  if (/客户号码|第一顺位|第二顺位|身故受益人|受益人|100%|联系电话|邮政编码/.test(text)) return '';
  if (/(?:保险|人寿|健康)(?:股份有限公司|有限责任公司)$/.test(text)) return '';
  if (/^(基本|内容|基本内容|保险|险种|名称|保险名称)$/.test(text)) return '';
  if (/保险金额|保障计划|交费期间|交费期满日|保险费约定支付日/.test(text)) return '';
  if (/^(每年\d{1,2}月\d{1,2}日|至20\d{2}年\d{1,2}月\d{1,2}日|[¥￥]?\d+(?:\.\d+)?元?)$/.test(text)) return '';
  return text;
}

function normalizePersonNameValue(value) {
  const text = compactLine(value);
  if (!text) return '';
  const cleaned = text
    .replace(/^(投保人名称|投保人|投保人姓名|要保人|要保人姓名|被保险人|被保险人姓名|受保人|受保人姓名|被保人)[:：]?/, '')
    .replace(/^（[^）]*）[:：]?/, '')
    .replace(/(性别|生日|出生|生于|证件号码|证件号|受益顺序|受益份额|本栏以下空白|及保险主要事项).*$/, '')
    .trim();
  const matched = cleaned.match(/^[一-龥·]{2,8}/);
  return matched?.[0] || '';
}

function normalizeBeneficiaryValue(value) {
  const text = compactLine(value)
    .replace(/^(身故保险金受益人|身故受益人|受益人)[:：]?/, '')
    .replace(/(受益顺序|受益份额|联系电话|邮政编码|本栏以下空白).*$/, '')
    .trim();
  if (!text) return '';
  if (/^(?:被保险人)?的?法定(?:继承人|继本人|维承人|受益人)?$/.test(text)) return '法定';
  if (/法定(?:继承人|继本人|维承人|受益人)/.test(text)) return '法定';
  return normalizePersonNameValue(text) || text;
}

function isBeneficiaryPlaceholderLine(value) {
  const text = compactLine(value);
  if (!text) return true;
  return /^(?:[-—－一]+|证件号码|证件号|受益顺序|受益份额|身故保险金受益人|身故受益人|受益人)$/.test(text);
}

function extractBeneficiaryFromLines(lines) {
  const inline = normalizeBeneficiaryValue(extractByLabels(lines, LABELS.beneficiary, ['证件号码', '证件号', '受益顺序', '受益份额']));
  if (inline) return inline;

  const labelIndex = findLooseLabelIndex(lines, LABELS.beneficiary);
  if (labelIndex < 0) return '';
  const headerWindow = lines.slice(labelIndex, Math.min(lines.length, labelIndex + 5)).map(compactLine).join(' ');
  const looksLikeBeneficiaryTable = /证件号码|证件号|受益顺序|受益份额/.test(headerWindow);

  for (let index = labelIndex + 1; index < Math.min(lines.length, labelIndex + 12); index += 1) {
    const line = compactLine(lines[index]);
    if (!line) continue;
    if (/保险利益表|特别约定|保险单说明|保单制作日期|保险公司签章|合同生效日期|合同成立日期|投保人/.test(line)) break;
    if (/^(被保险人|被保人|受保人)[:：]/.test(line)) break;
    if (isBeneficiaryPlaceholderLine(line)) continue;
    const value = normalizeBeneficiaryValue(line);
    if (!value) continue;
    if (looksLikeBeneficiaryTable || /法定继承人|继承人|受益人|[一-龥·]{2,8}/.test(value)) return value;
  }

  return '';
}

function normalizePaymentPeriodValue(value) {
  const text = compactLine(value);
  if (!text) return '';
  if (/续期保险费交费日期|交费期满日|保险费约定支付日|缴费.*日期|交费.*日期/.test(text)) return '';
  if (/^(趸交|一次交清|一次性交清|一次性交费|一次性缴清)$/.test(text)) return '趸交';
  if (/^\d+年交$/.test(text)) return text;
  if (/^\d+年(?:期)?$/.test(text)) return `${text.replace(/期$/, '')}交`;
  const matched = text.match(/((?:\d+年)?(?:趸交|年交|月交|季交|一次交清))(?:\/?(\d+年))?/);
  if (matched?.[1]) {
    return matched[2] ? `${matched[1]}/${matched[2]}` : matched[1];
  }
  const freqFirst = text.match(/^(年交|月交|季交|半年交)\/?(\d+年)$/);
  if (freqFirst?.[1] && freqFirst?.[2]) {
    return `${freqFirst[1]}/${freqFirst[2]}`;
  }
  const yearAndMode = text.match(/^(\d+年)(年交|月交|季交|半年交)$/);
  if (yearAndMode?.[1] && yearAndMode?.[2]) {
    return yearAndMode[2] === '年交' ? `${yearAndMode[1]}交` : `${yearAndMode[1]}${yearAndMode[2]}`;
  }
  return '';
}

function normalizePaymentModeValue(value) {
  const text = compactLine(value);
  if (!text) return '';
  if (/^(年缴|年交)$/.test(text)) return '年交';
  if (/^(月缴|月交)$/.test(text)) return '月交';
  if (/^(季缴|季交)$/.test(text)) return '季交';
  if (/^(半年缴|半年交)$/.test(text)) return '半年交';
  if (/^(趸交|一次交清|一次性交清|一次性交费|一次性缴清)$/.test(text)) return '趸交';
  return '';
}

function normalizePaymentYearsValue(value) {
  const text = compactLine(value);
  if (!text) return '';
  const matched = text.match(/^(\d+)(?:年|期)?$/);
  return matched?.[1] || '';
}

function combinePaymentPeriod(paymentYears, paymentMode) {
  const years = normalizePaymentYearsValue(paymentYears);
  const mode = normalizePaymentModeValue(paymentMode);
  if (years && mode === '年交') return `${years}年交`;
  if (years && mode) return `${years}年${mode}`;
  return normalizePaymentPeriodValue(paymentYears) || normalizePaymentPeriodValue(paymentMode);
}

function canonicalPaymentPeriodValue(value) {
  const text = compactLine(value);
  if (!text) return '';
  if (/^(趸交|一次交清|一次性交清|一次性交费|一次性缴清)$/.test(text)) return '趸交';
  const split = text.match(/^(年交|月交|季交|半年交)\/?(\d{1,3})年$/);
  if (split?.[1] && split?.[2]) {
    return split[1] === '年交' ? `${split[2]}年交` : `${split[2]}年${split[1]}`;
  }
  const modeFirst = text.match(/^(年缴|月缴|季缴|半年缴)\/?(\d{1,3})年$/);
  if (modeFirst?.[1] && modeFirst?.[2]) {
    const mode = modeFirst[1].replace('缴', '交');
    return mode === '年交' ? `${modeFirst[2]}年交` : `${modeFirst[2]}年${mode}`;
  }
  if (/^\d{1,3}年交$/.test(text)) return text;
  if (/^\d{1,3}年月交$/.test(text) || /^\d{1,3}年季交$/.test(text) || /^\d{1,3}年半年交$/.test(text)) return text;
  return normalizePaymentPeriodValue(text);
}

function combineMappedPaymentPeriod(matchedFields = {}) {
  const combined = combinePaymentPeriod(matchedFields.paymentPeriod || '', matchedFields.paymentMode || '');
  return canonicalPaymentPeriodValue(combined) || canonicalPaymentPeriodValue(matchedFields.paymentPeriod || '') || canonicalPaymentPeriodValue(matchedFields.paymentMode || '');
}

function normalizeCoveragePeriodValue(value) {
  const text = compactLine(value);
  if (!text) return '';
  const matched = text.match(/(至20\d{2}年\d{1,2}月\d{1,2}日(?:零时)?)/);
  if (matched?.[1]) return matched[1];
  if (/终身/.test(text)) return '终身';
  const ageMatched = text.match(/(?:保至|保障至|至)?(\d{2,3})周?岁/);
  if (ageMatched?.[1]) return `至${ageMatched[1]}岁`;
  if (/^\d+年$/.test(text)) return text;
  return '';
}

function isStandaloneAmountLine(text) {
  const line = compactLine(text);
  if (!line) return false;
  if (/^(每年|首期|首年|合计|¥|￥)/.test(line)) return false;
  if (/^(至20\d{2}年|年交|月交|季交|趸交|一次交清|\/\d+年|\/20\d{2}年)/.test(line)) return false;
  return Boolean(parseAmountValue(line));
}

function normalizeAmountValue(rawValue) {
  const raw = compactLine(rawValue);
  if (!raw) return '';
  if (/保险合同号|合同号|证件号码/.test(raw)) return '';
  if (/年|月|日/.test(raw)) return '';
  if (!/[¥￥元万亿]/.test(raw) && /^\d{9,}$/.test(raw)) return '';
  return parseAmountValue(raw);
}

function formatPositiveAmount(amount) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) return '';
  return Number.isInteger(value) ? String(value) : String(value).replace(/\.?0+$/u, '');
}

function sumNormalizedPlanPremiums(plans) {
  const premiums = (Array.isArray(plans) ? plans : [])
    .map((plan) => Number(plan?.premium || ''))
    .filter((amount) => Number.isFinite(amount) && amount > 0);
  if (!premiums.length) return '';
  return formatPositiveAmount(premiums.reduce((total, amount) => total + amount, 0));
}

export function normalizeExtractedPolicyFields(candidate) {
  const payload = candidate || {};
  const normalizedCompany = normalizeCompanyName(payload.company || '');
  const rawPaymentPeriod = normalizePaymentPeriodValue(payload.paymentPeriod || '')
    || combinePaymentPeriod(payload.paymentYears || '', payload.paymentMode || '')
    || '';
  const plans = normalizePolicyPlans(payload.plans || [], normalizedCompany);
  const mainPlan = plans.find((plan) => plan.role === 'main') || plans[0] || null;
  const planPremiumTotal = sumNormalizedPlanPremiums(plans);
  const insuredIdNumber = normalizeIdNumber(payload.insuredIdNumber || payload.insuredIdentityNumber || payload.insuredIdCard || '');
  const insuredBirthday = formatDateValue(payload.insuredBirthday || payload.insuredBirthDate || '') || birthdayFromIdNumber(insuredIdNumber);
  return {
    company: normalizedCompany,
    name: normalizeNameValue(payload.name || '') || mainPlan?.name || '',
    applicant: normalizePersonNameValue(payload.applicant || ''),
    beneficiary: normalizeBeneficiaryValue(payload.beneficiary || payload.deathBeneficiary || payload.deathBenefitBeneficiary || ''),
    insured: normalizePersonNameValue(payload.insured || ''),
    insuredIdNumber,
    insuredBirthday,
    date: formatDateValue(payload.date || ''),
    paymentPeriod: mainPlan?.paymentPeriod || rawPaymentPeriod,
    coveragePeriod: mainPlan?.coveragePeriod || normalizeCoveragePeriodValue(payload.coveragePeriod || ''),
    amount: mainPlan?.amount || normalizeAmountValue(payload.amount || '') || parseAmountValue(payload.amount || ''),
    firstPremium: planPremiumTotal || normalizeAmountValue(payload.firstPremium || '') || parseAmountValue(payload.firstPremium || ''),
    ...(plans.length ? { plans } : {}),
  };
}

function inferNormalizedPlanProductType(name) {
  const text = compactLine(name);
  if (/万能型|万能账户|万能险|最低保证利率|账户价值/.test(text)) return '万能账户';
  if (/投资连结|投连/.test(text)) return '投连险';
  if (/重大疾病|重疾/.test(text)) return '重疾险';
  if (/医疗/.test(text)) return '医疗险';
  if (/意外/.test(text)) return '意外险';
  if (/护理/.test(text)) return '护理险';
  if (/两全/.test(text)) return '两全保险';
  if (/年金|养老金|养老/.test(text)) return '年金险';
  if (/终身寿|寿险/.test(text)) return '增额终身寿险';
  return '';
}

function normalizePolicyPlanRole(value, index, name) {
  const text = compactLine(`${value || ''}${name || ''}`);
  if (/万能型|万能账户|万能险|最低保证利率|账户价值/.test(text)) return 'linked_account';
  if (/附加/.test(text)) return 'rider';
  if (['main', 'rider', 'linked_account', 'unknown'].includes(String(value || ''))) return String(value);
  return index === 0 ? 'main' : 'rider';
}

function normalizePolicyPlans(plans, company = '') {
  const normalizedCompany = normalizeCompanyName(company);
  return (Array.isArray(plans) ? plans : [])
    .map((plan, index) => {
      const name = normalizeNameValue(plan?.matchedProductName || plan?.name || plan?.productName || '');
      const rawName = normalizeNameValue(plan?.name || plan?.productName || name);
      if (!name && !rawName) return null;
      const paymentMode = normalizePaymentModeValue(plan?.paymentMode || '');
      const rawPaymentPeriod = normalizePaymentPeriodValue(plan?.paymentPeriod || '') || (paymentMode === '趸交' ? '趸交' : '');
      const premium = normalizeAmountValue(plan?.premium || plan?.firstPremium || '') || parseAmountValue(plan?.premium || plan?.firstPremium || '');
      return {
        company: normalizeCompanyName(plan?.company || normalizedCompany),
        role: normalizePolicyPlanRole(plan?.role || '', index, rawName || name),
        name: rawName || name,
        matchedProductName: name && name !== rawName ? name : String(plan?.matchedProductName || '').trim(),
        productType: String(plan?.productType || inferNormalizedPlanProductType(rawName || name)).trim(),
        amount: normalizeAmountValue(plan?.amount || '') || parseAmountValue(plan?.amount || ''),
        coveragePeriod: normalizeCoveragePeriodValue(plan?.coveragePeriod || ''),
        paymentMode,
        paymentPeriod: rawPaymentPeriod,
        premium,
        premiumText: String(plan?.premiumText || '').trim(),
        matchScore: Number(plan?.matchScore || 0) || 0,
        matchReason: String(plan?.matchReason || '').trim(),
      };
    })
    .filter(Boolean);
}

function fallbackFirstPremium(lines) {
  for (const raw of lines) {
    const line = compactLine(raw);
    if (!line) continue;
    if (/首期保险费合计|首期保险费|首期保费|首年保费|保险费合计|总保费/.test(line)) {
      const amount = parseAmountValue(line);
      if (amount) return amount;
    }
  }

  for (const raw of [...lines].reverse()) {
    const line = compactLine(raw);
    if (!line) continue;
    if (/^[¥￥]\d/.test(line)) {
      const amount = parseAmountValue(line);
      if (amount) return amount;
    }
  }

  return '';
}

function extractHeaderCompany(lines, rawText) {
  const headerWindow = normalizeOcrText(lines.slice(0, 16).join('\n'));
  return findCompanyAlias(headerWindow) || findCompanyAlias(rawText);
}

function fallbackCompany(lines) {
  for (const line of lines) {
    const aliased = findCompanyAlias(line);
    if (aliased) return aliased;
  }
  const excludedPattern = new RegExp(
    `^(?:${[
      ...LABELS.name,
      ...LABELS.applicant,
      ...LABELS.insured,
      ...LABELS.date,
      ...LABELS.paymentPeriod,
      ...LABELS.coveragePeriod,
      ...LABELS.amount,
      ...LABELS.firstPremium,
    ]
      .map(escapeRegExp)
      .join('|')})\\s*[:：]?`,
    'i'
  );
  return (
    lines.find((line) => !excludedPattern.test(line) && (/保险.+(公司|集团|股份)/.test(line) || /(公司|集团|股份).+保险/.test(line))) ||
    lines.find((line) => !excludedPattern.test(line) && /(保险|保司)/.test(line)) ||
    ''
  );
}

function fallbackProductName(lines, company) {
  return (
    lines.find((line) => {
      if (!line || line === company) return false;
      if (/保险(?:保单|单)$/.test(compactLine(line))) return false;
      return /(险|医疗|重疾|寿险|意外|年金|保)/.test(line);
    }) || ''
  );
}

function findLooseLabelIndex(lines, labels) {
  const patterns = labels.map((label) => new RegExp(buildLooseLabelPattern(label), 'i'));
  const exactIndex = lines.findIndex((line) => patterns.some((pattern) => pattern.test(line)));
  if (exactIndex >= 0) return exactIndex;
  return lines.findIndex((line) => findFuzzyLabelMatch(line, labels));
}

function fallbackTableProductName(lines) {
  const index = findLooseLabelIndex(lines, LABELS.name);
  if (index < 0) return '';

  let primary = '';
  let suffix = '';
  for (const raw of lines.slice(index + 1, index + 40)) {
    const line = compactLine(raw);
    if (!line) continue;
    if (/^(首期保险费合计|特别约定)/.test(line) || isPolicyNameStructuralBoundary(line)) break;
    if (isGenericPolicyLine(line)) continue;
    if (/^(每年\d{1,2}月\d{1,2}日|至20\d{2}年\d{1,2}月\d{1,2}日|[¥￥]?\d+(?:\.\d+)?元?|\/\d+年|\/20\d{2}年|3份|年交|月交|季交|趸交|一次交清)$/.test(line)) {
      continue;
    }
    if (isPolicyProductDescriptor(line)) {
      if (!primary) {
        primary = line;
      }
      continue;
    }

    if (!primary) {
      primary = line;
      continue;
    }

    if (!/险|保险|医疗|寿险|年金/.test(primary) && /险|保险|医疗|寿险|年金/.test(line)) {
      suffix = line;
      break;
    }
  }
  return normalizeNameValue(`${primary}${suffix}`);
}

function fallbackLooseProductName(lines, company) {
  const index = findLooseLabelIndex(lines, LABELS.name);
  if (index < 0) return '';
  let primary = '';
  let suffix = '';
  for (const raw of lines.slice(index + 1, index + 50)) {
    const line = compactLine(raw);
    if (!line) continue;
    if (isPolicyNameStructuralBoundary(line)) break;
    if (isGenericPolicyLine(line)) continue;
    if (/^(投保人|被保险人|合同成立日期|合同生效日期|保险合同号|特别约定|首期保险费合计|证件号码|受益顺序|受益份额)/.test(line)) continue;
    if (/^(每年\d{1,2}月\d{1,2}日|至20\d{2}年\d{1,2}月\d{1,2}日|[¥￥]?\d+(?:\.\d+)?元?|\/\d+年|\/20\d{2}年|3份|年交|月交|季交|趸交|一次交清)$/.test(line)) continue;
    if (normalizeCompanyName(line) === company || findCompanyAlias(line) === company) continue;
    if (!/[一-龥A-Za-z]/.test(line)) continue;
    if (isPolicyProductDescriptor(line)) {
      if (!primary) {
        primary = line;
      }
      continue;
    }

    if (!primary) {
      primary = line;
      continue;
    }
    if (!/险|保险|医疗|寿险|年金/.test(primary) && /险|保险|医疗|寿险|年金/.test(line)) {
      suffix = line;
      break;
    }
  }
  return normalizeNameValue(`${primary}${suffix}`);
}

function isPolicyProductNoise(line, company) {
  if (!line) return true;
  if (isPolicyNameStructuralBoundary(line)) return true;
  if (isGenericPolicyLine(line)) return true;
  if (
    /^(投保人|被保险人|合同成立日期|合同生效日期|保险合同号|特别约定|首期保险费合计|证件号码|受益顺序|受益份额)/.test(
      line
    )
  ) {
    return true;
  }
  if (
    /^(每年\d{1,2}月\d{1,2}日|至20\d{2}年\d{1,2}月\d{1,2}日(?:零时)?|[¥￥]?\d+(?:\.\d+)?元?|\/\d+年|\/20\d{2}年\d{1,2}月\d{1,2}日|3份|年交|月交|季交|趸交|一次交清)$/.test(
      line
    )
  ) {
    return true;
  }
  if (/(交费|缴费|保险费|日期|合计|金额|份数|零时|受益|本栏空白|期满日|交清)/.test(line)) return true;
  if (normalizeCompanyName(line) === company || findCompanyAlias(line) === company) return true;
  if (!/[一-龥A-Za-z]/.test(line)) return true;
  if (/(?:^|[^\d])\d{3,}(?:\.\d+)?(?:元|份)?$/.test(line)) return true;
  return false;
}

function isPolicyProductComplete(line) {
  return /(保险|医疗保险|寿险|年金保险|两全保险|意外保险|疾病保险|重疾保险|护理保险)$/.test(line);
}

function isPolicyProductSuffix(line) {
  return /^(保险|医疗保险|寿险|年金保险|两全保险|意外保险|疾病保险|重疾保险|护理保险)$/.test(line);
}

function isPolicyProductSeed(line, company) {
  if (isPolicyProductNoise(line, company)) return false;
  if (isPolicyProductDescriptor(line)) return false;
  if (isPolicyProductComplete(line)) return true;
  return !/(?:20\d{2}年|\d+(?:\.\d+)?元|\/\d+年)/.test(line);
}

function collectTablePolicyProductNames(lines, company) {
  const index = findLooseLabelIndex(lines, LABELS.name);
  if (index < 0) return [];

  const source = lines.slice(index + 1, index + 80).map((line) => compactLine(line)).filter(Boolean);
  const picked = [];
  let cursor = 0;

  while (cursor < source.length) {
    const current = source[cursor];
    if (isBenefitTableHeaderLine(current)) {
      cursor += 1;
      continue;
    }
    if (isPolicyNameStructuralBoundary(current)) break;
    if (!isPolicyProductSeed(current, company)) {
      cursor += 1;
      continue;
    }

    let product = current;
    let suffixIndex = -1;
    if (!isPolicyProductComplete(product)) {
      for (let offset = 1; offset <= 6 && cursor + offset < source.length; offset += 1) {
        const next = source[cursor + offset];
        if (isPolicyProductNoise(next, company)) {
          continue;
        }
        if (isPolicyProductSuffix(next) || isPolicyProductDescriptor(next)) {
          product = `${product}${next}`;
          suffixIndex = cursor + offset;
          break;
        }
      }
    }

    const normalized = normalizeNameValue(product);
    if (normalized && !picked.includes(normalized)) {
      picked.push(normalized);
    }
    cursor = suffixIndex >= 0 ? suffixIndex + 1 : cursor + 1;
  }

  return picked;
}

function isBenefitTableHeaderLine(line) {
  const text = compactLine(line);
  if (
    /^(?:基本|保险金额\/?|保险金额|保险期间|交费方式|保险费约定支付日|保险费|\/?保障计划\/份数|\/?交费期间(?:（续期)?|保险费交费日期）?|\/?交费期满日|首期)$/u.test(
      text
    )
  ) {
    return true;
  }
  return BENEFIT_TABLE_HEADER_LABELS.some((label) => matchesFuzzyPhrase(text, label, { minScore: fuzzyLabelThreshold(label) }));
}

function extractBenefitTableProductName(lines, company) {
  const index = findLooseLabelIndex(lines, LABELS.name);
  if (index < 0) return '';

  const source = lines.slice(index + 1, index + 80).map((line) => compactLine(line)).filter(Boolean);
  for (let cursor = 0; cursor < source.length; cursor += 1) {
    const current = source[cursor];
    if (isBenefitTableHeaderLine(current)) continue;
    if (isPolicyNameStructuralBoundary(current)) break;
    if (isPolicyProductNoise(current, company)) continue;
    if (isPolicyProductDescriptor(current)) continue;

    let descriptor = '';
    for (let offset = 1; offset <= 16 && cursor + offset < source.length; offset += 1) {
      const next = source[cursor + offset];
      if (isPolicyNameStructuralBoundary(next)) break;
      if (isPolicyProductDescriptor(next) || isPolicyProductSuffix(next)) {
        descriptor = next;
        break;
      }
    }

    const normalized = normalizeNameValue(`${current}${descriptor}`);
    if (normalized) return normalized;
  }
  return '';
}

function fallbackCoveragePeriod(lines) {
  for (const raw of lines) {
    const line = normalizeCoveragePeriodValue(raw);
    if (line) return line;
  }
  return '';
}

function fallbackPaymentPeriod(lines) {
  for (let index = 0; index < lines.length; index += 1) {
    const current = compactLine(lines[index]);
    if (!current) continue;
    const matched = current.match(/((?:\d+年)?(?:趸交|月交|年交|季交|一次交清))/);
    if (matched?.[1]) {
      if (/^\d+年交$/.test(matched[1])) return matched[1];
      for (let offset = 1; offset <= 3; offset += 1) {
        const next = compactLine(lines[index + offset] || '');
        if (next && /^\/?\d+年/.test(next)) {
          return `${matched[1]}/${next.replace(/^\/+/, '')}`;
        }
      }
      return matched[1];
    }
  }
  return '';
}

function fallbackAmount(lines) {
  const index = findLooseLabelIndex(lines, LABELS.name);
  const source = index >= 0 ? lines.slice(index + 1, index + 50) : lines;
  for (const raw of source) {
    const line = compactLine(raw);
    if (!line) continue;
    if (/保险合同号|合同号|证件号码|客户号码|保单号|联系电话|邮政编码|营业部代码|业务员姓名及代码/.test(String(raw || ''))) continue;
    if (/年\d{1,2}月\d{1,2}日|合同成立|合同生效|生效日|生效时间/.test(String(raw || ''))) continue;
    if (/^(首期保险费|首年保费|保险费合计|首期保险费合计|总保费|总保险费|每年|[¥￥])/.test(line)) continue;
    if (/^(至20\d{2}年|年交|月交|季交|趸交|一次交清|\/\d+年|\/20\d{2}年)/.test(line)) continue;
    const amount = normalizeAmountValue(raw);
    if (amount) return amount;
  }
  return '';
}

const HORIZONTAL_POLICY_TABLE_HEADERS = [
  { key: 'insured', pattern: /^被保险人(?:姓名)?$/ },
  { key: 'customerNo', pattern: /^客户号码$/ },
  { key: 'name', pattern: /^(保险险种|险种名称|保险名称|主险名称)$/ },
  { key: 'coveragePeriod', pattern: /^(保险期限|保险期间|保障期间)$/ },
  { key: 'paymentYears', pattern: /^(缴费年期|交费年期|缴费年限|交费年限)$/ },
  { key: 'paymentMode', pattern: /^(缴费方式|交费方式)$/ },
  { key: 'amount', pattern: /^(保险金额(?:\(元\)|（元）)?|基本保险金额(?:\(元\)|（元）)?)$/ },
  { key: 'firstPremium', pattern: /^(保险费(?:\(元\)|（元）)?|首期保险费(?:\(元\)|（元）)?|总保费(?:\(人民币\))?)$/ },
];

const INLINE_HORIZONTAL_HEADER_LABELS = [
  { key: 'insured', labels: ['被保险人姓名', '被保险人'] },
  { key: 'customerNo', labels: ['客户号码'] },
  { key: 'name', labels: ['保险险种', '险种名称', '保险名称', '主险名称'] },
  { key: 'coveragePeriod', labels: ['保险期限', '保险期间', '保障期间'] },
  { key: 'paymentYears', labels: ['缴费年期', '交费年期', '缴费年限', '交费年限'] },
  { key: 'paymentMode', labels: ['缴费方式', '交费方式'] },
  { key: 'amount', labels: ['保险金额(元)', '保险金额（元）', '保险金额', '基本保险金额(元)', '基本保险金额（元）', '基本保险金额'] },
  { key: 'firstPremium', labels: ['保险费(元)', '保险费（元）', '保险费', '首期保险费(元)', '首期保险费（元）', '首期保险费', '总保费(人民币)', '总保费'] },
];

function detectHorizontalPolicyHeaderKey(line) {
  const text = compactLine(line);
  if (!text) return '';
  const matched = HORIZONTAL_POLICY_TABLE_HEADERS.find((item) => item.pattern.test(text));
  return matched?.key || '';
}

function isHorizontalPolicySectionTerminator(line) {
  const text = compactLine(line);
  if (!text) return true;
  return /^(身故受益人|第一顺位|第二顺位|本栏以下空白|特别约定|营业部代码|业务员姓名及代码|养老保险领取方式|红利选择|第\d+页)/.test(
    text
  );
}

function parseTailAmountSegment(line) {
  const raw = String(line || '').trim();
  if (!raw) return null;

  const decimalMatches = Array.from(raw.matchAll(/(?:RMB|[¥￥])?\d[\d,]*\.\d{2}(?:元)?/gi));
  const genericMatches = decimalMatches.length
    ? decimalMatches
    : Array.from(raw.matchAll(/(?:RMB|[¥￥])?\d[\d,]*(?:元|万|亿)?/gi));
  const matched = [...genericMatches]
    .reverse()
    .find((item) => normalizeAmountValue(item[0]) || parseAmountValue(item[0]));
  if (!matched?.[0]) return null;

  const amount = normalizeAmountValue(matched[0]) || parseAmountValue(matched[0]);
  if (!amount) return null;
  return {
    amount,
    remaining: cleanupFieldValue(raw.slice(0, matched.index).trim()),
  };
}

function parseTailPaymentMode(line) {
  const matched = String(line || '').match(/(趸交|一次交清|一次性交清|一次性交费|一次性缴清|年缴|年交|月缴|月交|季缴|季交|半年缴|半年交)(?:\s*)$/);
  if (!matched?.[1]) return null;
  return {
    value: matched[1],
    remaining: cleanupFieldValue(String(line || '').slice(0, matched.index).trim()),
  };
}

function parseTailPaymentYears(line) {
  const matched = String(line || '').match(/(\d{1,3})(?:年|期)?(?:\s*)$/);
  if (!matched?.[1]) return null;
  return {
    value: matched[1],
    remaining: cleanupFieldValue(String(line || '').slice(0, matched.index).trim()),
  };
}

function parseTailCoveragePeriod(line) {
  const matched = String(line || '').match(/(终身|至20\d{2}年\d{1,2}月\d{1,2}日(?:零时)?|至\d{2,3}周?岁|\d+年)(?:\s*)$/);
  if (!matched?.[1]) return null;
  return {
    value: matched[1],
    remaining: cleanupFieldValue(String(line || '').slice(0, matched.index).trim()),
  };
}

function splitLeadingInsuredAndCustomerNo(line) {
  const text = cleanupFieldValue(line);
  if (!text) return { insured: '', customerNo: '', remaining: '' };
  const matched = text.match(/^([一-龥·]{2,8})\s*([A-Z]{0,4}\d{6,}[A-Z0-9]*)\s*(.*)$/i);
  if (matched) {
    return {
      insured: normalizePersonNameValue(matched[1]),
      customerNo: matched[2],
      remaining: cleanupFieldValue(matched[3]),
    };
  }
  const nameOnly = text.match(/^([一-龥·]{2,8})\s*(.*)$/);
  return {
    insured: normalizePersonNameValue(nameOnly?.[1] || ''),
    customerNo: '',
    remaining: cleanupFieldValue(nameOnly?.[2] || ''),
  };
}

function mapCompactHorizontalValueLine(headerKeys, line) {
  let remaining = cleanupFieldValue(line);
  if (!remaining) {
    return {
      name: '',
      insured: '',
      coveragePeriod: '',
      paymentPeriod: '',
      amount: '',
      firstPremium: '',
    };
  }

  const mapped = {
    name: '',
    insured: '',
    coveragePeriod: '',
    paymentPeriod: '',
    amount: '',
    firstPremium: '',
  };
  let paymentYears = '';
  let paymentMode = '';

  if (headerKeys.includes('firstPremium')) {
    const parsed = parseTailAmountSegment(remaining);
    if (parsed) {
      mapped.firstPremium = parsed.amount;
      remaining = parsed.remaining;
    }
  }

  if (headerKeys.includes('amount')) {
    const parsed = parseTailAmountSegment(remaining);
    if (parsed) {
      mapped.amount = parsed.amount;
      remaining = parsed.remaining;
    }
  }

  if (headerKeys.includes('paymentMode')) {
    const parsed = parseTailPaymentMode(remaining);
    if (parsed) {
      paymentMode = parsed.value;
      remaining = parsed.remaining;
    }
  }

  if (headerKeys.includes('paymentYears')) {
    const parsed = parseTailPaymentYears(remaining);
    if (parsed) {
      paymentYears = parsed.value;
      remaining = parsed.remaining;
    }
  }

  if (headerKeys.includes('coveragePeriod')) {
    const parsed = parseTailCoveragePeriod(remaining);
    if (parsed) {
      mapped.coveragePeriod = normalizeCoveragePeriodValue(parsed.value);
      remaining = parsed.remaining;
    }
  }

  const leading = splitLeadingInsuredAndCustomerNo(remaining);
  if (headerKeys.includes('insured')) {
    mapped.insured = leading.insured;
  }
  const productSource = headerKeys.includes('customerNo') ? leading.remaining : remaining;
  if (headerKeys.includes('name')) {
    mapped.name = normalizeNameValue(productSource);
  }
  mapped.paymentPeriod = combinePaymentPeriod(paymentYears, paymentMode);
  return mapped;
}

function extractHorizontalTableFields(lines) {
  const source = lines
    .map((line) => ({ raw: cleanupFieldValue(line), compact: compactLine(line) }))
    .filter((item) => item.compact);

  const mapHeaderKeysToValues = (headerKeys, valueTokens) => {
    const mapped = {
      name: '',
      insured: '',
      coveragePeriod: '',
      paymentPeriod: '',
      amount: '',
      firstPremium: '',
    };
    let paymentYears = '';
    let paymentMode = '';

    for (let index = 0; index < Math.min(headerKeys.length, valueTokens.length); index += 1) {
      const key = headerKeys[index];
      const value = valueTokens[index];
      if (!value) continue;
      if (key === 'insured') {
        mapped.insured = normalizePersonNameValue(value);
      } else if (key === 'name') {
        mapped.name = normalizeNameValue(value);
      } else if (key === 'coveragePeriod') {
        mapped.coveragePeriod = normalizeCoveragePeriodValue(value);
      } else if (key === 'paymentYears') {
        paymentYears = value;
      } else if (key === 'paymentMode') {
        paymentMode = value;
      } else if (key === 'amount') {
        mapped.amount = normalizeAmountValue(value);
      } else if (key === 'firstPremium') {
        mapped.firstPremium = normalizeAmountValue(value) || parseAmountValue(value);
      }
    }

    mapped.paymentPeriod = combinePaymentPeriod(paymentYears, paymentMode);
    return mapped;
  };

  for (let start = 0; start < source.length; start += 1) {
    const headerKeys = [];
    let cursor = start;
    while (cursor < source.length) {
      const key = detectHorizontalPolicyHeaderKey(source[cursor].raw);
      if (!key) {
        if (headerKeys.length === 0) break;
        break;
      }
      if (!headerKeys.includes(key)) {
        headerKeys.push(key);
      }
      cursor += 1;
    }

    if (headerKeys.length < 5) continue;

    const values = [];
    let valueCursor = cursor;
    while (valueCursor < source.length && values.length < headerKeys.length) {
      const item = source[valueCursor];
      if (!item.compact) {
        valueCursor += 1;
        continue;
      }
      if (detectHorizontalPolicyHeaderKey(item.raw)) break;
      if (isHorizontalPolicySectionTerminator(item.raw)) break;
      values.push(item.raw);
      valueCursor += 1;
    }

    if (values.length < 1) continue;
    let mapped = mapHeaderKeysToValues(headerKeys, values);
    if ((!mapped.name || !mapped.paymentPeriod || !mapped.amount || !mapped.firstPremium) && values.length === 1) {
      const compactMapped = mapCompactHorizontalValueLine(headerKeys, values[0]);
      if (
        compactMapped.name
        || compactMapped.insured
        || compactMapped.coveragePeriod
        || compactMapped.paymentPeriod
        || compactMapped.amount
        || compactMapped.firstPremium
      ) {
        mapped = compactMapped;
      }
    }
    if ((!mapped.name || !mapped.paymentPeriod || !mapped.amount || !mapped.firstPremium) && values.length === 1) {
      const inlineTokens = values[0].split(/\s+/).map((item) => cleanupFieldValue(item)).filter(Boolean);
      if (inlineTokens.length >= headerKeys.length) {
        mapped = mapHeaderKeysToValues(headerKeys, inlineTokens);
      }
    }
    if (mapped.name || mapped.insured || mapped.coveragePeriod || mapped.paymentPeriod || mapped.amount || mapped.firstPremium) {
      return mapped;
    }
  }

  return {
    name: '',
    insured: '',
    coveragePeriod: '',
    paymentPeriod: '',
    amount: '',
    firstPremium: '',
  };
}

function extractInlineHorizontalTableFields(lines) {
  const source = lines
    .map((line) => ({ raw: cleanupFieldValue(line), compact: compactLine(line) }))
    .filter((item) => item.compact);

  const findHeaderPositions = (line) =>
    INLINE_HORIZONTAL_HEADER_LABELS.flatMap((item) =>
      item.labels.map((label) => ({
        key: item.key,
        index: line.indexOf(compactLine(label)),
        label,
      }))
    )
      .filter((item) => item.index >= 0)
      .sort((a, b) => a.index - b.index);

  for (let index = 0; index < source.length; index += 1) {
    const headerLine = source[index];
    const headerPositions = findHeaderPositions(headerLine.compact);
    if (headerPositions.length < 5) continue;

    const valueLine = source[index + 1];
    if (!valueLine || isHorizontalPolicySectionTerminator(valueLine.raw)) continue;
    if (findHeaderPositions(valueLine.compact).length >= 3) continue;

    const valueTokens = valueLine.raw.split(/\s+/).map((item) => cleanupFieldValue(item)).filter(Boolean);
    if (valueTokens.length < 5) continue;

    const mapped = {
      name: '',
      insured: '',
      coveragePeriod: '',
      paymentPeriod: '',
      amount: '',
      firstPremium: '',
    };
    let paymentYears = '';
    let paymentMode = '';

    for (let cursor = 0; cursor < Math.min(headerPositions.length, valueTokens.length); cursor += 1) {
      const key = headerPositions[cursor].key;
      const token = valueTokens[cursor];
      if (!token) continue;
      if (key === 'insured') mapped.insured = normalizePersonNameValue(token);
      else if (key === 'name') mapped.name = normalizeNameValue(token);
      else if (key === 'coveragePeriod') mapped.coveragePeriod = normalizeCoveragePeriodValue(token);
      else if (key === 'paymentYears') paymentYears = token;
      else if (key === 'paymentMode') paymentMode = token;
      else if (key === 'amount') mapped.amount = normalizeAmountValue(token);
      else if (key === 'firstPremium') mapped.firstPremium = normalizeAmountValue(token) || parseAmountValue(token);
    }

    mapped.paymentPeriod = combinePaymentPeriod(paymentYears, paymentMode);
    if (mapped.name || mapped.insured || mapped.coveragePeriod || mapped.paymentPeriod || mapped.amount || mapped.firstPremium) {
      return mapped;
    }
  }

  return {
    name: '',
    insured: '',
    coveragePeriod: '',
    paymentPeriod: '',
    amount: '',
    firstPremium: '',
  };
}

function extractCompressedHorizontalTableFields(rawText, lines = []) {
  const source = Array.from(
    new Set(
      normalizeOcrText(rawText)
        .split('\n')
        .map((line) => compactLine(line))
        .filter(Boolean)
    )
  );

  const findHeaderPositions = (line) =>
    INLINE_HORIZONTAL_HEADER_LABELS.flatMap((item) =>
      item.labels.map((label) => ({
        key: item.key,
        label: compactLine(label),
        index: line.indexOf(compactLine(label)),
      }))
    )
      .filter((item) => item.index >= 0)
      .sort((a, b) => {
        if (a.index !== b.index) return a.index - b.index;
        return b.label.length - a.label.length;
      });

  for (const line of source) {
    const positions = findHeaderPositions(line);
    if (positions.length < 5) continue;

    const ordered = [];
    for (const item of positions) {
      if (ordered.length && ordered[ordered.length - 1].key === item.key) continue;
      ordered.push(item);
    }

    const lastHeader = ordered[ordered.length - 1];
    if (!lastHeader) continue;
    const tail = cleanupFieldValue(line.slice(lastHeader.index + lastHeader.label.length));
    if (!tail) continue;

    const mapped = mapCompactHorizontalValueLine(
      ordered.map((item) => item.key),
      tail,
    );
    if (mapped.name || mapped.insured || mapped.coveragePeriod || mapped.paymentPeriod || mapped.amount || mapped.firstPremium) {
      return mapped;
    }
  }

  return {
    name: '',
    insured: '',
    coveragePeriod: '',
    paymentPeriod: '',
    amount: '',
    firstPremium: '',
  };
}

function extractLoosePolicyRowFields(lines) {
  const source = lines.map((line) => cleanupFieldValue(line)).filter(Boolean);

  for (const line of source) {
    const text = compactLine(line);
    if (!text) continue;
    if (/^(投保人|被保险人|客户号码|承保日期|合同生效日期|合同成立日期|总保费|身故受益人|第一顺位|第二顺位|特别约定|营业部代码|业务员姓名及代码)/.test(text)) {
      continue;
    }
    if (!/(终身|至20\d{2}年\d{1,2}月\d{1,2}日(?:零时)?|至\d{2,3}周?岁|\d+年)/.test(text)) continue;
    if (!/(年缴|年交|月缴|月交|季缴|季交|趸交|一次交清|一次性交清|一次性交费|一次性缴清)/.test(text)) continue;
    if ((text.match(/\d[\d,.]*(?:元)?/g) || []).length < 2) continue;

    const premiumParsed = parseTailAmountSegment(line);
    if (!premiumParsed) continue;
    const amountParsed = parseTailAmountSegment(premiumParsed.remaining);
    if (!amountParsed) continue;
    const paymentModeParsed = parseTailPaymentMode(amountParsed.remaining);
    if (!paymentModeParsed) continue;
    const paymentYearsParsed = parseTailPaymentYears(paymentModeParsed.remaining);
    if (!paymentYearsParsed) continue;
    const coverageParsed = parseTailCoveragePeriod(paymentYearsParsed.remaining);
    if (!coverageParsed) continue;

    const leading = splitLeadingInsuredAndCustomerNo(coverageParsed.remaining);
    const name = normalizeNameValue(leading.remaining);
    if (!name) continue;

    return {
      name,
      insured: leading.insured,
      coveragePeriod: normalizeCoveragePeriodValue(coverageParsed.value),
      paymentPeriod: combinePaymentPeriod(paymentYearsParsed.value, paymentModeParsed.value),
      amount: amountParsed.amount,
      firstPremium: premiumParsed.amount,
    };
  }

  return {
    name: '',
    insured: '',
    coveragePeriod: '',
    paymentPeriod: '',
    amount: '',
    firstPremium: '',
  };
}

function extractInlineLabeledPolicyFields(lines) {
  const source = lines.map((line) => cleanupFieldValue(line)).filter(Boolean);
  const mapped = {
    applicant: '',
    insured: '',
    name: '',
    date: '',
    paymentPeriod: '',
    coveragePeriod: '',
    amount: '',
    firstPremium: '',
  };
  let paymentYears = '';
  let paymentMode = '';

  const extractInline = (labels, line) => {
    const ordered = [...labels].sort((a, b) => b.length - a.length);
    for (const label of ordered) {
      const pattern = new RegExp(`^${buildLooseLabelPattern(label)}\\s*[:：]?\\s*(.+)$`, 'i');
      const matched = line.match(pattern);
      if (matched?.[1]) return cleanupFieldValue(matched[1]);
    }
    return '';
  };

  for (const line of source) {
    if (!mapped.applicant) {
      const value = extractInline(LABELS.applicant, line);
      if (value) mapped.applicant = normalizePersonNameValue(value);
    }
    if (!mapped.insured) {
      const value = extractInline(LABELS.insured, line);
      if (value) mapped.insured = normalizePersonNameValue(value);
    }
    if (!mapped.name) {
      const value = extractInline(LABELS.name, line);
      if (value) mapped.name = normalizeNameValue(value);
    }
    if (!mapped.date) {
      const value = extractInline(LABELS.date, line);
      if (value) mapped.date = formatDateValue(value);
    }
    if (!paymentYears) {
      paymentYears = extractInline(['缴费年期', '交费年期', '缴费年限', '交费年限'], line) || paymentYears;
    }
    if (!paymentMode) {
      paymentMode = extractInline(['缴费方式', '交费方式'], line) || paymentMode;
    }
    if (!mapped.coveragePeriod) {
      const value = extractInline(LABELS.coveragePeriod, line);
      if (value) mapped.coveragePeriod = normalizeCoveragePeriodValue(value);
    }
    if (!mapped.amount) {
      const value = extractInline(['保险金额(元)', '保险金额（元）', ...LABELS.amount], line);
      if (value) mapped.amount = normalizeAmountValue(value);
    }
    if (!mapped.firstPremium) {
      const value = extractInline(['保险费(元)', '保险费（元）', ...LABELS.firstPremium], line);
      if (value) mapped.firstPremium = normalizeAmountValue(value);
    }
  }

  mapped.paymentPeriod = combinePaymentPeriod(paymentYears, paymentMode);
  return mapped;
}

function extractSequentialTableFields(lines, company) {
  const source = lines.map((line) => compactLine(line)).filter(Boolean);
  const findStandaloneHeaderIndex = (pattern) => source.findIndex((line) => pattern.test(line));
  const headerIndexes = [
    findStandaloneHeaderIndex(/^保险项目$/),
    findStandaloneHeaderIndex(/^保险期间$/),
    findStandaloneHeaderIndex(/^(交费年限|缴费年限|交费期间|缴费期间)$/),
    findStandaloneHeaderIndex(/^(基本保险金额\/份数\/档次|基本保险金额\/保险金额|基本保险金额)$/),
    findStandaloneHeaderIndex(/^保险费$/),
  ].filter((index) => index >= 0);

  if (headerIndexes.length < 5) {
    return { name: '', coveragePeriod: '', paymentPeriod: '', amount: '', firstPremium: '' };
  }

  const values = source.slice(Math.max(...headerIndexes) + 1, Math.max(...headerIndexes) + 16);
  let name = '';
  let coveragePeriod = '';
  let paymentPeriod = '';
  let amount = '';
  let firstPremium = '';

  for (const line of values) {
    if (!line) continue;
    if (/^\(本栏以下空白\)|^特别约定/.test(line)) break;

    const totalPremium = /首期保费合计|首期保险费合计|保险费合计/.test(line) ? parseAmountValue(line) : '';
    if (totalPremium) {
      firstPremium = totalPremium;
      continue;
    }

    if (!name) {
      const normalizedName = normalizeNameValue(line.replace(/^(投保主险|主险|保险项目|投保产品)[:：]?/, ''));
      if (
        normalizedName
        && !looksLikeCompanyName(normalizedName)
        && !/保险单|保险合同|投保人|被保险人|本栏以下空白|首期保费/.test(normalizedName)
        && !normalizeCoveragePeriodValue(normalizedName)
        && !normalizePaymentPeriodValue(normalizedName)
        && !/^[¥￥]?\d+(?:[,.]\d+)?(?:元|万|亿)?$/.test(normalizedName)
      ) {
        name = normalizedName;
        continue;
      }
    }

    if (!coveragePeriod) {
      const coverageValue = normalizeCoveragePeriodValue(line);
      if (coverageValue) {
        coveragePeriod = coverageValue;
        continue;
      }
    }

    if (!paymentPeriod) {
      const paymentValue = normalizePaymentPeriodValue(line);
      if (paymentValue) {
        paymentPeriod = paymentValue;
        continue;
      }
    }

    const amountValue = /^[¥￥]?\d[\d,.]*(?:元|万|亿)?$/.test(line) ? normalizeAmountValue(line) : '';
    if (amountValue) {
      if (!amount) {
        amount = amountValue;
        continue;
      }
      if (!firstPremium) {
        firstPremium = amountValue;
      }
    }
  }

  return {
    name,
    coveragePeriod,
    paymentPeriod,
    amount,
    firstPremium,
  };
}

function extractPrimaryPlanRowFields(lines) {
  const source = lines.map((line) => compactLine(line)).filter(Boolean);
  const productIndex = source.findIndex((line) => /^(投保主险|主险)[:：]?/.test(line));
  if (productIndex < 0) {
    return { name: '', coveragePeriod: '', paymentPeriod: '', amount: '', firstPremium: '' };
  }

  const inlineLine = source[productIndex].replace(/^(投保主险|主险)[:：]?/, '');
  let name = '';
  let coveragePeriod = '';
  let paymentPeriod = '';
  let amount = '';
  let firstPremium = '';

  const inlineCoverageMatch = inlineLine.match(/(终身|至20\d{2}年\d{1,2}月\d{1,2}日(?:零时)?|至\d{2,3}周?岁|\d+年)/);
  if (inlineCoverageMatch?.index != null) {
    const rawName = inlineLine.slice(0, inlineCoverageMatch.index);
    const rest = inlineLine.slice(inlineCoverageMatch.index + inlineCoverageMatch[1].length);
    const rawAmounts = [
      ...rest.matchAll(/(?:RMB|[¥￥])?\d[\d,]*(?:\.\d+)?元|RMB\d[\d,]*(?:\.\d+)?/gi),
    ]
      .map((matched) => normalizeAmountValue(String(matched[0] || '')))
      .filter(Boolean);

    name = normalizeNameValue(rawName);
    coveragePeriod = normalizeCoveragePeriodValue(inlineCoverageMatch[1]);

    const paymentMatch = rest.match(/(趸交|一次交清|一次性交清|一次性交费|一次性缴清|\d+年(?:交)?|年交|月交|季交|半年交)/);
    if (paymentMatch?.[1]) {
      paymentPeriod = normalizePaymentPeriodValue(paymentMatch[1]);
    }

    if (rawAmounts[0]) amount = rawAmounts[0];
    if (rawAmounts[1]) firstPremium = rawAmounts[1];
  }

  if (!name) {
    name = normalizeNameValue(inlineLine);
  }

  for (const line of source.slice(productIndex + 1, productIndex + 8)) {
    if (!coveragePeriod) {
      const coverageValue = normalizeCoveragePeriodValue(line);
      if (coverageValue) {
        coveragePeriod = coverageValue;
        continue;
      }
    }

    if (!paymentPeriod) {
      const paymentValue = normalizePaymentPeriodValue(line);
      if (paymentValue) {
        paymentPeriod = paymentValue;
        continue;
      }
    }

    const amountValue = /^[¥￥]?\d[\d,.]*(?:元|万|亿)?$/.test(line) ? normalizeAmountValue(line) : '';
    if (amountValue) {
      if (!amount) {
        amount = amountValue;
        continue;
      }
      if (!firstPremium) {
        firstPremium = amountValue;
      }
    }
  }

  if (!firstPremium) {
    for (const line of source.slice(productIndex, productIndex + 24)) {
      if (/首期保费合计|首期保险费合计|保险费合计/.test(line)) {
        const totalPremium = parseAmountValue(line);
        if (totalPremium) {
          firstPremium = totalPremium;
          break;
        }
      }
    }
  }

  return {
    name,
    coveragePeriod,
    paymentPeriod,
    amount,
    firstPremium,
  };
}

function mergeRecognizedTextCandidates(...texts) {
  const lines = [];
  const seen = new Set();
  for (const raw of texts) {
    for (const line of splitRecognizedLines(raw)) {
      const key = compactLine(line).toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      lines.push(cleanupFieldValue(line));
    }
  }
  return normalizeOcrText(lines.join('\n'));
}

function scorePolicyData(data) {
  let score = 0;
  if (data.company) score += 2;
  if (data.name) score += 3;
  if (data.applicant) score += 1.5;
  if (data.insured) score += 1.5;
  if (data.date) score += 1.5;
  if (data.paymentPeriod) score += 1;
  if (data.coveragePeriod) score += 1;
  if (data.amount) score += 2;
  if (data.firstPremium) score += 2;
  return score;
}

function sumPlanPremiumsForFields(plans = []) {
  const values = (Array.isArray(plans) ? plans : [])
    .map((plan) => Number(plan?.premium || ''))
    .filter((amount) => Number.isFinite(amount) && amount > 0);
  if (!values.length) return '';
  const total = values.reduce((sum, amount) => sum + amount, 0);
  return Number.isInteger(total) ? String(total) : String(total).replace(/\.?0+$/u, '');
}

function pickFirstNonEmpty(values) {
  return values.find(Boolean) || '';
}

function pickLongest(values) {
  return values
    .filter(Boolean)
    .sort((a, b) => String(b).length - String(a).length)[0] || '';
}

function pickBestPaymentPeriod(values) {
  return values
    .filter(Boolean)
    .sort((a, b) => {
      const scoreA = (String(a).includes('/') ? 2 : 0) + String(a).length;
      const scoreB = (String(b).includes('/') ? 2 : 0) + String(b).length;
      return scoreB - scoreA;
    })[0] || '';
}

function pickLargestNumeric(values) {
  return values
    .filter(Boolean)
    .map((value) => ({ raw: String(value), num: Number(value) }))
    .filter((item) => Number.isFinite(item.num) && item.num > 0)
    .sort((a, b) => b.num - a.num)[0]?.raw || '';
}

function scorePolicyPlans(plans = []) {
  return (Array.isArray(plans) ? plans : []).reduce((score, plan) => {
    if (plan?.name) score += 2;
    if (plan?.role) score += 0.5;
    for (const key of ['amount', 'coveragePeriod', 'paymentMode', 'paymentPeriod', 'premium']) {
      if (plan?.[key]) score += 1;
    }
    return score;
  }, 0);
}

function mergePolicyDataCandidates(dataList) {
  const plans = dataList
    .map((item) => (Array.isArray(item?.plans) ? item.plans : []))
    .sort((a, b) => scorePolicyPlans(b) - scorePolicyPlans(a) || b.length - a.length)[0] || [];
  const insuredIdNumber = pickFirstNonEmpty(dataList.map((item) => item?.insuredIdNumber || ''));
  return {
    company: pickFirstNonEmpty(dataList.map((item) => item?.company || '')),
    name: pickLongest(dataList.map((item) => item?.name || '')),
    applicant: pickFirstNonEmpty(dataList.map((item) => item?.applicant || '')),
    insured: pickFirstNonEmpty(dataList.map((item) => item?.insured || '')),
    insuredIdNumber,
    insuredBirthday: pickFirstNonEmpty(dataList.map((item) => item?.insuredBirthday || '')) || birthdayFromIdNumber(insuredIdNumber),
    date: pickFirstNonEmpty(dataList.map((item) => item?.date || '')),
    paymentPeriod: pickBestPaymentPeriod(dataList.map((item) => item?.paymentPeriod || '')),
    coveragePeriod: pickLongest(dataList.map((item) => item?.coveragePeriod || '')),
    amount: pickLargestNumeric(dataList.map((item) => item?.amount || '')),
    firstPremium: pickLargestNumeric(dataList.map((item) => item?.firstPremium || '')),
    ...(plans.length ? { plans } : {}),
  };
}

export function selectBestPolicyScanCandidate(texts) {
  const uniqueTexts = [];
  const seen = new Set();
  for (const raw of texts) {
    const normalized = normalizeOcrText(raw);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    uniqueTexts.push(normalized);
  }

  const evaluated = uniqueTexts.map((text) => ({
    ocrText: text,
    data: extractPolicyFieldsFromText(text),
  }));

  let best = { score: -1, data: null, ocrText: '' };
  for (const item of evaluated) {
    const data = item.data;
    const score = scorePolicyData(data);
    if (score > best.score) {
      best = { score, data, ocrText: item.ocrText };
    }
  }

  if (evaluated.length > 1) {
    const mergedData = mergePolicyDataCandidates(evaluated.map((item) => item.data));
    const mergedText = mergeRecognizedTextCandidates(...uniqueTexts);
    const mergedScore = scorePolicyData(mergedData);
    if (mergedScore >= best.score) {
      best = { score: mergedScore, data: mergedData, ocrText: mergedText };
    }
  }

  return best;
}

export function extractPolicyFieldsFromText(rawText) {
  const lines = splitRecognizedLines(rawText);
  const isTableStyle = lines.some((line) => /保险利益表/.test(line)) && findLooseLabelIndex(lines, LABELS.name) >= 0;
  const isReceiptStyle =
    lines.some((line) => /保险业务收据/u.test(line)) ||
    (lines.filter((line) => /^产品名称[:：]?/u.test(compactLine(line))).length >= 2 && lines.some((line) => /^金额\s*[¥￥]?\d/u.test(compactLine(line))));
  const headerCompany = extractHeaderCompany(lines, rawText);
  const company = normalizeCompanyName(
    headerCompany || extractByLabels(lines, LABELS.company) || cleanupFieldValue(fallbackCompany(lines)) || findCompanyAlias(rawText)
  );
  const fieldMatch = matchPolicyFieldsFromLines(lines, { company, rawText });
  const matchedFields = fieldMatch.fields || {};
  const inlineLabeledData = extractInlineLabeledPolicyFields(lines);
  const horizontalTableData = extractHorizontalTableFields(lines);
  const inlineHorizontalTableData = extractInlineHorizontalTableFields(lines);
  const compressedHorizontalTableData = extractCompressedHorizontalTableFields(rawText, lines);
  const loosePolicyRowData = extractLoosePolicyRowFields(lines);
  const sequentialTableData = extractSequentialTableFields(lines, company);
  const primaryPlanRowData = extractPrimaryPlanRowFields(lines);
  const plans = normalizePolicyPlans(extractPolicyPlansFromLines(lines, { company }), company);
  const mainPlan = plans.find((plan) => plan.role === 'main') || plans[0] || null;
  const benefitTableName = extractBenefitTableProductName(lines, company);
  const tableProductNames = collectTablePolicyProductNames(lines, company);
  const tableName =
    benefitTableName
    || matchedFields.name
    || tableProductNames.filter(Boolean).join(' / ')
    || normalizeNameValue(fallbackTableProductName(lines))
    || normalizeNameValue(fallbackLooseProductName(lines, company));
  const genericName =
    normalizeNameValue(
      extractByLabels(lines, LABELS.name, [
        '客户号码',
        '身故受益人',
        '第一顺位',
        '第二顺位',
        ...LABELS.applicant,
        ...LABELS.insured,
        ...LABELS.date,
        ...LABELS.paymentPeriod,
        ...LABELS.coveragePeriod,
        ...LABELS.amount,
        ...LABELS.firstPremium,
      ])
    )
    || normalizeNameValue(fallbackProductName(lines, company));
  const name =
    (isReceiptStyle ? mainPlan?.name || '' : '')
    || inlineLabeledData.name
    ||
    compressedHorizontalTableData.name
    ||
    inlineHorizontalTableData.name
    ||
    horizontalTableData.name
    || loosePolicyRowData.name
    || (isTableStyle ? mainPlan?.name || tableName : '')
    || primaryPlanRowData.name
    || sequentialTableData.name
    || genericName
    || matchedFields.name
    || tableName;
  const applicant = inlineLabeledData.applicant || normalizePersonNameValue(extractByLabels(lines, LABELS.applicant, LABELS.insured));
  const beneficiary = extractBeneficiaryFromLines(lines);
  const insured =
    inlineLabeledData.insured
    ||
    compressedHorizontalTableData.insured
    ||
    inlineHorizontalTableData.insured
    ||
    horizontalTableData.insured
    || loosePolicyRowData.insured
    || normalizePersonNameValue(
      extractByLabels(lines, LABELS.insured, [
        '客户号码',
        '保险险种',
        ...LABELS.date,
        ...LABELS.paymentPeriod,
        ...LABELS.coveragePeriod,
        ...LABELS.amount,
      ])
    );
  const insuredIdentity = isReceiptStyle ? { insuredIdNumber: '', insuredBirthday: '' } : extractInsuredIdentity(lines, insured);
  const date = extractPreferredDate(lines) || inlineLabeledData.date;
  const mappedPaymentPeriod = combineMappedPaymentPeriod(matchedFields);
  const mainPlanPaymentPeriod = isTableStyle ? mainPlan?.paymentPeriod || '' : '';
  const mainPlanCoveragePeriod = isTableStyle ? mainPlan?.coveragePeriod || '' : '';
  const mainPlanAmount = isTableStyle ? mainPlan?.amount || '' : '';
  const rawPaymentPeriod =
    mainPlanPaymentPeriod
    ||
    inlineLabeledData.paymentPeriod
    ||
    compressedHorizontalTableData.paymentPeriod
    ||
    inlineHorizontalTableData.paymentPeriod
    ||
    horizontalTableData.paymentPeriod
    || loosePolicyRowData.paymentPeriod
    ||
    mappedPaymentPeriod
    || primaryPlanRowData.paymentPeriod
    || sequentialTableData.paymentPeriod
    || normalizePaymentPeriodValue(extractByLabels(lines, LABELS.paymentPeriod, LABELS.coveragePeriod))
    || fallbackPaymentPeriod(lines);
  const paymentPeriod = canonicalPaymentPeriodValue(rawPaymentPeriod) || rawPaymentPeriod;
  const coveragePeriod =
    mainPlanCoveragePeriod
    ||
    inlineLabeledData.coveragePeriod
    ||
    compressedHorizontalTableData.coveragePeriod
    ||
    inlineHorizontalTableData.coveragePeriod
    ||
    horizontalTableData.coveragePeriod
    || loosePolicyRowData.coveragePeriod
    || primaryPlanRowData.coveragePeriod
    || sequentialTableData.coveragePeriod
    || normalizeCoveragePeriodValue(extractByLabels(lines, LABELS.coveragePeriod, LABELS.amount))
    || matchedFields.coveragePeriod
    || normalizeCoveragePeriodValue(fallbackCoveragePeriod(lines));
  const amount = isReceiptStyle
    ? ''
    : mainPlanAmount
      ||
      inlineLabeledData.amount
      ||
      compressedHorizontalTableData.amount
      ||
      inlineHorizontalTableData.amount
      ||
      horizontalTableData.amount
      || loosePolicyRowData.amount
      || primaryPlanRowData.amount
      || sequentialTableData.amount
      || normalizeAmountValue(extractByLabels(lines, LABELS.amount, LABELS.firstPremium))
      || matchedFields.amount
      || fallbackAmount(lines);
  const firstPremium =
    inlineLabeledData.firstPremium
    ||
    compressedHorizontalTableData.firstPremium
    ||
    inlineHorizontalTableData.firstPremium
    ||
    horizontalTableData.firstPremium
    || loosePolicyRowData.firstPremium
    ||
    (isTableStyle ? fallbackFirstPremium(lines) : '')
    || primaryPlanRowData.firstPremium
    || sequentialTableData.firstPremium
    || normalizeAmountValue(extractByLabels(lines, LABELS.firstPremium))
    || matchedFields.firstPremium
    || fallbackFirstPremium(lines);
  const planPremiumTotal = sumPlanPremiumsForFields(plans);

  return {
    company,
    name,
    applicant,
    beneficiary,
    insured,
    insuredIdNumber: insuredIdentity.insuredIdNumber,
    insuredBirthday: insuredIdentity.insuredBirthday,
    date,
    paymentPeriod,
    coveragePeriod,
    amount,
    firstPremium: fallbackFirstPremium(lines) || planPremiumTotal || firstPremium,
    ...(plans.length ? { plans } : {}),
  };
}

function inferFileExtension(name, mimeType) {
  const fileName = String(name || '').trim().toLowerCase();
  const mime = String(mimeType || '').trim().toLowerCase();
  if (fileName.endsWith('.png') || mime === 'image/png') return '.png';
  if (fileName.endsWith('.jpg') || fileName.endsWith('.jpeg') || mime === 'image/jpeg') return '.jpg';
  if (fileName.endsWith('.heic') || mime === 'image/heic' || mime === 'image/heif') return '.heic';
  if (fileName.endsWith('.webp') || mime === 'image/webp') return '.webp';
  return '.jpg';
}

function isPdfUpload(uploadItem) {
  const name = String(uploadItem?.name || '').trim().toLowerCase();
  const type = String(uploadItem?.type || '').trim().toLowerCase();
  const dataUrl = String(uploadItem?.dataUrl || '').trim().toLowerCase();
  return name.endsWith('.pdf') || type === 'application/pdf' || dataUrl.startsWith('data:application/pdf;');
}

function parseDataUrl(uploadItem) {
  const dataUrl = String(uploadItem?.dataUrl || '').trim();
  const type = String(uploadItem?.type || '').trim().toLowerCase();
  if (!dataUrl.startsWith('data:')) throw new Error('INVALID_DATA_URL');
  const matched = dataUrl.match(/^data:([^;,]+)?(?:;[^,]*)?;base64,(.+)$/);
  if (!matched?.[2]) throw new Error('INVALID_DATA_URL');
  const mimeType = String(matched[1] || type || '').trim().toLowerCase();
  if (!mimeType.startsWith('image/')) throw new Error('POLICY_SCAN_TYPE_UNSUPPORTED');
  const buffer = Buffer.from(matched[2], 'base64');
  if (!buffer.length) throw new Error('INVALID_DATA_URL');
  if (buffer.length > DEFAULT_MAX_SCAN_BYTES) throw new Error('FILE_TOO_LARGE');
  return { mimeType, buffer };
}

function isImageUpload(uploadItem) {
  const type = String(uploadItem?.type || '').trim().toLowerCase();
  const dataUrl = String(uploadItem?.dataUrl || '').trim().toLowerCase();
  return type.startsWith('image/') || dataUrl.startsWith('data:image/');
}

function parsePdfDataUrl(uploadItem) {
  const dataUrl = String(uploadItem?.dataUrl || '').trim();
  const type = String(uploadItem?.type || '').trim().toLowerCase();
  if (!dataUrl.startsWith('data:')) throw new Error('INVALID_DATA_URL');
  const matched = dataUrl.match(/^data:([^;,]+)?(?:;[^,]*)?;base64,(.+)$/);
  if (!matched?.[2]) throw new Error('INVALID_DATA_URL');
  const mimeType = String(matched[1] || type || '').trim().toLowerCase();
  if (mimeType !== 'application/pdf' && !String(uploadItem?.name || '').toLowerCase().endsWith('.pdf')) {
    throw new Error('POLICY_SCAN_TYPE_UNSUPPORTED');
  }
  const buffer = Buffer.from(matched[2], 'base64');
  if (!buffer.length) throw new Error('INVALID_DATA_URL');
  if (buffer.length > DEFAULT_MAX_SCAN_BYTES) throw new Error('FILE_TOO_LARGE');
  return { buffer };
}

async function extractTextFromPdfUpload(uploadItem) {
  const { buffer } = parsePdfDataUrl(uploadItem);
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loadingTask = getDocument({
    data: new Uint8Array(buffer),
    disableWorker: true,
    useSystemFonts: true,
  });
  const doc = await loadingTask.promise;
  const chunks = [];
  try {
    const maxPages = Math.min(Number(doc.numPages || 0), 30);
    for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => String(item?.str || '').trim())
        .filter(Boolean)
        .join(' ');
      if (text) chunks.push(text);
      page.cleanup();
    }
  } finally {
    await doc.destroy();
  }
  const text = normalizeOcrText(chunks.join('\n'));
  if (!text) throw new Error('POLICY_PDF_TEXT_EMPTY');
  return text;
}

function getConfiguredOcrProvider() {
  return resolveEffectivePolicyOcrProvider();
}

function getConfiguredOcrPostprocessor() {
  const value = String(process.env.POLICY_OCR_POSTPROCESSOR || OCR_POSTPROCESSOR_NONE)
    .trim()
    .toLowerCase();
  return value || OCR_POSTPROCESSOR_NONE;
}

function getConfiguredOllamaBaseUrl() {
  return String(process.env.POLICY_OCR_OLLAMA_BASE_URL || 'http://127.0.0.1:11434').trim().replace(/\/+$/, '');
}

function getConfiguredOllamaModel() {
  return String(process.env.POLICY_OCR_OLLAMA_MODEL || 'qwen2.5:0.5b').trim();
}

function getConfiguredMlxPython() {
  return String(process.env.POLICY_OCR_MLX_PYTHON || 'python3').trim() || 'python3';
}

function getConfiguredMlxModel() {
  return String(process.env.POLICY_OCR_MLX_MODEL || 'mlx-community/Qwen2.5-VL-3B-Instruct-4bit').trim();
}

function getConfiguredMlxTimeoutMs() {
  const value = Number(process.env.POLICY_OCR_MLX_TIMEOUT_MS || 180000);
  return Number.isFinite(value) && value > 1000 ? value : 180000;
}

export function getConfiguredMlxMaxImageDimension() {
  const value = Number(process.env.POLICY_OCR_MLX_MAX_IMAGE_DIMENSION || DEFAULT_MLX_MAX_IMAGE_DIMENSION);
  return Number.isFinite(value) && value >= 1024 ? Math.trunc(value) : DEFAULT_MLX_MAX_IMAGE_DIMENSION;
}

async function prepareImageForMlxInference(absPath, tmpDir) {
  const maxDimension = getConfiguredMlxMaxImageDimension();
  if (!maxDimension || maxDimension <= 0) return absPath;

  const resizedPath = path.join(tmpDir, `scan-mlx-resized${path.extname(absPath) || '.jpg'}`);
  try {
    await execFileAsync(
      'sips',
      ['-Z', String(maxDimension), absPath, '--out', resizedPath],
      {
        timeout: 15000,
        maxBuffer: 2 * 1024 * 1024,
        env: {
          ...process.env,
          LC_ALL: process.env.LC_ALL || 'en_US.UTF-8',
        },
      },
    );
    return existsSync(resizedPath) ? resizedPath : absPath;
  } catch {
    return absPath;
  }
}

function getConfiguredOllamaVisionModel() {
  return String(process.env.POLICY_OCR_OLLAMA_VISION_MODEL || 'qwen2.5vl:3b').trim();
}

function getConfiguredOllamaVisionNumCtx() {
  const value = Number(process.env.POLICY_OCR_OLLAMA_VISION_NUM_CTX || 512);
  return Number.isFinite(value) && value >= 128 ? Math.trunc(value) : 512;
}

function getConfiguredOllamaTimeoutMs() {
  const value = Number(process.env.POLICY_OCR_OLLAMA_TIMEOUT_MS || 45000);
  return Number.isFinite(value) && value > 1000 ? value : 45000;
}

function envFlag(env, key, defaultValue = false) {
  const raw = env?.[key];
  if (raw == null) return defaultValue;
  return !['0', 'false', 'no', 'off', ''].includes(String(raw).trim().toLowerCase());
}

function shouldUseLocalVisionFallback(env = process.env) {
  return envFlag(env, 'POLICY_OCR_LOCAL_VISION_FALLBACK', false);
}

function extractJsonObjectBlock(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const fenceMatched = raw.match(/```json\s*([\s\S]+?)```/i) || raw.match(/```\s*([\s\S]+?)```/i);
  const candidate = fenceMatched?.[1] || raw;
  const firstBrace = candidate.indexOf('{');
  const lastBrace = candidate.lastIndexOf('}');
  if (firstBrace < 0 || lastBrace < 0 || lastBrace <= firstBrace) return null;
  return candidate.slice(firstBrace, lastBrace + 1);
}

function escapeJsonControlCharsInStrings(text) {
  let result = '';
  let inString = false;
  let escaped = false;

  for (const char of String(text || '')) {
    if (escaped) {
      result += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      result += char;
      escaped = true;
      continue;
    }
    if (char === '"') {
      result += char;
      inString = !inString;
      continue;
    }
    if (inString) {
      if (char === '\n') {
        result += '\\n';
        continue;
      }
      if (char === '\r') {
        result += '\\r';
        continue;
      }
      if (char === '\t') {
        result += '\\t';
        continue;
      }
      if (char === '\b') {
        result += '\\b';
        continue;
      }
      if (char === '\f') {
        result += '\\f';
        continue;
      }
    }
    result += char;
  }

  return result;
}

export function parseVisionJsonObjectBlock(text) {
  const jsonBlock = extractJsonObjectBlock(text);
  if (!jsonBlock) return null;
  try {
    return JSON.parse(jsonBlock);
  } catch {
    return JSON.parse(escapeJsonControlCharsInStrings(jsonBlock));
  }
}

async function postprocessPolicyFieldsWithOllama(ocrText, baseData, fetchImpl = fetch) {
  const normalizedText = normalizeOcrText(ocrText);
  if (!normalizedText) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), getConfiguredOllamaTimeoutMs());
  try {
    const response = await fetchImpl(`${getConfiguredOllamaBaseUrl()}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: getConfiguredOllamaModel(),
        stream: false,
        options: { temperature: 0 },
        messages: [
          {
            role: 'system',
            content:
              '你是保险保单OCR纠错助手。只能根据OCR原文提取字段，不能臆造。只输出JSON，不要解释。若字段不确定就返回空字符串。',
          },
          {
            role: 'user',
            content: [
              '请从下面的保单OCR文本中提取字段，并输出 JSON：',
              '{"company":"","name":"","applicant":"","beneficiary":"","insured":"","insuredIdNumber":"","insuredBirthday":"","date":"","paymentPeriod":"","coveragePeriod":"","amount":"","firstPremium":"","plans":[]}',
              '要求：',
              '1. 保险公司优先识别页眉保司全称或英文品牌，例如 PING AN -> 中国平安保险。',
              '2. 如果出现横向表头和下一行数据，要按表头对应值抽取。',
              '3. date 使用 YYYY-MM-DD。',
              '4. paymentPeriod 用如 25年交、10年交、趸交。',
              '5. amount 和 firstPremium 只保留数字，不要逗号和单位。',
              '6. 如果被保险人身份证/证件号码清晰可见，insuredIdNumber 输出该号码，insuredBirthday 从身份证出生日期推导为 YYYY-MM-DD；不要输出投保人的证件号码。',
              '7. beneficiary 提取身故保险金受益人；如果表头下方写“被保险人的法定继承人”或“法定继承人”，beneficiary 输出“法定”。',
              '8. 不要把 保单号/客户号码/联系电话/证件号码 当作保额或保费。',
              '9. 如果有“保险利益表/险种名称”表格，plans 必须输出每一条险种，格式为 {"role":"","name":"","amount":"","coveragePeriod":"","paymentMode":"","paymentPeriod":"","premium":"","productType":""}。',
              '10. plans 第一条有效主险 role 用 main；名称含“万能型/万能账户/最低保证利率/账户价值”的账户类险种 role 用 linked_account；其他附加险 role 用 rider。',
              '11. 扁平字段 name/paymentPeriod/coveragePeriod/amount 以 main 行为准；firstPremium 优先取“首期保险费合计”，没有合计时取 plans 保费合计。',
              '',
              '当前规则解析结果（仅供参考，错了可以纠正）：',
              JSON.stringify(baseData || {}, null, 2),
              '',
              'OCR原文：',
              normalizedText,
            ].join('\n'),
          },
        ],
      }),
    });

    if (!response.ok) throw new Error('POLICY_OCR_POSTPROCESSOR_FAILED');
    const payload = await response.json().catch(() => null);
    const content = String(payload?.message?.content || payload?.response || '').trim();
    const parsed = parseVisionJsonObjectBlock(content);
    if (!parsed) return null;
    const normalized = normalizeExtractedPolicyFields(parsed);
    return Object.values(normalized).some(Boolean) ? normalized : null;
  } catch (error) {
    const message = String(error?.message || error || '');
    if (message.includes('AbortError')) {
      throw new Error('POLICY_OCR_POSTPROCESSOR_TIMEOUT');
    }
    throw new Error('POLICY_OCR_POSTPROCESSOR_FAILED');
  } finally {
    clearTimeout(timer);
  }
}

export async function extractPolicyFieldsFromImageWithOllamaVision(uploadItem, fetchImpl = fetch) {
  if (!uploadItem) throw new Error('POLICY_SCAN_INPUT_REQUIRED');
  const { buffer } = parseDataUrl(uploadItem);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), getConfiguredOllamaTimeoutMs());
  try {
    const response = await fetchImpl(`${getConfiguredOllamaBaseUrl()}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: getConfiguredOllamaVisionModel(),
        stream: false,
        options: { temperature: 0, num_ctx: getConfiguredOllamaVisionNumCtx() },
        messages: [
          {
            role: 'system',
            content:
              '你是保险保单视觉识别助手。只能根据图片提取字段，不能臆造。只输出JSON，不要解释。若字段不确定就返回空字符串。',
          },
          {
            role: 'user',
            content: [
              '请直接阅读这张保单图片，并输出 JSON：',
              '{"company":"","name":"","applicant":"","beneficiary":"","insured":"","insuredIdNumber":"","insuredBirthday":"","date":"","paymentPeriod":"","coveragePeriod":"","amount":"","firstPremium":"","plans":[]}',
              '要求：',
              '1. 保险公司优先识别页眉保司名称或英文品牌，例如 PING AN -> 中国平安保险。',
              '2. 表格里上面是标题、下面或右侧是对应值时，必须按标题和值一一匹配。',
              '3. date 使用 YYYY-MM-DD。',
              '4. paymentPeriod 用如 25年交、10年交、趸交。',
              '5. amount 和 firstPremium 只保留数字，不要逗号和单位。',
              '6. 如果被保险人身份证/证件号码清晰可见，insuredIdNumber 输出该号码，insuredBirthday 从身份证出生日期推导为 YYYY-MM-DD；不要输出投保人的证件号码。',
              '7. beneficiary 提取身故保险金受益人；如果表头下方写“被保险人的法定继承人”或“法定继承人”，beneficiary 输出“法定”。',
              '8. 不要把 保单号/客户号码/联系电话/证件号码 当作保额或保费。',
              '9. 如果图片里有“保险利益表/险种名称”表格，plans 必须输出每一条险种，格式为 {"role":"","name":"","amount":"","coveragePeriod":"","paymentMode":"","paymentPeriod":"","premium":"","productType":""}。',
              '10. plans 第一条有效主险 role 用 main；名称含“万能型/万能账户/最低保证利率/账户价值”的账户类险种 role 用 linked_account；其他附加险 role 用 rider。',
              '11. 扁平字段 name/paymentPeriod/coveragePeriod/amount 以 main 行为准；firstPremium 优先取“首期保险费合计”，没有合计时取 plans 保费合计。',
            ].join('\n'),
            images: [buffer.toString('base64')],
          },
        ],
      }),
    });

    if (!response.ok) throw new Error('POLICY_OCR_VISION_FAILED');
    const payload = await response.json().catch(() => null);
    const content = String(payload?.message?.content || payload?.response || '').trim();
    const parsed = parseVisionJsonObjectBlock(content);
    if (!parsed) return null;
    const normalized = normalizeExtractedPolicyFields(parsed);
    return Object.values(normalized).some(Boolean) ? normalized : null;
  } catch (error) {
    const message = String(error?.message || error || '');
    if (message.includes('AbortError')) {
      throw new Error('POLICY_OCR_VISION_TIMEOUT');
    }
    throw new Error('POLICY_OCR_VISION_FAILED');
  } finally {
    clearTimeout(timer);
  }
}

function countMissingPlanFields(plan = {}) {
  return ['amount', 'coveragePeriod', 'paymentPeriod', 'premium'].reduce((count, key) => count + (plan?.[key] ? 0 : 1), 0);
}

function plansPremiumTotal(plans = []) {
  const premiums = (Array.isArray(plans) ? plans : [])
    .map((plan) => Number(plan?.premium || ''))
    .filter((amount) => Number.isFinite(amount) && amount > 0);
  if (!premiums.length) return 0;
  return premiums.reduce((sum, amount) => sum + amount, 0);
}

export function needsLocalVisionFallback(data = {}, ocrText = '') {
  const text = normalizeOcrText(ocrText);
  const plans = Array.isArray(data?.plans) ? data.plans : [];
  const mentionsBenefitTable = /保险利益表|险种名称|保险险种|基本保险金额\/保险金额/u.test(text);
  if (!mentionsBenefitTable) return false;

  const hasMainFieldProblem = !data?.name || !data?.amount || !data?.coveragePeriod || !data?.paymentPeriod || !data?.firstPremium;
  if (hasMainFieldProblem) return true;
  if (plans.length < 2 && /附加|万能型|万能账户|一次交清|趸交|特定疾病|鑫天利/u.test(text)) return true;
  if (plans.some((plan) => countMissingPlanFields(plan) >= 2)) return true;
  if (String(data?.paymentPeriod || '') === '趸交' && plans.some((plan) => String(plan?.paymentPeriod || '').match(/\d+年交/u))) return true;

  const totalPremium = Number(data?.firstPremium || 0);
  const planPremiumTotal = plansPremiumTotal(plans);
  if (totalPremium > 0 && planPremiumTotal > 0 && Math.abs(totalPremium - planPremiumTotal) > 1) return true;

  return false;
}

export async function maybeEnhancePolicyScanWithLocalVision(scan, visionExtractor = extractPolicyFieldsFromImageWithMlxVlm, env = process.env) {
  if (!scan?.uploadItem || isPdfUpload(scan.uploadItem) || !isImageUpload(scan.uploadItem)) return scan;
  if (!shouldUseLocalVisionFallback(env)) return scan;
  if (!needsLocalVisionFallback(scan.data, scan.ocrText)) return scan;

  try {
    const visionResult = await visionExtractor(scan.uploadItem, scan.data || {}, scan.ocrText || '');
    if (!visionResult?.data) return scan;
    const normalizedVisionData = normalizeExtractedPolicyFields(visionResult.data);
    const merged = mergePolicyDataCandidates([scan.data || {}, normalizedVisionData]);
    if (scorePolicyData(merged) >= scorePolicyData(scan.data || {})) {
      return {
        ...scan,
        data: merged,
        ocrText: scan.ocrText || normalizeOcrText(visionResult.ocrText || ''),
      };
    }
  } catch {
    // Local VLM fallback is opportunistic; keep the deterministic OCR result if unavailable.
  }
  return scan;
}

export async function extractPolicyFieldsFromImageWithMlxVlm(uploadItem) {
  if (!uploadItem) throw new Error('POLICY_SCAN_INPUT_REQUIRED');
  const { mimeType, buffer } = parseDataUrl(uploadItem);
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'policy-ocr-mlx-'));
  const absPath = path.join(tmpDir, `scan${inferFileExtension(uploadItem?.name, mimeType)}`);
  const prompt = [
    '你是保险保单视觉识别助手。只能根据图片提取字段，不能臆造。只输出 JSON，不要解释。',
    '请输出 JSON：',
    '{"company":"","name":"","applicant":"","insured":"","insuredIdNumber":"","insuredBirthday":"","date":"","paymentPeriod":"","coveragePeriod":"","amount":"","firstPremium":"","plans":[],"ocrText":""}',
    '要求：',
    '1. 保险公司优先识别页眉保司名称或英文品牌，例如 PING AN -> 中国平安保险。',
    '2. 表格里上面是标题、下面或右侧是对应值时，必须按标题和值一一匹配。',
    '3. date 使用 YYYY-MM-DD。',
    '4. paymentPeriod 用如 25年交、10年交、趸交。',
    '5. amount 和 firstPremium 只保留数字，不要逗号和单位。',
    '6. 如果被保险人身份证/证件号码清晰可见，insuredIdNumber 输出该号码，insuredBirthday 从身份证出生日期推导为 YYYY-MM-DD；不要输出投保人的证件号码。',
    '7. 不要把 保单号/客户号码/联系电话/证件号码 当作保额或保费。',
    '8. 如果图片里有“保险利益表/险种名称”表格，plans 必须输出每一条险种，格式为 {"role":"","name":"","amount":"","coveragePeriod":"","paymentMode":"","paymentPeriod":"","premium":"","productType":""}。',
    '9. plans 第一条有效主险 role 用 main；名称含“万能型/万能账户/最低保证利率/账户价值”的账户类险种 role 用 linked_account；其他附加险 role 用 rider。',
    '10. 扁平字段 name/paymentPeriod/coveragePeriod/amount 以 main 行为准；firstPremium 优先取“首期保险费合计”，没有合计时取 plans 保费合计。',
    '11. ocrText 输出尽量忠实的保单可读文本，按行拼接；如果拿不准可以留空。',
  ].join('\n');

  try {
    await writeFile(absPath, buffer);
    const inferenceImagePath = await prepareImageForMlxInference(absPath, tmpDir);
    const { stdout } = await execFileAsync(
      getConfiguredMlxPython(),
      [
        '-m',
        'mlx_vlm',
        'generate',
        '--model',
        getConfiguredMlxModel(),
        '--max-tokens',
        '640',
        '--temperature',
        '0.0',
        '--image',
        inferenceImagePath,
        '--prompt',
        prompt,
      ],
      {
        timeout: getConfiguredMlxTimeoutMs(),
        maxBuffer: 16 * 1024 * 1024,
        env: {
          ...process.env,
          PYTHONIOENCODING: 'utf-8',
        },
      },
    );
    const parsed = parseVisionJsonObjectBlock(stdout);
    if (!parsed) throw new Error('POLICY_OCR_FAILED');
    const normalized = normalizeExtractedPolicyFields(parsed);
    if (!Object.values(normalized).some(Boolean)) throw new Error('POLICY_OCR_EMPTY');
    return {
      data: normalized,
      ocrText: normalizeOcrText(parsed?.ocrText || parsed?.text || ''),
    };
  } catch (error) {
    const message = [
      String(error?.message || error || ''),
      String(error?.stdout || ''),
      String(error?.stderr || ''),
    ]
      .join('\n')
      .trim();
    if (
      /ModuleNotFoundError|No module named ['"]?mlx_vlm|can't open file|No such file or directory|command not found|mlx_vlm/i.test(
        message,
      )
    ) {
      throw new Error('POLICY_OCR_PROVIDER_NOT_READY');
    }
    if (/timed out|ETIMEDOUT|SIGTERM|killed/i.test(message)) {
      throw new Error('POLICY_OCR_UPSTREAM_TIMEOUT');
    }
    if (message.includes('POLICY_OCR_EMPTY')) throw new Error('POLICY_OCR_EMPTY');
    throw new Error('POLICY_OCR_FAILED');
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function extractBaiduPrivateOcrText(payload) {
  const candidateArrays = [
    payload?.words_result,
    payload?.data?.words_result,
    payload?.result?.words_result,
    payload?.ret,
    payload?.data?.ret,
    payload?.results,
  ];

  for (const candidate of candidateArrays) {
    if (!Array.isArray(candidate)) continue;
    const joined = candidate
      .map((item) => cleanupFieldValue(item?.words || item?.word || item?.text || item?.content || item?.value || ''))
      .filter(Boolean)
      .join('\n');
    const normalized = normalizeOcrText(joined);
    if (normalized) return normalized;
  }

  const directText = normalizeOcrText(payload?.text || payload?.data?.text || payload?.result?.text || '');
  return directText;
}

export function extractPaddleOcrText(payload) {
  const lineArrays = [
    payload?.lines,
    payload?.data?.lines,
    payload?.result?.lines,
    ...(Array.isArray(payload?.result) ? payload.result.map((item) => item?.res?.rec_texts || item?.rec_texts) : []),
  ];

  for (const candidate of lineArrays) {
    if (!Array.isArray(candidate)) continue;
    const joined = candidate
      .map((item) => cleanupFieldValue(item?.words || item?.word || item?.text || item?.content || item?.value || item || ''))
      .filter(Boolean)
      .join('\n');
    const normalized = normalizeOcrText(joined);
    if (normalized) return normalized;
  }

  return normalizeOcrText(payload?.ocrText || payload?.text || payload?.data?.ocrText || payload?.result?.ocrText || '');
}

function buildBaiduPrivateRequest(uploadItem) {
  const { buffer } = parseDataUrl(uploadItem);
  const rawUrl = String(process.env.POLICY_OCR_BAIDU_PRIVATE_URL || '').trim();
  if (!rawUrl) throw new Error('POLICY_OCR_PROVIDER_NOT_CONFIGURED');

  const requestUrl = new URL(rawUrl);
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  const token = String(process.env.POLICY_OCR_BAIDU_PRIVATE_ACCESS_TOKEN || '').trim();
  const authMode = String(process.env.POLICY_OCR_BAIDU_PRIVATE_AUTH_MODE || (token ? 'query' : 'none'))
    .trim()
    .toLowerCase();
  const authHeader = String(process.env.POLICY_OCR_BAIDU_PRIVATE_AUTH_HEADER || 'X-Auth-Token').trim() || 'X-Auth-Token';

  if (token) {
    if (authMode === 'query') {
      requestUrl.searchParams.set('access_token', token);
    } else if (authMode === 'bearer') {
      headers.Authorization = `Bearer ${token}`;
    } else if (authMode === 'header') {
      headers[authHeader] = token;
    }
  }

  const body = new URLSearchParams();
  body.set('image', buffer.toString('base64'));
  body.set('detect_direction', 'true');
  body.set('probability', 'true');
  return {
    url: requestUrl.toString(),
    headers,
    body,
  };
}

async function recognizeTextWithVision(uploadItem) {
  assertOcrScriptExists(OCR_SWIFT_SCRIPT);
  const { mimeType, buffer } = parseDataUrl(uploadItem);
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'policy-ocr-'));
  const absPath = path.join(tmpDir, `scan${inferFileExtension(uploadItem?.name, mimeType)}`);
  try {
    await writeFile(absPath, buffer);
    const { stdout } = await execFileAsync('swift', [OCR_SWIFT_SCRIPT, absPath], {
      timeout: 15000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return normalizeOcrText(stdout);
  } catch (err) {
    const message = String(err?.message || err || '');
    if (message.includes('POLICY_OCR_EMPTY')) throw new Error('POLICY_OCR_EMPTY');
    if (message.includes('POLICY_OCR_PROVIDER_NOT_READY')) throw new Error('POLICY_OCR_PROVIDER_NOT_READY');
    throw new Error('POLICY_OCR_FAILED');
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function getConfiguredPaddlePython() {
  const explicitPython = String(process.env.POLICY_OCR_PADDLE_PYTHON || '').trim();
  if (explicitPython) return explicitPython;
  if (existsSync(LOCAL_PADDLE_VENV_PYTHON)) return LOCAL_PADDLE_VENV_PYTHON;
  return 'python3';
}

function getConfiguredPaddlePipeline(provider = getConfiguredOcrProvider()) {
  const explicit = String(process.env.POLICY_OCR_PADDLE_PIPELINE || '')
    .trim()
    .toLowerCase();
  if (explicit === 'ocr' || explicit === 'vl') return explicit;
  return provider === OCR_PROVIDER_PADDLEOCR_VL_LOCAL ? 'vl' : 'ocr';
}

async function warmupPaddleLocalIfNeeded() {
  const provider = getConfiguredOcrProvider();
  if (provider !== OCR_PROVIDER_PADDLE_LOCAL && provider !== OCR_PROVIDER_PADDLEOCR_VL_LOCAL) return;
  if (paddleWarmupPromise) return paddleWarmupPromise;
  assertOcrScriptExists(OCR_PADDLE_SCRIPT);

  const env = { ...process.env };
  const projectDir = String(env.POLICY_OCR_PADDLE_PROJECT_DIR || '').trim();
  const pythonCmd = getConfiguredPaddlePython();
  env.POLICY_OCR_PADDLE_PIPELINE = getConfiguredPaddlePipeline(provider);

  paddleWarmupPromise = execFileAsync(pythonCmd, [OCR_PADDLE_SCRIPT, '--warmup'], {
    env,
    cwd: projectDir || undefined,
    timeout: 60000,
    maxBuffer: 10 * 1024 * 1024,
  })
    .catch(() => undefined)
    .finally(() => {
      paddleWarmupPromise = Promise.resolve();
    });

  return paddleWarmupPromise;
}

async function recognizePaddlePolicyUpload(uploadItem) {
  const provider = getConfiguredOcrProvider();
  await warmupPaddleLocalIfNeeded();
  assertOcrScriptExists(OCR_PADDLE_SCRIPT);
  const { mimeType, buffer } = parseDataUrl(uploadItem);
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'policy-ocr-paddle-'));
  const absPath = path.join(tmpDir, `scan${inferFileExtension(uploadItem?.name, mimeType)}`);
  try {
    await writeFile(absPath, buffer);
    const env = { ...process.env };
    const projectDir = String(env.POLICY_OCR_PADDLE_PROJECT_DIR || '').trim();
    const pythonCmd = getConfiguredPaddlePython();
    env.POLICY_OCR_PADDLE_PIPELINE = getConfiguredPaddlePipeline(provider);
    const { stdout } = await execFileAsync(pythonCmd, [OCR_PADDLE_SCRIPT, absPath], {
      env,
      cwd: projectDir || undefined,
      timeout: 60000,
      maxBuffer: 20 * 1024 * 1024,
    });
    let payload = null;
    try {
      payload = JSON.parse(stdout);
    } catch {
      throw new Error('POLICY_OCR_FAILED');
    }
    const recognized = extractPaddleOcrText(payload);
    if (!recognized) throw new Error('POLICY_OCR_EMPTY');
    return {
      ocrText: recognized,
      boxes: Array.isArray(payload?.boxes) ? payload.boxes : [],
      rawPayload: payload,
    };
  } catch (err) {
    const message = String(err?.stderr || err?.message || err || '');
    if (message.includes('POLICY_OCR_EMPTY')) throw new Error('POLICY_OCR_EMPTY');
    if (message.includes('POLICY_OCR_PADDLE_IMPORT_FAILED') || message.includes('POLICY_OCR_PROVIDER_NOT_READY')) {
      throw new Error('POLICY_OCR_PROVIDER_NOT_READY');
    }
    throw new Error('POLICY_OCR_FAILED');
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function recognizeTextWithPaddleLocal(uploadItem) {
  const result = await recognizePaddlePolicyUpload(uploadItem);
  return result.ocrText;
}

let pdfExtractKitWarmupPromise = null;

function getConfiguredPdfExtractKitPython() {
  const explicit = String(process.env.POLICY_OCR_PDF_EXTRACT_KIT_PYTHON || '').trim();
  if (explicit) return explicit;
  if (existsSync(LOCAL_PADDLE_VENV_PYTHON)) return LOCAL_PADDLE_VENV_PYTHON;
  return 'python3';
}

function getConfiguredPdfExtractKitBackend() {
  const explicit = String(process.env.POLICY_OCR_PDF_EXTRACT_KIT_BACKEND || '').trim().toLowerCase();
  if (explicit === 'pipeline' || explicit === 'vlm') return explicit;
  return 'pipeline';
}

async function warmupPdfExtractKitIfNeeded() {
  const provider = getConfiguredOcrProvider();
  if (provider !== OCR_PROVIDER_PDF_EXTRACT_KIT_LOCAL) return;
  if (pdfExtractKitWarmupPromise) return pdfExtractKitWarmupPromise;
  assertOcrScriptExists(OCR_PDF_EXTRACT_KIT_SCRIPT);
  const env = { ...process.env };
  env.POLICY_OCR_PDF_EXTRACT_KIT_BACKEND = getConfiguredPdfExtractKitBackend();
  const pythonCmd = getConfiguredPdfExtractKitPython();
  pdfExtractKitWarmupPromise = execFileAsync(pythonCmd, [OCR_PDF_EXTRACT_KIT_SCRIPT, '--warmup'], {
    env,
    timeout: 300000,
    maxBuffer: 10 * 1024 * 1024,
  })
    .catch(() => undefined)
    .finally(() => {
      pdfExtractKitWarmupPromise = Promise.resolve();
    });
  return pdfExtractKitWarmupPromise;
}

async function recognizeTextWithPdfExtractKit(uploadItem) {
  await warmupPdfExtractKitIfNeeded();
  assertOcrScriptExists(OCR_PDF_EXTRACT_KIT_SCRIPT);
  const { mimeType, buffer } = parseDataUrl(uploadItem);
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'policy-ocr-pdf-extract-kit-'));
  const ext = inferFileExtension(uploadItem?.name, mimeType);
  const absPath = path.join(tmpDir, `scan${ext}`);
  try {
    await writeFile(absPath, buffer);
    const env = { ...process.env };
    env.POLICY_OCR_PDF_EXTRACT_KIT_BACKEND = getConfiguredPdfExtractKitBackend();
    const pythonCmd = getConfiguredPdfExtractKitPython();
    const { stdout } = await execFileAsync(pythonCmd, [OCR_PDF_EXTRACT_KIT_SCRIPT, absPath], {
      env,
      timeout: 600000,
      maxBuffer: 50 * 1024 * 1024,
    });
    let payload = null;
    try {
      payload = JSON.parse(stdout);
    } catch {
      throw new Error('POLICY_OCR_FAILED');
    }
    if (!payload?.ok) {
      throw new Error('POLICY_OCR_FAILED');
    }
    const recognized = normalizeOcrText(payload.ocrText || '');
    if (!recognized) throw new Error('POLICY_OCR_EMPTY');
    return recognized;
  } catch (err) {
    const message = String(err?.stderr || err?.message || err || '');
    if (message.includes('POLICY_OCR_EMPTY')) throw new Error('POLICY_OCR_EMPTY');
    if (message.includes('POLICY_OCR_PDF_EXTRACT_KIT_IMPORT_FAILED') || message.includes('POLICY_OCR_PROVIDER_NOT_READY')) {
      throw new Error('POLICY_OCR_PROVIDER_NOT_READY');
    }
    throw new Error('POLICY_OCR_FAILED');
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function shouldFallbackToPaddleForImages(env = process.env) {
  return String(env.POLICY_OCR_FALLBACK_PADDLE || 'true').trim().toLowerCase() !== 'false';
}

async function recognizeTextWithImageFallback(uploadItem) {
  const provider = getConfiguredOcrProvider();
  try {
    return await recognizeTextFromUpload(uploadItem);
  } catch (err) {
    if (
      !shouldFallbackToPaddleForImages()
      || provider === OCR_PROVIDER_PADDLE_LOCAL
      || provider === OCR_PROVIDER_PADDLEOCR_VL_LOCAL
    ) {
      throw err;
    }
    const code = String(err?.code || err?.message || '');
    if (code !== 'POLICY_OCR_EMPTY' && code !== 'POLICY_OCR_FAILED' && code !== 'POLICY_OCR_PROVIDER_NOT_READY') {
      throw err;
    }
    try {
      return await recognizeTextWithPaddleLocal(uploadItem);
    } catch {
      throw err;
    }
  }
}

async function recognizeTextWithBaiduPrivate(uploadItem) {
  const request = buildBaiduPrivateRequest(uploadItem);
  let response;
  try {
    response = await fetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
    });
  } catch {
    throw new Error('POLICY_OCR_FAILED');
  }

  if (!response.ok) {
    throw new Error('POLICY_OCR_FAILED');
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    throw new Error('POLICY_OCR_FAILED');
  }

  const recognized = extractBaiduPrivateOcrText(payload);
  if (!recognized) throw new Error('POLICY_OCR_EMPTY');
  return recognized;
}

async function recognizeTextFromUpload(uploadItem) {
  const provider = getConfiguredOcrProvider();
  if (provider === OCR_PROVIDER_BAIDU_PRIVATE) {
    return recognizeTextWithBaiduPrivate(uploadItem);
  }
  if (provider === OCR_PROVIDER_PADDLE_LOCAL || provider === OCR_PROVIDER_PADDLEOCR_VL_LOCAL) {
    return recognizeTextWithPaddleLocal(uploadItem);
  }
  if (provider === OCR_PROVIDER_PDF_EXTRACT_KIT_LOCAL) {
    return recognizeTextWithPdfExtractKit(uploadItem);
  }
  return recognizeTextWithVision(uploadItem);
}

export async function scanInsurancePolicyLocal({ uploadItem, ocrText }) {
  let recognizedText = normalizeOcrText(ocrText);
  if (!recognizedText && !uploadItem) throw new Error('POLICY_SCAN_INPUT_REQUIRED');
  if (!recognizedText && isPdfUpload(uploadItem)) {
    recognizedText = await extractTextFromPdfUpload(uploadItem);
  }

  let data = null;
  let bestOcrText = recognizedText;
  let scanFieldConfidence = {};
  let scanOcrWarnings = [];
  if (recognizedText) {
    data = extractPolicyFieldsFromText(recognizedText);
  } else {
    const provider = getConfiguredOcrProvider();
    if (provider === OCR_PROVIDER_OLLAMA_VISION_LOCAL) {
      data = await extractPolicyFieldsFromImageWithOllamaVision(uploadItem);
      bestOcrText = '';
    } else if (provider === OCR_PROVIDER_MLX_QWEN25_VL_LOCAL) {
      const mlxResult = await extractPolicyFieldsFromImageWithMlxVlm(uploadItem);
      data = mlxResult?.data || null;
      bestOcrText = normalizeOcrText(mlxResult?.ocrText || '');
    } else {
      const candidates = [];
      let handledPaddleLayout = false;
      if (provider === OCR_PROVIDER_PADDLE_LOCAL || provider === OCR_PROVIDER_PADDLEOCR_VL_LOCAL) {
        const paddleResult = await recognizePaddlePolicyUpload(uploadItem);
        candidates.push(paddleResult.ocrText);
        const best = selectBestPolicyScanCandidate(candidates);
        const layoutResult = paddleResult.boxes?.length
          ? parsePolicyBasicInfoFromLayoutBoxes(paddleResult.boxes)
          : null;
        const merged = mergePolicyLayoutScanResult({
          textData: best.data,
          layoutResult,
        });
        data = merged.data;
        scanFieldConfidence = merged.fieldConfidence;
        scanOcrWarnings = merged.ocrWarnings;
        bestOcrText = best.ocrText;
        handledPaddleLayout = true;
      } else if (provider === OCR_PROVIDER_PDF_EXTRACT_KIT_LOCAL) {
        const pdfExtractKitText = await recognizeTextWithPdfExtractKit(uploadItem);
        candidates.push(pdfExtractKitText);
      } else {
        candidates.push(await recognizeTextWithImageFallback(uploadItem));
      }
      if (!handledPaddleLayout) {
        const best = selectBestPolicyScanCandidate(candidates);
        data = best.data;
        bestOcrText = best.ocrText;
      }
    }
  }

  if (
    getConfiguredOcrProvider() !== OCR_PROVIDER_OLLAMA_VISION_LOCAL
    && getConfiguredOcrProvider() !== OCR_PROVIDER_MLX_QWEN25_VL_LOCAL
    && getConfiguredOcrPostprocessor() === OCR_POSTPROCESSOR_OLLAMA_QWEN
    && bestOcrText
  ) {
    try {
      const llmData = await postprocessPolicyFieldsWithOllama(bestOcrText, data);
      if (llmData) {
        const merged = mergePolicyDataCandidates([data, llmData]);
        if (scorePolicyData(merged) >= scorePolicyData(data)) {
          data = merged;
        }
      }
    } catch {
      // Keep OCR flow available even when the local LLM is unavailable.
    }
  }

  const localVisionEnhanced = await maybeEnhancePolicyScanWithLocalVision({
    uploadItem,
    data,
    ocrText: bestOcrText,
  });
  data = localVisionEnhanced.data;
  bestOcrText = normalizeOcrText(localVisionEnhanced.ocrText || bestOcrText);

  if (!Object.values(data).some(Boolean)) throw new Error('POLICY_OCR_EMPTY');
  const fieldConfidence = Object.keys(scanFieldConfidence).length ? scanFieldConfidence : (data.fieldConfidence || {});
  const dataOcrWarnings = Array.isArray(data.ocrWarnings) ? data.ocrWarnings : [];
  const ocrWarnings = [...new Set([...scanOcrWarnings, ...dataOcrWarnings].map((item) => String(item || '').trim()).filter(Boolean))];
  delete data.fieldConfidence;
  delete data.ocrWarnings;
  return {
    ok: true,
    data,
    ocrText: bestOcrText,
    ...(Object.keys(fieldConfidence).length ? { fieldConfidence } : {}),
    ...(ocrWarnings.length ? { ocrWarnings } : {}),
  };
}

/**
 * Scan a cash value table image using local OCR.
 * PaddleOCR runs first because table coordinates are more reliable for cash value grids;
 * macOS Vision remains the fast text-only fallback when PaddleOCR is unavailable.
 */
export async function scanCashValueTable({ uploadItem }, dependencies = {}) {
  if (!uploadItem?.dataUrl) {
    return { ok: false, error: 'CASH_VALUE_TABLE_NOT_DETECTED', message: '缺少图片数据' };
  }

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'cash-value-ocr-'));
  const imagePath = path.join(tmpDir, 'input.png');
  let visionError = null;
  let paddleError = null;
  const execFileImpl = dependencies.execFile || execFileAsync;
  const platform = dependencies.platform || process.platform;
  const envBase = dependencies.env || process.env;
  const warmupPaddle = dependencies.warmupPaddle || warmupPaddleLocalIfNeeded;
  const resolveScriptPaths = dependencies.resolveScriptPaths || resolveLocalOcrScriptPaths;
  const assertScriptExists = dependencies.assertScriptExists || assertOcrScriptExists;
  const getPaddlePython = dependencies.getPaddlePython || getConfiguredPaddlePython;

  try {
    const base64Data = uploadItem.dataUrl.replace(/^data:image\/\w+;base64,/, '');
    await writeFile(imagePath, Buffer.from(base64Data, 'base64'));

    try {
      const { paddleScriptPath } = resolveScriptPaths();
      assertScriptExists(paddleScriptPath);

      // Reuse the same Python environment as the existing policy OCR
      await warmupPaddle();
      const pythonCmd = getPaddlePython();
      const env = { ...envBase };
      const projectDir = String(env.POLICY_OCR_PADDLE_PROJECT_DIR || '').trim();
      env.POLICY_OCR_PADDLE_PIPELINE = 'ocr';

      const { stdout } = await execFileImpl(pythonCmd, [paddleScriptPath, imagePath], {
        env,
        cwd: projectDir || undefined,
        maxBuffer: 50 * 1024 * 1024,
        timeout: 120000,
      });

      const ocrOutput = JSON.parse(stdout);
      if (!ocrOutput.ok) {
        paddleError = { ok: false, error: 'PARSE_FAILED', message: 'OCR 识别失败' };
      } else {
        const boxes = ocrOutput.boxes || [];
        const parsed = parseCashValueTable(boxes);
        if (parsed.ok) return parsed;
        paddleError = parsed;
      }
    } catch (error) {
      const code = String(error?.message || error?.code || 'PARSE_FAILED');
      const stderr = String(error?.stderr || '').slice(0, 300);
      paddleError = {
        ok: false,
        error: code,
        message: `PaddleOCR 识别失败: ${code}${stderr ? ` (${stderr})` : ''}`,
      };
    }

    if (platform === 'darwin') {
      try {
        const { visionScriptPath } = resolveScriptPaths();
        assertScriptExists(visionScriptPath);
        const { stdout } = await execFileImpl('swift', [visionScriptPath, imagePath], {
          timeout: 30000,
          maxBuffer: 20 * 1024 * 1024,
        });
        const parsedText = parseCashValueText(stdout, { source: 'macos_vision' });
        if (parsedText.ok) return parsedText;
        visionError = parsedText;
      } catch (error) {
        const code = String(error?.message || error?.code || 'PARSE_FAILED');
        visionError = {
          ok: false,
          error: code,
          message: `macOS Vision OCR 失败: ${code}`,
        };
      }
    }

    if (visionError && paddleError) {
      return {
        ...paddleError,
        message: `${paddleError.message}；${visionError.message}`,
      };
    }

    return paddleError || visionError || { ok: false, error: 'PARSE_FAILED', message: '现金价值表解析失败' };
  } catch (error) {
    const code = String(error?.message || error?.code || 'PARSE_FAILED');
    const stderr = String(error?.stderr || '').slice(0, 300);
    return { ok: false, error: code, message: `现金价值表解析失败: ${code}${stderr ? ` (${stderr})` : ''}` };
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

function shouldForceLocalOcr(env = process.env) {
  return String(env.POLICY_OCR_FORCE_LOCAL || '').trim().toLowerCase() === 'true';
}

export async function scanInsurancePolicy({ uploadItem, ocrText }) {
  if (!shouldForceLocalOcr() && hasConfiguredOcrServiceBaseUrl()) {
    return scanInsurancePolicyOverHttp({ uploadItem, ocrText });
  }
  return scanInsurancePolicyLocal({ uploadItem, ocrText });
}

void warmupPaddleLocalIfNeeded();
void warmupPdfExtractKitIfNeeded();
