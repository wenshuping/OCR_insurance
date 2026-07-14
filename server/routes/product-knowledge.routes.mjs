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
    productRagService,
    productMaterialFetchImpl,
    upsertKnowledgeRecords,
    persistResponsibilityLookupArtifacts,
    allocateId,
    db,
  } = context;
  const ingestionService = productIngestionService || (productKnowledgeStore
    ? createProductIngestionService({ store: productKnowledgeStore })
    : null);
  const ragService = productRagService || (productKnowledgeStore
    ? createProductRagService({ store: productKnowledgeStore })
    : null);
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
      const documents = storeOrThrow().listDocuments({
        tenantId: DEFAULT_TENANT_ID,
        limit: req.query?.limit,
      }).map((document) => ({
        ...document,
        job: storeOrThrow().getIngestionJob({
          tenantId: DEFAULT_TENANT_ID,
          documentId: document.id,
        }),
        ...(String(req.query?.includeChunks || '') === 'review' ? (() => {
          const indexReview = storeOrThrow().getDocumentIndexReview({ tenantId: DEFAULT_TENANT_ID, documentId: document.id });
          return {
            indexReview: indexReview ? { ...indexReview, activeChunks: undefined, candidateChunks: undefined } : null,
            reviewChunks: indexReview?.candidateChunks?.length ? indexReview.candidateChunks : indexReview?.activeChunks || [],
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
      return res.json({ ok: true, ...result });
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
          throw routeError(
            'PRODUCT_DOCUMENT_BINDING_REQUIRED',
            readiness.blockingReasons[0]?.message || '产品资料必须先绑定产品才能发布',
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
