import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createInitialState } from './policy-ocr.domain.mjs';
import { ensureCashflowTable, ensureCashValueTable } from './cashflow-store.mjs';
import { normalizeKnowledgeRecord } from './policy-knowledge.service.mjs';

const SCHEMA_VERSION = '3';

const DB_OWNED_KEYS = new Set([
  'users',
  'sessions',
  'adminSessions',
  'smsCodes',
  'policies',
  'pendingScans',
  'sourceRecords',
  'knowledgeRecords',
  'insuranceIndicatorRecords',
  'optionalResponsibilityRecords',
  'productCustomerResponsibilitySummaries',
  'productCustomerSummaryGenerationRuns',
  'policyDerivedResults',
  'productIndicatorVersions',
  'indicatorUpdateBatches',
  'officialDomainProfiles',
  'familyProfiles',
  'familyMembers',
  'familyReports',
  'familyReportIssues',
  'familyReportCorrections',
  'familyReportShares',
  'familySalesReviews',
  'familySalesChatThreads',
  'familySalesChatMessages',
  'familySalesMemories',
  'reportRefreshEvents',
  'membershipConfig',
  'membershipOrders',
  'memberships',
  'userWechatIdentities',
  'wechatOAuthStates',
  'userDingtalkIdentities',
  'dingtalkBindingChallenges',
  'agentPolicyImportTasks',
  'nextId',
]);

const RESERVED_STATE_KEYS = new Set(['nextId']);

function parseJson(value, fallback) {
  try {
    return JSON.parse(String(value || ''));
  } catch {
    return fallback;
  }
}

async function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeStringArray(value) {
  const seen = new Set();
  const result = [];
  for (const item of normalizeArray(value)) {
    const text = String(item || '').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
}

function normalizeJsonStringArray(value) {
  return normalizeStringArray(typeof value === 'string' ? parseJson(value, []) : value);
}

function normalizeCustomerSummaryJson(value) {
  const parsed = typeof value === 'string' ? parseJson(value, {}) : value;
  const row = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  const contentBlocks = normalizeArray(row.contentBlocks || row.content_blocks)
    .map((block) => ({
      blockKey: String(block?.blockKey || block?.block_key || '').trim(),
      title: String(block?.title || '').trim(),
      enabled: block?.enabled !== false,
      editable: block?.editable !== false,
      order: Number.isFinite(Number(block?.order)) ? Number(block.order) : 0,
      content: String(block?.content || '').trim(),
    }))
    .filter((block) => block.blockKey || block.title || block.content);
  return {
    company: String(row.company || '').trim(),
    productName: String(row.productName || row.product_name || '').trim(),
    headline: String(row.headline || '').trim(),
    mainResponsibilities: normalizeArray(row.mainResponsibilities || row.main_responsibilities)
      .map((item) => ({
        title: String(item?.title || '').trim(),
        plainText: String(item?.plainText || item?.plain_text || '').trim(),
        triggerCondition: String(item?.triggerCondition || item?.trigger_condition || '').trim(),
        howItPays: String(item?.howItPays || item?.how_it_pays || '').trim(),
        calculationStatus: String(item?.calculationStatus || item?.calculation_status || '').trim(),
        requiredPolicyFields: normalizeStringArray(item?.requiredPolicyFields || item?.required_policy_fields),
        sourceRefs: normalizeStringArray(item?.sourceRefs || item?.source_refs),
      }))
      .filter((item) => item.title || item.plainText || item.triggerCondition || item.howItPays || item.calculationStatus || item.requiredPolicyFields.length || item.sourceRefs.length),
    notices: normalizeStringArray(row.notices),
    requiredPolicyFields: normalizeStringArray(row.requiredPolicyFields || row.required_policy_fields),
    sourceUrls: normalizeStringArray(row.sourceUrls || row.source_urls),
    contentBlocks,
  };
}

function hasCustomerSummaryContent(summaryJson = {}) {
  return Boolean(
    String(summaryJson.headline || '').trim()
      || normalizeArray(summaryJson.mainResponsibilities).some((item) =>
        String(item?.title || '').trim()
          || String(item?.plainText || '').trim()
          || String(item?.howItPays || '').trim(),
      )
      || normalizeArray(summaryJson.contentBlocks).some((block) =>
        String(block?.title || '').trim() || String(block?.content || '').trim(),
      ),
  );
}

function maxNumericId(rows) {
  return normalizeArray(rows).reduce((max, row) => {
    const id = Number(row?.id || 0);
    return Number.isFinite(id) ? Math.max(max, id) : max;
  }, 0);
}

function resolveNextId(state) {
  const maxId = Math.max(
    maxNumericId(state.users),
    maxNumericId(state.smsCodes),
    maxNumericId(state.policies),
    maxNumericId(state.sourceRecords),
    maxNumericId(state.knowledgeRecords),
    maxNumericId(state.familyProfiles),
    maxNumericId(state.familyMembers),
    maxNumericId(state.familyReports),
    maxNumericId(state.familyReportIssues),
    maxNumericId(state.familyReportCorrections),
    maxNumericId(state.familyReportShares),
    maxNumericId(state.familySalesReviews),
    maxNumericId(state.familySalesChatThreads),
    maxNumericId(state.familySalesChatMessages),
    maxNumericId(state.familySalesMemories),
    maxNumericId(state.reportRefreshEvents),
    maxNumericId(state.membershipOrders),
  );
  return Math.max(Number(state.nextId || 1), maxId + 1, 1);
}

function jsonPayload(value) {
  return JSON.stringify(value || {});
}

function normalizePolicyDerivedResult(row = {}) {
  const policyId = Number(row.policyId || row.policy_id || 0);
  if (!Number.isFinite(policyId) || policyId <= 0) return null;
  return {
    ...row,
    policyId,
    productKeys: normalizeStringArray(row.productKeys || row.product_keys),
    coverageIndicators: normalizeArray(row.coverageIndicators),
    optionalResponsibilities: normalizeArray(row.optionalResponsibilities),
    responsibilityCards: normalizeArray(row.responsibilityCards),
    indicatorVersions: row.indicatorVersions && typeof row.indicatorVersions === 'object' && !Array.isArray(row.indicatorVersions)
      ? row.indicatorVersions
      : {},
    knowledgeVersion: Number(row.knowledgeVersion || 0) || 0,
    status: String(row.status || 'ready'),
    staleReason: String(row.staleReason || row.stale_reason || ''),
    generatedAt: String(row.generatedAt || row.generated_at || ''),
    updatedAt: String(row.updatedAt || row.updated_at || ''),
    error: String(row.error || ''),
  };
}

function normalizeProductIndicatorVersion(row = {}) {
  const productKey = String(row.productKey || row.product_key || '').trim();
  if (!productKey) return null;
  return {
    ...row,
    productKey,
    version: Math.max(0, Number(row.version || 0) || 0),
    batchId: String(row.batchId || row.batch_id || ''),
    updatedAt: String(row.updatedAt || row.updated_at || ''),
  };
}

function normalizeIndicatorUpdateBatch(row = {}) {
  const id = String(row.id || '').trim();
  if (!id) return null;
  const productKeys = normalizeStringArray(row.productKeys || row.product_keys);
  return {
    ...row,
    id,
    productKeys,
    changedProductKeyCount: Number(row.changedProductKeyCount ?? row.changed_product_key_count ?? productKeys.length) || 0,
    affectedPolicyCount: Number(row.affectedPolicyCount ?? row.affected_policy_count ?? 0) || 0,
    createdAt: String(row.createdAt || row.created_at || ''),
  };
}

function normalizeProductCustomerResponsibilitySummary(row = {}) {
  const parsedPayload = typeof row.payload === 'string' ? parseJson(row.payload, {}) : row.payload;
  const payload = parsedPayload && typeof parsedPayload === 'object' && !Array.isArray(parsedPayload) ? parsedPayload : {};
  const source = { ...payload, ...row };
  const productKey = String(source.productKey || source.product_key || '').trim();
  const summaryVersion = String(source.summaryVersion || source.summary_version || '').trim();
  if (!productKey || !summaryVersion) return null;
  const summaryJson = normalizeCustomerSummaryJson(source.summaryJson || source.summary_json);
  const sourceUrls = normalizeStringArray(source.sourceUrls || source.source_urls);
  const dbSourceUrls = normalizeJsonStringArray(source.source_urls_json);
  const normalizedSourceUrls = sourceUrls.length ? sourceUrls : dbSourceUrls.length ? dbSourceUrls : summaryJson.sourceUrls;
  const id = String(source.id || '').trim() || `customer_summary:${productKey}:${summaryVersion}`;
  return {
    id,
    productKey,
    company: String(source.company || '').trim(),
    productName: String(source.productName || source.product_name || '').trim(),
    summaryVersion,
    status: String(source.status || '').trim(),
    headline: String(source.headline || summaryJson.headline || '').trim(),
    summaryJson,
    sourceUrls: normalizedSourceUrls,
    sourceDigest: String(source.sourceDigest || source.source_digest || '').trim(),
    modelProvider: String(source.modelProvider || source.model_provider || '').trim(),
    modelName: String(source.modelName || source.model_name || '').trim(),
    generatedAt: String(source.generatedAt || source.generated_at || '').trim(),
    updatedAt: String(source.updatedAt || source.updated_at || '').trim(),
    payload: payload && Object.keys(payload).length ? payload : {},
  };
}

function normalizeProductCustomerSummaryGenerationRun(row = {}) {
  const parsedPayload = typeof row.payload === 'string' ? parseJson(row.payload, {}) : row.payload;
  const payload = parsedPayload && typeof parsedPayload === 'object' && !Array.isArray(parsedPayload) ? parsedPayload : {};
  const source = { ...payload, ...row };
  const productKey = String(source.product_key || source.productKey || '').trim();
  const summaryVersion = String(source.summary_version || source.summaryVersion || '').trim();
  const id = String(source.id || '').trim();
  if (!id || !productKey || !summaryVersion) return null;
  const preservedPayload = payload.payload && typeof payload.payload === 'object' && !Array.isArray(payload.payload)
    ? payload.payload
    : payload;
  const qualityIssues = row.quality_issues_json !== undefined
    ? normalizeArray(parseJson(row.quality_issues_json, []))
    : normalizeArray(source.qualityIssues || source.quality_issues || parseJson(source.quality_issues_json, []));
  return {
    id,
    productKey,
    company: String(source.company || '').trim(),
    productName: String(source.product_name || source.productName || '').trim(),
    summaryVersion,
    status: String(source.status || '').trim() || 'failed',
    productCategory: String(source.product_category || source.productCategory || '').trim(),
    categoryLabel: String(source.category_label || source.categoryLabel || '').trim(),
    modelProvider: String(source.model_provider || source.modelProvider || '').trim(),
    modelName: String(source.model_name || source.modelName || '').trim(),
    modelTier: String(source.model_tier || source.modelTier || '').trim(),
    sourceDigest: String(source.source_digest || source.sourceDigest || '').trim(),
    sourceSectionsDigest: String(source.source_sections_digest || source.sourceSectionsDigest || '').trim(),
    qualityIssues,
    rawPreview: String(source.raw_preview || source.rawPreview || '').trim(),
    createdAt: String(source.created_at || source.createdAt || '').trim(),
    payload: preservedPayload,
  };
}

function getMeta(db, key) {
  return db.prepare('SELECT value FROM app_meta WHERE key = ?').get(key)?.value || '';
}

function setMeta(db, key, value) {
  db.prepare(`
    INSERT INTO app_meta (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value ?? ''));
}

function createSchema(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      mobile TEXT NOT NULL,
      created_at TEXT,
      updated_at TEXT,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_users_mobile ON users(mobile);

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER,
      created_at TEXT,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);

    CREATE TABLE IF NOT EXISTS admin_sessions (
      token TEXT PRIMARY KEY,
      expires_at TEXT,
      payload TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sms_codes (
      id INTEGER PRIMARY KEY,
      mobile TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT,
      created_at TEXT,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sms_codes_mobile ON sms_codes(mobile);

    CREATE TABLE IF NOT EXISTS policies (
      id INTEGER PRIMARY KEY,
      user_id INTEGER,
      guest_id TEXT,
      company TEXT,
      name TEXT,
      insured TEXT,
      created_at TEXT,
      updated_at TEXT,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_policies_user_id ON policies(user_id);
    CREATE INDEX IF NOT EXISTS idx_policies_guest_id ON policies(guest_id);

    CREATE TABLE IF NOT EXISTS pending_scans (
      row_id INTEGER PRIMARY KEY AUTOINCREMENT,
      guest_id TEXT NOT NULL,
      created_at TEXT,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pending_scans_guest_id ON pending_scans(guest_id);

    CREATE TABLE IF NOT EXISTS source_records (
      id INTEGER PRIMARY KEY,
      policy_id INTEGER,
      company TEXT,
      product_name TEXT,
      url TEXT,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_source_records_policy_id ON source_records(policy_id);
    CREATE INDEX IF NOT EXISTS idx_source_records_url ON source_records(url);

    CREATE TABLE IF NOT EXISTS knowledge_records (
      id INTEGER PRIMARY KEY,
      company TEXT,
      product_name TEXT,
      url TEXT,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_knowledge_records_company ON knowledge_records(company);
    CREATE INDEX IF NOT EXISTS idx_knowledge_records_product_name ON knowledge_records(product_name);
    CREATE INDEX IF NOT EXISTS idx_knowledge_records_url ON knowledge_records(url);

    CREATE TABLE IF NOT EXISTS insurance_indicator_records (
      id TEXT PRIMARY KEY,
      company TEXT,
      product_name TEXT,
      coverage_type TEXT,
      liability TEXT,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_insurance_indicator_records_company ON insurance_indicator_records(company);
    CREATE INDEX IF NOT EXISTS idx_insurance_indicator_records_product_name ON insurance_indicator_records(product_name);

    CREATE TABLE IF NOT EXISTS optional_responsibility_records (
      id TEXT PRIMARY KEY,
      company TEXT,
      product_name TEXT,
      liability TEXT,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_optional_responsibility_records_company ON optional_responsibility_records(company);
    CREATE INDEX IF NOT EXISTS idx_optional_responsibility_records_product_name ON optional_responsibility_records(product_name);

    CREATE TABLE IF NOT EXISTS product_responsibility_cards (
      id TEXT PRIMARY KEY,
      product_key TEXT NOT NULL,
      company TEXT,
      product_name TEXT,
      title TEXT,
      category TEXT,
      cashflow_treatment TEXT,
      calculation_status TEXT,
      calculation_reason TEXT,
      responsibility_scope TEXT,
      selection_status TEXT,
      source_url TEXT,
      generated_at TEXT,
      updated_at TEXT,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_product_responsibility_cards_product_key ON product_responsibility_cards(product_key);
    CREATE INDEX IF NOT EXISTS idx_product_responsibility_cards_company_product ON product_responsibility_cards(company, product_name);
    CREATE INDEX IF NOT EXISTS idx_product_responsibility_cards_status ON product_responsibility_cards(calculation_status);

    CREATE TABLE IF NOT EXISTS product_customer_responsibility_summaries (
      id TEXT PRIMARY KEY,
      product_key TEXT NOT NULL,
      company TEXT,
      product_name TEXT,
      summary_version TEXT NOT NULL,
      status TEXT NOT NULL,
      headline TEXT,
      summary_json TEXT NOT NULL,
      source_urls_json TEXT NOT NULL DEFAULT '[]',
      source_digest TEXT,
      model_provider TEXT,
      model_name TEXT,
      generated_at TEXT,
      updated_at TEXT,
      payload TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_product_customer_responsibility_summaries_product_version
      ON product_customer_responsibility_summaries(product_key, summary_version);
    CREATE INDEX IF NOT EXISTS idx_product_customer_responsibility_summaries_company_product
      ON product_customer_responsibility_summaries(company, product_name);
    CREATE INDEX IF NOT EXISTS idx_product_customer_responsibility_summaries_status
      ON product_customer_responsibility_summaries(status);

    CREATE TABLE IF NOT EXISTS product_customer_summary_generation_runs (
      id TEXT PRIMARY KEY,
      product_key TEXT NOT NULL,
      company TEXT,
      product_name TEXT,
      summary_version TEXT NOT NULL,
      status TEXT NOT NULL,
      product_category TEXT,
      category_label TEXT,
      model_provider TEXT,
      model_name TEXT,
      model_tier TEXT,
      source_digest TEXT,
      source_sections_digest TEXT,
      quality_issues_json TEXT NOT NULL DEFAULT '[]',
      raw_preview TEXT,
      created_at TEXT,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_product_customer_summary_generation_runs_product_version
      ON product_customer_summary_generation_runs(product_key, summary_version);
    CREATE INDEX IF NOT EXISTS idx_product_customer_summary_generation_runs_status
      ON product_customer_summary_generation_runs(status);

    CREATE TABLE IF NOT EXISTS policy_derived_results (
      policy_id INTEGER PRIMARY KEY,
      product_keys TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'ready',
      stale_reason TEXT,
      generated_at TEXT,
      updated_at TEXT,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_policy_derived_results_status ON policy_derived_results(status);

    CREATE TABLE IF NOT EXISTS product_indicator_versions (
      product_key TEXT PRIMARY KEY,
      version INTEGER NOT NULL DEFAULT 0,
      batch_id TEXT,
      updated_at TEXT,
      payload TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS indicator_update_batches (
      id TEXT PRIMARY KEY,
      created_at TEXT,
      product_keys TEXT NOT NULL DEFAULT '[]',
      changed_product_key_count INTEGER NOT NULL DEFAULT 0,
      affected_policy_count INTEGER NOT NULL DEFAULT 0,
      payload TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS official_domain_profiles (
      id TEXT PRIMARY KEY,
      payload TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS family_profiles (
      id INTEGER PRIMARY KEY,
      owner_user_id INTEGER,
      owner_guest_id TEXT,
      family_name TEXT,
      core_member_id INTEGER,
      status TEXT,
      created_at TEXT,
      updated_at TEXT,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_family_profiles_owner_user_id ON family_profiles(owner_user_id);
    CREATE INDEX IF NOT EXISTS idx_family_profiles_owner_guest_id ON family_profiles(owner_guest_id);

    CREATE TABLE IF NOT EXISTS family_members (
      id INTEGER PRIMARY KEY,
      family_id INTEGER,
      name TEXT,
      relation_to_core TEXT,
      status TEXT,
      created_at TEXT,
      updated_at TEXT,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_family_members_family_id ON family_members(family_id);
    CREATE INDEX IF NOT EXISTS idx_family_members_name ON family_members(name);

    CREATE TABLE IF NOT EXISTS family_reports (
      id INTEGER PRIMARY KEY,
      family_id INTEGER,
      owner_user_id INTEGER,
      owner_guest_id TEXT,
      status TEXT,
      source TEXT,
      generated_at TEXT,
      created_at TEXT,
      updated_at TEXT,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_family_reports_family_id ON family_reports(family_id);
    CREATE INDEX IF NOT EXISTS idx_family_reports_owner_user_id ON family_reports(owner_user_id);
    CREATE INDEX IF NOT EXISTS idx_family_reports_owner_guest_id ON family_reports(owner_guest_id);
    CREATE INDEX IF NOT EXISTS idx_family_reports_status ON family_reports(status);
    CREATE INDEX IF NOT EXISTS idx_family_reports_generated_at ON family_reports(generated_at);

    CREATE TABLE IF NOT EXISTS family_report_issues (
      id INTEGER PRIMARY KEY,
      report_id INTEGER,
      family_id INTEGER,
      owner_user_id INTEGER,
      owner_guest_id TEXT,
      severity TEXT,
      category TEXT,
      status TEXT,
      source TEXT,
      created_at TEXT,
      updated_at TEXT,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_family_report_issues_report_id ON family_report_issues(report_id);
    CREATE INDEX IF NOT EXISTS idx_family_report_issues_family_id ON family_report_issues(family_id);
    CREATE INDEX IF NOT EXISTS idx_family_report_issues_status ON family_report_issues(status);
    CREATE INDEX IF NOT EXISTS idx_family_report_issues_severity ON family_report_issues(severity);

    CREATE TABLE IF NOT EXISTS family_report_corrections (
      id INTEGER PRIMARY KEY,
      report_id INTEGER,
      family_id INTEGER,
      owner_user_id INTEGER,
      owner_guest_id TEXT,
      policy_id INTEGER,
      member_id INTEGER,
      dimension TEXT,
      action TEXT,
      status TEXT,
      source TEXT,
      issue_id INTEGER,
      created_at TEXT,
      updated_at TEXT,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_family_report_corrections_report_id ON family_report_corrections(report_id);
    CREATE INDEX IF NOT EXISTS idx_family_report_corrections_family_id ON family_report_corrections(family_id);
    CREATE INDEX IF NOT EXISTS idx_family_report_corrections_status ON family_report_corrections(status);
    CREATE INDEX IF NOT EXISTS idx_family_report_corrections_issue_id ON family_report_corrections(issue_id);

    CREATE TABLE IF NOT EXISTS family_report_shares (
      id INTEGER PRIMARY KEY,
      family_id INTEGER,
      owner_user_id INTEGER,
      owner_guest_id TEXT,
      token TEXT,
      status TEXT,
      created_at TEXT,
      updated_at TEXT,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_family_report_shares_family_id ON family_report_shares(family_id);
    CREATE INDEX IF NOT EXISTS idx_family_report_shares_owner_user_id ON family_report_shares(owner_user_id);
    CREATE INDEX IF NOT EXISTS idx_family_report_shares_owner_guest_id ON family_report_shares(owner_guest_id);
    CREATE INDEX IF NOT EXISTS idx_family_report_shares_token ON family_report_shares(token);

    CREATE TABLE IF NOT EXISTS family_sales_reviews (
      id INTEGER PRIMARY KEY,
      family_id INTEGER,
      owner_user_id INTEGER,
      owner_guest_id TEXT,
      status TEXT,
      generated_at TEXT,
      created_at TEXT,
      updated_at TEXT,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_family_sales_reviews_family_id ON family_sales_reviews(family_id);
    CREATE INDEX IF NOT EXISTS idx_family_sales_reviews_owner_user_id ON family_sales_reviews(owner_user_id);
    CREATE INDEX IF NOT EXISTS idx_family_sales_reviews_owner_guest_id ON family_sales_reviews(owner_guest_id);
    CREATE INDEX IF NOT EXISTS idx_family_sales_reviews_generated_at ON family_sales_reviews(generated_at);

    CREATE TABLE IF NOT EXISTS family_sales_chat_threads (
      id INTEGER PRIMARY KEY,
      family_id INTEGER,
      owner_user_id INTEGER,
      owner_guest_id TEXT,
      status TEXT,
      title TEXT,
      created_at TEXT,
      updated_at TEXT,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_family_sales_chat_threads_family_id ON family_sales_chat_threads(family_id);
    CREATE INDEX IF NOT EXISTS idx_family_sales_chat_threads_owner_user_id ON family_sales_chat_threads(owner_user_id);
    CREATE INDEX IF NOT EXISTS idx_family_sales_chat_threads_owner_guest_id ON family_sales_chat_threads(owner_guest_id);
    CREATE INDEX IF NOT EXISTS idx_family_sales_chat_threads_updated_at ON family_sales_chat_threads(updated_at);

    CREATE TABLE IF NOT EXISTS family_sales_chat_messages (
      id INTEGER PRIMARY KEY,
      thread_id INTEGER,
      family_id INTEGER,
      role TEXT,
      created_at TEXT,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_family_sales_chat_messages_thread_id ON family_sales_chat_messages(thread_id);
    CREATE INDEX IF NOT EXISTS idx_family_sales_chat_messages_family_id ON family_sales_chat_messages(family_id);
    CREATE INDEX IF NOT EXISTS idx_family_sales_chat_messages_created_at ON family_sales_chat_messages(created_at);

    CREATE TABLE IF NOT EXISTS family_sales_memories (
      id INTEGER PRIMARY KEY,
      family_id INTEGER,
      owner_user_id INTEGER,
      owner_guest_id TEXT,
      kind TEXT,
      status TEXT,
      source_thread_id INTEGER,
      created_at TEXT,
      updated_at TEXT,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_family_sales_memories_family_id ON family_sales_memories(family_id);
    CREATE INDEX IF NOT EXISTS idx_family_sales_memories_owner_user_id ON family_sales_memories(owner_user_id);
    CREATE INDEX IF NOT EXISTS idx_family_sales_memories_owner_guest_id ON family_sales_memories(owner_guest_id);
    CREATE INDEX IF NOT EXISTS idx_family_sales_memories_updated_at ON family_sales_memories(updated_at);

    CREATE TABLE IF NOT EXISTS report_refresh_events (
      id INTEGER PRIMARY KEY,
      kind TEXT,
      family_id INTEGER,
      report_id INTEGER,
      owner_user_id INTEGER,
      owner_guest_id TEXT,
      created_at TEXT,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_report_refresh_events_kind ON report_refresh_events(kind);
    CREATE INDEX IF NOT EXISTS idx_report_refresh_events_family_id ON report_refresh_events(family_id);
    CREATE INDEX IF NOT EXISTS idx_report_refresh_events_owner_user_id ON report_refresh_events(owner_user_id);
    CREATE INDEX IF NOT EXISTS idx_report_refresh_events_owner_guest_id ON report_refresh_events(owner_guest_id);
    CREATE INDEX IF NOT EXISTS idx_report_refresh_events_created_at ON report_refresh_events(created_at);

    CREATE TABLE IF NOT EXISTS membership_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      payload TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS membership_orders (
      id INTEGER PRIMARY KEY,
      out_trade_no TEXT NOT NULL,
      user_id INTEGER,
      status TEXT,
      created_at TEXT,
      updated_at TEXT,
      payload TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_membership_orders_out_trade_no ON membership_orders(out_trade_no);
    CREATE INDEX IF NOT EXISTS idx_membership_orders_user_id ON membership_orders(user_id);

    CREATE TABLE IF NOT EXISTS memberships (
      user_id INTEGER PRIMARY KEY,
      status TEXT,
      expires_at TEXT,
      updated_at TEXT,
      payload TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_wechat_identities (
      user_id INTEGER,
      app_id TEXT,
      openid TEXT,
      updated_at TEXT,
      payload TEXT NOT NULL,
      PRIMARY KEY (user_id, app_id)
    );

    CREATE TABLE IF NOT EXISTS wechat_oauth_states (
      state TEXT PRIMARY KEY,
      user_id INTEGER,
      app_id TEXT,
      expires_at TEXT,
      used_at TEXT,
      created_at TEXT,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_wechat_oauth_states_user_id ON wechat_oauth_states(user_id);

    CREATE TABLE IF NOT EXISTS user_dingtalk_identities (
      corp_id TEXT NOT NULL,
      ding_user_id TEXT NOT NULL,
      user_id INTEGER,
      status TEXT,
      updated_at TEXT,
      payload TEXT NOT NULL,
      PRIMARY KEY (corp_id, ding_user_id)
    );

    CREATE TABLE IF NOT EXISTS dingtalk_binding_challenges (
      token_hash TEXT PRIMARY KEY,
      corp_id TEXT NOT NULL,
      ding_user_id TEXT NOT NULL,
      status TEXT,
      expires_at TEXT,
      updated_at TEXT,
      payload TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_policy_import_tasks (
      id INTEGER PRIMARY KEY,
      family_id INTEGER NOT NULL,
      owner_user_id INTEGER,
      owner_guest_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      state_version INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_policy_import_tasks_family ON agent_policy_import_tasks(family_id, updated_at);

    CREATE TABLE IF NOT EXISTS state_documents (
      key TEXT PRIMARY KEY,
      payload TEXT NOT NULL
    );
  `);
  ensureCashflowTable(db);
  ensureCashValueTable(db);
  setMeta(db, 'schema_version', SCHEMA_VERSION);
}

function insertRows(db, state) {
  const insertUser = db.prepare(`
    INSERT INTO users (id, mobile, created_at, updated_at, payload)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const user of normalizeArray(state.users)) {
    insertUser.run(
      Number(user.id),
      String(user.mobile || ''),
      String(user.createdAt || ''),
      String(user.updatedAt || ''),
      jsonPayload(user),
    );
  }

  const insertSession = db.prepare(`
    INSERT INTO sessions (token, user_id, created_at, payload)
    VALUES (?, ?, ?, ?)
  `);
  for (const session of normalizeArray(state.sessions)) {
    const token = String(session.token || '').trim();
    if (!token) continue;
    insertSession.run(token, Number(session.userId || 0) || null, String(session.createdAt || ''), jsonPayload(session));
  }

  const insertAdminSession = db.prepare(`
    INSERT INTO admin_sessions (token, expires_at, payload)
    VALUES (?, ?, ?)
  `);
  for (const session of normalizeArray(state.adminSessions)) {
    const token = String(session.token || '').trim();
    if (!token) continue;
    insertAdminSession.run(token, String(session.expiresAt || ''), jsonPayload(session));
  }

  const insertSms = db.prepare(`
    INSERT INTO sms_codes (id, mobile, used, expires_at, created_at, payload)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const sms of normalizeArray(state.smsCodes)) {
    insertSms.run(
      Number(sms.id),
      String(sms.mobile || ''),
      sms.used ? 1 : 0,
      String(sms.expiresAt || ''),
      String(sms.createdAt || ''),
      jsonPayload(sms),
    );
  }

  const insertPolicy = db.prepare(`
    INSERT INTO policies (id, user_id, guest_id, company, name, insured, created_at, updated_at, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const policy of normalizeArray(state.policies)) {
    insertPolicy.run(
      Number(policy.id),
      Number(policy.userId || 0) || null,
      String(policy.guestId || ''),
      String(policy.company || ''),
      String(policy.name || ''),
      String(policy.insured || ''),
      String(policy.createdAt || ''),
      String(policy.updatedAt || ''),
      jsonPayload(policy),
    );
  }

  const insertPendingScan = db.prepare(`
    INSERT INTO pending_scans (guest_id, created_at, payload)
    VALUES (?, ?, ?)
  `);
  for (const pending of normalizeArray(state.pendingScans)) {
    insertPendingScan.run(String(pending.guestId || ''), String(pending.createdAt || ''), jsonPayload(pending));
  }

  const insertSourceRecord = db.prepare(`
    INSERT INTO source_records (id, policy_id, company, product_name, url, payload)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const source of normalizeArray(state.sourceRecords)) {
    insertSourceRecord.run(
      Number(source.id),
      Number(source.policyId || 0) || null,
      String(source.company || ''),
      String(source.productName || ''),
      String(source.url || ''),
      jsonPayload(source),
    );
  }

  const insertKnowledgeRecord = db.prepare(`
    INSERT INTO knowledge_records (id, company, product_name, url, payload)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const record of normalizeArray(state.knowledgeRecords)) {
    insertKnowledgeRecord.run(
      Number(record.id),
      String(record.company || ''),
      String(record.productName || record.title || ''),
      String(record.url || ''),
      jsonPayload(record),
    );
  }

  const insertInsuranceIndicatorRecord = db.prepare(`
    INSERT INTO insurance_indicator_records (id, company, product_name, coverage_type, liability, payload)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const record of normalizeArray(state.insuranceIndicatorRecords)) {
    const id = String(record?.id || '').trim();
    if (!id) continue;
    insertInsuranceIndicatorRecord.run(
      id,
      String(record.company || ''),
      String(record.productName || ''),
      String(record.coverageType || ''),
      String(record.liability || ''),
      jsonPayload(record),
    );
  }

  const insertOptionalResponsibilityRecord = db.prepare(`
    INSERT INTO optional_responsibility_records (id, company, product_name, liability, payload)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const record of normalizeArray(state.optionalResponsibilityRecords)) {
    const id = String(record?.id || '').trim();
    if (!id) continue;
    insertOptionalResponsibilityRecord.run(
      id,
      String(record.company || ''),
      String(record.productName || ''),
      String(record.liability || ''),
      jsonPayload(record),
    );
  }

  const insertProductCustomerResponsibilitySummary = db.prepare(`
    INSERT INTO product_customer_responsibility_summaries (
      id,
      product_key,
      company,
      product_name,
      summary_version,
      status,
      headline,
      summary_json,
      source_urls_json,
      source_digest,
      model_provider,
      model_name,
      generated_at,
      updated_at,
      payload
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of normalizeArray(state.productCustomerResponsibilitySummaries)) {
    const summary = normalizeProductCustomerResponsibilitySummary(row);
    if (!summary || summary.status !== 'ready') continue;
    insertProductCustomerResponsibilitySummary.run(
      summary.id,
      summary.productKey,
      summary.company,
      summary.productName,
      summary.summaryVersion,
      summary.status,
      summary.headline,
      JSON.stringify(summary.summaryJson),
      JSON.stringify(summary.sourceUrls),
      summary.sourceDigest,
      summary.modelProvider,
      summary.modelName,
      summary.generatedAt,
      summary.updatedAt,
      jsonPayload(summary),
    );
  }

  const insertProductCustomerSummaryGenerationRun = db.prepare(`
    INSERT INTO product_customer_summary_generation_runs (
      id,
      product_key,
      company,
      product_name,
      summary_version,
      status,
      product_category,
      category_label,
      model_provider,
      model_name,
      model_tier,
      source_digest,
      source_sections_digest,
      quality_issues_json,
      raw_preview,
      created_at,
      payload
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of normalizeArray(state.productCustomerSummaryGenerationRuns)) {
    const run = normalizeProductCustomerSummaryGenerationRun(row);
    if (!run) continue;
    insertProductCustomerSummaryGenerationRun.run(
      run.id,
      run.productKey,
      run.company,
      run.productName,
      run.summaryVersion,
      run.status,
      run.productCategory,
      run.categoryLabel,
      run.modelProvider,
      run.modelName,
      run.modelTier,
      run.sourceDigest,
      run.sourceSectionsDigest,
      JSON.stringify(run.qualityIssues),
      run.rawPreview,
      run.createdAt,
      jsonPayload(run),
    );
  }

  const insertPolicyDerivedResult = db.prepare(`
    INSERT INTO policy_derived_results (policy_id, product_keys, status, stale_reason, generated_at, updated_at, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of normalizeArray(state.policyDerivedResults)) {
    const derived = normalizePolicyDerivedResult(row);
    if (!derived) continue;
    insertPolicyDerivedResult.run(
      derived.policyId,
      JSON.stringify(derived.productKeys),
      derived.status,
      derived.staleReason,
      derived.generatedAt,
      derived.updatedAt,
      jsonPayload(derived),
    );
  }

  const insertProductIndicatorVersion = db.prepare(`
    INSERT INTO product_indicator_versions (product_key, version, batch_id, updated_at, payload)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const row of normalizeArray(state.productIndicatorVersions)) {
    const version = normalizeProductIndicatorVersion(row);
    if (!version) continue;
    insertProductIndicatorVersion.run(
      version.productKey,
      version.version,
      version.batchId,
      version.updatedAt,
      jsonPayload(version),
    );
  }

  const insertIndicatorUpdateBatch = db.prepare(`
    INSERT INTO indicator_update_batches (id, created_at, product_keys, changed_product_key_count, affected_policy_count, payload)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const row of normalizeArray(state.indicatorUpdateBatches)) {
    const batch = normalizeIndicatorUpdateBatch(row);
    if (!batch) continue;
    insertIndicatorUpdateBatch.run(
      batch.id,
      batch.createdAt,
      JSON.stringify(batch.productKeys),
      batch.changedProductKeyCount,
      batch.affectedPolicyCount,
      jsonPayload(batch),
    );
  }

  const insertProfile = db.prepare(`
    INSERT INTO official_domain_profiles (id, payload)
    VALUES (?, ?)
  `);
  normalizeArray(state.officialDomainProfiles).forEach((profile, index) => {
    const id = String(profile?.id || `profile-${index + 1}`).trim();
    if (!id) return;
    insertProfile.run(id, jsonPayload({ ...profile, id }));
  });

  const insertFamilyProfile = db.prepare(`
    INSERT INTO family_profiles (id, owner_user_id, owner_guest_id, family_name, core_member_id, status, created_at, updated_at, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const profile of normalizeArray(state.familyProfiles)) {
    insertFamilyProfile.run(
      Number(profile.id),
      Number(profile.ownerUserId || 0) || null,
      String(profile.ownerGuestId || ''),
      String(profile.familyName || ''),
      Number(profile.coreMemberId || 0) || null,
      String(profile.status || ''),
      String(profile.createdAt || ''),
      String(profile.updatedAt || ''),
      jsonPayload(profile),
    );
  }

  const insertFamilyMember = db.prepare(`
    INSERT INTO family_members (id, family_id, name, relation_to_core, status, created_at, updated_at, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const member of normalizeArray(state.familyMembers)) {
    insertFamilyMember.run(
      Number(member.id),
      Number(member.familyId || 0) || null,
      String(member.name || ''),
      String(member.relationToCore || ''),
      String(member.status || ''),
      String(member.createdAt || ''),
      String(member.updatedAt || ''),
      jsonPayload(member),
    );
  }

  const insertFamilyReport = db.prepare(`
    INSERT INTO family_reports (id, family_id, owner_user_id, owner_guest_id, status, source, generated_at, created_at, updated_at, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const report of normalizeArray(state.familyReports)) {
    insertFamilyReport.run(
      Number(report.id),
      Number(report.familyId || 0) || null,
      Number(report.ownerUserId || 0) || null,
      String(report.ownerGuestId || ''),
      String(report.status || ''),
      String(report.source || ''),
      String(report.generatedAt || ''),
      String(report.createdAt || ''),
      String(report.updatedAt || ''),
      jsonPayload(report),
    );
  }

  const insertFamilyReportIssue = db.prepare(`
    INSERT INTO family_report_issues (id, report_id, family_id, owner_user_id, owner_guest_id, severity, category, status, source, created_at, updated_at, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const issue of normalizeArray(state.familyReportIssues)) {
    insertFamilyReportIssue.run(
      Number(issue.id),
      Number(issue.reportId || 0) || null,
      Number(issue.familyId || 0) || null,
      Number(issue.ownerUserId || 0) || null,
      String(issue.ownerGuestId || ''),
      String(issue.severity || ''),
      String(issue.category || ''),
      String(issue.status || ''),
      String(issue.source || ''),
      String(issue.createdAt || ''),
      String(issue.updatedAt || ''),
      jsonPayload(issue),
    );
  }

  const insertFamilyReportCorrection = db.prepare(`
    INSERT INTO family_report_corrections (id, report_id, family_id, owner_user_id, owner_guest_id, policy_id, member_id, dimension, action, status, source, issue_id, created_at, updated_at, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const correction of normalizeArray(state.familyReportCorrections)) {
    insertFamilyReportCorrection.run(
      Number(correction.id),
      Number(correction.reportId || 0) || null,
      Number(correction.familyId || 0) || null,
      Number(correction.ownerUserId || 0) || null,
      String(correction.ownerGuestId || ''),
      Number(correction.policyId || 0) || null,
      Number(correction.memberId || 0) || null,
      String(correction.dimension || ''),
      String(correction.action || ''),
      String(correction.status || ''),
      String(correction.source || ''),
      Number(correction.issueId || 0) || null,
      String(correction.createdAt || ''),
      String(correction.updatedAt || ''),
      jsonPayload(correction),
    );
  }

  const insertFamilyReportShare = db.prepare(`
    INSERT INTO family_report_shares (id, family_id, owner_user_id, owner_guest_id, token, status, created_at, updated_at, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const share of normalizeArray(state.familyReportShares)) {
    insertFamilyReportShare.run(
      Number(share.id),
      Number(share.familyId || 0) || null,
      Number(share.ownerUserId || 0) || null,
      String(share.ownerGuestId || ''),
      String(share.token || share.shareToken || ''),
      String(share.status || ''),
      String(share.createdAt || ''),
      String(share.updatedAt || ''),
      jsonPayload(share),
    );
  }

  const insertFamilySalesReview = db.prepare(`
    INSERT INTO family_sales_reviews (id, family_id, owner_user_id, owner_guest_id, status, generated_at, created_at, updated_at, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const review of normalizeArray(state.familySalesReviews)) {
    insertFamilySalesReview.run(
      Number(review.id),
      Number(review.familyId || 0) || null,
      Number(review.ownerUserId || 0) || null,
      String(review.ownerGuestId || ''),
      String(review.status || ''),
      String(review.generatedAt || ''),
      String(review.createdAt || ''),
      String(review.updatedAt || ''),
      jsonPayload(review),
    );
  }

  const insertFamilySalesChatThread = db.prepare(`
    INSERT INTO family_sales_chat_threads (id, family_id, owner_user_id, owner_guest_id, status, title, created_at, updated_at, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const thread of normalizeArray(state.familySalesChatThreads)) {
    insertFamilySalesChatThread.run(
      Number(thread.id),
      Number(thread.familyId || 0) || null,
      Number(thread.ownerUserId || 0) || null,
      String(thread.ownerGuestId || ''),
      String(thread.status || ''),
      String(thread.title || ''),
      String(thread.createdAt || ''),
      String(thread.updatedAt || ''),
      jsonPayload(thread),
    );
  }

  const insertFamilySalesChatMessage = db.prepare(`
    INSERT INTO family_sales_chat_messages (id, thread_id, family_id, role, created_at, payload)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const message of normalizeArray(state.familySalesChatMessages)) {
    insertFamilySalesChatMessage.run(
      Number(message.id),
      Number(message.threadId || 0) || null,
      Number(message.familyId || 0) || null,
      String(message.role || ''),
      String(message.createdAt || ''),
      jsonPayload(message),
    );
  }

  const insertFamilySalesMemory = db.prepare(`
    INSERT INTO family_sales_memories (id, family_id, owner_user_id, owner_guest_id, kind, status, source_thread_id, created_at, updated_at, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const memory of normalizeArray(state.familySalesMemories)) {
    insertFamilySalesMemory.run(
      Number(memory.id),
      Number(memory.familyId || 0) || null,
      Number(memory.ownerUserId || 0) || null,
      String(memory.ownerGuestId || ''),
      String(memory.kind || ''),
      String(memory.status || ''),
      Number(memory.sourceThreadId || 0) || null,
      String(memory.createdAt || ''),
      String(memory.updatedAt || ''),
      jsonPayload(memory),
    );
  }

  const insertReportRefreshEvent = db.prepare(`
    INSERT INTO report_refresh_events (id, kind, family_id, report_id, owner_user_id, owner_guest_id, created_at, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const event of normalizeArray(state.reportRefreshEvents)) {
    insertReportRefreshEvent.run(
      Number(event.id),
      String(event.kind || ''),
      Number(event.familyId || 0) || null,
      Number(event.reportId || 0) || null,
      Number(event.ownerUserId || 0) || null,
      String(event.ownerGuestId || ''),
      String(event.createdAt || ''),
      jsonPayload(event),
    );
  }

  if (state.membershipConfig) {
    db.prepare(`
      INSERT INTO membership_config (id, payload)
      VALUES (1, ?)
    `).run(jsonPayload(state.membershipConfig));
  }

  const insertMembershipOrder = db.prepare(`
    INSERT INTO membership_orders (id, out_trade_no, user_id, status, created_at, updated_at, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const order of normalizeArray(state.membershipOrders)) {
    insertMembershipOrder.run(
      Number(order.id),
      String(order.outTradeNo || ''),
      Number(order.userId || 0) || null,
      String(order.status || ''),
      String(order.createdAt || ''),
      String(order.updatedAt || ''),
      jsonPayload(order),
    );
  }

  const insertMembership = db.prepare(`
    INSERT INTO memberships (user_id, status, expires_at, updated_at, payload)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const membership of normalizeArray(state.memberships)) {
    insertMembership.run(
      Number(membership.userId || 0),
      String(membership.status || ''),
      String(membership.expiresAt || ''),
      String(membership.updatedAt || ''),
      jsonPayload(membership),
    );
  }

  const insertUserWechatIdentity = db.prepare(`
    INSERT INTO user_wechat_identities (user_id, app_id, openid, updated_at, payload)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const identity of normalizeArray(state.userWechatIdentities)) {
    insertUserWechatIdentity.run(
      Number(identity.userId || 0),
      String(identity.appId || ''),
      String(identity.openid || ''),
      String(identity.updatedAt || ''),
      jsonPayload(identity),
    );
  }

  const insertWechatOAuthState = db.prepare(`
    INSERT INTO wechat_oauth_states (state, user_id, app_id, expires_at, used_at, created_at, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const oauthState of normalizeArray(state.wechatOAuthStates)) {
    const stateToken = String(oauthState?.state || '').trim();
    if (!stateToken) continue;
    insertWechatOAuthState.run(
      stateToken,
      Number(oauthState.userId || 0) || null,
      String(oauthState.appId || ''),
      String(oauthState.expiresAt || ''),
      String(oauthState.usedAt || ''),
      String(oauthState.createdAt || ''),
      jsonPayload(oauthState),
    );
  }

  for (const identity of normalizeArray(state.userDingtalkIdentities)) upsertDingtalkIdentity(db, identity);
  for (const challenge of normalizeArray(state.dingtalkBindingChallenges)) upsertDingtalkBindingChallenge(db, challenge);
  const insertAgentPolicyImportTask = db.prepare(`
    INSERT INTO agent_policy_import_tasks
      (id, family_id, owner_user_id, owner_guest_id, status, state_version, updated_at, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const task of normalizeArray(state.agentPolicyImportTasks)) {
    insertAgentPolicyImportTask.run(
      Number(task.id), Number(task.familyId), Number(task.ownerUserId || 0) || null,
      String(task.ownerGuestId || ''), String(task.status || ''), Number(task.stateVersion),
      String(task.updatedAt || ''), jsonPayload(task),
    );
  }

  const insertStateDocument = db.prepare(`
    INSERT INTO state_documents (key, payload)
    VALUES (?, ?)
  `);
  for (const [key, value] of Object.entries(state || {})) {
    if (DB_OWNED_KEYS.has(key) || RESERVED_STATE_KEYS.has(key)) continue;
    insertStateDocument.run(key, JSON.stringify(value));
  }
}

function upsertAdminSession(db, session = {}) {
  const token = String(session?.token || '').trim();
  if (!token) return;
  db.prepare(`
    INSERT INTO admin_sessions (token, expires_at, payload)
    VALUES (?, ?, ?)
    ON CONFLICT(token) DO UPDATE SET
      expires_at = excluded.expires_at,
      payload = excluded.payload
  `).run(token, String(session.expiresAt || ''), jsonPayload(session));
}

function upsertUser(db, user = {}) {
  db.prepare(`
    INSERT INTO users (id, mobile, created_at, updated_at, payload)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      mobile = excluded.mobile,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      payload = excluded.payload
  `).run(
    Number(user.id),
    String(user.mobile || ''),
    String(user.createdAt || ''),
    String(user.updatedAt || ''),
    jsonPayload(user),
  );
}

function upsertSession(db, session = {}) {
  const token = String(session?.token || '').trim();
  if (!token) return;
  db.prepare(`
    INSERT INTO sessions (token, user_id, created_at, payload)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(token) DO UPDATE SET
      user_id = excluded.user_id,
      created_at = excluded.created_at,
      payload = excluded.payload
  `).run(
    token,
    Number(session.userId || 0) || null,
    String(session.createdAt || ''),
    jsonPayload(session),
  );
}

function upsertSmsCode(db, sms = {}) {
  db.prepare(`
    INSERT INTO sms_codes (id, mobile, used, expires_at, created_at, payload)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      mobile = excluded.mobile,
      used = excluded.used,
      expires_at = excluded.expires_at,
      created_at = excluded.created_at,
      payload = excluded.payload
  `).run(
    Number(sms.id),
    String(sms.mobile || ''),
    sms.used ? 1 : 0,
    String(sms.expiresAt || ''),
    String(sms.createdAt || ''),
    jsonPayload(sms),
  );
}

function upsertMembershipConfig(db, config = null) {
  if (!config) {
    db.prepare('DELETE FROM membership_config WHERE id = 1').run();
    return;
  }
  db.prepare(`
    INSERT INTO membership_config (id, payload)
    VALUES (1, ?)
    ON CONFLICT(id) DO UPDATE SET payload = excluded.payload
  `).run(jsonPayload(config));
}

function upsertStateDocument(db, key, value) {
  const normalizedKey = String(key || '').trim();
  if (!normalizedKey) return;
  db.prepare(`
    INSERT INTO state_documents (key, payload)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET
      payload = excluded.payload
  `).run(normalizedKey, JSON.stringify(value ?? null));
}

function upsertPolicy(db, policy = {}) {
  db.prepare(`
    INSERT INTO policies (id, user_id, guest_id, company, name, insured, created_at, updated_at, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      user_id = excluded.user_id,
      guest_id = excluded.guest_id,
      company = excluded.company,
      name = excluded.name,
      insured = excluded.insured,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      payload = excluded.payload
  `).run(
    Number(policy.id),
    Number(policy.userId || 0) || null,
    String(policy.guestId || ''),
    String(policy.company || ''),
    String(policy.name || ''),
    String(policy.insured || ''),
    String(policy.createdAt || ''),
    String(policy.updatedAt || ''),
    jsonPayload(policy),
  );
}

function upsertPolicyDerivedResultRow(db, row = {}) {
  const derived = normalizePolicyDerivedResult(row);
  if (!derived) return null;
  db.prepare(`
    INSERT INTO policy_derived_results (policy_id, product_keys, status, stale_reason, generated_at, updated_at, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(policy_id) DO UPDATE SET
      product_keys = excluded.product_keys,
      status = excluded.status,
      stale_reason = excluded.stale_reason,
      generated_at = excluded.generated_at,
      updated_at = excluded.updated_at,
      payload = excluded.payload
  `).run(
    derived.policyId,
    JSON.stringify(derived.productKeys),
    derived.status,
    derived.staleReason,
    derived.generatedAt,
    derived.updatedAt,
    jsonPayload(derived),
  );
  return derived;
}

function upsertProductCustomerResponsibilitySummaryRow(db, row = {}) {
  const summary = normalizeProductCustomerResponsibilitySummary(row);
  if (!summary || summary.status !== 'ready') return null;
  if (!hasCustomerSummaryContent(summary.summaryJson)) return null;
  db.prepare(`
    INSERT INTO product_customer_responsibility_summaries (
      id,
      product_key,
      company,
      product_name,
      summary_version,
      status,
      headline,
      summary_json,
      source_urls_json,
      source_digest,
      model_provider,
      model_name,
      generated_at,
      updated_at,
      payload
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(product_key, summary_version) DO UPDATE SET
      id = excluded.id,
      company = excluded.company,
      product_name = excluded.product_name,
      status = excluded.status,
      headline = excluded.headline,
      summary_json = excluded.summary_json,
      source_urls_json = excluded.source_urls_json,
      source_digest = excluded.source_digest,
      model_provider = excluded.model_provider,
      model_name = excluded.model_name,
      generated_at = excluded.generated_at,
      updated_at = excluded.updated_at,
      payload = excluded.payload
  `).run(
    summary.id,
    summary.productKey,
    summary.company,
    summary.productName,
    summary.summaryVersion,
    summary.status,
    summary.headline,
    JSON.stringify(summary.summaryJson),
    JSON.stringify(summary.sourceUrls),
    summary.sourceDigest,
    summary.modelProvider,
    summary.modelName,
    summary.generatedAt,
    summary.updatedAt,
    jsonPayload(summary),
  );
  return summary;
}

function upsertProductCustomerSummaryGenerationRunRow(db, row = {}) {
  const run = normalizeProductCustomerSummaryGenerationRun(row);
  if (!run) return null;
  db.prepare(`
    INSERT INTO product_customer_summary_generation_runs (
      id,
      product_key,
      company,
      product_name,
      summary_version,
      status,
      product_category,
      category_label,
      model_provider,
      model_name,
      model_tier,
      source_digest,
      source_sections_digest,
      quality_issues_json,
      raw_preview,
      created_at,
      payload
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      product_key = excluded.product_key,
      company = excluded.company,
      product_name = excluded.product_name,
      summary_version = excluded.summary_version,
      status = excluded.status,
      product_category = excluded.product_category,
      category_label = excluded.category_label,
      model_provider = excluded.model_provider,
      model_name = excluded.model_name,
      model_tier = excluded.model_tier,
      source_digest = excluded.source_digest,
      source_sections_digest = excluded.source_sections_digest,
      quality_issues_json = excluded.quality_issues_json,
      raw_preview = excluded.raw_preview,
      created_at = excluded.created_at,
      payload = excluded.payload
  `).run(
    run.id,
    run.productKey,
    run.company,
    run.productName,
    run.summaryVersion,
    run.status,
    run.productCategory,
    run.categoryLabel,
    run.modelProvider,
    run.modelName,
    run.modelTier,
    run.sourceDigest,
    run.sourceSectionsDigest,
    JSON.stringify(run.qualityIssues),
    run.rawPreview,
    run.createdAt,
    jsonPayload(run),
  );
  return run;
}

function upsertProductIndicatorVersionRow(db, row = {}) {
  const version = normalizeProductIndicatorVersion(row);
  if (!version) return null;
  db.prepare(`
    INSERT INTO product_indicator_versions (product_key, version, batch_id, updated_at, payload)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(product_key) DO UPDATE SET
      version = excluded.version,
      batch_id = excluded.batch_id,
      updated_at = excluded.updated_at,
      payload = excluded.payload
  `).run(
    version.productKey,
    version.version,
    version.batchId,
    version.updatedAt,
    jsonPayload(version),
  );
  return version;
}

function upsertIndicatorUpdateBatchRow(db, row = {}) {
  const batch = normalizeIndicatorUpdateBatch(row);
  if (!batch) return null;
  db.prepare(`
    INSERT INTO indicator_update_batches (id, created_at, product_keys, changed_product_key_count, affected_policy_count, payload)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      created_at = excluded.created_at,
      product_keys = excluded.product_keys,
      changed_product_key_count = excluded.changed_product_key_count,
      affected_policy_count = excluded.affected_policy_count,
      payload = excluded.payload
  `).run(
    batch.id,
    batch.createdAt,
    JSON.stringify(batch.productKeys),
    batch.changedProductKeyCount,
    batch.affectedPolicyCount,
    jsonPayload(batch),
  );
  return batch;
}

function upsertKnowledgeRecordRow(db, row = {}) {
  const record = normalizeKnowledgeRecord(row);
  if (!record?.id) return null;
  db.prepare(`
    INSERT INTO knowledge_records (id, company, product_name, url, payload)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      company = excluded.company,
      product_name = excluded.product_name,
      url = excluded.url,
      payload = excluded.payload
  `).run(
    Number(record.id),
    String(record.company || ''),
    String(record.productName || record.title || ''),
    String(record.url || ''),
    jsonPayload(record),
  );
  return record;
}

function upsertInsuranceIndicatorRecordRow(db, row = {}) {
  const id = String(row?.id || '').trim();
  if (!id) return null;
  db.prepare(`
    INSERT INTO insurance_indicator_records (id, company, product_name, coverage_type, liability, payload)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      company = excluded.company,
      product_name = excluded.product_name,
      coverage_type = excluded.coverage_type,
      liability = excluded.liability,
      payload = excluded.payload
  `).run(
    id,
    String(row.company || ''),
    String(row.productName || ''),
    String(row.coverageType || ''),
    String(row.liability || ''),
    jsonPayload(row),
  );
  return row;
}

function normalizedProductResponsibilityCardRow(row = {}) {
  const payload = row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload) ? row.payload : row;
  const id = String(row.id || payload.id || '').trim();
  const productKey = String(row.productKey || payload.productKey || '').trim();
  if (!id || !productKey) return null;
  return {
    id,
    productKey,
    company: String(row.company || payload.company || '').trim(),
    productName: String(row.productName || payload.productName || payload.product_name || '').trim(),
    title: String(row.title || payload.title || '').trim(),
    category: String(row.category || payload.category || '').trim(),
    cashflowTreatment: String(row.cashflowTreatment || payload.cashflowTreatment || '').trim(),
    calculationStatus: String(row.calculationStatus || payload.calculationStatus || '').trim(),
    calculationReason: String(row.calculationReason || payload.calculationReason || '').trim(),
    responsibilityScope: String(row.responsibilityScope || payload.responsibilityScope || '').trim(),
    selectionStatus: String(row.selectionStatus || payload.selectionStatus || '').trim(),
    sourceUrl: String(row.sourceUrl || payload.sourceUrl || '').trim(),
    generatedAt: String(row.generatedAt || payload.generatedAt || '').trim(),
    updatedAt: String(row.updatedAt || payload.updatedAt || '').trim(),
    payload,
  };
}

function upsertProductResponsibilityCardRow(db, row = {}) {
  const card = normalizedProductResponsibilityCardRow(row);
  if (!card) return null;
  db.prepare(`
    INSERT INTO product_responsibility_cards (
      id,
      product_key,
      company,
      product_name,
      title,
      category,
      cashflow_treatment,
      calculation_status,
      calculation_reason,
      responsibility_scope,
      selection_status,
      source_url,
      generated_at,
      updated_at,
      payload
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      product_key = excluded.product_key,
      company = excluded.company,
      product_name = excluded.product_name,
      title = excluded.title,
      category = excluded.category,
      cashflow_treatment = excluded.cashflow_treatment,
      calculation_status = excluded.calculation_status,
      calculation_reason = excluded.calculation_reason,
      responsibility_scope = excluded.responsibility_scope,
      selection_status = excluded.selection_status,
      source_url = excluded.source_url,
      generated_at = excluded.generated_at,
      updated_at = excluded.updated_at,
      payload = excluded.payload
  `).run(
    card.id,
    card.productKey,
    card.company,
    card.productName,
    card.title,
    card.category,
    card.cashflowTreatment,
    card.calculationStatus,
    card.calculationReason,
    card.responsibilityScope,
    card.selectionStatus,
    card.sourceUrl,
    card.generatedAt,
    card.updatedAt,
    jsonPayload(card.payload),
  );
  return card;
}

function deleteSession(db, token) {
  const value = String(token || '').trim();
  if (!value) return;
  db.prepare('DELETE FROM sessions WHERE token = ?').run(value);
}

function deletePolicy(db, policyId) {
  const id = Number(policyId);
  if (!Number.isFinite(id)) return;
  db.prepare('DELETE FROM source_records WHERE policy_id = ?').run(id);
  db.prepare('DELETE FROM policies WHERE id = ?').run(id);
}

function upsertMembershipOrder(db, order = {}) {
  if (!order?.id) return;
  db.prepare(`
    INSERT INTO membership_orders (id, out_trade_no, user_id, status, created_at, updated_at, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      out_trade_no = excluded.out_trade_no,
      user_id = excluded.user_id,
      status = excluded.status,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      payload = excluded.payload
  `).run(
    Number(order.id),
    String(order.outTradeNo || ''),
    Number(order.userId || 0) || null,
    String(order.status || ''),
    String(order.createdAt || ''),
    String(order.updatedAt || ''),
    jsonPayload(order),
  );
}

function upsertMembership(db, membership = {}) {
  const userId = Number(membership?.userId || 0);
  if (!userId) return;
  db.prepare(`
    INSERT INTO memberships (user_id, status, expires_at, updated_at, payload)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      status = excluded.status,
      expires_at = excluded.expires_at,
      updated_at = excluded.updated_at,
      payload = excluded.payload
  `).run(
    userId,
    String(membership.status || ''),
    String(membership.expiresAt || ''),
    String(membership.updatedAt || ''),
    jsonPayload(membership),
  );
}

function upsertUserWechatIdentity(db, identity = {}) {
  const userId = Number(identity?.userId || 0);
  const appId = String(identity?.appId || '').trim();
  if (!userId || !appId) return;
  db.prepare(`
    INSERT INTO user_wechat_identities (user_id, app_id, openid, updated_at, payload)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, app_id) DO UPDATE SET
      openid = excluded.openid,
      updated_at = excluded.updated_at,
      payload = excluded.payload
  `).run(
    userId,
    appId,
    String(identity.openid || ''),
    String(identity.updatedAt || ''),
    jsonPayload(identity),
  );
}

function upsertWechatOAuthState(db, oauthState = {}) {
  const stateToken = String(oauthState?.state || '').trim();
  if (!stateToken) return;
  db.prepare(`
    INSERT INTO wechat_oauth_states (state, user_id, app_id, expires_at, used_at, created_at, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(state) DO UPDATE SET
      user_id = excluded.user_id,
      app_id = excluded.app_id,
      expires_at = excluded.expires_at,
      used_at = excluded.used_at,
      created_at = excluded.created_at,
      payload = excluded.payload
  `).run(
    stateToken,
    Number(oauthState.userId || 0) || null,
    String(oauthState.appId || ''),
    String(oauthState.expiresAt || ''),
    String(oauthState.usedAt || ''),
    String(oauthState.createdAt || ''),
    jsonPayload(oauthState),
  );
}

const DINGTALK_SENSITIVE_PAYLOAD_KEYS = new Set([
  'token',
  'mobile',
  'rawtoken',
  'phone',
  'accesstoken',
  'downloadurl',
]);

function safeDingtalkPayload(value) {
  if (Array.isArray(value)) return value.map((item) => safeDingtalkPayload(item));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !DINGTALK_SENSITIVE_PAYLOAD_KEYS.has(key.replaceAll('_', '').toLowerCase()))
      .map(([key, item]) => [key, safeDingtalkPayload(item)]),
  );
}

function upsertDingtalkIdentity(db, identity = {}) {
  const safe = safeDingtalkPayload(identity);
  const corpId = String(safe.corpId || safe.corp_id || '').trim();
  const dingUserId = String(safe.dingUserId || safe.ding_user_id || '').trim();
  if (!corpId || !dingUserId) return;
  db.prepare(`
    INSERT INTO user_dingtalk_identities (corp_id, ding_user_id, user_id, status, updated_at, payload)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(corp_id, ding_user_id) DO UPDATE SET
      user_id = excluded.user_id,
      status = excluded.status,
      updated_at = excluded.updated_at,
      payload = excluded.payload
  `).run(corpId, dingUserId, Number(safe.userId || 0) || null, String(safe.status || ''), String(safe.updatedAt || ''), jsonPayload(safe));
}

function upsertDingtalkBindingChallenge(db, challenge = {}) {
  const safe = safeDingtalkPayload(challenge);
  const tokenHash = String(safe.tokenHash || safe.token_hash || '').trim();
  const corpId = String(safe.corpId || safe.corp_id || '').trim();
  const dingUserId = String(safe.dingUserId || safe.ding_user_id || '').trim();
  if (!tokenHash || !corpId || !dingUserId) return;
  db.prepare(`
    INSERT INTO dingtalk_binding_challenges (token_hash, corp_id, ding_user_id, status, expires_at, updated_at, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(token_hash) DO UPDATE SET
      corp_id = excluded.corp_id,
      ding_user_id = excluded.ding_user_id,
      status = excluded.status,
      expires_at = excluded.expires_at,
      updated_at = excluded.updated_at,
      payload = excluded.payload
  `).run(tokenHash, corpId, dingUserId, String(safe.status || ''), String(safe.expiresAt || ''), String(safe.updatedAt || ''), jsonPayload(safe));
}

function replaceSourceRecordsForPolicy(db, state, policyId) {
  const id = Number(policyId);
  if (!Number.isFinite(id)) return;
  db.prepare('DELETE FROM source_records WHERE policy_id = ?').run(id);
  const insertSourceRecord = db.prepare(`
    INSERT INTO source_records (id, policy_id, company, product_name, url, payload)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const source of normalizeArray(state.sourceRecords).filter((row) => Number(row?.policyId || 0) === id)) {
    insertSourceRecord.run(
      Number(source.id),
      Number(source.policyId || 0) || null,
      String(source.company || ''),
      String(source.productName || ''),
      String(source.url || ''),
      jsonPayload(source),
    );
  }
}

function replaceOfficialDomainProfiles(db, state) {
  db.prepare('DELETE FROM official_domain_profiles').run();
  const insertProfile = db.prepare(`
    INSERT INTO official_domain_profiles (id, payload)
    VALUES (?, ?)
  `);
  normalizeArray(state.officialDomainProfiles).forEach((profile, index) => {
    const id = String(profile?.id || `profile-${index + 1}`).trim();
    if (!id) return;
    insertProfile.run(id, jsonPayload({ ...profile, id }));
  });
}

function replaceFamilyProfiles(db, state) {
  db.exec('DELETE FROM family_report_corrections; DELETE FROM family_report_issues; DELETE FROM family_reports; DELETE FROM family_members; DELETE FROM family_profiles;');
  const insertFamilyProfile = db.prepare(`
    INSERT INTO family_profiles (id, owner_user_id, owner_guest_id, family_name, core_member_id, status, created_at, updated_at, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const profile of normalizeArray(state.familyProfiles)) {
    insertFamilyProfile.run(
      Number(profile.id),
      Number(profile.ownerUserId || 0) || null,
      String(profile.ownerGuestId || ''),
      String(profile.familyName || ''),
      Number(profile.coreMemberId || 0) || null,
      String(profile.status || ''),
      String(profile.createdAt || ''),
      String(profile.updatedAt || ''),
      jsonPayload(profile),
    );
  }

  const insertFamilyMember = db.prepare(`
    INSERT INTO family_members (id, family_id, name, relation_to_core, status, created_at, updated_at, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const member of normalizeArray(state.familyMembers)) {
    insertFamilyMember.run(
      Number(member.id),
      Number(member.familyId || 0) || null,
      String(member.name || ''),
      String(member.relationToCore || ''),
      String(member.status || ''),
      String(member.createdAt || ''),
      String(member.updatedAt || ''),
      jsonPayload(member),
    );
  }
}

function replaceFamilyReportShares(db, state) {
  db.prepare('DELETE FROM family_report_shares').run();
  const insertFamilyReportShare = db.prepare(`
    INSERT INTO family_report_shares (id, family_id, owner_user_id, owner_guest_id, token, status, created_at, updated_at, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const share of normalizeArray(state.familyReportShares)) {
    insertFamilyReportShare.run(
      Number(share.id),
      Number(share.familyId || 0) || null,
      Number(share.ownerUserId || 0) || null,
      String(share.ownerGuestId || ''),
      String(share.token || share.shareToken || ''),
      String(share.status || ''),
      String(share.createdAt || ''),
      String(share.updatedAt || ''),
      jsonPayload(share),
    );
  }
}

function replaceFamilyReports(db, state) {
  db.prepare('DELETE FROM family_report_corrections').run();
  db.prepare('DELETE FROM family_report_issues').run();
  db.prepare('DELETE FROM family_reports').run();
  const insertFamilyReport = db.prepare(`
    INSERT INTO family_reports (id, family_id, owner_user_id, owner_guest_id, status, source, generated_at, created_at, updated_at, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const report of normalizeArray(state.familyReports)) {
    insertFamilyReport.run(
      Number(report.id),
      Number(report.familyId || 0) || null,
      Number(report.ownerUserId || 0) || null,
      String(report.ownerGuestId || ''),
      String(report.status || ''),
      String(report.source || ''),
      String(report.generatedAt || ''),
      String(report.createdAt || ''),
      String(report.updatedAt || ''),
      jsonPayload(report),
    );
  }
  const insertFamilyReportIssue = db.prepare(`
    INSERT INTO family_report_issues (id, report_id, family_id, owner_user_id, owner_guest_id, severity, category, status, source, created_at, updated_at, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const issue of normalizeArray(state.familyReportIssues)) {
    insertFamilyReportIssue.run(
      Number(issue.id),
      Number(issue.reportId || 0) || null,
      Number(issue.familyId || 0) || null,
      Number(issue.ownerUserId || 0) || null,
      String(issue.ownerGuestId || ''),
      String(issue.severity || ''),
      String(issue.category || ''),
      String(issue.status || ''),
      String(issue.source || ''),
      String(issue.createdAt || ''),
      String(issue.updatedAt || ''),
      jsonPayload(issue),
    );
  }
  const insertFamilyReportCorrection = db.prepare(`
    INSERT INTO family_report_corrections (id, report_id, family_id, owner_user_id, owner_guest_id, policy_id, member_id, dimension, action, status, source, issue_id, created_at, updated_at, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const correction of normalizeArray(state.familyReportCorrections)) {
    insertFamilyReportCorrection.run(
      Number(correction.id),
      Number(correction.reportId || 0) || null,
      Number(correction.familyId || 0) || null,
      Number(correction.ownerUserId || 0) || null,
      String(correction.ownerGuestId || ''),
      Number(correction.policyId || 0) || null,
      Number(correction.memberId || 0) || null,
      String(correction.dimension || ''),
      String(correction.action || ''),
      String(correction.status || ''),
      String(correction.source || ''),
      Number(correction.issueId || 0) || null,
      String(correction.createdAt || ''),
      String(correction.updatedAt || ''),
      jsonPayload(correction),
    );
  }
}

function replaceFamilySalesReviews(db, state) {
  db.prepare('DELETE FROM family_sales_reviews').run();
  const insertFamilySalesReview = db.prepare(`
    INSERT INTO family_sales_reviews (id, family_id, owner_user_id, owner_guest_id, status, generated_at, created_at, updated_at, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const review of normalizeArray(state.familySalesReviews)) {
    insertFamilySalesReview.run(
      Number(review.id),
      Number(review.familyId || 0) || null,
      Number(review.ownerUserId || 0) || null,
      String(review.ownerGuestId || ''),
      String(review.status || ''),
      String(review.generatedAt || ''),
      String(review.createdAt || ''),
      String(review.updatedAt || ''),
      jsonPayload(review),
    );
  }
}

function replaceFamilySalesChats(db, state) {
  db.prepare('DELETE FROM family_sales_chat_messages').run();
  db.prepare('DELETE FROM family_sales_chat_threads').run();
  const insertThread = db.prepare(`
    INSERT INTO family_sales_chat_threads (id, family_id, owner_user_id, owner_guest_id, status, title, created_at, updated_at, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const thread of normalizeArray(state.familySalesChatThreads)) {
    insertThread.run(
      Number(thread.id),
      Number(thread.familyId || 0) || null,
      Number(thread.ownerUserId || 0) || null,
      String(thread.ownerGuestId || ''),
      String(thread.status || ''),
      String(thread.title || ''),
      String(thread.createdAt || ''),
      String(thread.updatedAt || ''),
      jsonPayload(thread),
    );
  }
  const insertMessage = db.prepare(`
    INSERT INTO family_sales_chat_messages (id, thread_id, family_id, role, created_at, payload)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const message of normalizeArray(state.familySalesChatMessages)) {
    insertMessage.run(
      Number(message.id),
      Number(message.threadId || 0) || null,
      Number(message.familyId || 0) || null,
      String(message.role || ''),
      String(message.createdAt || ''),
      jsonPayload(message),
    );
  }
}

function replaceFamilySalesMemories(db, state) {
  db.prepare('DELETE FROM family_sales_memories').run();
  const insertMemory = db.prepare(`
    INSERT INTO family_sales_memories (id, family_id, owner_user_id, owner_guest_id, kind, status, source_thread_id, created_at, updated_at, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const memory of normalizeArray(state.familySalesMemories)) {
    insertMemory.run(
      Number(memory.id),
      Number(memory.familyId || 0) || null,
      Number(memory.ownerUserId || 0) || null,
      String(memory.ownerGuestId || ''),
      String(memory.kind || ''),
      String(memory.status || ''),
      Number(memory.sourceThreadId || 0) || null,
      String(memory.createdAt || ''),
      String(memory.updatedAt || ''),
      jsonPayload(memory),
    );
  }
}

function replaceReportRefreshEvents(db, state) {
  db.prepare('DELETE FROM report_refresh_events').run();
  const insertReportRefreshEvent = db.prepare(`
    INSERT INTO report_refresh_events (id, kind, family_id, report_id, owner_user_id, owner_guest_id, created_at, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const event of normalizeArray(state.reportRefreshEvents)) {
    insertReportRefreshEvent.run(
      Number(event.id),
      String(event.kind || ''),
      Number(event.familyId || 0) || null,
      Number(event.reportId || 0) || null,
      Number(event.ownerUserId || 0) || null,
      String(event.ownerGuestId || ''),
      String(event.createdAt || ''),
      jsonPayload(event),
    );
  }
}

function replacePendingScan(db, state, guestId) {
  const id = String(guestId || '').trim();
  if (!id) return;
  db.prepare('DELETE FROM pending_scans WHERE guest_id = ?').run(id);
  const pending = normalizeArray(state.pendingScans).find((row) => String(row?.guestId || '') === id);
  if (!pending) return;
  db.prepare(`
    INSERT INTO pending_scans (guest_id, created_at, payload)
    VALUES (?, ?, ?)
  `).run(id, String(pending.createdAt || ''), jsonPayload(pending));
}

function updateStateMeta(db, state, now) {
  const initializedAt = getMeta(db, 'state_initialized_at');
  setMeta(db, 'next_id', String(resolveNextId(state)));
  setMeta(db, 'state_initialized_at', initializedAt || now);
  setMeta(db, 'updated_at', now);
}

function clearDbOwnedTables(db) {
  db.exec(`
    DELETE FROM family_report_issues;
    DELETE FROM family_report_corrections;
    DELETE FROM family_reports;
    DELETE FROM family_sales_memories;
    DELETE FROM family_sales_chat_messages;
    DELETE FROM family_sales_chat_threads;
    DELETE FROM family_sales_reviews;
    DELETE FROM report_refresh_events;
    DELETE FROM family_report_shares;
    DELETE FROM family_members;
    DELETE FROM family_profiles;
    DELETE FROM users;
    DELETE FROM sessions;
    DELETE FROM admin_sessions;
    DELETE FROM sms_codes;
    DELETE FROM policies;
    DELETE FROM pending_scans;
    DELETE FROM source_records;
    DELETE FROM knowledge_records;
    DELETE FROM insurance_indicator_records;
    DELETE FROM optional_responsibility_records;
    DELETE FROM product_customer_responsibility_summaries;
    DELETE FROM product_customer_summary_generation_runs;
    DELETE FROM policy_derived_results;
    DELETE FROM product_indicator_versions;
    DELETE FROM indicator_update_batches;
    DELETE FROM official_domain_profiles;
    DELETE FROM membership_config;
    DELETE FROM membership_orders;
    DELETE FROM memberships;
    DELETE FROM user_wechat_identities;
    DELETE FROM wechat_oauth_states;
    DELETE FROM user_dingtalk_identities;
    DELETE FROM dingtalk_binding_challenges;
    DELETE FROM agent_policy_import_tasks;
    DELETE FROM state_documents;
  `);
}

function loadPayloadRows(db, table, orderBy) {
  return db.prepare(`SELECT payload FROM ${table} ${orderBy ? `ORDER BY ${orderBy}` : ''}`)
    .all()
    .map((row) => parseJson(row.payload, null))
    .filter(Boolean);
}

function loadProductCustomerSummaryGenerationRuns(db) {
  return db.prepare(`
    SELECT
      id,
      product_key,
      company,
      product_name,
      summary_version,
      status,
      product_category,
      category_label,
      model_provider,
      model_name,
      model_tier,
      source_digest,
      source_sections_digest,
      quality_issues_json,
      raw_preview,
      created_at,
      payload
    FROM product_customer_summary_generation_runs
    ORDER BY created_at DESC, id ASC
  `)
    .all()
    .map((row) => normalizeProductCustomerSummaryGenerationRun(row))
    .filter(Boolean);
}

function loadDbOwnedState(db) {
  const state = {
    users: loadPayloadRows(db, 'users', 'id ASC'),
    sessions: loadPayloadRows(db, 'sessions', 'created_at ASC'),
    adminSessions: loadPayloadRows(db, 'admin_sessions', 'expires_at ASC'),
    smsCodes: loadPayloadRows(db, 'sms_codes', 'id ASC'),
    policies: loadPayloadRows(db, 'policies', 'id ASC'),
    pendingScans: loadPayloadRows(db, 'pending_scans', 'row_id ASC'),
    sourceRecords: loadPayloadRows(db, 'source_records', 'id ASC'),
    knowledgeRecords: loadPayloadRows(db, 'knowledge_records', 'id ASC'),
    insuranceIndicatorRecords: loadPayloadRows(db, 'insurance_indicator_records', 'product_name ASC, coverage_type ASC, liability ASC, id ASC'),
    optionalResponsibilityRecords: loadPayloadRows(db, 'optional_responsibility_records', 'product_name ASC, liability ASC, id ASC'),
    productCustomerResponsibilitySummaries: loadPayloadRows(db, 'product_customer_responsibility_summaries', 'product_name ASC, summary_version ASC, id ASC'),
    productCustomerSummaryGenerationRuns: loadProductCustomerSummaryGenerationRuns(db),
    policyDerivedResults: loadPayloadRows(db, 'policy_derived_results', 'policy_id ASC'),
    productIndicatorVersions: loadPayloadRows(db, 'product_indicator_versions', 'product_key ASC'),
    indicatorUpdateBatches: loadPayloadRows(db, 'indicator_update_batches', 'created_at ASC, id ASC'),
    officialDomainProfiles: loadPayloadRows(db, 'official_domain_profiles', 'id ASC'),
    familyProfiles: loadPayloadRows(db, 'family_profiles', 'id ASC'),
    familyMembers: loadPayloadRows(db, 'family_members', 'id ASC'),
    familyReports: loadPayloadRows(db, 'family_reports', 'generated_at ASC, id ASC'),
    familyReportIssues: loadPayloadRows(db, 'family_report_issues', 'created_at ASC, id ASC'),
    familyReportCorrections: loadPayloadRows(db, 'family_report_corrections', 'created_at ASC, id ASC'),
    familyReportShares: loadPayloadRows(db, 'family_report_shares', 'created_at ASC, id ASC'),
    familySalesReviews: loadPayloadRows(db, 'family_sales_reviews', 'generated_at ASC, id ASC'),
    familySalesChatThreads: loadPayloadRows(db, 'family_sales_chat_threads', 'updated_at ASC, id ASC'),
    familySalesChatMessages: loadPayloadRows(db, 'family_sales_chat_messages', 'created_at ASC, id ASC'),
    familySalesMemories: loadPayloadRows(db, 'family_sales_memories', 'updated_at ASC, id ASC'),
    reportRefreshEvents: loadPayloadRows(db, 'report_refresh_events', 'created_at ASC, id ASC'),
    membershipConfig: parseJson(db.prepare('SELECT payload FROM membership_config WHERE id = 1').get()?.payload, null),
    membershipOrders: loadPayloadRows(db, 'membership_orders', 'id ASC'),
    memberships: loadPayloadRows(db, 'memberships', 'user_id ASC'),
    userWechatIdentities: loadPayloadRows(db, 'user_wechat_identities', 'user_id ASC, app_id ASC'),
    wechatOAuthStates: loadPayloadRows(db, 'wechat_oauth_states', 'created_at ASC, state ASC'),
    userDingtalkIdentities: loadPayloadRows(db, 'user_dingtalk_identities', 'corp_id ASC, ding_user_id ASC'),
    dingtalkBindingChallenges: loadPayloadRows(db, 'dingtalk_binding_challenges', 'updated_at ASC, token_hash ASC'),
    agentPolicyImportTasks: loadPayloadRows(db, 'agent_policy_import_tasks', 'updated_at ASC, id ASC'),
  };
  state.knowledgeRecords = state.knowledgeRecords
    .map((record) => normalizeKnowledgeRecord(record))
    .filter(Boolean);
  state.policyDerivedResults = state.policyDerivedResults
    .map((row) => normalizePolicyDerivedResult(row))
    .filter(Boolean);
  state.productCustomerResponsibilitySummaries = state.productCustomerResponsibilitySummaries
    .map((row) => normalizeProductCustomerResponsibilitySummary(row))
    .filter((row) => row && row.status === 'ready');
  state.productIndicatorVersions = state.productIndicatorVersions
    .map((row) => normalizeProductIndicatorVersion(row))
    .filter(Boolean);
  state.indicatorUpdateBatches = state.indicatorUpdateBatches
    .map((row) => normalizeIndicatorUpdateBatch(row))
    .filter(Boolean);
  for (const row of db.prepare('SELECT key, payload FROM state_documents ORDER BY key ASC').all()) {
    state[row.key] = parseJson(row.payload, null);
  }
  return state;
}

function stateDocumentEntries(state) {
  return Object.entries(state || {}).filter(([key]) => !DB_OWNED_KEYS.has(key) && !RESERVED_STATE_KEYS.has(key));
}

export async function createSqliteStateStore({ dbPath, seedStatePath } = {}) {
  if (!dbPath) throw new Error('POLICY_OCR_APP_DB_PATH is required');
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  createSchema(db);

  async function loadSeedState() {
    const seed = seedStatePath ? await readJsonFile(seedStatePath, createInitialState()) : createInitialState();
    return { ...createInitialState(), ...seed, nextId: resolveNextId(seed) };
  }

  async function persist(state) {
    const nextState = { ...createInitialState(), ...state };
    nextState.nextId = resolveNextId(nextState);
    const now = new Date().toISOString();
    const initializedAt = getMeta(db, 'state_initialized_at');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('PRAGMA defer_foreign_keys = ON');
      clearDbOwnedTables(db);
      insertRows(db, nextState);
      updateStateMeta(db, nextState, now);
      if (seedStatePath && !initializedAt && !getMeta(db, 'imported_from_json_state_path')) {
        setMeta(db, 'imported_from_json_state_path', seedStatePath);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  async function persistAgentPolicyImportTask({ state, task, expectedVersion = 0 } = {}) {
    if (!task || !Number.isSafeInteger(task.id) || !Number.isSafeInteger(task.stateVersion)) {
      throw Object.assign(new Error('保单录入任务无效'), { code: 'INVALID_TASK', status: 400 });
    }
    const nextState = { ...createInitialState(), ...state };
    const now = String(task.updatedAt || new Date().toISOString());
    db.exec('BEGIN IMMEDIATE');
    try {
      let changed;
      if (expectedVersion === 0) {
        changed = db.prepare(`
          INSERT OR IGNORE INTO agent_policy_import_tasks
            (id, family_id, owner_user_id, owner_guest_id, status, state_version, updated_at, payload)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          task.id, task.familyId, Number(task.ownerUserId || 0) || null, String(task.ownerGuestId || ''),
          String(task.status), task.stateVersion, now, jsonPayload(task),
        ).changes;
      } else {
        changed = db.prepare(`
          UPDATE agent_policy_import_tasks
          SET family_id = ?, owner_user_id = ?, owner_guest_id = ?, status = ?, state_version = ?, updated_at = ?, payload = ?
          WHERE id = ? AND state_version = ?
        `).run(
          task.familyId, Number(task.ownerUserId || 0) || null, String(task.ownerGuestId || ''),
          String(task.status), task.stateVersion, now, jsonPayload(task), task.id, expectedVersion,
        ).changes;
      }
      if (changed !== 1) throw Object.assign(new Error('任务状态已更新，请刷新后重试'), { code: 'STALE_INTERACTION', status: 409 });
      updateStateMeta(db, nextState, now);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  async function findAgentPolicyImportTask(id) {
    return parseJson(db.prepare('SELECT payload FROM agent_policy_import_tasks WHERE id = ?').get(Number(id))?.payload, null);
  }

  async function persistAdminSession({ state, session = null } = {}) {
    const nextState = { ...createInitialState(), ...state };
    nextState.nextId = resolveNextId(nextState);
    const targetSession = session || normalizeArray(nextState.adminSessions).at(-1);
    const now = new Date().toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      upsertAdminSession(db, targetSession);
      updateStateMeta(db, nextState, now);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  async function persistDingtalkIdentityState({ state, identity = null, challenge = null, challenges = [] } = {}) {
    const nextState = { ...createInitialState(), ...state };
    nextState.nextId = resolveNextId(nextState);
    const now = new Date().toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      if (identity) upsertDingtalkIdentity(db, identity);
      if (challenge) upsertDingtalkBindingChallenge(db, challenge);
      for (const changedChallenge of normalizeArray(challenges)) upsertDingtalkBindingChallenge(db, changedChallenge);
      updateStateMeta(db, nextState, now);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  async function persistMembershipConfig({ state, config = null } = {}) {
    const nextState = { ...createInitialState(), ...state };
    nextState.nextId = resolveNextId(nextState);
    const now = new Date().toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      upsertMembershipConfig(db, config || nextState.membershipConfig || null);
      updateStateMeta(db, nextState, now);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  async function persistStateDocument({ state, key = '', value = null } = {}) {
    const normalizedKey = String(key || '').trim();
    if (!normalizedKey) throw new Error('State document key is required');
    const nextState = { ...createInitialState(), ...state };
    nextState.nextId = resolveNextId(nextState);
    const now = new Date().toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      upsertStateDocument(db, normalizedKey, value);
      updateStateMeta(db, nextState, now);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    if (state && typeof state === 'object') state[normalizedKey] = value;
    return value;
  }

  async function persistOfficialDomainProfiles({ state } = {}) {
    const nextState = { ...createInitialState(), ...state };
    nextState.nextId = resolveNextId(nextState);
    const now = new Date().toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      replaceOfficialDomainProfiles(db, nextState);
      updateStateMeta(db, nextState, now);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  async function persistPolicyScanSave({ state, policy, clearPendingGuestId = '' } = {}) {
    if (!policy?.id) {
      await persist(state);
      return;
    }
    const nextState = { ...createInitialState(), ...state };
    nextState.nextId = resolveNextId(nextState);
    const now = new Date().toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('PRAGMA defer_foreign_keys = ON');
      upsertPolicy(db, policy);
      replaceSourceRecordsForPolicy(db, nextState, policy.id);
      replaceFamilyProfiles(db, nextState);
      replaceFamilyReports(db, nextState);
      replaceReportRefreshEvents(db, nextState);
      const pendingGuestId = String(clearPendingGuestId || '').trim();
      if (pendingGuestId) {
        db.prepare('DELETE FROM pending_scans WHERE guest_id = ?').run(pendingGuestId);
      }
      updateStateMeta(db, nextState, now);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  async function persistAuthSmsCode({ state, sms = null } = {}) {
    const nextState = { ...createInitialState(), ...state };
    nextState.nextId = resolveNextId(nextState);
    const targetSms = sms || normalizeArray(nextState.smsCodes).at(-1);
    const now = new Date().toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      if (targetSms) upsertSmsCode(db, targetSms);
      updateStateMeta(db, nextState, now);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  async function persistAuthRegistration({
    state,
    user = null,
    sms = null,
    session = null,
    guestId = '',
    policyIds = [],
  } = {}) {
    const nextState = { ...createInitialState(), ...state };
    nextState.nextId = resolveNextId(nextState);
    const pendingGuestId = String(guestId || '').trim();
    const affectedPolicyIds = new Set(policyIds.map((id) => Number(id)).filter(Number.isFinite));
    const now = new Date().toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('PRAGMA defer_foreign_keys = ON');
      if (user) upsertUser(db, user);
      if (sms) upsertSmsCode(db, sms);
      if (session) upsertSession(db, session);
      if (pendingGuestId) {
        replaceFamilyProfiles(db, nextState);
        replaceFamilyReports(db, nextState);
        replaceReportRefreshEvents(db, nextState);
        db.prepare('DELETE FROM pending_scans WHERE guest_id = ?').run(pendingGuestId);
      }
      for (const policyId of affectedPolicyIds) {
        const policy = normalizeArray(nextState.policies).find((row) => Number(row?.id) === policyId);
        if (!policy) continue;
        upsertPolicy(db, policy);
        replaceSourceRecordsForPolicy(db, nextState, policy.id);
      }
      updateStateMeta(db, nextState, now);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  async function persistAuthLogout({ state, token = '' } = {}) {
    const nextState = { ...createInitialState(), ...state };
    nextState.nextId = resolveNextId(nextState);
    const now = new Date().toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      deleteSession(db, token);
      updateStateMeta(db, nextState, now);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  async function persistPolicyState({ state, policy = null, includeFamilyState = false } = {}) {
    if (!policy?.id) {
      await persist(state);
      return;
    }
    const nextState = { ...createInitialState(), ...state };
    nextState.nextId = resolveNextId(nextState);
    const now = new Date().toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('PRAGMA defer_foreign_keys = ON');
      upsertPolicy(db, policy);
      replaceSourceRecordsForPolicy(db, nextState, policy.id);
      if (includeFamilyState) {
        replaceFamilyProfiles(db, nextState);
        replaceFamilyReports(db, nextState);
        replaceReportRefreshEvents(db, nextState);
      }
      updateStateMeta(db, nextState, now);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  async function persistPolicyDelete({ state, policyId = 0 } = {}) {
    const nextState = { ...createInitialState(), ...state };
    nextState.nextId = resolveNextId(nextState);
    const now = new Date().toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      deletePolicy(db, policyId);
      updateStateMeta(db, nextState, now);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  async function persistMembershipState({
    state,
    order = null,
    membership = null,
    identity = null,
    oauthState = null,
  } = {}) {
    const nextState = { ...createInitialState(), ...state };
    nextState.nextId = resolveNextId(nextState);
    const now = new Date().toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      if (order) upsertMembershipOrder(db, order);
      if (membership) upsertMembership(db, membership);
      if (identity) upsertUserWechatIdentity(db, identity);
      if (oauthState) upsertWechatOAuthState(db, oauthState);
      updateStateMeta(db, nextState, now);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  async function persistPendingScan({ state, guestId = '' } = {}) {
    const pendingGuestId = String(guestId || '').trim();
    if (!pendingGuestId) {
      await persist(state);
      return;
    }
    const nextState = { ...createInitialState(), ...state };
    nextState.nextId = resolveNextId(nextState);
    const now = new Date().toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      replacePendingScan(db, nextState, pendingGuestId);
      updateStateMeta(db, nextState, now);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  async function persistFamilyState({ state, includePolicies = false } = {}) {
    const nextState = { ...createInitialState(), ...state };
    nextState.nextId = resolveNextId(nextState);
    const now = new Date().toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('PRAGMA defer_foreign_keys = ON');
      replaceFamilyProfiles(db, nextState);
      replaceFamilyReports(db, nextState);
      replaceFamilyReportShares(db, nextState);
      replaceFamilySalesReviews(db, nextState);
      replaceFamilySalesChats(db, nextState);
      replaceFamilySalesMemories(db, nextState);
      replaceReportRefreshEvents(db, nextState);
      if (includePolicies) {
        for (const policy of normalizeArray(nextState.policies)) {
          upsertPolicy(db, policy);
        }
      }
      updateStateMeta(db, nextState, now);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  async function persistFamilyReportState({ state } = {}) {
    const nextState = { ...createInitialState(), ...state };
    nextState.nextId = resolveNextId(nextState);
    const now = new Date().toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      replaceFamilyReports(db, nextState);
      replaceReportRefreshEvents(db, nextState);
      updateStateMeta(db, nextState, now);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  async function persistPolicyDerivedResult({ state, derivedResult = null } = {}) {
    const target = normalizePolicyDerivedResult(derivedResult);
    if (!target) return null;
    const nextState = { ...createInitialState(), ...state };
    nextState.nextId = resolveNextId(nextState);
    const now = new Date().toISOString();
    const row = { ...target, updatedAt: target.updatedAt || now };
    db.exec('BEGIN IMMEDIATE');
    try {
      upsertPolicyDerivedResultRow(db, row);
      updateStateMeta(db, nextState, now);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    if (state && typeof state === 'object') {
      state.policyDerivedResults = loadPayloadRows(db, 'policy_derived_results', 'policy_id ASC')
        .map((item) => normalizePolicyDerivedResult(item))
        .filter(Boolean);
    }
    return row;
  }

  async function persistProductCustomerResponsibilitySummary({ state, summary = null } = {}) {
    const target = normalizeProductCustomerResponsibilitySummary(summary || {});
    if (!target || target.status !== 'ready') return null;
    const nextState = { ...createInitialState(), ...state };
    nextState.nextId = resolveNextId(nextState);
    const now = new Date().toISOString();
    const row = { ...target, updatedAt: target.updatedAt || now };
    db.exec('BEGIN IMMEDIATE');
    try {
      upsertProductCustomerResponsibilitySummaryRow(db, row);
      updateStateMeta(db, nextState, now);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    if (state && typeof state === 'object') {
      state.productCustomerResponsibilitySummaries = loadPayloadRows(
        db,
        'product_customer_responsibility_summaries',
        'product_name ASC, summary_version ASC, id ASC',
      )
        .map((item) => normalizeProductCustomerResponsibilitySummary(item))
        .filter((item) => item && item.status === 'ready');
    }
    return row;
  }

  async function persistProductCustomerSummaryGenerationRun({ state, run = null } = {}) {
    const now = new Date().toISOString();
    const target = normalizeProductCustomerSummaryGenerationRun({ ...(run || {}), createdAt: run?.createdAt || now });
    if (!target) {
      throw new Error('Product customer summary generation run requires id, productKey, and summaryVersion');
    }
    const nextState = { ...createInitialState(), ...state };
    nextState.nextId = resolveNextId(nextState);
    db.exec('BEGIN IMMEDIATE');
    try {
      upsertProductCustomerSummaryGenerationRunRow(db, target);
      updateStateMeta(db, nextState, now);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    if (state && typeof state === 'object') {
      state.productCustomerSummaryGenerationRuns = loadProductCustomerSummaryGenerationRuns(db);
    }
    return target;
  }

  async function findProductCustomerResponsibilitySummary({
    productKey = '',
    summaryVersion = '',
    sourceDigest = '',
  } = {}) {
    const key = String(productKey || '').trim();
    const version = String(summaryVersion || '').trim();
    if (!key || !version) return null;
    const row = db.prepare(`
      SELECT payload
      FROM product_customer_responsibility_summaries
      WHERE product_key = ?
        AND summary_version = ?
        AND status = 'ready'
      LIMIT 1
    `).get(key, version);
    const summary = normalizeProductCustomerResponsibilitySummary(parseJson(row?.payload, null) || {});
    if (!summary) return null;
    const hasSummaryContent = Boolean(
      summary.summaryJson?.headline
        || normalizeArray(summary.summaryJson?.mainResponsibilities).some((item) =>
          item?.title || item?.plainText || item?.howItPays,
        ),
    );
    if (!hasSummaryContent) return null;
    const digest = String(sourceDigest || '').trim();
    if (digest && summary.sourceDigest !== digest) return null;
    return summary;
  }

  async function markPolicyDerivedResultsStaleByProductKeys({
    state,
    productKeys = [],
    staleReason = 'indicator_updated',
  } = {}) {
    const changedKeys = new Set(normalizeStringArray(productKeys));
    if (!changedKeys.size) return { policyIds: [] };
    const nextState = { ...createInitialState(), ...state };
    nextState.nextId = resolveNextId(nextState);
    const now = new Date().toISOString();
    const rows = loadPayloadRows(db, 'policy_derived_results', 'policy_id ASC')
      .map((item) => normalizePolicyDerivedResult(item))
      .filter(Boolean);
    const affectedRows = rows.filter((row) => row.productKeys.some((key) => changedKeys.has(key)));
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of affectedRows) {
        upsertPolicyDerivedResultRow(db, {
          ...row,
          status: 'stale',
          staleReason: String(staleReason || 'indicator_updated'),
          updatedAt: now,
        });
      }
      updateStateMeta(db, nextState, now);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    if (state && typeof state === 'object') {
      state.policyDerivedResults = loadPayloadRows(db, 'policy_derived_results', 'policy_id ASC')
        .map((item) => normalizePolicyDerivedResult(item))
        .filter(Boolean);
    }
    return { policyIds: affectedRows.map((row) => row.policyId) };
  }

  async function upsertProductIndicatorVersions({ state, productKeys = [], batchId = '' } = {}) {
    const keys = normalizeStringArray(productKeys);
    if (!keys.length) return { productKeys: [], rows: [] };
    const nextState = { ...createInitialState(), ...state };
    nextState.nextId = resolveNextId(nextState);
    const now = new Date().toISOString();
    const currentRows = loadPayloadRows(db, 'product_indicator_versions', 'product_key ASC')
      .map((item) => normalizeProductIndicatorVersion(item))
      .filter(Boolean);
    const currentByKey = new Map(currentRows.map((row) => [row.productKey, row]));
    const rows = keys.map((productKey) => {
      const current = currentByKey.get(productKey);
      return {
        productKey,
        version: (Number(current?.version || 0) || 0) + 1,
        batchId: String(batchId || ''),
        updatedAt: now,
      };
    });
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of rows) upsertProductIndicatorVersionRow(db, row);
      updateStateMeta(db, nextState, now);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    if (state && typeof state === 'object') {
      state.productIndicatorVersions = loadPayloadRows(db, 'product_indicator_versions', 'product_key ASC')
        .map((item) => normalizeProductIndicatorVersion(item))
        .filter(Boolean);
    }
    return { productKeys: keys, rows };
  }

  async function recordIndicatorUpdateBatch({ state, batch = {} } = {}) {
    const now = new Date().toISOString();
    const target = normalizeIndicatorUpdateBatch({
      ...batch,
      id: batch.id || `batch_${Date.now()}`,
      createdAt: batch.createdAt || now,
    });
    if (!target) return null;
    const nextState = { ...createInitialState(), ...state };
    nextState.nextId = resolveNextId(nextState);
    db.exec('BEGIN IMMEDIATE');
    try {
      upsertIndicatorUpdateBatchRow(db, target);
      updateStateMeta(db, nextState, now);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    if (state && typeof state === 'object') {
      state.indicatorUpdateBatches = loadPayloadRows(db, 'indicator_update_batches', 'created_at ASC, id ASC')
        .map((item) => normalizeIndicatorUpdateBatch(item))
        .filter(Boolean);
    }
    return target;
  }

  async function persistResponsibilityLookupArtifacts({
    state,
    knowledgeRecords = [],
    indicatorRecords = [],
    responsibilityCards = [],
  } = {}) {
    const nextState = { ...createInitialState(), ...state };
    nextState.nextId = resolveNextId(nextState);
    const now = new Date().toISOString();
    const normalizedKnowledgeRecords = [];
    for (const rawRecord of normalizeArray(knowledgeRecords)) {
      const record = normalizeKnowledgeRecord(rawRecord);
      if (!record) continue;
      if (!record.id) {
        record.id = Number(nextState.nextId || 1);
        nextState.nextId = record.id + 1;
      }
      normalizedKnowledgeRecords.push(record);
    }
    const normalizedIndicatorRecords = normalizeArray(indicatorRecords)
      .filter((record) => String(record?.id || '').trim());
    const normalizedCardRows = normalizeArray(responsibilityCards)
      .map((row) => normalizedProductResponsibilityCardRow(row))
      .filter(Boolean);
    const cardProductKeys = Array.from(new Set(normalizedCardRows.map((row) => row.productKey).filter(Boolean)));
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const record of normalizedKnowledgeRecords) upsertKnowledgeRecordRow(db, record);
      for (const record of normalizedIndicatorRecords) upsertInsuranceIndicatorRecordRow(db, record);
      for (const productKey of cardProductKeys) {
        db.prepare('DELETE FROM product_responsibility_cards WHERE product_key = ?').run(productKey);
      }
      for (const row of normalizedCardRows) upsertProductResponsibilityCardRow(db, row);
      updateStateMeta(db, nextState, now);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    if (state && typeof state === 'object') {
      state.knowledgeRecords = loadPayloadRows(db, 'knowledge_records', 'id ASC')
        .map((record) => normalizeKnowledgeRecord(record))
        .filter(Boolean);
      state.insuranceIndicatorRecords = loadPayloadRows(
        db,
        'insurance_indicator_records',
        'product_name ASC, coverage_type ASC, liability ASC, id ASC',
      );
      state.nextId = resolveNextId({ ...state, nextId: nextState.nextId });
    }
    return {
      knowledgeRecordCount: normalizedKnowledgeRecords.length,
      indicatorRecordCount: normalizedIndicatorRecords.length,
      responsibilityCardCount: normalizedCardRows.length,
      productKeys: cardProductKeys,
    };
  }

  async function load() {
    if (!getMeta(db, 'state_initialized_at')) {
      const seedState = await loadSeedState();
      await persist(seedState);
      return seedState;
    }
    const state = createInitialState();
    Object.assign(state, loadDbOwnedState(db));
    state.nextId = resolveNextId({ ...state, nextId: Number(getMeta(db, 'next_id') || 1) });
    return state;
  }

  function close() {
    db.close();
  }

  return {
    db,
    dbPath,
    seedStatePath,
    load,
    persist,
    persistAdminSession,
    persistDingtalkIdentityState,
    persistMembershipConfig,
    persistStateDocument,
    persistOfficialDomainProfiles,
    persistAuthSmsCode,
    persistAuthRegistration,
    persistAuthLogout,
    persistPolicyState,
    persistPolicyDelete,
    persistMembershipState,
    persistPolicyScanSave,
    persistPendingScan,
    persistFamilyState,
    persistFamilyReportState,
    persistAgentPolicyImportTask,
    findAgentPolicyImportTask,
    persistPolicyDerivedResult,
    persistProductCustomerResponsibilitySummary,
    persistProductCustomerSummaryGenerationRun,
    findProductCustomerResponsibilitySummary,
    markPolicyDerivedResultsStaleByProductKeys,
    upsertProductIndicatorVersions,
    recordIndicatorUpdateBatch,
    persistResponsibilityLookupArtifacts,
    close,
  };
}
