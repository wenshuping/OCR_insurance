import { evaluateSalesChampionShadowRoute } from './sales-champion-shadow-router.service.mjs';

const RULES = Object.freeze([
  { pattern: /(?:不需要|不用了|别联系|不要再联系|拒绝)/u, concern: 'follow_up', capability: 'follow_up_consent', stage: 'contact', refusal: true },
  { pattern: /(?:返佣|返点|返钱|回扣)/u, concern: 'rebate', capability: 'rebate_request_handling', stage: 'objection' },
  { pattern: /(?:家人|爱人|老公|老婆|父母|商量)/u, concern: 'family_decision', capability: 'family_joint_decision', stage: 'objection' },
  { pattern: /(?:退保|现金价值|回本|流动性|取钱)/u, concern: 'surrender', capability: 'tradeoff_disclosure', stage: 'objection', factSensitive: true },
  { pattern: /(?:理赔|赔不赔|免责|等待期|核保|健康告知|收益|保额|条款)/u, concern: 'benefits', capability: 'plain_language_explanation', stage: 'proposal', factSensitive: true },
  { pattern: /(?:贵|预算|没钱|负担|交不起)/u, concern: 'affordability', capability: 'five_question_diagnosis', stage: 'objection' },
  { pattern: /(?:骗人|不相信|不靠谱|保险公司安全吗|倒闭)/u, concern: 'trust', capability: 'reputation_objection', stage: 'objection' },
  { pattern: /(?:推荐|方案|产品|怎么买|怎么配置)/u, concern: 'product_fit', capability: 'five_question_diagnosis', stage: 'discovery' },
]);

function normalizedQuestion(value) {
  return String(value || '').replace(/\s+/gu, ' ').trim().slice(0, 2_000);
}

export function interpretSalesChampionShadowTurn({ question } = {}) {
  const current = normalizedQuestion(question);
  const matched = RULES.find((rule) => rule.pattern.test(current));
  const rule = matched || {
    concern: 'unknown',
    capability: 'needs_discovery',
    stage: 'discovery',
  };
  const confidence = matched ? 0.8 : 0.66;
  return {
    contractVersion: 1,
    customerStatements: current ? [{ text: current, source: 'current_message' }] : [],
    stage: { value: rule.stage, confidence },
    concerns: current ? [{ type: rule.concern, priority: 'primary', confidence }] : [],
    signals: {
      explicitRefusal: rule.refusal === true,
      stopContact: rule.refusal === true && /(?:别联系|不要再联系)/u.test(current),
      factSensitive: rule.factSensitive === true,
    },
    missingInformation: rule.concern === 'product_fit' || rule.concern === 'unknown' ? ['customer_goal'] : [],
    proposedCapabilities: [rule.capability],
  };
}

export function routeSalesChampionShadowTurn({ question, runtimeAvailable = true } = {}) {
  const sourceText = normalizedQuestion(question);
  const proposal = interpretSalesChampionShadowTurn({ question: sourceText });
  return evaluateSalesChampionShadowRoute({
    proposal,
    sourceTexts: sourceText ? [sourceText] : [],
    runtimeAvailable,
  });
}
