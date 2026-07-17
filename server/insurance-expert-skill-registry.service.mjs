import fs from 'node:fs';
import path from 'node:path';
import { selectInsuranceExpertSkillCandidates } from './insurance-expert-skill-router.service.mjs';

const DEFAULT_LOCAL_SKILL_ROOT = '/Users/wenshuping/.agents/skills';

const BUILTIN_PRODUCT_SKILLS = Object.freeze([
  skill({
    key: 'product_overview',
    label: '产品概览',
    description: '解释已确认保险产品的定位、核心保障和适用查询入口。',
  }),
  skill({
    key: 'insurance_expert_qa',
    label: '保单专家通用问答',
    description: '处理保险产品相关但未命中特定原子 Skill 的通用自然语言问题，例如适合人群、产品亮点、注意事项、投保条件和客户理解。',
    requiresOfficialEvidence: true,
    tags: ['通用问答', '适合人群', '亮点', '优势', '注意事项', '投保条件', 'qa'],
  }),
  skill({
    key: 'responsibility_detail',
    label: 'C端保险责任助理',
    description: '抽取并解释保险责任、保障内容、计划责任差异和具体保障项目。',
    requiresOfficialEvidence: true,
    tags: ['责任', '保障', '计划', 'coverage', 'benefit'],
  }),
  skill({
    key: 'plan_comparison',
    label: '保障计划对比',
    description: '对比同一产品内计划一、计划二、计划三等保障计划差异。',
    requiresOfficialEvidence: true,
    tags: ['计划', '对比', 'comparison'],
  }),
  skill({
    key: 'product_comparison',
    label: '产品对比',
    description: '对比两个或多个保险产品的责任、等待期、免赔、报销、续保和替换风险。',
    requiresOfficialEvidence: true,
    tags: ['产品对比', 'comparison', 'compare'],
  }),
  skill({ key: 'exclusion_lookup', label: '免责查询', description: '查询责任免除、不保事项。', requiresOfficialEvidence: true, tags: ['免责', '不保'] }),
  skill({ key: 'waiting_period_lookup', label: '等待期查询', description: '查询等待期规则。', requiresOfficialEvidence: true, tags: ['等待期'] }),
  skill({ key: 'deductible_lookup', label: '免赔额查询', description: '查询免赔额、年度免赔额。', requiresOfficialEvidence: true, tags: ['免赔'] }),
  skill({ key: 'reimbursement_lookup', label: '报销比例查询', description: '查询报销比例、赔付方式和费用补偿规则。', requiresOfficialEvidence: true, tags: ['报销', '赔付'] }),
  skill({ key: 'renewal_lookup', label: '续保查询', description: '查询续保、保证续保和保险期间。', requiresOfficialEvidence: true, tags: ['续保'] }),
  skill({ key: 'official_terms_retrieval', label: '官方条款检索', description: '检索官方 PDF、官网条款和已审核资料。', tags: ['官方', '条款', 'source'] }),
  skill({ key: 'approved_material_retrieval', label: '已审核资料检索', description: '检索企业已发布且审核通过的产品资料。', tags: ['资料', 'material'] }),
  skill({ key: 'evidence_validation', label: '证据校验', description: '校验是否已覆盖用户问题所需证据。' }),
]);

const BUILTIN_FAMILY_SKILLS = Object.freeze([
  skill({ key: 'family_summary', label: '家庭保单摘要', description: '查询授权家庭保单摘要。' }),
  skill({ key: 'coverage_report', label: '家庭保障报告', description: '查询授权家庭保障报告。' }),
  skill({ key: 'evidence_validation', label: '证据校验', description: '校验证据完整性。' }),
]);

function text(value, limit = 2_000) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function skill({
  key,
  label,
  description,
  tags = [],
  source = 'builtin',
  path: skillPath = '',
  requiresOfficialEvidence = false,
  safetyBoundaries = [],
} = {}) {
  return Object.freeze({
    key: text(key, 120),
    label: text(label || key, 120),
    description: text(description, 500),
    tags: Object.freeze([...new Set(tags.map((item) => text(item, 80)).filter(Boolean))]),
    source,
    path: text(skillPath, 1_000),
    requiresOfficialEvidence: Boolean(requiresOfficialEvidence),
    safetyBoundaries: Object.freeze(safetyBoundaries.map((item) => text(item, 200)).filter(Boolean).slice(0, 8)),
  });
}

function skillKeyFromName(name = '', fallback = '') {
  const raw = text(name || fallback, 120).normalize('NFKC').toLowerCase();
  return raw.replace(/[^a-z0-9\u4e00-\u9fa5]+/gu, '_').replace(/^_+|_+$/gu, '').slice(0, 80);
}

function parseFrontMatter(markdown = '') {
  const match = markdown.match(/^---\n([\s\S]*?)\n---/u);
  if (!match) return {};
  return Object.fromEntries(match[1].split('\n').map((line) => {
    const index = line.indexOf(':');
    if (index < 0) return null;
    return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
  }).filter(Boolean));
}

function safetyBoundariesFromMarkdown(markdown = '') {
  const boundaries = [];
  for (const line of markdown.split('\n')) {
    const normalized = text(line
      .replace(/^[-*#✅❌\s]+/u, '')
      .replace(/^[a-z_][a-z0-9_-]*\s*:\s*/iu, ''), 240);
    if (!normalized) continue;
    if (/NEVER|不得|禁止|不提供|不建议|No external APIs|No policy purchases|local/i.test(normalized)) {
      boundaries.push(normalized);
    }
    if (boundaries.length >= 8) break;
  }
  return boundaries;
}

function isInsuranceSkillCandidate(value = '') {
  return /insurance|policy|coverage|claim|underwriting|annuity|premium|actuarial|benefit|liability|保险|保单|保障|理赔|核保|责任|医疗险|寿险|年金/u.test(value);
}

export function loadLocalInsuranceExpertSkills({
  skillRoot = DEFAULT_LOCAL_SKILL_ROOT,
  maxSkills = 500,
} = {}) {
  if (!skillRoot || !fs.existsSync(skillRoot)) return [];
  const entries = fs.readdirSync(skillRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(skillRoot, entry.name, 'SKILL.md'))
    .filter((skillPath) => fs.existsSync(skillPath))
    .sort((left, right) => left.localeCompare(right));
  const skills = [];
  for (const skillPath of entries) {
    const markdown = fs.readFileSync(skillPath, 'utf8');
    const frontMatter = parseFrontMatter(markdown);
    const name = text(frontMatter.name || path.basename(path.dirname(skillPath)), 120);
    const description = text(frontMatter.description, 500);
    if (!isInsuranceSkillCandidate(`${name} ${description}`)) continue;
    skills.push(skill({
      key: skillKeyFromName(name, path.basename(path.dirname(skillPath))),
      label: name,
      description,
      source: 'local_skill',
      path: skillPath,
      safetyBoundaries: safetyBoundariesFromMarkdown(markdown),
      tags: [name, description].filter(Boolean),
    }));
    if (skills.length >= maxSkills) break;
  }
  return skills;
}

function mergeSkills(skills) {
  const byKey = new Map();
  for (const item of skills) {
    if (!item?.key || byKey.has(item.key)) continue;
    byKey.set(item.key, item);
  }
  return [...byKey.values()];
}

export function createInsuranceExpertSkillRegistry({
  localSkills = null,
  skillRoot = DEFAULT_LOCAL_SKILL_ROOT,
} = {}) {
  const loadedLocalSkills = Array.isArray(localSkills)
    ? localSkills
    : loadLocalInsuranceExpertSkills({ skillRoot });
  const productSkills = mergeSkills([...BUILTIN_PRODUCT_SKILLS, ...loadedLocalSkills]);
  const familySkills = [...BUILTIN_FAMILY_SKILLS];

  function skillsForIntent(intent, context = {}) {
    const base = intent === 'insurance_product_knowledge' ? productSkills : familySkills;
    if (intent === 'insurance_product_knowledge') {
      return selectInsuranceExpertSkillCandidates({
        intent,
        context,
        skills: base,
        maxSkills: 8,
      });
    }
    return base;
  }

  return Object.freeze({
    skillsForIntent,
    skillKeysForIntent(intent, context = {}) {
      return skillsForIntent(intent, context).map((item) => item.key);
    },
    officialFactSkillKeys(intent, context = {}) {
      return new Set(skillsForIntent(intent, context)
        .filter((item) => item.requiresOfficialEvidence)
        .map((item) => item.key));
    },
  });
}

export function formatSkillRegistryForPrompt(skills = []) {
  return skills.map((definition) => {
    const safety = definition.safetyBoundaries?.length
      ? ` 安全边界：${definition.safetyBoundaries.slice(0, 2).join('；')}`
      : '';
    return `- ${definition.key}｜${definition.label}：${definition.description}${safety}`;
  }).join('\n');
}
