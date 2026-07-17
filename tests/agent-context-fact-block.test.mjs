import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compileAgentContextFactBlock,
  normalizeAgentContextFactBlock,
} from '../server/agent-context-fact-block.service.mjs';

test('context fact block keeps controlled facts, current goal, and source-separated conflicts', () => {
  const factBlock = compileAgentContextFactBlock({
    previous: {
      conflicts: [{
        topic: '等待期',
        sources: [
          { source: '官方条款O1', conclusion: '30天' },
          { source: '培训资料M1', conclusion: '无等待期' },
        ],
      }],
    },
    currentQuestion: '计划一、二、三分别是啥',
    taskStatus: 'active',
    owner: 'insurance_expert',
    product: { productName: '寰宇尊悦高端医疗保险', updatedAt: 1_720_000_000_000 },
    productSource: 'domain_agent',
    productCandidates: {
      question: '寰宇尊悦', updatedAt: 1_720_000_000_000,
      products: ['新华保险《寰宇尊悦高端医疗保险》'],
    },
    updatedAt: 1_720_000_001_000,
  });

  assert.deepEqual(factBlock.goal, {
    question: '计划一、二、三分别是啥', status: 'active', owner: 'insurance_expert',
  });
  assert.deepEqual(factBlock.verifiedEntities.product, {
    officialName: '寰宇尊悦高端医疗保险', source: 'domain_agent', verifiedAt: 1_720_000_000_000,
  });
  assert.equal(factBlock.pendingClarification.candidates.length, 1);
  assert.equal(factBlock.conflicts[0].sources.length, 2);
});

test('context fact block rejects source-less conflict conclusions and bounds unsafe text', () => {
  const normalized = normalizeAgentContextFactBlock({
    goal: { question: `问题${'x'.repeat(2_000)}`, status: 'unknown', owner: 'other' },
    conflicts: [
      { topic: '续保', sources: [{ source: '', conclusion: '保证续保' }] },
      { topic: '免赔额', sources: [{ source: 'O1', conclusion: '1万元' }, { source: 'M1', conclusion: '0元' }] },
    ],
  });

  assert.equal(normalized.goal.question.length, 1_000);
  assert.equal(normalized.goal.status, 'active');
  assert.equal(normalized.goal.owner, 'hermes');
  assert.deepEqual(normalized.conflicts.map((item) => item.topic), ['免赔额']);
});
