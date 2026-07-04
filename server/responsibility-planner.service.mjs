import { jsonrepair } from 'jsonrepair';

const PLANNER_MODE_SET = new Set(['auto', 'all', 'off']);
const COMPLEX_CATEGORIES = new Set([
  'participating_life',
  'annuity',
  'critical_illness',
  'universal_life',
  'investment_linked',
  'endowment',
  'long_term_care',
]);
const COMPLEX_SIGNAL_PATTERN =
  /(分红|累积红利|可选责任|年金|疾病组|多次给付|豁免|护理|账户价值|保证利率|复利|三者最大|二者较大|领取日|结算利率|投资风险|费用)/u;
const TRAFFIC_OR_SPECIFIC_ACCIDENT_PATTERN =
  /(交通|航空|列车|客运|轮船|汽车|驾乘|步行|骑行|电梯|高空|公共场所|自然灾害|意外.{0,12}(?:10|15|20|30|40|60)\s*倍)/u;

function textOf(value) {
  if (typeof value === 'string') return value.trim();
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function compactText(value, limit = 1200) {
  const text = textOf(value).replace(/\s+/gu, ' ');
  return text.length <= limit ? text : `${text.slice(0, limit)}...`;
}

function compactArray(items, mapper, limit = 8) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, limit).map(mapper).filter(Boolean);
}

function stringArray(value, limit = 8) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => compactText(item, 160))
    .filter(Boolean)
    .slice(0, limit);
}

function uniqueStrings(values = [], limit = 8) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const item = compactText(value, 160);
    if (!item || seen.has(item)) continue;
    seen.add(item);
    result.push(item);
    if (result.length >= limit) break;
  }
  return result;
}

function compactSourceSections(sourceSections = {}) {
  return {
    quality: sourceSections.quality || null,
    sourceInventory: compactArray(sourceSections.sourceInventory, (source) => ({
      title: compactText(source?.title || source?.name, 80),
      url: compactText(source?.url, 240),
    })),
    mainResponsibilityText: compactText(sourceSections.mainResponsibilityText, 5000),
    coverageSections: compactArray(sourceSections.coverageSections, (section) => ({
      title: compactText(section?.title, 80),
      body: compactText(section?.text || section?.body, 3000),
    }), 3),
    responsibilityItems: compactArray(sourceSections.responsibilityItems, (item) => ({
      title: compactText(item?.title, 80),
      body: compactText(item?.body || item?.plainText || item?.paymentRule || item?.triggerCondition, 1500),
      sourceRefs: compactArray(item?.sourceRefs, (ref) => ({
        title: compactText(ref?.title || ref?.sourceTitle, 80),
        page: ref?.page ?? ref?.pageNumber ?? null,
      }), 4),
    }), 12),
    supplementSections: compactArray(sourceSections.supplementSections, (section) => ({
      title: compactText(section?.title, 80),
      body: compactText(section?.body || section?.text, 1000),
    }), 8),
    gaps: compactArray(sourceSections.gaps, (gap) => compactText(gap, 120), 8),
  };
}

function parsePlannerJson(raw) {
  const text = textOf(raw);
  if (!text) throw new Error('Planner returned empty content');
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/iu);
  const candidates = [
    text,
    fenced?.[1] || '',
    text.includes('{') && text.includes('}') ? text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1) : '',
  ].map(textOf).filter(Boolean);
  const seen = new Set();
  let lastError = null;
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    try {
      return JSON.parse(candidate);
    } catch (error) {
      lastError = error;
    }
    try {
      return JSON.parse(jsonrepair(candidate));
    } catch (error) {
      lastError = error;
    }
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Planner JSON parse failed: ${(lastError || error).message}`);
  }
}

export function normalizeResponsibilityPlannerMode(value, fallback = 'auto') {
  const normalizedFallback = PLANNER_MODE_SET.has(textOf(fallback).toLowerCase()) ? textOf(fallback).toLowerCase() : 'auto';
  const normalized = textOf(value).toLowerCase();
  return PLANNER_MODE_SET.has(normalized) ? normalized : normalizedFallback;
}

export function shouldUseResponsibilityPlanner({ mode = 'auto', routing = {}, sourceSections = {} } = {}) {
  const normalizedMode = normalizeResponsibilityPlannerMode(mode);
  if (normalizedMode === 'off') return { usePlanner: false, reason: 'disabled' };
  if (normalizedMode === 'all') return { usePlanner: true, reason: 'forced_all' };

  const category = textOf(routing.productCategory);
  const tags = Array.isArray(routing.featureTags) ? routing.featureTags : [];
  const items = Array.isArray(sourceSections.responsibilityItems) ? sourceSections.responsibilityItems : [];
  const coverageSections = Array.isArray(sourceSections.coverageSections) ? sourceSections.coverageSections : [];
  const supplements = Array.isArray(sourceSections.supplementSections) ? sourceSections.supplementSections : [];
  const joinedEvidence = compactText(
    [
      category,
      textOf(routing.categoryLabel),
      tags.map((tag) => textOf(tag)).join(' '),
      textOf(sourceSections.mainResponsibilityText),
      ...coverageSections.map((section) => `${textOf(section?.title)} ${textOf(section?.text || section?.body)}`),
      ...items.map((item) => `${textOf(item?.title)} ${textOf(item?.body)} ${textOf(item?.paymentRule)}`),
      ...supplements.map((item) => `${textOf(item?.title)} ${textOf(item?.body)}`),
    ].join('\n'),
    12000,
  );

  if (textOf(routing.modelTier) === 'pro') return { usePlanner: true, reason: 'pro_model_routing' };
  if (COMPLEX_CATEGORIES.has(category)) return { usePlanner: true, reason: 'complex_category' };
  if (tags.some((tag) => /participating|optional|account|disease|compound|annuity/u.test(textOf(tag)))) {
    return { usePlanner: true, reason: 'complex_feature_tag' };
  }
  if (joinedEvidence.length > 5000) return { usePlanner: true, reason: 'long_official_evidence' };
  if (COMPLEX_SIGNAL_PATTERN.test(joinedEvidence)) return { usePlanner: true, reason: 'complex_evidence_signal' };
  return { usePlanner: false, reason: 'simple_product' };
}

export function buildResponsibilityPlannerPrompt({
  product,
  localRouting,
  sourceSections,
  cards = [],
  indicators = [],
} = {}) {
  const payload = {
    product: {
      company: textOf(product?.company),
      productName: textOf(product?.productName || product?.name),
    },
    localRouting: localRouting || {},
    sourceSections: compactSourceSections(sourceSections),
    cards: compactArray(cards, (card) => ({
      title: compactText(card?.title || card?.productName || card?.name, 80),
      content: compactText(card?.content || card?.text || card?.summary, 1000),
    }), 6),
    indicators: compactArray(indicators, (indicator) => ({
      name: compactText(indicator?.name || indicator?.label || indicator?.key, 80),
      value: compactText(indicator?.value || indicator?.text, 240),
    }), 10),
  };

  return [
    '你是保险产品理解 Planner，只负责整理证据和给最终写作模型提供方向，不写最终客户文案。',
    '只返回 JSON，不要 Markdown，不要解释，不要营销话术。',
    'Planner 不能覆盖官方资料；官方证据没有出现的产品功能必须写入 missingOrUnclear，不要放入 functionFocus。',
    '不要编造未支持的产品功能，不要写营销文案。',
    '请输出字段：plannerVersion, productCategory, categoryLabel, confidence, recommendedTemplate, positioningFocus, productPurposeFocus, responsibilityFocus, functionFocus, attentionFocus, evidenceNeeds, missingOrUnclear, notesForFinalPrompt。',
    'confidence 只能是 high, medium, low。',
    'positioningFocus 用于复合定位；如果本地分类是两全保险且证据出现交通/航空/驾乘/电梯/自然灾害等特定意外高倍给付，必须同时包含“两全保险”和“交通/特定意外高倍保障”。',
    '对于责任很多的交通/特定意外产品，notesForFinalPrompt 必须提醒最终模型先归纳保障结构，再按场景分组列责任，不要把10条以上责任机械塞进一个展示块。',
    '输入证据如下：',
    JSON.stringify(payload, null, 2),
  ].join('\n');
}

function plannerEvidenceText(sourceSections = {}) {
  return [
    textOf(sourceSections.mainResponsibilityText),
    ...compactArray(sourceSections.coverageSections, (section) => `${textOf(section?.title)} ${textOf(section?.text || section?.body)}`, 8),
    ...compactArray(sourceSections.responsibilityItems, (item) => `${textOf(item?.title)} ${textOf(item?.body)} ${textOf(item?.paymentRule)}`, 20),
  ].join('\n');
}

function compositePositioningHints(routing = {}, sourceSections = {}) {
  const category = textOf(routing.productCategory);
  const tags = Array.isArray(routing.featureTags) ? routing.featureTags.map(textOf) : [];
  const evidence = plannerEvidenceText(sourceSections);
  const hasTrafficOrSpecificAccident = tags.includes('traffic_accident_extra')
    || TRAFFIC_OR_SPECIFIC_ACCIDENT_PATTERN.test(evidence);
  if (category === 'endowment' && hasTrafficOrSpecificAccident) {
    return ['两全保险', '交通/特定意外高倍保障'];
  }
  return [];
}

function enrichPlannerOutput(planner = {}, routing = {}, sourceSections = {}) {
  const positioningHints = compositePositioningHints(routing, sourceSections);
  const notes = positioningHints.length
    ? ['先归纳为两全保险 + 交通/特定意外高倍保障，再按满期/身故全残/意外场景分组列责任；不要把10条以上责任机械塞进一个展示块。']
    : [];
  return {
    ...planner,
    categoryLabel: positioningHints.length && !/意外保障型/u.test(planner.categoryLabel)
      ? '意外保障型两全保险'
      : planner.categoryLabel,
    positioningFocus: uniqueStrings([
      ...stringArray(planner.positioningFocus),
      ...positioningHints,
    ]),
    notesForFinalPrompt: uniqueStrings([
      ...stringArray(planner.notesForFinalPrompt),
      ...notes,
    ]),
  };
}

export function normalizeResponsibilityPlannerOutput(raw, fallbackRouting = {}) {
  const value = typeof raw === 'string' ? parsePlannerJson(raw) : raw;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Planner JSON output is not an object');
  }

  return {
    plannerVersion: compactText(value.plannerVersion || 'product-understanding-planner-v1', 80),
    productCategory: compactText(value.productCategory || fallbackRouting.productCategory, 80),
    categoryLabel: compactText(value.categoryLabel || fallbackRouting.categoryLabel, 80),
    confidence: ['high', 'medium', 'low'].includes(value.confidence) ? value.confidence : 'medium',
    recommendedTemplate: compactText(value.recommendedTemplate, 80),
    positioningFocus: stringArray(value.positioningFocus),
    productPurposeFocus: stringArray(value.productPurposeFocus),
    responsibilityFocus: stringArray(value.responsibilityFocus),
    functionFocus: stringArray(value.functionFocus),
    attentionFocus: stringArray(value.attentionFocus),
    evidenceNeeds: stringArray(value.evidenceNeeds),
    missingOrUnclear: stringArray(value.missingOrUnclear),
    notesForFinalPrompt: stringArray(value.notesForFinalPrompt),
  };
}

export async function callDeepSeekForResponsibilityPlanner({
  prompt,
  model = 'deepseek-v4-flash',
  fetchImpl = globalThis.fetch,
} = {}) {
  const apiKey = textOf(process.env.DEEPSEEK_API_KEY);
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY is required for responsibility Planner');
  const baseUrl = textOf(process.env.DEEPSEEK_BASE_URL) || 'https://api.deepseek.com';
  const response = await fetchImpl(`${baseUrl.replace(/\/$/u, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: '你只返回可解析 JSON。' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.1,
      response_format: { type: 'json_object' },
    }),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = textOf(payload?.error?.message) || `DeepSeek Planner request failed: ${response.status}`;
    throw new Error(message);
  }
  return textOf(payload?.choices?.[0]?.message?.content);
}

export async function runResponsibilityPlanner({
  mode = process.env.RESPONSIBILITY_PLANNER_MODE || 'auto',
  model = process.env.RESPONSIBILITY_PLANNER_MODEL || 'deepseek-v4-flash',
  product,
  routing,
  sourceSections,
  cards = [],
  indicators = [],
  generateWithDeepSeek = callDeepSeekForResponsibilityPlanner,
  logger = console,
} = {}) {
  const plannerMode = normalizeResponsibilityPlannerMode(mode, 'auto');
  const decision = shouldUseResponsibilityPlanner({ mode: plannerMode, routing, sourceSections });
  if (!decision.usePlanner) {
    logger?.info?.(`[customer-responsibility-planner] skipped/${decision.reason}`);
    return {
      plannerMode,
      plannerUsed: false,
      plannerReason: decision.reason,
      plannerModel: model,
      planner: null,
      plannerPrompt: null,
      plannerError: null,
    };
  }

  const prompt = buildResponsibilityPlannerPrompt({
    product,
    localRouting: routing,
    sourceSections,
    cards,
    indicators,
  });

  try {
    logger?.info?.(`[customer-responsibility-planner] called model=${model} mode=${plannerMode}`);
    const raw = await generateWithDeepSeek({ prompt, model });
    const planner = enrichPlannerOutput(normalizeResponsibilityPlannerOutput(raw, routing), routing, sourceSections);
    logger?.info?.(
      `[customer-responsibility-planner] parsed category=${planner.productCategory} template=${planner.recommendedTemplate}`,
    );
    return {
      plannerMode,
      plannerUsed: true,
      plannerReason: decision.reason,
      plannerModel: model,
      planner,
      plannerPrompt: prompt,
      plannerError: null,
    };
  } catch (error) {
    logger?.warn?.(`[customer-responsibility-planner] failed ${error.message}`);
    return {
      plannerMode,
      plannerUsed: false,
      plannerReason: 'planner_failed',
      plannerModel: model,
      planner: null,
      plannerPrompt: prompt,
      plannerError: error.message,
    };
  }
}
