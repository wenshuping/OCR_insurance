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

    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_chunks_fts USING fts5(
      chunk_id UNINDEXED,
      tenant_id UNINDEXED,
      document_id UNINDEXED,
      content,
      contextual_prefix,
      tokenize='trigram'
    );
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

  function replaceParsedArtifacts(input = {}) {
    const tenantId = text(input.tenantId);
    const documentId = text(input.documentId);
    const document = getDocument({ tenantId, documentId });
    if (!document) return null;
    const pages = Array.isArray(input.pages) ? input.pages : [];
    const chunks = Array.isArray(input.chunks) ? input.chunks : [];
    const now = text(input.now) || new Date().toISOString();
    const candidateIndexVersion = text(input.indexVersion) || `idx_${crypto.randomUUID()}`;
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
          text(page?.rawText),
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
          jsonPayload({ ...(chunk?.payload || {}), indexVersion: candidateIndexVersion, sourceChunkId }),
        );
        if (chunkType !== 'parent' && text(chunk?.indexStatus) !== 'blocked') {
          insertFts.run(chunkId, tenantId, documentId, content, text(chunk?.contextualPrefix));
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
          AND json_extract(payload, '$.indexVersion') = ?
      `).get(tenantId, documentId, candidateIndexVersion)?.count || 0;
      if (!count) {
        const error = new Error('资料尚未完成解析和切片，不能发布');
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
          UPDATE knowledge_chunks SET review_status = 'published', updated_at = ?
          WHERE tenant_id = ? AND document_id = ? AND json_extract(payload, '$.indexVersion') = ?
        `).run(now, tenantId, documentId, targetVersion);
      } else if (action === 'unpublish') {
        db.prepare(`
          UPDATE knowledge_chunks SET review_status = 'rejected', updated_at = ?
          WHERE tenant_id = ? AND document_id = ? AND json_extract(payload, '$.indexVersion') = ?
        `).run(now, tenantId, documentId, activeIndexVersion);
      } else if (candidateIndexVersion) {
        db.prepare(`
          UPDATE knowledge_chunks SET review_status = 'rejected', updated_at = ?
          WHERE tenant_id = ? AND document_id = ? AND json_extract(payload, '$.indexVersion') = ?
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
    listDocumentChunks,
    listDocumentPages,
    listDocumentProductLinks,
    listDocuments,
    listProducts,
    replaceParsedArtifacts,
    reviewDocument,
    saveDocumentProductLinks,
    searchChunks,
    updateDocumentState,
    updateIngestionJob,
  };
}
