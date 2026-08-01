import assert from 'node:assert/strict';
import test from 'node:test';
import {
  validateSalesTurnProposal,
} from '../server/sales-champion-turn.contract.mjs';
import {
  SALES_CHAMPION_SKILL_CONTRACT,
  salesChampionPromptRules,
  selectSalesChampionSkills,
} from '../server/sales-champion-skill-registry.mjs';
import { evaluateSalesTurnReadiness } from '../server/sales-champion-readiness.service.mjs';
import { evaluateSalesChampionRoute } from '../server/sales-champion-router.service.mjs';
import {
  SALES_CHAMPION_TRAINING_PACKS,
  SALES_CHAMPION_TRAINING_SOURCES,
  getSalesChampionTrainingPackBoundaryCandidates,
  getSalesChampionTrainingPacks,
  validateSalesChampionTrainingCatalog,
} from '../server/sales-champion-training-catalog.mjs';

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
  assert.deepEqual(proposal.situations, []);
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
  assert.throws(
    () => validateSalesTurnProposal(validProposal({ situations: ['guessed_rich_client'] }), {
      sourceTexts: ['钱放二十年太久'],
    }),
    /situations contains invalid value/u,
  );
});

test('sales turn contract accepts one primary plus six supporting capability candidates', () => {
  const capabilities = [
    'tradeoff_disclosure',
    'family_joint_decision',
    'five_question_diagnosis',
    'reputation_objection',
    'risk_pooling_explanation',
    'plain_language_explanation',
    'fact_sensitive_routing',
  ];
  const proposal = validateSalesTurnProposal(validProposal({ proposedCapabilities: capabilities }), {
    sourceTexts: ['钱放二十年太久'],
  });
  assert.deepEqual(proposal.proposedCapabilities, capabilities);
  assert.throws(
    () => validateSalesTurnProposal(validProposal({
      proposedCapabilities: [...capabilities, 'rebate_request_handling'],
    }), { sourceTexts: ['钱放二十年太久'] }),
    /at most 7 items/u,
  );
});

test('skill registry selects a primary skill, supporting skills, and mandatory fact routing', () => {
  const selection = selectSalesChampionSkills(validProposal());
  assert.equal(selection.navigator.key, 'sales_process_navigator');
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

test('process navigator rules are always included before final sales champion synthesis', () => {
  const selection = selectSalesChampionSkills(validProposal());
  const rules = salesChampionPromptRules(selection).join('\n');

  assert.match(rules, /先用本轮已确认事实和客户标签判断当前业务线与销售阶段/u);
  assert.match(rules, /只有没有可执行的精确或阶段能力时.*general_sales_clarification/u);
});

test('skill registry allows up to six relevant supporting skills without duplicating the primary', () => {
  const selection = selectSalesChampionSkills(validProposal({
    concerns: [
      { type: 'liquidity', priority: 'primary', confidence: 0.91 },
      { type: 'family_decision', priority: 'secondary', confidence: 0.82 },
      { type: 'trust', priority: 'secondary', confidence: 0.8 },
      { type: 'affordability', priority: 'secondary', confidence: 0.78 },
      { type: 'risk_pooling', priority: 'secondary', confidence: 0.76 },
    ],
    proposedCapabilities: [
      'tradeoff_disclosure',
      'family_joint_decision',
      'five_question_diagnosis',
      'reputation_objection',
      'risk_pooling_explanation',
      'plain_language_explanation',
      'fact_sensitive_routing',
    ],
  }));

  assert.equal(selection.primary.key, 'tradeoff_disclosure');
  assert.deepEqual(selection.supporting.map((skill) => skill.key), [
    'family_joint_decision',
    'five_question_diagnosis',
    'reputation_objection',
    'risk_pooling_explanation',
    'plain_language_explanation',
    'fact_sensitive_routing',
  ]);
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
  assert.equal(selection.navigator.key, 'sales_process_navigator');
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
    'uncover_real_objection_with_reverse_question',
  ]);
  assert.equal(result.trainingPacks.every(
    (pack) => pack.source === 'cheng-jiye-practical-sales-2026-07',
  ), true);
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

test('training catalog retains disabled legacy packs without loading them at runtime', () => {
  const packs = getSalesChampionTrainingPacks(['referral_request'], {
    stage: 'post_sale',
    concerns: ['follow_up'],
  });

  assert.deepEqual(packs, []);
  assert.equal(SALES_CHAMPION_TRAINING_PACKS.some(
    (pack) => pack.key === 'request_consented_referral',
  ), true);
  assert.deepEqual(SALES_CHAMPION_TRAINING_SOURCES.map(({ id, status }) => ({ id, status })), [
    { id: 'yanli-whole-life-sales-2026-07', status: 'disabled' },
    { id: 'yuleilei-high-client-sales-2026-07', status: 'disabled' },
    { id: 'cheng-jiye-practical-sales-2026-07', status: 'active' },
    { id: 'cheng-jiye-atomic-skills-2026-07', status: 'active' },
    { id: 'wenxian-meeting-close-skills-2026-07', status: 'active' },
    { id: 'ye-yunyan-customer-operation-skills-2026-07', status: 'active' },
    { id: 'yi-rong-health-sales-skills-2026-07', status: 'active' },
    { id: 'daxiang-huibao-sales-skills-2026-07', status: 'active' },
  ]);
});

test('training catalog validates bounded registration contracts', () => {
  assert.equal(validateSalesChampionTrainingCatalog(), true);
  assert.throws(() => validateSalesChampionTrainingCatalog({
    sources: [{ id: 'course-a', version: 1, status: 'active' }],
    packs: [{
      key: 'bad_pack',
      version: 1,
      source: 'missing-course',
      capabilities: ['needs_discovery'],
      stages: ['discovery'],
      concerns: ['unknown'],
      requiredInputs: ['customer_statements'],
      antiTriggers: ['explicit_refusal'],
      outputContract: 'question_sequence',
      allowedUse: 'goal_questions',
      officialFactsRequired: false,
      priority: 50,
    }],
  }), /unknown source/u);
});

test('training catalog applies refusal anti-triggers before loading course material', () => {
  const packs = getSalesChampionTrainingPacks(['follow_up_consent'], {
    stage: 'appointment',
    concerns: ['follow_up'],
    signals: { explicitRefusal: true, stopContact: false },
  });

  assert.deepEqual(packs, []);
});

test('training catalog returns auditable prerequisites and deterministic ranking', () => {
  const packs = getSalesChampionTrainingPacks(['tradeoff_disclosure'], {
    stage: 'objection',
    concerns: ['liquidity'],
  });

  assert.equal(packs[0].key, 'uncover_real_objection_with_reverse_question');
  assert.deepEqual(packs[0].requiredInputs, ['customer_statements', 'stage', 'concerns']);
  assert.deepEqual(packs[0].antiTriggers, ['explicit_refusal', 'stop_contact']);
  assert.match(packs[0].selectionReason, /capability\+stage\+concern/u);
});

test('training catalog can return one primary plus six relevant supporting packs', () => {
  const capabilities = [...new Set(SALES_CHAMPION_TRAINING_PACKS.flatMap(
    (pack) => pack.capabilities,
  ))];
  const concerns = [...new Set(SALES_CHAMPION_TRAINING_PACKS.flatMap(
    (pack) => pack.concerns,
  ))];
  const situations = [...new Set(SALES_CHAMPION_TRAINING_PACKS.flatMap(
    (pack) => pack.situations,
  ))];
  const packs = getSalesChampionTrainingPacks(capabilities, {
    stage: 'objection',
    concerns,
    situations,
  });

  assert.equal(packs.length, 7);
  assert.equal(new Set(packs.map((pack) => pack.key)).size, 7);
});

test('training catalog routes Cheng Jiye stage progression with reviewed conversational rules', () => {
  const packs = getSalesChampionTrainingPacks(['needs_discovery'], {
    stage: 'discovery',
    concerns: ['unknown'],
  });

  assert.equal(packs[0].key, 'advance_relationship_by_stage');
  assert.equal(packs[0].source, 'cheng-jiye-practical-sales-2026-07');
  assert.deepEqual(packs[0].evidenceRefs, [
    'douyin:cheng-jiye:7617439313277553955',
    'douyin:cheng-jiye:7630848003833711872',
  ]);
  assert.match(packs[0].promptRules.join('\n'), /信息不完整.*今天就能做的动作/u);
  assert.match(packs[0].promptRules.join('\n'), /不要使用.*顾问本轮提供.*报告腔/u);
});

test('training catalog routes Cheng Jiye field methods by customer scenario', () => {
  const opening = getSalesChampionTrainingPacks(['appointment_scope', 'needs_discovery'], {
    stage: 'contact',
    concerns: ['trust'],
    situations: ['first_insurance_conversation'],
  });
  assert.equal(opening[0].key, 'open_conversation_without_sales_pressure');
  assert.match(opening[0].promptRules.join('\n'), /买不买、何时买、找谁买都由客户决定/u);

  const followUp = getSalesChampionTrainingPacks(['follow_up_consent'], {
    stage: 'decision',
    concerns: ['follow_up'],
    situations: ['event_follow_up'],
  });
  assert.equal(followUp[0].key, 'follow_up_by_customer_intent');
  assert.match(followUp[0].promptRules.join('\n'), /不再打扰/u);

  const familyDecision = getSalesChampionTrainingPacks(['family_joint_decision'], {
    stage: 'objection',
    concerns: ['family_decision'],
  });
  assert.equal(familyDecision[0].key, 'facilitate_family_decision');
  assert.equal(familyDecision[0].source, 'cheng-jiye-practical-sales-2026-07');
  assert.match(familyDecision[0].promptRules.join('\n'), /不要让客户和顾问联手去“说服”家人/u);
});

test('secondary Cheng Jiye methods require an explicit structured situation', () => {
  assert.equal(SALES_CHAMPION_TRAINING_PACKS.filter(
    (pack) => pack.source === 'cheng-jiye-practical-sales-2026-07',
  ).length, 23);
  const generic = getSalesChampionTrainingPacks(['needs_discovery'], {
    stage: 'discovery',
    concerns: ['unknown'],
  });
  assert.equal(generic[0].key, 'advance_relationship_by_stage');
  assert.equal(generic.some((pack) => pack.key === 'interview_high_value_client_journey'), false);

  const highValue = getSalesChampionTrainingPacks(['needs_discovery', 'five_question_diagnosis'], {
    stage: 'discovery',
    concerns: ['trust'],
    situations: ['high_value_client'],
  });
  assert.equal(highValue[0].key, 'interview_high_value_client_journey');

  const medicalOverlap = getSalesChampionTrainingPacks(['plain_language_explanation', 'fact_sensitive_routing'], {
    stage: 'objection',
    concerns: ['claims'],
    situations: ['medical_critical_illness_overlap'],
  });
  assert.equal(medicalOverlap[0].key, 'explain_medical_and_critical_illness_roles');
  assert.equal(medicalOverlap[0].officialFactsRequired, true);

  const solvency = getSalesChampionTrainingPacks(['reputation_objection', 'fact_sensitive_routing'], {
    stage: 'objection',
    concerns: ['insurer_safety'],
    situations: ['solvency_concern'],
  });
  assert.equal(solvency[0].key, 'route_solvency_objection_to_official_evidence');
  assert.match(solvency[0].promptRules.join('\n'), /不替公司辩护/u);
});

test('equivalent orphan-policy facts can route the post-sale service skill without the industry label', () => {
  const result = evaluateSalesChampionRoute({
    proposal: validProposal({
      customerStatements: [{ text: '公司转给我的老保单客户', source: 'current_message' }],
      stage: { value: 'post_sale', confidence: 0.94 },
      concerns: [{ type: 'unknown', priority: 'primary', confidence: 0.9 }],
      signals: { explicitRefusal: false, stopContact: false, factSensitive: false },
      missingInformation: ['explicit_customer_request'],
      proposedCapabilities: ['needs_discovery', 'appointment_scope', 'follow_up_consent'],
      insuranceNeeds: [],
      situations: ['orphan_policy'],
    }),
    sourceTexts: ['公司转给我的老保单客户'],
  });

  assert.equal(result.status, 'routed');
  assert.equal(result.selection.primary.key, 'needs_discovery');
  assert.equal(result.trainingPacks[0].key, 'serve_orphan_policy_before_selling');
  assert.equal(result.trainingPacks[0].mappingStatus, 'confirmed');
  assert.deepEqual(result.boundaryCandidates, []);
});

test('uncertain orphan-policy context becomes a confirmation candidate instead of executing the skill', () => {
  const result = evaluateSalesChampionRoute({
    proposal: validProposal({
      customerStatements: [{ text: '第一次接触这个老保单客户', source: 'current_message' }],
      stage: { value: 'post_sale', confidence: 0.92 },
      concerns: [{ type: 'unknown', priority: 'primary', confidence: 0.89 }],
      signals: { explicitRefusal: false, stopContact: false, factSensitive: false },
      missingInformation: ['customer_relationship_origin'],
      proposedCapabilities: ['needs_discovery'],
      insuranceNeeds: [],
      situations: [],
    }),
    sourceTexts: ['第一次接触这个老保单客户'],
  });

  assert.equal(result.trainingPacks.some(
    (pack) => pack.key === 'serve_orphan_policy_before_selling',
  ), false);
  assert.deepEqual(result.boundaryCandidates, [{
    key: 'serve_orphan_policy_before_selling',
    version: 1,
    source: 'cheng-jiye-practical-sales-2026-07',
    actionSignature: 'service_first',
    mappingStatus: 'needs_confirmation',
    confirmationSlots: ['customer_relationship_origin'],
    unknownFallback: 'generic_service_first',
    excludedSignals: ['explicit_refusal', 'stop_contact'],
    selectionReason: 'capability+stage+concern+missing_boundary_slot',
  }]);
});

test('possible orphan-policy service asks only the missing relationship and service boundaries', () => {
  const result = evaluateSalesChampionRoute({
    proposal: validProposal({
      customerStatements: [{ text: '第一次接触这个老保单客户，不清楚他要办什么', source: 'current_message' }],
      stage: { value: 'post_sale', confidence: 0.92 },
      concerns: [{ type: 'unknown', priority: 'primary', confidence: 0.89 }],
      signals: { explicitRefusal: false, stopContact: false, factSensitive: false },
      missingInformation: ['customer_relationship_origin', 'current_service_task'],
      proposedCapabilities: ['needs_discovery'],
      insuranceNeeds: [],
      situations: [],
    }),
    sourceTexts: ['第一次接触这个老保单客户，不清楚他要办什么'],
  });

  const orphan = result.boundaryCandidates.find(
    (candidate) => candidate.key === 'serve_orphan_policy_before_selling',
  );
  assert.deepEqual(orphan.confirmationSlots, ['customer_relationship_origin', 'current_service_task']);
  assert.deepEqual(result.navigation.questionPlan.map((item) => item.slot), [
    'current_service_task',
    'customer_relationship_origin',
  ]);
});

test('ordinary first meeting does not become an orphan-policy candidate and refusal excludes candidates', () => {
  const ordinary = getSalesChampionTrainingPackBoundaryCandidates(['needs_discovery'], {
    stage: 'post_sale',
    concerns: ['unknown'],
    missingInformation: ['meeting_trigger'],
  });
  const refused = getSalesChampionTrainingPackBoundaryCandidates(['needs_discovery'], {
    stage: 'post_sale',
    concerns: ['unknown'],
    missingInformation: ['customer_relationship_origin'],
    signals: { explicitRefusal: true, stopContact: false },
  });

  assert.deepEqual(ordinary, []);
  assert.deepEqual(refused, []);
});
