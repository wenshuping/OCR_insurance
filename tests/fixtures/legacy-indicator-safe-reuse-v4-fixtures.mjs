const digest = 'sha256:' + 'a'.repeat(64);

export function packet({ id, title, trigger = '发生保险事故', obligation = '我们给付保险金', formula = '基本保险金额 × 20%', limits = [] }) {
  return {
    company: '测试保险公司',
    productName: 'v4页码映射产品',
    sourceDigest: digest,
    responsibilityId: id,
    responsibilityTitle: title,
    officialResponsibility: {
      triggerCondition: trigger,
      insurerObligation: obligation,
      importantLimits: limits,
      indicators: [{ indicatorName: `${title}给付金额`, formulaText: formula, operands: [], branches: [] }],
    },
  };
}

export function canonicalPages(text) {
  return { pages: String(text).split('---PAGE---').map((value, index) => ({ page: index + 1, text: value })) };
}

export const fixtures = {
  crossPage: {
    packets: [packet({ id: 'r1', title: '身故保险金', trigger: '发生保险事故', obligation: '我们给付保险金', formula: '基本保险金额 × 20%' })],
    text: '条款目录 身故保险金---PAGE---身故保险金\n发生保险事故，我们承担责任。\n我们给付保险金。---PAGE---基本保险金额 × 20%\n年度给付不超过基本保险金额。',
  },
  samePageMultiple: {
    packets: [packet({ id: 'r1', title: '身故保险金', formula: '基本保险金额 × 20%' }), packet({ id: 'r2', title: '全残保险金', formula: '基本保险金额 × 30%' })],
    text: '身故保险金\n发生保险事故\n我们给付保险金\n基本保险金额 × 20%\n全残保险金\n发生保险事故\n我们给付保险金\n基本保险金额 × 30%',
  },
  whitespaceRaw: {
    packets: [packet({ id: 'r1', title: '身故保险金', formula: '基本保险金额' })],
    text: '身故保险金\n发生保险事故\n我们给付保险金\n基本 \n保险金额',
  },
  nonContiguous: {
    packets: [packet({ id: 'r1', title: '身故保险金', formula: '基本保险金额', limits: ['无免赔额', '年度给付不超过基本保险金额'] })],
    text: '身故保险金\n发生保险事故\n我们给付保险金\n基本保险金额\n无免赔额\n其他条款\n年度给付不超过基本保险金额',
  },
  contentsDuplicate: {
    packets: [packet({ id: 'r1', title: '身故保险金' })],
    text: '条款目录\n身故保险金---PAGE---身故保险金\n发生保险事故\n我们给付保险金\n基本保险金额 × 20%',
  },
  damagedTable: {
    packets: [packet({ id: 'r1', title: '身故保险金', formula: '基本保险金额 × 20%' })],
    text: '身故保险金\n发生保险事故\n我们给付保险金\n[TABLE_CORRUPTED]',
  },
};
