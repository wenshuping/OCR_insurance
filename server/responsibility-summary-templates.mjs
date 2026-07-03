function text(value) {
  return String(value ?? '').trim();
}

function firstText(...values) {
  return values.map(text).find(Boolean) || '';
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

function promptText(value, limit = 1200) {
  const normalized = text(value).replace(/\s+/gu, ' ');
  return normalized.length > limit ? normalized.slice(0, limit) : normalized;
}

function normalizedPromptComparable(value) {
  return text(value).replace(/\s+/gu, ' ');
}

function isDuplicateCoverageSection(sectionText, mainText) {
  const normalizedSection = normalizedPromptComparable(sectionText);
  const normalizedMain = normalizedPromptComparable(mainText);
  if (!normalizedSection || !normalizedMain) return false;
  return normalizedSection === normalizedMain || normalizedMain.includes(normalizedSection);
}

function compactPromptSourceRefs(sourceRefs = []) {
  return normalizeArray(sourceRefs)
    .map((ref) => ({
      sourceRefId: text(ref?.sourceRefId),
      sourceId: text(ref?.sourceId),
      sourceTitle: text(ref?.sourceTitle),
      sourceUrl: text(ref?.sourceUrl),
      sourceType: text(ref?.sourceType),
      sectionTitle: text(ref?.sectionTitle),
      itemId: text(ref?.itemId),
      pageHint: text(ref?.pageHint),
      quote: promptText(ref?.quote, 220),
    }))
    .filter((ref) => ref.sourceRefId || ref.sourceId || ref.quote);
}

function compactPromptSourceSections(sourceSections = {}) {
  const mainResponsibilityText = promptText(sourceSections.mainResponsibilityText, 9000);
  const responsibilityItems = normalizeArray(sourceSections.responsibilityItems)
    .map((item) => ({
      itemId: text(item?.itemId),
      title: text(item?.title),
      excerpt: promptText(item?.excerpt, 900),
      keyFacts: normalizeArray(item?.keyFacts).map(text).filter(Boolean).slice(0, 12),
      sourceRefs: compactPromptSourceRefs(item?.sourceRefs),
    }))
    .filter((item) => item.title || item.excerpt || item.keyFacts.length);
  return {
    sourceInventory: normalizeArray(sourceSections.sourceInventory)
      .map((source) => ({
        sourceId: text(source?.sourceId),
        title: text(source?.title),
        url: text(source?.url),
        sourceType: text(source?.sourceType),
        official: Boolean(source?.official),
      }))
      .filter((source) => source.sourceId || source.title || source.url),
    coverageSections: normalizeArray(sourceSections.coverageSections)
      .map((section) => {
        const sectionText = promptText(section?.text, 500);
        return {
          sectionId: text(section?.sectionId),
          title: text(section?.title),
          text: isDuplicateCoverageSection(sectionText, mainResponsibilityText) ? '' : sectionText,
          sourceRefs: compactPromptSourceRefs(section?.sourceRefs),
        };
      })
      .filter((section) => section.sectionId || section.title || section.text || section.sourceRefs.length),
    sourceTitle: text(sourceSections.sourceTitle),
    sourceUrl: text(sourceSections.sourceUrl),
    mainResponsibilityText,
    responsibilityItems,
    supplementSections: normalizeArray(sourceSections.supplementSections)
      .map((section) => ({
        type: text(section?.type),
        title: text(section?.title),
        text: promptText(section?.text || section?.content || section?.summary, 900),
        sourceRefs: compactPromptSourceRefs(section?.sourceRefs),
      }))
      .filter((section) => section.type || section.title || section.text),
    gaps: normalizeArray(sourceSections.gaps)
      .map((gap) => ({
        type: text(gap?.type),
        message: promptText(gap?.message, 180),
        sourceRefs: compactPromptSourceRefs(gap?.sourceRefs),
      }))
      .filter((gap) => gap.type || gap.message),
  };
}

function compactPromptCards(cards = []) {
  return normalizeArray(cards)
    .map((card) => ({
      title: firstText(card?.title, card?.liability, card?.coverageType),
      category: firstText(card?.category, card?.coverageType),
      officialExcerpt: promptText(firstText(card?.officialExcerpt, card?.sourceExcerpt, card?.excerpt), 700),
      plainSummary: promptText(firstText(card?.plainSummary, card?.summary), 280),
      payoutSummary: promptText(firstText(card?.payoutSummary, card?.paymentRule, card?.payout), 320),
      sourceUrl: firstText(card?.sourceUrl, card?.url),
      sourceTitle: firstText(card?.sourceTitle, card?.title),
    }))
    .filter((card) => card.title || card.officialExcerpt || card.plainSummary || card.payoutSummary);
}

function compactPromptIndicators(indicators = []) {
  return normalizeArray(indicators)
    .map((indicator) => ({
      liability: firstText(indicator?.liability, indicator?.coverageType, indicator?.title),
      payoutSummary: promptText(firstText(indicator?.payoutSummary, indicator?.formulaText, indicator?.formula, indicator?.payout), 320),
      basis: promptText(firstText(indicator?.basis, indicator?.sourceExcerpt, indicator?.excerpt), 320),
      requiredFieldHints: normalizeArray(indicator?.requiredFieldHints).map(text).filter(Boolean).slice(0, 8),
      sourceUrl: firstText(indicator?.sourceUrl, indicator?.url),
    }))
    .filter((indicator) => indicator.liability || indicator.payoutSummary || indicator.basis);
}

function compactPlannerResult(plannerResult) {
  if (!plannerResult?.plannerUsed || !plannerResult.planner) return null;
  const planner = plannerResult.planner;
  return {
    plannerMode: text(plannerResult.plannerMode),
    plannerReason: text(plannerResult.plannerReason),
    plannerModel: text(plannerResult.plannerModel),
    productCategory: text(planner.productCategory),
    categoryLabel: text(planner.categoryLabel),
    confidence: text(planner.confidence),
    recommendedTemplate: text(planner.recommendedTemplate),
    positioningFocus: normalizeArray(planner.positioningFocus).map(text).filter(Boolean),
    productPurposeFocus: normalizeArray(planner.productPurposeFocus).map(text).filter(Boolean),
    responsibilityFocus: normalizeArray(planner.responsibilityFocus).map(text).filter(Boolean),
    functionFocus: normalizeArray(planner.functionFocus).map(text).filter(Boolean),
    attentionFocus: normalizeArray(planner.attentionFocus).map(text).filter(Boolean),
    missingOrUnclear: normalizeArray(planner.missingOrUnclear).map(text).filter(Boolean),
    notesForFinalPrompt: normalizeArray(planner.notesForFinalPrompt).map(text).filter(Boolean),
  };
}

const CATEGORY_KEYWORD_RULES = {
  incremental_whole_life: {
    responsibility: ['身故', '全残', '基本保险金额', '给付系数', '复利递增', '(1+X%)^(n-1)'],
    productFunctionOrNote: ['现金价值'],
  },
  participating_life: {
    responsibility: ['身故保险金'],
    productFunctionOrNote: ['红利不保证', '累积红利保险金额'],
  },
  annuity: {
    responsibility: ['年金', '生存保险金', '身故保险金', '领取日', '保单周年日', '可选责任'],
    productFunctionOrNote: ['累积红利保险金额'],
  },
  critical_illness: {
    responsibility: ['等待期', '轻度疾病保险金', '中度疾病保险金', '重度疾病保险金', '身故保险金', '豁免保险费', '关爱保险金', '给付特别约定', '累计给付限额'],
    productFunctionOrNote: [],
  },
  medical: {
    responsibility: ['医疗保险金', '住院', '门诊', '免赔额', '赔付比例', '年度限额', '社保', '等待期'],
    productFunctionOrNote: [],
  },
  accident: {
    responsibility: ['意外身故', '意外伤残', '意外医疗', '交通工具', '猝死'],
    productFunctionOrNote: ['伤残等级'],
  },
  endowment: {
    responsibility: ['满期保险金', '身故保险金', '全残保险金', '生存保险金', '已交保险费', '基本保险金额'],
    productFunctionOrNote: [],
  },
  term_life: {
    responsibility: ['身故', '全残', '等待期', '基本保险金额', '已交保险费'],
    productFunctionOrNote: ['现金价值'],
  },
  ordinary_whole_life: {
    responsibility: ['身故', '全残', '等待期', '基本保险金额', '已交保险费'],
    productFunctionOrNote: ['现金价值'],
  },
  universal_life: {
    responsibility: ['身故保险金'],
    productFunctionOrNote: ['账户价值', '结算利率', '保证利率', '费用', '投资风险'],
  },
  investment_linked: {
    responsibility: ['身故保险金'],
    productFunctionOrNote: ['账户价值', '结算利率', '保证利率', '费用', '投资风险'],
  },
  long_term_care: {
    responsibility: ['护理保险金', '长期护理状态', '等待期', '身故保险金'],
    productFunctionOrNote: [],
  },
};

export function requiredKeywordsForCategory(category) {
  const rules = CATEGORY_KEYWORD_RULES[text(category)];
  if (!rules) return [];
  return [...rules.responsibility, ...rules.productFunctionOrNote];
}

export function categoryKeywordRules(category) {
  const rules = CATEGORY_KEYWORD_RULES[text(category)];
  if (!rules) return { responsibility: [], productFunctionOrNote: [], all: [] };
  return {
    responsibility: [...rules.responsibility],
    productFunctionOrNote: [...rules.productFunctionOrNote],
    all: [...rules.responsibility, ...rules.productFunctionOrNote],
  };
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
    '增额终身寿险模板：检查来源是否出现身故保险金、身体全残保险金、有效保险金额/基本保险金额递增公式、现金价值比较项、给付系数和年龄段；出现则写入对应字段，未出现不得编造，可写 missingOrUnclear only if该类产品通常需要核验/来源不清。',
    '如果来源出现“基本保险金额×(1+X%)^(n-1)”、“基本保险金额×1.035^(n-1)”或类似标量公式，必须解释为对应给付基准每年X%复利递增；当来源支持 1.035 时，将其翻译为每年3.5%复利递增。',
    '必须明确提示：复利递增是保险责任给付基准的递增，不等于现金价值按X%增长，也不代表保证收益率或实际回报。',
    '现金价值、保单贷款、减保、受益人指定只放入 productFunctions 或 importantNotes，不得放入 responsibilities。',
    trafficSignal ? '来源出现交通/公共交通/航空/驾乘等额外给付时，必须单独检查交通意外额外给付责任、触发条件、给付比例或限额。' : '如果来源没有交通意外额外给付，不要编造交通责任。',
  ].join('\n');
}

function endowmentInstructions(routing, sectionsText) {
  const trafficSignal = hasTag(routing, 'traffic_accident_extra')
    || /交通|航空|列车|客运|轮船|汽车|驾乘|步行|骑行|电梯|高空|公共场所|自然灾害/u.test(sectionsText);
  return [
    '两全保险模板：检查来源是否出现满期保险金、生存/祝寿类保险金、身故保险金和全残保险金；出现则写入 responsibilities，未出现不得编造，可写 missingOrUnclear only if该类产品通常需要核验/来源不清。',
    '如果来源使用“以下二者/三者较大者”等规则，保留比较口径，不要自行计算。',
    '满期和身故/全残触发条件必须分开写。',
    trafficSignal
      ? '复合定位：本产品应按“两全保险 + 交通/特定意外高倍保障”理解；产品主要做什么必须先说明满期返还/生存给付属性，再说明交通及特定意外高倍身故/全残保障。'
      : '',
    trafficSignal
      ? '展示规则：主要保险责任必须先归纳保障结构，再按满期/疾病身故全残/一般意外/交通意外/特定场景意外分组列责任；不要把10条以上相似意外责任机械塞进一个 contentBlocks.responsibilities 展示块。'
      : '',
  ].filter(Boolean).join('\n');
}

const CATEGORY_INSTRUCTIONS = {
  participating_life: [
    '分红寿险模板：检查来源是否出现身故保险金、全残保险金或满期/生存类保险金；出现则写入 responsibilities，未出现不得编造，可写 missingOrUnclear only if该类产品通常需要核验/来源不清。',
    '红利、累积红利保险金额、保单贷款、减保、现金价值、受益人指定是产品功能或重要提示，不是独立保险责任。',
    '必须提示红利不保证；如果来源说明累积红利保险金额参与保险金给付，只能说明来源中的处理方式。',
  ].join('\n'),
  annuity: [
    '年金保险模板：检查来源是否出现关爱年金、年金、生存保险金、养老年金、养老金、祝寿金、生日金、满期保险金、身故保险金和可选责任；出现则写入 responsibilities，未出现不得编造，可写 missingOrUnclear only if该类产品通常需要核验/来源不清。',
    '每项责任必须说明领取时间/领取日、领取频率、给付基准、给付比例或金额来源；无法确定时写入 missingOrUnclear。',
    '可选责任必须标明“可选”或“附加”，不要当成默认必有责任。',
  ].join('\n'),
  critical_illness: [
    '重大疾病保险模板：检查来源是否出现等待期、轻度疾病保险金、轻症/轻度疾病保险金、中度疾病保险金、重度疾病保险金、疾病分组、单组给付限额、累计给付限额、给付特别约定、身故保险金、少儿前10年关爱保险金、成人意外伤害特定疾病或身故关爱保险金、豁免保险费；出现则写入 responsibilities，未出现不得编造，可写 missingOrUnclear only if该类产品通常需要核验/来源不清。',
    '不要展开全部疾病名称，只摘要疾病数量、疾病分组、赔付比例、给付次数、间隔期、单组/累计限制和特别约定。',
    '儿童、成人、少儿前10年、成人意外伤害等限定条件必须写进 triggerCondition。',
  ].join('\n'),
  medical: [
    '医疗保险模板：检查来源是否出现住院医疗、门诊医疗、特殊门诊、门诊手术、特药、质子重离子等责任；出现则写入 responsibilities，未出现不得编造，可写 missingOrUnclear only if该类产品通常需要核验/来源不清。',
    '每项医疗责任必须写明免赔额、赔付比例、年度限额、社保身份/有无社保结算影响、等待期或续保条件；缺失则写入 missingOrUnclear。',
    '医疗费用依赖实际账单和责任范围，不要硬算最终赔付金额。',
  ].join('\n'),
  accident: [
    '意外险模板：检查来源是否出现意外身故、意外伤残、意外医疗、交通工具/航空/驾乘等特定意外责任和猝死责任；出现则写入 responsibilities，未出现不得编造，可写 missingOrUnclear only if该类产品通常需要核验/来源不清。',
    '伤残等级表不要展开，只说明按伤残等级表和对应比例给付。',
    '意外医疗必须说明免赔额、赔付比例、限额和社保相关条件（如来源提供）。',
  ].join('\n'),
  term_life: [
    '定期寿险模板：检查来源是否出现保险期间内的身故保险金、全残保险金、等待期、已交保险费、基本保险金额或现金价值比较项；出现则写入对应字段，未出现不得编造，可写 missingOrUnclear only if该类产品通常需要核验/来源不清。',
    '保险期间、等待期内外给付差异、给付基准必须写清楚；不要加入现金价值或红利责任。',
  ].join('\n'),
  ordinary_whole_life: [
    '普通终身寿险模板：检查来源是否出现身故保险金、全残保险金、等待期、年龄段、给付系数、已交保险费、基本保险金额和现金价值比较项；出现则写入对应字段，未出现不得编造，可写 missingOrUnclear only if该类产品通常需要核验/来源不清。',
    '现金价值、贷款、减保、受益人指定是产品功能或重要提示，不是保险责任。',
  ].join('\n'),
  universal_life: [
    '万能保险模板：检查来源是否出现身故/全残等保险金、账户价值、结算利率、保证利率、费用和投资风险；保险金出现则写入 responsibilities，账户/利率/费用/风险出现则放入 productFunctions 或 importantNotes，未出现不得编造。',
    '账户价值依赖结算利率、费用和实际账户状态，不要硬算。',
  ].join('\n'),
  investment_linked: [
    '投资连结保险模板：检查来源是否出现身故/全残等保险金、账户价值、投资账户、单位价格、结算利率、保证利率、费用和投资风险；保险金出现则写入 responsibilities，账户/利率/费用/风险出现则放入 productFunctions 或 importantNotes，未出现不得编造。',
    '必须提示投资风险和账户价值不保证；不要硬算账户价值或投资收益。',
  ].join('\n'),
  long_term_care: [
    '长期护理保险模板：检查来源是否出现护理保险金、长期护理状态/失能状态触发条件、等待期、给付期间/频率/限额，以及身故或满期责任；出现则写入 responsibilities，未出现不得编造，可写 missingOrUnclear only if该类产品通常需要核验/来源不清。',
    '护理状态认定依赖条款和事实材料，不要自行认定或硬算。',
  ].join('\n'),
};

function categoryInstructions(routing = {}, sourceSections = {}) {
  const category = text(routing.productCategory);
  const sectionsText = sourceText(sourceSections);
  const mainInstruction = category === 'incremental_whole_life'
    ? incrementalWholeLifeInstructions(routing, sectionsText)
    : category === 'endowment'
      ? endowmentInstructions(routing, sectionsText)
    : CATEGORY_INSTRUCTIONS[category] || '通用模板：按来源中的保险责任名称逐项摘要；保险责任、产品功能、重要提示必须分开。未知或其他险种也必须避免把现金价值、红利、贷款、减保、受益人指定混入 responsibilities。';
  return [mainInstruction, participatingInstruction(routing, category)].filter(Boolean).join('\n');
}

export function buildStructuredResponsibilityPrompt({
  product = {},
  routing = {},
  sourceSections = {},
  cards = [],
  indicators = [],
  plannerResult = null,
} = {}) {
  const plannerPayload = compactPlannerResult(plannerResult);
  const payload = {
    product,
    routing,
    planner: plannerPayload,
    sourceSections: compactPromptSourceSections(sourceSections),
    cards: compactPromptCards(cards),
    indicators: compactPromptIndicators(indicators),
  };

  return [
    '你是一名中国保险责任摘要助手。请只依据输入资料，为普通用户输出保险责任摘要。',
    '',
    '输出要求：只输出合法 JSON，JSON only，不要 Markdown，不要代码块，不要解释性前后缀。',
    '',
    '统一 JSON Schema：',
    '{"productCategory":"","categoryLabel":"","headline":"","responsibilities":[{"title":"","plainText":"","triggerCondition":"","paymentRule":"","calculationStatus":"claim_contingent|scheduled_cashflow|needs_table|waiver_only|not_calculable","sourceRefs":["sourceRefId"]}],"productFunctions":[],"importantNotes":[],"missingOrUnclear":[],"contentBlocks":[{"blockKey":"productPurpose|responsibilities|productFunctions|attentionNotes","title":"","enabled":true,"editable":true,"order":1,"content":""}]}',
    '',
    '字段要求：',
    '- productCategory 和 categoryLabel 使用路由结果；headline 用一句话概括主要保障。',
    '- responsibilities[] 只能放保险责任，每项必须包含 title、plainText、triggerCondition、paymentRule、calculationStatus。',
    '- 优先依据 sourceSections.mainResponsibilityText 和 coverageSections[] 中的完整官方保险责任正文；不要依赖被截断的小片段判断责任数字。',
    '- sourceSections.responsibilityItems[] 可能为空；保险责任正文默认不切片，避免跨页、列表汇总或编号边界切坏。',
    '- sourceSections.sourceInventory 是资料清单；sourceRefs 是责任项/章节对应的官方来源短引用。每项 responsibility 如果能对应到 item.sourceRefs，请把 sourceRefId 放入 responsibilities[].sourceRefs。',
    '- sourceSections.gaps 是缺失或需核验的信息，只能写入 missingOrUnclear 或 importantNotes，不得自行补齐。',
    '- productFunctions 放现金价值、红利、保单贷款、减保、账户价值、投资账户、受益人指定等非责任功能。',
    '- importantNotes 放红利不保证、复利递增非收益率、医疗/护理/疾病/账户价值依赖事实或表格等重要提示。',
    '- missingOrUnclear 放来源缺失、条件不明、需要费率表/现金价值表/疾病表/伤残表/理赔事实才能确定的项目。',
    '- contentBlocks 固定返回四块：productPurpose（产品主要做什么）、responsibilities（主要保险责任）、productFunctions（产品功能/权益）、attentionNotes（注意事项）。',
    '- 每个 contentBlocks 元素必须包含 blockKey、title、enabled、editable、order、content；除 productFunctions 外 enabled 和 editable 都为 true，order 从 1 开始。',
    '- contentBlocks.productFunctions 使用已有开关关闭：enabled 必须为 false；其内容可留空或简短保留，但页面不展示。',
    '- contentBlocks.productPurpose 必须先归纳产品定位，再说明核心用途；如果 planner.positioningFocus 有复合定位，必须体现出来。',
    '- contentBlocks.responsibilities 必须先用一句话归纳保障结构，再列主要责任；当相似责任超过10条时，必须按场景分组，不得机械逐条堆叠。',
    '- 兼容旧字段：如果你使用 mainResponsibilities、notices、requiredPolicyFields、sourceUrls，也必须与 responsibilities、importantNotes 和输入来源保持一致。',
    '',
    '硬性规则：',
    '- 只使用输入 sourceSections、cards、indicators 中能支持的内容；不要编造、补全或引用外部知识。',
    '- responsibilities[] 应从完整保险责任正文中识别，不要只根据 headline 或产品名称写泛泛摘要。',
    '- 每个责任项的 paymentRule 必须尽量覆盖完整保险责任正文中的等待期、年龄段、给付比例、较大者/最大者、递增公式、额外给付倍数等。',
    '- 每个责任项的 sourceRefs 只能引用输入中已有的 sourceRefId；没有来源不要编造 sourceRefId。',
    '- 必须把保险责任和产品功能分开。',
    '- 不得把现金价值、红利、保单贷款、减保、账户价值、投资账户、受益人指定混入 responsibilities。',
    '- 不要硬算依赖现金价值、账户价值、疾病表、伤残等级表、费用票据、红利、结算利率或理赔事实的金额。',
    '- 检查来源是否出现；出现则写入 responsibilities；未出现不得编造，可写 missingOrUnclear only if该类产品通常需要核验/来源不清。',
    '- 来源没有写明的责任、比例、年龄段、领取日、频率、限额，不要推断。',
    '- 对“两全保险 + 交通/特定意外高倍保障”这类复合产品，responsibilities[] 可保留官方细项，但 contentBlocks.responsibilities 必须归纳后分组展示。',
    '',
    '类别专用指令：',
    categoryInstructions(routing, sourceSections),
    '',
    ...(plannerPayload
      ? [
          'Planner 结果如下。它只用于提示写作重点，不能覆盖官方资料：',
          JSON.stringify(plannerPayload, null, 2),
          '',
        ]
      : [
          'Planner 未使用：请完全根据本地分类、官方结构化证据和产品名称写作。',
          '',
        ]),
    '输入资料 JSON：',
    JSON.stringify(payload, null, 2),
  ].join('\n');
}

export function buildOfficialResponsibilityRetryPrompt({
  product = {},
  routing = {},
  sourceSections = {},
} = {}) {
  const payload = {
    product,
    routing,
    sourceSections: compactPromptSourceSections(sourceSections),
  };

  return [
    '你是一名中国保险条款摘要助手。上一次摘要未通过质量校验，请仅依据下面的官方保险责任正文重新输出。',
    '',
    '输出要求：只输出合法 JSON，JSON only，不要 Markdown，不要代码块，不要解释性前后缀。',
    '',
    '统一 JSON Schema：',
    '{"productCategory":"","categoryLabel":"","headline":"","responsibilities":[{"title":"","plainText":"","triggerCondition":"","paymentRule":"","calculationStatus":"claim_contingent|scheduled_cashflow|needs_table|waiver_only|not_calculable","sourceRefs":["sourceRefId"]}],"productFunctions":[],"importantNotes":[],"missingOrUnclear":[]}',
    '',
    '重写规则：',
    '- 先按官方正文中的责任标题逐项识别，再改写成普通用户能读懂的保险责任摘要。',
    '- 优先读取 sourceSections.mainResponsibilityText 和 coverageSections[] 的完整官方责任正文；责任正文默认不切片。',
    '- 每项责任如果能对应到 item.sourceRefs，请把 sourceRefId 放入 responsibilities[].sourceRefs；只能引用输入中已有的 sourceRefId。',
    '- responsibilities[] 只能放正文明确写出的保险责任；不得凭产品名称或常识补责任。',
    '- paymentRule 要保留原文中的比例、年龄段、等待期、领取日、较大者/最大者、递增公式等关键规则。',
    '- 如果正文出现“基本保险金额×(1+X%)^(n-1)”或“1.035”等公式，说明这是给付基准按对应比例复利递增，并提示不等于收益率。',
    '- 红利、现金价值、保单贷款、减保、受益人指定等只放 productFunctions 或 importantNotes，除非正文明确把它作为给付比较项。',
    '- 任何来源没有写明的比例、功能或责任都不要写；确实不清楚才放 missingOrUnclear。',
    '- sourceSections.gaps 中列出的缺失资料只能作为需核验提示，不得自行补齐。',
    '',
    '类别专用指令：',
    categoryInstructions(routing, sourceSections),
    '',
    '官方责任正文 JSON：',
    JSON.stringify(payload, null, 2),
  ].join('\n');
}
