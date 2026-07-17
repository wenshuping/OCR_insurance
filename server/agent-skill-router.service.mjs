import { sanitizeDeepSeekRequestBody } from './deepseek-privacy-gateway.mjs';

function trim(value) {
  return String(value || '').trim();
}

function withCode(error, code, status) {
  error.code = code;
  if (status) error.status = status;
  return error;
}

const COMMON_INSURANCE_RULES = [
  '只基于已提供的家庭、保单、家庭报告、销售建议、官网证据和对话内容输出。',
  '缺少收入、负债、预算、健康告知、现金价值、分红、领取利益或责任条款证据时写“待核实”。',
  '不得承诺收益、分红、利率、理赔、核保、法律或税务结果。',
  '客户沟通必须温和、专业、可复制，避免恐吓式或压迫式销售。',
  '关键判断尽量写明依据来自“保单字段/家庭报告/销售建议/家庭责任信息/官网证据/续聊内容”。',
];

const SKILL_DEFINITIONS = {
  objection_handling: {
    label: '客户异议处理',
    rules: [
      '先共情客户顾虑，再用资料核实和方案分层回应。',
      '预算异议优先拆成基础/标准/完善三档，不直接催促加保。',
      '已买很多保险的异议要先做保单复盘，指出重复、缺口和待核实项。',
      '输出可直接复制的微信或面谈话术。',
    ],
  },
  coverage_gap: {
    label: '家庭保障缺口分析',
    rules: [
      '按成员逐一分析医疗、重疾、寿险、意外、失能和家庭责任缺口。',
      '优先参考家庭责任信息中的收入、支出、负债、子女教育、父母赡养和保费预算。',
      '没有保单的成员也必须覆盖，并说明资料缺口或销售机会。',
      '建议顺序优先保障底座，再谈养老、教育金、年金或财富传承。',
    ],
  },
  policy_evidence: {
    label: '保单责任与官网证据核对',
    rules: [
      '官网证据与保单派生分类冲突时，优先参考官网产品名称、官网链接和责任指标。',
      '无法确认的责任、除外、等待期、现金价值或领取规则必须标记“待核实”。',
      '不得声称读过未提供的条款全文。',
      '输出时区分“已确认依据”和“仍需补证据”。',
    ],
  },
  product_comparison: {
    label: '产品比对与替换评估',
    rules: [
      '只比较已提供的产品资料、保单字段、官网证据和责任指标；不得凭记忆编造产品责任。',
      '先确认产品是否同类型；不同类型产品不能直接说“谁更好”，只能按客户目标和风险场景拆维度比较。',
      '比较维度包括保障责任、赔付条件、等待期、免责/除外、缴费期、保障期、保额、保费、现金价值/领取规则、续保或保证续保、健康告知和核保影响。',
      '涉及替换、退保、换保或转保时必须提示退保损失、等待期重启、重新核保、既往症影响和现金价值损失。',
      '不得输出“肯定更划算”“一定建议换”等确定性结论；缺少条款、费率、现金价值、健康状况或预算时写“待核实”。',
      '输出优先采用结论先行、对比表、适合人群、风险点、待核实资料和顾问话术。',
    ],
  },
  sales_script: {
    label: '销售话术与面谈设计',
    rules: [
      '话术要能直接复制给顾问使用，但不要代替顾问自动发送。',
      '面谈顺序为先核实数据，再展示保障缺口，再展开方案，再约补资料或二次面谈。',
      '避免夸大风险和制造焦虑，用问题引导客户确认责任和预算。',
      '需要给出下一步动作和补资料清单。',
    ],
  },
  sales_review_regeneration: {
    label: '销售建议报告重算',
    rules: [
      '只吸收顾问明确选择的续聊内容，不要引入未选择的聊天内容。',
      '把已选续聊中的客户异议、表达偏好、方案排序和下一步动作融入新版报告。',
      '如果已选内容和家庭/保单资料冲突，优先提示“待核实”，不要直接覆盖事实。',
      '新版报告保持简短，只保留关键核实项、最多三个保障问题、最多三个销售机会、一个面谈目标和行动清单。',
    ],
  },
  followup_materials: {
    label: '补资料与跟进清单',
    rules: [
      '把问题拆成客户需要补充的信息、顾问需要核对的保单资料和系统已有证据。',
      '每个待核实项说明为什么需要、会影响哪类建议。',
      '跟进动作要按今天、下次面谈、后续保全或投保准备排序。',
    ],
  },
};

const SKILL_KEYS = Object.keys(SKILL_DEFINITIONS);

function normalizeSkillKeys(values = []) {
  return unique((Array.isArray(values) ? values : [])
    .map((value) => trim(value))
    .filter((value) => SKILL_KEYS.includes(value)))
    .slice(0, 4);
}

function unique(values = []) {
  return Array.from(new Set(values.filter(Boolean)));
}

export function selectAgentSkillPrompt({ scene = 'family_sales_chat', salesChatContext = null } = {}) {
  const primaryIntent = salesChatContext ? 'sales_review_regeneration' : 'sales_script';
  const skillKeys = unique([
    primaryIntent,
    salesChatContext ? 'sales_script' : '',
  ]);
  const skillRules = skillKeys.flatMap((key) => SKILL_DEFINITIONS[key]?.rules || []);
  return {
    scene,
    intent: primaryIntent,
    skills: skillKeys.map((key) => ({
      key,
      label: SKILL_DEFINITIONS[key]?.label || key,
    })),
    systemRules: unique([...COMMON_INSURANCE_RULES, ...skillRules]),
    promptHint: `本地安全 fallback 仅启用“${SKILL_DEFINITIONS[primaryIntent]?.label || primaryIntent}”；不得按原始问题关键词推断更具体的 skill。`,
    selectedBy: 'local_fallback',
  };
}

function skillSelectionMessages({ scene = '', question = '', salesChatContext = null } = {}) {
  const skillList = SKILL_KEYS
    .map((key) => `- ${key}: ${SKILL_DEFINITIONS[key].label}`)
    .join('\n');
  return [
    {
      role: 'system',
      content: [
        '你是保险营销 Agent 的 skill router，只负责选择本轮要启用的 skills。',
        '必须只返回 JSON，不要解释，不要输出 Markdown。',
        '可选 skills：',
        skillList,
        '',
        '选择原则：',
        '- 最多选择 4 个 skill key。',
        '- 如果是销售建议报告重算，必须包含 sales_review_regeneration。',
        '- 如果是客户异议或预算问题，包含 objection_handling。',
        '- 如果是保障缺口或优先补保障，包含 coverage_gap。',
        '- 如果是责任、条款或官网证据，包含 policy_evidence。',
        '- 如果是产品对比、竞品差异、哪个好、替换、换保、转保或退保，包含 product_comparison；涉及条款证据时再包含 policy_evidence，涉及替换旧保单时再包含 followup_materials。',
        '- 如果需要微信话术、面谈提纲或邀约，包含 sales_script。',
        '- 如果需要补资料或下一步动作，包含 followup_materials。',
        '',
        'JSON 格式：{"intent":"skill_key","skills":["skill_key"],"reason":"不超过20字"}',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        `scene: ${scene}`,
        `hasSelectedSalesChatContext: ${salesChatContext ? 'true' : 'false'}`,
        `question: ${trim(question).slice(0, 1_000)}`,
      ].join('\n'),
    },
  ];
}

function parseSkillSelection(content = '') {
  const jsonText = trim(content).replace(/^```json\s*/iu, '').replace(/^```\s*/u, '').replace(/```$/u, '').trim();
  const parsed = JSON.parse(jsonText);
  const skills = normalizeSkillKeys(parsed?.skills);
  const intent = SKILL_KEYS.includes(trim(parsed?.intent)) ? trim(parsed.intent) : skills[0];
  return {
    intent: intent || 'sales_script',
    skills: skills.length ? skills : ['sales_script'],
    reason: trim(parsed?.reason).slice(0, 60),
  };
}

export function buildAgentSkillPromptFromSelection({ scene = 'family_sales_chat', selection = {}, salesChatContext = null } = {}) {
  const fallback = selectAgentSkillPrompt({ scene, question: '', salesChatContext });
  const skillKeys = normalizeSkillKeys(selection.skills);
  const keys = skillKeys.length ? skillKeys : fallback.skills.map((skill) => skill.key);
  const intent = SKILL_KEYS.includes(trim(selection.intent)) ? trim(selection.intent) : keys[0];
  const skillRules = keys.flatMap((key) => SKILL_DEFINITIONS[key]?.rules || []);
  return {
    scene,
    intent,
    skills: keys.map((key) => ({
      key,
      label: SKILL_DEFINITIONS[key]?.label || key,
    })),
    systemRules: unique([...COMMON_INSURANCE_RULES, ...skillRules]),
    promptHint: `智能 skill router 选择为“${SKILL_DEFINITIONS[intent]?.label || intent}”，请按对应保险业务规则组织输出。`,
    selectedBy: 'deepseek',
    selectionReason: trim(selection.reason),
  };
}

export async function selectAgentSkillPromptWithDeepSeek({
  scene = 'family_sales_chat',
  question = '',
  salesChatContext = null,
  fetchImpl = fetch,
  config = {},
  privacyOptions = {},
} = {}) {
  if (!config.apiKey) {
    return selectAgentSkillPrompt({ scene, question, salesChatContext });
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), Number(config.timeoutMs || 30_000));
  try {
    const body = {
      model: config.model || 'deepseek-v4-flash',
      max_tokens: 300,
      temperature: 0,
      messages: skillSelectionMessages({ scene, question, salesChatContext }),
    };
    const response = await fetchImpl(new URL('/chat/completions', config.baseUrl || 'https://api.deepseek.com'), {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(sanitizeDeepSeekRequestBody(body, privacyOptions)),
    });
    if (!response.ok) {
      const bodyText = trim(await response.text());
      throw withCode(new Error(`AGENT_SKILL_ROUTER_UPSTREAM_${response.status}:${bodyText || 'upstream_error'}`), 'AGENT_SKILL_ROUTER_UPSTREAM_FAILED', 502);
    }
    const payload = await response.json();
    const selection = parseSkillSelection(payload?.choices?.[0]?.message?.content || '');
    return buildAgentSkillPromptFromSelection({ scene, selection, salesChatContext });
  } catch {
    return selectAgentSkillPrompt({ scene, question, salesChatContext });
  } finally {
    clearTimeout(timeoutId);
  }
}
