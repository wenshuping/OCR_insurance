import crypto from 'node:crypto';

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

  return {
    createDocumentUpload,
    getDocument,
    getIngestionJob,
    listDocuments,
    updateIngestionJob,
  };
}
