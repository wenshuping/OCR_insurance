import assert from 'node:assert/strict';
import test from 'node:test';

import { selectInsuranceExpertSkillCandidates } from '../server/insurance-expert-skill-router.service.mjs';

const SKILLS = [
  { key: 'product_overview', label: '产品概览', description: '产品概览' },
  { key: 'insurance_expert_qa', label: '保单专家通用问答', description: '通用问答' },
  { key: 'responsibility_detail', label: 'C端保险责任助理', description: '保险责任' },
  { key: 'plan_comparison', label: '保障计划对比', description: '计划对比' },
  { key: 'product_comparison', label: '产品对比', description: '产品对比' },
  { key: 'official_terms_retrieval', label: '官方条款检索', description: '官方条款' },
  { key: 'approved_material_retrieval', label: '已审核资料检索', description: '已审核资料' },
  { key: 'evidence_validation', label: '证据校验', description: '证据校验' },
  { key: 'insurance', label: 'insurance', description: 'Local record manager', source: 'local_skill' },
  { key: 'claims_clause_locator_assistant', label: 'claims', description: 'claims clause helper', source: 'local_skill' },
];

function keys(question, context = {}) {
  return selectInsuranceExpertSkillCandidates({
    intent: 'insurance_product_knowledge',
    question,
    context: { question, ...context },
    skills: SKILLS,
  }).map((skill) => skill.key);
}

test('insurance expert skill router exposes only responsibility skills for responsibility questions', () => {
  assert.deepEqual(keys('寰宇尊悦保险责任'), [
    'responsibility_detail',
    'official_terms_retrieval',
    'evidence_validation',
  ]);
});

test('insurance expert skill router exposes plan comparison with responsibility support', () => {
  assert.deepEqual(keys('保障计划（计划一/二/三）分别是啥'), [
    'plan_comparison',
    'responsibility_detail',
    'official_terms_retrieval',
    'evidence_validation',
  ]);
});

test('insurance expert skill router keeps local record management separate from product facts', () => {
  assert.deepEqual(keys('帮我记录这张保单，后面提醒续期'), [
    'insurance',
    'evidence_validation',
  ]);
});

test('insurance expert skill router uses generic QA for common product questions', () => {
  assert.deepEqual(keys('这个产品适合什么人群', {
    resolvedProduct: { company: '新华保险', officialName: '医药安欣（易核版）医疗保险' },
  }), [
    'insurance_expert_qa',
    'official_terms_retrieval',
    'approved_material_retrieval',
    'evidence_validation',
  ]);
});

test('insurance expert skill router keeps specific skills ahead of generic QA', () => {
  assert.deepEqual(keys('保障计划（计划一/二/三）分别是啥', {
    resolvedProduct: { company: '新华保险', officialName: '寰宇尊悦高端医疗保险' },
  }), [
    'plan_comparison',
    'responsibility_detail',
    'official_terms_retrieval',
    'evidence_validation',
  ]);
});

test('insurance expert skill router keeps generic downloaded skills hidden unless selected by manifest', () => {
  assert.equal(keys('寰宇尊悦保险责任').includes('claims_clause_locator_assistant'), false);
});
