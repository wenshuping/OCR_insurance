import { SEMANTIC_QUERY_ASPECTS } from './agent-semantic-contract.mjs';
import {
  SALES_CHAMPION_CAPABILITY_KEYS,
  SALES_CHAMPION_KYC_EVIDENCE_SOURCES,
  SALES_CHAMPION_KYC_FACT_KEYS,
  SALES_CHAMPION_MISSING_INFORMATION_KEYS,
  SALES_CHAMPION_SITUATION_KEYS,
  hasExplicitCustomerAttribution,
  validateSalesTurnProposal,
} from './sales-champion-turn.contract.mjs';
import { SALES_CHAMPION_CUSTOMER_LABEL_TAXONOMY } from './sales-champion-customer-labels.mjs';
import {
  redactDeepSeekDirectIdentifiers,
  buildDeepSeekChatCompletionsUrl,
  sanitizeDeepSeekRequestBody,
} from './deepseek-privacy-gateway.mjs';

const STAGES = ['contact', 'appointment', 'discovery', 'proposal', 'objection', 'decision', 'post_sale'];
const CONCERNS = [
  'liquidity', 'duration', 'family_decision', 'trust', 'affordability', 'product_fit',
  'insurer_safety', 'benefits', 'claims', 'underwriting', 'surrender', 'rebate',
  'risk_pooling', 'follow_up', 'unknown',
];
const INTERPRETER_MAX_TOKENS = 2_000;
const CUSTOMER_STATEMENT_MAX_ITEMS = 20;
const CUSTOMER_STATEMENT_CHARACTER_BUDGET = 4_000;
const CUSTOMER_STATEMENT_KYC_PRIORITY = Object.freeze({
  customer_goal: 50,
  service_request: 45,
  insurance_attitude: 40,
  purchase_behavior: 35,
  conversation_outcome: 30,
});
const SITUATION_MAPPING_RULES = Object.freeze([
  'first_insurance_conversation：明确是第一次和该客户谈保险；仅仅第一次见面、第一次服务不算。',
  'orphan_policy：明确是原业务员离职、公司转交保单、刚接手别人的老保单客户；不要求出现“孤儿单”三个字。一直由当前顾问服务的老客户不算。',
  'high_value_client：顾问明确要经营高净值客户旅程；只有年龄、职业、收入或资产背景不算。',
  'retirement_planning：客户明确在谈养老目标或退休现金流；只有五十多岁或买过年金险不算。',
  'investment_comparison：客户明确在比较保险与投资、存款或其他资产工具的角色；只出现产品名称不算。',
  'long_payment_commitment：客户明确担心缴费期限太长、坚持不住或退休前交不完；不要自动推断预算不足。',
  'premium_coverage_tradeoff：客户明确在权衡保费投入和保障额度；只有收入、预算或保额背景不算。',
  'medical_critical_illness_overlap：明确询问医疗险和重疾险如何分工或是否重复；只有已买医疗险不算。',
  'social_commercial_overlap：明确询问社保与商业保险如何分工或是否重复；只有有社保不算。',
  'dividend_uncertainty：明确质疑红利、分红或非保证利益；只出现分红型产品名称不算。',
  'solvency_concern：明确担心保险公司偿付能力或长期安全；普通品牌偏好不算。',
  'return_expectation：明确表达收益预期、嫌收益低或要求先说明收益限制；只出现利率背景不算。',
  'buying_signal：客户主动询问投保手续、下一步、材料或明确表示愿意推进；礼貌回应不算。',
  'health_risk_conversation：当前任务是和客户讨论健康风险和保障需求；年龄或健康背景本身不算。',
  'verified_product_change：存在已经核验的产品调整、停售或生效变化；传闻和未经核验的变化不算。',
  'service_trust_recovery：明确存在失联服务、强推、投诉或不愉快服务经历；普通“不信任保险”不算。',
  'existing_customer_add_on：明确是已有客户的加保、追加或重新规划；仅仅提到客户买过保险不算。',
  'event_follow_up：明确是在活动、讲座或客户沙龙后跟进；普通见面后跟进不算。',
  'regional_pipeline：明确要按区域安排一批客户的经营和约访；单个客户跟进不算。',
]);

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

function dropUngroundedCustomerStatements(proposal, sourceTexts = []) {
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)
    || !Array.isArray(proposal.customerStatements) || !proposal.customerStatements.length) return proposal;
  const sources = sourceTexts.map((item) => text(item).replace(/\s+/gu, ''));
  const currentSource = sources[0] || '';
  const historicalSources = sources.slice(1).filter(Boolean);
  const grounded = proposal.customerStatements.flatMap((statement, index) => {
    if (!statement || typeof statement !== 'object' || Array.isArray(statement)
      || Object.keys(statement).length !== 2
      || !Object.hasOwn(statement, 'text') || !Object.hasOwn(statement, 'source')
      || !['current_message', 'confirmed_history'].includes(statement.source)) return [statement];
    const statementText = text(statement.text);
    if (!statementText || statementText.length > 500) return [statement];
    const normalized = statementText.replace(/\s+/gu, '');
    if (currentSource.includes(normalized)) {
      return [{ ...statement, source: 'current_message', normalized, index }];
    }
    if (historicalSources.some((source) => source.includes(normalized))) {
      return [{ ...statement, source: 'confirmed_history', normalized, index }];
    }
    return [];
  });
  if (!grounded.length) return proposal;
  if (grounded.some((statement) => !statement?.normalized)) {
    return { ...proposal, customerStatements: grounded.slice(0, CUSTOMER_STATEMENT_MAX_ITEMS) };
  }
  const facts = Array.isArray(proposal.kycFacts) ? proposal.kycFacts : [];
  const labels = Array.isArray(proposal.customerLabels) ? proposal.customerLabels : [];
  const unique = [...new Map(grounded.map((statement) => [statement.normalized, statement])).values()];
  const ranked = unique.map((statement) => {
    const kycPriority = facts.reduce((highest, fact) => {
      const evidence = text(fact?.evidence).replace(/\s+/gu, '');
      const matches = evidence && (evidence.includes(statement.normalized)
        || statement.normalized.includes(evidence));
      return matches ? Math.max(highest, CUSTOMER_STATEMENT_KYC_PRIORITY[fact?.key] || 10) : highest;
    }, 0);
    const labelPriority = labels.some((label) => {
      const evidence = text(label?.evidence).replace(/\s+/gu, '');
      return evidence && (evidence.includes(statement.normalized)
        || statement.normalized.includes(evidence));
    }) ? 8 : 0;
    return {
      ...statement,
      score: (statement.source === 'current_message' ? 20 : 0) + kycPriority + labelPriority,
    };
  }).sort((left, right) => right.score - left.score || left.index - right.index);
  let usedCharacters = 0;
  const selected = [];
  for (const statement of ranked) {
    if (selected.length >= CUSTOMER_STATEMENT_MAX_ITEMS) break;
    if (usedCharacters + statement.text.length > CUSTOMER_STATEMENT_CHARACTER_BUDGET) continue;
    selected.push({ text: statement.text, source: statement.source });
    usedCharacters += statement.text.length;
  }
  return { ...proposal, customerStatements: selected };
}

function normalizeAdvisorEvidenceAttribution(proposal, sourceTexts = []) {
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) return proposal;
  return {
    ...proposal,
    ...(Array.isArray(proposal.kycFacts) ? {
      kycFacts: proposal.kycFacts.map((fact) => (
        fact?.source === 'customer_statement'
          && !hasExplicitCustomerAttribution(fact.evidence, sourceTexts)
          ? { ...fact, source: 'advisor_fact' }
          : fact
      )),
    } : {}),
    ...(Array.isArray(proposal.customerLabels) ? {
      customerLabels: proposal.customerLabels.filter((label) => (
        label?.source !== 'customer_statement'
          || hasExplicitCustomerAttribution(label.evidence, sourceTexts)
      )),
    } : {}),
  };
}

function dropUngroundedKycEvidence(proposal, sourceTexts = []) {
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) return proposal;
  const sources = sourceTexts.map((item) => text(item).replace(/\s+/gu, '')).filter(Boolean);
  const keepGrounded = (item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || typeof item.evidence !== 'string' || !item.evidence.trim()) return true;
    const evidence = item.evidence.replace(/\s+/gu, '');
    return sources.some((source) => source.includes(evidence));
  };
  return {
    ...proposal,
    ...(Array.isArray(proposal.kycFacts)
      ? { kycFacts: proposal.kycFacts.filter(keepGrounded).slice(0, 16) }
      : {}),
    ...(Array.isArray(proposal.customerLabels)
      ? { customerLabels: proposal.customerLabels.filter(keepGrounded).slice(0, 20) }
      : {}),
  };
}

function normalizeGroundedProposal(proposal, sourceTexts = []) {
  return normalizeAdvisorEvidenceAttribution(
    dropUngroundedKycEvidence(
      dropUngroundedCustomerStatements(proposal, sourceTexts),
      sourceTexts,
    ),
    sourceTexts,
  );
}

function applyTurnRelation(proposal, question = '') {
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) return proposal;
  const value = text(question).replace(/\s+/gu, '');
  const correction = /(?:人家|客户).{0,24}(?:没|没有|并没|并没有)(?:明确)?(?:说|表示|提到|提过|想|想要|要求)/u.test(value)
    || /(?:是我|也是我|只是我).{0,20}(?:沟通|问|引导|推|判断|觉得|猜).{0,8}(?:出来|的)/u.test(value)
    || /^(?:人家|客户|他|她|这|那|前面|之前).{0,80}(?:不是|难道).{1,80}(?:吗|嘛|呢)[？?]?$/u.test(value);
  return correction
    ? {
      ...proposal,
      turnRelation: { value: 'correction', confidence: 1 },
      concerns: [{ type: 'unknown', priority: 'primary', confidence: 1 }],
      missingInformation: [],
      unknownInformation: [],
      proposedCapabilities: ['general_sales_clarification'],
      insuranceNeeds: [],
      situations: [],
    }
    : proposal;
}

function boundedHistory(history = []) {
  return (Array.isArray(history) ? history : []).slice(-20).flatMap((message) => {
    const role = text(message?.role);
    const content = redactDeepSeekDirectIdentifiers(text(message?.content)).slice(0, 2_000);
    return ['user', 'assistant'].includes(role) && content ? [{ role, content }] : [];
  });
}

function interpreterMessages({ question, history, activeCustomerKyc = null }) {
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
          `missingInformation 只能是：${SALES_CHAMPION_MISSING_INFORMATION_KEYS.join(', ')}`,
          `proposedCapabilities 只能是：${SALES_CHAMPION_CAPABILITY_KEYS.join(', ')}`,
          `situations 只能是：${SALES_CHAMPION_SITUATION_KEYS.join(', ')}`,
          `kycFacts.key 只能是：${SALES_CHAMPION_KYC_FACT_KEYS.join(', ')}`,
          `kycFacts.source 和 customerLabels.source 只能是：${SALES_CHAMPION_KYC_EVIDENCE_SOURCES.join(', ')}`,
          `customerLabels 必须使用以下受控标签：${JSON.stringify(SALES_CHAMPION_CUSTOMER_LABEL_TAXONOMY)}`,
          `insuranceNeeds.queryAspects 只能是：${SEMANTIC_QUERY_ASPECTS.join(', ')}`,
          'customerStatements 最多提交 24 条候选逐字证据片段，不得改写；系统会去重并在总字符预算内优先保留与客户目标、明确态度、服务诉求、购买行为和本轮结果有关的证据。它只标记证据位置，不代表客户本人说过。片段在当前问题中才用 current_message，只在历史中出现必须用 confirmed_history。',
          'customerStatements 不要收录顾问的任务请求，例如“我怎么跟进”“给我建议”“怎么回复”；也不要把整段 currentQuestion 原样放进一条 statement。',
          'kycFacts 从顾问描述中提取年龄人生阶段、工作职业、收入、家庭婚姻子女、居住房产、资产负债、现有保单、客户目标、保险态度、购买行为、决策方式、联系偏好、服务事项和本轮结果。evidence 必须逐字摘录自当前问题或已确认历史。',
          '客户明确原话用 customer_statement；顾问明确陈述的客观情况用 advisor_fact；“估计、可能、应该、忘记了”等用 advisor_estimate；“我感觉、我觉得他抗保、意向高”等顾问判断用 advisor_inference。',
          'customerLabels 只登记有证据的受控标签。customer_statement 或明确 advisor_fact 可以 confirmed；advisor_estimate 和 advisor_inference 只能 candidate。没有证据的维度不要输出默认标签。',
          '工作、家庭、收入、居住、房产和已有保单要进入 KYC，但不得仅凭年龄、职业、收入、婚姻、房产或产品名称推断 economic_capacity、purchase_intent、resistance、decision_maturity、family_decision 或保障缺口。',
          '购买意向、抗保和决策标签优先依据客户原话与行为，例如主动提问、提供资料、要求方案、约定下次、明确拒绝或表达不信任；顾问主观感觉只能形成 candidate。',
          '只有回答确实依赖产品责任、条款、续保、理赔、核保、现金价值或产品比较事实时，才添加 type=product_facts 的 insuranceNeeds。',
          '只有需要基于已授权家庭保单或保障报告判断现有保障覆盖、重复或缺口时，才添加 type=coverage_gap 的 insuranceNeeds。',
          '产品名称只是客户背景、且销售建议不依赖产品事实时，insuranceNeeds 必须为空。',
          '年龄、收入估计、婚姻状态、居住、房产、子女和已有产品属于客户背景，不会自动成为 affordability、family_decision、benefits 或 product_fit concern。只有客户明确表达预算异议、共同决策问题、产品疑问或购买诉求时才能选择对应 concern。',
          '顾问只问“怎么跟进”，但客户目标和当前销售进展尚不清楚时，使用 discovery + unknown + needs_discovery，不得从背景信息猜一个异议。',
          'situations 按业务事实语义判断，不要求用户说出 Skill 名称或行业术语；等价的明确事实可以确认场景。没有明确事实时返回空数组，不得根据年龄、收入或产品名称猜测。',
          '场景映射边界如下：',
          ...SITUATION_MAPPING_RULES,
          '如果某个场景可能适用，但缺少决定性信息，不要把它放进 situations；只把对应的最小确认项放进 missingInformation。比如疑似接手老保单但来源不清楚时添加 customer_relationship_origin。',
          'missingInformation 只记录会改变本轮 Skill、话术安全边界或保险事实核验的信息；不要为了补全客户画像而一次列很多项目。',
          '如果顾问在当前问题或历史里已明确说某项“不知道、不了解、没问到、拿不到”，把对应字段放进 unknownInformation，不要再放进 missingInformation，也不要重复追问；后续仍按安全兜底给方法。',
          '保险事实和保障缺口交给 Insurance Expert；销售阶段、客户关注点、跟进策略归 Sales Champion。',
          '明确拒绝或要求停止联系时设置对应 signals，不得选择促成类能力。',
          'JSON 字段必须完整：contractVersion, customerStatements, kycFacts, customerLabels, stage, concerns, signals, missingInformation, unknownInformation, proposedCapabilities, insuranceNeeds, situations。',
          'contractVersion 必须是 JSON 数字 1，不能是字符串。confidence 必须是 0 到 1 的 JSON 数字。',
          'insuranceNeeds 每项格式为 {"type":"product_facts|coverage_gap","queryAspects":[]}。',
          'kycFacts 每项格式为 {"key":"受控字段","value":"简短结构化值","source":"证据来源","evidence":"逐字证据"}。',
          'customerLabels 每项格式为 {"dimension":"标签维度","value":"受控标签值","status":"confirmed|candidate","source":"证据来源","evidence":"逐字证据","confidence":0.9}。',
          '完整 JSON 形状必须是：',
          '{"contractVersion":1,"customerStatements":[{"text":"逐字摘录的原句","source":"current_message"}],"kycFacts":[],"customerLabels":[],"stage":{"value":"discovery","confidence":0.9},"concerns":[{"type":"unknown","priority":"primary","confidence":0.9}],"signals":{"explicitRefusal":false,"stopContact":false,"factSensitive":false},"missingInformation":["customer_goal"],"unknownInformation":[],"proposedCapabilities":["needs_discovery"],"insuranceNeeds":[],"situations":[]}',
        ].join('\n'),
      },
      {
        role: 'user',
        content: JSON.stringify({
          activeCustomerKyc,
          history: safeHistory,
          currentQuestion: safeQuestion,
        }),
      },
    ],
    sourceTexts: [safeQuestion, ...safeHistory.map((message) => message.content)],
  };
}

export async function interpretSalesChampionTurn({
  question = '',
  history = [],
  activeCustomerKyc = null,
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
  const { messages, sourceTexts } = interpreterMessages({ question, history, activeCustomerKyc });
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const complete = async (requestMessages) => {
      const response = await fetchImpl(buildDeepSeekChatCompletionsUrl(baseUrl), {
        method: 'POST',
        signal: controller.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(sanitizeDeepSeekRequestBody({
          model,
          max_tokens: INTERPRETER_MAX_TOKENS,
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
      return validateSalesTurnProposal(
        applyTurnRelation(
          normalizeGroundedProposal(parseJson(firstContent), sourceTexts),
          question,
        ),
        { sourceTexts },
      );
    } catch (validationError) {
      const repairedContent = await complete([
        ...messages,
        { role: 'assistant', content: firstContent },
        {
          role: 'user',
          content: `上一份 JSON 未通过 contract 校验：${text(validationError?.message).slice(0, 300)}。只修正 JSON 结构和枚举值；不得改变原问题含义，不得添加无必要的 insuranceNeeds。仅返回修正后的完整 JSON。`,
        },
      ]);
      return validateSalesTurnProposal(
        applyTurnRelation(
          normalizeGroundedProposal(parseJson(repairedContent), sourceTexts),
          question,
        ),
        { sourceTexts },
      );
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
