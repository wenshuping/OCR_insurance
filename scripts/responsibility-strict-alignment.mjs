const rows = (value) => Array.isArray(value) ? value : [];
const text = (value) => value === null || value === undefined ? '' : String(value).trim();
const preserveText = (value) => value === null || value === undefined ? '' : String(value);
const compact = (value) => text(value).normalize('NFKC').replace(/\s+/gu, '');

function payload(row = {}) {
  if (row?.payload && typeof row.payload === 'object') return row.payload;
  if (typeof row?.payload === 'string') {
    try {
      return JSON.parse(row.payload);
    } catch {
      return {};
    }
  }
  return row || {};
}

function canonical(value) {
  if (value === undefined || value === '') return null;
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

function equal(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function responsibilityTitle(responsibility = {}) {
  return text(
    responsibility.card?.title
    || responsibility.liability
    || responsibility.responsibilityName
    || responsibility.title
    || responsibility.name,
  );
}

function sourceExcerptFor(value = {}) {
  const segments = rows(value.evidenceSegments);
  const evidence = segments
    .map((segment) => preserveText(
      segment?.sourceExcerpt || segment?.exactText || segment?.text || segment?.excerpt,
    ))
    .filter((item) => item.trim())
    .join('\n');
  return evidence || preserveText(value.sourceExcerpt);
}

function artifactResponsibilities(artifact = {}) {
  return rows(artifact.responsibilities).length
    ? rows(artifact.responsibilities)
    : rows(artifact.acceptedResponsibilities);
}

function expectedIndicator(artifact, responsibility, indicator) {
  const sourceDigest = text(
    indicator.sourceDigest
    || responsibility.sourceDigest
    || artifact.sourceDigest
    || artifact.productIdentity?.sourceDigest,
  );
  return {
    indicatorName: text(indicator.indicatorName),
    responsibilityId: text(indicator.responsibilityId || responsibility.responsibilityId),
    sourceUrl: text(
      indicator.sourceUrl
      || responsibility.sourceUrl
      || artifact.sourceUrl
      || artifact.productIdentity?.sourceUrl,
    ),
    sourceDigest,
    responsibilitySourceDigest: text(
      indicator.responsibilitySourceDigest
      || responsibility.responsibilitySourceDigest
      || sourceDigest,
    ),
    sourceExcerpt: sourceExcerptFor(indicator) || sourceExcerptFor(responsibility),
    evidenceSegments: Array.isArray(indicator.evidenceSegments)
      ? indicator.evidenceSegments
      : (Array.isArray(responsibility.evidenceSegments) ? responsibility.evidenceSegments : null),
    provenance: indicator.provenance ?? responsibility.provenance ?? null,
    formulaText: preserveText(indicator.formulaText || responsibility.formulaText),
    normalizedFormula: text(indicator.normalizedFormula || responsibility.normalizedFormula) || null,
    requiredInputs: Array.isArray(indicator.requiredInputs)
      ? indicator.requiredInputs
      : (Array.isArray(responsibility.requiredInputs) ? responsibility.requiredInputs : null),
    operands: Array.isArray(indicator.operands)
      ? indicator.operands
      : (Array.isArray(responsibility.operands) ? responsibility.operands : null),
    branches: Array.isArray(indicator.branches)
      ? indicator.branches
      : (Array.isArray(responsibility.branches) ? responsibility.branches : null),
    parentResponsibilityId: text(
      indicator.parentResponsibilityId || responsibility.parentResponsibilityId,
    ) || null,
    branchId: text(indicator.branchId || responsibility.branchId) || null,
  };
}

function addReason(reasons, code, details = {}) {
  reasons.push({ code, ...details });
}

function uniqueValues(values) {
  return [...new Set(values.map(text).filter(Boolean))];
}

export function evaluateResponsibilityStrictAlignment({
  artifact = null,
  artifacts = null,
  cards = [],
  indicators = [],
  company = '',
  productName = '',
} = {}) {
  const artifactList = artifacts ? rows(artifacts).map(payload) : (artifact ? [payload(artifact)] : []);
  const cardRows = rows(cards).map((row) => ({ ...row, payload: payload(row) }));
  const recordRows = rows(indicators).map((row) => ({ ...row, payload: payload(row) }));
  const reasons = [];
  const effectiveCompany = text(company || artifactList[0]?.company || cardRows[0]?.company || recordRows[0]?.company);
  const effectiveProductName = text(productName || artifactList[0]?.productName || cardRows[0]?.productName || recordRows[0]?.productName);

  if (artifactList.length !== 1) {
    addReason(reasons, 'APPROVED_ARTIFACT_COUNT_MISMATCH', { expected: 1, actual: artifactList.length });
  }
  const approved = artifactList[0] || {};
  const responsibilities = artifactResponsibilities(approved);
  if (!responsibilities.length) addReason(reasons, 'APPROVED_RESPONSIBILITY_INVENTORY_EMPTY');

  const cardPayloads = cardRows.map((row) => row.payload);
  const recordPayloads = recordRows.map((row) => row.payload);
  const nested = cardPayloads.flatMap((card) => rows(card.indicators).map((indicator) => ({ card, indicator })));
  const expected = responsibilities.flatMap((responsibility, responsibilityIndex) => {
    const sourceIndicators = rows(responsibility.indicators);
    if (!sourceIndicators.length) {
      addReason(reasons, 'APPROVED_RESPONSIBILITY_INDICATORS_EMPTY', {
        responsibilityId: text(responsibility.responsibilityId),
        responsibilityIndex,
      });
    }
    return sourceIndicators.map((indicator, indicatorIndex) => ({
      responsibility,
      responsibilityIndex,
      indicatorIndex,
      expected: expectedIndicator(approved, responsibility, indicator),
    }));
  });

  if (cardRows.length !== responsibilities.length) {
    addReason(reasons, 'CARD_COUNT_MISMATCH', { expected: responsibilities.length, actual: cardRows.length });
  }
  if (nested.length !== expected.length) {
    addReason(reasons, 'NESTED_INDICATOR_COUNT_MISMATCH', { expected: expected.length, actual: nested.length });
  }
  if (recordRows.length !== expected.length) {
    addReason(reasons, 'INDICATOR_RECORD_COUNT_MISMATCH', { expected: expected.length, actual: recordRows.length });
  }

  const expectedTitles = responsibilities.map(responsibilityTitle);
  const actualTitles = cardRows.map((row) => text(row.title || row.payload.title));
  const duplicateTitles = actualTitles.filter((title, index) => title && actualTitles.indexOf(title) !== index);
  if (uniqueValues(duplicateTitles).length) {
    addReason(reasons, 'DUPLICATE_CARD_TITLE', { values: uniqueValues(duplicateTitles) });
  }
  expectedTitles.forEach((title, index) => {
    if (!actualTitles.some((actual) => compact(actual) === compact(title))) {
      addReason(reasons, 'CARD_TITLE_MISMATCH', { responsibilityIndex: index, expected: title });
    }
  });

  const nestedIds = nested.map(({ indicator }) => text(indicator.id || indicator.indicatorId));
  const recordIds = recordRows.map((row) => text(row.id || row.payload.id));
  if (nestedIds.some((id) => !id)) addReason(reasons, 'NESTED_INDICATOR_ID_MISSING');
  if (recordIds.some((id) => !id)) addReason(reasons, 'INDICATOR_RECORD_ID_MISSING');
  if (new Set(nestedIds.filter(Boolean)).size !== nestedIds.filter(Boolean).length) {
    addReason(reasons, 'DUPLICATE_NESTED_INDICATOR_ID');
  }
  if (new Set(recordIds.filter(Boolean)).size !== recordIds.filter(Boolean).length) {
    addReason(reasons, 'DUPLICATE_INDICATOR_RECORD_ID');
  }
  for (const id of nestedIds.filter(Boolean)) {
    if (!recordIds.includes(id)) addReason(reasons, 'ORPHAN_NESTED_INDICATOR', { indicatorId: id });
  }
  for (const id of recordIds.filter(Boolean)) {
    if (!nestedIds.includes(id)) addReason(reasons, 'ORPHAN_INDICATOR_RECORD', { indicatorId: id });
  }

  for (const item of expected) {
    const marker = {
      responsibilityId: item.expected.responsibilityId,
      responsibilityIndex: item.responsibilityIndex,
      indicatorIndex: item.indicatorIndex,
    };
    const nestedMatches = nested.filter(({ indicator }) => (
      text(indicator.responsibilityId) === item.expected.responsibilityId
    ));
    const nestedMatch = nestedMatches[item.indicatorIndex] || null;
    if (!nestedMatch) {
      addReason(reasons, 'EXPECTED_NESTED_INDICATOR_MISSING', marker);
      continue;
    }
    const nestedId = text(nestedMatch.indicator.id || nestedMatch.indicator.indicatorId);
    const recordMatch = recordRows.find((row) => text(row.id || row.payload.id) === nestedId) || null;
    if (!recordMatch) {
      addReason(reasons, 'EXPECTED_INDICATOR_RECORD_MISSING', { ...marker, indicatorId: nestedId });
      continue;
    }
    const cardTitle = text(nestedMatch.card.title);
    const expectedTitle = responsibilityTitle(item.responsibility);
    if (compact(cardTitle) !== compact(expectedTitle)) {
      addReason(reasons, 'CARD_TITLE_MISMATCH', { ...marker, expected: expectedTitle, actual: cardTitle });
    }
    if (compact(recordMatch.payload.liability || recordMatch.liability) !== compact(expectedTitle)) {
      addReason(reasons, 'INDICATOR_LIABILITY_MISMATCH', {
        ...marker,
        expected: expectedTitle,
        actual: text(recordMatch.payload.liability || recordMatch.liability),
      });
    }
    for (const [field, expectedValue] of Object.entries(item.expected)) {
      const nestedValue = nestedMatch.indicator[field];
      const recordValue = recordMatch.payload[field];
      if (!equal(nestedValue, expectedValue)) {
        addReason(reasons, 'ARTIFACT_TO_NESTED_FIELD_MISMATCH', { ...marker, field });
      }
      if (!equal(recordValue, nestedValue)) {
        addReason(reasons, 'NESTED_TO_RECORD_FIELD_MISMATCH', { ...marker, field });
      }
    }
  }

  const sourceDigests = uniqueValues([
    approved.sourceDigest,
    approved.productIdentity?.sourceDigest,
    ...cardPayloads.map((card) => card.sourceDigest || card.responsibilitySourceDigest),
    ...nested.map(({ indicator }) => indicator.sourceDigest || indicator.responsibilitySourceDigest),
    ...recordPayloads.map((indicator) => indicator.sourceDigest || indicator.responsibilitySourceDigest),
  ]);
  if (sourceDigests.length > 1) addReason(reasons, 'SOURCE_DIGEST_CONFLICT', { values: sourceDigests });

  const dedupedReasons = [...new Map(reasons.map((reason) => [JSON.stringify(reason), reason])).values()];
  return {
    company: effectiveCompany,
    productName: effectiveProductName,
    strictAligned: dedupedReasons.length === 0,
    reasonCodes: dedupedReasons.map((reason) => reason.code),
    reasons: dedupedReasons,
    counts: {
      approvedArtifacts: artifactList.length,
      responsibilities: responsibilities.length,
      cards: cardRows.length,
      expectedIndicators: expected.length,
      nestedIndicators: nested.length,
      indicatorRecords: recordRows.length,
    },
  };
}

export function loadStrictAlignmentProduct(db, { company, productName } = {}) {
  const artifacts = db.prepare(`
    SELECT company, product_name productName, payload
      FROM product_responsibility_artifacts
     WHERE company = ? AND product_name = ?
       AND json_extract(payload, '$.audit.status') = 'approved'
     ORDER BY published_at DESC, id DESC
  `).all(text(company), text(productName));
  const cards = db.prepare(`
    SELECT id, company, product_name productName, title, payload
      FROM product_responsibility_cards
     WHERE company = ? AND product_name = ?
     ORDER BY id
  `).all(text(company), text(productName));
  const indicators = db.prepare(`
    SELECT id, company, product_name productName, liability, payload
      FROM insurance_indicator_records
     WHERE company = ? AND product_name = ?
     ORDER BY id
  `).all(text(company), text(productName));
  return evaluateResponsibilityStrictAlignment({ artifacts, cards, indicators, company, productName });
}
