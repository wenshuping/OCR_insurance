import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';
import {
  allocateId,
  assertValidMobile,
  attachPoliciesCoverageIndicators,
  attachPolicyCoverageIndicators,
  buildPolicyFromScan,
  birthdayFromIdNumber,
  createInitialState,
  createSession,
  deleteSession,
  findPolicyCoverageIndicators,
  findSessionUser,
  getBearerToken,
  latestValidSmsCode,
  normalizeGuestId,
  normalizeDateOnly,
  normalizeIdNumber,
  normalizePolicyPlans,
  normalizeMobile,
  normalizePolicyRelation,
  normalizePolicySources,
  publicUser,
} from './policy-ocr.domain.mjs';
import { scanPolicyWithConfiguredRuntime } from './ocr-runtime.mjs';
import { enhancePolicyScanWithOcrMapping } from './policy-ocr-mapping.mjs';
import { queryPolicyAndPlanResponsibilities, queryPolicyResponsibilities } from './policy-responsibility-query.mjs';
import { searchFeishuKnowledgeRecords } from './feishu-knowledge.service.mjs';
import {
  crawlOfficialKnowledge,
  findKnowledgeProductCandidates,
  normalizeKnowledgeRecord,
  upsertKnowledgeRecords,
} from './policy-knowledge.service.mjs';
import {
  getDefaultOfficialDomainProfiles,
  isPolicyOfficialSourceUrl,
  mergeOfficialDomainProfiles,
  normalizeOfficialDomainProfile,
} from './c-policy-analysis.service.mjs';
import { deliverSmsCode, resolveSmsDeliveryPlan } from './sms-delivery.mjs';
import { computePolicyCashflow, computeScenarioEntries } from './cashflow-compute.mjs';
import { findProductCashflowTemplate } from './cashflow-template.mjs';
import { createCashflowStore } from './cashflow-store.mjs';

const MAX_POLICY_UPLOAD_BYTES = 12 * 1024 * 1024;
const JSON_BODY_LIMIT = '24mb';
const MAX_SMS_PER_DAY_IN_PRODUCTION = 5;
const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const DEFAULT_OCR_SERVICE_URL = 'http://127.0.0.1:4105';
const WECHAT_TOKEN_CACHE_BUFFER_MS = 5 * 60 * 1000;

const wechatTokenCache = {
  accessToken: '',
  accessTokenExpiresAt: 0,
  jsapiTicket: '',
  jsapiTicketExpiresAt: 0,
};

function trim(value) {
  return String(value || '').trim();
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(Object(value), key);
}

function nowMs() {
  return Date.now();
}

function elapsedMs(startedAt) {
  return Math.max(0, nowMs() - startedAt);
}

function createPerformanceLogger(options = {}) {
  if (typeof options.performanceLogger === 'function') {
    return options.performanceLogger;
  }
  return (event) => {
    console.log(`[policy-ocr-perf] ${JSON.stringify(event)}`);
  };
}

function logPerformance(logger, event, payload = {}) {
  try {
    logger({
      event,
      ts: new Date().toISOString(),
      ...payload,
    });
  } catch {
    // Performance logging must never affect the policy flow.
  }
}

function codeFromError(error) {
  return String(error?.code || error?.message || 'INTERNAL_ERROR');
}

function statusFromError(error) {
  return Number(error?.status || 500);
}

function sendError(res, error, fallbackStatus = 500) {
  const code = codeFromError(error);
  const payload = {
    ok: false,
    code,
    message: error?.message && error.message !== code ? error.message : code,
  };
  if (error?.registrationRequiredNext) payload.registrationRequiredNext = true;
  return res.status(statusFromError(error) || fallbackStatus).json(payload);
}

function resolveWechatConfig() {
  return {
    appId: trim(process.env.WECHAT_H5_APP_ID || process.env.WECHAT_APP_ID),
    appSecret: trim(process.env.WECHAT_H5_APP_SECRET || process.env.WECHAT_APP_SECRET),
  };
}

function assertWechatConfigReady(config) {
  if (config.appId && config.appSecret) return;
  const error = new Error('微信公众号 JS-SDK 未配置');
  error.code = 'WECHAT_JS_SDK_NOT_CONFIGURED';
  error.status = 503;
  throw error;
}

async function fetchWechatJson(url) {
  const response = await fetch(url);
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload || payload.errcode) {
    const error = new Error(payload?.errmsg || `WECHAT_API_${response.status}`);
    error.code = payload?.errcode ? `WECHAT_API_${payload.errcode}` : 'WECHAT_API_FAILED';
    error.status = 502;
    throw error;
  }
  return payload;
}

async function getWechatAccessToken(config) {
  const now = nowMs();
  if (wechatTokenCache.accessToken && wechatTokenCache.accessTokenExpiresAt > now + WECHAT_TOKEN_CACHE_BUFFER_MS) {
    return wechatTokenCache.accessToken;
  }
  const url = new URL('https://api.weixin.qq.com/cgi-bin/token');
  url.searchParams.set('grant_type', 'client_credential');
  url.searchParams.set('appid', config.appId);
  url.searchParams.set('secret', config.appSecret);
  const payload = await fetchWechatJson(url);
  wechatTokenCache.accessToken = trim(payload.access_token);
  wechatTokenCache.accessTokenExpiresAt = now + Number(payload.expires_in || 7200) * 1000;
  wechatTokenCache.jsapiTicket = '';
  wechatTokenCache.jsapiTicketExpiresAt = 0;
  return wechatTokenCache.accessToken;
}

async function getWechatJsapiTicket(config) {
  const now = nowMs();
  if (wechatTokenCache.jsapiTicket && wechatTokenCache.jsapiTicketExpiresAt > now + WECHAT_TOKEN_CACHE_BUFFER_MS) {
    return wechatTokenCache.jsapiTicket;
  }
  const accessToken = await getWechatAccessToken(config);
  const url = new URL('https://api.weixin.qq.com/cgi-bin/ticket/getticket');
  url.searchParams.set('access_token', accessToken);
  url.searchParams.set('type', 'jsapi');
  const payload = await fetchWechatJson(url);
  wechatTokenCache.jsapiTicket = trim(payload.ticket);
  wechatTokenCache.jsapiTicketExpiresAt = now + Number(payload.expires_in || 7200) * 1000;
  return wechatTokenCache.jsapiTicket;
}

function normalizeWechatSignatureUrl(value) {
  const raw = trim(value).split('#')[0];
  if (!raw) {
    const error = new Error('缺少签名 URL');
    error.code = 'WECHAT_JS_SDK_URL_REQUIRED';
    error.status = 400;
    throw error;
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    const error = new Error('签名 URL 格式不正确');
    error.code = 'WECHAT_JS_SDK_URL_INVALID';
    error.status = 400;
    throw error;
  }
  if (!['https:', 'http:'].includes(parsed.protocol)) {
    const error = new Error('签名 URL 必须是 HTTP 或 HTTPS');
    error.code = 'WECHAT_JS_SDK_URL_INVALID';
    error.status = 400;
    throw error;
  }
  return raw;
}

async function createWechatJsSdkSignature(rawUrl) {
  const config = resolveWechatConfig();
  assertWechatConfigReady(config);
  const signedUrl = normalizeWechatSignatureUrl(rawUrl);
  const ticket = await getWechatJsapiTicket(config);
  const nonceStr = crypto.randomBytes(16).toString('hex');
  const timestamp = Math.floor(Date.now() / 1000);
  const stringToSign = [
    `jsapi_ticket=${ticket}`,
    `noncestr=${nonceStr}`,
    `timestamp=${timestamp}`,
    `url=${signedUrl}`,
  ].join('&');
  const signature = crypto.createHash('sha1').update(stringToSign).digest('hex');
  return {
    appId: config.appId,
    nonceStr,
    timestamp,
    signature,
    jsApiList: ['chooseImage', 'getLocalImgData'],
  };
}

function resolveAuthUser(req, state) {
  return findSessionUser(state, getBearerToken(req));
}

function requireAuth(req, res, state) {
  const user = resolveAuthUser(req, state);
  if (!user) {
    res.status(401).json({ ok: false, code: 'UNAUTHORIZED', message: '请先注册登录' });
    return null;
  }
  return user;
}

function resolveAdminPassword(options = {}) {
  const explicitPassword = trim(options.adminPassword || process.env.POLICY_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD);
  if (explicitPassword) return explicitPassword;
  if (process.env.NODE_ENV !== 'production') {
    return trim(process.env.P_OPS_API_KEY);
  }
  return '';
}

function createAdminSession(state) {
  const now = new Date();
  const session = {
    token: crypto.randomUUID(),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ADMIN_SESSION_TTL_MS).toISOString(),
  };
  state.adminSessions.push(session);
  return session.token;
}

function findAdminSession(state, token) {
  const normalized = String(token || '').trim();
  if (!normalized) return null;
  return (state.adminSessions || []).find(
    (row) => String(row.token || '') === normalized && new Date(row.expiresAt).getTime() > Date.now(),
  ) || null;
}

function requireAdmin(req, res, state, adminPassword) {
  if (!adminPassword) {
    res.status(503).json({ ok: false, code: 'ADMIN_PASSWORD_NOT_CONFIGURED', message: '后台密码未配置' });
    return null;
  }
  const session = findAdminSession(state, getBearerToken(req));
  if (!session) {
    res.status(401).json({ ok: false, code: 'ADMIN_UNAUTHORIZED', message: '请先登录管理后台' });
    return null;
  }
  return session;
}

function resolveOcrServiceUrl(env = process.env) {
  return trim(env.POLICY_OCR_SERVICE_URL || env.POLICY_OCR_LOCAL_SERVICE_URL || DEFAULT_OCR_SERVICE_URL).replace(/\/+$/, '');
}

function buildOcrServiceHeaders(env = process.env) {
  const headers = { 'content-type': 'application/json', 'x-internal-service': 'policy-ocr-app' };
  const token = trim(env.POLICY_OCR_SERVICE_TOKEN);
  if (token) headers['x-ocr-service-token'] = token;
  return headers;
}

async function requestOcrServiceConfig({ method = 'GET', body } = {}) {
  const baseUrl = resolveOcrServiceUrl();
  if (!baseUrl) {
    const error = new Error('OCR 服务地址未配置');
    error.code = 'POLICY_OCR_SERVICE_NOT_CONFIGURED';
    error.status = 503;
    throw error;
  }
  let response;
  try {
    response = await fetch(`${baseUrl}/internal/ocr-service/config`, {
      method,
      headers: buildOcrServiceHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    const error = new Error('OCR 服务未连接，无法读取识别方式配置');
    error.code = 'POLICY_OCR_SERVICE_UNAVAILABLE';
    error.status = 503;
    throw error;
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(payload?.message || payload?.code || 'OCR 识别方式配置失败');
    error.code = payload?.code || 'POLICY_OCR_CONFIG_FAILED';
    error.status = response.status;
    throw error;
  }
  return payload;
}

function defaultCodeGenerator() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function localSmsDeliveryPlanResolver(codeGenerator) {
  return ({ mobile }) => ({
    mobile,
    code: codeGenerator(),
    deliveryMode: 'mock',
    exposeDevCode: true,
  });
}

function isoDateOnly(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

function assertSmsSendAllowed(state, mobile) {
  if (process.env.NODE_ENV !== 'production') return;
  const today = isoDateOnly();
  const sentToday = state.smsCodes.filter(
    (row) => String(row.mobile || '') === mobile && isoDateOnly(row.createdAt) === today,
  ).length;
  if (sentToday >= MAX_SMS_PER_DAY_IN_PRODUCTION) {
    const error = new Error('今日验证码次数已达上限');
    error.code = 'SMS_LIMIT_REACHED';
    error.status = 429;
    throw error;
  }
}

function hasPendingSmsCode(state, mobile) {
  const normalizedMobile = normalizeMobile(mobile);
  return (state.smsCodes || []).some(
    (row) =>
      String(row.mobile || '') === normalizedMobile &&
      !row.used &&
      new Date(row.expiresAt).getTime() > Date.now(),
  );
}

function normalizeSmsSendError(error) {
  const code = codeFromError(error);
  if (code === 'SMS_PROVIDER_NOT_READY' || code === 'SMS_MODE_NOT_ALLOWED') {
    const next = new Error('短信服务未配置，请联系管理员');
    next.code = code;
    next.status = 503;
    return next;
  }
  if (code === 'SMS_DELIVERY_FAILED') {
    const next = new Error('验证码发送失败，请稍后重试');
    next.code = code;
    next.status = String(error?.providerResponseCode || '').trim() === 'isv.BUSINESS_LIMIT_CONTROL' ? 429 : 424;
    return next;
  }
  return error;
}

function normalizeManualPolicyData(value) {
  if (!value || typeof value !== 'object') return {};
  const data = {};
  for (const key of ['company', 'name', 'applicant', 'beneficiary', 'insured', 'date', 'paymentPeriod', 'coveragePeriod']) {
    const text = String(value[key] || '').trim();
    if (text) data[key] = text;
  }
  const insuredIdNumber = normalizeIdNumber(value.insuredIdNumber || value.insuredIdentityNumber || value.insuredIdCard);
  if (insuredIdNumber) data.insuredIdNumber = insuredIdNumber;
  const insuredBirthday = normalizeDateOnly(value.insuredBirthday || value.insuredBirthDate) || birthdayFromIdNumber(insuredIdNumber);
  if (insuredBirthday) data.insuredBirthday = insuredBirthday;
  for (const key of ['applicantRelation', 'insuredRelation']) {
    const relation = normalizePolicyRelation(value[key]);
    if (relation) data[key] = relation;
  }
  for (const key of ['amount', 'firstPremium']) {
    const amount = Number(value[key] || 0);
    if (Number.isFinite(amount) && amount > 0) data[key] = amount;
  }
  if (Array.isArray(value.plans)) {
    const plans = value.plans
      .map((plan) => ({
        company: trim(plan?.company),
        role: trim(plan?.role),
        name: trim(plan?.name || plan?.productName),
        matchedProductName: trim(plan?.matchedProductName),
        productType: trim(plan?.productType),
        amount: Number(plan?.amount || 0) || 0,
        coveragePeriod: trim(plan?.coveragePeriod),
        paymentMode: trim(plan?.paymentMode),
        paymentPeriod: trim(plan?.paymentPeriod),
        premium: Number(plan?.premium || plan?.firstPremium || 0) || 0,
        premiumText: trim(plan?.premiumText),
        matchScore: Number(plan?.matchScore || 0) || 0,
        matchReason: trim(plan?.matchReason),
      }))
      .filter((plan) => plan.name || plan.matchedProductName);
    if (plans.length) data.plans = plans;
  }
  return data;
}

function normalizePolicyUpdateData(value, existingPolicy = {}) {
  if (!value || typeof value !== 'object') return {};
  const input = value.policy && typeof value.policy === 'object' ? value.policy : value;
  const data = {};
  const textFields = ['company', 'name', 'applicant', 'beneficiary', 'insured', 'paymentPeriod', 'coveragePeriod'];
  for (const key of textFields) {
    if (hasOwn(input, key)) data[key] = trim(input[key]);
  }
  if (hasOwn(input, 'date')) data.date = normalizeDateOnly(input.date) || trim(input.date);
  if (hasOwn(input, 'insuredIdNumber') || hasOwn(input, 'insuredIdentityNumber') || hasOwn(input, 'insuredIdCard')) {
    data.insuredIdNumber = normalizeIdNumber(input.insuredIdNumber || input.insuredIdentityNumber || input.insuredIdCard);
  }
  if (hasOwn(input, 'insuredBirthday') || hasOwn(input, 'insuredBirthDate')) {
    data.insuredBirthday = normalizeDateOnly(input.insuredBirthday || input.insuredBirthDate);
  }
  for (const key of ['applicantRelation', 'insuredRelation']) {
    if (hasOwn(input, key)) data[key] = normalizePolicyRelation(input[key]);
  }
  for (const key of ['amount', 'firstPremium']) {
    if (!hasOwn(input, key)) continue;
    const amount = Number(input[key] || 0);
    if (!Number.isFinite(amount) || amount < 0) {
      const error = new Error(`${key} 格式不正确`);
      error.code = 'INVALID_POLICY_AMOUNT';
      error.status = 400;
      throw error;
    }
    data[key] = amount;
  }
  if (hasOwn(input, 'plans')) {
    data.plans = normalizePolicyPlans(input.plans, data.company || existingPolicy.company || '');
  }
  if (hasOwn(data, 'company') && !data.company) {
    const error = new Error('保险公司不能为空');
    error.code = 'POLICY_COMPANY_REQUIRED';
    error.status = 400;
    throw error;
  }
  if (hasOwn(data, 'name') && !data.name) {
    const error = new Error('保险产品名称不能为空');
    error.code = 'POLICY_NAME_REQUIRED';
    error.status = 400;
    throw error;
  }
  return data;
}

function policyProductIdentity(policy = {}) {
  const planIdentity = (Array.isArray(policy.plans) ? policy.plans : [])
    .map((plan) =>
      [
        trim(plan?.company || policy.company),
        trim(plan?.matchedProductName || plan?.name || plan?.productName),
        trim(plan?.role),
      ].join('::'),
    )
    .filter(Boolean)
    .join('||');
  return [trim(policy.company), trim(policy.name), planIdentity].join('##');
}

function clearPolicyReportForRegeneration(state, policy) {
  policy.responsibilities = [];
  policy.report = '';
  policy.sources = [];
  policy.reportStatus = 'generating';
  policy.reportError = '';
  if (Array.isArray(state.sourceRecords)) {
    state.sourceRecords = state.sourceRecords.filter((row) => Number(row.policyId) !== Number(policy.id));
  }
}

function normalizeResponsibilityQueryInput(value = {}) {
  const company = trim(value?.company).slice(0, 80);
  const name = trim(value?.name).slice(0, 160);
  if (!company || !name) {
    const error = new Error('请输入保险公司和保险名称');
    error.code = 'POLICY_RESPONSIBILITY_QUERY_INPUT_REQUIRED';
    error.status = 400;
    throw error;
  }
  return { company, name };
}

function policyInputMetrics(body = {}) {
  return {
    uploadBytes: Number(body?.uploadItem?.size || 0) || 0,
    hasUpload: Boolean(body?.uploadItem),
    inputOcrChars: String(body?.ocrText || '').length,
    hasProvidedScan: Boolean(body?.scan),
    hasProvidedAnalysis: Boolean(body?.analysis),
  };
}

function finiteNonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : 0;
}

function sanitizeClientPerformancePayload(body = {}) {
  const event = trim(body?.event).replace(/[^\w.-]/g, '').slice(0, 80) || 'client.unknown';
  return {
    event,
    source: trim(body?.source).replace(/[^\w.-]/g, '').slice(0, 60) || 'client',
    durationMs: finiteNonNegativeNumber(body?.durationMs),
    fileReadMs: finiteNonNegativeNumber(body?.fileReadMs),
    imageDecodeMs: finiteNonNegativeNumber(body?.imageDecodeMs),
    imageCompressMs: finiteNonNegativeNumber(body?.imageCompressMs),
    requestMs: finiteNonNegativeNumber(body?.requestMs),
    originalBytes: finiteNonNegativeNumber(body?.originalBytes),
    uploadBytes: finiteNonNegativeNumber(body?.uploadBytes),
    outputOcrChars: finiteNonNegativeNumber(body?.outputOcrChars),
    responsibilityCount: finiteNonNegativeNumber(body?.responsibilityCount),
    hasUpload: Boolean(body?.hasUpload),
    usedUpload: Boolean(body?.usedUpload),
    reusedScan: Boolean(body?.reusedScan),
    reusedAnalysis: Boolean(body?.reusedAnalysis),
    page: trim(body?.page).slice(0, 120),
    networkType: trim(body?.networkType).slice(0, 30),
    userAgentKind: trim(body?.userAgentKind).slice(0, 30),
    errorCode: trim(body?.errorCode).replace(/[^\w.-]/g, '').slice(0, 80),
    errorMessage: trim(body?.errorMessage).slice(0, 180),
  };
}

function buildAdminOverview(state) {
  const usersById = new Map((state.users || []).map((user) => [Number(user.id), user]));
  const sourceRecords = (state.sourceRecords || [])
    .map((record) => ({ ...record }))
    .sort((a, b) => String(b.lastUsedAt || b.discoveredAt || '').localeCompare(String(a.lastUsedAt || a.discoveredAt || '')));
  const sourceRecordsByPolicyId = new Map();
  for (const record of sourceRecords) {
    const key = Number(record.policyId || 0);
    const list = sourceRecordsByPolicyId.get(key) || [];
    list.push(record);
    sourceRecordsByPolicyId.set(key, list);
  }
  const policyRows = (state.policies || [])
    .map((policy) => {
      const user = usersById.get(Number(policy.userId)) || null;
      const policySources = normalizePolicySources(
        Array.isArray(policy.sources) && policy.sources.length
          ? policy.sources
          : sourceRecordsByPolicyId.get(Number(policy.id)) || [],
      );
      return {
        ...policy,
        sources: policySources,
        userMobile: user?.mobile || '',
      };
    })
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));

  const users = (state.users || [])
    .map((user) => {
      const policies = policyRows.filter((policy) => Number(policy.userId) === Number(user.id));
      const insuredNames = new Set(policies.map((policy) => String(policy.insured || '').trim() || '未识别被保人'));
      return {
        id: Number(user.id),
        mobile: String(user.mobile || ''),
        createdAt: user.createdAt,
        policyCount: policies.length,
        insuredCount: insuredNames.size,
        totalCoverage: policies.reduce((sum, policy) => sum + Number(policy.amount || 0), 0),
        annualPremium: policies.reduce((sum, policy) => sum + Number(policy.firstPremium || 0), 0),
      };
    })
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));

  const insuredMap = new Map();
  for (const policy of policyRows) {
    const userId = Number(policy.userId || 0);
    const insured = String(policy.insured || '').trim() || '未识别被保人';
    const key = `${userId}:${insured}`;
    const existing = insuredMap.get(key) || {
      key,
      userId,
      userMobile: policy.userMobile || '',
      insured,
      policyCount: 0,
      totalCoverage: 0,
      annualPremium: 0,
    };
    existing.policyCount += 1;
    existing.totalCoverage += Number(policy.amount || 0);
    existing.annualPremium += Number(policy.firstPremium || 0);
    insuredMap.set(key, existing);
  }

  return {
    users,
    insureds: [...insuredMap.values()].sort((a, b) => b.policyCount - a.policyCount || a.insured.localeCompare(b.insured)),
    policies: attachPoliciesCoverageIndicators(policyRows, state.insuranceIndicatorRecords),
    sourceRecords,
    summary: {
      userCount: users.length,
      insuredCount: insuredMap.size,
      policyCount: policyRows.length,
      sourceRecordCount: sourceRecords.length,
      knowledgeRecordCount: Array.isArray(state.knowledgeRecords) ? state.knowledgeRecords.length : 0,
      totalCoverage: policyRows.reduce((sum, policy) => sum + Number(policy.amount || 0), 0),
      annualPremium: policyRows.reduce((sum, policy) => sum + Number(policy.firstPremium || 0), 0),
    },
  };
}

function parseProfileList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || '').trim()).filter(Boolean);
  return String(value || '')
    .split(/[\n,，;；\s]+/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildEffectiveOfficialDomainProfiles(state) {
  return mergeOfficialDomainProfiles(state.officialDomainProfiles || []);
}

function buildAdminOfficialDomainProfiles(state) {
  const customIds = new Set((state.officialDomainProfiles || []).map((profile) => String(profile.id || '')));
  return buildEffectiveOfficialDomainProfiles(state)
    .map((profile) => ({
      ...profile,
      source: customIds.has(profile.id) ? 'custom' : 'system',
    }))
    .sort((left, right) => {
      if (left.source !== right.source) return left.source === 'custom' ? -1 : 1;
      return String(left.company || '').localeCompare(String(right.company || ''), 'zh-CN');
    });
}

function normalizeAdminOfficialDomainProfileInput(state, body = {}, id = '') {
  const profile = normalizeOfficialDomainProfile({
    id: id || body.id || `custom_${allocateId(state)}`,
    company: body.company,
    aliases: parseProfileList(body.aliases),
    companyAliases: parseProfileList(body.companyAliases),
    siteDomains: parseProfileList(body.siteDomains),
    officialDomains: parseProfileList(body.officialDomains || body.domains),
  });
  if (!profile) {
    const error = new Error('请填写保险公司名称和至少一个官方域名');
    error.code = 'OFFICIAL_DOMAIN_PROFILE_INVALID';
    error.status = 400;
    throw error;
  }
  return {
    ...profile,
    updatedAt: new Date().toISOString(),
    createdAt: String(body.createdAt || new Date().toISOString()),
  };
}

function normalizeAdminKnowledgeCrawlInput(body = {}) {
  const company = trim(body.company);
  const name = trim(body.name || body.productName);
  if (!company || !name) {
    const error = new Error('请填写保险公司和产品名称');
    error.code = 'KNOWLEDGE_CRAWL_POLICY_REQUIRED';
    error.status = 400;
    throw error;
  }
  return { company, name };
}

function buildAdminKnowledgeRecords(state) {
  const officialDomainProfiles = buildEffectiveOfficialDomainProfiles(state);
  return (state.knowledgeRecords || [])
    .map((record) => normalizeKnowledgeRecord(record, { officialDomainProfiles }))
    .filter(Boolean)
    .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));
}

function normalizeSuggestionText(value) {
  return trim(value).replace(/\s+/gu, '').toLowerCase();
}

function buildResponsibilityCompanySuggestions(state, query = '', maxResults = 12) {
  const normalizedQuery = normalizeSuggestionText(query);
  const stats = new Map();
  const addCompany = (company, weight = 1) => {
    const name = trim(company);
    if (!name) return;
    const current = stats.get(name) || { company: name, recordCount: 0 };
    current.recordCount += weight;
    stats.set(name, current);
  };
  for (const record of state.knowledgeRecords || []) addCompany(record.company, 1);
  for (const policy of state.policies || []) addCompany(policy.company, 1);
  for (const profile of buildEffectiveOfficialDomainProfiles(state)) addCompany(profile.company, 0);

  return [...stats.values()]
    .map((item) => {
      const normalizedCompany = normalizeSuggestionText(item.company);
      const matchIndex = normalizedQuery ? normalizedCompany.indexOf(normalizedQuery) : 0;
      return {
        ...item,
        matchIndex,
        exact: normalizedQuery && normalizedCompany === normalizedQuery,
        startsWith: normalizedQuery && normalizedCompany.startsWith(normalizedQuery),
      };
    })
    .filter((item) => !normalizedQuery || item.matchIndex >= 0)
    .sort(
      (left, right) =>
        Number(right.exact) - Number(left.exact) ||
        Number(right.startsWith) - Number(left.startsWith) ||
        left.matchIndex - right.matchIndex ||
        right.recordCount - left.recordCount ||
        left.company.localeCompare(right.company, 'zh-CN'),
    )
    .slice(0, maxResults)
    .map(({ company, recordCount }) => ({ company, recordCount }));
}

function buildResponsibilityProductSuggestions(state, { company = '', query = '', maxResults = 12 } = {}) {
  const normalizedCompany = normalizeSuggestionText(company);
  if (!normalizedCompany) return [];
  const normalizedQuery = normalizeSuggestionText(query);
  const stats = new Map();
  const addProduct = (recordCompany, productName, weight = 1) => {
    const sourceCompany = trim(recordCompany);
    const name = trim(productName);
    if (!sourceCompany || !name) return;
    const sourceCompanyKey = normalizeSuggestionText(sourceCompany);
    const companyMatches =
      sourceCompanyKey === normalizedCompany ||
      sourceCompanyKey.includes(normalizedCompany) ||
      normalizedCompany.includes(sourceCompanyKey);
    if (!companyMatches) return;
    const key = `${sourceCompany}\u001f${name}`;
    const current = stats.get(key) || { company: sourceCompany, productName: name, recordCount: 0 };
    current.recordCount += weight;
    stats.set(key, current);
  };
  for (const record of state.knowledgeRecords || []) addProduct(record.company, record.productName || record.title, 1);
  for (const policy of state.policies || []) addProduct(policy.company, policy.name, 1);

  return [...stats.values()]
    .map((item) => {
      const normalizedProduct = normalizeSuggestionText(item.productName);
      const matchIndex = normalizedQuery ? normalizedProduct.indexOf(normalizedQuery) : 0;
      return {
        ...item,
        matchIndex,
        exact: normalizedQuery && normalizedProduct === normalizedQuery,
        startsWith: normalizedQuery && normalizedProduct.startsWith(normalizedQuery),
      };
    })
    .filter((item) => !normalizedQuery || item.matchIndex >= 0)
    .sort(
      (left, right) =>
        Number(right.exact) - Number(left.exact) ||
        Number(right.startsWith) - Number(left.startsWith) ||
        left.matchIndex - right.matchIndex ||
        right.recordCount - left.recordCount ||
        left.productName.localeCompare(right.productName, 'zh-CN'),
    )
    .slice(0, maxResults)
    .map(({ company: itemCompany, productName, recordCount }) => ({ company: itemCompany, productName, recordCount }));
}

function assertUploadItemSize(uploadItem) {
  const size = Number(uploadItem?.size || 0);
  if (Number.isFinite(size) && size > MAX_POLICY_UPLOAD_BYTES) {
    const error = new Error('图片太大，请压缩到 12MB 以内后重新上传');
    error.code = 'POLICY_OCR_FILE_TOO_LARGE';
    error.status = 413;
    throw error;
  }
}

function countGuestSavedPolicies(state, guestId) {
  if (!guestId) return 0;
  return (state.policies || []).filter((policy) => String(policy.guestId || '') === guestId && !policy.userId).length;
}

function guestRegistrationRequiredNext({ state, user, guestId }) {
  return !user && Boolean(guestId) && countGuestSavedPolicies(state, guestId) >= 1;
}

function assertGuestCanScan({ state, user, guestId }) {
  if (user) return;
  if (!guestId) {
    const error = new Error('缺少游客标识');
    error.code = 'GUEST_ID_REQUIRED';
    error.status = 400;
    throw error;
  }
  if (countGuestSavedPolicies(state, guestId) >= 1) {
    const error = new Error('第二次录入保单需要先完成手机验证码');
    error.code = 'REGISTRATION_REQUIRED';
    error.status = 401;
    error.registrationRequiredNext = true;
    throw error;
  }
}

function guestPendingScans(state, guestId) {
  if (!guestId) return [];
  return (state.pendingScans || []).filter((row) => String(row.guestId || '') === guestId);
}

function storeGuestPendingScan(state, { guestId, scan, analysis = null }) {
  if (!guestId) return;
  const now = new Date().toISOString();
  const existing = guestPendingScans(state, guestId)[0] || null;
  if (existing) {
    existing.scan = scan;
    existing.analysis = analysis;
    existing.updatedAt = now;
    return;
  }
  state.pendingScans.push({
    id: allocateId(state),
    guestId,
    scan,
    analysis,
    createdAt: now,
    updatedAt: now,
  });
}

function clearGuestPendingScans(state, guestId) {
  if (!guestId) return;
  state.pendingScans = (state.pendingScans || []).filter((row) => String(row.guestId || '') !== guestId);
}

function mergeManualPolicyDataIntoScan(scan, body) {
  const manualData = normalizeManualPolicyData(body?.manualData);
  return {
    ...scan,
    data: {
      ...(scan?.data || {}),
      ...manualData,
    },
  };
}

async function recognizePolicyInput({ scanner, body, state, applyManualData = true }) {
  assertUploadItemSize(body?.uploadItem || null);
  const scan = await scanner({
    uploadItem: body?.uploadItem || null,
    ocrText: body?.ocrText || '',
  });
  const scanWithText = {
    ...scan,
    ocrText: String(scan?.ocrText || body?.ocrText || '').trim(),
  };
  const mappedScan = enhancePolicyScanWithOcrMapping({ scan: scanWithText, state });
  return applyManualData ? mergeManualPolicyDataIntoScan(mappedScan, body) : mappedScan;
}

function normalizeProvidedScan(body, state) {
  const scan = body?.scan && typeof body.scan === 'object' ? body.scan : null;
  if (!scan) return null;
  const scanWithText = {
    ...scan,
    ocrText: String(scan.ocrText || body?.ocrText || '').trim(),
  };
  const mappedScan = enhancePolicyScanWithOcrMapping({ scan: scanWithText, state });
  return mergeManualPolicyDataIntoScan({
    ...mappedScan,
    ocrText: String(mappedScan.ocrText || '').trim(),
  }, body);
}

async function resolvePolicyScanInput({ scanner, body, state }) {
  assertUploadItemSize(body?.uploadItem || null);
  const providedScan = normalizeProvidedScan(body, state);
  if (providedScan) return providedScan;
  return recognizePolicyInput({ scanner, body, state });
}

function normalizeProvidedAnalysis(value) {
  if (!value || typeof value !== 'object') return null;
  const coverageTable = Array.isArray(value.coverageTable)
    ? value.coverageTable
        .map((row) => ({
          coverageType: String(row?.coverageType || '').trim(),
          scenario: String(row?.scenario || '').trim(),
          payout: String(row?.payout || '').trim(),
          note: String(row?.note || '').trim(),
        }))
        .filter((row) => row.coverageType || row.scenario || row.payout || row.note)
    : [];
  const report = String(value.report || '').trim();
  if (!report && !coverageTable.length) return null;
  return {
    ...value,
    report,
    coverageTable,
    sources: normalizePolicySources(value.sources),
  };
}

function recordPolicySourceRecords(state, policy, analysis) {
  const sources = normalizePolicySources(analysis?.sources || policy?.sources);
  if (!state || !policy || !sources.length) return;
  if (!Array.isArray(state.sourceRecords)) state.sourceRecords = [];
  const officialDomainProfiles = buildEffectiveOfficialDomainProfiles(state);
  const acceptedSources = sources.filter((source) => {
    const claimsInsurerOfficial = Boolean(source.official) || String(source.evidenceLevel || '') === 'insurer_official';
    if (!claimsInsurerOfficial) return true;
    return isPolicyOfficialSourceUrl(
      source.url,
      {
        company: String(source.company || policy.company || '').trim(),
        name: String(source.productName || policy.name || '').trim(),
      },
      officialDomainProfiles,
    );
  });
  if (!acceptedSources.length) return;
  const now = new Date().toISOString();
  for (const source of acceptedSources) {
    const sourceCompany = String(source.company || policy.company || '').trim();
    const sourceProductName = String(source.productName || policy.name || '').trim();
    const existing = state.sourceRecords.find(
      (row) => Number(row.policyId) === Number(policy.id) && String(row.url || '') === source.url,
    );
    if (existing) {
      existing.title = source.title || existing.title;
      existing.snippet = source.snippet || existing.snippet;
      existing.evidenceLabel = source.evidenceLabel || existing.evidenceLabel;
      existing.evidenceLevel = source.evidenceLevel || existing.evidenceLevel;
      existing.official = Boolean(source.official);
      existing.sourceType = source.sourceType || existing.sourceType;
      existing.company = sourceCompany || existing.company;
      existing.productName = sourceProductName || existing.productName;
      existing.lastUsedAt = now;
      existing.useCount = Number(existing.useCount || 0) + 1;
      continue;
    }
    state.sourceRecords.push({
      id: allocateId(state),
      policyId: Number(policy.id),
      company: sourceCompany,
      productName: sourceProductName,
      title: source.title,
      url: source.url,
      snippet: source.snippet,
      evidenceLabel: source.evidenceLabel,
      evidenceLevel: source.evidenceLevel,
      official: Boolean(source.official),
      sourceType: source.sourceType,
      discoveredAt: now,
      lastUsedAt: now,
      useCount: 1,
    });
  }
  upsertKnowledgeRecords(
    state,
    acceptedSources
      .filter(
        (source) => {
          const sourceCompany = String(source.company || policy.company || '').trim();
          const sourceProductName = String(source.productName || policy.name || '').trim();
          return (
            (Boolean(source.official) || String(source.evidenceLevel || '') === 'insurer_official') &&
            isPolicyOfficialSourceUrl(
              source.url,
              { company: sourceCompany, name: sourceProductName },
              officialDomainProfiles,
            )
          );
        },
      )
      .map((source) => ({
        company: String(source.company || policy.company || '').trim(),
        productName: String(source.productName || policy.name || '').trim(),
        title: source.title,
        url: source.url,
        snippet: source.snippet,
        sourceType: source.sourceType,
        materialType: source.sourceType === 'pdf' ? 'pdf' : '',
        official: true,
        evidenceLabel: source.evidenceLabel || '保险公司官方资料',
        evidenceLevel: source.evidenceLevel || 'insurer_official',
        parser: 'analysis_source',
        lastUsedAt: new Date().toISOString(),
        useCount: 1,
      })),
    {
      allocateId,
      officialDomainProfiles,
    },
  );
}

function applyAnalysisToPolicy(policy, analysis) {
  const normalized = normalizeProvidedAnalysis(analysis);
  if (!policy || !normalized) return false;
  policy.responsibilities = normalized.coverageTable.map((row) => ({
    coverageType: String(row.coverageType || '').trim() || '保险责任',
    scenario: String(row.scenario || '').trim() || '以条款约定为准',
    payout: String(row.payout || '').trim() || '以正式条款为准',
    note: String(row.note || '').trim(),
  }));
  policy.report = String(normalized.report || '').trim();
  policy.sources = normalizePolicySources(normalized.sources);
  policy.reportStatus = 'ready';
  policy.reportError = '';
  policy.updatedAt = new Date().toISOString();
  return true;
}

function markPolicyReportFailed(policy, error) {
  if (!policy) return;
  policy.reportStatus = 'failed';
  policy.reportError = error instanceof Error ? error.message : '报告生成失败';
  policy.updatedAt = new Date().toISOString();
}

function startPolicyReportGeneration({ state, policy, scan, analyzer, persist, performanceLogger, requestMetrics = {} }) {
  if (!policy || policy.reportStatus === 'ready') return;
  void (async () => {
    const analysisStartedAt = nowMs();
    try {
      const analysis = await analyzer({ scan });
      if (!applyAnalysisToPolicy(policy, analysis)) {
        throw new Error('报告生成结果为空');
      }
      recordPolicySourceRecords(state, policy, analysis);
      await persist();
      logPerformance(performanceLogger, 'policy.report.background.analysis', {
        route: 'background',
        durationMs: elapsedMs(analysisStartedAt),
        ...requestMetrics,
        outputOcrChars: String(scan?.ocrText || '').length,
        responsibilityCount: Array.isArray(analysis?.coverageTable) ? analysis.coverageTable.length : 0,
        policyId: policy.id,
      });
    } catch (error) {
      markPolicyReportFailed(policy, error);
      await persist();
      logPerformance(performanceLogger, 'policy.report.background.failed', {
        route: 'background',
        durationMs: elapsedMs(analysisStartedAt),
        ...requestMetrics,
        outputOcrChars: String(scan?.ocrText || '').length,
        policyId: policy.id,
      });
    }
  })();
}

function buildPolicyReportScan(policy) {
  return {
    ocrText: String(policy?.ocrText || '').trim(),
    data: {
      company: policy?.company || '',
      name: policy?.name || '',
      applicant: policy?.applicant || '',
      beneficiary: policy?.beneficiary || '',
      applicantRelation: policy?.applicantRelation || '',
      insured: policy?.insured || '',
      insuredRelation: policy?.insuredRelation || '',
      insuredIdNumber: policy?.insuredIdNumber || '',
      insuredBirthday: policy?.insuredBirthday || '',
      date: policy?.date || '',
      paymentPeriod: policy?.paymentPeriod || '',
      coveragePeriod: policy?.coveragePeriod || '',
      amount: policy?.amount || 0,
      firstPremium: policy?.firstPremium || 0,
      plans: Array.isArray(policy?.plans) ? policy.plans : [],
    },
  };
}

function findPolicyForReportRequest(req, state, adminPassword) {
  const id = Number(req.params?.id || 0);
  const token = getBearerToken(req);
  const adminSession = adminPassword ? findAdminSession(state, token) : null;
  const user = resolveAuthUser(req, state);
  const guestId = normalizeGuestId(req.query?.guestId || req.body?.guestId);
  if (!adminSession && !user && !guestId) {
    return {
      status: 401,
      payload: { ok: false, code: 'UNAUTHORIZED', message: '缺少登录信息或游客标识' },
    };
  }
  const policy = (state.policies || []).find((row) => {
    if (Number(row.id) !== id) return false;
    if (adminSession) return true;
    if (user) return Number(row.userId) === Number(user.id);
    return String(row.guestId || '') === guestId && !row.userId;
  });
  if (!policy) {
    return {
      status: 404,
      payload: { ok: false, code: 'POLICY_NOT_FOUND', message: '保单不存在' },
    };
  }
  return { policy };
}

export function createPolicyOcrApp(options = {}) {
  const state = options.state || createInitialState();
  if (!Array.isArray(state.users)) state.users = [];
  if (!Array.isArray(state.sessions)) state.sessions = [];
  if (!Array.isArray(state.adminSessions)) state.adminSessions = [];
  if (!Array.isArray(state.smsCodes)) state.smsCodes = [];
  if (!Array.isArray(state.policies)) state.policies = [];
  if (!Array.isArray(state.pendingScans)) state.pendingScans = [];
  if (!Array.isArray(state.sourceRecords)) state.sourceRecords = [];
  if (!Array.isArray(state.knowledgeRecords)) state.knowledgeRecords = [];
  if (!Array.isArray(state.insuranceIndicatorRecords)) state.insuranceIndicatorRecords = [];
  if (!Array.isArray(state.officialDomainProfiles)) state.officialDomainProfiles = [];
  if (!Number(state.nextId)) state.nextId = 1;

  const scanner = options.scanner || ((input) => scanPolicyWithConfiguredRuntime(input));
  const resolveFeishuKnowledgeRecords =
    options.resolveFeishuKnowledgeRecords === undefined
      ? options.policyResponsibilityQuery
        ? null
        : (input) => searchFeishuKnowledgeRecords(input)
      : options.resolveFeishuKnowledgeRecords;
  const analyzer =
    options.analyzer ||
    ((input) =>
      queryPolicyAndPlanResponsibilities({
        scan: input.scan,
        query: options.policyResponsibilityQuery,
        officialDomainProfiles: buildEffectiveOfficialDomainProfiles(state),
        knowledgeRecords: state.knowledgeRecords || [],
        resolveFeishuKnowledgeRecords,
        preferLocalKnowledgeAnswer: true,
      }));
  const assistantAnalyzer =
    options.assistantAnalyzer ||
    ((input) =>
      queryPolicyResponsibilities({
        scan: input.scan,
        query: options.policyResponsibilityQuery,
        officialDomainProfiles: buildEffectiveOfficialDomainProfiles(state),
        knowledgeRecords: state.knowledgeRecords || [],
        resolveFeishuKnowledgeRecords,
        preferLocalKnowledgeAnswer: input.preferLocalKnowledgeAnswer !== false,
        maxAttempts: input.preferLocalKnowledgeAnswer === false ? 1 : 2,
      }));
  const codeGenerator = options.codeGenerator || defaultCodeGenerator;
  const smsDeliveryPlanResolver =
    options.smsDeliveryPlanResolver ||
    (options.codeGenerator ? localSmsDeliveryPlanResolver(codeGenerator) : resolveSmsDeliveryPlan);
  const smsDeliverer = options.smsDeliverer || deliverSmsCode;
  const knowledgeFetchImpl = options.knowledgeFetchImpl || fetch;
  const persist = typeof options.persist === 'function' ? options.persist : async () => undefined;
  const adminPassword = resolveAdminPassword(options);
  const performanceLogger = createPerformanceLogger(options);

  // Initialize cashflow store: use the shared DB if provided, otherwise use an in-memory DB (for tests)
  let cashflowStore;
  if (options.db) {
    cashflowStore = createCashflowStore(options.db);
  } else {
    const memDb = new DatabaseSync(':memory:');
    // The policy_cashflows table has a FK reference to policies, so ensure a stub exists
    memDb.exec('CREATE TABLE IF NOT EXISTS policies (id INTEGER PRIMARY KEY)');
    cashflowStore = createCashflowStore(memDb);
  }

  /**
   * Compute cashflow entries for a policy and persist them to the cashflow store.
   * Returns { cashflowEntries, scenarioEntries, totalCashflow }.
   */
  function computeAndStoreCashflow(policy) {
    const policyIndicators = findPolicyCoverageIndicators(policy, state.insuranceIndicatorRecords);
    const template = findProductCashflowTemplate(policy, state.knowledgeRecords);
    const cashflowEntries = computePolicyCashflow(policy, template, policyIndicators);
    const scenarioEntries = computeScenarioEntries(policyIndicators, policy);
    const totalCashflow = cashflowEntries.reduce((sum, e) => sum + e.amount, 0);

    if (cashflowEntries.length) {
      cashflowStore.replaceEntries(policy.id, cashflowEntries);
    }

    return { cashflowEntries, scenarioEntries, totalCashflow };
  }

  const app = express();
  app.locals.state = state;
  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'policy-ocr-app' });
  });

  app.get('/api/wechat/js-sdk-signature', async (req, res) => {
    try {
      const payload = await createWechatJsSdkSignature(req.query?.url);
      res.json({ ok: true, ...payload });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/client-perf', (req, res) => {
    const payload = sanitizeClientPerformancePayload(req.body);
    logPerformance(performanceLogger, payload.event, payload);
    res.json({ ok: true });
  });

  app.post('/api/policy-responsibilities/query', async (req, res) => {
    const routeStartedAt = nowMs();
    try {
      const input = normalizeResponsibilityQueryInput(req.body);
      const scan = {
        ocrText: `${input.company} ${input.name}`,
        data: input,
      };
      const preferLocalKnowledgeAnswer = req.body?.preferLocalKnowledgeAnswer !== false;
      const analysisStartedAt = nowMs();
      const analysis = await assistantAnalyzer({ scan, preferLocalKnowledgeAnswer });
      logPerformance(performanceLogger, 'policy.responsibility.assistant.analysis', {
        route: '/api/policy-responsibilities/query',
        durationMs: elapsedMs(analysisStartedAt),
        inputOcrChars: scan.ocrText.length,
        outputOcrChars: scan.ocrText.length,
        responsibilityCount: Array.isArray(analysis?.coverageTable) ? analysis.coverageTable.length : 0,
      });
      logPerformance(performanceLogger, 'policy.responsibility.assistant.complete', {
        route: '/api/policy-responsibilities/query',
        durationMs: elapsedMs(routeStartedAt),
        inputOcrChars: scan.ocrText.length,
      });
      res.json({ ok: true, analysis });
    } catch (error) {
      sendError(res, error, 400);
    }
  });

  app.get('/api/policy-responsibilities/company-suggestions', async (req, res) => {
    const q = trim(req.query?.q);
    const limit = Number(req.query?.limit || 12);
    res.json({
      ok: true,
      suggestions: buildResponsibilityCompanySuggestions(state, q, Number.isFinite(limit) && limit > 0 ? Math.min(limit, 50) : 12),
    });
  });

  app.get('/api/policy-responsibilities/product-suggestions', async (req, res) => {
    const company = trim(req.query?.company);
    const q = trim(req.query?.q);
    const limit = Number(req.query?.limit || 12);
    res.json({
      ok: true,
      suggestions: buildResponsibilityProductSuggestions(state, {
        company,
        query: q,
        maxResults: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 50) : 12,
      }),
    });
  });

  app.post('/api/policy-responsibilities/matches', async (req, res) => {
    try {
      const input = normalizeResponsibilityQueryInput(req.body);
      const policy = { company: input.company, name: input.name };
      const officialDomainProfiles = buildEffectiveOfficialDomainProfiles(state);
      const matches = findKnowledgeProductCandidates({
        policy,
        records: state.knowledgeRecords || [],
        officialDomainProfiles,
        maxResults: 3,
      });
      res.json({ ok: true, matches });
    } catch (error) {
      sendError(res, error, 400);
    }
  });

  app.post('/api/admin/login', async (req, res) => {
    try {
      if (!adminPassword) {
        const error = new Error('后台密码未配置');
        error.code = 'ADMIN_PASSWORD_NOT_CONFIGURED';
        error.status = 503;
        throw error;
      }
      if (String(req.body?.password || '') !== adminPassword) {
        const error = new Error('后台密码不正确');
        error.code = 'INVALID_ADMIN_PASSWORD';
        error.status = 401;
        throw error;
      }
      const token = createAdminSession(state);
      await persist(state);
      res.json({ ok: true, token, expiresInSeconds: Math.floor(ADMIN_SESSION_TTL_MS / 1000) });
    } catch (error) {
      sendError(res, error, 401);
    }
  });

  app.get('/api/admin/overview', async (req, res) => {
    const session = requireAdmin(req, res, state, adminPassword);
    if (!session) return;
    res.json({ ok: true, ...buildAdminOverview(state) });
  });

  app.get('/api/admin/ocr-config', async (req, res) => {
    const session = requireAdmin(req, res, state, adminPassword);
    if (!session) return;
    try {
      res.json(await requestOcrServiceConfig());
    } catch (error) {
      sendError(res, error, 503);
    }
  });

  app.post('/api/admin/ocr-config', async (req, res) => {
    const session = requireAdmin(req, res, state, adminPassword);
    if (!session) return;
    try {
      res.json(
        await requestOcrServiceConfig({
          method: 'POST',
          body: {
            mode: req.body?.mode,
          },
        }),
      );
    } catch (error) {
      sendError(res, error, 400);
    }
  });

  app.get('/api/admin/official-domain-profiles', async (req, res) => {
    const session = requireAdmin(req, res, state, adminPassword);
    if (!session) return;
    res.json({
      ok: true,
      profiles: buildAdminOfficialDomainProfiles(state),
      defaultCount: getDefaultOfficialDomainProfiles().length,
      customCount: (state.officialDomainProfiles || []).length,
    });
  });

  app.post('/api/admin/official-domain-profiles', async (req, res) => {
    const session = requireAdmin(req, res, state, adminPassword);
    if (!session) return;
    try {
      const profile = normalizeAdminOfficialDomainProfileInput(state, req.body);
      state.officialDomainProfiles.push(profile);
      await persist(state);
      res.status(201).json({ ok: true, profile, profiles: buildAdminOfficialDomainProfiles(state) });
    } catch (error) {
      sendError(res, error, 400);
    }
  });

  app.post('/api/admin/official-domain-profiles/:id', async (req, res) => {
    const session = requireAdmin(req, res, state, adminPassword);
    if (!session) return;
    try {
      const id = String(req.params.id || '').trim();
      const existing = (state.officialDomainProfiles || []).find((profile) => String(profile.id || '') === id) || null;
      const profile = normalizeAdminOfficialDomainProfileInput(state, { ...req.body, createdAt: existing?.createdAt }, id);
      state.officialDomainProfiles = (state.officialDomainProfiles || []).filter((row) => String(row.id || '') !== id);
      state.officialDomainProfiles.push(profile);
      await persist(state);
      res.json({ ok: true, profile, profiles: buildAdminOfficialDomainProfiles(state) });
    } catch (error) {
      sendError(res, error, 400);
    }
  });

  app.delete('/api/admin/official-domain-profiles/:id', async (req, res) => {
    const session = requireAdmin(req, res, state, adminPassword);
    if (!session) return;
    const id = String(req.params.id || '').trim();
    state.officialDomainProfiles = (state.officialDomainProfiles || []).filter((row) => String(row.id || '') !== id);
    await persist(state);
    res.json({ ok: true, profiles: buildAdminOfficialDomainProfiles(state) });
  });

  app.get('/api/admin/knowledge-records', async (req, res) => {
    const session = requireAdmin(req, res, state, adminPassword);
    if (!session) return;
    const records = buildAdminKnowledgeRecords(state);
    res.json({
      ok: true,
      records,
      summary: {
        count: records.length,
        officialCount: records.filter((record) => record.official).length,
      },
    });
  });

  app.post('/api/admin/knowledge-crawl', async (req, res) => {
    const session = requireAdmin(req, res, state, adminPassword);
    if (!session) return;
    try {
      const policy = normalizeAdminKnowledgeCrawlInput(req.body);
      const discovered = await crawlOfficialKnowledge({
        policy,
        officialDomainProfiles: buildEffectiveOfficialDomainProfiles(state),
        fetchImpl: knowledgeFetchImpl,
      });
      const saved = upsertKnowledgeRecords(state, discovered, {
        allocateId,
        officialDomainProfiles: buildEffectiveOfficialDomainProfiles(state),
      });
      await persist(state);
      res.json({
        ok: true,
        policy,
        savedCount: saved.length,
        records: buildAdminKnowledgeRecords(state),
        discovered,
      });
    } catch (error) {
      sendError(res, error, 400);
    }
  });

  app.post('/api/auth/send-code', async (req, res) => {
    try {
      const mobile = normalizeMobile(req.body?.mobile);
      assertValidMobile(mobile);
      assertSmsSendAllowed(state, mobile);
      const deliveryPlan = smsDeliveryPlanResolver({ mobile });
      const code = String(deliveryPlan?.code || '').trim();
      if (!/^\d{6}$/.test(code)) {
        const error = new Error('INVALID_CODE');
        error.status = 500;
        throw error;
      }
      const delivery = await smsDeliverer({
        mobile,
        code,
        plan: deliveryPlan,
      });
      const now = new Date();
      const sms = {
        id: allocateId(state),
        mobile,
        code,
        deliveryMode: String(delivery?.mode || deliveryPlan?.deliveryMode || ''),
        provider: String(delivery?.provider || ''),
        simulated: Boolean(delivery?.simulated),
        used: false,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 10 * 60 * 1000).toISOString(),
      };
      state.smsCodes.push(sms);
      await persist(state);
      const payload = {
        ok: true,
        expiresInSeconds: 600,
        deliveryMode: sms.deliveryMode || (delivery?.simulated ? 'mock' : 'real'),
      };
      if (deliveryPlan.exposeDevCode) payload.devCode = code;
      res.json(payload);
    } catch (error) {
      sendError(res, normalizeSmsSendError(error), 400);
    }
  });

  app.post('/api/auth/register', async (req, res) => {
    try {
      const mobile = normalizeMobile(req.body?.mobile);
      assertValidMobile(mobile);
      const sms = latestValidSmsCode(state, { mobile, code: req.body?.code });
      if (!sms) {
        const error = new Error(
          hasPendingSmsCode(state, mobile)
            ? '验证码不正确，请输入最新短信中的 6 位验证码'
            : '验证码不正确或已过期，请重新获取验证码',
        );
        error.code = 'INVALID_CODE';
        error.status = 400;
        throw error;
      }
      let user = state.users.find((row) => String(row.mobile || '') === mobile) || null;
      const guestId = normalizeGuestId(req.body?.guestId);
      const pendingAnalyses = [];
      for (const pending of guestPendingScans(state, guestId)) {
        pendingAnalyses.push({
          pending,
          analysis: normalizeProvidedAnalysis(pending.analysis) || (await analyzer({ scan: pending.scan })),
        });
      }

      sms.used = true;

      if (!user) {
        const now = new Date().toISOString();
        user = {
          id: allocateId(state),
          mobile,
          createdAt: now,
          updatedAt: now,
        };
        state.users.push(user);
      }

      let migratedPolicyCount = 0;
      if (guestId) {
        for (const policy of state.policies) {
          if (String(policy.guestId || '') !== guestId || policy.userId) continue;
          policy.userId = Number(user.id);
          policy.guestId = '';
          policy.updatedAt = new Date().toISOString();
          migratedPolicyCount += 1;
        }
      }
      for (const { pending, analysis } of pendingAnalyses) {
        const policy = buildPolicyFromScan({
          state,
          userId: user.id,
          guestId: '',
          scan: pending.scan,
          analysis,
        });
        state.policies.push(policy);
        recordPolicySourceRecords(state, policy, analysis);
        migratedPolicyCount += 1;
      }
      clearGuestPendingScans(state, guestId);

      const token = createSession(state, user.id);
      await persist(state);
      const policies = state.policies.filter((policy) => Number(policy.userId) === Number(user.id));
      res.json({
        ok: true,
        token,
        user: publicUser(user),
        migratedPolicyCount,
        policies: attachPoliciesCoverageIndicators(policies, state.insuranceIndicatorRecords),
      });
    } catch (error) {
      sendError(res, error, 400);
    }
  });

  app.post('/api/auth/logout', async (req, res) => {
    try {
      const token = getBearerToken(req);
      if (token) {
        deleteSession(state, token);
        await persist(state);
      }
      res.json({ ok: true });
    } catch (error) {
      sendError(res, error, 500);
    }
  });

  app.post('/api/policies/recognize', async (req, res) => {
    const routeStartedAt = nowMs();
    try {
      const user = resolveAuthUser(req, state);
      const guestId = normalizeGuestId(req.body?.guestId);
      assertGuestCanScan({ state, user, guestId });
      const ocrStartedAt = nowMs();
      const scan = await recognizePolicyInput({ scanner, body: req.body, state, applyManualData: false });
      logPerformance(performanceLogger, 'policy.recognize.ocr', {
        route: '/api/policies/recognize',
        durationMs: elapsedMs(ocrStartedAt),
        ...policyInputMetrics(req.body),
        outputOcrChars: String(scan?.ocrText || '').length,
      });
      if (!user && guestId) {
        storeGuestPendingScan(state, { guestId, scan, analysis: null });
        await persist(state);
      }
      logPerformance(performanceLogger, 'policy.recognize.complete', {
        route: '/api/policies/recognize',
        durationMs: elapsedMs(routeStartedAt),
        ...policyInputMetrics(req.body),
      });
      res.json({
        ok: true,
        scan,
        registrationRequiredNext: guestRegistrationRequiredNext({ state, user, guestId }),
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/policies/analyze', async (req, res) => {
    const routeStartedAt = nowMs();
    try {
      const user = resolveAuthUser(req, state);
      const guestId = normalizeGuestId(req.body?.guestId);
      assertGuestCanScan({ state, user, guestId });
      const scanStartedAt = nowMs();
      const normalizedScan = await resolvePolicyScanInput({ scanner, body: req.body, state });
      if (!req.body?.scan) {
        logPerformance(performanceLogger, 'policy.analyze.ocr', {
          route: '/api/policies/analyze',
          durationMs: elapsedMs(scanStartedAt),
          ...policyInputMetrics(req.body),
          outputOcrChars: String(normalizedScan?.ocrText || '').length,
        });
      }
      const analysisStartedAt = nowMs();
      const analysis = await analyzer({ scan: normalizedScan });
      logPerformance(performanceLogger, 'policy.analyze.analysis', {
        route: '/api/policies/analyze',
        durationMs: elapsedMs(analysisStartedAt),
        ...policyInputMetrics(req.body),
        outputOcrChars: String(normalizedScan?.ocrText || '').length,
        responsibilityCount: Array.isArray(analysis?.coverageTable) ? analysis.coverageTable.length : 0,
      });
      if (!user && guestId) {
        storeGuestPendingScan(state, { guestId, scan: normalizedScan, analysis });
        await persist(state);
      }
      logPerformance(performanceLogger, 'policy.analyze.complete', {
        route: '/api/policies/analyze',
        durationMs: elapsedMs(routeStartedAt),
        ...policyInputMetrics(req.body),
      });
      res.json({
        ok: true,
        scan: normalizedScan,
        analysis,
        registrationRequiredNext: guestRegistrationRequiredNext({ state, user, guestId }),
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/policies/scan', async (req, res) => {
    const routeStartedAt = nowMs();
    try {
      const user = resolveAuthUser(req, state);
      const guestId = normalizeGuestId(req.body?.guestId);
      assertGuestCanScan({ state, user, guestId });
      const scanStartedAt = nowMs();
      const normalizedScan = await resolvePolicyScanInput({ scanner, body: req.body, state });
      if (!req.body?.scan) {
        logPerformance(performanceLogger, 'policy.scan.ocr', {
          route: '/api/policies/scan',
          durationMs: elapsedMs(scanStartedAt),
          ...policyInputMetrics(req.body),
          outputOcrChars: String(normalizedScan?.ocrText || '').length,
        });
      } else {
        logPerformance(performanceLogger, 'policy.scan.ocr', {
          route: '/api/policies/scan',
          durationMs: elapsedMs(scanStartedAt),
          ...policyInputMetrics(req.body),
          outputOcrChars: String(normalizedScan?.ocrText || '').length,
          reusedScan: true,
        });
      }
      const providedAnalysis = normalizeProvidedAnalysis(req.body?.analysis);
      if (providedAnalysis) {
        logPerformance(performanceLogger, 'policy.scan.analysis', {
          route: '/api/policies/scan',
          durationMs: 0,
          ...policyInputMetrics(req.body),
          outputOcrChars: String(normalizedScan?.ocrText || '').length,
          responsibilityCount: Array.isArray(providedAnalysis?.coverageTable) ? providedAnalysis.coverageTable.length : 0,
          reusedAnalysis: true,
        });
      }
      const policy = buildPolicyFromScan({
        state,
        userId: user?.id || null,
        guestId,
        scan: normalizedScan,
        analysis: providedAnalysis,
      });
      state.policies.push(policy);
      if (providedAnalysis) recordPolicySourceRecords(state, policy, providedAnalysis);
      if (!user && guestId) clearGuestPendingScans(state, guestId);
      await persist(state);

      // Compute and store cashflow
      const { cashflowEntries, scenarioEntries, totalCashflow } = computeAndStoreCashflow(policy);

      if (!providedAnalysis) {
        startPolicyReportGeneration({
          state,
          policy,
          scan: normalizedScan,
          analyzer,
          persist: () => persist(state),
          performanceLogger,
          requestMetrics: policyInputMetrics(req.body),
        });
      }
      logPerformance(performanceLogger, 'policy.scan.complete', {
        route: '/api/policies/scan',
        durationMs: elapsedMs(routeStartedAt),
        ...policyInputMetrics(req.body),
        outputOcrChars: String(normalizedScan?.ocrText || '').length,
        policyId: policy.id,
      });
      res.status(201).json({
        ok: true,
        policy: {
          ...attachPolicyCoverageIndicators(policy, state.insuranceIndicatorRecords),
          cashflowEntries,
          scenarioEntries,
          totalCashflow,
        },
        registrationRequiredNext: guestRegistrationRequiredNext({ state, user, guestId }),
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get('/api/policies', async (req, res) => {
    const user = resolveAuthUser(req, state);
    const guestId = normalizeGuestId(req.query?.guestId);
    if (!user && !guestId) {
      return res.status(401).json({ ok: false, code: 'UNAUTHORIZED', message: '缺少游客标识' });
    }
    const policies = state.policies
      .filter((policy) => {
        if (user) return Number(policy.userId) === Number(user.id);
        return String(policy.guestId || '') === guestId && !policy.userId;
      })
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    res.json({ ok: true, policies: attachPoliciesCoverageIndicators(policies, state.insuranceIndicatorRecords) });
  });

  app.patch('/api/policies/:id', async (req, res) => {
    try {
      const result = findPolicyForReportRequest(req, state, adminPassword);
      if (!result.policy) {
        return res.status(result.status).json(result.payload);
      }
      const { policy } = result;
      const beforeIdentity = policyProductIdentity(policy);
      const updates = normalizePolicyUpdateData(req.body || {}, policy);
      if (!Object.keys(updates).length) {
        return res.status(400).json({ ok: false, code: 'POLICY_UPDATE_EMPTY', message: '没有可更新的保单数据' });
      }
      if (hasOwn(updates, 'insuredIdNumber') && !hasOwn(updates, 'insuredBirthday')) {
        updates.insuredBirthday = birthdayFromIdNumber(updates.insuredIdNumber);
      }
      Object.assign(policy, updates);
      const identityChanged = beforeIdentity !== policyProductIdentity(policy);
      if (identityChanged) clearPolicyReportForRegeneration(state, policy);
      policy.updatedAt = new Date().toISOString();
      await persist(state);
      if (identityChanged) {
        startPolicyReportGeneration({
          state,
          policy,
          scan: buildPolicyReportScan(policy),
          analyzer,
          persist: () => persist(state),
          performanceLogger,
          requestMetrics: { inputOcrChars: String(policy.ocrText || '').length },
        });
      }
      res.status(identityChanged ? 202 : 200).json({
        ok: true,
        policy: attachPolicyCoverageIndicators(policy, state.insuranceIndicatorRecords),
        reportRegenerating: identityChanged,
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.delete('/api/policies/:id', async (req, res) => {
    try {
      const result = findPolicyForReportRequest(req, state, adminPassword);
      if (!result.policy) {
        return res.status(result.status).json(result.payload);
      }
      const policyId = Number(result.policy.id);
      state.policies = (state.policies || []).filter((policy) => Number(policy.id) !== policyId);
      state.sourceRecords = (state.sourceRecords || []).filter((source) => Number(source.policyId) !== policyId);
      await persist(state);
      res.json({ ok: true, deletedId: policyId });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/policies/:id/report', async (req, res) => {
    try {
      const result = findPolicyForReportRequest(req, state, adminPassword);
      if (!result.policy) {
        return res.status(result.status).json(result.payload);
      }
      const { policy } = result;
      if (policy.reportStatus === 'ready') {
        return res.json({ ok: true, policy: attachPolicyCoverageIndicators(policy, state.insuranceIndicatorRecords), skipped: true });
      }
      if (policy.reportStatus !== 'generating') {
        policy.reportStatus = 'generating';
        policy.reportError = '';
        policy.responsibilities = [];
        policy.report = '';
        policy.sources = [];
        policy.updatedAt = new Date().toISOString();
        await persist(state);
        startPolicyReportGeneration({
          state,
          policy,
          scan: buildPolicyReportScan(policy),
          analyzer,
          persist: () => persist(state),
          performanceLogger,
          requestMetrics: { inputOcrChars: String(policy.ocrText || '').length },
        });
      }
      res.status(202).json({ ok: true, policy: attachPolicyCoverageIndicators(policy, state.insuranceIndicatorRecords) });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get('/api/policies/:id', async (req, res) => {
    const user = resolveAuthUser(req, state);
    const guestId = normalizeGuestId(req.query?.guestId);
    if (!user && !guestId) {
      return res.status(401).json({ ok: false, code: 'UNAUTHORIZED', message: '缺少游客标识' });
    }
    const policy = state.policies.find((row) => {
      if (Number(row.id) !== Number(req.params.id)) return false;
      if (user) return Number(row.userId) === Number(user.id);
      return String(row.guestId || '') === guestId && !row.userId;
    });
    if (!policy) return res.status(404).json({ ok: false, code: 'POLICY_NOT_FOUND', message: '保单不存在' });
    res.json({ ok: true, policy: attachPolicyCoverageIndicators(policy, state.insuranceIndicatorRecords) });
  });

  return app;
}
