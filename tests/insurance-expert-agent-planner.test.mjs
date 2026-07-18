import assert from 'node:assert/strict';
import test from 'node:test';

import { createInsuranceExpertAgentPlanner } from '../server/insurance-expert-agent-planner.service.mjs';
import { createInsuranceExpertSkillRegistry } from '../server/insurance-expert-skill-registry.service.mjs';

function response(content, ok = true) {
  return { ok, async json() { return { choices: [{ message: { content } }] }; } };
}

test('insurance expert agent plans plan comparison and complete official evidence from the customer question', async () => {
  let requestBody;
  const planner = createInsuranceExpertAgentPlanner({
    env: { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_BASE_URL: 'https://model.test' },
    async fetchImpl(_url, init) {
      requestBody = JSON.parse(init.body);
      return response(JSON.stringify({
        skills: ['plan_comparison', 'official_terms_retrieval', 'evidence_validation'],
        queryAspects: ['main_responsibilities'],
        evidenceGoals: ['列明每个计划包含的具体保险责任名称和主要内容'],
        maxRetrievalRounds: 2,
        reason: '客户要求展开计划差异',
      }));
    },
  });

  const plan = await planner.plan({
    intent: 'insurance_product_knowledge',
    question: '计划一、计划二、计划三分别是啥',
    resolvedProduct: { company: '新华保险', officialName: '寰宇尊悦高端医疗保险' },
    queryAspects: ['comparison', 'main_responsibilities'],
  });

  assert.deepEqual(plan.skills, ['plan_comparison', 'official_terms_retrieval', 'evidence_validation']);
  assert.equal(plan.maxRetrievalRounds, 2);
  assert.match(requestBody.messages[0].content, /分别是啥.*展开/u);
  assert.match(requestBody.messages[1].content, /计划一、计划二、计划三分别是啥/u);
});

test('insurance expert agent rejects a model plan that skips evidence validation', async () => {
  const planner = createInsuranceExpertAgentPlanner({
    env: { DEEPSEEK_API_KEY: 'test-key' },
    fetchImpl: async () => response(JSON.stringify({
      skills: ['plan_comparison'], queryAspects: ['main_responsibilities'],
      evidenceGoals: [], maxRetrievalRounds: 1, reason: '',
    })),
  });

  await assert.rejects(
    planner.plan({ intent: 'insurance_product_knowledge', question: '三个计划分别是什么' }),
    (error) => error.code === 'INSURANCE_EXPERT_PLAN_INVALID',
  );
});

test('insurance expert plan compiler adds required official retrieval for contract fact skills', async () => {
  const planner = createInsuranceExpertAgentPlanner({
    env: { DEEPSEEK_API_KEY: 'test-key' },
    fetchImpl: async () => response(JSON.stringify({
      skills: ['plan_comparison', 'evidence_validation'],
      queryAspects: [],
      evidenceGoals: ['说明三个计划的责任差异'],
      maxRetrievalRounds: 1,
      reason: '比较保障计划',
    })),
  });

  const plan = await planner.plan({
    intent: 'insurance_product_knowledge',
    question: '三个计划分别是什么',
    queryAspects: ['comparison', 'main_responsibilities'],
  });

  assert.deepEqual(plan.skills, [
    'plan_comparison', 'official_terms_retrieval', 'evidence_validation',
  ]);
});

test('generic product questions do not expose product overview responsibility shortcut', async () => {
  const planner = createInsuranceExpertAgentPlanner({
    env: { DEEPSEEK_API_KEY: 'test-key' },
    fetchImpl: async () => response(JSON.stringify({
      skills: ['product_overview', 'evidence_validation'],
      queryAspects: [],
      evidenceGoals: ['介绍产品'],
      maxRetrievalRounds: 1,
      reason: '客户确认了要查询的产品',
    })),
  });

  await assert.rejects(
    planner.plan({
      intent: 'insurance_product_knowledge',
      question: '寰宇尊悦',
      resolvedProduct: { company: '新华保险', officialName: '寰宇尊悦高端医疗保险' },
    }),
    (error) => error.code === 'INSURANCE_EXPERT_PLAN_INVALID',
  );
});

test('generic insurance QA compiles without forcing responsibility detail', async () => {
  let requestBody;
  const planner = createInsuranceExpertAgentPlanner({
    env: { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_BASE_URL: 'https://model.test' },
    async fetchImpl(_url, init) {
      requestBody = JSON.parse(init.body);
      return response(JSON.stringify({
        skills: ['insurance_expert_qa', 'approved_material_retrieval', 'evidence_validation'],
        queryAspects: ['product_advantages'],
        evidenceGoals: ['说明产品适合人群时区分官方明确事实和基于证据的专业解读'],
        maxRetrievalRounds: 2,
        reason: '客户询问产品适合人群，属于保险专家通用问答',
      }));
    },
  });

  const plan = await planner.plan({
    intent: 'insurance_product_knowledge',
    question: '这个产品适合什么人群',
    resolvedProduct: { company: '新华保险', officialName: '医药安欣（易核版）医疗保险' },
  });

  assert.deepEqual(plan.skills, [
    'insurance_expert_qa',
    'approved_material_retrieval',
    'official_terms_retrieval',
    'evidence_validation',
  ]);
  assert.equal(plan.maxRetrievalRounds, 2);
  assert.match(requestBody.messages[0].content, /insurance_expert_qa｜保单专家通用问答/u);
  assert.equal(plan.skills.includes('responsibility_detail'), false);
});

test('insurance expert agent rejects a raw-text attempt to expose an unrelated local skill', async () => {
  let requestBody;
  const skillRegistry = createInsuranceExpertSkillRegistry({
    localSkills: [{
      key: 'insurance',
      label: 'insurance',
      description: 'Local-first insurance record organizer for policies, renewals and claims logs.',
      source: 'local_skill',
      safetyBoundaries: ['NEVER provides insurance advice.'],
    }],
  });
  const planner = createInsuranceExpertAgentPlanner({
    env: { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_BASE_URL: 'https://model.test' },
    skillRegistry,
    async fetchImpl(_url, init) {
      requestBody = JSON.parse(init.body);
      return response(JSON.stringify({
        skills: ['insurance', 'evidence_validation'],
        queryAspects: [],
        evidenceGoals: ['记录保单并提醒续期'],
        maxRetrievalRounds: 1,
        reason: '客户要求记录本地保单事项',
      }));
    },
  });

  await assert.rejects(planner.plan({
    intent: 'insurance_product_knowledge', question: '帮我记录这张保单，后面提醒续期',
  }), (error) => error.code === 'INSURANCE_EXPERT_PLAN_INVALID');
  assert.doesNotMatch(requestBody.messages[0].content, /insurance｜本地保单记录管理/u);
});
