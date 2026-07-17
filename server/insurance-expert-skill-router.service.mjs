import { INSURANCE_EXPERT_CORE_SKILL_MANIFEST } from './insurance-expert-skill-manifest.mjs';

const SUPPORTING_FACT_SKILLS = Object.freeze([
  'official_terms_retrieval',
  'evidence_validation',
]);
const GENERIC_QA_SUPPORTING_SKILLS = Object.freeze([
  'official_terms_retrieval',
  'approved_material_retrieval',
  'evidence_validation',
]);

const RECORD_TERMS = Object.freeze(['记录', '保存', '整理', '续期提醒', '提醒续期', '保单记录', '理赔记录', '保费统计']);
const SALES_TERMS = Object.freeze(['客户', '话术', '异议', '成交', '跟进', '推荐', '销售', '收益低', '说服']);
const PLAN_TERMS = Object.freeze(['计划一', '计划二', '计划三', '计划1', '计划2', '计划3', '保障计划', '不同计划', '分别']);
const RESPONSIBILITY_TERMS = Object.freeze(['保险责任', '保障内容', '保什么', '保障范围', '责任范围', '责任']);
const PRODUCT_COMPARISON_TERMS = Object.freeze(['对比', '比较', '区别', '哪个好', '替换', '刚才那个', '这个和']);
const EXCLUSION_TERMS = Object.freeze(['免责', '不保', '不赔']);
const WAITING_TERMS = Object.freeze(['等待期', '多久能赔', '多久能报']);
const DEDUCTIBLE_TERMS = Object.freeze(['免赔', '免赔额']);
const REIMBURSEMENT_TERMS = Object.freeze(['报销', '赔付', '给付', '赔多少钱', '报销比例']);
const RENEWAL_TERMS = Object.freeze(['续保', '保证续保', '保险期间']);
const GENERIC_PRODUCT_TERMS = Object.freeze([
  '适合', '适合什么人群', '适合谁', '什么人可以买', '投保条件', '健康告知', '职业限制',
  '亮点', '优势', '怎么样', '注意事项', '有什么坑', '怎么理解', '普通医疗险',
]);

function text(value, limit = 2_000) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function includesAny(value, terms) {
  const normalized = text(value).toLowerCase();
  return terms.some((term) => normalized.includes(term.toLowerCase()));
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function hasProductContext(context = {}) {
  return Boolean(context.resolvedProduct || context.activeProduct
    || (Array.isArray(context.resolvedProducts) && context.resolvedProducts.length));
}

function selectCoreSkillKeys(question, context = {}) {
  const queryAspects = Array.isArray(context.queryAspects) ? context.queryAspects.join(' ') : '';
  const target = [question, queryAspects, context.currentGoal?.intent].join(' ');
  if (includesAny(target, RECORD_TERMS)) return ['insurance'];
  if (includesAny(target, SALES_TERMS)) return ['sales_champion'];

  const selected = [];
  if (includesAny(target, PLAN_TERMS)) selected.push('plan_comparison', 'responsibility_detail');
  if (includesAny(target, PRODUCT_COMPARISON_TERMS)
    && (Array.isArray(context.resolvedProducts) || /产品|这个|那个|刚才/u.test(target))) {
    selected.push('product_comparison');
  }
  if (includesAny(target, EXCLUSION_TERMS)) selected.push('exclusion_lookup');
  if (includesAny(target, WAITING_TERMS)) selected.push('waiting_period_lookup');
  if (includesAny(target, DEDUCTIBLE_TERMS)) selected.push('deductible_lookup');
  if (includesAny(target, REIMBURSEMENT_TERMS)) selected.push('reimbursement_lookup');
  if (includesAny(target, RENEWAL_TERMS)) selected.push('renewal_lookup');
  if (includesAny(target, RESPONSIBILITY_TERMS)) selected.push('responsibility_detail');
  if (!selected.length && (hasProductContext(context) || includesAny(target, GENERIC_PRODUCT_TERMS))) {
    selected.push('insurance_expert_qa');
  }
  return unique(selected);
}

function mergeByKey(skills = []) {
  const map = new Map();
  for (const skill of skills) {
    if (!skill?.key || map.has(skill.key)) continue;
    map.set(skill.key, skill);
  }
  return [...map.values()];
}

function applyManifest(definition) {
  const manifest = INSURANCE_EXPERT_CORE_SKILL_MANIFEST[definition.key];
  if (!manifest) return {
    ...definition,
    layer: definition.layer || (definition.source === 'local_skill' ? 'hidden' : 'supporting'),
    domain: definition.domain || 'insurance_expert',
  };
  return {
    ...definition,
    ...manifest,
    label: manifest.label || definition.label,
    description: manifest.description || definition.description,
    requiresOfficialEvidence: manifest.requiresOfficialEvidence || definition.requiresOfficialEvidence,
    safetyBoundaries: definition.safetyBoundaries || [],
  };
}

export function selectInsuranceExpertSkillCandidates({
  intent = 'insurance_product_knowledge',
  question = '',
  context = {},
  skills = [],
  maxSkills = 8,
} = {}) {
  if (intent !== 'insurance_product_knowledge') return mergeByKey(skills).slice(0, maxSkills);
  const enhanced = mergeByKey(skills).map(applyManifest);
  const byKey = new Map(enhanced.map((skill) => [skill.key, skill]));
  const selectedKeys = selectCoreSkillKeys(question || context.question, context);
  const selected = selectedKeys.map((key) => byKey.get(key)).filter(Boolean);
  const needsInsuranceEvidence = selected.some((skill) => skill.domain === 'insurance_expert'
    && skill.key !== 'insurance' && skill.key !== 'sales_champion');
  const supportingKeys = selected.some((skill) => skill.key === 'insurance_expert_qa')
    ? GENERIC_QA_SUPPORTING_SKILLS
    : (needsInsuranceEvidence ? SUPPORTING_FACT_SKILLS : ['evidence_validation']);
  const required = supportingKeys.map((key) => byKey.get(key)).filter(Boolean);
  const fallback = selected.length ? [] : ['insurance_expert_qa', ...GENERIC_QA_SUPPORTING_SKILLS]
    .map((key) => byKey.get(key)).filter(Boolean);
  return mergeByKey([...selected, ...required, ...fallback]).slice(0, maxSkills);
}
