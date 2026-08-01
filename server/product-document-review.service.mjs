function text(value) {
  return String(value ?? '').trim();
}

function uniqueText(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(text).filter(Boolean))];
}

function effectiveElements(pages) {
  return (Array.isArray(pages) ? pages : []).flatMap((page) => (
    Array.isArray(page?.layout?.elements)
      ? page.layout.elements
        .filter((element) => !(Array.isArray(page?.excludedElementIds) ? page.excludedElementIds : []).includes(text(element?.id)))
        .map((element) => ({ ...element, pageNo: Number(page.pageNo) }))
      : []
  )).filter((element) => ['text', 'table', 'business_image'].includes(text(element?.kind)));
}

function deterministicIssues(pages, chunks) {
  const readyChunks = (Array.isArray(chunks) ? chunks : []).filter((chunk) => text(chunk?.chunkType) !== 'parent' && text(chunk?.indexStatus) !== 'blocked');
  const covered = new Set(readyChunks.flatMap((chunk) => (
    Array.isArray(chunk?.payload?.sourceRegions) ? chunk.payload.sourceRegions.flatMap((region) => region.elementIds || []) : []
  )).map(text).filter(Boolean));
  const groupedMissing = new Map();
  for (const element of effectiveElements(pages).filter((item) => !covered.has(text(item.id)))) {
    const type = element.kind === 'business_image' ? 'image_missing' : 'missing_content';
    const reason = element.kind === 'business_image' ? '业务图片没有对应候选切片' : '来源内容没有被任何可检索切片覆盖';
    const pageNo = Number(element.pageNo);
    const key = `${pageNo}\u001f${type}\u001f${reason}`;
    if (!groupedMissing.has(key)) {
      groupedMissing.set(key, {
        type, severity: 'high', confidence: 1, pageNos: [pageNo],
        sourceRegions: [{ pageNo, elementIds: [] }], affectedChunkIds: [], reason,
        missingElements: [], proposedOperations: [], source: 'deterministic_coverage',
      });
    }
    const issue = groupedMissing.get(key);
    const elementId = text(element.id);
    if (elementId) issue.sourceRegions[0].elementIds.push(elementId);
    const content = text(element?.text || element?.caption);
    if (content) issue.missingElements.push(content);
  }
  const issues = [...groupedMissing.values()];
  for (const chunk of readyChunks) {
    if (/(?:扫码|二维码|关注公众号|客服电话)\s*[:：]?\s*\d{4,}/u.test(text(chunk.content))) {
      issues.push({
        type: 'content_extra', severity: 'medium', confidence: 0.9,
        pageNos: uniqueText([chunk.pageStart, chunk.pageEnd]).map(Number),
        sourceRegions: Array.isArray(chunk?.payload?.sourceRegions) ? chunk.payload.sourceRegions : [],
        affectedChunkIds: [text(chunk.id)], reason: '切片疑似包含二维码、公众号或重复联系方式',
        proposedOperations: [], source: 'deterministic_noise',
      });
    }
  }
  return issues;
}

function validateIssue(issue, pageMap, elementIds, chunkIds) {
  const pageNos = uniqueText(issue?.pageNos).map(Number).filter((pageNo) => pageMap.has(pageNo));
  const affectedChunkIds = uniqueText(issue?.affectedChunkIds).filter((id) => chunkIds.has(id));
  const sourceRegions = (Array.isArray(issue?.sourceRegions) ? issue.sourceRegions : []).flatMap((region) => {
    const pageNo = Number(region?.pageNo || 0);
    const validElementIds = uniqueText(region?.elementIds).filter((id) => elementIds.has(id));
    return pageMap.has(pageNo) && validElementIds.length ? [{ pageNo, elementIds: validElementIds }] : [];
  });
  if (!pageNos.length && !affectedChunkIds.length && !sourceRegions.length) return null;
  const type = text(issue?.type);
  const reason = text(issue?.reason);
  if (!type || !reason) return null;
  return {
    type,
    severity: ['high', 'medium', 'low'].includes(text(issue?.severity)) ? text(issue.severity) : 'medium',
    confidence: Math.max(0, Math.min(1, Number(issue?.confidence ?? 0.5))),
    pageNos,
    sourceRegions,
    affectedChunkIds,
    reason,
    missingElements: uniqueText(issue?.missingElements),
    proposedOperations: Array.isArray(issue?.proposedOperations) ? issue.proposedOperations : [],
    source: text(issue?.source) || 'ai_model',
  };
}

export function createProductDocumentReviewService({ reviewModel = null } = {}) {
  async function reviewDocument({ document = {}, pages = [], chunks = [] } = {}) {
    const pageMap = new Map((Array.isArray(pages) ? pages : []).map((page) => [Number(page?.pageNo || 0), page]));
    const elementIds = new Set(effectiveElements(pages).map((element) => text(element.id)));
    const chunkIds = new Set((Array.isArray(chunks) ? chunks : []).map((chunk) => text(chunk.id)));
    const baseIssues = deterministicIssues(pages, chunks);
    let modelResult = { model: '', issues: [] };
    if (typeof reviewModel === 'function') {
      try {
        modelResult = await reviewModel({ document, pages, chunks });
      } catch (error) {
        if (error?.code !== 'PRODUCT_DOCUMENT_REVIEW_MODEL_UNAVAILABLE') throw error;
        modelResult = { model: '', issues: [], unavailableReason: text(error?.message) };
      }
    }
    const issues = [...baseIssues, ...(Array.isArray(modelResult?.issues) ? modelResult.issues : [])]
      .map((issue) => validateIssue(issue, pageMap, elementIds, chunkIds))
      .filter(Boolean)
      .filter((issue, index, rows) => rows.findIndex((candidate) => JSON.stringify([
        candidate.type, candidate.reason, candidate.pageNos, candidate.affectedChunkIds, candidate.sourceRegions,
      ]) === JSON.stringify([issue.type, issue.reason, issue.pageNos, issue.affectedChunkIds, issue.sourceRegions])) === index);
    return {
      decision: issues.some((issue) => issue.severity === 'high') ? 'human_review_required' : issues.length ? 'review_recommended' : 'pass',
      model: text(modelResult?.model),
      modelStatus: text(modelResult?.model) ? 'completed' : 'unavailable',
      modelUnavailableReason: text(modelResult?.unavailableReason),
      issues,
      summary: {
        issueCount: issues.length,
        highRiskCount: issues.filter((issue) => issue.severity === 'high').length,
        mediumRiskCount: issues.filter((issue) => issue.severity === 'medium').length,
        reviewedChunkCount: chunkIds.size,
        reviewedPageCount: pageMap.size,
      },
      reviewVersion: 'product-document-review-v1',
    };
  }

  async function planCorrection({ document = {}, pages = [], chunks = [], request = {} } = {}) {
    if (typeof reviewModel !== 'function') {
      const error = new Error('产品资料 AI 修正模型暂不可用');
      error.code = 'PRODUCT_DOCUMENT_REVIEW_MODEL_UNAVAILABLE';
      error.status = 503;
      throw error;
    }
    const pageMap = new Map((Array.isArray(pages) ? pages : []).map((page) => [Number(page?.pageNo || 0), page]));
    const elementIds = new Set(effectiveElements(pages).map((element) => text(element.id)));
    const sourceChunks = Array.isArray(chunks) ? chunks : [];
    const chunkIds = new Set(sourceChunks.map((chunk) => text(chunk.id)));
    const modelResult = await reviewModel({ document, pages, chunks: sourceChunks, correctionRequest: request });
    const issues = (Array.isArray(modelResult?.issues) ? modelResult.issues : [])
      .map((issue) => validateIssue(issue, pageMap, elementIds, chunkIds))
      .filter(Boolean);
    const scope = text(request?.scope) || 'current_chunk';
    const requestedChunkIds = new Set(uniqueText(request?.targetChunkIds).filter((id) => chunkIds.has(id)));
    const pageNo = Number(request?.pageNo || 0);
    const pageChunkIds = new Set(sourceChunks.filter((chunk) => (
      pageNo > 0 && Number(chunk?.pageStart || 0) <= pageNo && Number(chunk?.pageEnd || 0) >= pageNo
    )).map((chunk) => text(chunk.id)));
    const allowedChunkIds = scope === 'document_repeated_regions'
      ? chunkIds
      : scope === 'current_chunk'
        ? requestedChunkIds
        : pageChunkIds;
    const operations = issues.flatMap((issue) => issue.proposedOperations || []).filter((operation) => {
      if (text(operation?.targetChunkId) && !allowedChunkIds.has(text(operation.targetChunkId))) return false;
      const targets = uniqueText(operation?.targetChunkIds);
      return targets.every((id) => allowedChunkIds.has(id));
    });
    return {
      model: text(modelResult?.model),
      issues,
      operations,
      correctionVersion: 'product-document-ai-correction-v1',
    };
  }

  return { planCorrection, reviewDocument };
}
