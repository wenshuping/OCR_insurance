#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const DEFAULT_DB = '/Users/wenshuping/OCR_insurance_ssd/.runtime/local/policy-ocr.sqlite';
const BASIC_ANNIVERSARY_RE = /(?:该)?保单生效对应日(?:的)?基本责任(?:的)?保险金额/u;
const OPTIONAL_ANNIVERSARY_RE = /(?:该)?保单生效对应日(?:的)?可选责任(?:的)?保险金额/u;
const DUPLICATE_BASIC_ANNIVERSARY_RE = /(?:该)?保单生效对应日(?:的)?(?:该)?保单生效对应日(?:的)?基本责任(?:的)?保险金额/u;
const LEGACY_BROAD_BASIC_ANNIVERSARY_RE = /保单生效对应日.{0,12}基本责任保险金额/u;
const PARTICIPATING_RE = /年度红利|(?:累积|累计)红利保险金额|增额红利|红利保险金额/u;
const PARTICIPATING_PRODUCT_RE = /分红|红利/u;
const ANNIVERSARY_DYNAMIC_RE = /(?:该)?保单生效对应日(?:的)?(?:基本责任|可选责任|基本|有效)(?:的)?保险金额/u;
const DIVIDEND_COMPONENT_RE = /(?:基本(?:责任)?|有效|可选责任)?保险金额\s*(?:加|\+|＋)\s*(?:已确定的)?(?:累积|累计)红利保险金额|(?:累积|累计)红利保险金额\s*(?:加|\+|＋)\s*(?:基本(?:责任)?|有效|可选责任)?保险金额/u;
const TARGET_PRODUCT_LINE_RE = /年金|两全|寿险|养老/u;
const STATIC_AMOUNT_KEYS = new Set(['basic_amount', 'basic_responsibility_amount', 'coverage_amount', 'sum_assured']);
const SEMANTIC_FIELDS = [
  'formulaText', 'normalizedFormula', 'basisKey', 'calculationKey', 'calculationEligible',
  'requiredInputs', 'operands', 'branches', 'payoutSummary', 'customerSummary', 'plainSummary',
];

function text(value) {
  return String(value ?? '').trim();
}

function parseJson(value, fallback = {}) {
  try {
    return JSON.parse(text(value));
  } catch {
    return fallback;
  }
}

function arg(name, fallback = '') {
  const prefix = `--${name}=`;
  const inline = process.argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function writeJsonFile(target, value) {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  fs.writeFileSync(target, content);
  return digest(content);
}

function normalized(value) {
  return text(value).replace(/\s+/gu, '').replace(/[（）()]/gu, '');
}

function issue({ code, severity = 'error', product, indicator, reason, recommendedAction, evidence = [] }) {
  return {
    code,
    severity,
    productKey: product.key,
    company: product.company,
    productName: product.productName,
    indicatorId: text(indicator?.id),
    liability: text(indicator?.liability),
    formulaText: text(indicator?.formulaText),
    sourceDigest: text(indicator?.sourceDigest || product.sourceDigest),
    sourceUrl: text(indicator?.sourceUrl || product.sourceUrl),
    reason,
    recommendedAction,
    evidence: evidence.filter(Boolean),
  };
}

function scopeClause(company, productName) {
  const terms = [];
  const values = [];
  if (company) {
    terms.push('company = ?');
    values.push(company);
  }
  if (productName) {
    terms.push('product_name = ?');
    values.push(productName);
  }
  return { where: terms.length ? ` WHERE ${terms.join(' AND ')}` : '', values };
}

function readProductRows(db, table, company, productName) {
  const scope = scopeClause(company, productName);
  return db.prepare(`SELECT * FROM ${table}${scope.where}`).all(...scope.values)
    .map((row) => ({ ...row, payload: parseJson(row.payload) }));
}

function indicatorFromRow(row) {
  const payload = row.payload || {};
  return {
    ...payload,
    id: text(payload.id || row.id),
    company: text(payload.company || row.company),
    productName: text(payload.productName || row.product_name),
    liability: text(payload.liability || row.liability),
    coverageType: text(payload.coverageType || row.coverage_type),
    category: text(payload.category || payload.productCategory),
    productType: text(payload.productType),
    sourceDigest: text(payload.sourceDigest || payload.responsibilitySourceDigest || payload.productIdentity?.sourceDigest),
    sourceUrl: text(payload.sourceUrl || payload.productIdentity?.sourceUrl),
  };
}

function cardFromRow(row) {
  const payload = row.payload || {};
  return {
    ...payload,
    id: text(payload.id || row.id),
    company: text(payload.company || row.company),
    productName: text(payload.productName || row.product_name),
    title: text(payload.title || row.title),
    category: text(payload.category || row.category || payload.productCategory || payload.productType),
    productType: text(payload.productType || payload.category || row.category),
  };
}

function artifactFromRow(row) {
  const payload = row.payload || {};
  return {
    ...payload,
    id: text(row.id),
    company: text(payload.company || row.company),
    productName: text(payload.productName || row.product_name),
    sourceDigest: text(payload.sourceDigest || payload.productIdentity?.sourceDigest || row.source_digest),
    sourceUrl: text(payload.sourceUrl || payload.productIdentity?.sourceUrl || row.source_url),
    approved: text(payload.audit?.status) === 'approved',
    acceptedResponsibilities: Array.isArray(payload.acceptedResponsibilities)
      ? payload.acceptedResponsibilities.length
      : Array.isArray(payload.responsibilities) ? payload.responsibilities.length : 0,
    blockers: Array.isArray(payload.blockers) ? payload.blockers.length : 0,
    category: text(payload.category),
    productType: text(payload.productType || payload.productOverview?.productType),
    evidenceText: JSON.stringify(payload),
  };
}

function productKey(company, productName) {
  return `${company}\u001f${productName}`;
}

function sourceText(indicator) {
  return [
    indicator.liability,
    indicator.formulaText,
    indicator.basis,
    indicator.condition,
    indicator.sourceExcerpt,
    indicator.basisDefinition?.formulaText,
    indicator.basisDefinition?.sourceExcerpt,
    indicator.normalizedFormula,
    indicator.requiredInputs,
    indicator.payoutSummary,
    indicator.customerSummary,
    indicator.plainSummary,
  ].map(text).join('\n');
}

function sourceParts(indicator) {
  const excerpt = text(indicator.sourceExcerpt);
  const liability = text(indicator.liability).replace(/\s+/gu, '');
  const compactExcerpt = excerpt.replace(/\s+/gu, '');
  const liabilityIndex = liability ? compactExcerpt.indexOf(liability) : -1;
  const linkedExcerpt = liabilityIndex >= 0
    ? compactExcerpt.slice(liabilityIndex, liabilityIndex + 360)
    : '';
  return [
    indicator.liability,
    indicator.formulaText,
    indicator.basis,
    indicator.condition,
    linkedExcerpt,
    indicator.basisDefinition?.formulaText,
    indicator.basisDefinition?.sourceExcerpt,
    indicator.normalizedFormula,
  ].map(text);
}

function hasPhrase(parts, pattern) {
  return parts.some((part) => pattern.test(part.replace(/\s+/gu, '')));
}

function duplicatePhraseField(value) {
  return DUPLICATE_BASIC_ANNIVERSARY_RE.test(text(value).replace(/\s+/gu, ''));
}

function semanticValue(value) {
  if (Array.isArray(value)) return JSON.stringify(value);
  if (value && typeof value === 'object') return JSON.stringify(value);
  return text(value);
}

function hasDividendComponent(parts) {
  return parts.some((part) => DIVIDEND_COMPONENT_RE.test(text(part).replace(/\s+/gu, '')));
}

function normalizedProductText(value) {
  return text(value).normalize('NFKC').replace(/\s+/gu, '').replace(/[（）()]/gu, '');
}

function isExcludedIncrementalWholeLife(product) {
  return /增额(?:终身寿|寿险|终身)/u.test(`${product.company}${product.productName}`);
}

function productHasParticipatingEvidence(product) {
  const explicitIdentity = PARTICIPATING_PRODUCT_RE.test(product.productName)
    || [...product.categories].some((value) => PARTICIPATING_PRODUCT_RE.test(value));
  if (explicitIdentity) return true;
  const targetLine = [...product.productTypes, ...product.categories, product.productName]
    .some((value) => TARGET_PRODUCT_LINE_RE.test(value));
  if (!targetLine) return false;
  return product.indicators.some((indicator) => {
    const parts = sourceParts(indicator);
    return PARTICIPATING_RE.test(sourceText(indicator))
      && (hasPhrase(parts, ANNIVERSARY_DYNAMIC_RE) || hasDividendComponent(parts));
  });
}

function productHasExplicitParticipatingIdentity(product) {
  return PARTICIPATING_PRODUCT_RE.test(product.productName)
    || [...product.categories].some((value) => PARTICIPATING_PRODUCT_RE.test(value));
}

function productCanonicalIdentity(product) {
  const digests = [...product.sourceDigests].filter(Boolean).sort();
  const urls = [...product.sourceUrls].filter(Boolean).sort();
  if (digests.length === 1) return `sourceDigest:${digests[0]}`;
  if (digests.length > 1) return `version-conflict:${normalizedProductText(product.company)}:${normalizedProductText(product.productName)}`;
  if (urls.length) return `sourceUrl:${urls.join('|')}`;
  return `product:${normalizedProductText(product.company)}:${normalizedProductText(product.productName)}`;
}

function comparableArtifact(product) {
  const artifacts = product.artifacts.filter((artifact) => (
    artifact.approved || (artifact.sourceDigest && artifact.acceptedResponsibilities > 0 && artifact.blockers === 0)
  ));
  const digestSet = product.sourceDigests;
  const urlSet = product.sourceUrls;
  return artifacts.find((artifact) => (
    (artifact.sourceDigest && digestSet.has(artifact.sourceDigest))
    || (!artifact.sourceDigest && artifact.sourceUrl && urlSet.has(artifact.sourceUrl))
  )) || null;
}

function issueClassification(issueItem, product) {
  if (isExcludedIncrementalWholeLife(product)) return 'excluded_incremental_whole_life';
  if (product.sourceDigests.size > 1) return 'version_conflict';
  const artifact = comparableArtifact(product);
  if (artifact) return 'true_positive';
  if (issueItem.code === 'CARD_INDICATOR_PROJECTION_MISMATCH') return 'materializer_blocked';
  return 'source_review';
}

function legacyFalsePositiveAudit(products) {
  const results = [];
  for (const product of products.values()) {
    if (product.company !== '新华保险' || product.productName !== '百年好合两全保险(分红型)') continue;
    for (const indicator of product.indicators) {
      const broadHit = LEGACY_BROAD_BASIC_ANNIVERSARY_RE.test(sourceText(indicator));
      const strictHit = hasPhrase(sourceParts(indicator), BASIC_ANNIVERSARY_RE);
      const staticDisplay = [indicator.formulaText, indicator.basis, indicator.payoutSummary]
        .map(text).join(' ');
      if (!broadHit || strictHit || !STATIC_AMOUNT_KEYS.has(text(indicator.basisKey))) continue;
      results.push({
        productKey: product.key,
        company: product.company,
        productName: product.productName,
        indicatorId: indicator.id,
        liability: indicator.liability,
        code: 'LEGACY_BROAD_REGEX_FALSE_POSITIVE',
        reason: '旧宽窗口正则命中了同一 sourceExcerpt 中其他责任的周年日短语；该责任自身仍是按基本责任保险金额给付。',
        evidence: [indicator.formulaText, staticDisplay],
        sourceDigests: [...product.sourceDigests].sort(),
        sourceUrls: [...product.sourceUrls].sort(),
        action: '记录误报，不修改百年好合产品数据。',
      });
    }
  }
  return results;
}

function duplicateKey(indicator) {
  const branchFingerprint = [
    ...(Array.isArray(indicator.branches) ? indicator.branches : []),
    ...(Array.isArray(indicator.operands) ? indicator.operands : []),
  ].map((item) => [
    normalized(item?.branchId),
    normalized(item?.conditionText || item?.condition),
    normalized(item?.formulaText),
    normalized(item?.basisKey),
    normalized(item?.calculationKey),
  ].join(':')).join('|');
  return [
    normalized(indicator.liability),
    normalized(indicator.formulaText),
    normalized(indicator.condition),
    normalized(indicator.basisKey),
    normalized(indicator.calculationKey),
    branchFingerprint,
  ].join('\u001f');
}

function repeatedFormula(indicator) {
  const formula = text(indicator.formulaText);
  const liability = text(indicator.liability);
  return Boolean(liability && new RegExp(`^${liability.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\s*=\\s*${liability.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\s*=`, 'u').test(formula));
}

function addProduct(map, company, productName) {
  const key = productKey(company, productName);
  if (!map.has(key)) {
    map.set(key, {
      key,
      company,
      productName,
      indicators: [],
      cards: [],
      artifacts: [],
      findings: [],
      sourceDigest: '',
      sourceUrl: '',
      sourceDigests: new Set(),
      sourceUrls: new Set(),
      productTypes: new Set(),
      categories: new Set(),
    });
  }
  return map.get(key);
}

export function auditParticipatingAnnuitySemantics(db, { company = '', productName = '' } = {}) {
  const products = new Map();
  for (const row of readProductRows(db, 'insurance_indicator_records', company, productName)) {
    const indicator = indicatorFromRow(row);
    const product = addProduct(products, indicator.company, indicator.productName);
    product.indicators.push(indicator);
    if (indicator.productType) product.productTypes.add(indicator.productType);
    if (indicator.category) product.categories.add(indicator.category);
    product.sourceDigest ||= indicator.sourceDigest;
    product.sourceUrl ||= indicator.sourceUrl;
    if (indicator.sourceDigest) product.sourceDigests.add(indicator.sourceDigest);
    if (indicator.sourceUrl) product.sourceUrls.add(indicator.sourceUrl);
  }
  for (const row of readProductRows(db, 'product_responsibility_cards', company, productName)) {
    const card = cardFromRow(row);
    const product = addProduct(products, card.company, card.productName);
    product.cards.push(card);
    if (card.productType) product.productTypes.add(card.productType);
    if (card.category) product.categories.add(card.category);
  }
  for (const row of readProductRows(db, 'product_responsibility_artifacts', company, productName)) {
    const artifact = artifactFromRow(row);
    const product = addProduct(products, artifact.company, artifact.productName);
    product.artifacts.push(artifact);
    if (artifact.productType) product.productTypes.add(artifact.productType);
    if (artifact.category) product.categories.add(artifact.category);
    product.sourceDigest ||= artifact.sourceDigest;
    product.sourceUrl ||= artifact.sourceUrl;
    if (artifact.sourceDigest) product.sourceDigests.add(artifact.sourceDigest);
    if (artifact.sourceUrl) product.sourceUrls.add(artifact.sourceUrl);
  }

  const issues = [];
  for (const product of products.values()) {
    const inGovernanceScope = productHasParticipatingEvidence(product)
      && !isExcludedIncrementalWholeLife(product);
    if (!inGovernanceScope) continue;
    const byId = new Map(product.indicators.map((indicator) => [indicator.id, indicator]));
    const hasParticipatingArtifactEvidence = product.artifacts.some((artifact) => (
      (artifact.approved || (artifact.sourceDigest && artifact.acceptedResponsibilities > 0 && artifact.blockers === 0))
      && PARTICIPATING_RE.test(artifact.evidenceText)
    ));
    const duplicated = new Map();

    for (const indicator of product.indicators) {
      const evidenceText = sourceText(indicator);
      const evidenceParts = sourceParts(indicator);
      const basicAnniversary = hasPhrase(evidenceParts, BASIC_ANNIVERSARY_RE);
      const optionalAnniversary = hasPhrase(evidenceParts, OPTIONAL_ANNIVERSARY_RE);
      const dynamicAnniversary = hasPhrase(evidenceParts, ANNIVERSARY_DYNAMIC_RE);
      const dividendComponent = hasDividendComponent([
        indicator.sourceExcerpt,
        indicator.basisDefinition?.sourceExcerpt,
      ]);
      const basisKey = text(indicator.basisKey);
      const calculationKey = text(indicator.calculationKey);
      if (dynamicAnniversary && (
        STATIC_AMOUNT_KEYS.has(basisKey)
        || calculationKey === 'basic_amount'
        || indicator.calculationEligible === true
      )) {
        issues.push(issue({
          code: optionalAnniversary ? 'ANNIVERSARY_OPTIONAL_AMOUNT_COLLAPSED' : 'ANNIVERSARY_BASIC_AMOUNT_COLLAPSED',
          product,
          indicator,
          reason: optionalAnniversary
            ? '同一责任官方证据明确使用保单周年日可选责任/保险金额，但原子指标已降级为静态保额或可直接计算。'
            : '同一责任官方证据明确使用保单周年日基本/有效保险金额，但原子指标已降级为静态基本保额或可直接计算。',
          recommendedAction: optionalAnniversary
            ? '保留动态周年日可选责任基数、客户选择状态与表格门禁。'
            : '使用 policy_anniversary_basic_amount + schedule_or_policy_table；要求 policyScheduleTable 与 policyYearOrAge，并禁止运行时取初始基本保额。',
          evidence: [indicator.formulaText, indicator.sourceExcerpt, `basisKey=${basisKey}`, `calculationKey=${calculationKey}`],
        }));
      }
      if (dynamicAnniversary && !optionalAnniversary && !STATIC_AMOUNT_KEYS.has(basisKey)
        && calculationKey !== 'basic_amount' && indicator.calculationEligible !== true) {
        product.findings.push({
          kind: 'dynamic_amount_correct',
          indicatorId: indicator.id,
          liability: indicator.liability,
        });
      } else if (!dynamicAnniversary && STATIC_AMOUNT_KEYS.has(basisKey)) {
        product.findings.push({
          kind: 'legitimate_static_amount',
          indicatorId: indicator.id,
          liability: indicator.liability,
        });
      }
      if (dividendComponent) {
        const projectedFields = [
          indicator.formulaText, indicator.normalizedFormula, indicator.basisKey, indicator.calculationKey,
          indicator.requiredInputs, indicator.operands, indicator.branches,
          indicator.payoutSummary, indicator.customerSummary, indicator.plainSummary,
        ];
        if (!hasDividendComponent(projectedFields)) {
          issues.push(issue({
            code: 'DIVIDEND_COMPONENT_LOST',
            product,
            indicator,
            reason: '同一责任官方证据明确由基本/有效保险金额与累积红利保险金额组成，但 artifact→indicator 投影未保留红利组成。',
            recommendedAction: '从同版 approved artifact 重建 indicator、责任卡和客户展示字段；不得猜测未来红利。',
            evidence: [indicator.sourceExcerpt, indicator.formulaText, indicator.normalizedFormula],
          }));
        }
      }
      for (const [field, value] of [
        ['formulaText', indicator.formulaText],
        ['normalizedFormula', indicator.normalizedFormula],
        ['payoutSummary', indicator.payoutSummary],
        ['customerSummary', indicator.customerSummary],
        ['plainSummary', indicator.plainSummary],
      ]) {
        if (!duplicatePhraseField(value)) continue;
        issues.push(issue({
          code: 'DUPLICATE_ANNIVERSARY_BASIC_AMOUNT_PHRASE',
          severity: 'error',
          product,
          indicator,
          reason: `${field} 包含重复的周年日基本责任保险金额短语。`,
          recommendedAction: '通过幂等周年日基数规范化 helper 合并为单一短语，不改变公式比例、红利语义或现金流门禁。',
          evidence: [`${field}=${value}`],
        }));
      }
      if ((basicAnniversary || optionalAnniversary) && PARTICIPATING_RE.test(evidenceText) && !hasParticipatingArtifactEvidence) {
        issues.push(issue({
          code: 'PARTICIPATING_SOURCE_NOT_ARTIFACT_BACKED',
          severity: 'warning',
          product,
          indicator,
          reason: '分红/红利与周年日金额关系没有获批官方责任 artifact 支撑。',
          recommendedAction: '先锁定同版官方条款，记录 sourceDigest、页码和红利定义，再重建该产品 artifact。',
          evidence: [indicator.formulaText, indicator.sourceExcerpt],
        }));
      }
      if (repeatedFormula(indicator)) {
        issues.push(issue({
          code: 'REPEATED_FORMULA_PREFIX',
          severity: 'warning',
          product,
          indicator,
          reason: '公式包含重复的责任名前缀，通常来自抽取或回填串接。',
          recommendedAction: '回到官方摘录，保存单一公式和单独的责任名称。',
          evidence: [indicator.formulaText],
        }));
      }
      const key = duplicateKey(indicator);
      const list = duplicated.get(key) || [];
      list.push(indicator);
      duplicated.set(key, list);
    }

    for (const indicators of duplicated.values()) {
      if (indicators.length < 2) continue;
      for (const indicator of indicators.slice(1)) {
        issues.push(issue({
          code: 'DUPLICATE_ATOMIC_INDICATOR',
          severity: 'warning',
          product,
          indicator,
          reason: `同一责任、公式、条件和计算口径存在 ${indicators.length} 条重复原子指标。`,
          recommendedAction: '确认不是不同年龄/保单年度阶段后，保留具有正确官方 sourceDigest 的一条，再重建责任卡。',
          evidence: indicators.map((item) => item.id),
        }));
      }
    }

    for (const card of product.cards) {
      for (const [field, value] of [
        ['formulaText', card.formulaText],
        ['normalizedFormula', card.normalizedFormula],
        ['payoutSummary', card.payoutSummary],
        ['customerSummary', card.customerSummary],
        ['plainSummary', card.plainSummary],
      ]) {
        if (!duplicatePhraseField(value)) continue;
        issues.push(issue({
          code: 'DUPLICATE_ANNIVERSARY_BASIC_AMOUNT_PHRASE',
          severity: 'error',
          product,
          indicator: { id: card.id, liability: card.title, [field]: value },
          reason: `责任卡 ${card.id} 的 ${field} 包含重复的周年日基本责任保险金额短语。`,
          recommendedAction: '重新物化责任卡，确保 formulaText、payoutSummary 和 customerSummary 使用单一规范短语。',
          evidence: [`${field}=${value}`],
        }));
      }
      for (const nested of Array.isArray(card.indicators) ? card.indicators : []) {
        for (const [field, value] of [
          ['formulaText', nested?.formulaText],
          ['normalizedFormula', nested?.normalizedFormula],
          ['payoutSummary', nested?.payoutSummary],
          ['customerSummary', nested?.customerSummary],
          ['plainSummary', nested?.plainSummary],
        ]) {
          if (!duplicatePhraseField(value)) continue;
          issues.push(issue({
            code: 'DUPLICATE_ANNIVERSARY_BASIC_AMOUNT_PHRASE',
            severity: 'error',
            product,
            indicator: { id: nested?.id || nested?.indicatorId, liability: nested?.liability, [field]: value },
            reason: `责任卡 ${card.id} 的 nested indicator ${field} 包含重复的周年日基本责任保险金额短语。`,
            recommendedAction: '以原子指标为唯一事实源重新物化责任卡，确保 nested indicator 不重复。',
            evidence: [`${field}=${value}`],
          }));
        }
        const raw = byId.get(text(nested?.id || nested?.indicatorId || nested?.nestedIndicatorId));
        if (!raw) continue;
        const mismatches = SEMANTIC_FIELDS.filter((field) => (
          nested[field] !== undefined && raw[field] !== undefined
          && semanticValue(nested[field]) !== semanticValue(raw[field])
        ));
        if (!mismatches.length) continue;
        issues.push(issue({
          code: 'CARD_INDICATOR_PROJECTION_MISMATCH',
          severity: 'error',
          product,
          indicator: raw,
          reason: `责任卡 ${card.id} 覆盖了原子指标字段：${mismatches.join(', ')}。`,
          recommendedAction: '以获批 artifact 的原子指标为唯一事实源，重新物化责任卡；不要在卡片层修正公式。',
          evidence: mismatches.map((field) => `${field}: card=${nested[field]} raw=${raw[field]}`),
        }));
      }
    }
  }

  const orderedProducts = [...products.values()]
    .map((product) => ({
      company: product.company,
      productName: product.productName,
      productKey: product.key,
      indicators: product.indicators.length,
      cards: product.cards.length,
      approvedArtifacts: product.artifacts.filter((artifact) => artifact.approved).length,
      sourceDigest: product.sourceDigest,
      sourceUrl: product.sourceUrl,
      sourceDigests: [...product.sourceDigests].sort(),
      sourceUrls: [...product.sourceUrls].sort(),
      productTypes: [...product.productTypes].sort(),
      categories: [...product.categories].sort(),
      findings: product.findings,
      canonicalIdentity: productCanonicalIdentity(product),
      governanceScope: productHasParticipatingEvidence(product) && !isExcludedIncrementalWholeLife(product),
      excludedReason: isExcludedIncrementalWholeLife(product) ? 'incremental_whole_life_specialized_lane' : '',
    }))
    .sort((left, right) => `${left.company}\u001f${left.productName}`.localeCompare(`${right.company}\u001f${right.productName}`));
  const productsByKey = new Map([...products.values()].map((product) => [product.key, product]));
  const classifiedIssues = issues.map((item) => {
    const product = productsByKey.get(item.productKey);
    const classification = product ? issueClassification(item, product) : 'source_review';
    return {
      ...item,
      classification,
      canonicalIdentity: product ? productCanonicalIdentity(product) : '',
      sourceDigests: product ? [...product.sourceDigests].sort() : [],
      sourceUrls: product ? [...product.sourceUrls].sort() : [],
    };
  });
  const byCode = {};
  for (const item of classifiedIssues) byCode[item.code] = (byCode[item.code] || 0) + 1;
  const byClassification = {};
  for (const item of classifiedIssues) byClassification[item.classification] = (byClassification[item.classification] || 0) + 1;
  const queue = (classification) => classifiedIssues.filter((item) => item.classification === classification);
  const truePositiveProducts = new Set(queue('true_positive').map((item) => item.productKey));
  const sourceReviewProducts = new Set(queue('source_review').map((item) => item.productKey));
  const versionConflictProducts = new Set(queue('version_conflict').map((item) => item.productKey));
  const materializerBlockedProducts = new Set(queue('materializer_blocked').map((item) => item.productKey));
  const falsePositiveAudit = legacyFalsePositiveAudit(products);
  const falsePositiveProducts = new Set(falsePositiveAudit.map((item) => item.productKey));
  const genericDefinitions = db.prepare('SELECT COUNT(*) AS count FROM indicator_definitions').get()?.count || 0;
  const issuesByProduct = new Map();
  for (const item of classifiedIssues) {
    const list = issuesByProduct.get(item.productKey) || [];
    list.push(item);
    issuesByProduct.set(item.productKey, list);
  }
  const repairCodes = new Set([
    'ANNIVERSARY_BASIC_AMOUNT_COLLAPSED',
    'ANNIVERSARY_OPTIONAL_AMOUNT_COLLAPSED',
    'DIVIDEND_COMPONENT_LOST',
    'DUPLICATE_ANNIVERSARY_BASIC_AMOUNT_PHRASE',
    'DUPLICATE_ATOMIC_INDICATOR',
    'REPEATED_FORMULA_PREFIX',
  ]);
  const productQueues = [...products.values()]
    .filter((product) => productHasParticipatingEvidence(product))
    .map((product) => {
      const productIssues = issuesByProduct.get(product.key) || [];
      let queueName = 'already_correct';
      if (isExcludedIncrementalWholeLife(product)) queueName = 'incremental_whole_life_special_lane';
      else if (product.sourceDigests.size > 1) queueName = 'version_conflict';
      else if (productIssues.some((item) => repairCodes.has(item.code)) && comparableArtifact(product)) queueName = 'confirmed_repair';
      else if (productIssues.some((item) => item.code === 'CARD_INDICATOR_PROJECTION_MISMATCH')) queueName = 'materializer_blocked';
      else if (productIssues.length) queueName = 'source_review';
      return {
        productKey: product.key,
        company: product.company,
        productName: product.productName,
        canonicalIdentity: productCanonicalIdentity(product),
        sourceDigests: [...product.sourceDigests].sort(),
        sourceUrls: [...product.sourceUrls].sort(),
        explicitName: PARTICIPATING_PRODUCT_RE.test(product.productName),
        explicitCategory: [...product.categories].some((value) => PARTICIPATING_PRODUCT_RE.test(value)),
        issueCount: productIssues.length,
        issueCodes: [...new Set(productIssues.map((item) => item.code))].sort(),
        findings: product.findings,
        queue: queueName,
        incrementalWholeLifeExcluded: isExcludedIncrementalWholeLife(product),
      };
    })
    .sort((left, right) => `${left.company}\u001f${left.productName}`.localeCompare(`${right.company}\u001f${right.productName}`));
  const productQueue = (queueName) => productQueues.filter((item) => item.queue === queueName);
  const queueCounts = Object.fromEntries([
    'confirmed_repair',
    'already_correct',
    'source_review',
    'version_conflict',
    'materializer_blocked',
    'incremental_whole_life_special_lane',
  ].map((name) => [name, productQueue(name).length]));
  const queueProductSets = Object.fromEntries([
    'confirmed_repair',
    'already_correct',
    'source_review',
    'version_conflict',
    'materializer_blocked',
    'incremental_whole_life_special_lane',
  ].map((name) => [name, new Set(productQueue(name).map((item) => item.productKey))]));
  const queueIntersectionCount = [...new Set(productQueues.map((item) => item.productKey))]
    .filter((key) => Object.values(queueProductSets).filter((set) => set.has(key)).length > 1).length;
  const regressionTerms = ['尊享人生', '尊贵人生', '荣享人生', '百年好合', '尊贵一生A', '尊贵一生B', '幸福年年'];
  const regressionSamples = regressionTerms.flatMap((term) => productQueues
    .filter((item) => item.productName.includes(term))
    .map((item) => ({ term, ...item })));
  regressionSamples.push({
    term: '普通静态年金',
    status: 'fixture_required',
    expectation: 'static basic amount remains static; no anniversary dynamic issue without same-liability official noun phrase',
  });
  return {
    schema: 'participating-annuity-semantic-audit/v1',
    generatedAt: new Date().toISOString(),
    scope: { company: company || null, productName: productName || null, readOnly: true },
    summary: {
      productsScanned: orderedProducts.length,
      candidateProducts: productQueues.length,
      indicatorsScanned: orderedProducts.reduce((sum, product) => sum + product.indicators, 0),
      cardsScanned: orderedProducts.reduce((sum, product) => sum + product.cards, 0),
      governanceProducts: productQueues.filter((product) => !product.incrementalWholeLifeExcluded).length,
      candidateNameOrCategoryProducts: productQueues.filter((product) => productHasExplicitParticipatingIdentity(productsByKey.get(product.productKey))).length,
      evidenceOnlyCandidateProducts: productQueues.filter((product) => !productHasExplicitParticipatingIdentity(productsByKey.get(product.productKey))).length,
      scopeReconciliation: {
        productNameBaseline: productQueues.filter((product) => product.explicitName).length,
        productCategoryOnly: productQueues.filter((product) => !product.explicitName && product.explicitCategory).length,
        evidenceOnlyAccepted: productQueues.filter((product) => !product.explicitName && !product.explicitCategory).length,
        union: productQueues.length,
        expectedUnion: 4590,
      },
      queueIntersectionCount,
      queueCounts,
      issues: classifiedIssues.length,
      byCode,
      byClassification,
      truePositiveProducts: truePositiveProducts.size,
      sourceReviewProducts: sourceReviewProducts.size,
      versionConflictProducts: versionConflictProducts.size,
      materializerBlockedProducts: materializerBlockedProducts.size,
      falsePositiveAuditIssues: falsePositiveAudit.length,
      falsePositiveProducts: falsePositiveProducts.size,
      genericIndicatorDefinitions: genericDefinitions,
      genericDefinitionsNotice: 'indicator_definitions 是跨产品通用模板，不能替代单产品官方条款。',
    },
    products: orderedProducts,
    truePositives: queue('true_positive'),
    falsePositiveAudit,
    sourceReviewQueue: queue('source_review'),
    versionConflictQueue: queue('version_conflict'),
    materializerBlockedQueue: queue('materializer_blocked'),
    productQueues,
    confirmedRepairProducts: productQueue('confirmed_repair'),
    alreadyCorrectProducts: productQueue('already_correct'),
    sourceReviewProducts: productQueue('source_review'),
    versionConflictProducts: productQueue('version_conflict'),
    materializerBlockedProducts: productQueue('materializer_blocked'),
    incrementalWholeLifeSpecialLane: productQueue('incremental_whole_life_special_lane'),
    regressionSamples,
    excludedQueue: classifiedIssues.filter((item) => item.classification === 'excluded_incremental_whole_life'),
    issues: classifiedIssues.sort((left, right) => `${left.company}\u001f${left.productName}\u001f${left.code}\u001f${left.indicatorId}`.localeCompare(`${right.company}\u001f${right.productName}\u001f${right.code}\u001f${right.indicatorId}`)),
    safety: {
      writeGate: 'BLOCKED',
      actualTargetWrites: 0,
      repairDisposition: 'import_pending',
      actualTarget: '/Users/wenshuping/OCR_insurance_ssd/.runtime/local/policy-ocr.sqlite',
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dbPath = path.resolve(arg('db', DEFAULT_DB));
  const outputPath = arg('output');
  const manifestDir = arg('manifest-dir');
  const company = arg('company');
  const productName = arg('product-name');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  let report;
  try {
    report = auditParticipatingAnnuitySemantics(db, { company, productName });
  } finally {
    db.close();
  }
  const canonical = `${JSON.stringify(report, null, 2)}\n`;
  const result = { ...report, reportSha256: digest(canonical) };
  if (outputPath) {
    const target = path.resolve(outputPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(result, null, 2)}\n`);
  }
  if (manifestDir) {
    const targetDir = path.resolve(manifestDir);
    fs.mkdirSync(targetDir, { recursive: true });
    const queueFiles = {
      'true-positive.json': result.truePositives,
      'false-positive-audit.json': result.falsePositiveAudit,
      'source-review.json': result.sourceReviewQueue,
      'version-conflict.json': result.versionConflictQueue,
      'materializer-blocked.json': result.materializerBlockedQueue,
      'confirmed-repair-products.json': result.confirmedRepairProducts,
      'already-correct-products.json': result.alreadyCorrectProducts,
      'source-review-products.json': result.sourceReviewProducts,
      'version-conflict-products.json': result.versionConflictProducts,
      'materializer-blocked-products.json': result.materializerBlockedProducts,
      'incremental-whole-life-special-lane.json': result.incrementalWholeLifeSpecialLane,
      'regression-samples.json': result.regressionSamples,
      'import-pending.json': {
        gate: result.safety.writeGate,
        disposition: result.safety.repairDisposition,
        products: result.confirmedRepairProducts,
      },
      'terminal-receipt.json': {
        status: 'terminal',
        dbPath,
        generatedAt: result.generatedAt,
        summary: result.summary,
        safety: result.safety,
        actualTargetWrites: 0,
      },
    };
    const checksums = [];
    for (const [name, value] of Object.entries(queueFiles)) {
      const file = path.join(targetDir, name);
      checksums.push(`${writeJsonFile(file, value)}  ${name}`);
    }
    fs.writeFileSync(path.join(targetDir, 'SHA256SUMS'), `${checksums.join('\n')}\n`);
  }
  process.stdout.write(`${JSON.stringify({
    dbPath,
    outputPath: outputPath ? path.resolve(outputPath) : null,
    manifestDir: manifestDir ? path.resolve(manifestDir) : null,
    ...result.summary,
    reportSha256: result.reportSha256,
  }, null, 2)}\n`);
}
