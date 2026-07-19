import crypto from 'node:crypto';

import { buildCanonicalProductId } from './canonical-product-id.mjs';

function text(value) {
  return String(value ?? '').trim();
}

function parseJson(value, fallback = {}) {
  try {
    const parsed = JSON.parse(String(value || ''));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function parseJsonValue(value, fallback = null) {
  try {
    return JSON.parse(String(value ?? ''));
  } catch {
    return fallback;
  }
}

function jsonPayload(value) {
  return JSON.stringify(value && typeof value === 'object' && !Array.isArray(value) ? value : {});
}

function documentFromRow(row, bytes) {
  if (!row) return null;
  const document = {
    id: text(row.id),
    tenantId: text(row.tenant_id),
    contentHash: text(row.content_hash),
    fileName: text(row.file_name),
    mediaType: text(row.media_type),
    extension: text(row.file_extension),
    byteSize: Number(row.byte_size || 0),
    documentType: text(row.document_type) || 'unknown',
    sourceAuthority: text(row.source_authority) || 'company_material',
    parseStatus: text(row.parse_status) || 'uploaded',
    reviewStatus: text(row.review_status) || 'quarantined',
    createdBy: text(row.created_by),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
    payload: parseJson(row.payload, {}),
  };
  if (bytes !== undefined) document.bytes = Buffer.from(bytes || []);
  return document;
}

function jobFromRow(row) {
  if (!row) return null;
  return {
    id: text(row.id),
    tenantId: text(row.tenant_id),
    documentId: text(row.document_id),
    status: text(row.status),
    currentStep: text(row.current_step),
    attemptCount: Number(row.attempt_count || 0),
    errorCode: text(row.error_code),
    errorMessage: text(row.error_message),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
    payload: parseJson(row.payload, {}),
  };
}

function pageFromRow(row) {
  if (!row) return null;
  return {
    id: text(row.id),
    tenantId: text(row.tenant_id),
    documentId: text(row.document_id),
    pageNo: Number(row.page_no || 0),
    rawText: text(row.raw_text),
    layout: parseJson(row.layout_json, {}),
    tables: (() => {
      try {
        const parsed = JSON.parse(String(row.tables_json || '[]'));
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    })(),
    ocrConfidence: row.ocr_confidence == null ? null : Number(row.ocr_confidence),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

function cleaningRunFromRow(row) {
  if (!row) return null;
  return {
    id: text(row.id),
    tenantId: text(row.tenant_id),
    documentId: text(row.document_id),
    sourceParseVersion: text(row.source_parse_version),
    cleaningVersion: text(row.cleaning_version),
    status: text(row.status),
    startedAt: text(row.started_at),
    completedAt: text(row.completed_at),
    summary: parseJson(row.summary_json, {}),
    payload: parseJson(row.payload, {}),
  };
}

function cleaningOperationFromRow(row) {
  if (!row) return null;
  return {
    id: text(row.id),
    tenantId: text(row.tenant_id),
    runId: text(row.run_id),
    documentId: text(row.document_id),
    pageNo: Number(row.page_no || 0),
    rule: text(row.rule_code),
    elementIds: parseJsonValue(row.element_ids_json, []),
    before: String(row.before_text ?? ''),
    after: String(row.after_text ?? ''),
    beforeHash: text(row.before_hash),
    afterHash: text(row.after_hash),
    decision: text(row.decision),
    createdAt: text(row.created_at),
    payload: parseJson(row.payload, {}),
  };
}

function chunkFromRow(row) {
  if (!row) return null;
  let headingPath = [];
  try {
    const parsed = JSON.parse(String(row.heading_path_json || '[]'));
    if (Array.isArray(parsed)) headingPath = parsed.map(text).filter(Boolean);
  } catch {
    headingPath = [];
  }
  return {
    id: text(row.id),
    tenantId: text(row.tenant_id),
    documentId: text(row.document_id),
    canonicalProductId: text(row.canonical_product_id),
    productVersionId: text(row.product_version_id),
    parentChunkId: text(row.parent_chunk_id),
    chunkType: text(row.chunk_type),
    headingPath,
    pageStart: Number(row.page_start || 0),
    pageEnd: Number(row.page_end || 0),
    content: text(row.content),
    contextualPrefix: text(row.contextual_prefix),
    tokenCount: Number(row.token_count || 0),
    contentHash: text(row.content_hash),
    sourceAuthority: text(row.source_authority),
    reviewStatus: text(row.review_status),
    ocrConfidence: row.ocr_confidence == null ? null : Number(row.ocr_confidence),
    embeddingVersion: text(row.embedding_version),
    indexStatus: text(row.index_status),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
    payload: parseJson(row.payload, {}),
    fileName: text(row.file_name),
    score: row.fts_score == null ? null : Number(row.fts_score),
  };
}

function linkFromRow(row) {
  if (!row) return null;
  return {
    id: text(row.id),
    tenantId: text(row.tenant_id),
    documentId: text(row.document_id),
    canonicalProductId: text(row.canonical_product_id),
    productVersionId: text(row.product_version_id),
    pageStart: Number(row.page_start || 0),
    pageEnd: Number(row.page_end || 0),
    relationType: text(row.relation_type),
    matchConfidence: row.match_confidence == null ? null : Number(row.match_confidence),
    reviewStatus: text(row.review_status),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
    payload: parseJson(row.payload, {}),
  };
}

function productFactFromRow(row) {
  if (!row) return null;
  return {
    id: text(row.id),
    tenantId: text(row.tenant_id),
    canonicalProductId: text(row.canonical_product_id),
    productVersionId: text(row.product_version_id),
    fieldKey: text(row.field_key),
    normalizedValue: parseJsonValue(row.normalized_value_json, null),
    displayValue: text(row.display_value),
    status: text(row.status),
    confidence: row.confidence == null ? null : Number(row.confidence),
    validFrom: text(row.valid_from),
    validTo: text(row.valid_to),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
    payload: parseJson(row.payload, {}),
  };
}

function productVersionFromRow(row) {
  if (!row) return null;
  return {
    id: text(row.id),
    tenantId: text(row.tenant_id),
    canonicalProductId: text(row.canonical_product_id),
    versionLabel: text(row.version_label),
    filingCode: text(row.filing_code),
    effectiveFrom: text(row.effective_from),
    effectiveTo: text(row.effective_to),
    saleStatus: text(row.sale_status) || 'unknown',
    reviewStatus: text(row.review_status) || 'pending',
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
    payload: parseJson(row.payload, {}),
  };
}

function reviewRunFromRow(row) {
  if (!row) return null;
  return {
    id: text(row.id),
    tenantId: text(row.tenant_id),
    documentId: text(row.document_id),
    indexVersion: text(row.index_version),
    reviewType: text(row.review_type),
    model: text(row.model),
    status: text(row.status),
    errorCode: text(row.error_code),
    errorMessage: text(row.error_message),
    startedAt: text(row.started_at),
    completedAt: text(row.completed_at),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
    summary: parseJson(row.summary_json, {}),
    payload: parseJson(row.payload, {}),
  };
}

function reviewIssueFromRow(row) {
  if (!row) return null;
  return {
    id: text(row.id),
    tenantId: text(row.tenant_id),
    runId: text(row.run_id),
    documentId: text(row.document_id),
    type: text(row.issue_type),
    severity: text(row.severity),
    confidence: row.confidence == null ? null : Number(row.confidence),
    reason: text(row.reason),
    status: text(row.status),
    reviewer: text(row.reviewer),
    resolution: text(row.resolution),
    pageNos: parseJsonValue(row.page_nos_json, []),
    sourceRegions: parseJsonValue(row.source_regions_json, []),
    affectedChunkIds: parseJsonValue(row.affected_chunk_ids_json, []),
    proposedOperations: parseJsonValue(row.proposed_operations_json, []),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
    payload: parseJson(row.payload, {}),
  };
}

function correctionFromRow(row) {
  if (!row) return null;
  return {
    id: text(row.id),
    tenantId: text(row.tenant_id),
    documentId: text(row.document_id),
    sourceIssueId: text(row.source_issue_id),
    indexVersion: text(row.index_version),
    appliedIndexVersion: text(row.applied_index_version),
    reasonCode: text(row.reason_code),
    note: text(row.note),
    scope: text(row.scope),
    operations: parseJsonValue(row.operations_json, []),
    status: text(row.status),
    createdBy: text(row.created_by),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
    payload: parseJson(row.payload, {}),
  };
}

export function ensureProductKnowledgeTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS product_documents (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      file_name TEXT NOT NULL,
      media_type TEXT,
      file_extension TEXT,
      byte_size INTEGER NOT NULL,
      document_type TEXT NOT NULL DEFAULT 'unknown',
      source_authority TEXT NOT NULL DEFAULT 'company_material',
      parse_status TEXT NOT NULL DEFAULT 'uploaded',
      review_status TEXT NOT NULL DEFAULT 'quarantined',
      created_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      UNIQUE (tenant_id, content_hash)
    );
    CREATE INDEX IF NOT EXISTS idx_product_documents_tenant_status
      ON product_documents(tenant_id, parse_status, review_status);

    CREATE TABLE IF NOT EXISTS product_document_blobs (
      document_id TEXT PRIMARY KEY,
      content BLOB NOT NULL,
      FOREIGN KEY (document_id) REFERENCES product_documents(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS product_ingestion_jobs (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      document_id TEXT NOT NULL,
      status TEXT NOT NULL,
      current_step TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      error_code TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY (document_id) REFERENCES product_documents(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_product_ingestion_jobs_active_document
      ON product_ingestion_jobs(document_id)
      WHERE status NOT IN ('rejected', 'cancelled');

    CREATE TABLE IF NOT EXISTS insurance_products (
      canonical_product_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      company TEXT NOT NULL,
      official_name TEXT NOT NULL,
      product_code TEXT,
      product_type TEXT,
      product_group_key TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_insurance_products_tenant_identity
      ON insurance_products(tenant_id, company, official_name);

    CREATE TABLE IF NOT EXISTS insurance_product_versions (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      canonical_product_id TEXT NOT NULL,
      version_label TEXT,
      filing_code TEXT,
      effective_from TEXT,
      effective_to TEXT,
      sale_status TEXT NOT NULL DEFAULT 'unknown',
      review_status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY (canonical_product_id) REFERENCES insurance_products(canonical_product_id)
    );
    CREATE TABLE IF NOT EXISTS product_document_links (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      document_id TEXT NOT NULL,
      canonical_product_id TEXT,
      product_version_id TEXT,
      page_start INTEGER,
      page_end INTEGER,
      relation_type TEXT NOT NULL DEFAULT 'candidate',
      match_confidence REAL,
      review_status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY (document_id) REFERENCES product_documents(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS product_document_pages (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      document_id TEXT NOT NULL,
      page_no INTEGER NOT NULL,
      raw_text TEXT NOT NULL DEFAULT '',
      layout_json TEXT NOT NULL DEFAULT '{}',
      tables_json TEXT NOT NULL DEFAULT '[]',
      ocr_confidence REAL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (document_id) REFERENCES product_documents(id) ON DELETE CASCADE,
      UNIQUE (document_id, page_no)
    );

    CREATE TABLE IF NOT EXISTS product_document_cleaning_runs (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      document_id TEXT NOT NULL,
      source_parse_version TEXT,
      cleaning_version TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      summary_json TEXT NOT NULL DEFAULT '{}',
      payload TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY (document_id) REFERENCES product_documents(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_product_document_cleaning_runs_document
      ON product_document_cleaning_runs(tenant_id, document_id, started_at);

    CREATE TABLE IF NOT EXISTS product_document_cleaning_operations (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      document_id TEXT NOT NULL,
      page_no INTEGER,
      rule_code TEXT NOT NULL,
      element_ids_json TEXT NOT NULL DEFAULT '[]',
      before_text TEXT NOT NULL DEFAULT '',
      after_text TEXT NOT NULL DEFAULT '',
      before_hash TEXT,
      after_hash TEXT,
      decision TEXT NOT NULL,
      created_at TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY (run_id) REFERENCES product_document_cleaning_runs(id) ON DELETE CASCADE,
      FOREIGN KEY (document_id) REFERENCES product_documents(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_product_document_cleaning_operations_run
      ON product_document_cleaning_operations(tenant_id, run_id, page_no);

    CREATE TABLE IF NOT EXISTS product_facts (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      canonical_product_id TEXT NOT NULL,
      product_version_id TEXT,
      field_key TEXT NOT NULL,
      normalized_value_json TEXT NOT NULL DEFAULT 'null',
      display_value TEXT,
      status TEXT NOT NULL DEFAULT 'candidate',
      confidence REAL,
      valid_from TEXT,
      valid_to TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS product_fact_evidence (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      fact_id TEXT NOT NULL,
      document_id TEXT NOT NULL,
      page_no INTEGER,
      source_text TEXT NOT NULL,
      source_authority TEXT NOT NULL,
      review_status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (fact_id) REFERENCES product_facts(id) ON DELETE CASCADE,
      FOREIGN KEY (document_id) REFERENCES product_documents(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS product_claims (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      canonical_product_id TEXT NOT NULL,
      product_version_id TEXT,
      claim_type TEXT NOT NULL,
      claim_text TEXT NOT NULL,
      comparison_scope_json TEXT NOT NULL DEFAULT '{}',
      target_customer_json TEXT NOT NULL DEFAULT '{}',
      verification_status TEXT NOT NULL DEFAULT 'candidate',
      compliance_note TEXT,
      source_document_id TEXT,
      source_page_no INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS knowledge_chunks (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      document_id TEXT NOT NULL,
      canonical_product_id TEXT,
      product_version_id TEXT,
      parent_chunk_id TEXT,
      chunk_type TEXT NOT NULL,
      heading_path_json TEXT NOT NULL DEFAULT '[]',
      page_start INTEGER,
      page_end INTEGER,
      content TEXT NOT NULL,
      contextual_prefix TEXT NOT NULL DEFAULT '',
      token_count INTEGER NOT NULL DEFAULT 0,
      content_hash TEXT NOT NULL,
      source_authority TEXT NOT NULL,
      review_status TEXT NOT NULL DEFAULT 'pending',
      valid_from TEXT,
      valid_to TEXT,
      ocr_confidence REAL,
      embedding_version TEXT,
      index_status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY (document_id) REFERENCES product_documents(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_product_version
      ON knowledge_chunks(tenant_id, canonical_product_id, product_version_id, review_status);

    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_chunks_fts USING fts5(
      chunk_id UNINDEXED,
      tenant_id UNINDEXED,
      document_id UNINDEXED,
      content,
      contextual_prefix,
      tokenize='trigram'
    );

    CREATE TABLE IF NOT EXISTS product_document_review_runs (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      document_id TEXT NOT NULL,
      index_version TEXT,
      review_type TEXT NOT NULL,
      model TEXT,
      status TEXT NOT NULL,
      error_code TEXT,
      error_message TEXT,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      summary_json TEXT NOT NULL DEFAULT '{}',
      payload TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY (document_id) REFERENCES product_documents(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_product_document_review_runs_document
      ON product_document_review_runs(tenant_id, document_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS product_document_review_issues (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      document_id TEXT NOT NULL,
      issue_type TEXT NOT NULL,
      severity TEXT NOT NULL,
      confidence REAL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      reviewer TEXT,
      resolution TEXT,
      page_nos_json TEXT NOT NULL DEFAULT '[]',
      source_regions_json TEXT NOT NULL DEFAULT '[]',
      affected_chunk_ids_json TEXT NOT NULL DEFAULT '[]',
      proposed_operations_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY (run_id) REFERENCES product_document_review_runs(id) ON DELETE CASCADE,
      FOREIGN KEY (document_id) REFERENCES product_documents(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_product_document_review_issues_document
      ON product_document_review_issues(tenant_id, document_id, status, severity);

    CREATE TABLE IF NOT EXISTS product_document_corrections (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      document_id TEXT NOT NULL,
      source_issue_id TEXT,
      index_version TEXT,
      applied_index_version TEXT,
      reason_code TEXT NOT NULL,
      note TEXT,
      scope TEXT NOT NULL DEFAULT 'current_chunk',
      operations_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'approved',
      created_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY (document_id) REFERENCES product_documents(id) ON DELETE CASCADE,
      FOREIGN KEY (source_issue_id) REFERENCES product_document_review_issues(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_product_document_corrections_document
      ON product_document_corrections(tenant_id, document_id, status, created_at);
  `);
}

export function createProductKnowledgeStore(db) {
  ensureProductKnowledgeTables(db);

  function getDocument({ tenantId, documentId, includeBytes = false } = {}) {
    const tenant = text(tenantId);
    const id = text(documentId);
    if (!tenant || !id) return null;
    const row = db.prepare(`
      SELECT *
      FROM product_documents
      WHERE tenant_id = ? AND id = ?
      LIMIT 1
    `).get(tenant, id);
    if (!row) return null;
    if (!includeBytes) return documentFromRow(row);
    const blob = db.prepare(`
      SELECT content
      FROM product_document_blobs
      WHERE document_id = ?
      LIMIT 1
    `).get(id);
    return documentFromRow(row, blob?.content);
  }

  function getIngestionJob({ tenantId, documentId = '', jobId = '' } = {}) {
    const tenant = text(tenantId);
    if (!tenant) return null;
    const resolvedJobId = text(jobId);
    const resolvedDocumentId = text(documentId);
    if (!resolvedJobId && !resolvedDocumentId) return null;
    const row = resolvedJobId
      ? db.prepare(`
          SELECT *
          FROM product_ingestion_jobs
          WHERE tenant_id = ? AND id = ?
          LIMIT 1
        `).get(tenant, resolvedJobId)
      : db.prepare(`
          SELECT *
          FROM product_ingestion_jobs
          WHERE tenant_id = ? AND document_id = ?
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        `).get(tenant, resolvedDocumentId);
    return jobFromRow(row);
  }

  function listDocuments({ tenantId, limit = 100 } = {}) {
    const tenant = text(tenantId);
    if (!tenant) return [];
    const boundedLimit = Math.max(1, Math.min(500, Math.trunc(Number(limit || 100)) || 100));
    return db.prepare(`
      SELECT *
      FROM product_documents
      WHERE tenant_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(tenant, boundedLimit).map((row) => documentFromRow(row));
  }

  function createDocumentUpload(input = {}) {
    const tenantId = text(input.tenantId);
    const contentHash = text(input.contentHash);
    const fileName = text(input.fileName);
    const bytes = Buffer.from(input.bytes || []);
    if (!tenantId || !contentHash || !fileName || !bytes.length) {
      throw new Error('Product document upload requires tenant, hash, file name, and bytes');
    }
    const now = text(input.now) || new Date().toISOString();
    let documentId = '';
    let deduplicated = false;
    db.exec('BEGIN IMMEDIATE');
    try {
      const existing = db.prepare(`
        SELECT id
        FROM product_documents
        WHERE tenant_id = ? AND content_hash = ?
        LIMIT 1
      `).get(tenantId, contentHash);
      if (existing?.id) {
        documentId = text(existing.id);
        deduplicated = true;
      } else {
        documentId = `pdoc_${crypto.randomUUID()}`;
        const jobId = `pjob_${crypto.randomUUID()}`;
        db.prepare(`
          INSERT INTO product_documents (
            id, tenant_id, content_hash, file_name, media_type, file_extension,
            byte_size, document_type, source_authority, parse_status, review_status,
            created_by, created_at, updated_at, payload
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'uploaded', 'quarantined', ?, ?, ?, ?)
        `).run(
          documentId,
          tenantId,
          contentHash,
          fileName,
          text(input.mediaType),
          text(input.extension),
          bytes.length,
          text(input.documentType) || 'unknown',
          text(input.sourceAuthority) || 'company_material',
          text(input.createdBy),
          now,
          now,
          jsonPayload(input.payload),
        );
        db.prepare(`
          INSERT INTO product_document_blobs (document_id, content)
          VALUES (?, ?)
        `).run(documentId, bytes);
        db.prepare(`
          INSERT INTO product_ingestion_jobs (
            id, tenant_id, document_id, status, current_step,
            attempt_count, created_at, updated_at, payload
          ) VALUES (?, ?, ?, 'uploaded', 'uploaded', 0, ?, ?, '{}')
        `).run(jobId, tenantId, documentId, now, now);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return {
      deduplicated,
      document: getDocument({ tenantId, documentId }),
      job: getIngestionJob({ tenantId, documentId }),
    };
  }

  function updateIngestionJob(input = {}) {
    const tenantId = text(input.tenantId);
    const jobId = text(input.jobId);
    const existing = getIngestionJob({ tenantId, jobId });
    if (!existing) return null;
    const now = text(input.now) || new Date().toISOString();
    const payload = {
      ...existing.payload,
      ...(input.payload && typeof input.payload === 'object' && !Array.isArray(input.payload) ? input.payload : {}),
    };
    db.prepare(`
      UPDATE product_ingestion_jobs
      SET status = ?,
          current_step = ?,
          attempt_count = ?,
          error_code = ?,
          error_message = ?,
          updated_at = ?,
          payload = ?
      WHERE tenant_id = ? AND id = ?
    `).run(
      text(input.status) || existing.status,
      text(input.currentStep) || existing.currentStep,
      existing.attemptCount + (input.incrementAttempt ? 1 : 0),
      Object.hasOwn(input, 'errorCode') ? text(input.errorCode) : existing.errorCode,
      Object.hasOwn(input, 'errorMessage') ? text(input.errorMessage) : existing.errorMessage,
      now,
      jsonPayload(payload),
      tenantId,
      jobId,
    );
    return getIngestionJob({ tenantId, jobId });
  }

  function updateDocumentState(input = {}) {
    const tenantId = text(input.tenantId);
    const documentId = text(input.documentId);
    const existing = getDocument({ tenantId, documentId });
    if (!existing) return null;
    const now = text(input.now) || new Date().toISOString();
    const payload = {
      ...existing.payload,
      ...(input.payload && typeof input.payload === 'object' && !Array.isArray(input.payload) ? input.payload : {}),
    };
    db.prepare(`
      UPDATE product_documents
      SET document_type = ?, parse_status = ?, review_status = ?, updated_at = ?, payload = ?
      WHERE tenant_id = ? AND id = ?
    `).run(
      text(input.documentType) || existing.documentType,
      text(input.parseStatus) || existing.parseStatus,
      text(input.reviewStatus) || existing.reviewStatus,
      now,
      jsonPayload(payload),
      tenantId,
      documentId,
    );
    return getDocument({ tenantId, documentId });
  }

  function listDocumentPageReviews({ tenantId, documentId, indexVersion = '' } = {}) {
    const document = getDocument({ tenantId, documentId });
    if (!document) return [];
    const reviews = document.payload?.pageReviews;
    return Object.values(reviews && typeof reviews === 'object' && !Array.isArray(reviews) ? reviews : {})
      .filter((review) => !text(indexVersion) || text(review?.indexVersion) === text(indexVersion))
      .sort((left, right) => Number(left?.pageNo || 0) - Number(right?.pageNo || 0));
  }

  function saveDocumentPageReview(input = {}) {
    const tenantId = text(input.tenantId);
    const documentId = text(input.documentId);
    const document = getDocument({ tenantId, documentId });
    const pageNo = Math.trunc(Number(input.pageNo || 0));
    const status = text(input.status);
    if (!document || pageNo < 1 || !['passed', 'needs_correction', 'excluded', 'pending_confirmation'].includes(status)) return null;
    const candidateIndexVersion = text(document.payload?.candidateIndexVersion);
    const indexVersion = text(input.indexVersion) || candidateIndexVersion;
    if (!indexVersion || indexVersion !== candidateIndexVersion) return null;
    const now = text(input.now) || new Date().toISOString();
    const current = document.payload?.pageReviews;
    const pageReviews = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
    const review = {
      pageNo,
      indexVersion,
      status,
      note: text(input.note).slice(0, 2000),
      reviewer: text(input.reviewer).slice(0, 200),
      reviewedAt: now,
    };
    const nextDocumentPayload = {
      ...document.payload,
      pageReviews: { ...pageReviews, [`${indexVersion}:${pageNo}`]: review },
    };
    const reviewStatusByPage = new Map(Object.values(nextDocumentPayload.pageReviews)
      .filter((item) => text(item?.indexVersion) === indexVersion)
      .map((item) => [Math.trunc(Number(item?.pageNo || 0)), text(item?.status)]));
    const candidateChunks = db.prepare(`
      SELECT * FROM knowledge_chunks
      WHERE tenant_id = ? AND document_id = ?
        AND json_extract(payload, '$.indexVersion') = ?
        AND page_start <= ? AND page_end >= ?
    `).all(tenantId, documentId, indexVersion, pageNo, pageNo);
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const chunk of candidateChunks) {
        const chunkPayload = parseJson(chunk.payload, {});
        const currentExclusion = chunkPayload.pageExclusion && typeof chunkPayload.pageExclusion === 'object'
          ? chunkPayload.pageExclusion
          : {};
        const currentPageNos = [...new Set((Array.isArray(currentExclusion.pageNos) ? currentExclusion.pageNos : [])
          .map((value) => Math.trunc(Number(value || 0))).filter((value) => value > 0))];
        const nextPageNos = status === 'excluded'
          ? [...new Set([...currentPageNos, pageNo])].sort((left, right) => left - right)
          : currentPageNos.filter((value) => value !== pageNo);
        const baseIndexStatus = text(currentExclusion.baseIndexStatus) || text(chunk.index_status) || 'ready';
        const reasons = currentExclusion.reasons && typeof currentExclusion.reasons === 'object'
          ? { ...currentExclusion.reasons }
          : {};
        if (status === 'excluded') reasons[String(pageNo)] = review.note || '人工确认本页不参与知识库检索';
        else delete reasons[String(pageNo)];
        const nextPayload = { ...chunkPayload };
        if (nextPageNos.length) {
          nextPayload.pageExclusion = {
            pageNos: nextPageNos,
            reasons,
            baseIndexStatus,
            reviewer: review.reviewer,
            updatedAt: now,
          };
        } else {
          delete nextPayload.pageExclusion;
        }
        const nextIndexStatus = nextPageNos.length ? 'blocked' : baseIndexStatus;
        const pageStart = Math.trunc(Number(chunk.page_start || 0));
        const pageEnd = Math.trunc(Number(chunk.page_end || pageStart));
        const everyCoveredPagePassed = pageStart > 0 && pageEnd >= pageStart
          && Array.from({ length: pageEnd - pageStart + 1 }, (_, offset) => pageStart + offset)
            .every((coveredPageNo) => reviewStatusByPage.get(coveredPageNo) === 'passed');
        const publishNow = text(chunk.chunk_type) !== 'parent'
          && nextIndexStatus === 'ready'
          && Boolean(text(chunk.canonical_product_id))
          && everyCoveredPagePassed;
        const nextReviewStatus = publishNow
          ? 'published'
          : text(chunk.review_status) === 'published' ? 'pending' : text(chunk.review_status) || 'pending';
        db.prepare(`
          UPDATE knowledge_chunks
          SET index_status = ?, review_status = ?, updated_at = ?, payload = ?
          WHERE id = ?
        `).run(nextIndexStatus, nextReviewStatus, now, jsonPayload(nextPayload), chunk.id);
        db.prepare('DELETE FROM knowledge_chunks_fts WHERE chunk_id = ?').run(chunk.id);
        if (text(chunk.chunk_type) !== 'parent' && nextIndexStatus !== 'blocked') {
          db.prepare(`
            INSERT INTO knowledge_chunks_fts (chunk_id, tenant_id, document_id, content, contextual_prefix)
            VALUES (?, ?, ?, ?, ?)
          `).run(chunk.id, tenantId, documentId, text(chunk.content), text(chunk.contextual_prefix));
        }
      }
      db.prepare(`
        UPDATE product_documents SET updated_at = ?, payload = ?
        WHERE tenant_id = ? AND id = ?
      `).run(now, jsonPayload(nextDocumentPayload), tenantId, documentId);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return review;
  }

  function replaceParsedArtifacts(input = {}) {
    const tenantId = text(input.tenantId);
    const documentId = text(input.documentId);
    const document = getDocument({ tenantId, documentId });
    if (!document) return null;
    const pages = Array.isArray(input.pages) ? input.pages : [];
    const chunks = Array.isArray(input.chunks) ? input.chunks : [];
    const facts = Array.isArray(input.facts) ? input.facts : [];
    const now = text(input.now) || new Date().toISOString();
    const candidateIndexVersion = text(input.indexVersion) || `idx_${crypto.randomUUID()}`;
    const previousCandidateIndexVersion = text(document.payload?.candidateIndexVersion);
    const publishedChunks = db.prepare(`
      SELECT id, payload FROM knowledge_chunks
      WHERE tenant_id = ? AND document_id = ? AND review_status = 'published'
    `).all(tenantId, documentId);
    let activeIndexVersion = text(document.payload?.activeIndexVersion);
    if (!activeIndexVersion && publishedChunks.length) activeIndexVersion = `legacy_${documentId}`;
    const chunkIdMap = new Map(chunks.map((chunk) => [text(chunk?.id), `${candidateIndexVersion}_${text(chunk?.id)}`]));
    db.exec('BEGIN IMMEDIATE');
    try {
      if (activeIndexVersion && publishedChunks.length && !text(document.payload?.activeIndexVersion)) {
        const markLegacy = db.prepare('UPDATE knowledge_chunks SET payload = ? WHERE id = ?');
        for (const row of publishedChunks) {
          markLegacy.run(jsonPayload({ ...parseJson(row.payload, {}), indexVersion: activeIndexVersion }), row.id);
        }
      }
      db.prepare(`
        DELETE FROM knowledge_chunks_fts
        WHERE chunk_id IN (
          SELECT id FROM knowledge_chunks
          WHERE tenant_id = ? AND document_id = ? AND review_status NOT IN ('published', 'superseded')
        )
      `).run(tenantId, documentId);
      db.prepare(`
        DELETE FROM knowledge_chunks
        WHERE tenant_id = ? AND document_id = ? AND review_status NOT IN ('published', 'superseded')
      `).run(tenantId, documentId);
      db.prepare('DELETE FROM product_document_pages WHERE tenant_id = ? AND document_id = ?').run(tenantId, documentId);
      if (previousCandidateIndexVersion) {
        const staleFactIds = db.prepare(`
          SELECT id FROM product_facts
          WHERE tenant_id = ?
            AND json_extract(payload, '$.documentId') = ?
            AND json_extract(payload, '$.indexVersion') = ?
        `).all(tenantId, documentId, previousCandidateIndexVersion).map((row) => row.id);
        if (staleFactIds.length) {
          const placeholders = staleFactIds.map(() => '?').join(', ');
          db.prepare(`DELETE FROM product_fact_evidence WHERE fact_id IN (${placeholders})`).run(...staleFactIds);
          db.prepare(`DELETE FROM product_facts WHERE id IN (${placeholders})`).run(...staleFactIds);
        }
      }

      const cleaning = input.cleaning && typeof input.cleaning === 'object' && !Array.isArray(input.cleaning)
        ? input.cleaning
        : null;
      if (cleaning && text(cleaning.cleaningVersion)) {
        const cleaningRunId = `pclean_${crypto.randomUUID()}`;
        const operations = Array.isArray(cleaning.operations) ? cleaning.operations : [];
        const summary = cleaning.summary && typeof cleaning.summary === 'object' && !Array.isArray(cleaning.summary)
          ? cleaning.summary
          : { operationCount: operations.length };
        db.prepare(`
          INSERT INTO product_document_cleaning_runs (
            id, tenant_id, document_id, source_parse_version, cleaning_version,
            status, started_at, completed_at, summary_json, payload
          ) VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, ?, '{}')
        `).run(
          cleaningRunId,
          tenantId,
          documentId,
          text(cleaning.sourceParseVersion),
          text(cleaning.cleaningVersion),
          now,
          now,
          jsonPayload(summary),
        );
        const insertCleaningOperation = db.prepare(`
          INSERT INTO product_document_cleaning_operations (
            id, tenant_id, run_id, document_id, page_no, rule_code,
            element_ids_json, before_text, after_text, before_hash, after_hash,
            decision, created_at, payload
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}')
        `);
        for (const operation of operations) {
          insertCleaningOperation.run(
            `pcleanop_${crypto.randomUUID()}`,
            tenantId,
            cleaningRunId,
            documentId,
            Number(operation?.pageNo || 0) || null,
            text(operation?.rule) || 'unknown',
            JSON.stringify(Array.isArray(operation?.elementIds) ? operation.elementIds.map(text).filter(Boolean) : []),
            String(operation?.before ?? ''),
            String(operation?.after ?? ''),
            text(operation?.beforeHash) || null,
            text(operation?.afterHash) || null,
            text(operation?.decision) || 'auto_applied',
            now,
          );
        }
      }

      const insertPage = db.prepare(`
        INSERT INTO product_document_pages (
          id, tenant_id, document_id, page_no, raw_text, layout_json, tables_json,
          ocr_confidence, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const page of pages) {
        const pageNo = Number(page?.pageNo || 0);
        if (!Number.isInteger(pageNo) || pageNo <= 0) throw new Error('Parsed page requires a positive page number');
        const layout = {
          ...(page?.layout && typeof page.layout === 'object' && !Array.isArray(page.layout) ? page.layout : {}),
          headings: Array.isArray(page?.headings) ? page.headings.map(text).filter(Boolean) : [],
          sourceLabel: text(page?.sourceLabel),
        };
        insertPage.run(
          `ppage_${crypto.randomUUID()}`,
          tenantId,
          documentId,
          pageNo,
          text(page?.originalRawText ?? page?.rawText),
          jsonPayload(layout),
          JSON.stringify(Array.isArray(page?.tables) ? page.tables : []),
          page?.ocrConfidence == null ? null : Number(page.ocrConfidence),
          now,
          now,
        );
      }

      const insertChunk = db.prepare(`
        INSERT INTO knowledge_chunks (
          id, tenant_id, document_id, canonical_product_id, product_version_id,
          parent_chunk_id, chunk_type, heading_path_json, page_start, page_end,
          content, contextual_prefix, token_count, content_hash, source_authority,
          review_status, valid_from, valid_to, ocr_confidence, embedding_version,
          index_status, created_at, updated_at, payload
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertFts = db.prepare(`
        INSERT INTO knowledge_chunks_fts (chunk_id, tenant_id, document_id, content, contextual_prefix)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const chunk of chunks) {
        const sourceChunkId = text(chunk?.id);
        const chunkId = chunkIdMap.get(sourceChunkId);
        const content = text(chunk?.content);
        if (!chunkId || !content) throw new Error('Knowledge chunk requires id and content');
        const chunkType = text(chunk?.chunkType) || 'child';
        const chunkPayload = chunk?.payload && typeof chunk.payload === 'object' ? chunk.payload : {};
        const semantic = chunkPayload.semantic && typeof chunkPayload.semantic === 'object'
          ? {
              ...chunkPayload.semantic,
              requiredContextChunkIds: (Array.isArray(chunkPayload.semantic.requiredContextChunkIds)
                ? chunkPayload.semantic.requiredContextChunkIds : [])
                .map((id) => chunkIdMap.get(text(id))).filter(Boolean),
            }
          : null;
        insertChunk.run(
          chunkId,
          tenantId,
          documentId,
          text(chunk?.canonicalProductId) || null,
          text(chunk?.productVersionId) || null,
          chunkIdMap.get(text(chunk?.parentChunkId)) || null,
          chunkType,
          JSON.stringify(Array.isArray(chunk?.headingPath) ? chunk.headingPath.map(text).filter(Boolean) : []),
          Number(chunk?.pageStart || 0) || null,
          Number(chunk?.pageEnd || 0) || null,
          content,
          text(chunk?.contextualPrefix),
          Number(chunk?.tokenCount || 0),
          text(chunk?.contentHash),
          text(chunk?.sourceAuthority) || document.sourceAuthority,
          text(chunk?.reviewStatus) || 'pending',
          text(chunk?.validFrom) || null,
          text(chunk?.validTo) || null,
          chunk?.ocrConfidence == null ? null : Number(chunk.ocrConfidence),
          text(chunk?.embeddingVersion) || null,
          text(chunk?.indexStatus) || 'ready',
          now,
          now,
          jsonPayload({
            ...chunkPayload,
            ...(semantic ? { semantic } : {}),
            indexVersion: candidateIndexVersion,
            sourceChunkId,
          }),
        );
        if (chunkType !== 'parent' && text(chunk?.indexStatus) !== 'blocked') {
          insertFts.run(chunkId, tenantId, documentId, content, text(chunk?.contextualPrefix));
        }
      }

      const sourceChunksById = new Map(chunks.map((chunk) => [text(chunk?.id), chunk]));
      const insertFact = db.prepare(`
        INSERT INTO product_facts (
          id, tenant_id, canonical_product_id, product_version_id, field_key,
          normalized_value_json, display_value, status, confidence, valid_from,
          valid_to, created_at, updated_at, payload
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'candidate', ?, NULL, NULL, ?, ?, ?)
      `);
      const insertFactEvidence = db.prepare(`
        INSERT INTO product_fact_evidence (
          id, tenant_id, fact_id, document_id, page_no, source_text,
          source_authority, review_status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      `);
      for (const fact of facts) {
        const canonicalProductId = text(fact?.canonicalProductId);
        const fieldKey = text(fact?.fieldKey);
        const sourceChunkIds = (Array.isArray(fact?.evidenceChunkIds) ? fact.evidenceChunkIds : [])
          .map(text).filter((id) => sourceChunksById.has(id));
        if (!canonicalProductId || !fieldKey || !sourceChunkIds.length) continue;
        const factIdentity = JSON.stringify([
          documentId, candidateIndexVersion, canonicalProductId, text(fact?.productVersionId),
          fieldKey, fact?.normalizedValue ?? null, fact?.scope || {}, sourceChunkIds,
        ]);
        const factId = `pfact_${crypto.createHash('sha256').update(factIdentity).digest('hex').slice(0, 24)}`;
        const storedChunkIds = sourceChunkIds.map((id) => chunkIdMap.get(id)).filter(Boolean);
        insertFact.run(
          factId,
          tenantId,
          canonicalProductId,
          text(fact?.productVersionId) || null,
          fieldKey,
          JSON.stringify(fact?.normalizedValue ?? null),
          text(fact?.displayValue),
          fact?.confidence == null ? null : Number(fact.confidence),
          now,
          now,
          jsonPayload({
            documentId,
            indexVersion: candidateIndexVersion,
            scope: fact?.scope || {},
            exceptions: Array.isArray(fact?.exceptions) ? fact.exceptions : [],
            completeness: text(fact?.completeness) || 'incomplete',
            evidenceChunkIds: storedChunkIds,
            extractorVersion: text(fact?.extractorVersion),
          }),
        );
        for (const sourceChunkId of sourceChunkIds) {
          const sourceChunk = sourceChunksById.get(sourceChunkId);
          insertFactEvidence.run(
            `pfev_${crypto.randomUUID()}`,
            tenantId,
            factId,
            documentId,
            Number(sourceChunk?.pageStart || 0) || null,
            text(sourceChunk?.content),
            text(sourceChunk?.sourceAuthority) || document.sourceAuthority,
            now,
            now,
          );
        }
      }

      const documentPayload = {
        ...document.payload,
        ...(input.payload && typeof input.payload === 'object' && !Array.isArray(input.payload) ? input.payload : {}),
        parsedPageCount: pages.length,
        indexedChunkCount: chunks.filter((chunk) => text(chunk?.chunkType) !== 'parent').length,
        activeIndexVersion,
        candidateIndexVersion,
      };
      db.prepare(`
        UPDATE product_documents
        SET document_type = ?, parse_status = 'indexed_pending_review', review_status = ?, updated_at = ?, payload = ?
        WHERE tenant_id = ? AND id = ?
      `).run(text(input.documentType) || document.documentType, activeIndexVersion ? 'published' : 'quarantined', now, jsonPayload(documentPayload), tenantId, documentId);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return {
      document: getDocument({ tenantId, documentId }),
      pages: listDocumentPages({ tenantId, documentId }),
      chunks: listDocumentChunks({ tenantId, documentId }),
      facts: listProductFacts({ tenantId, documentId, indexVersion: candidateIndexVersion }),
      indexVersion: candidateIndexVersion,
    };
  }

  function listDocumentPages({ tenantId, documentId } = {}) {
    return db.prepare(`
      SELECT * FROM product_document_pages
      WHERE tenant_id = ? AND document_id = ?
      ORDER BY page_no ASC
    `).all(text(tenantId), text(documentId)).map(pageFromRow);
  }

  function listDocumentCleaningRuns({ tenantId, documentId } = {}) {
    return db.prepare(`
      SELECT * FROM product_document_cleaning_runs
      WHERE tenant_id = ? AND document_id = ?
      ORDER BY started_at DESC, id DESC
    `).all(text(tenantId), text(documentId)).map(cleaningRunFromRow);
  }

  function listDocumentCleaningOperations({ tenantId, documentId, runId = '' } = {}) {
    const conditions = ['tenant_id = ?', 'document_id = ?'];
    const params = [text(tenantId), text(documentId)];
    if (text(runId)) {
      conditions.push('run_id = ?');
      params.push(text(runId));
    }
    return db.prepare(`
      SELECT * FROM product_document_cleaning_operations
      WHERE ${conditions.join(' AND ')}
      ORDER BY page_no ASC, created_at ASC, id ASC
    `).all(...params).map(cleaningOperationFromRow);
  }

  function listDocumentChunks({ tenantId, documentId, indexVersion = '' } = {}) {
    const chunks = db.prepare(`
      SELECT chunks.*, documents.file_name
      FROM knowledge_chunks chunks
      JOIN product_documents documents ON documents.id = chunks.document_id
      WHERE chunks.tenant_id = ? AND chunks.document_id = ?
      ORDER BY chunks.page_start ASC,
        CASE chunks.chunk_type WHEN 'parent' THEN 0 WHEN 'child' THEN 1 ELSE 2 END,
        chunks.id ASC
    `).all(text(tenantId), text(documentId)).map(chunkFromRow);
    const version = text(indexVersion);
    return version ? chunks.filter((chunk) => text(chunk.payload?.indexVersion) === version) : chunks;
  }

  function getDocumentIndexReview({ tenantId, documentId } = {}) {
    const document = getDocument({ tenantId, documentId });
    if (!document) return null;
    const activeIndexVersion = text(document.payload?.activeIndexVersion);
    const candidateIndexVersion = text(document.payload?.candidateIndexVersion);
    const activeChunks = activeIndexVersion ? listDocumentChunks({ tenantId, documentId, indexVersion: activeIndexVersion }) : [];
    const candidateChunks = candidateIndexVersion ? listDocumentChunks({ tenantId, documentId, indexVersion: candidateIndexVersion }) : [];
    const hashes = (rows) => new Set(rows.filter((row) => row.chunkType !== 'parent' && row.indexStatus === 'ready').map((row) => row.contentHash));
    const activeHashes = hashes(activeChunks);
    const candidateHashes = hashes(candidateChunks);
    return {
      activeIndexVersion,
      candidateIndexVersion,
      previousActiveIndexVersion: text(document.payload?.previousActiveIndexVersion),
      activeChunks,
      candidateChunks,
      diff: {
        added: [...candidateHashes].filter((hash) => !activeHashes.has(hash)).length,
        removed: [...activeHashes].filter((hash) => !candidateHashes.has(hash)).length,
        unchanged: [...candidateHashes].filter((hash) => activeHashes.has(hash)).length,
      },
    };
  }

  function getChunksByIds({ tenantId, chunkIds } = {}) {
    const ids = [...new Set((Array.isArray(chunkIds) ? chunkIds : []).map(text).filter(Boolean))];
    if (!text(tenantId) || !ids.length) return [];
    return db.prepare(`
      SELECT chunks.*, documents.file_name
      FROM knowledge_chunks chunks
      JOIN product_documents documents ON documents.id = chunks.document_id
      WHERE chunks.tenant_id = ? AND chunks.id IN (${ids.map(() => '?').join(', ')})
    `).all(text(tenantId), ...ids).map(chunkFromRow);
  }

  function updateCandidateChunkBinding(input = {}) {
    const tenantId = text(input.tenantId);
    const documentId = text(input.documentId);
    const chunkId = text(input.chunkId);
    const action = text(input.action);
    const document = getDocument({ tenantId, documentId });
    const candidateIndexVersion = text(document?.payload?.candidateIndexVersion);
    if (!document || !candidateIndexVersion) return null;
    if (!['bind', 'exclude'].includes(action)) {
      const error = new Error('切片标注动作必须是 bind 或 exclude');
      error.code = 'PRODUCT_CHUNK_BINDING_ACTION_INVALID';
      error.status = 400;
      throw error;
    }
    const chunk = db.prepare(`
      SELECT * FROM knowledge_chunks
      WHERE tenant_id = ? AND document_id = ? AND id = ?
        AND json_extract(payload, '$.indexVersion') = ?
    `).get(tenantId, documentId, chunkId, candidateIndexVersion);
    if (!chunk || text(chunk.chunk_type) === 'parent') return null;
    const currentPayload = parseJson(chunk.payload, {});
    if (action === 'bind' && text(chunk.index_status) === 'blocked' && currentPayload?.manualBinding?.action !== 'exclude') {
      const error = new Error('该切片因质量问题被隔离，不能通过产品绑定直接恢复');
      error.code = 'PRODUCT_CHUNK_QUALITY_BLOCKED';
      error.status = 409;
      throw error;
    }
    const now = text(input.now) || new Date().toISOString();
    const canonicalProductId = action === 'bind' ? text(input.canonicalProductId) : '';
    const productVersionId = action === 'bind' ? text(input.productVersionId) : '';
    const officialName = action === 'bind' ? text(input.officialName) : '';
    const prefixLines = text(chunk.contextual_prefix).split('\n')
      .filter((line) => !/^产品：/u.test(line));
    const contextualPrefix = [officialName ? `产品：${officialName}` : '', ...prefixLines].filter(Boolean).join('\n');
    const payload = {
      ...currentPayload,
      manualBinding: {
        action,
        canonicalProductId,
        officialName,
        reviewer: text(input.reviewer),
        updatedAt: now,
      },
    };
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`
        UPDATE knowledge_chunks
        SET canonical_product_id = ?, product_version_id = ?, index_status = ?,
            contextual_prefix = ?, updated_at = ?, payload = ?
        WHERE tenant_id = ? AND document_id = ? AND id = ?
      `).run(
        canonicalProductId || null,
        productVersionId || null,
        action === 'exclude' ? 'blocked' : 'ready',
        contextualPrefix,
        now,
        jsonPayload(payload),
        tenantId,
        documentId,
        chunkId,
      );
      db.prepare('DELETE FROM knowledge_chunks_fts WHERE chunk_id = ?').run(chunkId);
      if (action === 'bind') {
        db.prepare(`
          INSERT INTO knowledge_chunks_fts (chunk_id, tenant_id, document_id, content, contextual_prefix)
          VALUES (?, ?, ?, ?, ?)
        `).run(chunkId, tenantId, documentId, text(chunk.content), contextualPrefix);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return getChunksByIds({ tenantId, chunkIds: [chunkId] })[0] || null;
  }

  function saveDocumentProductLinks(input = {}) {
    const tenantId = text(input.tenantId);
    const documentId = text(input.documentId);
    if (!getDocument({ tenantId, documentId })) return [];
    const links = Array.isArray(input.links) ? input.links : [];
    const now = text(input.now) || new Date().toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('DELETE FROM product_document_links WHERE tenant_id = ? AND document_id = ?').run(tenantId, documentId);
      const insert = db.prepare(`
        INSERT INTO product_document_links (
          id, tenant_id, document_id, canonical_product_id, product_version_id,
          page_start, page_end, relation_type, match_confidence, review_status,
          created_at, updated_at, payload
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const link of links) {
        insert.run(
          `plink_${crypto.randomUUID()}`,
          tenantId,
          documentId,
          text(link?.canonicalProductId) || null,
          text(link?.productVersionId) || null,
          Number(link?.pageStart || 0) || null,
          Number(link?.pageEnd || 0) || null,
          text(link?.relationType) || 'candidate',
          link?.matchConfidence == null ? null : Number(link.matchConfidence),
          text(link?.reviewStatus) || 'pending',
          now,
          now,
          jsonPayload(link?.payload),
        );
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return listDocumentProductLinks({ tenantId, documentId });
  }

  function listDocumentProductLinks({ tenantId, documentId } = {}) {
    return db.prepare(`
      SELECT * FROM product_document_links
      WHERE tenant_id = ? AND document_id = ?
      ORDER BY page_start ASC, match_confidence DESC, id ASC
    `).all(text(tenantId), text(documentId)).map(linkFromRow);
  }

  function listProducts({ tenantId } = {}) {
    return db.prepare(`
      SELECT canonical_product_id, company, official_name, product_code, product_type, status, payload
      FROM insurance_products
      WHERE tenant_id = ?
      ORDER BY company ASC, official_name ASC
    `).all(text(tenantId)).map((row) => ({
      canonicalProductId: text(row.canonical_product_id),
      company: text(row.company),
      officialName: text(row.official_name),
      productCode: text(row.product_code),
      productType: text(row.product_type),
      status: text(row.status),
      payload: parseJson(row.payload, {}),
    }));
  }

  function listProductVersions({ tenantId, canonicalProductId } = {}) {
    const tenant = text(tenantId);
    const productId = text(canonicalProductId);
    if (!tenant || !productId) return [];
    return db.prepare(`
      SELECT *
      FROM insurance_product_versions
      WHERE tenant_id = ? AND canonical_product_id = ?
      ORDER BY effective_from ASC, version_label ASC, id ASC
    `).all(tenant, productId).map(productVersionFromRow);
  }

  function listProductFacts(input = {}) {
    const tenantId = text(input.tenantId);
    if (!tenantId) return [];
    const conditions = ['tenant_id = ?'];
    const params = [tenantId];
    if (text(input.documentId)) {
      conditions.push("json_extract(payload, '$.documentId') = ?");
      params.push(text(input.documentId));
    }
    if (text(input.indexVersion)) {
      conditions.push("json_extract(payload, '$.indexVersion') = ?");
      params.push(text(input.indexVersion));
    }
    if (text(input.canonicalProductId)) {
      conditions.push('canonical_product_id = ?');
      params.push(text(input.canonicalProductId));
    }
    if (text(input.productVersionId)) {
      conditions.push('product_version_id = ?');
      params.push(text(input.productVersionId));
    }
    const fieldKeys = [...new Set((Array.isArray(input.fieldKeys) ? input.fieldKeys : []).map(text).filter(Boolean))];
    if (fieldKeys.length) {
      conditions.push(`field_key IN (${fieldKeys.map(() => '?').join(', ')})`);
      params.push(...fieldKeys);
    }
    const statuses = [...new Set((Array.isArray(input.statuses) ? input.statuses : []).map(text).filter(Boolean))];
    if (statuses.length) {
      conditions.push(`status IN (${statuses.map(() => '?').join(', ')})`);
      params.push(...statuses);
    }
    return db.prepare(`
      SELECT * FROM product_facts
      WHERE ${conditions.join(' AND ')}
      ORDER BY field_key ASC, display_value ASC, id ASC
    `).all(...params).map(productFactFromRow);
  }

  function ensureProducts(input = {}) {
    const tenantId = text(input.tenantId);
    const company = text(input.company);
    const productNames = [...new Set((Array.isArray(input.productNames) ? input.productNames : [input.productName])
      .map(text).filter(Boolean))];
    if (!tenantId || !company || !productNames.length) return [];
    const now = text(input.now) || new Date().toISOString();
    const insert = db.prepare(`
      INSERT OR IGNORE INTO insurance_products (
        canonical_product_id, tenant_id, company, official_name, status,
        created_at, updated_at, payload
      ) VALUES (?, ?, ?, ?, 'draft', ?, ?, '{}')
    `);
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const productName of productNames) {
        insert.run(
          buildCanonicalProductId({ company, productName }),
          tenantId,
          company,
          productName,
          now,
          now,
        );
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    const placeholders = productNames.map(() => '?').join(', ');
    return db.prepare(`
      SELECT canonical_product_id, company, official_name, product_code, product_type, status, payload
      FROM insurance_products
      WHERE tenant_id = ? AND company = ? AND official_name IN (${placeholders})
      ORDER BY official_name ASC
    `).all(tenantId, company, ...productNames).map((row) => ({
      canonicalProductId: text(row.canonical_product_id),
      company: text(row.company),
      officialName: text(row.official_name),
      productCode: text(row.product_code),
      productType: text(row.product_type),
      status: text(row.status),
      payload: parseJson(row.payload, {}),
    }));
  }

  function ensureProductVersions(input = {}) {
    const tenantId = text(input.tenantId);
    const versionLabel = text(input.versionLabel);
    const products = (Array.isArray(input.products) ? input.products : [])
      .filter((product) => text(product?.canonicalProductId));
    if (!tenantId || !versionLabel || !products.length) return [];
    const now = text(input.now) || new Date().toISOString();
    const insert = db.prepare(`
      INSERT OR IGNORE INTO insurance_product_versions (
        id, tenant_id, canonical_product_id, version_label, filing_code,
        effective_from, effective_to, sale_status, review_status,
        created_at, updated_at, payload
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
    `);
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const product of products) {
        const canonicalProductId = text(product.canonicalProductId);
        const existing = db.prepare(`
          SELECT id FROM insurance_product_versions
          WHERE tenant_id = ? AND canonical_product_id = ? AND version_label = ?
          LIMIT 1
        `).get(tenantId, canonicalProductId, versionLabel);
        if (existing) continue;
        const identity = `${tenantId}\n${canonicalProductId}\n${versionLabel}`;
        const versionId = `pver_${crypto.createHash('sha256').update(identity).digest('hex').slice(0, 24)}`;
        insert.run(
          versionId,
          tenantId,
          canonicalProductId,
          versionLabel,
          text(input.filingCode) || null,
          text(input.effectiveFrom) || null,
          text(input.effectiveTo) || null,
          text(input.saleStatus) || 'unknown',
          now,
          now,
          jsonPayload(input.payload),
        );
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    const productIds = products.map((product) => text(product.canonicalProductId));
    const placeholders = productIds.map(() => '?').join(', ');
    return db.prepare(`
      SELECT * FROM insurance_product_versions
      WHERE tenant_id = ? AND version_label = ?
        AND canonical_product_id IN (${placeholders})
      ORDER BY canonical_product_id ASC, id ASC
    `).all(tenantId, versionLabel, ...productIds).map(productVersionFromRow);
  }

  function listDocumentReviewRuns({ tenantId, documentId, limit = 20 } = {}) {
    const boundedLimit = Math.max(1, Math.min(100, Math.trunc(Number(limit || 20)) || 20));
    return db.prepare(`
      SELECT * FROM product_document_review_runs
      WHERE tenant_id = ? AND document_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(text(tenantId), text(documentId), boundedLimit).map(reviewRunFromRow);
  }

  function listDocumentReviewIssues({ tenantId, documentId, runId = '', statuses = [] } = {}) {
    const conditions = ['tenant_id = ?', 'document_id = ?'];
    const params = [text(tenantId), text(documentId)];
    if (text(runId)) {
      conditions.push('run_id = ?');
      params.push(text(runId));
    }
    const normalizedStatuses = [...new Set((Array.isArray(statuses) ? statuses : []).map(text).filter(Boolean))];
    if (normalizedStatuses.length) {
      conditions.push(`status IN (${normalizedStatuses.map(() => '?').join(', ')})`);
      params.push(...normalizedStatuses);
    }
    return db.prepare(`
      SELECT * FROM product_document_review_issues
      WHERE ${conditions.join(' AND ')}
      ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
        created_at ASC, id ASC
    `).all(...params).map(reviewIssueFromRow);
  }

  function saveDocumentReviewResult(input = {}) {
    const tenantId = text(input.tenantId);
    const documentId = text(input.documentId);
    if (!getDocument({ tenantId, documentId })) return null;
    const now = text(input.now) || new Date().toISOString();
    const runId = `preview_${crypto.randomUUID()}`;
    const status = text(input.status) || 'completed';
    const issues = Array.isArray(input.issues) ? input.issues : [];
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`
        INSERT INTO product_document_review_runs (
          id, tenant_id, document_id, index_version, review_type, model, status,
          error_code, error_message, started_at, completed_at, created_at, updated_at,
          summary_json, payload
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        runId,
        tenantId,
        documentId,
        text(input.indexVersion) || null,
        text(input.reviewType) || 'ai_pre_review',
        text(input.model) || null,
        status,
        text(input.errorCode) || null,
        text(input.errorMessage) || null,
        text(input.startedAt) || now,
        status === 'completed' ? text(input.completedAt) || now : null,
        now,
        now,
        jsonPayload(input.summary),
        jsonPayload(input.payload),
      );
      const insertIssue = db.prepare(`
        INSERT INTO product_document_review_issues (
          id, tenant_id, run_id, document_id, issue_type, severity, confidence,
          reason, status, reviewer, resolution, page_nos_json, source_regions_json,
          affected_chunk_ids_json, proposed_operations_json, created_at, updated_at, payload
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const issue of issues) {
        if (!text(issue?.type) || !text(issue?.reason)) continue;
        insertIssue.run(
          `pissue_${crypto.randomUUID()}`,
          tenantId,
          runId,
          documentId,
          text(issue.type),
          text(issue.severity) || 'medium',
          issue.confidence == null ? null : Number(issue.confidence),
          text(issue.reason),
          text(issue.status) || 'open',
          text(issue.reviewer) || null,
          text(issue.resolution) || null,
          JSON.stringify(Array.isArray(issue.pageNos) ? issue.pageNos : []),
          JSON.stringify(Array.isArray(issue.sourceRegions) ? issue.sourceRegions : []),
          JSON.stringify(Array.isArray(issue.affectedChunkIds) ? issue.affectedChunkIds : []),
          JSON.stringify(Array.isArray(issue.proposedOperations) ? issue.proposedOperations : []),
          now,
          now,
          jsonPayload({ source: text(issue.source), missingElements: issue.missingElements || [] }),
        );
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return {
      run: reviewRunFromRow(db.prepare('SELECT * FROM product_document_review_runs WHERE id = ?').get(runId)),
      issues: listDocumentReviewIssues({ tenantId, documentId, runId }),
    };
  }

  function listDocumentCorrections({ tenantId, documentId, statuses = [] } = {}) {
    const conditions = ['tenant_id = ?', 'document_id = ?'];
    const params = [text(tenantId), text(documentId)];
    const normalizedStatuses = [...new Set((Array.isArray(statuses) ? statuses : []).map(text).filter(Boolean))];
    if (normalizedStatuses.length) {
      conditions.push(`status IN (${normalizedStatuses.map(() => '?').join(', ')})`);
      params.push(...normalizedStatuses);
    }
    return db.prepare(`
      SELECT * FROM product_document_corrections
      WHERE ${conditions.join(' AND ')}
      ORDER BY created_at ASC, id ASC
    `).all(...params).map(correctionFromRow);
  }

  function saveDocumentCorrection(input = {}) {
    const tenantId = text(input.tenantId);
    const documentId = text(input.documentId);
    const document = getDocument({ tenantId, documentId });
    if (!document) return null;
    const operations = Array.isArray(input.operations) ? input.operations : [];
    if (!text(input.reasonCode) || !operations.length) {
      const error = new Error('修正记录必须包含原因和至少一个操作');
      error.code = 'PRODUCT_DOCUMENT_CORRECTION_INVALID';
      error.status = 400;
      throw error;
    }
    const now = text(input.now) || new Date().toISOString();
    const correctionId = `pcorrection_${crypto.randomUUID()}`;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`
        INSERT INTO product_document_corrections (
          id, tenant_id, document_id, source_issue_id, index_version,
          reason_code, note, scope, operations_json, status, created_by,
          created_at, updated_at, payload
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        correctionId,
        tenantId,
        documentId,
        text(input.sourceIssueId) || null,
        text(input.indexVersion) || text(document.payload?.candidateIndexVersion) || null,
        text(input.reasonCode),
        text(input.note) || null,
        text(input.scope) || 'current_chunk',
        JSON.stringify(operations),
        text(input.status) || 'approved',
        text(input.createdBy) || null,
        now,
        now,
        jsonPayload(input.payload),
      );
      if (text(input.sourceIssueId)) {
        db.prepare(`
          UPDATE product_document_review_issues
          SET status = 'correction_planned', reviewer = ?, resolution = ?, updated_at = ?
          WHERE tenant_id = ? AND document_id = ? AND id = ?
        `).run(text(input.createdBy) || null, text(input.note) || null, now, tenantId, documentId, text(input.sourceIssueId));
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return correctionFromRow(db.prepare('SELECT * FROM product_document_corrections WHERE id = ?').get(correctionId));
  }

  function markDocumentCorrectionsApplied({ tenantId, documentId, correctionIds = [], indexVersion, now = '' } = {}) {
    const ids = [...new Set((Array.isArray(correctionIds) ? correctionIds : []).map(text).filter(Boolean))];
    if (!ids.length) return [];
    const updatedAt = text(now) || new Date().toISOString();
    db.prepare(`
      UPDATE product_document_corrections
      SET status = 'applied', applied_index_version = ?, updated_at = ?
      WHERE tenant_id = ? AND document_id = ? AND id IN (${ids.map(() => '?').join(', ')})
    `).run(text(indexVersion) || null, updatedAt, text(tenantId), text(documentId), ...ids);
    return listDocumentCorrections({ tenantId, documentId });
  }

  function reviewDocument(input = {}) {
    const tenantId = text(input.tenantId);
    const documentId = text(input.documentId);
    const action = text(input.action);
    const document = getDocument({ tenantId, documentId });
    if (!document) return null;
    if (!['publish', 'reject', 'rollback', 'unpublish'].includes(action)) {
      const error = new Error('审核动作必须是publish、reject、rollback或unpublish');
      error.code = 'PRODUCT_DOCUMENT_REVIEW_ACTION_INVALID';
      error.status = 400;
      throw error;
    }
    const activeIndexVersion = text(document.payload?.activeIndexVersion);
    const candidateIndexVersion = text(document.payload?.candidateIndexVersion);
    const previousActiveIndexVersion = text(document.payload?.previousActiveIndexVersion);
    if (action === 'publish') {
      if (!candidateIndexVersion) {
        const error = new Error('资料没有待发布的候选索引版本');
        error.code = 'PRODUCT_DOCUMENT_CANDIDATE_VERSION_NOT_FOUND';
        error.status = 409;
        throw error;
      }
      const count = db.prepare(`
        SELECT count(*) AS count FROM knowledge_chunks
        WHERE tenant_id = ? AND document_id = ? AND chunk_type != 'parent' AND index_status = 'ready'
          AND canonical_product_id IS NOT NULL
          AND json_extract(payload, '$.indexVersion') = ?
      `).get(tenantId, documentId, candidateIndexVersion)?.count || 0;
      if (!count) {
        const error = new Error('资料没有已绑定产品的可用切片，不能发布');
        error.code = 'PRODUCT_DOCUMENT_NOT_READY';
        error.status = 409;
        throw error;
      }
    }
    if (action === 'rollback' && !previousActiveIndexVersion) {
      const error = new Error('资料没有可回滚的上一索引版本');
      error.code = 'PRODUCT_DOCUMENT_ROLLBACK_VERSION_NOT_FOUND';
      error.status = 409;
      throw error;
    }
    if (action === 'unpublish' && !activeIndexVersion) {
      const error = new Error('资料没有正在使用的索引版本');
      error.code = 'PRODUCT_DOCUMENT_ACTIVE_VERSION_NOT_FOUND';
      error.status = 409;
      throw error;
    }
    const now = text(input.now) || new Date().toISOString();
    const targetVersion = action === 'publish' ? candidateIndexVersion : action === 'rollback' ? previousActiveIndexVersion : candidateIndexVersion;
    const nextActiveVersion = action === 'publish' ? candidateIndexVersion : action === 'rollback' ? previousActiveIndexVersion : action === 'unpublish' ? '' : activeIndexVersion;
    const reviewStatus = nextActiveVersion ? 'published' : 'rejected';
    const payload = {
      ...document.payload,
      activeIndexVersion: nextActiveVersion,
      candidateIndexVersion: action === 'reject' || action === 'publish' ? '' : text(document.payload?.candidateIndexVersion),
      previousActiveIndexVersion: action === 'publish' ? activeIndexVersion : action === 'rollback' || action === 'unpublish' ? activeIndexVersion : previousActiveIndexVersion,
      review: { action, reviewer: text(input.reviewer), reviewedAt: now, note: text(input.note) },
    };
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`
        UPDATE product_documents SET review_status = ?, updated_at = ?, payload = ?
        WHERE tenant_id = ? AND id = ?
      `).run(reviewStatus, now, jsonPayload(payload), tenantId, documentId);
      if (action === 'publish' || action === 'rollback') {
        db.prepare(`
          UPDATE knowledge_chunks SET review_status = 'superseded', updated_at = ?
          WHERE tenant_id = ? AND document_id = ? AND review_status = 'published'
        `).run(now, tenantId, documentId);
        db.prepare(`
          UPDATE knowledge_chunks
          SET review_status = CASE
            WHEN index_status = 'ready' AND canonical_product_id IS NOT NULL THEN 'published'
            ELSE 'rejected'
          END, updated_at = ?
          WHERE tenant_id = ? AND document_id = ? AND json_extract(payload, '$.indexVersion') = ?
        `).run(now, tenantId, documentId, targetVersion);
        db.prepare(`
          UPDATE product_facts SET status = 'expired', updated_at = ?
          WHERE tenant_id = ?
            AND json_extract(payload, '$.documentId') = ?
            AND status = 'confirmed'
        `).run(now, tenantId, documentId);
        if (document.sourceAuthority === 'insurer_official') {
          db.prepare(`
            UPDATE product_facts SET status = 'confirmed', updated_at = ?
            WHERE tenant_id = ?
              AND json_extract(payload, '$.documentId') = ?
              AND json_extract(payload, '$.indexVersion') = ?
              AND json_extract(payload, '$.completeness') = 'complete'
          `).run(now, tenantId, documentId, targetVersion);
        }
      } else if (action === 'unpublish') {
        db.prepare(`
          UPDATE knowledge_chunks SET review_status = 'rejected', updated_at = ?
          WHERE tenant_id = ? AND document_id = ? AND json_extract(payload, '$.indexVersion') = ?
        `).run(now, tenantId, documentId, activeIndexVersion);
        db.prepare(`
          UPDATE product_facts SET status = 'expired', updated_at = ?
          WHERE tenant_id = ?
            AND json_extract(payload, '$.documentId') = ?
            AND json_extract(payload, '$.indexVersion') = ?
            AND status = 'confirmed'
        `).run(now, tenantId, documentId, activeIndexVersion);
      } else if (candidateIndexVersion) {
        db.prepare(`
          UPDATE knowledge_chunks SET review_status = 'rejected', updated_at = ?
          WHERE tenant_id = ? AND document_id = ? AND json_extract(payload, '$.indexVersion') = ?
        `).run(now, tenantId, documentId, candidateIndexVersion);
        db.prepare(`
          UPDATE product_facts SET status = 'rejected', updated_at = ?
          WHERE tenant_id = ?
            AND json_extract(payload, '$.documentId') = ?
            AND json_extract(payload, '$.indexVersion') = ?
        `).run(now, tenantId, documentId, candidateIndexVersion);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return getDocument({ tenantId, documentId });
  }

  function searchChunks(input = {}) {
    const tenantId = text(input.tenantId);
    const query = text(input.query);
    if (!tenantId || !query) return [];
    const limit = Math.max(1, Math.min(50, Math.trunc(Number(input.limit || 10)) || 10));
    const includeQuarantined = input.includeQuarantined === true;
    const conditions = ['chunks.tenant_id = ?', "chunks.chunk_type != 'parent'", "chunks.index_status = 'ready'"];
    const params = [tenantId];
    if (!includeQuarantined) {
      conditions.push("chunks.review_status = 'published'");
    }
    if (text(input.canonicalProductId)) {
      conditions.push('chunks.canonical_product_id = ?');
      params.push(text(input.canonicalProductId));
    }
    if (text(input.productVersionId)) {
      conditions.push('chunks.product_version_id = ?');
      params.push(text(input.productVersionId));
    }
    if (text(input.asOfDate)) {
      const asOfDate = text(input.asOfDate);
      if (!/^\d{4}-\d{2}-\d{2}$/u.test(asOfDate)) {
        throw new TypeError('searchChunks asOfDate must use YYYY-MM-DD');
      }
      conditions.push("(chunks.valid_from IS NULL OR chunks.valid_from = '' OR chunks.valid_from <= ?)");
      params.push(asOfDate);
      conditions.push("(chunks.valid_to IS NULL OR chunks.valid_to = '' OR chunks.valid_to >= ?)");
      params.push(asOfDate);
    }
    const sourceAuthorities = [...new Set((Array.isArray(input.sourceAuthorities) ? input.sourceAuthorities : []).map(text).filter(Boolean))];
    if (sourceAuthorities.length) {
      conditions.push(`chunks.source_authority IN (${sourceAuthorities.map(() => '?').join(', ')})`);
      params.push(...sourceAuthorities);
    }
    const semanticKinds = [...new Set((Array.isArray(input.semanticKinds) ? input.semanticKinds : []).map(text).filter(Boolean))];
    if (semanticKinds.length) {
      conditions.push(`(
        json_extract(chunks.payload, '$.semantic.evidenceKind') IN (${semanticKinds.map(() => '?').join(', ')})
        OR json_extract(chunks.payload, '$.semantic.evidenceKind') IS NULL
      )`);
      params.push(...semanticKinds);
    }
    const factKeys = [...new Set((Array.isArray(input.factKeys) ? input.factKeys : []).map(text).filter(Boolean))];
    if (factKeys.length) {
      conditions.push(`(
        EXISTS (
          SELECT 1 FROM json_each(chunks.payload, '$.semantic.factKeys') AS fact_key
          WHERE fact_key.value IN (${factKeys.map(() => '?').join(', ')})
        )
        OR json_extract(chunks.payload, '$.semantic.factKeys') IS NULL
      )`);
      params.push(...factKeys);
    }
    if (query.length < 3) {
      conditions.push('(chunks.content LIKE ? OR chunks.contextual_prefix LIKE ?)');
      params.push(`%${query}%`, `%${query}%`, limit);
      return db.prepare(`
        SELECT chunks.*, documents.file_name, 0 AS fts_score
        FROM knowledge_chunks chunks
        JOIN product_documents documents ON documents.id = chunks.document_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY chunks.updated_at DESC, chunks.id ASC
        LIMIT ?
      `).all(...params).map(chunkFromRow);
    }
    const ftsQuery = `"${query.replace(/"/gu, '""')}"`;
    params.unshift(ftsQuery);
    params.push(limit);
    return db.prepare(`
      SELECT chunks.*, documents.file_name, bm25(knowledge_chunks_fts, 1.0, 0.35) AS fts_score
      FROM knowledge_chunks_fts
      JOIN knowledge_chunks chunks ON chunks.id = knowledge_chunks_fts.chunk_id
      JOIN product_documents documents ON documents.id = chunks.document_id
      WHERE knowledge_chunks_fts MATCH ? AND ${conditions.join(' AND ')}
      ORDER BY fts_score ASC, chunks.id ASC
      LIMIT ?
    `).all(...params).map(chunkFromRow);
  }

  return {
    createDocumentUpload,
    getDocument,
    getChunksByIds,
    getDocumentIndexReview,
    getIngestionJob,
    ensureProducts,
    ensureProductVersions,
    listDocumentCleaningOperations,
    listDocumentCleaningRuns,
    listDocumentCorrections,
    listDocumentPageReviews,
    listDocumentChunks,
    listDocumentPages,
    listDocumentProductLinks,
    listDocumentReviewIssues,
    listDocumentReviewRuns,
    listDocuments,
    listProductFacts,
    listProductVersions,
    listProducts,
    replaceParsedArtifacts,
    reviewDocument,
    saveDocumentCorrection,
    saveDocumentPageReview,
    saveDocumentReviewResult,
    saveDocumentProductLinks,
    searchChunks,
    markDocumentCorrectionsApplied,
    updateDocumentState,
    updateCandidateChunkBinding,
    updateIngestionJob,
  };
}
