import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildOptionalResponsibilityRecords,
} from '../server/optional-responsibility-governance.mjs';
import {
  attachPolicyCoverageIndicators,
  buildOptionalResponsibilityReview,
} from '../server/policy-ocr.domain.mjs';

const company = '新华保险';
const productName = '尊贵人生年金保险(分红型)';
const sourceUrl = 'https://static-cdn.newchinalife.com/ncl/pdf/20230616/c22a7896-3f2d-4677-a968-a94f28a3ec25.pdf';
const sourceExcerpt = [
  '保险责任包括基本责任和可选责任。',
  '可选责任的基本保险金额按本条款第2.3.2条确定。',
  '2.3.1基本责任 生存保险金按基本责任的保险金额给付。',
  '2.3.2可选责任',
  '投保人可以选择可选责任作为本合同项下的保险责任，并与本公司约定该项责任的基本保险金额。',
  '（1）祝寿金 被保险人于年满60周岁保单生效对应日生存，按当日可选责任的保险金额给付祝寿金。',
  '（2）身故或身体全残保险金 被保险人在祝寿金约定领取日之前身故或身体全残，按条款公式给付。',
  '未成年子女投保的，身故给付总和不得超过监管规定的限额。',
  '2.3保险责任 基本责任继续按下一章节约定。',
].join('\n');

const indicators = [
  {
    id: 'birthday-benefit',
    company,
    productName,
    coverageType: '现金流',
    liability: '祝寿金',
    responsibilityScope: 'optional',
    quantificationStatus: 'quantified',
    formulaText: '祝寿金 = 当日可选责任的保险金额',
    sourceUrl,
    sourceExcerpt,
  },
  {
    id: 'death-benefit',
    company,
    productName,
    coverageType: '身故保障',
    liability: '身故或身体全残保险金',
    responsibilityScope: 'optional',
    quantificationStatus: 'quantified',
    formulaText: '身故或身体全残保险金 = 条款公式',
    sourceUrl,
    sourceExcerpt,
  },
];

const basicIndicator = {
  id: 'basic-survival-benefit',
  company,
  productName,
  coverageType: '现金流',
  liability: '生存保险金',
  responsibilityScope: 'basic',
  quantificationStatus: 'quantified',
  formulaText: '生存保险金 = 基本责任的保险金额 × 9%',
  sourceUrl,
  sourceExcerpt: '保险责任包括基本责任和可选责任。基本责任包括生存保险金。',
};

test('an unnumbered optional section remains one selectable group with child indicators', () => {
  const records = buildOptionalResponsibilityRecords({
    policy: { company, name: productName },
    knowledgeRecords: [{ id: 'terms', company, productName, url: sourceUrl, pageText: sourceExcerpt }],
    indicators,
  });

  assert.equal(records.length, 1);
  assert.equal(records[0].liability, '可选责任');
  assert.deepEqual(records[0].indicatorIds.sort(), ['birthday-benefit', 'death-benefit']);
  assert.doesNotMatch(records[0].sourceExcerpt, /2\.3\.1基本责任|生存保险金按基本责任/u);
});

test('a basic responsibility mentioning optional responsibility is not linked to the optional group', () => {
  const records = buildOptionalResponsibilityRecords({
    policy: { company, name: productName },
    knowledgeRecords: [{ id: 'terms', company, productName, url: sourceUrl, pageText: sourceExcerpt }],
    indicators: [...indicators, basicIndicator],
  });

  assert.equal(records.length, 1);
  assert.deepEqual(records[0].indicatorIds.sort(), ['birthday-benefit', 'death-benefit']);
});

test('review drops parameter pseudo-responsibilities and repairs child linkage to the group', () => {
  const review = buildOptionalResponsibilityReview(
    {
      company,
      name: productName,
      optionalResponsibilities: [
        {
          id: 'stale-birthday-choice',
          company,
          productName,
          liability: '祝寿金',
          indicatorIds: ['birthday-benefit'],
          responsibilityScope: 'optional',
        },
        {
          id: 'stale-death-choice',
          company,
          productName,
          liability: '身故或身体全残保险金',
          indicatorIds: ['death-benefit'],
          responsibilityScope: 'optional',
        },
      ],
    },
    [...indicators, basicIndicator],
    [{ id: 'terms', company, productName, url: sourceUrl, pageText: sourceExcerpt }],
    [
      {
        id: 'legacy-group',
        company,
        productName,
        liability: '可选责任',
        indicatorIds: ['missing-old-indicator'],
        sourceUrl,
        sourceExcerpt,
      },
      {
        id: 'legacy-parameter',
        company,
        productName,
        liability: '该项责任的基本保险金',
        indicatorIds: [],
        sourceUrl,
        sourceExcerpt,
      },
      {
        id: 'legacy-optional-parameter',
        company,
        productName,
        liability: '可选责任的基本保险金',
        indicatorIds: [],
        sourceUrl,
        sourceExcerpt,
      },
    ],
  );

  assert.equal(review.length, 1);
  assert.equal(review[0].liability, '可选责任');
  assert.deepEqual(review[0].indicatorIds.sort(), ['birthday-benefit', 'death-benefit']);
  assert.equal(
    review[0].customerSummary,
    '可选责任包含祝寿金、身故或身体全残保险金，使用投保时单独约定的可选责任基本保险金额；具体给付金额按合同约定计算。',
  );
  assert.doesNotMatch(review[0].customerSummary, /未成年|下一章节|累计红利保险金额定义/u);
});

test('attachment repairs the birthday basis and blocks an incomplete comparison formula', () => {
  const attached = attachPolicyCoverageIndicators(
    { company, name: productName },
    [
      {
        ...indicators[0],
        formulaText: '祝寿金 = 保险金额 × 100%',
        basis: '保险金额',
      },
      {
        ...indicators[1],
        formulaText: '身故或身体全残保险金 = 保险金额 × 100%',
        basis: '保险金额',
        sourceExcerpt: '身故或身体全残保险金 按以下二者之较大者的1.05倍与可选责任的累积红利保险金额对应的现金价值二者之和给付。②可选责任的基本保险金额对应的现金价值。',
      },
    ],
    [{ id: 'terms', company, productName, url: sourceUrl, pageText: sourceExcerpt }],
    [{ id: 'legacy-group', company, productName, liability: '可选责任', sourceUrl, sourceExcerpt }],
  );

  const birthday = attached.coverageIndicators.find((indicator) => indicator.id === 'birthday-benefit');
  const death = attached.coverageIndicators.find((indicator) => indicator.id === 'death-benefit');
  assert.equal(birthday.optionalResponsibilityId, attached.optionalResponsibilities[0].id);
  assert.equal(death.optionalResponsibilityId, attached.optionalResponsibilities[0].id);
  assert.equal(birthday.basis, '当日可选责任的保险金额');
  assert.equal(birthday.formulaText, '祝寿金 = 当日可选责任的保险金额 × 100%');
  assert.doesNotMatch(death.formulaText, /保险金额\s*×\s*100%/u);
  assert.equal(death.calculationEligible, false);
  assert.match(death.calculationReason, /完整比较项/u);
});
