const text = (value) => String(value ?? '').trim();
const normalized = (value) => text(value).replace(/[,，\s]/gu, '').toLowerCase();
const numbers = (value) => normalized(value).match(/\d+(?:\.\d+)?%?/gu) || [];

export function validateProductAgentResponse(input = {}) {
  const response = input.response && typeof input.response === 'object' ? input.response : {};
  const claims = Array.isArray(response.claims) ? response.claims : [];
  const evidence = input.evidencePackage?.evidenceChunks || [];
  const evidenceById = new Map();
  evidence.forEach((item) => { evidenceById.set(item.chunkId, item); if (item.matchedChunkId) evidenceById.set(item.matchedChunkId, item); });
  const allowedProducts = new Set((input.candidateProducts || []).map((item) => text(item.canonicalProductId || item.productId || item.id)).filter(Boolean));
  const issues = [];
  if (!text(response.answer)) issues.push({ code: 'AGENT_ANSWER_MISSING', message: '缺少回答正文' });
  if (!claims.length) issues.push({ code: 'AGENT_CLAIMS_MISSING', message: '缺少可校验的结论列表' });
  claims.forEach((claim, index) => {
    const productId = text(claim?.productId);
    if (productId && !allowedProducts.has(productId)) issues.push({ code: 'AGENT_PRODUCT_NOT_CANDIDATE', claimIndex: index, productId });
    const ids = Array.isArray(claim?.evidenceChunkIds) ? claim.evidenceChunkIds.map(text).filter(Boolean) : [];
    if (!ids.length) issues.push({ code: 'AGENT_CITATION_MISSING', claimIndex: index });
    const sources = ids.map((id) => evidenceById.get(id)).filter(Boolean);
    if (sources.length !== ids.length) issues.push({ code: 'AGENT_CITATION_UNKNOWN', claimIndex: index });
    if (sources.some((source) => source.reviewStatus !== 'published')) issues.push({ code: 'AGENT_EVIDENCE_NOT_PUBLISHED', claimIndex: index });
    const sourceText = normalized(sources.map((source) => `${source.content} ${source.matchedContent || ''}`).join(' '));
    for (const number of numbers(claim?.text)) if (!sourceText.includes(number)) issues.push({ code: 'AGENT_NUMBER_UNSUPPORTED', claimIndex: index, value: number });
    if (claim?.claimType === 'objective_fact' && sources.length && sources.every((source) => source.sourceAuthority === 'company_material')) issues.push({ code: 'AGENT_MARKETING_AS_OBJECTIVE', claimIndex: index });
    if (claim?.certainty === 'confirmed' && !sources.length) issues.push({ code: 'AGENT_CERTAINTY_UNSUPPORTED', claimIndex: index });
  });
  return {
    valid: issues.length === 0,
    issues,
    fallback: issues.length ? {
      answer: '现有证据不足以支持确定性结论，以下仅列出可核对的原始资料。',
      evidence: evidence.filter((item) => item.reviewStatus === 'published').map((item) => ({ content: item.content, citation: item.citation })),
      requiresHumanReview: true,
    } : null,
  };
}
