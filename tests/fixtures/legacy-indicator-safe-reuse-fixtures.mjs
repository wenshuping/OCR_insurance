const digest = 'sha256:' + 'a'.repeat(64);
const otherDigest = 'sha256:' + 'b'.repeat(64);
const sourceUrl = 'https://official.example.test/terms/product.pdf';

function indicator({ id, responsibilityId, indicatorName, liability, formula = 'A', normalizedFormula = 'a', branches = [] }) {
  return {
    id,
    indicatorId: id,
    responsibilityId,
    indicatorName,
    liability,
    sourceUrl,
    sourceDigest: digest,
    sourcePage: 'PDF_PAGE_2',
    sourceExcerpt: `${liability}官方条款证据`,
    evidenceTokens: [`${liability}证据`],
    formulaText: formula,
    normalizedFormula,
    requiredInputs: ['basic_sum_insured'],
    operands: [{ operandId: 'basic', formulaText: '基本保险金额', requiredInputs: ['basic_sum_insured'] }],
    branches,
  };
}

function responsibility({ id = 'r1', title = '身故保险金', indicators = [indicator({
  id: 'i1', responsibilityId: id, indicatorName: `${title}给付金额`, liability: title,
})] } = {}) {
  return {
    responsibilityId: id,
    title,
    sourceUrl,
    sourceDigest: digest,
    sourcePage: 'PDF_PAGE_2',
    sourceExcerpt: `${title}官方条款证据`,
    evidenceTokens: [`${title}证据`],
    triggerCondition: '发生约定保险事故',
    insurerObligation: '按合同约定给付保险金',
    importantLimits: ['基本保险金额'],
    indicators,
  };
}

function product(responsibilities = [responsibility()]) {
  return {
    company: '测试保险公司',
    productName: '测试安全复用产品',
    sourceDigest: digest,
    sourceUrl,
    responsibilities,
  };
}

function legacyFromOfficial(official) {
  const cards = [];
  const indicators = [];
  for (const item of official.responsibilities) {
    const nested = item.indicators.map((value) => ({ ...value }));
    cards.push({
      id: `card-${item.responsibilityId}`,
      company: official.company,
      product_name: official.productName,
      title: item.title,
      source_url: sourceUrl,
      payload: {
        id: `card-${item.responsibilityId}`,
        company: official.company,
        productName: official.productName,
        title: item.title,
        sourceUrl,
        sourceDigest: digest,
        sourceExcerpt: item.sourceExcerpt,
        triggerCondition: item.triggerCondition,
        payoutSummary: item.insurerObligation,
        importantLimits: item.importantLimits,
        indicators: nested,
      },
    });
    for (const value of item.indicators) {
      indicators.push({
        id: value.id,
        company: official.company,
        product_name: official.productName,
        coverage_type: '基础责任',
        liability: value.liability,
        payload: { ...value },
      });
    }
  }
  return { cards, indicators };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

const legalMultiIndicatorOfficial = product([responsibility({
  indicators: [
    indicator({ id: 'i1', responsibilityId: 'r1', indicatorName: '身故保险金给付金额', liability: '身故保险金' }),
    indicator({ id: 'i2', responsibilityId: 'r1', indicatorName: '身故保险金特别给付金额', liability: '身故保险金' }),
  ],
})]);

const branchOfficial = product([responsibility({
  indicators: [indicator({
    id: 'i1',
    responsibilityId: 'r1',
    indicatorName: '身故或全残保险金给付金额',
    liability: '身故或全残保险金',
    branches: [
      { branchId: 'death', condition: '身故', formulaText: 'A' },
      { branchId: 'total_disability', condition: '全残', formulaText: 'A' },
    ],
  })],
  title: '身故或全残保险金',
})]);

export const fixtures = [
  {
    name: 'legacy-indicator-misses-responsibility',
    official: product([responsibility(), responsibility({ id: 'r2', title: '全残保险金', indicators: [indicator({ id: 'i2', responsibilityId: 'r2', indicatorName: '全残保险金给付金额', liability: '全残保险金' })] })]),
    mutate: (legacy) => { legacy.cards.pop(); legacy.indicators.pop(); },
    expected: ['missing responsibility'],
  },
  {
    name: 'legacy-indicator-duplicate',
    official: product(),
    mutate: (legacy) => { legacy.indicators.push(clone(legacy.indicators[0])); legacy.indicators[1].id = 'i1-duplicate'; legacy.cards[0].payload.indicators.push(clone(legacy.cards[0].payload.indicators[0])); },
    expected: ['duplicate_or_orphan'],
  },
  {
    name: 'legal-multi-indicator',
    official: legalMultiIndicatorOfficial,
    mutate: () => {},
    expected: ['reuse'],
  },
  {
    name: 'first-indicator-historical-truncation',
    official: legalMultiIndicatorOfficial,
    mutate: (legacy) => { legacy.cards[0].payload.indicators.pop(); legacy.indicators.pop(); },
    expected: ['missing indicator:身故保险金特别给付金额'],
  },
  {
    name: 'formula-field-lost',
    official: product(),
    mutate: (legacy) => { delete legacy.indicators[0].payload.normalizedFormula; delete legacy.cards[0].payload.indicators[0].normalizedFormula; },
    expected: ['formula_evidence_missing'],
  },
  {
    name: 'different-digest-version',
    official: product(),
    mutate: (legacy) => { legacy.indicators[0].payload.sourceDigest = otherDigest; legacy.cards[0].payload.sourceDigest = otherDigest; },
    expected: ['version_mismatch'],
  },
  {
    name: 'death-total-disability-branch-wrong-split',
    official: branchOfficial,
    mutate: (legacy) => {
      legacy.cards.push({ ...clone(legacy.cards[0]), id: 'card-r1-split', title: '全残保险金', payload: { ...clone(legacy.cards[0].payload), id: 'card-r1-split', title: '全残保险金' } });
      legacy.indicators.push({ ...clone(legacy.indicators[0]), id: 'i-split', liability: '全残保险金', payload: { ...clone(legacy.indicators[0].payload), id: 'i-split', liability: '全残保险金', indicatorName: '全残保险金给付金额' } });
    },
    expected: ['duplicate_or_orphan'],
  },
  {
    name: 'card-only',
    official: product(),
    mutate: (legacy) => { legacy.indicators = []; legacy.cards[0].payload.indicators = []; },
    expected: ['card_only'],
  },
  {
    name: 'indicator-only',
    official: product(),
    mutate: (legacy) => { legacy.cards = []; },
    expected: ['indicator_only'],
  },
];

export function materializeFixture(fixture) {
  const official = clone(fixture.official);
  const legacy = legacyFromOfficial(official);
  fixture.mutate(legacy);
  return { official, legacy };
}
