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
