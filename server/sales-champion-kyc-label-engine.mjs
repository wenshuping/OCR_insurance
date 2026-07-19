import {
  SALES_CHAMPION_CUSTOMER_LABEL_TAXONOMY,
} from './sales-champion-customer-labels.mjs';

const CUSTOMER_STATEMENT_SOURCES = new Set(['current_message', 'confirmed_history', 'customer_statement']);
const ADVISOR_FACT_SOURCES = new Set(['advisor_fact', 'advisor_confirmed']);
const ADVISOR_ESTIMATE_SOURCES = new Set(['advisor_estimate', 'advisor_inference']);
const LABEL_STATUSES = new Set(['confirmed', 'candidate']);

function text(value, path) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new TypeError(`${path} is required`);
  return normalized;
}

function array(value, path) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`);
  return value;
}

function validateLabel(label, path) {
  if (!label || typeof label !== 'object' || Array.isArray(label)) {
    throw new TypeError(`${path} must be an object`);
  }
  const dimension = text(label.dimension, `${path}.dimension`);
  const value = text(label.value, `${path}.value`);
  const allowed = SALES_CHAMPION_CUSTOMER_LABEL_TAXONOMY[dimension];
  if (!allowed) throw new TypeError(`${path}.dimension is not registered`);
  if (!allowed.includes(value)) throw new TypeError(`${path}.value is not registered`);
  return { dimension, value };
}

function factRecord({ key, value, source, evidence = '' }) {
  return { key, value, source, ...(evidence ? { evidence } : {}) };
}

function labelRecord({ dimension, value, source, evidence = '' }) {
  return { dimension, value, source, ...(evidence ? { evidence } : {}) };
}

function unique(records, identity) {
  const seen = new Set();
  return records.filter((record) => {
    const key = identity(record);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function factConflicts(confirmedFacts) {
  const byKey = new Map();
  for (const fact of confirmedFacts) {
    if (fact.key === 'customer_statement') continue;
    const records = byKey.get(fact.key) || [];
    records.push(fact);
    byKey.set(fact.key, records);
  }
  return [...byKey.entries()].flatMap(([key, records]) => {
    const values = unique(records.map((record) => record.value), (value) => JSON.stringify(value));
    if (values.length < 2) return [];
    return [{
      type: 'fact_value_conflict',
      key,
      values,
      sources: unique(records.map((record) => record.source), (source) => source),
    }];
  });
}

function normalizeCustomerStatements(customerStatements) {
  const confirmedFacts = [];
  const confirmedLabels = [];
  array(customerStatements, 'customerStatements').forEach((statement, index) => {
    if (!statement || typeof statement !== 'object' || Array.isArray(statement)) {
      throw new TypeError(`customerStatements[${index}] must be an object`);
    }
    const source = text(statement.source, `customerStatements[${index}].source`);
    if (!CUSTOMER_STATEMENT_SOURCES.has(source)) {
      throw new TypeError(`customerStatements[${index}].source is not a customer statement source`);
    }
    const statementText = text(statement.text, `customerStatements[${index}].text`);
    confirmedFacts.push(factRecord({
      key: 'customer_statement', value: statementText, source: 'customer_statement', evidence: statementText,
    }));
    array(statement.facts, `customerStatements[${index}].facts`).forEach((fact, factIndex) => {
      const key = text(fact?.key, `customerStatements[${index}].facts[${factIndex}].key`);
      if (fact?.value == null || String(fact.value).trim() === '') {
        throw new TypeError(`customerStatements[${index}].facts[${factIndex}].value is required`);
      }
      confirmedFacts.push(factRecord({
        key, value: fact.value, source: 'customer_statement', evidence: statementText,
      }));
    });
    array(statement.labels, `customerStatements[${index}].labels`).forEach((label, labelIndex) => {
      confirmedLabels.push(labelRecord({
        ...validateLabel(label, `customerStatements[${index}].labels[${labelIndex}]`),
        source: 'customer_statement',
        evidence: statementText,
      }));
    });
  });
  return { confirmedFacts, confirmedLabels };
}

function normalizeBusinessFacts(businessFacts) {
  const confirmedFacts = [];
  const estimatedFacts = [];
  const confirmedLabels = [];
  const candidateLabels = [];
  array(businessFacts, 'businessFacts').forEach((fact, index) => {
    if (!fact || typeof fact !== 'object' || Array.isArray(fact)) {
      throw new TypeError(`businessFacts[${index}] must be an object`);
    }
    const source = text(fact.source, `businessFacts[${index}].source`);
    const customerStatement = source === 'customer_statement';
    const confirmed = customerStatement || ADVISOR_FACT_SOURCES.has(source);
    const estimated = ADVISOR_ESTIMATE_SOURCES.has(source);
    if (!confirmed && !estimated) throw new TypeError(`businessFacts[${index}].source is invalid`);
    const key = text(fact.key, `businessFacts[${index}].key`);
    if (fact.value == null || String(fact.value).trim() === '') {
      throw new TypeError(`businessFacts[${index}].value is required`);
    }
    const evidence = typeof fact.evidence === 'string' ? fact.evidence.trim() : '';
    const targetFacts = confirmed ? confirmedFacts : estimatedFacts;
    const normalizedSource = customerStatement
      ? 'customer_statement'
      : (confirmed ? 'advisor_fact' : 'advisor_estimate');
    targetFacts.push(factRecord({ key, value: fact.value, source: normalizedSource, evidence }));
    array(fact.labels, `businessFacts[${index}].labels`).forEach((label, labelIndex) => {
      const record = labelRecord({
        ...validateLabel(label, `businessFacts[${index}].labels[${labelIndex}]`),
        source: normalizedSource,
        evidence,
      });
      (confirmed ? confirmedLabels : candidateLabels).push(record);
    });
  });
  return { confirmedFacts, estimatedFacts, confirmedLabels, candidateLabels };
}

function normalizeRecognizedLabels(recognizedLabels) {
  const confirmedLabels = [];
  const candidateLabels = [];
  array(recognizedLabels, 'recognizedLabels').forEach((label, index) => {
    const normalized = validateLabel(label, `recognizedLabels[${index}]`);
    const status = text(label.status, `recognizedLabels[${index}].status`);
    const source = text(label.source, `recognizedLabels[${index}].source`);
    if (!LABEL_STATUSES.has(status)) throw new TypeError(`recognizedLabels[${index}].status is invalid`);
    if (![...CUSTOMER_STATEMENT_SOURCES, ...ADVISOR_FACT_SOURCES, ...ADVISOR_ESTIMATE_SOURCES].includes(source)) {
      throw new TypeError(`recognizedLabels[${index}].source is invalid`);
    }
    if (ADVISOR_ESTIMATE_SOURCES.has(source) && status !== 'candidate') {
      throw new TypeError(`recognizedLabels[${index}] inferred labels must remain candidate`);
    }
    const normalizedSource = CUSTOMER_STATEMENT_SOURCES.has(source)
      ? 'customer_statement'
      : (ADVISOR_FACT_SOURCES.has(source) ? 'advisor_fact' : 'advisor_estimate');
    const evidence = typeof label.evidence === 'string' ? label.evidence.trim() : '';
    const record = labelRecord({ ...normalized, source: normalizedSource, evidence });
    (status === 'confirmed' ? confirmedLabels : candidateLabels).push(record);
  });
  return { confirmedLabels, candidateLabels };
}

function normalizeHistoricalLabels(historicalLabels) {
  const confirmedLabels = [];
  const candidateLabels = [];
  array(historicalLabels, 'historicalLabels').forEach((label, index) => {
    const normalized = validateLabel(label, `historicalLabels[${index}]`);
    const status = text(label.status, `historicalLabels[${index}].status`);
    if (!LABEL_STATUSES.has(status)) throw new TypeError(`historicalLabels[${index}].status is invalid`);
    const record = labelRecord({ ...normalized, source: 'history' });
    (status === 'confirmed' ? confirmedLabels : candidateLabels).push(record);
  });
  return { confirmedLabels, candidateLabels };
}

export function buildSalesChampionKycLabelSnapshot({
  customerStatements = [],
  historicalLabels = [],
  businessFacts = [],
  recognizedLabels = [],
} = {}) {
  const customer = normalizeCustomerStatements(customerStatements);
  const advisor = normalizeBusinessFacts(businessFacts);
  const history = normalizeHistoricalLabels(historicalLabels);
  const recognized = normalizeRecognizedLabels(recognizedLabels);
  const confirmedFacts = unique(
    [...customer.confirmedFacts, ...advisor.confirmedFacts],
    (fact) => `${fact.key}\u0000${JSON.stringify(fact.value)}\u0000${fact.source}`,
  );
  const estimatedFacts = unique(
    advisor.estimatedFacts,
    (fact) => `${fact.key}\u0000${JSON.stringify(fact.value)}\u0000${fact.source}`,
  );
  const confirmedLabels = unique(
    [...history.confirmedLabels, ...customer.confirmedLabels, ...advisor.confirmedLabels, ...recognized.confirmedLabels],
    (label) => `${label.dimension}\u0000${label.value}`,
  );
  const confirmedLabelKeys = new Set(confirmedLabels.map(
    (label) => `${label.dimension}\u0000${label.value}`,
  ));
  const candidateLabels = unique(
    [...history.candidateLabels, ...advisor.candidateLabels, ...recognized.candidateLabels],
    (label) => `${label.dimension}\u0000${label.value}`,
  ).filter((label) => !confirmedLabelKeys.has(`${label.dimension}\u0000${label.value}`));

  return {
    confirmedFacts,
    estimatedFacts,
    confirmedLabels,
    candidateLabels,
    conflicts: factConflicts(confirmedFacts),
  };
}
