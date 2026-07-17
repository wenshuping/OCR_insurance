import { SEMANTIC_QUERY_ASPECTS } from './agent-semantic-contract.mjs';
import { SALES_CHAMPION_CAPABILITY_KEYS, validateSalesTurnProposal } from './sales-champion-turn.contract.mjs';
import {
  redactDeepSeekDirectIdentifiers,
  sanitizeDeepSeekRequestBody,
} from './deepseek-privacy-gateway.mjs';

const STAGES = ['contact', 'appointment', 'discovery', 'proposal', 'objection', 'decision', 'post_sale'];
const CONCERNS = [
  'liquidity', 'duration', 'family_decision', 'trust', 'affordability', 'product_fit',
  'insurer_safety', 'benefits', 'claims', 'underwriting', 'surrender', 'rebate',
  'risk_pooling', 'follow_up', 'unknown',
];
const MISSING_INFORMATION = [
  'customer_goal', 'future_fund_use', 'budget', 'existing_coverage', 'product_contract',
  'cash_value_schedule', 'family_decision_process', 'health_information', 'contact_preference',
];

function text(value) {
  return String(value || '').trim();
}

function numberOrDefault(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function parseJson(content = '') {
  return JSON.parse(text(content)
    .replace(/^```json\s*/iu, '')
    .replace(/^```\s*/u, '')
    .replace(/```$/u, '')
    .trim());
}

function boundedHistory(history = []) {
  return (Array.isArray(history) ? history : []).slice(-12).flatMap((message) => {
    const role = text(message?.role);
    const content = redactDeepSeekDirectIdentifiers(text(message?.content)).slice(0, 2_000);
    return ['user', 'assistant'].includes(role) && content ? [{ role, content }] : [];
  });
}

function interpreterMessages({ question, history }) {
  const safeQuestion = redactDeepSeekDirectIdentifiers(question).slice(0, 2_000);
  const safeHistory = boundedHistory(history);
  return {
    messages: [
      {
        role: 'system',
        content: [
          '你是 Sales Champion 内部的销售 turn interpreter，只做结构化理解和受控能力选择，不生成给客户的答案。',
          '只能返回一个 JSON 对象，不要输出 Markdown、解释或额外字段。',
          `stage.value 只能是：${STAGES.join(', ')}`,
          `concerns.type 只能是：${CONCERNS.join(', ')}`,
          `missingInformation 只能是：${MISSING_INFORMATION.join(', ')}`,
          `proposedCapabilities 只能是：${SALES_CHAMPION_CAPABILITY_KEYS.join(', ')}`,
          `insuranceNeeds.queryAspects 只能是：${SEMANTIC_QUERY_ASPECTS.join(', ')}`,
          'customerStatements 必须拆成 2 到 8 条简短的客户背景或客户原话，每条都必须是当前问题或已确认历史中的逐字连续片段，不得改写；当前问题用 current_message，历史用 confirmed_history。',
          'customerStatements 不要收录顾问的任务请求，例如“我怎么跟进”“给我建议”“怎么回复”；也不要把整段 currentQuestion 原样放进一条 statement。',
          '只有回答确实依赖产品责任、条款、续保、理赔、核保、现金价值或产品比较事实时，才添加 type=product_facts 的 insuranceNeeds。',
          '只有需要基于已授权家庭保单或保障报告判断现有保障覆盖、重复或缺口时，才添加 type=coverage_gap 的 insuranceNeeds。',
          '产品名称只是客户背景、且销售建议不依赖产品事实时，insuranceNeeds 必须为空。',
          '年龄、收入估计、婚姻状态、居住、房产、子女和已有产品属于客户背景，不会自动成为 affordability、family_decision、benefits 或 product_fit concern。只有客户明确表达预算异议、共同决策问题、产品疑问或购买诉求时才能选择对应 concern。',
          '顾问只问“怎么跟进”，但客户目标和当前销售进展尚不清楚时，使用 discovery + unknown + needs_discovery，不得从背景信息猜一个异议。',
          '保险事实和保障缺口交给 Insurance Expert；销售阶段、客户关注点、跟进策略归 Sales Champion。',
          '明确拒绝或要求停止联系时设置对应 signals，不得选择促成类能力。',
          'JSON 字段必须完整：contractVersion, customerStatements, stage, concerns, signals, missingInformation, proposedCapabilities, insuranceNeeds。',
          'contractVersion 必须是 JSON 数字 1，不能是字符串。confidence 必须是 0 到 1 的 JSON 数字。',
          'insuranceNeeds 每项格式为 {"type":"product_facts|coverage_gap","queryAspects":[]}。',
          '完整 JSON 形状必须是：',
          '{"contractVersion":1,"customerStatements":[{"text":"逐字摘录的原句","source":"current_message"}],"stage":{"value":"discovery","confidence":0.9},"concerns":[{"type":"unknown","priority":"primary","confidence":0.9}],"signals":{"explicitRefusal":false,"stopContact":false,"factSensitive":false},"missingInformation":["customer_goal"],"proposedCapabilities":["needs_discovery"],"insuranceNeeds":[]}',
        ].join('\n'),
      },
      {
        role: 'user',
        content: JSON.stringify({ history: safeHistory, currentQuestion: safeQuestion }),
      },
    ],
    sourceTexts: [safeQuestion, ...safeHistory.map((message) => message.content)],
  };
}

export async function interpretSalesChampionTurn({
  question = '',
  history = [],
  fetchImpl = fetch,
  env = process.env,
} = {}) {
  const apiKey = text(env.DEEPSEEK_API_KEY || env.FAMILY_SALES_CHAT_API_KEY);
  if (!apiKey) {
    throw Object.assign(new Error('SALES_CHAMPION_INTERPRETER_NOT_READY'), {
      code: 'SALES_CHAMPION_INTERPRETER_NOT_READY', status: 503,
    });
  }
  const baseUrl = text(env.DEEPSEEK_BASE_URL || env.FAMILY_SALES_CHAT_BASE_URL) || 'https://api.deepseek.com';
  const model = text(env.SALES_CHAMPION_INTERPRETER_MODEL || env.FAMILY_AGENT_SKILL_ROUTER_MODEL) || 'deepseek-v4-flash';
  const timeoutMs = numberOrDefault(env.SALES_CHAMPION_INTERPRETER_TIMEOUT_MS, 30_000);
  const { messages, sourceTexts } = interpreterMessages({ question, history });
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const complete = async (requestMessages) => {
      const response = await fetchImpl(new URL('/chat/completions', baseUrl), {
        method: 'POST',
        signal: controller.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(sanitizeDeepSeekRequestBody({
          model,
          max_tokens: 2_000,
          temperature: 0,
          response_format: { type: 'json_object' },
          thinking: { type: 'disabled' },
          messages: requestMessages,
        })),
      });
      if (!response.ok) {
        throw Object.assign(new Error(`SALES_CHAMPION_INTERPRETER_UPSTREAM_${response.status}`), {
          code: 'SALES_CHAMPION_INTERPRETER_UPSTREAM_FAILED', status: 502,
        });
      }
      const payload = await response.json();
      return text(payload?.choices?.[0]?.message?.content);
    };

    const firstContent = await complete(messages);
    try {
      return validateSalesTurnProposal(parseJson(firstContent), { sourceTexts });
    } catch (validationError) {
      const repairedContent = await complete([
        ...messages,
        { role: 'assistant', content: firstContent },
        {
          role: 'user',
          content: `上一份 JSON 未通过 contract 校验：${text(validationError?.message).slice(0, 300)}。只修正 JSON 结构和枚举值；不得改变原问题含义，不得添加无必要的 insuranceNeeds。仅返回修正后的完整 JSON。`,
        },
      ]);
      return validateSalesTurnProposal(parseJson(repairedContent), { sourceTexts });
    }
  } catch (error) {
    if (controller.signal.aborted) {
      throw Object.assign(new Error('SALES_CHAMPION_INTERPRETER_TIMEOUT'), {
        code: 'SALES_CHAMPION_INTERPRETER_TIMEOUT', status: 504,
      });
    }
    if (error?.code) throw error;
    throw Object.assign(new Error('SALES_CHAMPION_INTERPRETER_INVALID_RESPONSE', { cause: error }), {
      code: 'SALES_CHAMPION_INTERPRETER_INVALID_RESPONSE', status: 502,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}
