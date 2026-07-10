import express from 'express';

import { sendError } from '../http/errors.mjs';
import { normalizeProductDocumentUpload } from '../product-document-upload.service.mjs';
import {
  catalogProductsFromState,
  createProductIngestionService,
} from '../product-ingestion.service.mjs';
import { createProductRagService } from '../product-rag.service.mjs';
import { createProductSalesAgent } from '../product-sales-agent.service.mjs';

const DEFAULT_TENANT_ID = 'default';

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
    productAgentStore,
    productAgentModelAdapter,
    productSalesAgent,
  } = context;
  const ingestionService = productIngestionService || (productKnowledgeStore
    ? createProductIngestionService({ store: productKnowledgeStore })
    : null);
  const ragService = productRagService || (productKnowledgeStore
    ? createProductRagService({ store: productKnowledgeStore })
    : null);
  const salesAgent = productSalesAgent || (productAgentStore && ragService && productAgentModelAdapter
    ? createProductSalesAgent({ agentStore: productAgentStore, ragService, modelAdapter: productAgentModelAdapter })
    : null);

  function userIdFromSession(session) {
    return String(session?.userId || session?.id || session?.token || 'admin');
  }

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

  router.post('/documents', async (req, res) => {
    const session = authorize(req, res);
    if (!session) return;
    try {
      const upload = normalizeProductDocumentUpload(req.body);
      const result = storeOrThrow().createDocumentUpload({
        tenantId: DEFAULT_TENANT_ID,
        createdBy: String(session.token || session.id || 'admin'),
        ...upload,
      });
      return res.status(result.deduplicated ? 200 : 201).json({ ok: true, ...result });
    } catch (error) {
      return sendError(res, error, 400);
    }
  });

  router.get('/documents', async (req, res) => {
    const session = authorize(req, res);
    if (!session) return;
    try {
      const documents = storeOrThrow().listDocuments({
        tenantId: DEFAULT_TENANT_ID,
        limit: req.query?.limit,
      });
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
      return res.json({
        ok: true,
        document,
        job,
        links,
        summary: { pageCount: pages.length, chunkCount: chunks.length },
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
      const document = storeOrThrow().reviewDocument({
        tenantId: DEFAULT_TENANT_ID,
        documentId: String(req.params.documentId || '').trim(),
        action: req.body?.action,
        note: req.body?.note,
        reviewer: String(session.token || session.id || 'admin'),
      });
      if (!document) throw routeError('PRODUCT_DOCUMENT_NOT_FOUND', '产品资料不存在', 404);
      return res.json({ ok: true, document });
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

  router.post('/agent/threads', async (req, res) => {
    const session = authorize(req, res);
    if (!session) return;
    try {
      if (!productAgentStore) throw routeError('PRODUCT_AGENT_STORE_UNAVAILABLE', '销售建议会话存储暂不可用', 503);
      const thread = productAgentStore.createThread({
        tenantId: DEFAULT_TENANT_ID,
        userId: userIdFromSession(session),
        customerId: req.body?.customerId,
        threadType: 'product_sales',
      });
      const taskState = productAgentStore.saveTaskState({
        tenantId: DEFAULT_TENANT_ID,
        userId: userIdFromSession(session),
        threadId: thread.id,
        candidateProducts: Array.isArray(req.body?.candidateProducts) ? req.body.candidateProducts : [],
        confirmedFacts: req.body?.confirmedFacts || {},
      });
      return res.status(201).json({ ok: true, thread, taskState });
    } catch (error) { return sendError(res, error); }
  });

  router.get('/agent/threads/:threadId', async (req, res) => {
    const session = authorize(req, res);
    if (!session) return;
    try {
      if (!productAgentStore) throw routeError('PRODUCT_AGENT_STORE_UNAVAILABLE', '销售建议会话存储暂不可用', 503);
      const scope = { tenantId: DEFAULT_TENANT_ID, userId: userIdFromSession(session), threadId: req.params.threadId };
      const thread = productAgentStore.getThread(scope);
      if (!thread) throw routeError('AGENT_THREAD_NOT_FOUND', '销售建议会话不存在', 404);
      return res.json({ ok: true, thread, taskState: productAgentStore.getTaskState(scope), messages: productAgentStore.listMessages(scope) });
    } catch (error) { return sendError(res, error); }
  });

  router.post('/agent/threads/:threadId/messages', async (req, res) => {
    const session = authorize(req, res);
    if (!session) return;
    try {
      if (!salesAgent) throw routeError('AGENT_MODEL_UNAVAILABLE', '销售建议模型暂不可用', 503);
      const result = await salesAgent.runTurn({
        tenantId: DEFAULT_TENANT_ID,
        userId: userIdFromSession(session),
        threadId: req.params.threadId,
        query: req.body?.query,
      });
      return res.json({ ok: true, ...result });
    } catch (error) { return sendError(res, error); }
  });

  return router;
}
