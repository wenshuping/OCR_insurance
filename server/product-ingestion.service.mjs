import { canonicalProductIdForRecord } from './canonical-product-id.mjs';
import { detectProductBoundaries, matchProductCandidates } from './product-boundary.service.mjs';
import { assessProductChunksQuality } from './product-chunk-quality.service.mjs';
import { annotateProductChunks } from './product-chunk-semantics.service.mjs';
import { chunkProductDocument } from './product-chunker.service.mjs';
import { parseProductDocument } from './product-document-parser.service.mjs';
import { assessProductDocumentQuality } from './product-document-quality.service.mjs';
import { extractProductFactCandidates } from './product-fact-extractor.service.mjs';

function text(value) {
  return String(value ?? '').trim();
}

function uniqueCatalog(records = []) {
  const products = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    const company = text(record?.company);
    const productName = text(record?.officialName || record?.productName || record?.name || record?.title);
    const canonicalProductId = text(record?.canonicalProductId)
      || canonicalProductIdForRecord({ ...record, productName }, company);
    if (!company || !productName || !canonicalProductId) continue;
    const key = canonicalProductId;
    const current = products.get(key) || {
      canonicalProductId,
      company,
      officialName: productName,
      productCodes: [],
    };
    current.productCodes = [...new Set([
      ...current.productCodes,
      record?.productCode,
      ...(Array.isArray(record?.productCodes) ? record.productCodes : []),
    ].map(text).filter(Boolean))];
    products.set(key, current);
  }
  return [...products.values()];
}

export function catalogProductsFromState(state = {}) {
  return uniqueCatalog([
    ...(Array.isArray(state?.knowledgeRecords) ? state.knowledgeRecords : []),
    ...(Array.isArray(state?.sourceRecords) ? state.sourceRecords : []),
    ...(Array.isArray(state?.productCustomerResponsibilitySummaries) ? state.productCustomerResponsibilitySummaries : []),
  ]);
}

function ingestionError(code, message, status = 404) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function bindChunksToMatchedProducts(chunks = [], matches = []) {
  const ranges = matches.flatMap((entry) => {
    const match = entry.autoLinkEligible ? entry.matches?.[0] : null;
    const pageStart = Number(entry.candidate?.pageStart || 0);
    const pageEnd = Number(entry.candidate?.pageEnd || pageStart);
    if (!match?.canonicalProductId || !pageStart) return [];
    return [{
      canonicalProductId: text(match.canonicalProductId),
      productVersionId: text(match.productVersionId),
      officialName: text(match.officialName),
      pageStart,
      pageEnd,
    }];
  });
  return chunks.map((chunk) => {
    const pageStart = Number(chunk?.pageStart || 0);
    const pageEnd = Number(chunk?.pageEnd || pageStart);
    const applicable = ranges.filter((range) => pageEnd >= range.pageStart && pageStart <= range.pageEnd);
    if (applicable.length !== 1) return chunk;
    const matched = applicable[0];
    const prefixLines = text(chunk?.contextualPrefix).split('\n')
      .filter((line) => !/^产品：/u.test(line) && !/^本资料涉及产品：/u.test(line));
    return {
      ...chunk,
      canonicalProductId: matched.canonicalProductId,
      productVersionId: matched.productVersionId,
      contextualPrefix: [`产品：${matched.officialName}`, ...prefixLines].filter(Boolean).join('\n'),
    };
  });
}

export function createProductIngestionService(options = {}) {
  const store = options.store;
  const parseDocument = options.parseDocument || parseProductDocument;
  const detectBoundaries = options.detectBoundaries || detectProductBoundaries;
  const matchCandidates = options.matchCandidates || matchProductCandidates;
  const chunkDocument = options.chunkDocument || chunkProductDocument;
  const annotateChunks = options.annotateChunks || annotateProductChunks;
  const assessDocumentQuality = options.assessDocumentQuality || assessProductDocumentQuality;
  const assessChunksQuality = options.assessChunksQuality || assessProductChunksQuality;
  const extractFacts = options.extractFacts || extractProductFactCandidates;

  async function ingestDocument(input = {}) {
    const tenantId = text(input.tenantId) || 'default';
    const documentId = text(input.documentId);
    if (!store) throw ingestionError('PRODUCT_KNOWLEDGE_STORE_UNAVAILABLE', '产品知识库暂不可用', 503);
    const document = store.getDocument({ tenantId, documentId, includeBytes: true });
    if (!document) throw ingestionError('PRODUCT_DOCUMENT_NOT_FOUND', '产品资料不存在');
    const job = store.getIngestionJob({ tenantId, documentId });
    if (!job) throw ingestionError('PRODUCT_INGESTION_JOB_NOT_FOUND', '产品资料解析任务不存在');

    store.updateIngestionJob({
      tenantId,
      jobId: job.id,
      status: 'processing',
      currentStep: 'parsing',
      incrementAttempt: true,
      errorCode: '',
      errorMessage: '',
    });
    try {
      const parsed = await parseDocument({
        bytes: document.bytes,
        extension: document.extension,
        document,
      });
      const documentQuality = assessDocumentQuality({ document, parsed });
      if (documentQuality.decision === 'reprocess_required') {
        throw ingestionError('PRODUCT_DOCUMENT_QUALITY_REPROCESS_REQUIRED', '产品资料质量不合格，需要重新解析', 422);
      }
      store.updateIngestionJob({ tenantId, jobId: job.id, status: 'processing', currentStep: 'detecting_products' });
      const detection = detectBoundaries(parsed.pages);
      const annotations = document.payload && typeof document.payload === 'object' ? document.payload : {};
      const annotatedProductNames = (Array.isArray(annotations.productNames) ? annotations.productNames : [annotations.productName]).map(text).filter(Boolean);
      let ensuredProducts = [];
      if (typeof store.ensureProducts === 'function') {
        ensuredProducts = store.ensureProducts({
          tenantId,
          company: text(annotations.company),
          productNames: annotatedProductNames,
        });
      }
      const catalog = uniqueCatalog([
        ...store.listProducts({ tenantId }),
        ...(Array.isArray(input.catalogProducts) ? input.catalogProducts : []),
      ]);
      const matches = matchCandidates(detection.candidates, catalog);
      const explicitlySelectedProduct = annotatedProductNames.length === 1
        ? ensuredProducts.find((entry) => text(entry.officialName) === annotatedProductNames[0])
        : null;
      const pageNumbers = parsed.pages.map((page) => Number(page?.pageNo || 0)).filter((pageNo) => pageNo > 0);
      const resolvedMatches = explicitlySelectedProduct && pageNumbers.length ? [{
        candidate: {
          company: text(explicitlySelectedProduct.company),
          productName: text(explicitlySelectedProduct.officialName),
          pageStart: Math.min(...pageNumbers),
          pageEnd: Math.max(...pageNumbers),
          relationType: 'primary',
          confidence: 1,
        },
        matches: [{ ...explicitlySelectedProduct, score: 1_000 }],
        autoLinkEligible: true,
        requiresReview: false,
        source: 'explicit_upload_selection',
      }] : matches;
      const single = resolvedMatches.length === 1 ? resolvedMatches[0] : null;
      const topMatch = single?.matches?.[0];
      const product = {
        company: text(annotations.company) || text(single?.candidate?.company),
        productName: text(single?.candidate?.productName) || (annotatedProductNames.length === 1 ? annotatedProductNames[0] : ''),
        versionLabel: text(annotations.versionLabel),
        canonicalProductId: single?.autoLinkEligible ? text(topMatch?.canonicalProductId) : '',
      };
      store.updateIngestionJob({ tenantId, jobId: job.id, status: 'processing', currentStep: 'chunking' });
      const rawChunks = chunkDocument({
        document: { ...document, documentType: parsed.documentType },
        product,
        pages: parsed.pages,
      });
      const semanticChunks = annotateChunks({
        document: { ...document, documentType: parsed.documentType },
        chunks: rawChunks,
      });
      const chunkQuality = assessChunksQuality(semanticChunks);
      const links = resolvedMatches.map((entry) => {
        const match = entry.matches?.[0];
        return {
          canonicalProductId: entry.autoLinkEligible ? text(match?.canonicalProductId) : '',
          pageStart: entry.candidate.pageStart,
          pageEnd: entry.candidate.pageEnd,
          relationType: entry.candidate.relationType || 'candidate',
          matchConfidence: match?.score ?? entry.candidate.confidence,
          reviewStatus: 'pending',
          payload: {
            detected: entry.candidate,
            matches: entry.matches,
            autoLinkEligible: entry.autoLinkEligible,
          },
        };
      });
      const chunks = bindChunksToMatchedProducts(chunkQuality.chunks, resolvedMatches);
      const facts = extractFacts({
        document: { ...document, documentType: parsed.documentType },
        chunks,
      });
      const artifacts = store.replaceParsedArtifacts({
        tenantId,
        documentId,
        documentType: parsed.documentType,
        pages: parsed.pages,
        chunks,
        facts,
        payload: {
          parser: parsed.parser,
          parserWarnings: parsed.warnings,
          parserMetadata: parsed.metadata,
          documentQuality,
          chunkQuality: {
            blockedChunkCount: chunkQuality.blockedChunkCount,
            reviewChunkCount: chunkQuality.reviewChunkCount,
            qualityRuleVersion: chunkQuality.qualityRuleVersion,
          },
          semanticClassifierVersion: 'product-chunk-semantic-v1',
          factExtractorVersion: 'product-fact-extractor-v1',
          extractedFactCount: facts.length,
          productCandidateCount: detection.candidates.length,
        },
      });
      const savedLinks = store.saveDocumentProductLinks({ tenantId, documentId, links });
      const sectionReviewCount = chunks.filter((chunk) => chunk?.payload?.reviewRequired === true).length;
      const requiresReview = detection.requiresReview
        || resolvedMatches.some((entry) => entry.requiresReview)
        || sectionReviewCount > 0
        || documentQuality.decision === 'review_required'
        || chunkQuality.blockedChunkCount > 0
        || chunkQuality.reviewChunkCount > 0;
      const completedJob = store.updateIngestionJob({
        tenantId,
        jobId: job.id,
        status: requiresReview ? 'match_required' : 'indexed_pending_review',
        currentStep: 'review',
        payload: {
          parser: parsed.parser,
          documentType: parsed.documentType,
          pageCount: parsed.pages.length,
          chunkCount: chunks.length,
          productCandidateCount: detection.candidates.length,
          sectionReviewCount,
          blockedChunkCount: chunkQuality.blockedChunkCount,
          qualityReviewChunkCount: chunkQuality.reviewChunkCount,
          documentQualityDecision: documentQuality.decision,
          requiresReview,
        },
      });
      return { ...artifacts, links: savedLinks, matches: resolvedMatches, job: completedJob };
    } catch (error) {
      const ocrRequired = error?.code === 'PRODUCT_DOCUMENT_OCR_REQUIRED';
      const transcriptionRequired = error?.code === 'PRODUCT_DOCUMENT_TRANSCRIPTION_REQUIRED';
      const qualityReprocessRequired = error?.code === 'PRODUCT_DOCUMENT_QUALITY_REPROCESS_REQUIRED';
      const pendingStatus = transcriptionRequired
        ? 'transcription_required'
        : ocrRequired
          ? 'ocr_required'
          : qualityReprocessRequired
            ? 'reprocess_required'
            : 'parse_failed';
      store.updateDocumentState({
        tenantId,
        documentId,
        parseStatus: pendingStatus,
        payload: { lastErrorCode: text(error?.code) || 'PRODUCT_DOCUMENT_PARSE_FAILED' },
      });
      store.updateIngestionJob({
        tenantId,
        jobId: job.id,
        status: pendingStatus,
        currentStep: pendingStatus,
        errorCode: text(error?.code) || 'PRODUCT_DOCUMENT_PARSE_FAILED',
        errorMessage: text(error?.message) || '产品资料解析失败',
      });
      throw error;
    }
  }

  return { ingestDocument };
}
