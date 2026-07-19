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
import {
  buildSalesChampionExecutionPlan,
  buildSalesChampionInformationFollowUp,
  evaluateSalesChampionRoute,
} from '../server/sales-champion-router.service.mjs';
import {
  SALES_CHAMPION_TRAINING_PACKS,
  SALES_CHAMPION_TRAINING_SOURCES,
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

test('sales turn contract rejects history evidence mislabeled as current message', () => {
  assert.throws(
    () => validateSalesTurnProposal(validProposal({
      customerStatements: [{ text: '历史里已经确认的事实', source: 'current_message' }],
    }), {
      sourceTexts: ['本轮只是补充另一件事', '历史里已经确认的事实'],
    }),
    /customerStatements\[0\]\.source does not match evidence/u,
  );
});

test('sales turn contract rejects advisor context mislabeled as a customer statement', () => {
  assert.throws(
    () => validateSalesTurnProposal(validProposal({
      customerStatements: [],
      kycFacts: [{
        key: 'existing_insurance',
        value: '已有一项安排',
        source: 'customer_statement',
        evidence: '人家不是已经有一项安排吗',
      }],
    }), {
      sourceTexts: ['人家不是已经有一项安排吗'],
    }),
    /kycFacts\[0\]\.source requires explicit customer attribution/u,
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
    'uncover_real_objection_with_reverse_question',
    'facilitate_family_decision',
  ]);
  assert.equal(result.trainingPacks.every(
    (pack) => pack.source === 'cheng-jiye-practical-sales-2026-07',
  ), true);
  assert.equal(result.executionPlan.primary.key, 'uncover_real_objection_with_reverse_question');
  assert.deepEqual(result.executionPlan.supporting.map((pack) => pack.key), [
    'facilitate_family_decision',
  ]);
  assert.equal(result.executionPlan.fallbackUsed, false);
  assert.deepEqual(result.informationFollowUp.questions.map((item) => item.key), [
    'future_fund_use',
    'product_contract',
  ]);
  assert.equal(result.informationFollowUp.questions[1].owner, 'insurance_expert');
});

test('information follow-up keeps only two high-impact questions across multiple skills', () => {
  const followUp = buildSalesChampionInformationFollowUp(validProposal({
    concerns: [
      { type: 'duration', priority: 'primary', confidence: 0.93 },
      { type: 'family_decision', priority: 'secondary', confidence: 0.81 },
    ],
    missingInformation: [
      'objection_reason', 'customer_goal', 'future_fund_use', 'budget', 'family_decision_process',
      'product_contract', 'cash_value_schedule',
    ],
  }));

  assert.equal(followUp.maxQuestions, 2);
  assert.deepEqual(followUp.questions.map((item) => item.key), [
    'objection_reason',
    'customer_goal',
  ]);
  assert.equal(followUp.questions.every((item) => item.askCustomerIfUnknown), true);
});

test('information follow-up asks nothing after refusal or stop-contact', () => {
  const followUp = buildSalesChampionInformationFollowUp(validProposal({
    signals: { explicitRefusal: true, stopContact: false, factSensitive: false },
  }));
  assert.deepEqual(followUp.questions, []);
});

test('information follow-up asks nothing while correcting prior context', () => {
  const followUp = buildSalesChampionInformationFollowUp(validProposal({
    turnRelation: { value: 'correction', confidence: 1 },
    missingInformation: ['customer_goal', 'objection_reason', 'budget'],
  }));
  assert.deepEqual(followUp.questions, []);
});

test('long payment without a confirmed secondary cause asks the objection reason first', () => {
  const followUp = buildSalesChampionInformationFollowUp(validProposal({
    concerns: [{ type: 'duration', priority: 'primary', confidence: 0.94 }],
    situations: ['long_payment_commitment'],
    missingInformation: ['customer_goal', 'future_fund_use'],
  }));

  assert.deepEqual(followUp.questions.map((item) => item.key), [
    'objection_reason',
    'customer_goal',
  ]);
  assert.match(followUp.questions[0].askCustomerIfUnknown, /具体最卡您的是哪一点/u);
  assert.doesNotMatch(followUp.questions[0].askCustomerIfUnknown, /还是/u);
});

test('training execution plan keeps one primary and at most six supporting packs', () => {
  const packs = [
    { key: 'primary' },
    { key: 'support-a' },
    { key: 'support-b' },
    { key: 'support-c' },
    { key: 'support-d' },
    { key: 'support-e' },
    { key: 'support-f' },
    { key: 'ignored' },
  ];
  assert.deepEqual(buildSalesChampionExecutionPlan(packs), {
    primary: { key: 'primary' },
    supporting: [
      { key: 'support-a' },
      { key: 'support-b' },
      { key: 'support-c' },
      { key: 'support-d' },
      { key: 'support-e' },
      { key: 'support-f' },
    ],
    fallbackUsed: false,
  });
  assert.deepEqual(buildSalesChampionExecutionPlan(), {
    primary: null,
    supporting: [],
    fallbackUsed: true,
  });
});

test('explicit situation training pack outranks generic packs with the same capability', () => {
  const packs = getSalesChampionTrainingPacks(['needs_discovery', 'fact_sensitive_routing'], {
    stage: 'objection',
    concerns: ['underwriting'],
    situations: ['age_based_purchase_delay'],
  });

  assert.equal(packs[0].key, 'handle_age_based_delay_without_scare');
  assert.match(packs[0].selectionReason, /^explicit_situation/u);
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
    { id: 'yirong-66-tips-2026-07', status: 'active' },
    { id: 'cheng-jiye-atomic-skills-2026-07', status: 'active' },
    { id: 'wenxian-meeting-close-skills-2026-07', status: 'active' },
    { id: 'ye-yunyan-customer-operation-skills-2026-07', status: 'active' },
    { id: 'yi-rong-health-sales-skills-2026-07', status: 'active' },
    { id: 'daxiang-huibao-sales-skills-2026-07', status: 'active' },
  ]);
});

test('registered customer-operation skills are available to semantic situation recall', () => {
  const packs = getSalesChampionTrainingPacks(['follow_up_consent'], {
    stage: 'contact',
    concerns: ['unknown'],
    situations: ['yeyunyan_client_contact_planning'],
  });

  assert.equal(packs[0]?.key, 'yeyunyan_client_contact_planning');
  assert.equal(packs[0]?.source, 'ye-yunyan-customer-operation-skills-2026-07');
});

test('unknown contact permission weights customer-operation skills without hard blocking them', () => {
  const packs = getSalesChampionTrainingPacks(['follow_up_consent'], {
    stage: 'contact',
    concerns: ['unknown'],
    situations: ['yeyunyan_client_contact_planning'],
    customerLabels: [{
      dimension: 'contact_permission', value: 'B0', status: 'candidate',
      source: 'advisor_inference', evidence: '尚未确认联系边界', confidence: 0.8,
    }],
  });

  assert.equal(packs[0]?.key, 'yeyunyan_client_contact_planning');
  assert.ok(packs[0].labelScore > 0);
});

test('unknown contact permission lowers a high-value sales skill score without excluding it', () => {
  const packs = getSalesChampionTrainingPacks(['reputation_objection'], {
    stage: 'contact',
    concerns: ['trust'],
    situations: ['chengjiye_high_net_worth_authentic_positioning'],
    customerLabels: [{
      dimension: 'contact_permission', value: 'B0', status: 'candidate',
      source: 'advisor_inference', evidence: '尚未确认联系边界', confidence: 0.8,
    }],
  });

  assert.equal(packs[0]?.key, 'chengjiye_high_net_worth_authentic_positioning');
  assert.ok(packs[0].labelScore < 0);
});

test('explicit stop-contact labels remain a hard safety exclusion', () => {
  const packs = getSalesChampionTrainingPacks(['follow_up_consent'], {
    stage: 'contact',
    concerns: ['unknown'],
    situations: ['yeyunyan_client_contact_planning'],
    customerLabels: [{
      dimension: 'contact_permission', value: 'B4', status: 'confirmed',
      source: 'customer_statement', evidence: '不要再联系我', confidence: 1,
    }],
  });

  assert.deepEqual(packs, []);
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

test('orphan policy service request reaches the Cheng Jiye skill through the full route', () => {
  const statement = '客户明确只要服务';
  const result = evaluateSalesChampionRoute({
    proposal: validProposal({
      customerStatements: [{ text: statement, source: 'current_message' }],
      stage: { value: 'post_sale', confidence: 0.95 },
      concerns: [{ type: 'follow_up', priority: 'primary', confidence: 0.94 }],
      signals: { explicitRefusal: false, stopContact: false, factSensitive: false },
      missingInformation: ['contact_preference'],
      proposedCapabilities: ['follow_up_consent'],
      insuranceNeeds: [],
      situations: ['orphan_policy'],
    }),
    sourceTexts: [statement],
  });

  assert.equal(result.status, 'routed');
  assert.equal(result.selection.primary.key, 'follow_up_consent');
  assert.equal(result.trainingPacks[0].key, 'serve_orphan_policy_before_selling');
  assert.equal(result.trainingPacks[0].source, 'cheng-jiye-practical-sales-2026-07');
});

test('new Cheng Jiye scenarios route to the distilled field method', () => {
  const cases = [
    {
      expected: 'compare_online_and_advisor_service_fairly',
      capabilities: ['reputation_objection', 'fact_sensitive_routing'],
      stage: 'objection', concerns: ['trust'], situations: ['online_purchase_comparison'],
    },
    {
      expected: 'turn_phone_question_into_low_pressure_meeting',
      capabilities: ['appointment_scope'],
      stage: 'appointment', concerns: ['follow_up'], situations: ['phone_only_appointment'],
    },
    {
      expected: 'reengage_after_proposal_silence',
      capabilities: ['follow_up_consent'],
      stage: 'objection', concerns: ['follow_up'], situations: ['silent_after_proposal'],
    },
    {
      expected: 'handle_anti_insurance_content_with_evidence',
      capabilities: ['reputation_objection', 'fact_sensitive_routing'],
      stage: 'objection', concerns: ['trust'], situations: ['anti_insurance_content'],
    },
    {
      expected: 'request_referral_after_earned_trust',
      capabilities: ['referral_request', 'follow_up_consent'],
      stage: 'post_sale', concerns: ['follow_up'], situations: ['consented_referral'],
    },
    {
      expected: 'diagnose_maturing_deposit_before_transfer',
      capabilities: ['needs_discovery'],
      stage: 'discovery', concerns: ['product_fit'], situations: ['maturing_deposit'],
    },
    {
      expected: 'explain_insurer_safety_without_guarantees',
      capabilities: ['reputation_objection', 'fact_sensitive_routing'],
      stage: 'objection', concerns: ['insurer_safety'], situations: ['insurer_failure_concern'],
    },
    {
      expected: 'support_cooling_off_surrender_choice',
      capabilities: ['cooling_off_support'],
      stage: 'post_sale', concerns: ['surrender'], situations: ['cooling_off_surrender'],
    },
    {
      expected: 'explain_insurance_value_in_customer_language',
      capabilities: ['plain_language_explanation'],
      stage: 'proposal', concerns: ['benefits'], situations: ['insurance_value_explanation'],
    },
  ];

  for (const item of cases) {
    const packs = getSalesChampionTrainingPacks(item.capabilities, item);
    assert.equal(packs[0]?.key, item.expected, item.expected);
  }
});

test('second-wave Cheng Jiye scenarios route without duplicating broad methods', () => {
  const cases = [
    ['handle_low_rate_objection_without_prediction', ['tradeoff_disclosure', 'plain_language_explanation'], 'objection', ['benefits'], ['low_rate_objection']],
    ['explain_critical_illness_price_change_with_evidence', ['plain_language_explanation', 'fact_sensitive_routing'], 'objection', ['affordability'], ['critical_illness_price_increase']],
    ['compare_gold_and_insurance_by_job', ['tradeoff_disclosure', 'plain_language_explanation'], 'objection', ['benefits'], ['gold_comparison']],
    ['discuss_forced_saving_fit_without_judgment', ['needs_discovery', 'tradeoff_disclosure'], 'discovery', ['product_fit'], ['forced_saving_fit']],
    ['bring_family_objection_into_same_conversation', ['family_joint_decision', 'follow_up_consent'], 'objection', ['family_decision'], ['family_member_opposition']],
    ['open_with_acquaintance_without_relationship_debt', ['appointment_scope', 'needs_discovery'], 'contact', ['trust'], ['acquaintance_opening']],
    ['revisit_existing_policy_goal_before_add_on', ['needs_discovery', 'fact_sensitive_routing'], 'objection', ['product_fit'], ['already_bought_too_much']],
    ['discover_wealth_preservation_goal_without_promises', ['needs_discovery', 'five_question_diagnosis'], 'discovery', ['product_fit'], ['wealth_preservation_goal']],
    ['address_advisor_continuity_before_long_commitment', ['reputation_objection', 'follow_up_consent'], 'objection', ['trust'], ['advisor_continuity_concern']],
  ];

  for (const [expected, capabilities, stage, concerns, situations] of cases) {
    const packs = getSalesChampionTrainingPacks(capabilities, { stage, concerns, situations });
    assert.equal(packs[0]?.key, expected, expected);
  }
  const lowRate = getSalesChampionTrainingPacks(['tradeoff_disclosure'], {
    stage: 'objection', concerns: ['benefits'], situations: ['low_rate_objection'],
  })[0];
  assert.match(lowRate.promptRules.join('\n'), /不要围绕某个固定利率数字/u);
  assert.match(lowRate.promptRules.join('\n'), /未来走势明确说成未知/u);
});

test('second-wave situations survive capability validation through the full route', () => {
  const cases = [
    {
      statement: '客户觉得现在利率太低',
      stage: 'objection', concern: 'benefits',
      capabilities: ['tradeoff_disclosure', 'plain_language_explanation', 'fact_sensitive_routing'],
      situation: 'low_rate_objection', expected: 'handle_low_rate_objection_without_prediction',
    },
    {
      statement: '我想跟熟人第一次聊保险',
      stage: 'contact', concern: 'unknown', capabilities: ['needs_discovery'],
      situation: 'acquaintance_opening', expected: 'open_with_acquaintance_without_relationship_debt',
    },
  ];

  for (const item of cases) {
    const result = evaluateSalesChampionRoute({
      proposal: validProposal({
        customerStatements: [{ text: item.statement, source: 'current_message' }],
        stage: { value: item.stage, confidence: 0.95 },
        concerns: [{ type: item.concern, priority: 'primary', confidence: 0.94 }],
        signals: { explicitRefusal: false, stopContact: false, factSensitive: false },
        missingInformation: ['customer_goal'],
        proposedCapabilities: item.capabilities,
        insuranceNeeds: [],
        situations: [item.situation],
      }),
      sourceTexts: [item.statement],
    });
    assert.equal(result.status, 'routed', item.situation);
    assert.equal(result.trainingPacks[0]?.key, item.expected, item.situation);
  }
});

test('Yirong 66 tips routes reviewed objection scenarios without unsafe course language', () => {
  const cases = [
    ['handle_age_based_delay_without_scare', ['needs_discovery', 'fact_sensitive_routing'], 'objection', ['underwriting'], 'age_based_purchase_delay'],
    ['compare_term_and_whole_life_by_goal', ['tradeoff_disclosure', 'fact_sensitive_routing'], 'objection', ['duration'], 'term_whole_life_choice'],
    ['review_third_party_cover_before_gap_claim', ['needs_discovery', 'fact_sensitive_routing'], 'objection', ['product_fit'], 'third_party_cover_overlap'],
    ['compare_cancer_only_and_critical_illness_roles', ['plain_language_explanation', 'fact_sensitive_routing'], 'objection', ['claims'], 'cancer_only_cover_overlap'],
    ['separate_crowdfunding_from_contractual_cover', ['risk_pooling_explanation'], 'objection', ['risk_pooling'], 'crowdfunding_substitute'],
    ['handle_underwriting_restriction_without_pressure', ['needs_discovery', 'fact_sensitive_routing'], 'objection', ['underwriting'], 'underwriting_restriction'],
    ['compare_disease_counts_by_relevant_terms', ['tradeoff_disclosure', 'fact_sensitive_routing'], 'objection', ['claims'], 'disease_count_comparison'],
    ['explain_claims_process_without_guarantee', ['reputation_objection', 'fact_sensitive_routing'], 'objection', ['claims'], 'claims_process_concern'],
    ['compare_similar_plan_prices_with_evidence', ['tradeoff_disclosure', 'fact_sensitive_routing'], 'objection', ['affordability'], 'similar_plan_price_difference'],
    ['explain_risk_pooling_when_premium_feels_wasted', ['risk_pooling_explanation', 'plain_language_explanation'], 'objection', ['risk_pooling'], 'premium_wasted_objection'],
    ['protect_budget_when_debt_competes_with_cover', ['five_question_diagnosis', 'tradeoff_disclosure'], 'objection', ['affordability'], 'debt_budget_constraint'],
    ['decline_rebate_and_explain_service_scope', ['rebate_request_handling', 'reputation_objection'], 'objection', ['rebate'], 'rebate_request'],
    ['turn_vague_postponement_into_customer_choice', ['follow_up_consent', 'five_question_diagnosis'], 'objection', ['follow_up'], 'postpone_without_date'],
    ['verify_existing_coverage_amount_before_gap_claim', ['needs_discovery', 'fact_sensitive_routing'], 'objection', ['product_fit'], 'existing_coverage_amount'],
    ['surface_advisor_fit_concern_directly', ['reputation_objection', 'follow_up_consent'], 'objection', ['trust'], 'advisor_fit_concern'],
    ['balance_long_term_savings_and_liquidity', ['needs_discovery', 'tradeoff_disclosure', 'fact_sensitive_routing'], 'objection', ['liquidity'], 'long_term_savings_liquidity'],
    ['respond_to_insurance_superstition_respectfully', ['plain_language_explanation', 'reputation_objection'], 'objection', ['trust'], 'insurance_superstition'],
  ];

  for (const [expected, capabilities, stage, concerns, situation] of cases) {
    const packs = getSalesChampionTrainingPacks(capabilities, { stage, concerns, situations: [situation] });
    assert.equal(packs[0]?.key, expected, situation);
    assert.equal(packs[0]?.source, 'yirong-66-tips-2026-07', situation);
    assert.match(packs[0]?.evidenceRefs[0] || '', /^local:yirong-66-tips:/u, situation);
  }

  const combinedRules = cases.flatMap(([, capabilities, stage, concerns, situation]) => (
    getSalesChampionTrainingPacks(capabilities, { stage, concerns, situations: [situation] })[0]?.promptRules || []
  )).join('\n');
  assert.doesNotMatch(combinedRules, /抗保分子|国家兜底/u);
  assert.match(combinedRules, /不得承诺百分之百能赔/u);
  assert.match(combinedRules, /不要把未成交叫飞单/u);
});

test('Yirong situation survives contract validation through the full route', () => {
  const statement = '客户说有房贷车贷，没有余钱买保险';
  const result = evaluateSalesChampionRoute({
    proposal: validProposal({
      customerStatements: [{ text: statement, source: 'current_message' }],
      stage: { value: 'objection', confidence: 0.95 },
      concerns: [{ type: 'affordability', priority: 'primary', confidence: 0.94 }],
      signals: { explicitRefusal: false, stopContact: false, factSensitive: false },
      missingInformation: ['budget'],
      proposedCapabilities: ['five_question_diagnosis', 'tradeoff_disclosure'],
      insuranceNeeds: [], situations: ['debt_budget_constraint'],
    }),
    sourceTexts: [statement],
  });

  assert.equal(result.status, 'routed');
  assert.equal(result.trainingPacks[0]?.key, 'protect_budget_when_debt_competes_with_cover');
});

test('long payment method asks neutrally before handling the confirmed blocker', () => {
  const packs = getSalesChampionTrainingPacks(['tradeoff_disclosure', 'five_question_diagnosis'], {
    stage: 'objection',
    concerns: ['duration'],
    situations: ['long_payment_commitment'],
  });

  assert.equal(packs[0].key, 'clarify_long_payment_commitment');
  assert.match(packs[0].promptRules.join('\n'), /不要用四选一的话术诱导/u);
  assert.match(packs[0].promptRules.join('\n'), /中性开放问法让客户自己说具体卡点/u);
  assert.match(packs[0].promptRules.join('\n'), /围绕客户确认的那个卡点继续/u);
  assert.match(packs[0].promptRules.join('\n'), /不要拿收入证明/u);
  assert.doesNotMatch(packs[0].promptRules.join('\n'), /十年太长|十年不合适/u);
  assert.deepEqual(packs[0].evidenceRefs, ['douyin:cheng-jiye:7602564999688588584']);
});

test('explicit sales situations remain reachable across their wider real-world stage and concern range', () => {
  const cases = [
    ['clarify_long_payment_commitment', ['tradeoff_disclosure'], 'decision', ['liquidity'], 'long_payment_commitment'],
    ['serve_orphan_policy_before_selling', ['needs_discovery'], 'contact', ['trust'], 'orphan_policy'],
    ['frame_retirement_with_future_scene', ['needs_discovery'], 'objection', ['duration'], 'retirement_planning'],
    ['identify_buying_signal_and_ask_next_step', ['appointment_scope'], 'proposal', ['benefits'], 'buying_signal'],
    ['rebuild_service_trust_before_recommendation', ['reputation_objection'], 'discovery', ['follow_up'], 'service_trust_recovery'],
  ];

  for (const [expected, capabilities, stage, concerns, situation] of cases) {
    const packs = getSalesChampionTrainingPacks(capabilities, {
      stage, concerns, situations: [situation],
    });
    assert.equal(packs[0]?.key, expected);
  }
});

test('secondary Cheng Jiye methods require an explicit structured situation', () => {
  assert.equal(SALES_CHAMPION_TRAINING_PACKS.filter(
    (pack) => pack.source === 'cheng-jiye-practical-sales-2026-07',
  ).length, 41);
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
