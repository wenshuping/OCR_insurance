import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createInitialState } from './policy-ocr.domain.mjs';
import { ensureCashflowTable, ensureCashValueTable } from './cashflow-store.mjs';
import { normalizeKnowledgeRecord } from './policy-knowledge.service.mjs';

const SCHEMA_VERSION = '2';

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
  'officialDomainProfiles',
  'familyProfiles',
  'familyMembers',
  'familyReportShares',
  'membershipConfig',
  'membershipOrders',
  'memberships',
  'userWechatIdentities',
  'wechatOAuthStates',
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
    maxNumericId(state.familyReportShares),
    maxNumericId(state.membershipOrders),
  );
  return Math.max(Number(state.nextId || 1), maxId + 1, 1);
}

function jsonPayload(value) {
  return JSON.stringify(value || {});
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

  const insertStateDocument = db.prepare(`
    INSERT INTO state_documents (key, payload)
    VALUES (?, ?)
  `);
  for (const [key, value] of Object.entries(state || {})) {
    if (DB_OWNED_KEYS.has(key) || RESERVED_STATE_KEYS.has(key)) continue;
    insertStateDocument.run(key, JSON.stringify(value));
  }
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

function replaceFamilyProfiles(db, state) {
  db.exec('DELETE FROM family_members; DELETE FROM family_profiles;');
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
    DELETE FROM official_domain_profiles;
    DELETE FROM membership_config;
    DELETE FROM membership_orders;
    DELETE FROM memberships;
    DELETE FROM user_wechat_identities;
    DELETE FROM wechat_oauth_states;
    DELETE FROM state_documents;
  `);
}

function loadPayloadRows(db, table, orderBy) {
  return db.prepare(`SELECT payload FROM ${table} ${orderBy ? `ORDER BY ${orderBy}` : ''}`)
    .all()
    .map((row) => parseJson(row.payload, null))
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
    officialDomainProfiles: loadPayloadRows(db, 'official_domain_profiles', 'id ASC'),
    familyProfiles: loadPayloadRows(db, 'family_profiles', 'id ASC'),
    familyMembers: loadPayloadRows(db, 'family_members', 'id ASC'),
    familyReportShares: loadPayloadRows(db, 'family_report_shares', 'created_at ASC, id ASC'),
    membershipConfig: parseJson(db.prepare('SELECT payload FROM membership_config WHERE id = 1').get()?.payload, null),
    membershipOrders: loadPayloadRows(db, 'membership_orders', 'id ASC'),
    memberships: loadPayloadRows(db, 'memberships', 'user_id ASC'),
    userWechatIdentities: loadPayloadRows(db, 'user_wechat_identities', 'user_id ASC, app_id ASC'),
    wechatOAuthStates: loadPayloadRows(db, 'wechat_oauth_states', 'created_at ASC, state ASC'),
  };
  state.knowledgeRecords = state.knowledgeRecords
    .map((record) => normalizeKnowledgeRecord(record))
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
      replaceFamilyReportShares(db, nextState);
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
    persistAuthSmsCode,
    persistAuthRegistration,
    persistPolicyScanSave,
    persistPendingScan,
    persistFamilyState,
    close,
  };
}
