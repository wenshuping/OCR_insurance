import express from 'express';
import dns from 'node:dns/promises';
import net from 'node:net';

import { sendError } from '../http/errors.mjs';
import { listProductCatalogCompanies, searchProductCatalog } from '../product-catalog-search.mjs';
import { MAX_PRODUCT_DOCUMENT_BYTES, normalizeProductDocumentUpload } from '../product-document-upload.service.mjs';
import {
  catalogProductsFromState,
  createProductIngestionService,
} from '../product-ingestion.service.mjs';
import { assessProductPublishReadiness } from '../product-document-quality.service.mjs';
import { buildProductDocumentCorrectionPlan } from '../product-document-correction.service.mjs';
import { createProductDocumentPreviewService } from '../product-document-preview.service.mjs';
import { createProductDocumentReviewService } from '../product-document-review.service.mjs';
import { createProductDocumentReviewModel } from '../product-document-review-model.service.mjs';
import { createProductRagService } from '../product-rag.service.mjs';

const DEFAULT_TENANT_ID = 'default';

function cleanText(value, maxLength = 200) {
  return String(value || '').trim().slice(0, maxLength);
}

function cleanTags(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((item) => cleanText(item, 40))
    .filter(Boolean))].slice(0, 30);
}

function isPrivateAddress(address) {
  const value = String(address || '').toLowerCase();
  if (net.isIPv4(value)) {
    const [a, b] = value.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return net.isIPv6(value) && (value === '::1' || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe80:'));
}

async function safePublicUrl(value, { skipDns = false } = {}) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch { throw routeError('PRODUCT_MATERIAL_URL_INVALID', '请输入有效的资料链接', 400); }
  if (!['http:', 'https:'].includes(url.protocol)) throw routeError('PRODUCT_MATERIAL_URL_INVALID', '资料链接只支持HTTP或HTTPS', 400);
  if (url.username || url.password || url.hostname === 'localhost' || url.hostname.endsWith('.local') || isPrivateAddress(url.hostname)) {
    throw routeError('PRODUCT_MATERIAL_URL_FORBIDDEN', '资料链接不能指向本机或内网地址', 400);
  }
  if (!skipDns) {
    const addresses = await dns.lookup(url.hostname, { all: true }).catch(() => []);
    if (!addresses.length || addresses.some((item) => isPrivateAddress(item.address))) {
      throw routeError('PRODUCT_MATERIAL_URL_FORBIDDEN', '资料链接地址不可访问或指向内网', 400);
    }
  }
  return url;
}

function fileNameFromUrl(url, contentType) {
  const pathName = decodeURIComponent(url.pathname.split('/').at(-1) || '').trim();
  if (/\.[A-Za-z0-9]{2,6}$/u.test(pathName)) return pathName;
  if (/pdf/iu.test(contentType)) return '链接资料.pdf';
  if (/presentation/iu.test(contentType)) return '链接资料.pptx';
  if (/wordprocessingml/iu.test(contentType)) return '链接资料.docx';
  return '链接网页资料.txt';
}

function htmlToText(value) {
  return String(value || '')
    .replace(/<script\b[\s\S]*?<\/script>/giu, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/giu, ' ')
    .replace(/<[^>]+>/gu, '\n')
    .replace(/&nbsp;/giu, ' ').replace(/&amp;/giu, '&').replace(/&lt;/giu, '<').replace(/&gt;/giu, '>')
    .replace(/[ \t]+/gu, ' ').replace(/\n{3,}/gu, '\n\n').trim();
}

async function fetchLinkedMaterial(sourceUrl, fetchImpl) {
  let url = await safePublicUrl(sourceUrl, { skipDns: fetchImpl !== globalThis.fetch });
  for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
    const response = await fetchImpl(url, { redirect: 'manual', headers: { 'user-agent': 'OCR-Insurance-Knowledge/1.0' } });
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      url = await safePublicUrl(new URL(response.headers.get('location'), url).toString(), { skipDns: fetchImpl !== globalThis.fetch });
      continue;
    }
    if (!response.ok) throw routeError('PRODUCT_MATERIAL_URL_FETCH_FAILED', `资料链接读取失败（${response.status}）`, 422);
    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > MAX_PRODUCT_DOCUMENT_BYTES) throw routeError('PRODUCT_DOCUMENT_TOO_LARGE', '链接资料超过16MB', 413);
    const contentType = String(response.headers.get('content-type') || '').split(';')[0].trim();
    let bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_PRODUCT_DOCUMENT_BYTES) throw routeError('PRODUCT_DOCUMENT_TOO_LARGE', '链接资料超过16MB', 413);
    let fileName = fileNameFromUrl(url, contentType);
    if (/text\/html|application\/xhtml/iu.test(contentType) || /\.html?$/iu.test(fileName)) {
      bytes = Buffer.from(htmlToText(bytes.toString('utf8')), 'utf8');
      fileName = fileName.replace(/\.html?$/iu, '') + '.txt';
    }
    if (!bytes.length) throw routeError('PRODUCT_DOCUMENT_EMPTY', '资料链接没有可解析内容', 422);
    return { sourceUrl: url.toString(), fileName, mediaType: /\.txt$/iu.test(fileName) ? 'text/plain' : contentType, bytes };
  }
  throw routeError('PRODUCT_MATERIAL_URL_REDIRECT_LIMIT', '资料链接重定向次数过多', 422);
}

function uploadPayload(body, libraryType, extra = {}) {
  const productNames = cleanTags(body?.productNames).length
    ? cleanTags(body.productNames)
    : [cleanText(body?.productName)].filter(Boolean);
  return {
    libraryType,
    contributorName: cleanText(body?.contributorName), contributorRole: cleanText(body?.contributorRole),
    title: cleanText(body?.title), materialType: cleanText(body?.materialType), company: cleanText(body?.company),
    productName: productNames[0] || '', productNames, versionLabel: cleanText(body?.versionLabel), focusTags: cleanTags(body?.focusTags),
    materialUsages: cleanTags(body?.materialUsages).length ? cleanTags(body?.materialUsages) : [cleanText(body?.materialUsage) || '销售建议资料'],
    specialInstructions: cleanText(body?.specialInstructions, 2000), ...extra,
  };
}

function documentProductNames(payload = {}) {
  const names = Array.isArray(payload.productNames) ? payload.productNames : [payload.productName];
  return [...new Set(names.map((item) => cleanText(item)).filter(Boolean))];
}

function ensureUploadedProducts(store, payload = {}) {
  if (typeof store?.ensureProducts !== 'function') return [];
  return store.ensureProducts({
    tenantId: DEFAULT_TENANT_ID,
    company: cleanText(payload.company),
    productNames: documentProductNames(payload),
  });
}

function bindingProductsForDocument(store, document = {}) {
  const selectedNames = new Set(documentProductNames(document.payload).map(comparableProductName));
  const company = cleanText(document.payload?.company);
  return store.listProducts({ tenantId: DEFAULT_TENANT_ID })
    .filter((product) => (!company || cleanText(product.company) === company)
      && selectedNames.has(comparableProductName(product.officialName)))
    .map((product) => {
      const versionLabel = cleanText(document.payload?.versionLabel);
      const version = versionLabel && typeof store.listProductVersions === 'function'
        ? store.listProductVersions({
            tenantId: DEFAULT_TENANT_ID,
            canonicalProductId: product.canonicalProductId,
          }).find((entry) => cleanText(entry.versionLabel) === versionLabel)
        : null;
      return {
        canonicalProductId: product.canonicalProductId,
        productVersionId: cleanText(version?.id),
        company: product.company,
        officialName: product.officialName,
      };
    });
}

function comparableProductName(value) {
  return String(value || '').replace(/[\s（）()·]/gu, '').toLowerCase();
}

function pagesForProduct(pages, links, productName) {
  const target = comparableProductName(productName);
  const ranges = links.filter((link) => {
    const detected = comparableProductName(link?.payload?.detected?.productName);
    return detected && (detected.includes(target) || target.includes(detected));
  });
  if (!ranges.length) return { pages, boundaryMatched: false };
  return {
    pages: pages.filter((page) => ranges.some((range) => page.pageNo >= Number(range.pageStart || 0) && page.pageNo <= Number(range.pageEnd || 0))),
    boundaryMatched: true,
  };
}

function isResponsibilityIndicatorMaterial(payload = {}) {
  return (Array.isArray(payload.materialUsages) ? payload.materialUsages : [payload.materialUsage])
    .some((item) => /责任指标/u.test(String(item || '')));
}

function routeError(code, message, status) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

export function createProductKnowledgeRoutes(context = {}) {
  const router = express.Router();
  const {
    state,
    adminPassword,
    requireAdmin,
    productKnowledgeStore,
    productIngestionService,
    productDocumentPreviewService,
    productDocumentReviewService,
    productRagService,
    recognizeDocumentText,
    parseProductPageVisual,
    reconstructProductSlide,
    productMaterialFetchImpl,
    upsertKnowledgeRecords,
    persistResponsibilityLookupArtifacts,
    allocateId,
    db,
  } = context;
  const ingestionService = productIngestionService || (productKnowledgeStore
    ? createProductIngestionService({ store: productKnowledgeStore, recognizeDocumentText, parseProductPageVisual, reconstructProductSlide })
    : null);
  const ragService = productRagService || (productKnowledgeStore
    ? createProductRagService({ store: productKnowledgeStore })
    : null);
  const reviewService = productDocumentReviewService || createProductDocumentReviewService({
    reviewModel: createProductDocumentReviewModel(),
  });
  const previewService = productDocumentPreviewService || createProductDocumentPreviewService();
  function authorize(req, res) {
    if (typeof requireAdmin !== 'function') {
      res.status(503).json({
        ok: false,
        code: 'PRODUCT_KNOWLEDGE_ADMIN_AUTH_UNAVAILABLE',
        message: '产品知识库后台鉴权不可用',
      });
      return null;
    }
    return requireAdmin(req, res, state, adminPassword);
  }

  function storeOrThrow() {
    if (!productKnowledgeStore) {
      throw routeError(
        'PRODUCT_KNOWLEDGE_STORE_UNAVAILABLE',
        '产品知识库暂不可用',
        503,
      );
    }
    return productKnowledgeStore;
  }

  async function runAndSaveDocumentReview(documentId) {
    const store = storeOrThrow();
    const document = store.getDocument({ tenantId: DEFAULT_TENANT_ID, documentId });
    if (!document) throw routeError('PRODUCT_DOCUMENT_NOT_FOUND', '产品资料不存在', 404);
    const pages = store.listDocumentPages({ tenantId: DEFAULT_TENANT_ID, documentId });
    const indexReview = store.getDocumentIndexReview({ tenantId: DEFAULT_TENANT_ID, documentId });
    const review = await reviewService.reviewDocument({
      document,
      pages,
      chunks: indexReview?.candidateChunks || [],
    });
    const saved = store.saveDocumentReviewResult({
      tenantId: DEFAULT_TENANT_ID,
      documentId,
      indexVersion: indexReview?.candidateIndexVersion || document.payload?.candidateIndexVersion,
      reviewType: 'ai_pre_review',
      model: review.model,
      status: 'completed',
      issues: review.issues,
      summary: review.summary,
      payload: { decision: review.decision, reviewVersion: review.reviewVersion },
    });
    return { review, run: saved?.run || null, issues: saved?.issues || [] };
  }

  router.get('/catalog/companies', (req, res) => {
    const session = authorize(req, res);
    if (!session) return;
    try {
      if (!db) throw routeError('PRODUCT_CATALOG_UNAVAILABLE', '产品目录数据库暂不可用', 503);
      const companies = listProductCatalogCompanies({ db, visibility: 'admin' }).map((row) => row.company);
      return res.json({ ok: true, companies, summary: { count: companies.length } });
    } catch (error) { return sendError(res, error); }
  });

  router.get('/catalog/products', (req, res) => {
    const session = authorize(req, res);
    if (!session) return;
    try {
      if (!db) throw routeError('PRODUCT_CATALOG_UNAVAILABLE', '产品目录数据库暂不可用', 503);
      const company = cleanText(req.query?.company, 200);
      const query = cleanText(req.query?.q, 200);
      const limit = Math.max(1, Math.min(50, Number(req.query?.limit || 30) || 30));
      const products = searchProductCatalog({ db, company, query, limit, visibility: 'admin' });
      return res.json({ ok: true, products, summary: { count: products.length, query, company } });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/documents', async (req, res) => {
    const session = authorize(req, res);
    if (!session) return;
    try {
      const upload = normalizeProductDocumentUpload(req.body);
      const libraryType = req.body?.libraryType === 'expert' ? 'expert' : 'company_product';
      const store = storeOrThrow();
      const payload = uploadPayload(req.body, libraryType);
      const result = store.createDocumentUpload({
        tenantId: DEFAULT_TENANT_ID,
        createdBy: String(session.token || session.id || 'admin'),
        sourceAuthority: libraryType === 'expert' ? 'expert_training' : 'company_material',
        payload,
        ...upload,
        contentHash: `${libraryType}:${upload.contentHash}`,
      });
      const products = ensureUploadedProducts(store, payload);
      return res.status(result.deduplicated ? 200 : 201).json({ ok: true, ...result, products });
    } catch (error) {
      return sendError(res, error, 400);
    }
  });

  router.post('/documents/from-url', async (req, res) => {
    const session = authorize(req, res);
    if (!session) return;
    try {
      const libraryType = req.body?.libraryType === 'expert' ? 'expert' : 'company_product';
      const linked = await fetchLinkedMaterial(req.body?.sourceUrl, productMaterialFetchImpl || globalThis.fetch);
      const upload = normalizeProductDocumentUpload({
        fileName: linked.fileName,
        mediaType: linked.mediaType,
        dataBase64: linked.bytes.toString('base64'),
      });
      const store = storeOrThrow();
      const payload = uploadPayload(req.body, libraryType, { sourceUrl: linked.sourceUrl });
      const result = store.createDocumentUpload({
        tenantId: DEFAULT_TENANT_ID,
        createdBy: String(session.token || session.id || 'admin'),
        sourceAuthority: libraryType === 'expert' ? 'expert_training' : 'company_material',
        payload,
        ...upload,
        contentHash: `${libraryType}:${upload.contentHash}`,
      });
      const products = ensureUploadedProducts(store, payload);
      return res.status(result.deduplicated ? 200 : 201).json({ ok: true, ...result, products });
    } catch (error) { return sendError(res, error, error?.status || 400); }
  });

  router.get('/documents', async (req, res) => {
    const session = authorize(req, res);
    if (!session) return;
    try {
      const store = storeOrThrow();
      const includeReviewChunks = String(req.query?.includeChunks || '') === 'review';
      const documents = store.listDocuments({
        tenantId: DEFAULT_TENANT_ID,
        limit: req.query?.limit,
      }).map((document) => ({
        ...document,
        job: store.getIngestionJob({
          tenantId: DEFAULT_TENANT_ID,
          documentId: document.id,
        }),
        ...(includeReviewChunks ? (() => {
          const indexReview = store.getDocumentIndexReview({ tenantId: DEFAULT_TENANT_ID, documentId: document.id });
          const reviewChunks = indexReview?.candidateChunks?.length ? indexReview.candidateChunks : indexReview?.activeChunks || [];
          return {
            indexReview: indexReview ? { ...indexReview, activeChunks: undefined, candidateChunks: undefined } : null,
            reviewChunks,
            bindingProducts: bindingProductsForDocument(store, document),
            publishReadiness: indexReview?.candidateIndexVersion ? assessProductPublishReadiness({
              document,
              links: store.listDocumentProductLinks({ tenantId: DEFAULT_TENANT_ID, documentId: document.id }),
              chunks: reviewChunks,
            }) : null,
          };
        })() : {}),
      }));
      return res.json({ ok: true, documents, summary: { count: documents.length } });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get('/documents/:documentId', async (req, res) => {
    const session = authorize(req, res);
    if (!session) return;
    try {
      const store = storeOrThrow();
      const documentId = String(req.params.documentId || '').trim();
      const document = store.getDocument({
        tenantId: DEFAULT_TENANT_ID,
        documentId,
      });
      if (!document) {
        throw routeError('PRODUCT_DOCUMENT_NOT_FOUND', '产品资料不存在', 404);
      }
      const job = store.getIngestionJob({
        tenantId: DEFAULT_TENANT_ID,
        documentId,
      });
      const links = store.listDocumentProductLinks({ tenantId: DEFAULT_TENANT_ID, documentId });
      const pages = store.listDocumentPages({ tenantId: DEFAULT_TENANT_ID, documentId });
      const chunks = store.listDocumentChunks({ tenantId: DEFAULT_TENANT_ID, documentId });
      const indexReview = store.getDocumentIndexReview({ tenantId: DEFAULT_TENANT_ID, documentId });
      return res.json({
        ok: true,
        document,
        job,
        links,
        chunks,
        indexReview,
        summary: {
          pageCount: pages.length,
          chunkCount: chunks.length,
          readyChunkCount: chunks.filter((chunk) => chunk.chunkType !== 'parent' && chunk.indexStatus === 'ready').length,
          blockedChunkCount: chunks.filter((chunk) => chunk.chunkType !== 'parent' && chunk.indexStatus === 'blocked').length,
        },
      });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get('/documents/:documentId/review-workspace', (req, res) => {
    const session = authorize(req, res);
    if (!session) return;
    try {
      const store = storeOrThrow();
      const documentId = String(req.params.documentId || '').trim();
      const document = store.getDocument({ tenantId: DEFAULT_TENANT_ID, documentId });
      if (!document) throw routeError('PRODUCT_DOCUMENT_NOT_FOUND', '产品资料不存在', 404);
      const pages = store.listDocumentPages({ tenantId: DEFAULT_TENANT_ID, documentId });
      const indexReview = store.getDocumentIndexReview({ tenantId: DEFAULT_TENANT_ID, documentId });
      const reviewRuns = store.listDocumentReviewRuns({ tenantId: DEFAULT_TENANT_ID, documentId });
      const cleaningRuns = typeof store.listDocumentCleaningRuns === 'function'
        ? store.listDocumentCleaningRuns({ tenantId: DEFAULT_TENANT_ID, documentId })
        : [];
      const cleaningOperations = cleaningRuns[0] && typeof store.listDocumentCleaningOperations === 'function'
        ? store.listDocumentCleaningOperations({
            tenantId: DEFAULT_TENANT_ID,
            documentId,
            runId: cleaningRuns[0].id,
          })
        : [];
      const issues = reviewRuns[0]
        ? store.listDocumentReviewIssues({ tenantId: DEFAULT_TENANT_ID, documentId, runId: reviewRuns[0].id })
        : [];
      const corrections = store.listDocumentCorrections({ tenantId: DEFAULT_TENANT_ID, documentId });
      const pageReviews = store.listDocumentPageReviews({
        tenantId: DEFAULT_TENANT_ID,
        documentId,
        indexVersion: indexReview?.candidateIndexVersion,
      });
      return res.json({
        ok: true,
        document,
        pages,
        indexReview,
        reviewRuns,
        issues,
        corrections,
        pageReviews,
        cleaningRuns,
        cleaningOperations,
      });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post('/documents/:documentId/pages/:pageNo/review', (req, res) => {
    const session = authorize(req, res);
    if (!session) return;
    try {
      const store = storeOrThrow();
      const documentId = String(req.params.documentId || '').trim();
      const pageNo = Number(req.params.pageNo || 0);
      const pages = store.listDocumentPages({ tenantId: DEFAULT_TENANT_ID, documentId });
      if (!pages.some((page) => page.pageNo === pageNo)) {
        throw routeError('PRODUCT_DOCUMENT_PAGE_NOT_FOUND', '产品资料页面不存在', 404);
      }
      const review = store.saveDocumentPageReview({
        tenantId: DEFAULT_TENANT_ID,
        documentId,
        pageNo,
        indexVersion: req.body?.indexVersion,
        status: req.body?.status,
        note: req.body?.note,
        reviewer: String(session.token || session.id || 'admin'),
      });
      if (!review) throw routeError('PRODUCT_DOCUMENT_PAGE_REVIEW_INVALID', '页面审核状态无效', 400);
      const candidateChunks = store.getDocumentIndexReview({ tenantId: DEFAULT_TENANT_ID, documentId })?.candidateChunks || [];
      const publishedChunkCount = candidateChunks.filter((chunk) => (
        chunk.chunkType !== 'parent'
        && chunk.reviewStatus === 'published'
        && pageNo >= chunk.pageStart
        && pageNo <= chunk.pageEnd
      )).length;
      return res.json({ ok: true, review, publishedChunkCount });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get('/documents/:documentId/source', (req, res) => {
    const session = authorize(req, res);
    if (!session) return;
    try {
      const documentId = String(req.params.documentId || '').trim();
      const document = storeOrThrow().getDocument({
        tenantId: DEFAULT_TENANT_ID,
        documentId,
        includeBytes: true,
      });
      if (!document) throw routeError('PRODUCT_DOCUMENT_NOT_FOUND', '产品资料不存在', 404);
      const fileName = cleanText(document.fileName, 240) || 'document';
      const mediaType = cleanText(document.mediaType, 120);
      res.setHeader('Content-Type', /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/u.test(mediaType) ? mediaType : 'application/octet-stream');
      res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(fileName)}`);
      return res.send(document.bytes);
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get('/documents/:documentId/pages/:pageNo/preview', async (req, res) => {
    const session = authorize(req, res);
    if (!session) return;
    try {
      const documentId = String(req.params.documentId || '').trim();
      const pageNo = Number(req.params.pageNo || 0);
      const store = storeOrThrow();
      const document = store.getDocument({ tenantId: DEFAULT_TENANT_ID, documentId, includeBytes: true });
      if (!document) throw routeError('PRODUCT_DOCUMENT_NOT_FOUND', '产品资料不存在', 404);
      const pages = store.listDocumentPages({ tenantId: DEFAULT_TENANT_ID, documentId });
      if (!pages.some((page) => page.pageNo === pageNo)) {
        throw routeError('PRODUCT_DOCUMENT_PAGE_NOT_FOUND', '产品资料页面不存在', 404);
      }
      const image = await previewService.getPagePreview({ document, pageNo });
      res.setHeader('Content-Type', document.mediaType.startsWith('image/') ? document.mediaType : 'image/png');
      res.setHeader('Cache-Control', 'private, max-age=3600');
      return res.send(image);
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post('/documents/:documentId/pre-review', async (req, res) => {
    const session = authorize(req, res);
    if (!session) return;
    try {
      const documentId = String(req.params.documentId || '').trim();
      return res.json({ ok: true, ...await runAndSaveDocumentReview(documentId) });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post('/documents/:documentId/corrections/plan', async (req, res) => {
    const session = authorize(req, res);
    if (!session) return;
    try {
      const store = storeOrThrow();
      const documentId = String(req.params.documentId || '').trim();
      const document = store.getDocument({ tenantId: DEFAULT_TENANT_ID, documentId });
      if (!document) {
        throw routeError('PRODUCT_DOCUMENT_NOT_FOUND', '产品资料不存在', 404);
      }
      const deterministicPlan = buildProductDocumentCorrectionPlan(req.body);
      if (deterministicPlan.operations.length || !cleanText(deterministicPlan.note)) {
        return res.json({ ok: true, plan: deterministicPlan });
      }
      if (typeof reviewService.planCorrection !== 'function') {
        throw routeError('PRODUCT_DOCUMENT_AI_CORRECTION_UNAVAILABLE', '产品资料 AI 修正服务暂不可用', 503);
      }
      const pages = store.listDocumentPages({ tenantId: DEFAULT_TENANT_ID, documentId });
      const indexReview = store.getDocumentIndexReview({ tenantId: DEFAULT_TENANT_ID, documentId });
      const aiPlan = await reviewService.planCorrection({
        document,
        pages,
        chunks: indexReview?.candidateChunks || [],
        request: {
          pageNo: Number(req.body?.pageNo || 0),
          reasonCode: deterministicPlan.reasonCode,
          note: deterministicPlan.note,
          scope: deterministicPlan.scope,
          targetChunkIds: req.body?.targetChunkIds,
          sourceElementIds: req.body?.sourceElementIds,
        },
      });
      return res.json({
        ok: true,
        plan: {
          ...buildProductDocumentCorrectionPlan({ ...req.body, operations: aiPlan.operations }),
          model: aiPlan.model,
          aiIssues: aiPlan.issues,
          correctionVersion: aiPlan.correctionVersion,
        },
      });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post('/documents/:documentId/corrections/confirm', async (req, res) => {
    const session = authorize(req, res);
    if (!session) return;
    try {
      const store = storeOrThrow();
      const documentId = String(req.params.documentId || '').trim();
      const plan = buildProductDocumentCorrectionPlan(req.body?.plan || req.body);
      const correction = store.saveDocumentCorrection({
        tenantId: DEFAULT_TENANT_ID,
        documentId,
        sourceIssueId: req.body?.sourceIssueId,
        indexVersion: req.body?.indexVersion,
        reasonCode: plan.reasonCode,
        note: plan.note,
        scope: plan.scope,
        operations: plan.operations,
        status: 'approved',
        createdBy: String(session.token || session.id || 'admin'),
      });
      if (!correction) throw routeError('PRODUCT_DOCUMENT_NOT_FOUND', '产品资料不存在', 404);
      let reprocessed = null;
      if (ingestionService) {
        reprocessed = await ingestionService.ingestDocument({
          tenantId: DEFAULT_TENANT_ID,
          documentId,
          catalogProducts: catalogProductsFromState(state),
          correctionIds: [correction.id],
          correctionOperations: correction.operations,
        });
      }
      const pageNo = Math.trunc(Number(req.body?.pageNo || 0));
      if (reprocessed?.indexVersion && pageNo > 0) {
        store.saveDocumentPageReview({
          tenantId: DEFAULT_TENANT_ID,
          documentId,
          pageNo,
          indexVersion: reprocessed.indexVersion,
          status: 'pending_confirmation',
          note: 'AI 修正已生成新候选版本，等待人工再次确认',
          reviewer: String(session.token || session.id || 'admin'),
        });
      }
      return res.json({ ok: true, correction, reprocessed });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post('/documents/:documentId/process', async (req, res) => {
    const session = authorize(req, res);
    if (!session) return;
    try {
      if (!ingestionService) {
        throw routeError('PRODUCT_INGESTION_UNAVAILABLE', '产品资料解析服务暂不可用', 503);
      }
      const result = await ingestionService.ingestDocument({
        tenantId: DEFAULT_TENANT_ID,
        documentId: String(req.params.documentId || '').trim(),
        catalogProducts: catalogProductsFromState(state),
      });
      const documentId = String(req.params.documentId || '').trim();
      let preReview;
      try {
        preReview = { status: 'completed', ...await runAndSaveDocumentReview(documentId) };
      } catch (reviewError) {
        const store = storeOrThrow();
        const document = store.getDocument({ tenantId: DEFAULT_TENANT_ID, documentId });
        const saved = store.saveDocumentReviewResult({
          tenantId: DEFAULT_TENANT_ID,
          documentId,
          indexVersion: document?.payload?.candidateIndexVersion,
          reviewType: 'ai_pre_review',
          status: 'failed',
          errorCode: cleanText(reviewError?.code) || 'PRODUCT_DOCUMENT_PRE_REVIEW_FAILED',
          errorMessage: cleanText(reviewError?.message, 1000) || '产品资料预审失败',
          payload: { degraded: true },
        });
        preReview = {
          status: 'failed',
          degraded: true,
          code: cleanText(reviewError?.code) || 'PRODUCT_DOCUMENT_PRE_REVIEW_FAILED',
          message: cleanText(reviewError?.message, 1000) || '产品资料预审失败',
          run: saved?.run || null,
          issues: saved?.issues || [],
        };
      }
      return res.json({ ok: true, ...result, preReview });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get('/documents/:documentId/candidates', async (req, res) => {
    const session = authorize(req, res);
    if (!session) return;
    try {
      const store = storeOrThrow();
      const documentId = String(req.params.documentId || '').trim();
      if (!store.getDocument({ tenantId: DEFAULT_TENANT_ID, documentId })) {
        throw routeError('PRODUCT_DOCUMENT_NOT_FOUND', '产品资料不存在', 404);
      }
      const candidates = store.listDocumentProductLinks({ tenantId: DEFAULT_TENANT_ID, documentId });
      return res.json({ ok: true, candidates, summary: { count: candidates.length } });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.patch('/documents/:documentId/chunks/:chunkId/binding', async (req, res) => {
    const session = authorize(req, res);
    if (!session) return;
    try {
      const store = storeOrThrow();
      const documentId = String(req.params.documentId || '').trim();
      const document = store.getDocument({ tenantId: DEFAULT_TENANT_ID, documentId });
      if (!document) throw routeError('PRODUCT_DOCUMENT_NOT_FOUND', '产品资料不存在', 404);
      const action = cleanText(req.body?.action);
      const canonicalProductId = cleanText(req.body?.canonicalProductId);
      const products = bindingProductsForDocument(store, document);
      const product = products.find((item) => item.canonicalProductId === canonicalProductId);
      if (action === 'bind' && !product) {
        throw routeError('PRODUCT_CHUNK_BINDING_PRODUCT_INVALID', '请选择这份资料已经标注的产品', 400);
      }
      const chunk = store.updateCandidateChunkBinding({
        tenantId: DEFAULT_TENANT_ID,
        documentId,
        chunkId: String(req.params.chunkId || '').trim(),
        action,
        canonicalProductId: product?.canonicalProductId,
        productVersionId: product?.productVersionId,
        officialName: product?.officialName,
        reviewer: String(session.token || session.id || 'admin'),
      });
      if (!chunk) throw routeError('PRODUCT_CHUNK_NOT_FOUND', '当前候选版本中没有这个切片', 404);
      const indexReview = store.getDocumentIndexReview({ tenantId: DEFAULT_TENANT_ID, documentId });
      const publishReadiness = assessProductPublishReadiness({
        document,
        links: store.listDocumentProductLinks({ tenantId: DEFAULT_TENANT_ID, documentId }),
        chunks: indexReview?.candidateChunks || [],
      });
      return res.json({ ok: true, chunk, publishReadiness });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post('/documents/:documentId/review', async (req, res) => {
    const session = authorize(req, res);
    if (!session) return;
    try {
      const store = storeOrThrow();
      const pendingDocument = store.getDocument({ tenantId: DEFAULT_TENANT_ID, documentId: String(req.params.documentId || '').trim() });
      if (req.body?.action === 'publish' && pendingDocument) {
        const documentId = pendingDocument.id;
        const readiness = assessProductPublishReadiness({
          document: pendingDocument,
          links: store.listDocumentProductLinks({ tenantId: DEFAULT_TENANT_ID, documentId }),
          chunks: store.getDocumentIndexReview({ tenantId: DEFAULT_TENANT_ID, documentId })?.candidateChunks || [],
        });
        if (readiness.decision === 'blocked') {
          const reason = readiness.blockingReasons[0];
          const affectedCount = Number(reason?.affectedCount || 0);
          throw routeError(
            'PRODUCT_DOCUMENT_BINDING_REQUIRED',
            `${reason?.message || '产品资料必须先绑定产品才能发布'}${affectedCount ? `（影响 ${affectedCount} 个切片）` : ''}，请先修正产品绑定后再发布`,
            409,
          );
        }
      }
      if (req.body?.action === 'publish' && isResponsibilityIndicatorMaterial(pendingDocument?.payload) && (!pendingDocument?.payload?.company || !documentProductNames(pendingDocument.payload).length)) {
        throw routeError('PRODUCT_RESPONSIBILITY_MATERIAL_IDENTITY_REQUIRED', '产品责任指标补充资料必须填写保险公司和产品名称', 400);
      }
      const document = store.reviewDocument({
        tenantId: DEFAULT_TENANT_ID,
        documentId: String(req.params.documentId || '').trim(),
        action: req.body?.action,
        note: req.body?.note,
        reviewer: String(session.token || session.id || 'admin'),
      });
      if (!document) throw routeError('PRODUCT_DOCUMENT_NOT_FOUND', '产品资料不存在', 404);
      let registeredKnowledgeRecords = [];
      const productNames = documentProductNames(document.payload);
      if (req.body?.action === 'publish' && document.sourceAuthority === 'company_material' && isResponsibilityIndicatorMaterial(document.payload) && document.payload?.company && productNames.length && typeof upsertKnowledgeRecords === 'function') {
        const pages = store.listDocumentPages({ tenantId: DEFAULT_TENANT_ID, documentId: document.id });
        const links = store.listDocumentProductLinks({ tenantId: DEFAULT_TENANT_ID, documentId: document.id });
        const sourceUrl = cleanText(document.payload?.sourceUrl, 1000) || `admin-product-material://knowledge/${document.id}`;
        const records = productNames.map((productName) => {
          const scoped = pagesForProduct(pages, links, productName);
          const productUrl = productNames.length > 1 ? `${sourceUrl}${sourceUrl.includes('#') ? '&' : '#'}product=${encodeURIComponent(productName)}` : sourceUrl;
          return {
            company: document.payload.company,
            productName,
            title: document.payload.title || document.fileName,
            url: productUrl,
            sourceUrl,
            sourceType: document.extension,
            materialType: document.payload.materialType || document.documentType,
            pageText: scoped.pages.map((page) => page.rawText).filter(Boolean).join('\n\n').slice(0, 30000),
            official: false,
            sourceKind: 'admin_product_material',
            evidenceLabel: '后台审核产品资料',
            evidenceLevel: 'company_material',
            verificationStatus: scoped.boundaryMatched || productNames.length === 1 ? 'company_reviewed' : 'product_boundary_review_required',
            verificationLabel: scoped.boundaryMatched || productNames.length === 1 ? '公司资料已审核，重要责任仍需正式条款复核' : '多产品资料未确认页码边界，使用前需人工复核',
            qualityStatus: scoped.boundaryMatched || productNames.length === 1 ? 'reviewed' : 'needs_product_boundary_review',
            reviewStatus: 'approved', globalSearchable: true, parser: 'product_knowledge_upload',
            versionNo: document.payload.versionLabel || '', uploadNames: [document.fileName],
          };
        });
        const saved = upsertKnowledgeRecords(state, records, { allocateId });
        registeredKnowledgeRecords = saved;
        if (saved.length && typeof persistResponsibilityLookupArtifacts === 'function') {
          await persistResponsibilityLookupArtifacts({ knowledgeRecords: saved });
        }
      }
      return res.json({ ok: true, document, registeredKnowledgeRecord: registeredKnowledgeRecords[0] || null, registeredKnowledgeRecords });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post('/search', async (req, res) => {
    const session = authorize(req, res);
    if (!session) return;
    try {
      if (!ragService) throw routeError('PRODUCT_RAG_UNAVAILABLE', '产品知识检索服务暂不可用', 503);
      const includeQuarantined = req.body?.includeQuarantined === true;
      const evidencePackage = ragService.retrieve({
        tenantId: DEFAULT_TENANT_ID,
        query: req.body?.query,
        canonicalProductId: req.body?.canonicalProductId,
        productVersionId: req.body?.productVersionId,
        asOfDate: req.body?.asOfDate,
        products: req.body?.products,
        tokenBudget: req.body?.tokenBudget,
        includeQuarantined,
      });
      return res.json({
        ok: true,
        ...evidencePackage,
        results: evidencePackage.evidenceChunks,
      });
    } catch (error) {
      return sendError(res, error);
    }
  });

  return router;
}
