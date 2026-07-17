export const SEMANTIC_CONTRACT_VERSION = 1;

export const SEMANTIC_INTENTS = Object.freeze([
  'chat',
  'family_list',
  'family_summary',
  'coverage_report',
  'sales_report',
  'sales_coaching',
  'upload_link',
  'insurance_product_knowledge',
]);

export const SEMANTIC_QUERY_ASPECTS = Object.freeze([
  'main_responsibilities',
  'product_advantages',
  'exclusions',
  'waiting_period',
  'deductible',
  'reimbursement_ratio',
  'renewal',
  'sales_status',
  'comparison',
  'family_overview',
  'coverage_gap',
  'report_status',
  'sales_guidance',
  'upload',
]);

export const SEMANTIC_MENTION_TYPES = Object.freeze(['insurer', 'product', 'family']);

export const SEMANTIC_REFERENCE_TYPES = Object.freeze([
  'current_product',
  'current_family',
  'candidate_index',
  'previous_result',
  'comparison_left',
  'comparison_right',
]);

export const SEMANTIC_DECISIONS = Object.freeze([
  'execute',
  'clarify',
  'reject',
  'retry_later',
]);

const OPERATIONS = Object.freeze(['read', 'write']);
const REQUESTED_STEPS = Object.freeze(['lookup', 'compare', 'generate', 'upload', 'continue']);
const ROOT_FIELDS = new Set([
  'semanticContractVersion',
  'intent',
  'operation',
  'queryAspects',
  'mentions',
  'references',
  'requestedSteps',
  'confidence',
]);
const CONFIDENCE_FIELDS = new Set(['intent', 'mentions', 'references']);
const MAX_MENTIONS = 20;
const MAX_REFERENCES = 20;
const IMPLICIT_REFERENCE_TYPES = new Set([
  'current_product',
  'current_family',
  'previous_result',
  'comparison_left',
  'comparison_right',
]);

function invalid() {
  const error = new Error('SEMANTIC_PROPOSAL_INVALID');
  error.code = 'SEMANTIC_PROPOSAL_INVALID';
  throw error;
}

function invalidFrame() {
  const error = new Error('SEMANTIC_FRAME_INVALID');
  error.code = 'SEMANTIC_FRAME_INVALID';
  throw error;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyFields(value, fields) {
  return Object.keys(value).every((key) => fields.has(key));
}

function isDenseArray(value) {
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) return false;
  }
  return true;
}

function boundedString(value, limit) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > limit) invalid();
  return normalized;
}

function normalizeConfidence(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    invalid();
  }
  return value;
}

function normalizeControlledList(value, allowed, limit) {
  if (!Array.isArray(value) || value.length > limit || !isDenseArray(value)) invalid();
  const normalized = value.map((item) => boundedString(item, 80));
  if (normalized.some((item) => !allowed.includes(item))) invalid();
  return [...new Set(normalized)];
}

function normalizeTextEntries(value, {
  allowedTypes,
  allowedFields,
  maxItems,
  maxTextLength,
  question,
  implicitTypes = new Set(),
}) {
  if (!Array.isArray(value) || value.length > maxItems || !isDenseArray(value)) invalid();
  return value.map((entry) => {
    if (!isRecord(entry) || !hasOnlyFields(entry, allowedFields)) invalid();
    const type = boundedString(entry.type, 40);
    const rawText = implicitTypes.has(type) && entry.rawText === ''
      ? ''
      : boundedString(entry.rawText, maxTextLength);
    if (!allowedTypes.includes(type) || !question.includes(rawText)) invalid();
    return { type, rawText };
  });
}

export function normalizeSemanticProposal(value, originalQuestion) {
  if (!isRecord(value) || !hasOnlyFields(value, ROOT_FIELDS)) invalid();
  if (value.semanticContractVersion !== SEMANTIC_CONTRACT_VERSION) invalid();

  const question = boundedString(originalQuestion, 1_000);
  const intent = boundedString(value.intent, 80);
  const operation = boundedString(value.operation, 20);
  if (!SEMANTIC_INTENTS.includes(intent) || !OPERATIONS.includes(operation)) invalid();

  const mentions = normalizeTextEntries(value.mentions, {
    allowedTypes: SEMANTIC_MENTION_TYPES,
    allowedFields: new Set(['type', 'rawText']),
    maxItems: MAX_MENTIONS,
    maxTextLength: 200,
    question,
  });
  const references = normalizeTextEntries(value.references, {
    allowedTypes: SEMANTIC_REFERENCE_TYPES,
    allowedFields: new Set(['type', 'rawText']),
    maxItems: MAX_REFERENCES,
    maxTextLength: 100,
    question,
    implicitTypes: IMPLICIT_REFERENCE_TYPES,
  });

  const scores = value.confidence;
  if (!isRecord(scores) || !hasOnlyFields(scores, CONFIDENCE_FIELDS)) invalid();

  return {
    semanticContractVersion: SEMANTIC_CONTRACT_VERSION,
    intent,
    operation,
    queryAspects: normalizeControlledList(value.queryAspects ?? [], SEMANTIC_QUERY_ASPECTS, 8),
    mentions,
    references,
    requestedSteps: normalizeControlledList(value.requestedSteps ?? [], REQUESTED_STEPS, 4),
    confidence: {
      intent: normalizeConfidence(scores.intent),
      mentions: normalizeConfidence(scores.mentions),
      references: normalizeConfidence(scores.references),
    },
  };
}

function frameString(value, limit, { optional = false } = {}) {
  if (optional && (value === undefined || value === '')) return '';
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > limit) invalidFrame();
  return normalized;
}

export function semanticFrameToRouterCandidate(frame, question) {
  if (!isRecord(frame)) invalidFrame();
  const intent = frameString(frame.intent, 80);
  const operation = frameString(frame.operation, 20);
  const normalizedQuestion = frameString(question, 1_000);
  const confidence = frame?.confidence?.intent;
  if (!SEMANTIC_INTENTS.includes(intent)
    || !OPERATIONS.includes(operation)
    || typeof confidence !== 'number'
    || !Number.isFinite(confidence)
    || confidence < 0
    || confidence > 1) {
    invalidFrame();
  }

  const resolvedEntities = frame.resolvedEntities ?? {};
  if (!isRecord(resolvedEntities)) invalidFrame();
  if (Object.keys(resolvedEntities).some((key) => !['product', 'products', 'family'].includes(key))) {
    invalidFrame();
  }
  const hasProduct = resolvedEntities.product !== undefined && resolvedEntities.product !== null;
  const hasProducts = resolvedEntities.products !== undefined && resolvedEntities.products !== null;
  const hasFamily = resolvedEntities.family !== undefined && resolvedEntities.family !== null;
  const requiresProduct = intent === 'insurance_product_knowledge';
  const requiresFamily = ['family_summary', 'coverage_report', 'sales_report']
    .includes(intent);
  const allowsOptionalFamily = intent === 'sales_coaching';
  if ((requiresProduct && ((hasProduct === hasProducts) || hasFamily))
    || (requiresFamily && (!hasFamily || hasProduct || hasProducts))
    || (!requiresProduct && !requiresFamily && !allowsOptionalFamily
      && (hasProduct || hasProducts || hasFamily))
    || (allowsOptionalFamily && (hasProduct || hasProducts))) {
    invalidFrame();
  }
  const entities = {};
  if (hasProduct) {
    if (!isRecord(resolvedEntities.product)) invalidFrame();
    entities.productName = frameString(resolvedEntities.product.officialName, 200);
    const canonicalProductId = frameString(
      resolvedEntities.product.canonicalProductId,
      200,
      { optional: true },
    );
    const productCompany = frameString(resolvedEntities.product.company, 200, { optional: true });
    if (canonicalProductId) entities.productCanonicalId = canonicalProductId;
    if (productCompany) entities.productCompany = productCompany;
  }
  if (hasProducts) {
    if (!Array.isArray(resolvedEntities.products) || resolvedEntities.products.length !== 2) invalidFrame();
    const canonicalIds = new Set();
    resolvedEntities.products.forEach((product, index) => {
      if (!isRecord(product)) invalidFrame();
      const suffix = index + 1;
      entities[`product${suffix}Name`] = frameString(product.officialName, 200);
      entities[`product${suffix}CanonicalId`] = frameString(product.canonicalProductId, 200);
      entities[`product${suffix}Company`] = frameString(product.company, 200);
      canonicalIds.add(entities[`product${suffix}CanonicalId`]);
    });
    if (canonicalIds.size !== 2) invalidFrame();
  }
  if (hasFamily) {
    if (!isRecord(resolvedEntities.family)) invalidFrame();
    entities.familyName = frameString(resolvedEntities.family.displayName, 200);
  }

  return {
    intent,
    question: normalizedQuestion,
    confidence,
    requestedOperation: operation,
    ...(Object.keys(entities).length ? { entities } : {}),
  };
}
