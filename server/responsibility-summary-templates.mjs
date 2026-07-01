function text(value) {
  return String(value ?? '').trim();
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function hasTag(routing, tag) {
  return normalizeArray(routing?.featureTags).includes(tag);
}

function sourceText(sourceSections = {}) {
  return [
    sourceSections.mainResponsibilityText,
    ...normalizeArray(sourceSections.supplementSections).flatMap((section) => [
      section?.type,
      section?.title,
      section?.text,
      section?.content,
      section?.summary,
    ]),
  ].map(text).filter(Boolean).join('\n');
}

const CATEGORY_KEYWORDS = {
  incremental_whole_life: ['身故', '全残', '基本保险金额', '现金价值', '给付系数', '复利递增'],
  participating_life: ['身故保险金', '红利不保证', '累积红利保险金额'],
  annuity: ['年金', '生存保险金', '身故保险金', '领取日', '可选责任'],
  critical_illness: ['等待期', '轻度疾病保险金', '中度疾病保险金', '重度疾病保险金', '身故保险金', '豁免保险费', '关爱保险金', '累计给付限额'],
  medical: ['医疗保险金', '住院', '门诊', '免赔额', '赔付比例', '年度限额'],
  accident: ['意外身故', '意外伤残', '意外医疗'],
  endowment: ['满期保险金', '身故保险金', '全残保险金'],
  term_life: ['身故', '全残', '等待期'],
  ordinary_whole_life: ['身故', '全残', '现金价值'],
  universal_life: ['账户价值', '身故保险金', '结算利率', '最低保证利率'],
  investment_linked: ['账户价值', '身故保险金', '投资风险'],
  long_term_care: ['护理保险金', '长期护理状态', '等待期', '身故保险金'],
};

export function requiredKeywordsForCategory(category) {
  return [...(CATEGORY_KEYWORDS[text(category)] || [])];
}

function participatingInstruction(routing, category) {
  if (!hasTag(routing, 'participating') && category !== 'participating_life') return '';
  return [
    '分红/红利处理：红利、累积红利保险金额、终了红利属于 productFunctions 或 importantNotes，不是独立保险责任。',
    '必须提示红利不保证；如果来源说明累积红利保险金额会并入身故/全残等给付基准，只能按来源解释处理方式，不要自行测算红利。',
  ].join('\n');
}

function incrementalWholeLifeInstructions(routing, sectionsText) {
  const trafficSignal = hasTag(routing, 'traffic_accident_extra') || /交通|航空|公共交通|驾乘/u.test(sectionsText);
  return [
    '增额终身寿险模板：必须检查并摘要身故保险金、身体全残保险金、有效保险金额/基本保险金额递增公式、现金价值比较项、给付系数和年龄段。',
    '如果来源出现“基本保险金额×(1+X%)^(n-1)”或类似公式，必须解释为对应给付基准每年X%复利递增。',
    '必须明确提示：复利递增是保险责任给付基准的递增，不等于现金价值按X%增长，也不代表保证收益率或实际回报。',
    '现金价值、保单贷款、减保、受益人指定只放入 productFunctions 或 importantNotes，不得放入 responsibilities。',
    trafficSignal ? '来源出现交通/公共交通/航空/驾乘等额外给付时，必须单独检查交通意外额外给付责任、触发条件、给付比例或限额。' : '如果来源没有交通意外额外给付，不要编造交通责任。',
  ].join('\n');
}

const CATEGORY_INSTRUCTIONS = {
  participating_life: [
    '分红寿险模板：必须先识别真实保险责任，如身故保险金、全残保险金或满期/生存类保险金。',
    '红利、累积红利保险金额、保单贷款、减保、现金价值、受益人指定是产品功能或重要提示，不是独立保险责任。',
    '必须提示红利不保证；如果来源说明累积红利保险金额参与保险金给付，只能说明来源中的处理方式。',
  ].join('\n'),
  annuity: [
    '年金保险模板：按责任名称拆分关爱年金、年金、生存保险金、养老年金、养老金、祝寿金、生日金、满期保险金、身故保险金和可选责任。',
    '每项责任必须说明领取时间/领取日、领取频率、给付基准、给付比例或金额来源；无法确定时写入 missingOrUnclear。',
    '可选责任必须标明“可选”或“附加”，不要当成默认必有责任。',
  ].join('\n'),
  critical_illness: [
    '重大疾病保险模板：必须逐项检查等待期、轻度疾病保险金、轻症/轻度疾病保险金、中度疾病保险金、重度疾病保险金、疾病分组、单组给付限额、累计给付限额、给付特别约定、身故保险金、少儿前10年关爱保险金、成人意外伤害特定疾病或身故关爱保险金、豁免保险费。',
    '不要展开全部疾病名称，只摘要疾病数量、疾病分组、赔付比例、给付次数、间隔期、单组/累计限制和特别约定。',
    '儿童、成人、少儿前10年、成人意外伤害等限定条件必须写进 triggerCondition。',
  ].join('\n'),
  medical: [
    '医疗保险模板：必须检查住院医疗、门诊医疗、特殊门诊、门诊手术、特药、质子重离子等来源中出现的责任。',
    '每项医疗责任必须写明免赔额、赔付比例、年度限额、社保身份/有无社保结算影响、等待期或续保条件；缺失则写入 missingOrUnclear。',
    '医疗费用依赖实际账单和责任范围，不要硬算最终赔付金额。',
  ].join('\n'),
  accident: [
    '意外险模板：必须检查意外身故、意外伤残、意外医疗，以及来源中出现的交通/航空/驾乘等特定意外责任。',
    '伤残等级表不要展开，只说明按伤残等级表和对应比例给付。',
    '意外医疗必须说明免赔额、赔付比例、限额和社保相关条件（如来源提供）。',
  ].join('\n'),
  endowment: [
    '两全保险模板：必须检查满期保险金、生存/祝寿类保险金、身故保险金和全残保险金。',
    '如果来源使用“以下二者/三者较大者”等规则，保留比较口径，不要自行计算。',
    '满期和身故/全残触发条件必须分开写。',
  ].join('\n'),
  term_life: [
    '定期寿险模板：必须检查保险期间内的身故保险金、全残保险金、等待期或责任免除相关限制。',
    '保险期间、等待期内外给付差异、给付基准必须写清楚；不要加入现金价值或红利责任。',
  ].join('\n'),
  ordinary_whole_life: [
    '普通终身寿险模板：必须检查身故保险金、全残保险金、等待期/年龄段/给付系数和现金价值比较项（如来源出现）。',
    '现金价值、贷款、减保、受益人指定是产品功能或重要提示，不是保险责任。',
  ].join('\n'),
  universal_life: [
    '万能保险模板：必须区分保险责任和账户功能；身故/全残等保险金放入 responsibilities，账户价值、结算利率、最低保证利率、费用收取放入 productFunctions 或 importantNotes。',
    '账户价值依赖结算利率、费用和实际账户状态，不要硬算。',
  ].join('\n'),
  investment_linked: [
    '投资连结保险模板：必须区分保险责任和投资账户功能；身故/全残等保险金放入 responsibilities，账户价值、投资账户、单位价格、费用和投资风险放入 productFunctions 或 importantNotes。',
    '必须提示投资风险和账户价值不保证；不要硬算账户价值或投资收益。',
  ].join('\n'),
  long_term_care: [
    '长期护理保险模板：必须检查护理保险金、长期护理状态/失能状态触发条件、等待期、给付期间/频率/限额，以及身故或满期责任（如来源出现）。',
    '护理状态认定依赖条款和事实材料，不要自行认定或硬算。',
  ].join('\n'),
};

function categoryInstructions(routing = {}, sourceSections = {}) {
  const category = text(routing.productCategory);
  const sectionsText = sourceText(sourceSections);
  const mainInstruction = category === 'incremental_whole_life'
    ? incrementalWholeLifeInstructions(routing, sectionsText)
    : CATEGORY_INSTRUCTIONS[category] || '通用模板：按来源中的保险责任名称逐项摘要；保险责任、产品功能、重要提示必须分开。未知或其他险种也必须避免把现金价值、红利、贷款、减保、受益人指定混入 responsibilities。';
  return [mainInstruction, participatingInstruction(routing, category)].filter(Boolean).join('\n');
}

export function buildStructuredResponsibilityPrompt({
  product = {},
  routing = {},
  sourceSections = {},
  cards = [],
  indicators = [],
} = {}) {
  const payload = {
    product,
    routing,
    sourceSections,
    cards,
    indicators,
  };

  return [
    '你是一名中国保险责任摘要助手。请只依据输入资料，为普通用户输出保险责任摘要。',
    '',
    '输出要求：只输出合法 JSON，JSON only，不要 Markdown，不要代码块，不要解释性前后缀。',
    '',
    '统一 JSON Schema：',
    '{"productCategory":"","categoryLabel":"","headline":"","responsibilities":[{"title":"","plainText":"","triggerCondition":"","paymentRule":"","calculationStatus":""}],"productFunctions":[],"importantNotes":[],"missingOrUnclear":[]}',
    '',
    '字段要求：',
    '- productCategory 和 categoryLabel 使用路由结果；headline 用一句话概括主要保障。',
    '- responsibilities[] 只能放保险责任，每项必须包含 title、plainText、triggerCondition、paymentRule、calculationStatus。',
    '- productFunctions 放现金价值、红利、保单贷款、减保、账户价值、投资账户、受益人指定等非责任功能。',
    '- importantNotes 放红利不保证、复利递增非收益率、医疗/护理/疾病/账户价值依赖事实或表格等重要提示。',
    '- missingOrUnclear 放来源缺失、条件不明、需要费率表/现金价值表/疾病表/伤残表/理赔事实才能确定的项目。',
    '',
    '硬性规则：',
    '- 只使用输入 sourceSections、cards、indicators 中能支持的内容；不要编造、补全或引用外部知识。',
    '- 必须把保险责任和产品功能分开。',
    '- 不得把现金价值、红利、保单贷款、减保、账户价值、投资账户、受益人指定混入 responsibilities。',
    '- 不要硬算依赖现金价值、账户价值、疾病表、伤残等级表、费用票据、红利、结算利率或理赔事实的金额。',
    '- 来源没有写明的责任、比例、年龄段、领取日、频率、限额，不要推断；写入 missingOrUnclear。',
    '',
    '类别专用指令：',
    categoryInstructions(routing, sourceSections),
    '',
    '输入资料 JSON：',
    JSON.stringify(payload, null, 2),
  ].join('\n');
}
