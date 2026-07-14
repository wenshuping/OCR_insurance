import { sanitizeDeepSeekRequestBody } from './deepseek-privacy-gateway.mjs';
import { DEFAULT_AGENT_RUNTIME_SETTINGS } from './agent-question-policy.service.mjs';

const INTENTS = [
  'family_list', 'family_summary', 'coverage_report', 'sales_report', 'sales_coaching',
  'insurance_product_knowledge', 'upload_link', 'system_help', 'chat', 'unknown_read', 'unknown_write',
];

function text(value) {
  return String(value || '').trim();
}

function parseCandidate(content, question) {
  const parsed = JSON.parse(text(content).replace(/^```json\s*/iu, '').replace(/^```\s*/u, '').replace(/```$/u, '').trim());
  const intent = INTENTS.includes(text(parsed?.intent)) ? text(parsed.intent) : 'unknown_read';
  const familyName = text(parsed?.familyName).slice(0, 100);
  const productName = text(parsed?.productName).slice(0, 200);
  const entities = {
    ...(familyName ? { familyName } : {}),
    ...(productName ? { productName } : {}),
  };
  return {
    intent,
    question: text(question).slice(0, 1_000),
    confidence: Math.min(1, Math.max(0, Number(parsed?.confidence) || 0)),
    requestedOperation: intent === 'unknown_write' ? 'write' : 'read',
    ...(Object.keys(entities).length ? { entities } : {}),
  };
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
        '你是 OCR Insurance 的渠道理解器，只负责把自然语言转换成受控意图，不回答保险问题。',
        '结合最近对话理解追问，例如“为什么0份有效”“那这个家庭呢”“这个产品有什么优势”，并从上文恢复已经明确的家庭名称或保险产品全名。',
        `intent 只能是：${INTENTS.join(', ')}。`,
        'family_list=查询家庭数量；family_summary=家庭成员、保单数量、状态及状态原因；coverage_report=家庭保障分析或缺口；sales_report=销售建议报告；sales_coaching=沟通话术；insurance_product_knowledge=产品责任、条款、等待期、免责、产品对比、某公司有哪些在售或停售产品；upload_link=上传保单；system_help=系统使用；chat=普通闲聊；unknown_write=未识别的修改/删除/转移操作；unknown_read=其他未识别查询。',
        '只返回 JSON：{"intent":"...","familyName":"明确或从上文恢复的家庭名，没有则空字符串","productName":"明确或从上文恢复的保险产品全名，没有则空字符串","confidence":0到1}。',
        '不得输出 userId、familyId、policyId、手机号、身份证号、权限结论或工具名。',
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
        max_tokens: 300,
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
      return parseCandidate(payload?.choices?.[0]?.message?.content, question);
    } finally {
      clearTimeout(timeout);
    }
  };
}
