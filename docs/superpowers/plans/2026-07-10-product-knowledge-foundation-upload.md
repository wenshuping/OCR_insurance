# Product Knowledge Foundation And Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the durable SQLite foundation and authenticated admin API for uploading company product documents without changing the existing customer-policy upload or responsibility RAG flows.

**Architecture:** Keep the current modular monolith. Add a focused product-knowledge store, an upload domain service, and a separate admin route module. Store immutable file bytes and metadata in SQLite, create an idempotent ingestion job, and leave parsing/indexing to the next implementation plan.

**Tech Stack:** Node.js ESM, Express, `node:sqlite`, `node:crypto`, Node test runner, existing admin authentication and SQLite state store.

---

## File Structure

- Create `server/product-knowledge-store.mjs`: schema, row mapping, and narrow document/job persistence methods.
- Create `server/product-document-upload.service.mjs`: upload validation, MIME/extension classification, base64 decoding, hashing, and document/job creation input.
- Create `server/routes/product-knowledge.routes.mjs`: authenticated admin upload/list/detail endpoints.
- Create `tests/product-knowledge-store.test.mjs`: schema, idempotency, BLOB, list/detail, and job tests.
- Create `tests/product-document-upload.test.mjs`: validation, decoding, format support, and duplicate hash tests.
- Create `tests/product-knowledge-routes.test.mjs`: route authentication and API behavior.
- Modify `server/sqlite-state-store.mjs`: call the focused product-knowledge schema initializer.
- Modify `server/app.mjs`: mount product knowledge admin routes.
- Modify `server/index.mjs`: no new global state; continue passing `db` into the app.
- Modify `docs/superpowers/specs/2026-07-10-product-knowledge-rag-agent-architecture.md`: keep as the governing design included on the feature branch.

## Success Criteria

- A valid admin can upload PDF, PPT/PPTX, DOC/DOCX, XLS/XLSX, TXT/MD, JPG/JPEG, or PNG bytes through JSON base64.
- Uploads larger than 16 MiB, invalid base64, empty files, and unsupported formats are rejected with stable codes.
- The raw file is durably stored as a SQLite BLOB; temporary files are not a source of truth.
- The same tenant and SHA-256 hash reuse one document and create no duplicate BLOB.
- Each new document has one `uploaded` ingestion job ready for the parser worker.
- Existing `persist(state)` does not delete product-knowledge tables.
- Product document routes require the existing admin session.
- Existing tests remain green and no production runtime is touched.

### Task 1: Product Knowledge Schema

**Files:**
- Create: `server/product-knowledge-store.mjs`
- Modify: `server/sqlite-state-store.mjs`
- Test: `tests/product-knowledge-store.test.mjs`

- [ ] **Step 1: Write the failing schema test**

Create `tests/product-knowledge-store.test.mjs` with a temporary SQLite database. Call `ensureProductKnowledgeTables(db)` twice and assert these tables exist:

```js
const expectedTables = [
  'product_documents',
  'product_document_blobs',
  'product_ingestion_jobs',
  'insurance_products',
  'insurance_product_versions',
  'product_document_links',
  'product_document_pages',
  'product_facts',
  'product_fact_evidence',
  'product_claims',
  'knowledge_chunks',
];
```

Also create a normal `createSqliteStateStore`, call `persist(state)`, and assert an inserted `product_documents` row remains. This proves the legacy full-state persistence path does not clear the new tables.

- [ ] **Step 2: Run the test and verify the missing module failure**

Run:

```bash
node --test tests/product-knowledge-store.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `server/product-knowledge-store.mjs`.

- [ ] **Step 3: Implement the schema initializer**

Create `server/product-knowledge-store.mjs` with:

```js
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
```

Import it in `server/sqlite-state-store.mjs` and call it after the existing cashflow table initializers:

```js
import { ensureProductKnowledgeTables } from './product-knowledge-store.mjs';

ensureCashflowTable(db);
ensureCashValueTable(db);
ensureProductKnowledgeTables(db);
```

- [ ] **Step 4: Run the focused schema test**

Run:

```bash
node --test tests/product-knowledge-store.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit the schema foundation**

```bash
git add server/product-knowledge-store.mjs server/sqlite-state-store.mjs tests/product-knowledge-store.test.mjs
git commit -m "feat: add product knowledge schema"
```

### Task 2: Upload Validation And Normalization

**Files:**
- Create: `server/product-document-upload.service.mjs`
- Test: `tests/product-document-upload.test.mjs`

- [ ] **Step 1: Write failing validation tests**

Cover:

```js
normalizeProductDocumentUpload({
  fileName: '产品培训.pptx',
  mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  dataBase64: Buffer.from('test deck').toString('base64'),
});
```

Assert:

- extension is `pptx`;
- bytes equal the original Buffer;
- SHA-256 is stable;
- PDF, PPT/PPTX, DOC/DOCX, XLS/XLSX, TXT/MD, JPG/JPEG and PNG are accepted;
- empty content throws `PRODUCT_DOCUMENT_EMPTY`;
- invalid base64 throws `PRODUCT_DOCUMENT_INVALID_BASE64`;
- unsupported `.exe` throws `PRODUCT_DOCUMENT_UNSUPPORTED_TYPE`;
- a byte length above `16 * 1024 * 1024` throws `PRODUCT_DOCUMENT_TOO_LARGE` with status 413.

- [ ] **Step 2: Run the test and verify it fails**

```bash
node --test tests/product-document-upload.test.mjs
```

Expected: FAIL with missing module.

- [ ] **Step 3: Implement the normalizer**

Export:

```js
export const MAX_PRODUCT_DOCUMENT_BYTES = 16 * 1024 * 1024;
export const SUPPORTED_PRODUCT_DOCUMENT_EXTENSIONS = new Set([
  'pdf', 'ppt', 'pptx', 'doc', 'docx', 'xls', 'xlsx', 'txt', 'md', 'jpg', 'jpeg', 'png',
]);

export function normalizeProductDocumentUpload(input = {}) {
  const fileName = normalizeFileName(input.fileName);
  const extension = extensionFromFileName(fileName);
  const bytes = decodeBase64(input.dataBase64);
  return {
    fileName,
    extension,
    mediaType: String(input.mediaType || '').trim() || DEFAULT_MEDIA_TYPES[extension],
    bytes,
    byteSize: bytes.length,
    contentHash: crypto.createHash('sha256').update(bytes).digest('hex'),
  };
}
```

Use a domain error helper local to the module:

```js
function uploadError(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}
```

Base64 validation must remove whitespace and require a canonical base64 alphabet with optional final padding. Do not accept `data:` URLs in this endpoint.

- [ ] **Step 4: Run focused tests**

```bash
node --test tests/product-document-upload.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit upload normalization**

```bash
git add server/product-document-upload.service.mjs tests/product-document-upload.test.mjs
git commit -m "feat: validate product document uploads"
```

### Task 3: Narrow Product Document Store

**Files:**
- Modify: `server/product-knowledge-store.mjs`
- Modify: `tests/product-knowledge-store.test.mjs`

- [ ] **Step 1: Write failing persistence tests**

Test `createProductKnowledgeStore(db)` with a normalized document input:

```js
const first = store.createDocumentUpload({
  tenantId: 'default',
  createdBy: 'admin-session',
  fileName: '产品培训.pptx',
  mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  extension: 'pptx',
  bytes: Buffer.from('test deck'),
  contentHash: createHash('sha256').update('test deck').digest('hex'),
  now: '2026-07-10T00:00:00.000Z',
});
```

Assert:

- document, blob and job rows are written in one transaction;
- status is `uploaded`, current step is `uploaded`, review status is `quarantined`;
- a second call with the same tenant/hash returns `deduplicated: true` and does not add rows;
- `listDocuments({ tenantId })` never returns BLOB bytes;
- `getDocument({ tenantId, documentId, includeBytes: true })` returns exact bytes;
- another tenant cannot read the document;
- `updateIngestionJob` changes only the target job and increments attempt count when requested.

- [ ] **Step 2: Run focused tests and verify missing exports**

```bash
node --test tests/product-knowledge-store.test.mjs
```

Expected: FAIL because `createProductKnowledgeStore` is not exported.

- [ ] **Step 3: Implement store methods**

Add:

```js
export function createProductKnowledgeStore(db) {
  ensureProductKnowledgeTables(db);
  return {
    createDocumentUpload,
    listDocuments,
    getDocument,
    getIngestionJob,
    updateIngestionJob,
  };
}
```

IDs use random UUIDs with stable prefixes:

```js
const documentId = `pdoc_${crypto.randomUUID()}`;
const jobId = `pjob_${crypto.randomUUID()}`;
```

`createDocumentUpload` must use `BEGIN IMMEDIATE`, recheck `(tenant_id, content_hash)` inside the transaction, and roll back on any failure.

- [ ] **Step 4: Run focused tests**

```bash
node --test tests/product-knowledge-store.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit the narrow store**

```bash
git add server/product-knowledge-store.mjs tests/product-knowledge-store.test.mjs
git commit -m "feat: persist product document uploads"
```

### Task 4: Authenticated Admin Product Document API

**Files:**
- Create: `server/routes/product-knowledge.routes.mjs`
- Create: `tests/product-knowledge-routes.test.mjs`

- [ ] **Step 1: Write failing route tests**

Build a small Express app with JSON parsing, a temporary database, `createProductKnowledgeStore(db)`, and an injected `requireAdmin` stub.

Cover:

- `POST /documents` returns 401 without admin;
- valid upload returns 201 with document metadata and job, never raw bytes;
- duplicate upload returns 200 with `deduplicated: true`;
- invalid upload returns the stable domain error code;
- `GET /documents` lists tenant-scoped rows;
- `GET /documents/:id` returns document and job but no bytes;
- a missing document returns `PRODUCT_DOCUMENT_NOT_FOUND` and 404.

- [ ] **Step 2: Run route tests and verify missing module**

```bash
node --test tests/product-knowledge-routes.test.mjs
```

Expected: FAIL with missing route module.

- [ ] **Step 3: Implement the route module**

Export:

```js
export function createProductKnowledgeRoutes(context = {}) {
  const router = express.Router();
  const { state, adminPassword, requireAdmin, productKnowledgeStore } = context;
  const tenantId = 'default';

  router.post('/documents', async (req, res) => {
    const session = requireAdmin(req, res, state, adminPassword);
    if (!session) return;
    try {
      const upload = normalizeProductDocumentUpload(req.body);
      const result = productKnowledgeStore.createDocumentUpload({
        tenantId,
        createdBy: String(session.token || session.id || 'admin'),
        ...upload,
      });
      res.status(result.deduplicated ? 200 : 201).json({ ok: true, ...result });
    } catch (error) {
      sendError(res, error, 400);
    }
  });

  router.get('/documents', listProductDocuments);
  router.get('/documents/:documentId', getProductDocument);
  return router;
}
```

For every handler:

1. call the existing `requireAdmin(req, res, state, adminPassword)`;
2. return immediately if unauthorized;
3. normalize domain input outside the store;
4. use `sendError` for stable status/code mapping;
5. never return BLOB bytes or base64 in list/detail responses.

- [ ] **Step 4: Run route tests**

```bash
node --test tests/product-knowledge-routes.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit routes**

```bash
git add server/routes/product-knowledge.routes.mjs tests/product-knowledge-routes.test.mjs
git commit -m "feat: add product document admin api"
```

### Task 5: Application Wiring

**Files:**
- Modify: `server/app.mjs`
- Modify: `server/index.mjs`
- Modify: `tests/product-knowledge-routes.test.mjs`

- [ ] **Step 1: Add a failing full-app route test**

Create a temporary `createSqliteStateStore`, pass its `db` into `createPolicyOcrApp`, log in through `/api/admin/login`, and upload a TXT document through:

```text
POST /api/admin/product-knowledge/documents
```

Assert the HTTP response and then query `product_documents`, `product_document_blobs`, and `product_ingestion_jobs` directly from SQLite.

- [ ] **Step 2: Run the full-app route test**

```bash
node --test tests/product-knowledge-routes.test.mjs
```

Expected: FAIL with 404 before the route is mounted.

- [ ] **Step 3: Wire store and route into the app**

In `server/app.mjs`:

```js
import { createProductKnowledgeStore } from './product-knowledge-store.mjs';
import { createProductKnowledgeRoutes } from './routes/product-knowledge.routes.mjs';
```

After `routeContext` is built:

```js
const productKnowledgeStore = options.productKnowledgeStore
  || (options.db ? createProductKnowledgeStore(options.db) : null);
```

Mount before the general admin router:

```js
app.use('/api/admin/product-knowledge', createProductKnowledgeRoutes({
  ...routeContext,
  productKnowledgeStore,
}));
app.use('/api/admin', createAdminRoutes(routeContext));
```

No route may call full-state `persist(state)` for product document writes.

`server/index.mjs` already passes `db: store.db`; retain that contract and only add an explicit `productKnowledgeStore` option if tests show it is necessary.

- [ ] **Step 4: Run focused and backend tests**

```bash
node --test tests/product-knowledge-store.test.mjs tests/product-document-upload.test.mjs tests/product-knowledge-routes.test.mjs
npm run check
npm test
```

Expected: all PASS.

- [ ] **Step 5: Commit app wiring**

```bash
git add server/app.mjs server/index.mjs tests/product-knowledge-routes.test.mjs
git commit -m "feat: wire product knowledge uploads"
```

### Task 6: Harness Mapping And Phase Handoff

**Files:**
- Modify: `docs/harness-test-map.json`
- Add: `docs/superpowers/plans/2026-07-10-product-knowledge-rag-v2.md` in the next plan-writing pass.
- Include: `docs/superpowers/specs/2026-07-10-product-knowledge-rag-agent-architecture.md`

- [ ] **Step 1: Map high-risk product knowledge files to focused tests**

Add mappings for:

```json
{
  "server/product-knowledge-store.mjs": [
    "tests/product-knowledge-store.test.mjs"
  ],
  "server/product-document-upload.service.mjs": [
    "tests/product-document-upload.test.mjs"
  ],
  "server/routes/product-knowledge.routes.mjs": [
    "tests/product-knowledge-routes.test.mjs"
  ]
}
```

Preserve the existing JSON shape and ordering convention.

- [ ] **Step 2: Run the required quality gate**

```bash
npm run harness:audit
npm run check
npm test
```

Expected: all PASS.

- [ ] **Step 3: Commit documentation and harness mapping**

```bash
git add docs/harness-test-map.json docs/superpowers/specs/2026-07-10-product-knowledge-rag-agent-architecture.md docs/superpowers/plans/2026-07-10-product-knowledge-foundation-upload.md
git commit -m "docs: define product knowledge foundation"
```

## Plan Self-Review

- Spec coverage in this plan: durable product document source, upload quarantine, tenant/hash deduplication, ingestion job foundation, product/version/fact/claim/chunk schema, admin authentication, narrow persistence, and compatibility with existing state persistence.
- Intentionally deferred to the next independent plan: Office/PDF/image parsing, OCR, product boundary detection, product resolution, fact extraction, RAG chunking, FTS/vector indexing, and review/publish UI.
- No placeholders are used for this phase; deferred work belongs to named subsequent plans rather than incomplete steps here.
- Existing customer policy upload, production database, responsibility cards, indicators, and customer summary generation remain unchanged.
