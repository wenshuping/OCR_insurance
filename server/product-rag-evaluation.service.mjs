function text(value) {
  return String(value ?? '').trim();
}

function unique(values = []) {
  return [...new Set((Array.isArray(values) ? values : []).map(text).filter(Boolean))];
}

function evaluateCase(testCase, result) {
  const evidence = Array.isArray(result?.evidenceChunks) ? result.evidenceChunks : [];
  const chunkIds = new Set(evidence.flatMap((item) => [item?.chunkId, item?.matchedChunkId]).map(text).filter(Boolean));
  const requiredChunkIds = unique(testCase?.requiredChunkIds);
  const forbiddenChunkIds = unique(testCase?.forbiddenChunkIds);
  const requiredHits = requiredChunkIds.filter((id) => chunkIds.has(id));
  const forbiddenHits = forbiddenChunkIds.filter((id) => chunkIds.has(id));
  const expectedVersionId = text(testCase?.productVersionId);
  const wrongVersionEvidence = expectedVersionId
    ? evidence.filter((item) => text(item?.productVersionId) !== expectedVersionId)
    : [];
  const citedEvidence = evidence.filter((item) => (
    text(item?.citation?.documentId)
    && text(item?.citation?.chunkId)
    && Number(item?.citation?.pageStart || 0) > 0
  ));
  return {
    id: text(testCase?.id),
    question: text(testCase?.question),
    requiredChunkCount: requiredChunkIds.length,
    requiredHitCount: requiredHits.length,
    forbiddenHits,
    wrongVersionEvidenceCount: wrongVersionEvidence.length,
    evidenceCount: evidence.length,
    citedEvidenceCount: citedEvidence.length,
    passed: requiredHits.length === requiredChunkIds.length
      && forbiddenHits.length === 0
      && wrongVersionEvidence.length === 0
      && citedEvidence.length === evidence.length,
  };
}

export async function evaluateProductRagBaseline(input = {}) {
  if (typeof input.retrieve !== 'function') {
    throw new TypeError('Product RAG evaluation requires retrieve');
  }
  const cases = Array.isArray(input.cases) ? input.cases : [];
  const results = [];
  for (const testCase of cases) {
    const retrieval = await input.retrieve({
      tenantId: text(testCase?.tenantId) || 'default',
      query: text(testCase?.question),
      canonicalProductId: text(testCase?.canonicalProductId),
      productVersionId: text(testCase?.productVersionId),
      asOfDate: text(testCase?.asOfDate),
      tokenBudget: Number(testCase?.tokenBudget || 3000),
    });
    results.push(evaluateCase(testCase, retrieval));
  }
  const requiredTotal = results.reduce((sum, item) => sum + item.requiredChunkCount, 0);
  const requiredHits = results.reduce((sum, item) => sum + item.requiredHitCount, 0);
  const evidenceTotal = results.reduce((sum, item) => sum + item.evidenceCount, 0);
  const citedEvidence = results.reduce((sum, item) => sum + item.citedEvidenceCount, 0);
  return {
    cases: results,
    metrics: {
      casePassRate: results.length ? results.filter((item) => item.passed).length / results.length : 0,
      requiredEvidenceRecall: requiredTotal ? requiredHits / requiredTotal : 0,
      wrongVersionEvidenceCount: results.reduce((sum, item) => sum + item.wrongVersionEvidenceCount, 0),
      forbiddenEvidenceCount: results.reduce((sum, item) => sum + item.forbiddenHits.length, 0),
      citationCompleteness: evidenceTotal ? citedEvidence / evidenceTotal : 1,
    },
    evaluationVersion: 'product-rag-evaluation-v1',
  };
}
