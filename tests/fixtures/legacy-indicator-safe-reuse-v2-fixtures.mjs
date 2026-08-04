const digest = 'sha256:' + 'a'.repeat(64);
const oldDigest = 'sha256:' + 'b'.repeat(64);

function unit({ id, responsibilityId, indicatorName, liability, formulaText = 'A', normalizedFormula = 'a', operands = [], branches = [] }) {
  return {
    indicatorId: id,
    id,
    responsibilityId,
    indicatorName,
    liability,
    sourceUrl: 'https://official.example.test/product.pdf',
    sourceDigest: digest,
    sourcePage: '2',
    sourceExcerpt: `${indicatorName}官方证据`,
    evidenceTokens: [`${indicatorName}证据`],
    evidenceSegments: [{ sourcePage: '2', sourceExcerpt: `${indicatorName}官方证据` }],
    formulaText,
    normalizedFormula,
    basis: '基本保险金额',
    basisKey: 'basic_insured_amount',
    calculationKey: 'fixed_amount',
    requiredInputs: ['basic_insured_amount'],
    operands,
    branches,
  };
}

function responsibility({ id = 'r1', title = '身故保险金', indicators = null, indicatorInventoryAmbiguous = false } = {}) {
  const value = {
    responsibilityId: id,
    title,
    sourceUrl: 'https://official.example.test/product.pdf',
    sourceDigest: digest,
    sourcePage: '2',
    sourceExcerpt: `${title}官方证据`,
    evidenceTokens: [`${title}证据`],
    evidenceSegments: [{ sourcePage: '2', sourceExcerpt: `${title}官方证据` }],
    triggerCondition: '发生约定保险事故',
    insurerObligation: '按合同约定给付保险金',
    importantLimits: ['基本保险金额'],
  };
  if (!indicatorInventoryAmbiguous) value.indicators = indicators || [unit({ id: 'i1', responsibilityId: id, indicatorName: `${title}给付金额`, liability: title })];
  if (indicatorInventoryAmbiguous) value.indicatorInventoryAmbiguous = true;
  return value;
}

function product(responsibilities) {
  return { company: '测试保险公司', productName: 'v2严格语义产品', sourceDigest: digest, sourceUrl: 'https://official.example.test/product.pdf', responsibilities };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function legacyFromOfficial(official) {
  const cards = [];
  const indicators = [];
  for (const item of official.responsibilities) {
    const nested = (item.indicators || []).map((value) => clone(value));
    cards.push({
      id: `card-${item.responsibilityId}`,
      title: item.title,
      source_url: item.sourceUrl,
      payload: {
        id: `card-${item.responsibilityId}`,
        title: item.title,
        responsibilityId: item.responsibilityId,
        sourceUrl: item.sourceUrl,
        sourceDigest: digest,
        sourcePage: item.sourcePage,
        sourceExcerpt: item.sourceExcerpt,
        evidenceTokens: item.evidenceTokens,
        evidenceSegments: item.evidenceSegments,
        triggerCondition: item.triggerCondition,
        payoutSummary: item.insurerObligation,
        importantLimits: item.importantLimits,
        indicators: nested,
      },
    });
    for (const value of item.indicators || []) indicators.push({
      id: value.id,
      liability: value.liability,
      payload: clone(value),
    });
  }
  return { cards, indicators };
}

const base = product([responsibility()]);
const twoIndependent = product([responsibility({ indicators: [
  unit({ id: 'i1', responsibilityId: 'r1', indicatorName: '身故保险金给付金额', liability: '身故保险金' }),
  unit({ id: 'i2', responsibilityId: 'r1', indicatorName: '身故保险金特别给付金额', liability: '身故保险金' }),
] })]);
const maxOne = product([responsibility({ indicators: [unit({
  id: 'i1', responsibilityId: 'r1', indicatorName: '身故保险金给付金额', liability: '身故保险金',
  formulaText: 'max(A,B)', normalizedFormula: 'max(a,b)',
  operands: [{ operandId: 'a', formulaText: '基本保险金额' }, { operandId: 'b', formulaText: '现金价值' }],
})] })]);
const ambiguous = product([responsibility({ indicatorInventoryAmbiguous: true })]);

export const v2Fixtures = [
  {
    name: 'card-present-indicator-entirely-missing',
    official: base,
    mutate: (legacy) => { legacy.cards[0].payload.indicators = []; legacy.indicators = []; },
    expected: { status: 'missing_indicator', missingIndicatorCount: 1, incompleteIndicatorCount: 0 },
  },
  {
    name: 'indicator-present-evidence-fields-missing',
    official: base,
    mutate: (legacy) => {
      delete legacy.cards[0].payload.indicators[0].sourcePage;
      delete legacy.cards[0].payload.indicators[0].sourceExcerpt;
      delete legacy.indicators[0].payload.sourcePage;
      delete legacy.indicators[0].payload.sourceExcerpt;
      delete legacy.indicators[0].payload.evidenceSegments;
    },
    expected: { status: 'indicator_incomplete', missingIndicatorCount: 0, incompleteIndicatorCount: 1 },
  },
  {
    name: 'legacy-pollution-stays-in-diff-only',
    official: base,
    mutate: (legacy) => {
      const poison = {
        formulaText: '旧指标虚构公式=99%',
        normalizedFormula: 'legacy-poison-99-percent',
        sourceExcerpt: '旧指标虚构证据和错误比例99%',
        legacySourceDigest: oldDigest,
      };
      Object.assign(legacy.indicators[0].payload, poison);
      Object.assign(legacy.cards[0].payload.indicators[0], poison);
    },
    expected: { status: 'indicator_incomplete', poison: ['旧指标虚构公式=99%', 'legacy-poison-99-percent', '旧指标虚构证据和错误比例99%', oldDigest] },
  },
  {
    name: 'death-total-disability-split-is-duplicate',
    official: product([responsibility({ title: '身故或全残保险金', indicators: [unit({ id: 'i1', responsibilityId: 'r1', indicatorName: '身故或全残保险金给付金额', liability: '身故或全残保险金' })] })]),
    mutate: (legacy) => {
      const split = clone(legacy.indicators[0]);
      split.id = 'i-split';
      split.payload.id = 'i-split';
      split.payload.indicatorName = '全残保险金给付金额';
      legacy.indicators.push(split);
      legacy.cards[0].payload.indicators.push(clone(split.payload));
    },
    expected: { status: 'duplicate_or_split' },
  },
  {
    name: 'two-truly-independent-indicators-are-valid',
    official: twoIndependent,
    mutate: () => {},
    expected: { status: 'exact_complete' },
  },
  {
    name: 'max-two-operands-remains-one-indicator',
    official: maxOne,
    mutate: () => {},
    expected: { status: 'exact_complete' },
  },
  {
    name: 'complex-table-indicator-count-is-ambiguous',
    official: ambiguous,
    mutate: (legacy) => {
      legacy.cards[0].payload.indicators = [{ indicatorName: 'legacy猜测指标', responsibilityId: 'r1' }];
      legacy.indicators = [{ id: 'legacy-guess', liability: '身故保险金', payload: { id: 'legacy-guess', responsibilityId: 'r1', indicatorName: 'legacy猜测指标' } }];
    },
    expected: { status: 'indicator_inventory_ambiguous' },
  },
];

export function materializeV2Fixture(fixture) {
  const official = clone(fixture.official);
  const legacy = legacyFromOfficial(official);
  fixture.mutate(legacy);
  return { official, legacy };
}
