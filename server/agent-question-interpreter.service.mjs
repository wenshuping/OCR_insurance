import { sanitizeDeepSeekRequestBody } from './deepseek-privacy-gateway.mjs';
import { DEFAULT_AGENT_RUNTIME_SETTINGS } from './agent-question-policy.service.mjs';
import {
  normalizeSemanticProposal,
  SEMANTIC_INTENTS,
  SEMANTIC_MENTION_TYPES,
  SEMANTIC_QUERY_ASPECTS,
  SEMANTIC_REFERENCE_TYPES,
} from './agent-semantic-contract.mjs';

function text(value) {
  return String(value || '').trim();
}

function parseProposal(content, question) {
  const parsed = JSON.parse(text(content)
    .replace(/^```json\s*/iu, '')
    .replace(/^```\s*/u, '')
    .replace(/```$/u, '')
    .trim());
  const queryAspects = Array.isArray(parsed?.queryAspects) ? parsed.queryAspects : [];
  const mentions = Array.isArray(parsed?.mentions) ? parsed.mentions : [];
  const references = Array.isArray(parsed?.references) ? parsed.references : [];
  const requestedSteps = Array.isArray(parsed?.requestedSteps) ? parsed.requestedSteps : [];
  const productComparison = queryAspects.includes('comparison')
    && requestedSteps.includes('compare')
    && (mentions.some((mention) => mention?.type === 'product')
      || references.some((reference) => [
        'current_product', 'comparison_left', 'comparison_right',
      ].includes(reference?.type)));
  const hasProductSubject = mentions.some((mention) => mention?.type === 'product')
    || references.some((reference) => [
      'current_product', 'comparison_left', 'comparison_right',
    ].includes(reference?.type));
  const hasFamilySubject = mentions.some((mention) => mention?.type === 'family')
    || references.some((reference) => reference?.type === 'current_family');
  const productFactQuery = hasProductSubject
    && !hasFamilySubject
    && queryAspects.some((aspect) => [
      'main_responsibilities', 'product_advantages', 'exclusions', 'waiting_period', 'deductible',
      'reimbursement_ratio', 'renewal', 'sales_status',
    ].includes(aspect));
  return normalizeSemanticProposal({
    semanticContractVersion: 1,
    intent: productComparison || productFactQuery ? 'insurance_product_knowledge' : parsed?.intent,
    operation: parsed?.operation,
    queryAspects,
    mentions,
    references,
    requestedSteps,
    confidence: parsed?.confidence,
  }, question);
}

function messages(question, history = [], recentMessageLimit = DEFAULT_AGENT_RUNTIME_SETTINGS.fallbackHistoryMessageLimit) {
  const limit = Math.min(40, Math.max(1, Number.parseInt(recentMessageLimit, 10) || DEFAULT_AGENT_RUNTIME_SETTINGS.fallbackHistoryMessageLimit));
  const recent = (Array.isArray(history) ? history : []).slice(-limit).flatMap((item) => {
    const role = text(item?.role);
    const content = text(item?.content).slice(0, 1_000);
    return ['user', 'assistant'].includes(role) && content ? [{ role, content }] : [];
  });
  return [
    {
      role: 'system',
      content: [
        '你是 OCR Insurance 的渠道语义解析器，只把当前问题转换成受控语义，不回答保险事实。',
        '结合最近对话判断当前问题是否延续上一任务，但不得从历史中复制或编造本轮原文没有出现的实体名称。',
        '只输出一个 JSON 对象，固定字段为 semanticContractVersion, intent, operation, queryAspects, mentions, references, requestedSteps, confidence。',
        'semanticContractVersion 固定为数字 1；operation 只能是 read 或 write。',
        `intent 只能是：${SEMANTIC_INTENTS.join(', ')}。`,
        `queryAspects 只能从以下值选择：${SEMANTIC_QUERY_ASPECTS.join(', ')}。`,
        `mentions.type 只能是：${SEMANTIC_MENTION_TYPES.join(', ')}；mentions.rawText 必须逐字来自当前问题。`,
        `references.type 只能是：${SEMANTIC_REFERENCE_TYPES.join(', ')}；显式引用的 rawText 必须逐字来自当前问题，省略实体形成的隐式引用允许 rawText 为空字符串。`,
        '如果当前问题通过代词、省略主语、候选序号或承接上文来引用实体，使用 references 表达，不要把历史实体写入 mentions。',
        '产品对比缺少一侧且需要承接当前产品时，用 comparison_left 或 comparison_right 标明缺失角色；没有上下文时也照实输出引用，后端会负责澄清。',
        '仅查询产品责任、产品优势、条款、等待期、免责、免赔额、赔付比例、续保或在售状态时，intent 必须是 insurance_product_knowledge；不得标记为家庭保障报告。',
        '询问产品优势、亮点、卖点或好在哪里时，queryAspects 使用 product_advantages，不得使用 main_responsibilities。',
        'requestedSteps 只能从 lookup, compare, generate, upload, continue 中选择。',
        'confidence 必须恰好包含 intent, mentions, references 三个 0 到 1 的数字。',
        '不得输出 userId、familyId、policyId、手机号、身份证号、权限结论、工具名或其他字段。',
      ].join('\n'),
    },
    ...recent,
    { role: 'user', content: text(question).slice(0, 1_000) },
  ];
}

export function createDeepSeekAgentQuestionInterpreter({ env = process.env, fetchImpl = fetch } = {}) {
  const apiKey = text(env.DEEPSEEK_API_KEY);
  const baseUrl = text(env.DEEPSEEK_BASE_URL) || 'https://api.deepseek.com';
  const model = text(env.DINGTALK_AGENT_MODEL || env.DEEPSEEK_MODEL) || 'deepseek-v4-flash';
  const timeoutMs = Math.max(1_000, Number(env.DINGTALK_AGENT_MODEL_TIMEOUT_MS) || 20_000);

  return async function interpretQuestion({ question, history = [], recentMessageLimit } = {}) {
    if (!apiKey) throw new Error('DINGTALK_AGENT_MODEL_NOT_CONFIGURED');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const body = sanitizeDeepSeekRequestBody({
        model,
        temperature: 0,
        max_tokens: 2_000,
        response_format: { type: 'json_object' },
        messages: messages(question, history, recentMessageLimit),
      });
      const response = await fetchImpl(new URL('/chat/completions', baseUrl), {
        method: 'POST',
        signal: controller.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`DINGTALK_AGENT_MODEL_UPSTREAM_${response.status}`);
      const payload = await response.json();
      return parseProposal(payload?.choices?.[0]?.message?.content, question);
    } finally {
      clearTimeout(timeout);
    }
  };
}
