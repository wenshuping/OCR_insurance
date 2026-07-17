import assert from 'node:assert/strict';
import test from 'node:test';

import { createInsuranceExpertTool } from '../server/insurance-expert-tool.service.mjs';
import { createInsuranceExpertSkillRegistry } from '../server/insurance-expert-skill-registry.service.mjs';

function result() {
  return {
    facts: { certainty: 'supported' },
    provenance: { source: 'official' },
    presentation: { message: '保险结论' },
    interaction: { type: 'answer', text: '保险结论' },
  };
}

test('insurance expert invokes only an allowed private domain action', async () => {
  const calls = [];
  const tool = createInsuranceExpertTool({ execute(action, context) {
    calls.push({ action, context });
    return result();
  } });
  const output = await tool.askInsuranceExpertTool({ context: {
    internalUserId: 7,
    intent: 'insurance_product_knowledge',
    question: '比较两款产品',
    resolvedProducts: [
      { canonicalProductId: 'a', company: '甲保险', officialName: '甲产品' },
      { canonicalProductId: 'b', company: '乙保险', officialName: '乙产品' },
    ],
    queryAspects: ['comparison'],
    tool: 'product_knowledge_search',
  } });
  assert.equal(calls[0].action, 'product_knowledge_search');
  assert.equal(output.provenance.domainAgent, 'insurance_expert');
  assert.equal(output.provenance.agentAsTool, true);
});

test('insurance expert planner selects atomic skills before the domain action executes', async () => {
  let received;
  const expertPlan = {
    skills: ['plan_comparison', 'official_terms_retrieval', 'evidence_validation'],
    queryAspects: ['main_responsibilities'],
    evidenceGoals: ['展开三个计划包含的具体责任'],
    maxRetrievalRounds: 2,
    reason: '客户追问计划内容',
  };
  const tool = createInsuranceExpertTool({
    planner: { async plan() { return expertPlan; } },
    execute(_action, context) { received = context; return result(); },
  });

  await tool.askInsuranceExpertTool({ context: {
    internalUserId: 7,
    intent: 'insurance_product_knowledge',
    question: '计划一、计划二、计划三分别是啥',
    queryAspects: ['comparison', 'main_responsibilities'],
  } });

  assert.deepEqual(received.expertPlan, { ...expertPlan, maxRetrievalRounds: 1 });
});

test('insurance expert retries only its planned loop when evidence validation is incomplete', async () => {
  const rounds = [];
  const tool = createInsuranceExpertTool({
    planner: { async plan() {
      return {
        skills: ['official_terms_retrieval', 'evidence_validation'],
        queryAspects: ['main_responsibilities'],
        evidenceGoals: ['取得完整责任名称'],
        maxRetrievalRounds: 2,
      };
    } },
    execute(_action, context) {
      rounds.push(context.expertPlan.maxRetrievalRounds);
      return {
        ...result(),
        retrieval: context.expertPlan.maxRetrievalRounds === 1
          ? { completeness: 'incomplete', missingEvidence: ['complete_responsibility_summary'] }
          : { completeness: 'complete', missingEvidence: [] },
      };
    },
  });

  const output = await tool.askInsuranceExpertTool({ context: {
    internalUserId: 7,
    intent: 'insurance_product_knowledge',
    question: '具体有哪些责任',
  } });

  assert.deepEqual(rounds, [1, 2]);
  assert.equal(output.retrieval.completeness, 'complete');
});

test('insurance expert drops caller-supplied raw facts and rejects other agent intents', async () => {
  let received;
  const tool = createInsuranceExpertTool({ execute(_action, context) { received = context; return result(); } });
  await tool.askInsuranceExpertTool({ context: {
    internalUserId: 7, intent: 'insurance_product_knowledge', question: '查询', rawOcr: 'secret',
  } });
  assert.equal(received.rawOcr, undefined);
  await assert.rejects(tool.askInsuranceExpertTool({ context: {
    internalUserId: 7, intent: 'sales_coaching', question: '话术',
  } }), /not allowed/u);
  await assert.rejects(tool.askInsuranceExpertTool({ context: {
    internalUserId: 7,
    intent: 'insurance_product_knowledge',
    tool: 'create_upload_link',
    question: '查询',
  } }), /tool is not allowed/u);
});

test('insurance expert returns a structured timeout error', async () => {
  const tool = createInsuranceExpertTool({
    timeoutMs: 5,
    execute: () => new Promise(() => {}),
  });
  await assert.rejects(
    tool.askInsuranceExpertTool({ context: {
      internalUserId: 7, intent: 'coverage_report', question: '保障报告', familyId: 1,
    } }),
    (error) => error.code === 'AGENT_TIMEOUT' && error.status === 504,
  );
});

test('insurance expert tool rejects a local skill not authorized by semantic aspects', async () => {
  let executeCalled = false;
  const skillRegistry = createInsuranceExpertSkillRegistry({
    localSkills: [{
      key: 'insurance',
      label: 'insurance',
      description: 'Local-first insurance record organizer for policies, renewals and claims logs.',
      source: 'local_skill',
    }],
  });
  const tool = createInsuranceExpertTool({
    skillRegistry,
    planner: { async plan() {
      return {
        skills: ['insurance', 'evidence_validation'],
        queryAspects: [],
        evidenceGoals: ['记录续期'],
        maxRetrievalRounds: 1,
      };
    } },
    execute() { executeCalled = true; return result(); },
  });

  await assert.rejects(tool.askInsuranceExpertTool({ context: {
    internalUserId: 7, intent: 'insurance_product_knowledge', question: '帮我记录保单续期',
  } }), /unauthorized skill/u);
  assert.equal(executeCalled, false);
});
