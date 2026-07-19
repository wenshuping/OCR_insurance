const CONFIDENCE_VERSION = 'product-evidence-confidence-v1';
const CRITICAL_FACT = /(?:\d|[%％]|元|万元|天|日|月|年|周岁|承担|不承担|可以|不可以|保险产品|保险计划)/u;

function text(value) {
  return String(value ?? '').trim();
}

function confidenceValue(element) {
  for (const candidate of [element?.confidence, element?.ocrConfidence, element?.handwritingConfidence, element?.transcriptionConfidence]) {
    if (candidate == null || candidate === '') continue;
    const value = Number(candidate);
    if (Number.isFinite(value) && value >= 0 && value <= 1) return value;
  }
  return null;
}

function sourceFor(page, elements) {
  const values = [
    page?.ocrConfidence == null ? '' : 'ocr',
    page?.confidenceSource,
    page?.layout?.confidenceSource,
    page?.layout?.sourceType,
    page?.layout?.extraction?.method,
    ...elements.flatMap((element) => [element?.confidenceSource, element?.sourceType, element?.source]),
  ].map((value) => text(value).toLowerCase()).filter(Boolean).join(' ');
  if (/handwrit/u.test(values)) return 'handwriting_ocr';
  if (/transcri|speech|audio|asr/u.test(values)) return 'transcription';
  if (/ocr|scan|image/u.test(values)) return 'ocr';
  if (/native|officeparser|text_layer|derived_line/u.test(values)) return 'native_text';
  return 'unknown';
}

function aggregate(elements, source) {
  const evidence = elements.map((element) => {
    const content = text(element?.text || element?.caption);
    return { confidence: confidenceValue(element), content, weight: Math.max([...content].length, 1) };
  }).filter((item) => item.content);
  const scored = evidence.filter((item) => item.confidence != null);
  const critical = scored.filter((item) => CRITICAL_FACT.test(item.content));
  const missingConfidenceCount = evidence.length - scored.length;
  const minimum = scored.length ? Math.min(...scored.map((item) => item.confidence)) : null;
  const average = scored.length ? scored.reduce((sum, item) => sum + item.confidence, 0) / scored.length : null;
  const totalWeight = scored.reduce((sum, item) => sum + item.weight, 0);
  const weighted = totalWeight ? scored.reduce((sum, item) => sum + item.confidence * item.weight, 0) / totalWeight : null;
  const criticalFactMinimum = critical.length ? Math.min(...critical.map((item) => item.confidence)) : null;
  let decision = 'pass';
  const reasons = [];
  if (criticalFactMinimum != null && criticalFactMinimum < 0.85) {
    decision = 'blocked';
    reasons.push('low_critical_fact_confidence');
  } else if ((minimum != null && minimum < 0.7) || (missingConfidenceCount > 0 && source !== 'native_text')) {
    decision = 'review_required';
    if (minimum != null && minimum < 0.7) reasons.push('low_evidence_confidence');
    if (missingConfidenceCount > 0 && source !== 'native_text') reasons.push('missing_non_native_confidence');
  }
  return {
    source,
    minimum,
    average,
    weighted,
    criticalFactMinimum,
    decision,
    reasons,
    evidenceCount: evidence.length,
    missingConfidenceCount,
    confidenceVersion: CONFIDENCE_VERSION,
  };
}

function pageElements(page) {
  const elements = Array.isArray(page?.layout?.elements) ? page.layout.elements : [];
  const pageConfidence = Number(page?.ocrConfidence);
  const hasPageConfidence = Number.isFinite(pageConfidence) && pageConfidence >= 0 && pageConfidence <= 1;
  return elements.map((element) => (
    confidenceValue(element) == null && hasPageConfidence
      ? { ...element, confidence: pageConfidence, confidenceSource: 'page_ocr_confidence' }
      : element
  ));
}

export function aggregatePageEvidenceConfidence(page) {
  const elements = pageElements(page);
  return aggregate(elements, sourceFor(page, elements));
}

export function aggregateChunkEvidenceConfidence(chunk, pages = []) {
  const byPage = new Map((Array.isArray(pages) ? pages : []).map((page) => [Number(page?.pageNo || 0), page]));
  const regions = Array.isArray(chunk?.payload?.sourceRegions) ? chunk.payload.sourceRegions : [];
  const elements = [];
  const sourcePages = [];
  for (const region of regions) {
    const page = byPage.get(Number(region?.pageNo || 0));
    if (!page) continue;
    sourcePages.push(page);
    const ids = new Set((Array.isArray(region?.elementIds) ? region.elementIds : []).map(text));
    elements.push(...pageElements(page).filter((element) => ids.has(text(element?.id))));
  }
  const sources = new Set(sourcePages.map((page) => sourceFor(page, elements)));
  const source = sources.size === 1 ? [...sources][0] : sources.size > 1 ? 'mixed' : 'unknown';
  return aggregate(elements, source);
}

export function aggregateProductEvidenceConfidence({ pages = [], chunks = [] } = {}) {
  const sourcePages = Array.isArray(pages) ? pages : [];
  return {
    pages: sourcePages.map((page) => ({ ...page, evidenceConfidence: aggregatePageEvidenceConfidence(page) })),
    chunks: (Array.isArray(chunks) ? chunks : []).map((chunk) => {
      const confidence = aggregateChunkEvidenceConfidence(chunk, sourcePages);
      return {
        ...chunk,
        payload: {
          ...(chunk?.payload && typeof chunk.payload === 'object' && !Array.isArray(chunk.payload) ? chunk.payload : {}),
          confidence,
        },
      };
    }),
    confidenceVersion: CONFIDENCE_VERSION,
  };
}
