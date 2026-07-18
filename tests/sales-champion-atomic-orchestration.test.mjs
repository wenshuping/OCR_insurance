import assert from 'node:assert/strict';
import test from 'node:test';
import {
  validateSalesTurnProposal,
} from '../server/sales-champion-turn.contract.mjs';
import {
  SALES_CHAMPION_SKILL_CONTRACT,
  selectSalesChampionSkills,
} from '../server/sales-champion-skill-registry.mjs';
import { evaluateSalesTurnReadiness } from '../server/sales-champion-readiness.service.mjs';
import { evaluateSalesChampionRoute } from '../server/sales-champion-router.service.mjs';
import { getSalesChampionTrainingPacks } from '../server/sales-champion-training-catalog.mjs';

function validProposal(overrides = {}) {
  return {
    contractVersion: 1,
    customerStatements: [
      { text: '钱放二十年太久', source: 'current_message' },
    ],
    stage: { value: 'objection', confidence: 0.92 },
    concerns: [
      { type: 'liquidity', priority: 'primary', confidence: 0.91 },
      { type: 'family_decision', priority: 'secondary', confidence: 0.78 },
    ],
    signals: {
      explicitRefusal: false,
      stopContact: false,
      factSensitive: true,
    },
    missingInformation: ['future_fund_use', 'product_contract'],
    proposedCapabilities: ['tradeoff_disclosure', 'family_joint_decision'],
    insuranceNeeds: [{ type: 'product_facts', queryAspects: [] }],
    ...overrides,
  };
}

test('sales turn contract accepts grounded multi-concern proposals', () => {
  const proposal = validateSalesTurnProposal(validProposal(), {
    sourceTexts: ['客户说钱放二十年太久，但是家里人还没有讨论。'],
  });
  assert.equal(proposal.stage.value, 'objection');
  assert.deepEqual(proposal.concerns.map((concern) => concern.type), ['liquidity', 'family_decision']);
});

test('sales turn contract rejects customer statements not grounded in source text', () => {
  assert.throws(
    () => validateSalesTurnProposal(validProposal(), { sourceTexts: ['客户只是问产品期限。'] }),
    /customerStatements\[0\]\.text must be grounded/u,
  );
});

test('sales turn contract rejects unknown fields and invalid enums', () => {
  assert.throws(
    () => validateSalesTurnProposal({ ...validProposal(), hiddenPlan: 'close_now' }, {
      sourceTexts: ['钱放二十年太久'],
    }),
    /unknown field: hiddenPlan/u,
  );
  assert.throws(
    () => validateSalesTurnProposal(validProposal({
      stage: { value: 'force_close', confidence: 0.99 },
    }), { sourceTexts: ['钱放二十年太久'] }),
    /stage\.value is invalid/u,
  );
});

test('skill registry selects a primary skill, supporting skills, and mandatory fact routing', () => {
  const selection = selectSalesChampionSkills(validProposal());
  assert.equal(selection.primary.key, 'tradeoff_disclosure');
  assert.deepEqual(selection.supporting.map((skill) => skill.key), [
    'family_joint_decision',
    'fact_sensitive_routing',
  ]);
  assert.equal(selection.decision, 'execute');
  assert.equal(selection.confidence, 0.91);
  assert.equal(selection.executionContract, SALES_CHAMPION_SKILL_CONTRACT);
  assert.match(selection.executionContract.outputContract, /完整客户语义包/u);
  assert.match(selection.executionContract.outputContract, /客户已表达事实 \+ 销售阶段\/异议解读 \+ 可执行沟通建议\/话术 \+ 需要保险专家核验的事实点 \+ 不确定边界/u);
});

test('skill registry rejects a capability whose stage and concern prerequisites do not match', () => {
  const selection = selectSalesChampionSkills(validProposal({
    stage: { value: 'appointment', confidence: 0.9 },
    concerns: [{ type: 'follow_up', priority: 'primary', confidence: 0.88 }],
    signals: { explicitRefusal: false, stopContact: false, factSensitive: false },
    proposedCapabilities: ['tradeoff_disclosure', 'follow_up_consent'],
  }));
  assert.equal(selection.primary.key, 'follow_up_consent');
  assert.deepEqual(selection.rejected, [
    { key: 'tradeoff_disclosure', reason: 'stage_or_concern_mismatch' },
  ]);
});

test('skill registry falls back to generic sales champion skill when no specific capability matches', () => {
  const selection = selectSalesChampionSkills(validProposal({
    stage: { value: 'proposal', confidence: 0.9 },
    concerns: [{ type: 'unknown', priority: 'primary', confidence: 0.86 }],
    signals: { explicitRefusal: false, stopContact: false, factSensitive: false },
    proposedCapabilities: ['appointment_scope'],
  }));

  assert.equal(selection.primary.key, 'general_sales_clarification');
  assert.equal(selection.decision, 'clarify');
  assert.match(selection.executionContract.outputContract, /不得把客户自然语言降级为关键词话术/u);
});

test('readiness gate stops on refusal before selecting promotional skills', () => {
  const readiness = evaluateSalesTurnReadiness(validProposal({
    signals: { explicitRefusal: true, stopContact: false, factSensitive: false },
  }));
  assert.equal(readiness.decision, 'stop_contact');
  assert.equal(readiness.reason, 'explicit_refusal');
});

test('readiness gate clarifies low-confidence or missing concern interpretation', () => {
  const lowConfidence = evaluateSalesTurnReadiness(validProposal({
    stage: { value: 'objection', confidence: 0.52 },
  }));
  const missingConcern = evaluateSalesTurnReadiness(validProposal({ concerns: [] }));
  assert.equal(lowConfidence.decision, 'clarify');
  assert.equal(lowConfidence.reason, 'low_stage_confidence');
  assert.equal(missingConcern.decision, 'clarify');
  assert.equal(missingConcern.reason, 'missing_concern');
});

test('readiness gate marks official facts required without blocking a well-grounded turn', () => {
  const readiness = evaluateSalesTurnReadiness(validProposal());
  assert.equal(readiness.decision, 'execute');
  assert.equal(readiness.officialFactsRequired, true);
});

test('sales champion router returns a controlled route without producing a customer answer', () => {
  const result = evaluateSalesChampionRoute({
    proposal: validProposal(),
    sourceTexts: ['客户说钱放二十年太久，家里也还没有商量。'],
  });
  assert.equal(result.status, 'routed');
  assert.equal(result.readiness.decision, 'execute');
  assert.equal(result.selection.primary.key, 'tradeoff_disclosure');
  assert.equal('answer' in result, false);
  assert.equal(result.contractVersion, 1);
  assert.deepEqual(result.trainingPacks.map((pack) => pack.key), [
    'facilitate_family_decision',
    'clarify_liquidity_objection',
    'exit_mismatched_proposal',
  ]);
  assert.equal(result.trainingPacks.every((pack) => pack.source === 'yanli-whole-life-sales-2026-07'), true);
});

test('sales champion router contains invalid model proposals instead of guessing a route', () => {
  const result = evaluateSalesChampionRoute({
    proposal: { ...validProposal(), hiddenPlan: 'close_now' },
    sourceTexts: ['钱放二十年太久'],
  });
  assert.equal(result.status, 'invalid_proposal');
  assert.equal(result.readiness, null);
  assert.equal(result.selection, null);
  assert.match(result.error, /unknown field/u);
});

test('training catalog routes consented referral and privacy skills from the high-client course', () => {
  const packs = getSalesChampionTrainingPacks(['referral_request'], {
    stage: 'post_sale',
    concerns: ['follow_up'],
  });

  assert.deepEqual(packs.map((pack) => pack.key), [
    'request_consented_referral',
    'protect_network_client_privacy',
  ]);
  assert.equal(packs.every((pack) => pack.source === 'yuleilei-high-client-sales-2026-07'), true);
});

test('training catalog routes evidence-based trust skills from the high-client course', () => {
  const packs = getSalesChampionTrainingPacks(['reputation_objection'], {
    stage: 'objection',
    concerns: ['trust'],
  });

  assert.deepEqual(packs.map((pack) => pack.key), [
    'position_trusted_advisor',
    'build_evidence_based_trust',
  ]);
});
