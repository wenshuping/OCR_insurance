import crypto from 'node:crypto';

export const RESPONSIBILITY_GENERATION_GOVERNANCE_STATE_KEY = 'responsibilityGenerationGovernance';
export const RESPONSIBILITY_OFFICIAL_TEXT_FALLBACK_STATUS = 'official_text_fallback_after_retry_failed';
const DEFAULT_PLANNER_MODE = 'auto';

const DEFAULT_PROMPT_RULES = [
  '只提取含有触发条件和保险公司给付、赔付、报销、豁免义务的保险责任。',
  '不要把章节名、计算参数、理赔申请流程、责任免除、未还款项扣除识别为保险责任。',
  '保留官方责任名称，不要把“重度疾病保险金”等官方名称改写成泛化名称。',
  '多版本产品必须先锁定具体官方 PDF 或官方页面；来源不清时不要生成结构化责任。',
  '现金价值、红利、保单贷款、减保、账户价值、投资账户、受益人指定不得作为独立保险责任。',
];

const DEFAULT_BLOCKED_TITLES = [
  '保险责任',
  '基本责任',
  '可选责任',
  '可选责任一',
  '可选责任二',
  '可选责任三',
  '附加责任',
  '保险金',
  '免赔额',
  '赔付比例',
  '给付比例',
  '申请保险金',
  '保险金申请',
  '责任免除',
  '未还款项扣除',
];

const DEFAULT_FAILURE_EXAMPLES = [
  {
    badOutput: '可选责任一',
    reason: '这是章节名，不是保险责任。',
    correction: '只保留该章节下具体的保险金或豁免费用责任。',
  },
  {
    badOutput: '免赔额',
    reason: '这是医疗险计算参数，不是保险公司承担给付义务的责任。',
    correction: '把免赔额写进对应医疗保险金的 paymentRule 或 importantNotes。',
  },
  {
    badOutput: '责任免除',
    reason: '这是除外责任章节，不是保险责任。',
    correction: '责任免除只能作为注意事项，不进入 responsibilities。',
  },
];

function text(value) {
  return String(value ?? '').trim();
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueStrings(values = [], limit = 80) {
  const seen = new Set();
  const result = [];
  for (const value of normalizeArray(values)) {
    const item = text(value).replace(/\s+/gu, ' ');
    if (!item || seen.has(item)) continue;
    seen.add(item);
    result.push(item.slice(0, 240));
    if (result.length >= limit) break;
  }
  return result;
}

function normalizeFailureExample(value = {}) {
  if (typeof value === 'string') {
    const [badOutput = '', reason = '', correction = ''] = value.split('|').map(text);
    return normalizeFailureExample({ badOutput, reason, correction });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const badOutput = text(value.badOutput || value.bad_output || value.output || value.title).slice(0, 120);
  const reason = text(value.reason || value.errorReason || value.error_reason).slice(0, 240);
  const correction = text(value.correction || value.correctRule || value.correct_rule).slice(0, 320);
  if (!badOutput && !reason && !correction) return null;
  return { badOutput, reason, correction };
}

function normalizeFailureExamples(values = [], limit = 40) {
  const seen = new Set();
  const result = [];
  for (const value of normalizeArray(values)) {
    const item = normalizeFailureExample(value);
    if (!item) continue;
    const key = [item.badOutput, item.reason, item.correction].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
    if (result.length >= limit) break;
  }
  return result;
}

function normalizedTitle(value) {
  return text(value).replace(/\s+/gu, '').replace(/[：:。；;，,、]/gu, '');
}

function normalizePlannerMode(value) {
  const mode = text(value);
  return mode === 'all' || mode === 'off' || mode === 'auto' ? mode : DEFAULT_PLANNER_MODE;
}

export function normalizeResponsibilityGenerationGovernanceConfig(config = {}, { now = '' } = {}) {
  const source = config && typeof config === 'object' && !Array.isArray(config) ? config : {};
  const promptRules = uniqueStrings(source.promptRules || source.rules || DEFAULT_PROMPT_RULES);
  const blockedResponsibilityTitles = uniqueStrings(
    source.blockedResponsibilityTitles || source.blockedTitles || DEFAULT_BLOCKED_TITLES,
  );
  const failureExamples = normalizeFailureExamples(source.failureExamples || source.examples || DEFAULT_FAILURE_EXAMPLES);
  const fallbackMode = text(source.fallbackMode) === 'needs_review'
    ? 'needs_review'
    : 'official_text_after_second_failure';
  return {
    enabled: source.enabled !== false,
    plannerMode: normalizePlannerMode(source.plannerMode),
    promptRules,
    blockedResponsibilityTitles,
    failureExamples,
    fallbackMode,
    updatedAt: text(source.updatedAt) || text(now),
  };
}

export function getResponsibilityGenerationGovernanceConfig(state = {}) {
  return normalizeResponsibilityGenerationGovernanceConfig(
    state?.[RESPONSIBILITY_GENERATION_GOVERNANCE_STATE_KEY],
  );
}

export function responsibilityGenerationGovernanceDigest(config = {}) {
  const normalized = normalizeResponsibilityGenerationGovernanceConfig(config);
  if (!normalized.enabled) {
    return crypto.createHash('sha256').update(JSON.stringify({
      enabled: false,
      plannerMode: normalized.plannerMode,
    })).digest('hex');
  }
  return crypto.createHash('sha256').update(JSON.stringify({
    enabled: normalized.enabled,
    plannerMode: normalized.plannerMode,
    promptRules: normalized.promptRules,
    blockedResponsibilityTitles: normalized.blockedResponsibilityTitles,
    failureExamples: normalized.failureExamples,
    fallbackMode: normalized.fallbackMode,
    updatedAt: normalized.updatedAt,
  })).digest('hex');
}

export function blockedResponsibilityTitleIssue(title, config = {}) {
  const normalized = normalizeResponsibilityGenerationGovernanceConfig(config);
  if (!normalized.enabled) return null;
  const candidate = normalizedTitle(title);
  if (!candidate) return null;
  const blocked = normalized.blockedResponsibilityTitles
    .map(normalizedTitle)
    .filter(Boolean)
    .find((item) => item === candidate);
  if (!blocked) return null;
  return {
    code: 'blocked_responsibility_title',
    title: text(title),
    message: `“${text(title)}”属于后台规则禁止的责任标题，不应作为保险责任输出。`,
  };
}

export function responsibilityGenerationGovernancePromptSection(config = {}) {
  const normalized = normalizeResponsibilityGenerationGovernanceConfig(config);
  if (!normalized.enabled) return '';
  const lines = [
    '运营后台动态规则：以下规则由运营后台配置，优先级高于通用写作习惯；如与官方原文冲突，以官方原文为准。',
    ...normalized.promptRules.map((rule) => `- ${rule}`),
  ];
  if (normalized.blockedResponsibilityTitles.length) {
    lines.push(`- 以下内容不得作为 responsibilities[].title 输出：${normalized.blockedResponsibilityTitles.join('、')}`);
  }
  if (normalized.failureExamples.length) {
    lines.push('失败样例库：');
    normalized.failureExamples.forEach((item, index) => {
      lines.push(`${index + 1}. 错误输出“${item.badOutput || '未命名'}”：${item.reason || '不合规'}；正确处理：${item.correction || '按官方责任正文重新识别。'}`);
    });
  }
  return lines.join('\n');
}

export function qualityIssuesPromptSection(issues = []) {
  const rows = normalizeArray(issues)
    .map((issue) => ({
      code: text(issue?.code),
      title: text(issue?.title),
      message: text(issue?.message),
      index: Number.isFinite(Number(issue?.index)) ? Number(issue.index) : null,
    }))
    .filter((issue) => issue.code || issue.title || issue.message);
  if (!rows.length) return '';
  return [
    '上一次输出未通过校验，失败原因如下：',
    ...rows.slice(0, 20).map((issue, index) => {
      const label = issue.title ? `“${issue.title}”` : (issue.index === null ? '' : `第${issue.index + 1}项`);
      return `${index + 1}. ${[label, issue.code, issue.message].filter(Boolean).join('：')}`;
    }),
    '请根据上述失败原因重新生成，仍然只输出合法 JSON。',
  ].join('\n');
}

export function buildOfficialTextFallbackCustomerSummary({
  company = '',
  productName = '',
  sourceSections = {},
  sourceUrls = [],
} = {}) {
  const officialText = text(sourceSections.mainResponsibilityText);
  const content = officialText || '官方保险责任正文暂未抽取完整，请查看来源文件。';
  return {
    company: text(company),
    productName: text(productName),
    headline: '自动整理未通过，以下为保险责任原文。',
    mainResponsibilities: [],
    notices: ['结构化保险责任两次校验未通过，本次不展示模型整理结果。'],
    requiredPolicyFields: [],
    sourceUrls: uniqueStrings(sourceUrls),
    officialResponsibilityText: content,
    contentBlocks: [
      {
        blockKey: 'productPurpose',
        title: '产品主要做什么',
        enabled: true,
        editable: true,
        order: 1,
        content: '自动整理未通过，暂不生成产品定位。',
      },
      {
        blockKey: 'responsibilities',
        title: '主要保险责任',
        enabled: true,
        editable: true,
        order: 2,
        content,
      },
      {
        blockKey: 'productFunctions',
        title: '产品功能/权益',
        enabled: false,
        editable: true,
        order: 3,
        content: '',
      },
      {
        blockKey: 'attentionNotes',
        title: '注意事项',
        enabled: true,
        editable: true,
        order: 4,
        content: '请以官方条款正文为准；如需结构化责任卡片，请调整后台规则或人工复核来源。',
      },
    ],
  };
}
