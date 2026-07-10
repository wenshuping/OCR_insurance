import { canonicalProductIdForRecord } from './canonical-product-id.mjs';
import { detectProductBoundaries, matchProductCandidates } from './product-boundary.service.mjs';
import { chunkProductDocument } from './product-chunker.service.mjs';
import { parseProductDocument } from './product-document-parser.service.mjs';

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

export function createProductIngestionService(options = {}) {
  const store = options.store;
  const parseDocument = options.parseDocument || parseProductDocument;
  const detectBoundaries = options.detectBoundaries || detectProductBoundaries;
  const matchCandidates = options.matchCandidates || matchProductCandidates;
  const chunkDocument = options.chunkDocument || chunkProductDocument;

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
      store.updateIngestionJob({ tenantId, jobId: job.id, status: 'processing', currentStep: 'detecting_products' });
      const detection = detectBoundaries(parsed.pages);
      const catalog = uniqueCatalog([
        ...store.listProducts({ tenantId }),
        ...(Array.isArray(input.catalogProducts) ? input.catalogProducts : []),
      ]);
      const matches = matchCandidates(detection.candidates, catalog);
      const single = matches.length === 1 ? matches[0] : null;
      const topMatch = single?.matches?.[0];
      const product = single ? {
        company: single.candidate.company,
        productName: single.candidate.productName,
        canonicalProductId: single.autoLinkEligible ? text(topMatch?.canonicalProductId) : '',
      } : {};
      store.updateIngestionJob({ tenantId, jobId: job.id, status: 'processing', currentStep: 'chunking' });
      const chunks = chunkDocument({
        document: { ...document, documentType: parsed.documentType },
        product,
        pages: parsed.pages,
      });
      const links = matches.map((entry) => {
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
      const artifacts = store.replaceParsedArtifacts({
        tenantId,
        documentId,
        documentType: parsed.documentType,
        pages: parsed.pages,
        chunks,
        payload: {
          parser: parsed.parser,
          parserWarnings: parsed.warnings,
          parserMetadata: parsed.metadata,
          productCandidateCount: detection.candidates.length,
        },
      });
      const savedLinks = store.saveDocumentProductLinks({ tenantId, documentId, links });
      const requiresReview = detection.requiresReview || matches.some((entry) => entry.requiresReview);
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
          requiresReview,
        },
      });
      return { ...artifacts, links: savedLinks, matches, job: completedJob };
    } catch (error) {
      const ocrRequired = error?.code === 'PRODUCT_DOCUMENT_OCR_REQUIRED';
      store.updateDocumentState({
        tenantId,
        documentId,
        parseStatus: ocrRequired ? 'ocr_required' : 'parse_failed',
        payload: { lastErrorCode: text(error?.code) || 'PRODUCT_DOCUMENT_PARSE_FAILED' },
      });
      store.updateIngestionJob({
        tenantId,
        jobId: job.id,
        status: ocrRequired ? 'ocr_required' : 'parse_failed',
        currentStep: ocrRequired ? 'ocr_required' : 'parsing',
        errorCode: text(error?.code) || 'PRODUCT_DOCUMENT_PARSE_FAILED',
        errorMessage: text(error?.message) || '产品资料解析失败',
      });
      throw error;
    }
  }

  return { ingestDocument };
}
