import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildSalesChampionKycLabelSnapshot,
} from '../server/sales-champion-kyc-label-engine.mjs';

test('KYC snapshot keeps customer statements, advisor facts, and advisor estimates separate', () => {
  const result = buildSalesChampionKycLabelSnapshot({
    customerStatements: [{
      text: '我更习惯微信联系，最近担心缴费时间太长。',
      source: 'current_message',
      facts: [{ key: 'contact_channel', value: '微信' }],
      labels: [
        { dimension: 'communication_preference', value: '微信' },
        { dimension: 'current_concern', value: '缴费持续性顾虑' },
      ],
    }],
    businessFacts: [{
      key: 'occupation', value: '公务员', source: 'advisor_fact', evidence: '顾问已核实工作信息',
    }, {
      key: 'annual_income', value: '20万元以上', source: 'advisor_estimate',
      labels: [{ dimension: 'economic_capacity', value: 'E4' }],
    }],
  });

  assert.ok(result.confirmedFacts.some(
    (fact) => fact.key === 'contact_channel' && fact.source === 'customer_statement',
  ));
  assert.ok(result.confirmedFacts.some(
    (fact) => fact.key === 'occupation' && fact.source === 'advisor_fact',
  ));
  assert.deepEqual(result.estimatedFacts, [{
    key: 'annual_income', value: '20万元以上', source: 'advisor_estimate',
  }]);
  assert.ok(result.confirmedLabels.some(
    (label) => label.dimension === 'communication_preference' && label.value === '微信',
  ));
  assert.deepEqual(result.candidateLabels, [{
    dimension: 'economic_capacity', value: 'E4', source: 'advisor_estimate',
  }]);
});

test('age income and marriage facts never imply intent capacity or family decision labels', () => {
  const result = buildSalesChampionKycLabelSnapshot({
    customerStatements: [{
      text: '客户50多岁，已婚。',
      source: 'current_message',
      facts: [{ key: 'age_range', value: '50多岁' }, { key: 'marital_status', value: '已婚' }],
    }],
    businessFacts: [{
      key: 'annual_income', value: '20万元以上', source: 'advisor_fact',
    }],
  });

  assert.deepEqual(result.confirmedLabels, []);
  assert.deepEqual(result.candidateLabels, []);
  assert.equal(result.confirmedFacts.length, 4);
});

test('confirmed labels override the same historical candidate without changing other candidates', () => {
  const result = buildSalesChampionKycLabelSnapshot({
    customerStatements: [{
      text: '以后只要必要提醒。',
      source: 'confirmed_history',
      labels: [{ dimension: 'communication_preference', value: '只接收必要提醒' }],
    }],
    historicalLabels: [{
      dimension: 'communication_preference', value: '只接收必要提醒', status: 'candidate',
    }, {
      dimension: 'current_concern', value: '顾虑尚未明确', status: 'candidate',
    }],
  });

  assert.deepEqual(result.confirmedLabels, [{
    dimension: 'communication_preference',
    value: '只接收必要提醒',
    source: 'customer_statement',
    evidence: '以后只要必要提醒。',
  }]);
  assert.deepEqual(result.candidateLabels, [{
    dimension: 'current_concern', value: '顾虑尚未明确', source: 'history',
  }]);
});

test('KYC snapshot reports conflicting confirmed facts without silently choosing one', () => {
  const result = buildSalesChampionKycLabelSnapshot({
    customerStatements: [{
      text: '我现在一年收入大概15万。', source: 'current_message',
      facts: [{ key: 'annual_income', value: '15万元' }],
    }],
    businessFacts: [{
      key: 'annual_income', value: '20万元', source: 'advisor_fact',
    }],
  });

  assert.deepEqual(result.conflicts, [{
    type: 'fact_value_conflict',
    key: 'annual_income',
    values: ['15万元', '20万元'],
    sources: ['customer_statement', 'advisor_fact'],
  }]);
});

test('KYC snapshot validates all labels against the registered taxonomy', () => {
  assert.throws(() => buildSalesChampionKycLabelSnapshot({
    historicalLabels: [{ dimension: 'purchase_intent', value: 'I9', status: 'confirmed' }],
  }), /value is not registered/u);
  assert.throws(() => buildSalesChampionKycLabelSnapshot({
    businessFacts: [{
      key: 'income', value: '20万元', source: 'advisor_estimate',
      labels: [{ dimension: 'unknown_dimension', value: 'X1' }],
    }],
  }), /dimension is not registered/u);
});

test('KYC snapshot consumes interpreter labels without upgrading advisor inference', () => {
  const result = buildSalesChampionKycLabelSnapshot({
    businessFacts: [{
      key: 'insurance_attitude', value: '比较抗保', source: 'advisor_inference',
      evidence: '我感觉他比较抗保',
    }],
    recognizedLabels: [{
      dimension: 'resistance', value: 'K4', status: 'candidate',
      source: 'advisor_inference', evidence: '我感觉他比较抗保',
    }],
  });

  assert.equal(result.estimatedFacts[0].source, 'advisor_estimate');
  assert.deepEqual(result.candidateLabels, [{
    dimension: 'resistance', value: 'K4', source: 'advisor_estimate', evidence: '我感觉他比较抗保',
  }]);
  assert.throws(() => buildSalesChampionKycLabelSnapshot({
    recognizedLabels: [{
      dimension: 'resistance', value: 'K4', status: 'confirmed',
      source: 'advisor_inference', evidence: '我感觉他比较抗保',
    }],
  }), /must remain candidate/u);
});
