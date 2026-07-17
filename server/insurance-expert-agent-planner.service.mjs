import {
  redactDeepSeekDirectIdentifiers,
  sanitizeDeepSeekRequestBody,
} from './deepseek-privacy-gateway.mjs';
import {
  createInsuranceExpertSkillRegistry,
  formatSkillRegistryForPrompt,
} from './insurance-expert-skill-registry.service.mjs';

const QUERY_ASPECTS = new Set([
  'main_responsibilities', 'product_advantages', 'exclusions', 'waiting_period',
  'deductible', 'reimbursement_ratio', 'renewal', 'sales_status', 'comparison',
]);
const OFFICIAL_FACT_ASPECTS = new Set([
  'main_responsibilities', 'exclusions', 'waiting_period', 'deductible',
  'reimbursement_ratio', 'renewal', 'comparison',
]);

function plannerError(code) {
  return Object.assign(new Error(code), { code });
}

function text(value, limit = 2_000) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function parseJsonObject(value) {
  const normalized = text(value, 20_000).replace(/^```(?:json)?\s*|\s*```$/giu, '').trim();
  try {
    const parsed = JSON.parse(normalized);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const DEFAULT_SKILL_REGISTRY = createInsuranceExpertSkillRegistry();

function registryOrDefault(skillRegistry) {
  return skillRegistry && typeof skillRegistry.skillsForIntent === 'function'
    ? skillRegistry
    : DEFAULT_SKILL_REGISTRY;
}

function allowedSkillDefinitions(intent, context = {}, skillRegistry = null) {
  return registryOrDefault(skillRegistry).skillsForIntent(intent, context);
}

export function insuranceExpertSkillsForIntent(intent, context = {}, skillRegistry = null) {
  return allowedSkillDefinitions(intent, context, skillRegistry).map((definition) => definition.key);
}

function normalizePlan(value, intent, availableSkills, officialFactSkills) {
  const allowed = new Set(availableSkills.map((definition) => definition.key));
  const selectedSkills = [...new Set((Array.isArray(value?.skills) ? value.skills : [])
    .map((item) => text(item, 80)).filter((item) => allowed.has(item)))].slice(0, 8);
  const queryAspects = [...new Set((Array.isArray(value?.queryAspects) ? value.queryAspects : [])
    .map((item) => text(item, 80)).filter((item) => QUERY_ASPECTS.has(item)))].slice(0, 8);
  const taskSkills = [...new Set([
    ...selectedSkills.filter((skill) => skill !== 'evidence_validation'),
    ...(selectedSkills.includes('product_overview') ? ['responsibility_detail'] : []),
  ])];
  const needsOfficialTerms = intent === 'insurance_product_knowledge' && (
    taskSkills.some((skill) => officialFactSkills.has(skill))
    || queryAspects.some((aspect) => OFFICIAL_FACT_ASPECTS.has(aspect))
  );
  const skills = [...new Set([
    ...taskSkills,
    ...(needsOfficialTerms ? ['official_terms_retrieval'] : []),
    ...(selectedSkills.includes('evidence_validation') ? ['evidence_validation'] : []),
  ])].slice(0, 8);
  const evidenceGoals = [...new Set((Array.isArray(value?.evidenceGoals) ? value.evidenceGoals : [])
    .map((item) => text(item, 240)).filter(Boolean))].slice(0, 8);
  const maxRetrievalRounds = Number(value?.maxRetrievalRounds);
  if (!skills.length || !skills.includes('evidence_validation')) return null;
  const substantiveSkills = new Set([
    ...availableSkills
      .map((definition) => definition.key)
      .filter((key) => !['evidence_validation', 'official_terms_retrieval', 'approved_material_retrieval'].includes(key)),
  ]);
  if (intent === 'insurance_product_knowledge'
    && !skills.some((item) => substantiveSkills.has(item))) return null;
  if (!Number.isInteger(maxRetrievalRounds) || maxRetrievalRounds < 1 || maxRetrievalRounds > 2) return null;
  return {
    skills,
    queryAspects,
    evidenceGoals,
    maxRetrievalRounds,
    reason: text(value?.reason, 200),
  };
}

function safeContext(context) {
  const products = Array.isArray(context?.resolvedProducts)
    ? context.resolvedProducts.slice(0, 2).map((product) => ({
      company: text(product?.company, 200),
      officialName: text(product?.officialName, 300),
    })) : [];
  const product = context?.resolvedProduct && typeof context.resolvedProduct === 'object'
    ? {
      company: text(context.resolvedProduct.company, 200),
      officialName: text(context.resolvedProduct.officialName, 300),
    } : null;
  return {
    intent: text(context?.intent, 80),
    question: text(redactDeepSeekDirectIdentifiers(context?.question), 2_000),
    ...(product?.company && product?.officialName ? { product } : {}),
    ...(products.length ? { products } : {}),
    semanticHints: Array.isArray(context?.queryAspects)
      ? context.queryAspects.map((item) => text(item, 80)).filter(Boolean).slice(0, 8) : [],
  };
}

export function createInsuranceExpertAgentPlanner({
  env = process.env,
  fetchImpl = fetch,
  timeoutMs = 20_000,
  skillRegistry = null,
} = {}) {
  const apiKey = text(env?.DEEPSEEK_API_KEY, 2_000);
  const baseUrl = text(env?.DEEPSEEK_BASE_URL, 2_000) || 'https://api.deepseek.com';
  const model = text(env?.DINGTALK_INSURANCE_EXPERT_PLANNER_MODEL || env?.DEEPSEEK_MODEL, 200)
    || 'deepseek-v4-flash';

  return Object.freeze({
    async plan(context) {
      if (!apiKey) throw plannerError('INSURANCE_EXPERT_PLANNER_UNAVAILABLE');
      const intent = text(context?.intent, 80);
      const registry = registryOrDefault(skillRegistry);
      const availableSkills = allowedSkillDefinitions(intent, context, registry);
      const availableSkillKeys = availableSkills.map((definition) => definition.key);
      const officialFactSkills = typeof registry.officialFactSkillKeys === 'function'
        ? registry.officialFactSkillKeys(intent, context)
        : new Set(availableSkills.filter((definition) => definition.requiresOfficialEvidence).map((definition) => definition.key));
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), Math.max(1_000, timeoutMs));
      try {
        const response = await fetchImpl(new URL('/chat/completions', baseUrl), {
          method: 'POST',
          signal: controller.signal,
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(sanitizeDeepSeekRequestBody({
            model,
            temperature: 0,
            max_tokens: 700,
            response_format: { type: 'json_object' },
            messages: [
              {
                role: 'system',
                content: [
                  '你是 OCR Insurance 的保险专家 Agent 规划器。先理解客户原问题、已解析产品和语义提示，再选择完成本轮任务所需的原子 Skills。',
                  '语义提示只是参考，不得用大类标签替代客户的具体问题；例如“分别是啥”要求展开被引用项目的名称和内容。',
                  '摘要、责任卡、完整条款和公司资料都是证据来源，不是最终答案。需要具体合同事实时选择 official_terms_retrieval。',
                  '每个计划、版本或产品都必须覆盖客户实际询问的维度；证据不足时允许第二轮补充检索。',
                  '必须选择 evidence_validation。不得输出保险事实、答案、内部 ID 或未列出的 Skill。',
                  '可选 Skills：',
                  formatSkillRegistryForPrompt(availableSkills),
                  `可选 Skill keys：${availableSkillKeys.join(', ')}`,
                  `queryAspects 可选：${[...QUERY_ASPECTS].join(', ')}`,
                  '只输出 JSON：{"skills":[],"queryAspects":[],"evidenceGoals":[],"maxRetrievalRounds":1或2,"reason":""}',
                ].join('\n'),
              },
              { role: 'user', content: JSON.stringify(safeContext(context)) },
            ],
          })),
        });
        if (!response.ok) throw plannerError('INSURANCE_EXPERT_PLANNER_FAILED');
        const payload = await response.json();
        const plan = normalizePlan(
          parseJsonObject(payload?.choices?.[0]?.message?.content),
          intent,
          availableSkills,
          officialFactSkills,
        );
        if (!plan) throw plannerError('INSURANCE_EXPERT_PLAN_INVALID');
        return plan;
      } catch (error) {
        if (error?.code) throw error;
        throw plannerError(error?.name === 'AbortError'
          ? 'INSURANCE_EXPERT_PLANNER_TIMEOUT' : 'INSURANCE_EXPERT_PLANNER_FAILED');
      } finally {
        clearTimeout(timeout);
      }
    },
  });
}
