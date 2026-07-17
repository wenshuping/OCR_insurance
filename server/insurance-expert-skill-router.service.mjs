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

const ASPECT_SKILL_KEYS = Object.freeze({
  main_responsibilities: Object.freeze(['responsibility_detail']),
  product_advantages: Object.freeze(['insurance_expert_qa']),
  exclusions: Object.freeze(['exclusion_lookup']),
  waiting_period: Object.freeze(['waiting_period_lookup']),
  deductible: Object.freeze(['deductible_lookup']),
  reimbursement_ratio: Object.freeze(['reimbursement_lookup']),
  renewal: Object.freeze(['renewal_lookup']),
  comparison: Object.freeze(['product_comparison', 'plan_comparison']),
});

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function selectCoreSkillKeys(context = {}) {
  const aspects = unique(Array.isArray(context.queryAspects) ? context.queryAspects : []);
  const selected = aspects.flatMap((aspect) => ASPECT_SKILL_KEYS[aspect] || []);
  return unique(selected.length ? selected : ['insurance_expert_qa']);
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
  context = {},
  skills = [],
  maxSkills = 8,
} = {}) {
  if (intent !== 'insurance_product_knowledge') return mergeByKey(skills).slice(0, maxSkills);
  const enhanced = mergeByKey(skills).map(applyManifest);
  const byKey = new Map(enhanced.map((skill) => [skill.key, skill]));
  const selectedKeys = selectCoreSkillKeys(context);
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
