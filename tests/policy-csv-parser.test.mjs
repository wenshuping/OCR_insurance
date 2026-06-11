import assert from 'node:assert/strict';
import test from 'node:test';

import {
  mapPolicyWorkbookToScan,
  parseCsvText,
} from '../ocr-service/analyzer/csv-parser.mjs';

test('policy csv parser maps long CSV rows into policy fields with attribution', () => {
  const rows = parseCsvText('字段,识别值,来源,置信度\n保险公司,新华保险,ocr,0.95\n投保人,温舒萍,ocr,0.92\n首期保险费合计,3000,ocr,0.9\n');
  const mapped = mapPolicyWorkbookToScan({
    source: 'ocr',
    sheets: { fields: rows },
  });

  assert.equal(mapped.data.company, '新华保险');
  assert.equal(mapped.data.applicant, '温舒萍');
  assert.equal(mapped.data.firstPremium, '3000');
  assert.equal(mapped.fieldAttribution.company.source, 'ocr');
  assert.equal(mapped.fieldAttribution.company.parser, 'analyzer/csv-parser');
  assert.equal(mapped.fieldEvidence.applicant.relation, 'csv-parser');
  assert.ok(mapped.quality.recognitionRate > 0);
});

test('policy csv parser maps Excel-style wide rows and plan rows into policy fields', () => {
  const mapped = mapPolicyWorkbookToScan({
    source: 'vision',
    sheets: {
      fields: [
        {
          保险公司: '中国平安保险',
          产品名称: '平安福终身寿险',
          被保险人证件号码: '110105199001010010',
          出生日期: '1990-01-01',
          保险期间: '终身',
        },
      ],
      plans: [
        {
          角色: 'main',
          险种名称: '平安福终身寿险',
          保险金额: '500000',
          保险费: '12000',
          保险期间: '终身',
        },
      ],
    },
  });

  assert.equal(mapped.data.company, '中国平安保险');
  assert.equal(mapped.data.name, '平安福终身寿险');
  assert.equal(mapped.data.insuredIdNumber, '110105199001010010');
  assert.equal(mapped.data.insuredBirthday, '1990-01-01');
  assert.equal(mapped.data.coveragePeriod, '终身');
  assert.equal(mapped.data.plans[0].name, '平安福终身寿险');
  assert.equal(mapped.data.plans[0].premium, '12000');
  assert.equal(mapped.fieldAttribution.name.source, 'vision');
});

test('policy csv parser leaves uncertain fields empty', () => {
  const mapped = mapPolicyWorkbookToScan({
    source: 'vision',
    sheets: {
      fields: [
        { field: 'applicant', label: '投保人', value: '张三', confidence: 'review' },
        { field: 'insured', label: '被保险人', value: '李四', confidence: '0.4' },
        { field: 'company', label: '保险公司', value: '新华保险', confidence: '0.9' },
      ],
    },
  });

  assert.equal(mapped.data.applicant, undefined);
  assert.equal(mapped.data.insured, undefined);
  assert.equal(mapped.data.company, '新华保险');
  assert.equal(mapped.fieldAttribution.applicant, undefined);
  assert.equal(mapped.fieldAttribution.company.source, 'vision');
});

