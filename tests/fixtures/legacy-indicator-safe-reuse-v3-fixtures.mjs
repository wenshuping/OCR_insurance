import { v2Fixtures, materializeV2Fixture } from './legacy-indicator-safe-reuse-v2-fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const baseOfficial = clone(v2Fixtures.find((item) => item.name === 'indicator-present-evidence-fields-missing').official);

function materialize(official, mutateLegacy = () => {}) {
  const { legacy } = materializeV2Fixture({ official, mutate: () => {} });
  mutateLegacy(legacy);
  return { official, legacy };
}

export const v3Fixtures = [
  {
    name: 'source-page-exact-offset-is-deterministic',
    make() {
      const official = clone(baseOfficial);
      official.officialSourceText = '身故保险金给付金额官方原文';
      const indicator = official.responsibilities[0].indicators[0];
      indicator.evidenceSegments = [{ sourcePage: '7', startOffset: 0, endOffset: 9, exactText: '身故保险金给付金额' }];
      const result = materialize(official, (legacy) => {
        delete legacy.cards[0].payload.indicators[0].sourcePage;
        delete legacy.cards[0].payload.indicators[0].evidenceSegments;
        delete legacy.indicators[0].payload.sourcePage;
        delete legacy.indicators[0].payload.evidenceSegments;
      });
      return result;
    },
  },
  {
    name: 'source-page-without-exact-mapping-requires-source-review',
    make() {
      const official = clone(baseOfficial);
      const result = materialize(official, (legacy) => {
        delete legacy.cards[0].payload.indicators[0].sourcePage;
        delete legacy.cards[0].payload.evidenceSegments;
        delete legacy.indicators[0].payload.sourcePage;
        delete legacy.indicators[0].payload.evidenceSegments;
      });
      return result;
    },
  },
  {
    name: 'basis-is-deterministic-only-when-officially-proven',
    make() {
      const official = clone(baseOfficial);
      const indicator = official.responsibilities[0].indicators[0];
      indicator.formulaText = '基本保险金额 × 20%';
      indicator.normalizedFormula = 'basic_amount * 0.2';
      indicator.basisKey = 'basic_insured_amount';
      const result = materialize(official, (legacy) => {
        delete legacy.cards[0].payload.indicators[0].basis;
        delete legacy.indicators[0].payload.basis;
      });
      return result;
    },
  },
  {
    name: 'basis-without-canonical-proof-is-bounded-review',
    make() {
      const official = clone(baseOfficial);
      const indicator = official.responsibilities[0].indicators[0];
      indicator.formulaText = '见分支';
      indicator.normalizedFormula = 'piecewise';
      indicator.basisKey = 'piecewise';
      const result = materialize(official, (legacy) => {
        delete legacy.cards[0].payload.indicators[0].basis;
        delete legacy.indicators[0].payload.basis;
      });
      return result;
    },
  },
  {
    name: 'formula-equivalent-normalization-and-operands-are-preserved',
    make() {
      const official = clone(baseOfficial);
      const indicator = official.responsibilities[0].indicators[0];
      indicator.formulaText = 'Max(基本保险金额, 现金价值)';
      indicator.normalizedFormula = 'max(basic_amount, cash_value)';
      indicator.basisKey = 'sum_of_bases';
      indicator.calculationKey = 'maximum_of_bases';
      indicator.operands = [{ operandId: 'a', formulaText: '基本保险金额' }, { operandId: 'b', formulaText: '现金价值' }];
      const result = materialize(official, (legacy) => {
        delete legacy.cards[0].payload.indicators[0].normalizedFormula;
        delete legacy.indicators[0].payload.normalizedFormula;
      });
      return result;
    },
  },
  {
    name: 'semantic-formula-conflict-is-bounded-review',
    make() {
      const official = clone(baseOfficial);
      const indicator = official.responsibilities[0].indicators[0];
      indicator.formulaText = '基本保险金额 × 20%';
      indicator.normalizedFormula = 'basic_amount * 0.99';
      const result = materialize(official, (legacy) => {
        delete legacy.cards[0].payload.indicators[0].normalizedFormula;
        delete legacy.indicators[0].payload.normalizedFormula;
      });
      return result;
    },
  },
  {
    name: 'death-total-disability-branches-remain-one-indicator',
    make() {
      const fixture = v2Fixtures.find((item) => item.name === 'death-total-disability-split-is-duplicate');
      return materialize(clone(fixture.official), fixture.mutate);
    },
  },
  {
    name: 'two-independent-indicators-remain-valid',
    make() {
      const fixture = v2Fixtures.find((item) => item.name === 'two-truly-independent-indicators-are-valid');
      return materialize(clone(fixture.official));
    },
  },
];

export function pollutionFixture() {
  const fixture = v2Fixtures.find((item) => item.name === 'legacy-pollution-stays-in-diff-only');
  return materialize(clone(fixture.official), fixture.mutate);
}

export function multiResponsibilityFixture() {
  const first = clone(baseOfficial);
  const second = clone(baseOfficial.responsibilities[0]);
  second.responsibilityId = 'r2';
  second.title = '全残保险金';
  second.indicators[0].indicatorId = 'i2';
  second.indicators[0].id = 'i2';
  second.indicators[0].responsibilityId = 'r2';
  second.indicators[0].indicatorName = '全残保险金给付金额';
  second.indicators[0].liability = '全残保险金';
  first.responsibilities[0].indicators[0].formulaText = '基本保险金额 × 20%';
  first.responsibilities[0].indicators[0].normalizedFormula = 'basic_amount * 0.99';
  second.indicators[0].formulaText = '基本保险金额 × 20%';
  second.indicators[0].normalizedFormula = 'basic_amount * 0.99';
  first.responsibilities.push(second);
  return materialize(first, (legacy) => {
    for (const card of legacy.cards) {
      delete card.payload.indicators[0].normalizedFormula;
    }
    for (const indicator of legacy.indicators) delete indicator.payload.normalizedFormula;
  });
}
