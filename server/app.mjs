import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';
import { createRouteContext } from './http/context.mjs';
import { codeFromError } from './http/errors.mjs';
import { createAdminRoutes } from './routes/admin.routes.mjs';
import { createAuthRoutes } from './routes/auth.routes.mjs';
import { createCashflowRoutes } from './routes/cashflow.routes.mjs';
import { createClientPerformanceRoutes } from './routes/client-performance.routes.mjs';
import { createDingtalkIdentityRoutes } from './routes/dingtalk-identity.routes.mjs';
import { createFamilyRoutes } from './routes/families.routes.mjs';
import { createMembershipRoutes } from './routes/membership.routes.mjs';
import { createPolicyRoutes } from './routes/policies.routes.mjs';
import { createResponsibilityRoutes } from './routes/responsibilities.routes.mjs';
import { createWechatRoutes } from './routes/wechat.routes.mjs';
import { createWukongMcpRoutes } from './routes/wukong-mcp.routes.mjs';
import { createWukongMcpGateway } from './wukong-mcp-gateway.service.mjs';
import { buildFamilyReport } from '../src/family-report-engine.mjs';
import {
  allocateId,
  assertValidMobile,
  attachPoliciesCoverageIndicators,
  attachPolicyCoverageIndicators,
  buildOptionalResponsibilityReview,
  buildPolicyFromScan,
  birthdayFromIdNumber,
  createInitialState,
  createSession,
  deleteSession,
  findPolicyCoverageIndicators,
  findSessionUser,
  getBearerToken,
  latestValidSmsCode,
  normalizeBeneficiary,
  normalizeGuestId,
  normalizeDateOnly,
  normalizeOptionalResponsibilities,
  normalizeIdNumber,
  normalizePolicyScanData,
  normalizePolicyPlans,
  normalizeMobile,
  normalizePolicyRelation,
  normalizePolicySources,
  selectedCoverageIndicators,
  publicUser,
} from './policy-ocr.domain.mjs';
import { scanPolicyWithConfiguredRuntime } from './ocr-runtime.mjs';
import { buildPolicyOcrVisionContext, enhancePolicyScanWithOcrMapping } from './policy-ocr-mapping.mjs';
import {
  buildLocalKnowledgeResponsibilityAnalysis,
  queryPolicyAndPlanResponsibilities,
  queryPolicyResponsibilities,
} from './policy-responsibility-query.mjs';
import { searchFeishuKnowledgeRecords } from './feishu-knowledge.service.mjs';
import {
  crawlJrcpcxProductCandidateRecords,
  crawlOpenWebProductReferenceRecords,
  crawlOfficialKnowledge,
  buildKnowledgeSearchArtifacts,
  findKnowledgeProductCandidates,
  LEGACY_EXTERNAL_REFERENCE_LEVEL,
  legacyExternalProductReferenceRecords,
  isExternalReferenceSourceKind,
  sourceKindForKnowledgeRecord,
  productIdentityCodesFromRecord,
  withPolicyProductMatchStatus,
  companiesMatch,
  normalizeKnowledgeRecord,
  scoreCompanySuggestionMatch,
  scoreProductNameMatch,
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
import { createCashflowStore, createCashValueStore } from './cashflow-store.mjs';
import {
  buildPolicyDerivedResult,
  mergePolicyDerivedResult,
} from './policy-derived-results.service.mjs';
import { generateProductCustomerResponsibilitySummary } from './product-customer-responsibility-summary.service.mjs';
import {
  buildResponsibilityCardsForPolicy,
  buildResponsibilitySummaryReportFromCards,
  isGeneratedResponsibilityCountReport,
  mergeCoverageTableWithCheckedRows,
  responsibilityRowsFromCards,
} from './responsibility-card-standardizer.mjs';
import {
  buildOptionalResponsibilityGaps,
  rebuildOptionalResponsibilityGovernance,
} from './optional-responsibility-governance.mjs';
import {
  archiveFamilyMember,
  createFamilyMember,
  createFamilyProfile,
  archiveFamilyGeneratedReports,
  archiveFamilyGeneratedReportsForPolicy,
  archiveFamilyProfile,
  enrichFamilyMemberIdentity,
  ensureDefaultFamilyProfileForPrincipal,
  familyOwnerMatches,
  listFamilyMembers,
  listFamilyProfilesForOwner,
  matchFamilyMemberByPerson,
  normalizeFamilyRelation,
  repairDuplicateFamilyMembers,
  setFamilyCoreMember,
  syncFamilyMemberFromPolicyPerson,
  updateFamilyProfileName,
  updateFamilyMemberProfile,
  updateFamilyMemberNotes,
  updateFamilyMemberRelation,
  upsertFamilyMember,
  validatePolicyFamilyBinding,
} from './family-profile.domain.mjs';
import {
  appendFamilyReportCorrections,
  appendFamilyReportIssues,
  buildAdminReportIssueDetail,
  buildAdminReportIssueSummaries,
  clientFamilyReportRecord,
  createFamilyReportRecord,
  FAMILY_REPORT_ENGINE_VERSION,
  applyFamilyReportPolicyCorrections,
  trustedFamilyReportCorrections,
  syncFamilyReportRuleIssues,
  updateFamilyReportCorrectionStatus,
  updateFamilyReportRecordReport,
} from './family-report-record.service.mjs';
import { generateFamilyReportQualityIssues } from './family-report-quality.service.mjs';
import {
  assertUserCanSavePolicy,
  assertUserReportRefreshAllowed,
  buildMembershipSnapshot,
  consumeWechatOAuthState,
  createMembershipOrder,
  createWechatOAuthState,
  findUserWechatOpenid,
  getMembershipConfig,
  markMembershipOrderPrepayCreated,
  processMembershipPaymentSuccess,
  recordUserReportRefresh,
  updateMembershipConfig,
  upsertUserWechatIdentity,
} from './membership.domain.mjs';
import {
  createMockJsapiPayParams,
  createWechatPayJsapiPrepay,
  decryptWechatPayResource,
  resolveWechatPayConfig,
  verifyWechatPaySignature,
} from './wechat-pay.service.mjs';
import { canonicalProductIdFromOfficialProduct } from './canonical-product-id.mjs';
import { evidenceVerificationFields } from './evidence-classification.service.mjs';
import {
  confirmAdvisorBinding,
  createAdvisorBindingChallenge,
  findAdvisorBindingCandidate,
  revokeAdvisorBinding,
} from './dingtalk-advisor-identity.service.mjs';

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

async function fetchWechatOAuthOpenid(code) {
  const config = resolveWechatConfig();
  assertWechatConfigReady(config);
  const url = new URL('https://api.weixin.qq.com/sns/oauth2/access_token');
  url.searchParams.set('appid', config.appId);
  url.searchParams.set('secret', config.appSecret);
  url.searchParams.set('code', trim(code));
  url.searchParams.set('grant_type', 'authorization_code');
  const payload = await fetchWechatJson(url);
  const openid = trim(payload?.openid);
  if (!openid) {
    const error = new Error('WECHAT_OPENID_NOT_FOUND');
    error.code = 'WECHAT_OPENID_NOT_FOUND';
    error.status = 502;
    throw error;
  }
  return openid;
}

function resolveAuthUser(req, state) {
  return findSessionUser(state, getBearerToken(req));
}

function requestOwner(req, user) {
  return user
    ? { userId: Number(user.id), guestId: '' }
    : { userId: null, guestId: normalizeGuestId(req.query?.guestId || req.body?.guestId) };
}

function policyOwner(policy = {}) {
  const userId = Number(policy.userId || 0) || null;
  return {
    userId,
    guestId: userId ? '' : normalizeGuestId(policy.guestId),
  };
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

function namedPolicyPerson(value) {
  const name = trim(value);
  return name && normalizeBeneficiary(name) !== '法定' ? name : '';
}

function sharePolicyPersonInfo(data = {}) {
  const next = { ...(data || {}) };
  const applicantName = namedPolicyPerson(next.applicant);
  const insuredName = namedPolicyPerson(next.insured);
  const beneficiaryName = namedPolicyPerson(next.beneficiary);
  const shareBirthday = (leftName, leftKey, rightName, rightKey) => {
    if (!leftName || !rightName || leftName !== rightName) return;
    const birthday = trim(next[leftKey] || next[rightKey]);
    if (!birthday) return;
    if (!trim(next[leftKey])) next[leftKey] = birthday;
    if (!trim(next[rightKey])) next[rightKey] = birthday;
  };
  const shareBeneficiaryRelation = (personName, relationValue) => {
    if (!personName || !beneficiaryName || personName !== beneficiaryName) return;
    if (trim(next.beneficiaryRelation)) return;
    const relation = normalizePolicyRelation(relationValue);
    if (relation && relation !== '待确认') next.beneficiaryRelation = relation;
  };
  shareBirthday(applicantName, 'applicantBirthday', insuredName, 'insuredBirthday');
  shareBirthday(applicantName, 'applicantBirthday', beneficiaryName, 'beneficiaryBirthday');
  shareBirthday(insuredName, 'insuredBirthday', beneficiaryName, 'beneficiaryBirthday');
  shareBeneficiaryRelation(applicantName, next.applicantRelationLabel || next.applicantRelation);
  shareBeneficiaryRelation(insuredName, next.insuredRelationLabel || next.insuredRelation);
  return next;
}

function normalizeManualPolicyData(value) {
  if (!value || typeof value !== 'object') return {};
  const data = {};
  for (const key of ['company', 'name', 'applicant', 'insured', 'date', 'paymentPeriod', 'coveragePeriod']) {
    const text = String(value[key] || '').trim();
    if (text) data[key] = text;
  }
  const applicantBirthday = normalizeDateOnly(value.applicantBirthday || value.applicantBirthDate);
  if (applicantBirthday) data.applicantBirthday = applicantBirthday;
  const beneficiary = normalizeBeneficiary(value.beneficiary);
  if (beneficiary) data.beneficiary = beneficiary;
  const beneficiaryRelation = normalizePolicyRelation(value.beneficiaryRelation || value.beneficiaryRelationLabel);
  if (beneficiaryRelation) data.beneficiaryRelation = beneficiaryRelation;
  const beneficiaryBirthday = normalizeDateOnly(value.beneficiaryBirthday || value.beneficiaryBirthDate);
  if (beneficiaryBirthday) data.beneficiaryBirthday = beneficiaryBirthday;
  const insuredIdNumber = normalizeIdNumber(value.insuredIdNumber || value.insuredIdentityNumber || value.insuredIdCard);
  if (insuredIdNumber) data.insuredIdNumber = insuredIdNumber;
  const insuredBirthday = normalizeDateOnly(value.insuredBirthday || value.insuredBirthDate) || birthdayFromIdNumber(insuredIdNumber);
  if (insuredBirthday) data.insuredBirthday = insuredBirthday;
  for (const { key, labelKey } of [
    { key: 'applicantRelation', labelKey: 'applicantRelationLabel' },
    { key: 'insuredRelation', labelKey: 'insuredRelationLabel' },
  ]) {
    const relation = normalizePolicyRelation(value[key] || value[labelKey]);
    if (relation) data[key] = relation;
  }
  for (const key of ['amount', 'firstPremium']) {
    const amount = Number(value[key] || 0);
    if (Number.isFinite(amount) && amount > 0) data[key] = amount;
  }
  if (Array.isArray(value.plans)) {
    const plans = value.plans
      .map((plan) => {
        const normalized = {
          company: trim(plan?.company),
          role: trim(plan?.role),
          name: trim(plan?.name || plan?.productName),
          matchedProductName: trim(plan?.matchedProductName),
          productCode: trim(plan?.productCode),
          productCodes: Array.isArray(plan?.productCodes) ? plan.productCodes.map(trim).filter(Boolean) : [],
          productType: trim(plan?.productType),
          amount: Number(plan?.amount || 0) || 0,
          coveragePeriod: trim(plan?.coveragePeriod),
          paymentMode: trim(plan?.paymentMode),
          paymentPeriod: trim(plan?.paymentPeriod),
          premium: Number(plan?.premium || plan?.firstPremium || 0) || 0,
          premiumText: trim(plan?.premiumText),
          matchScore: Number(plan?.matchScore || 0) || 0,
          matchReason: trim(plan?.matchReason),
        };
        const canonicalProductId = trim(plan?.canonicalProductId);
        if (canonicalProductId) normalized.canonicalProductId = canonicalProductId;
        return normalized;
      })
      .filter((plan) => plan.name || plan.matchedProductName);
    if (plans.length) data.plans = plans;
  }
  const canonicalProductId = trim(value.canonicalProductId);
  if (canonicalProductId) data.canonicalProductId = canonicalProductId;
  return sharePolicyPersonInfo(data);
}

function normalizedPlanIdentity(plan = {}, fallbackCompany = '') {
  return [
    trim(plan?.company || fallbackCompany),
    trim(plan?.role),
    trim(plan?.matchedProductName || plan?.name || plan?.productName),
  ].join('::');
}

function compactText(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/\s+/gu, '')
    .trim()
    .toLowerCase();
}

function shouldPreferScanPlanOverManualPlan(manualPlan = {}, scanPlan = {}) {
  const manualRole = trim(manualPlan?.role);
  const scanRole = trim(scanPlan?.role);
  if (manualRole !== 'rider' || scanRole !== 'rider') return false;
  const manualMatchedName = trim(manualPlan?.matchedProductName || manualPlan?.name || manualPlan?.productName);
  const scanMatchedName = trim(scanPlan?.matchedProductName || scanPlan?.name || scanPlan?.productName);
  if (!manualMatchedName || !scanMatchedName) return false;
  const manualCanonicalProductId = trim(manualPlan?.canonicalProductId);
  if (manualCanonicalProductId) return false;
  const manualProductType = trim(manualPlan?.productType);
  if (manualProductType) return false;
  return compactText(manualMatchedName) !== compactText(scanMatchedName);
}

function mergeManualPlansIntoScan(scanPlans = [], manualPlans = [], fallbackCompany = '') {
  const normalizedScanPlans = normalizePolicyPlans(scanPlans, fallbackCompany);
  const normalizedManualPlans = normalizePolicyPlans(manualPlans, fallbackCompany);
  if (!normalizedManualPlans.length) return normalizedScanPlans;
  if (!normalizedScanPlans.length) return normalizedManualPlans;
  const mergedPlans = normalizedManualPlans.map((manualPlan, index) => {
    const scanPlan = normalizedScanPlans[index] || null;
    if (!scanPlan) return manualPlan;
    if (shouldPreferScanPlanOverManualPlan(manualPlan, scanPlan)) {
      return {
        ...scanPlan,
        premium: manualPlan.premium || scanPlan.premium,
        amount: manualPlan.amount || scanPlan.amount,
        coveragePeriod: manualPlan.coveragePeriod || scanPlan.coveragePeriod,
        paymentMode: manualPlan.paymentMode || scanPlan.paymentMode,
        paymentPeriod: manualPlan.paymentPeriod || scanPlan.paymentPeriod,
      };
    }
    return manualPlan;
  });
  return mergedPlans;
}

function syncSubmittedMainPlanFields(plans = [], fields = {}) {
  const submittedAmount = hasOwn(fields, 'amount') ? Number(fields.amount || 0) : null;
  const submittedPremium = hasOwn(fields, 'firstPremium') ? Number(fields.firstPremium || 0) : null;
  if (submittedAmount !== null && (!Number.isFinite(submittedAmount) || submittedAmount < 0)) return plans;
  if (submittedPremium !== null && (!Number.isFinite(submittedPremium) || submittedPremium < 0)) return plans;
  let updatedMain = false;
  return plans.map((plan, index) => {
    const role = trim(plan?.role || (index === 0 ? 'main' : 'rider'));
    if (updatedMain || (role !== 'main' && index !== 0)) return plan;
    updatedMain = true;
    const nextPlan = { ...plan };
    if (submittedAmount !== null) nextPlan.amount = submittedAmount;
    if (submittedPremium !== null) nextPlan.premium = submittedPremium;
    if (hasOwn(fields, 'coveragePeriod')) nextPlan.coveragePeriod = trim(fields.coveragePeriod);
    if (hasOwn(fields, 'paymentPeriod')) nextPlan.paymentPeriod = trim(fields.paymentPeriod);
    return nextPlan;
  });
}

function preserveMappedCanonicalIdsInManualData(manualData = {}, scanData = {}) {
  const next = { ...manualData };
  const manualProductName = trim(next.name);
  const mappedProductName = trim(scanData.name);
  if (!next.canonicalProductId && trim(scanData.canonicalProductId) && (!manualProductName || manualProductName === mappedProductName)) {
    next.canonicalProductId = trim(scanData.canonicalProductId);
  }
  if (Array.isArray(next.plans) && Array.isArray(scanData.plans)) {
    next.plans = next.plans.map((plan, index) => {
      if (trim(plan?.canonicalProductId)) return plan;
      const mappedPlan = scanData.plans[index] || null;
      const mappedCanonicalProductId = trim(mappedPlan?.canonicalProductId);
      if (!mappedCanonicalProductId) return plan;
      const manualIdentity = normalizedPlanIdentity(plan, next.company || scanData.company);
      const mappedIdentity = normalizedPlanIdentity(mappedPlan, scanData.company || next.company);
      return manualIdentity === mappedIdentity
        ? { ...plan, canonicalProductId: mappedCanonicalProductId }
        : plan;
    });
  }
  return next;
}

function keepMatchingParticipantBindingId({
  manualName = '',
  manualMemberId = null,
  scanName = '',
}) {
  const normalizedManualName = trim(manualName);
  const normalizedScanName = trim(scanName);
  const normalizedMemberId = Number(manualMemberId || 0) || null;
  if (!normalizedMemberId) return null;
  if (!normalizedManualName || !normalizedScanName) return normalizedMemberId;
  return normalizedManualName === normalizedScanName ? normalizedMemberId : null;
}

function normalizePolicyUpdateData(value, existingPolicy = {}) {
  if (!value || typeof value !== 'object') return {};
  const input = value.policy && typeof value.policy === 'object' ? value.policy : value;
  const data = {};
  const hasCanonicalProductIdInput = hasOwn(input, 'canonicalProductId');
  const textFields = ['company', 'name', 'applicant', 'insured', 'paymentPeriod', 'coveragePeriod'];
  for (const key of textFields) {
    if (hasOwn(input, key)) data[key] = trim(input[key]);
  }
  if (hasCanonicalProductIdInput) data.canonicalProductId = trim(input.canonicalProductId);
  if (hasOwn(input, 'beneficiary')) data.beneficiary = normalizeBeneficiary(input.beneficiary);
  if (hasOwn(input, 'beneficiaryRelation') || hasOwn(input, 'beneficiaryRelationLabel')) {
    data.beneficiaryRelation = normalizePolicyRelation(input.beneficiaryRelation || input.beneficiaryRelationLabel);
  }
  if (hasOwn(input, 'date')) data.date = normalizeDateOnly(input.date) || trim(input.date);
  if (hasOwn(input, 'applicantBirthday') || hasOwn(input, 'applicantBirthDate')) {
    data.applicantBirthday = normalizeDateOnly(input.applicantBirthday || input.applicantBirthDate);
  }
  if (hasOwn(input, 'beneficiaryBirthday') || hasOwn(input, 'beneficiaryBirthDate')) {
    data.beneficiaryBirthday = normalizeDateOnly(input.beneficiaryBirthday || input.beneficiaryBirthDate);
  }
  if (hasOwn(input, 'insuredIdNumber') || hasOwn(input, 'insuredIdentityNumber') || hasOwn(input, 'insuredIdCard')) {
    data.insuredIdNumber = normalizeIdNumber(input.insuredIdNumber || input.insuredIdentityNumber || input.insuredIdCard);
  }
  if (hasOwn(input, 'insuredBirthday') || hasOwn(input, 'insuredBirthDate')) {
    data.insuredBirthday = normalizeDateOnly(input.insuredBirthday || input.insuredBirthDate);
  }
  for (const { key, labelKey } of [
    { key: 'applicantRelation', labelKey: 'applicantRelationLabel' },
    { key: 'insuredRelation', labelKey: 'insuredRelationLabel' },
  ]) {
    if (hasOwn(input, key) || hasOwn(input, labelKey)) data[key] = normalizePolicyRelation(input[key] || input[labelKey]);
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
  const sharedPersonData = sharePolicyPersonInfo({
    applicant: hasOwn(data, 'applicant') ? data.applicant : existingPolicy.applicant,
    applicantBirthday: hasOwn(data, 'applicantBirthday') ? data.applicantBirthday : existingPolicy.applicantBirthday,
    applicantRelation: hasOwn(data, 'applicantRelation') ? data.applicantRelation : existingPolicy.applicantRelation,
    applicantRelationLabel: hasOwn(input, 'applicantRelationLabel') ? normalizePolicyRelation(input.applicantRelationLabel) : existingPolicy.applicantRelationLabel,
    beneficiary: hasOwn(data, 'beneficiary') ? data.beneficiary : existingPolicy.beneficiary,
    beneficiaryRelation: hasOwn(data, 'beneficiaryRelation') ? data.beneficiaryRelation : existingPolicy.beneficiaryRelation,
    beneficiaryBirthday: hasOwn(data, 'beneficiaryBirthday') ? data.beneficiaryBirthday : existingPolicy.beneficiaryBirthday,
    insured: hasOwn(data, 'insured') ? data.insured : existingPolicy.insured,
    insuredRelation: hasOwn(data, 'insuredRelation') ? data.insuredRelation : existingPolicy.insuredRelation,
    insuredRelationLabel: hasOwn(input, 'insuredRelationLabel') ? normalizePolicyRelation(input.insuredRelationLabel) : existingPolicy.insuredRelationLabel,
    insuredBirthday: hasOwn(data, 'insuredBirthday') ? data.insuredBirthday : existingPolicy.insuredBirthday,
  });
  if (!hasOwn(data, 'applicantBirthday') && trim(sharedPersonData.applicantBirthday) !== trim(existingPolicy.applicantBirthday)) {
    data.applicantBirthday = sharedPersonData.applicantBirthday;
  }
  if (!hasOwn(data, 'insuredBirthday') && trim(sharedPersonData.insuredBirthday) !== trim(existingPolicy.insuredBirthday)) {
    data.insuredBirthday = sharedPersonData.insuredBirthday;
  }
  if (!hasOwn(data, 'beneficiaryBirthday') && trim(sharedPersonData.beneficiaryBirthday) !== trim(existingPolicy.beneficiaryBirthday)) {
    data.beneficiaryBirthday = sharedPersonData.beneficiaryBirthday;
  }
  if (!hasOwn(data, 'beneficiaryRelation') && trim(sharedPersonData.beneficiaryRelation) !== trim(existingPolicy.beneficiaryRelation)) {
    data.beneficiaryRelation = sharedPersonData.beneficiaryRelation;
  }
  const submittedMainPlanFields = {
    ...(hasOwn(input, 'amount') && hasOwn(data, 'amount') ? { amount: data.amount } : {}),
    ...(hasOwn(input, 'firstPremium') && hasOwn(data, 'firstPremium') ? { firstPremium: data.firstPremium } : {}),
    ...(hasOwn(input, 'coveragePeriod') && hasOwn(data, 'coveragePeriod') ? { coveragePeriod: data.coveragePeriod } : {}),
    ...(hasOwn(input, 'paymentPeriod') && hasOwn(data, 'paymentPeriod') ? { paymentPeriod: data.paymentPeriod } : {}),
  };
  if (!hasOwn(input, 'plans') && Object.keys(submittedMainPlanFields).length && Array.isArray(existingPolicy.plans) && existingPolicy.plans.length) {
    data.plans = normalizePolicyPlans(existingPolicy.plans, data.company || existingPolicy.company || '');
  }
  if (Array.isArray(data.plans) && data.plans.length) {
    const amountToSync = data.amount || existingPolicy.amount || 0;
    const premiumToSync = data.firstPremium || existingPolicy.firstPremium || 0;
    const hasSubmittedAmount = hasOwn(input, 'amount') && hasOwn(data, 'amount');
    const hasSubmittedPremium = hasOwn(input, 'firstPremium') && hasOwn(data, 'firstPremium');
    if (amountToSync || premiumToSync) {
      data.plans = data.plans.map((plan, index) => {
        const isMain = plan.role === 'main' || index === 0;
        if (!isMain) return plan;
        return {
          ...plan,
          amount: hasSubmittedAmount ? data.amount : plan.amount || amountToSync || 0,
          premium: hasSubmittedPremium ? data.firstPremium : plan.premium || premiumToSync || 0,
        };
      });
    }
    data.plans = syncSubmittedMainPlanFields(data.plans, submittedMainPlanFields);
    if (!hasCanonicalProductIdInput && !data.canonicalProductId) {
      const mainPlan = data.plans.find((plan) => plan.role === 'main') || data.plans[0];
      data.canonicalProductId = trim(mainPlan?.canonicalProductId);
    }
  }
  if (hasOwn(input, 'optionalResponsibilities')) {
    data.optionalResponsibilities = normalizeOptionalResponsibilities(input.optionalResponsibilities);
  }
  for (const key of ['familyId', 'applicantMemberId', 'insuredMemberId']) {
    if (!hasOwn(input, key)) continue;
    const id = Number(input[key] || 0);
    data[key] = Number.isFinite(id) && id > 0 ? id : null;
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

function familyInputHasBindingFields(input = {}) {
  return ['familyId', 'applicantMemberId', 'insuredMemberId'].some((key) => hasOwn(input, key));
}

function normalizeFamilyBindingInput(input = {}) {
  return {
    familyId: Number(input.familyId || 0) || null,
    applicantMemberId: Number(input.applicantMemberId || 0) || null,
    insuredMemberId: Number(input.insuredMemberId || 0) || null,
    applicantRelationLabel: trim(input.applicantRelation || input.applicantRelationLabel),
    insuredRelationLabel: trim(input.insuredRelation || input.insuredRelationLabel),
  };
}

function familyBindingInputFromPolicyUpdate(updates = {}, policy = {}) {
  return normalizeFamilyBindingInput({
    familyId: hasOwn(updates, 'familyId') ? updates.familyId : policy.familyId,
    applicantMemberId: hasOwn(updates, 'applicantMemberId') ? updates.applicantMemberId : policy.applicantMemberId,
    insuredMemberId: hasOwn(updates, 'insuredMemberId') ? updates.insuredMemberId : policy.insuredMemberId,
    applicantRelation: hasOwn(updates, 'applicantRelation') ? updates.applicantRelation : (policy.applicantRelationLabel || policy.applicantRelation),
    insuredRelation: hasOwn(updates, 'insuredRelation') ? updates.insuredRelation : (policy.insuredRelationLabel || policy.insuredRelation),
  });
}

function policyHasFamilyBinding(policy = {}) {
  return Boolean(policy.familyId && policy.applicantMemberId && policy.insuredMemberId);
}

function shouldRebuildPolicyFamilyBinding(updates = {}, policy = {}) {
  const familyMemberFields = [
    'applicant',
    'insured',
    'applicantBirthday',
    'insuredBirthday',
    'insuredIdNumber',
    'applicantRelation',
    'insuredRelation',
  ];
  return (
    familyInputHasBindingFields(updates) ||
    (policyHasFamilyBinding(policy) && familyMemberFields.some((key) => hasOwn(updates, key)))
  );
}

function buildPolicyFamilyBinding(state, input = {}, owner = {}, personData = {}, options = {}) {
  const normalizedInput = normalizeFamilyBindingInput(input);
  validatePolicyFamilyBinding(state, normalizedInput, owner);
  const family = (state.familyProfiles || []).find((row) => Number(row.id) === Number(normalizedInput.familyId));
  const members = listFamilyMembers(state, normalizedInput.familyId);
  const applicant = members.find((row) => Number(row.id) === Number(normalizedInput.applicantMemberId));
  const insured = members.find((row) => Number(row.id) === Number(normalizedInput.insuredMemberId));
  const applicantPerson = familyPersonFromPolicyData(personData, 'applicant');
  const insuredPerson = familyPersonFromPolicyData(personData, 'insured');
  const beneficiaryName = namedPolicyPerson(personData.beneficiary);
  const beneficiaryMember = beneficiaryName
    ? members.find((row) => String(row.status || 'active') === 'active' && trim(row.name) === beneficiaryName)
    : null;
  for (const { member, relationLabel } of [
    { member: applicant, relationLabel: normalizedInput.applicantRelationLabel },
    { member: insured, relationLabel: normalizedInput.insuredRelationLabel },
  ]) {
    if (!member || !relationLabel) continue;
    const relation = normalizeFamilyRelation(relationLabel);
    if (relation.relationToCore === 'self') {
      if (family && Number(family.coreMemberId || 0) !== Number(member.id)) {
        setFamilyCoreMember(state, family, member);
      } else if (member.relationLabel !== '本人') {
        updateFamilyMemberRelation(member, '本人');
        if (family) family.updatedAt = member.updatedAt;
      }
      continue;
    }
    if (Number(member.id) === Number(family?.coreMemberId || 0)) {
      if (member.relationLabel !== '本人') {
        updateFamilyMemberRelation(member, '本人');
        if (family) family.updatedAt = member.updatedAt;
      }
      continue;
    }
    if (member.relationLabel !== relation.relationLabel) {
      updateFamilyMemberRelation(member, relation.relationLabel);
      if (family) family.updatedAt = member.updatedAt;
    }
  }
  const applicantChanged = applicant ? syncFamilyMemberFromPolicyPerson(applicant, applicantPerson) : false;
  const insuredChanged = insured ? syncFamilyMemberFromPolicyPerson(insured, insuredPerson) : false;
  if (family && (applicantChanged || insuredChanged)) {
    family.updatedAt = (insuredChanged ? insured : applicant)?.updatedAt || new Date().toISOString();
  }
  const applicantNameSnapshot = trim(personData.applicant);
  const insuredNameSnapshot = trim(personData.insured);
  const nameMismatch = (
    (applicantNameSnapshot && applicant?.name && applicantNameSnapshot !== trim(applicant.name)) ||
    (insuredNameSnapshot && insured?.name && insuredNameSnapshot !== trim(insured.name))
  );
  return {
    familyBindingSource: trim(options.familyBindingSource) || 'explicit',
    familyId: Number(family?.id || normalizedInput.familyId),
    applicantMemberId: Number(applicant?.id || normalizedInput.applicantMemberId),
    insuredMemberId: Number(insured?.id || normalizedInput.insuredMemberId),
    applicantNameSnapshot,
    insuredNameSnapshot,
    applicantRelationSnapshot: trim(applicant?.relationLabel),
    insuredRelationSnapshot: trim(insured?.relationLabel),
    participantReviewStatus: nameMismatch ? 'name_mismatch' : 'ok',
    applicantMemberName: trim(applicant?.name),
    applicantRelationLabel: trim(applicant?.relationLabel),
    insuredMemberName: trim(insured?.name),
    insuredRelationLabel: trim(insured?.relationLabel),
    beneficiaryRelationLabel: trim(beneficiaryMember?.relationLabel),
  };
}

function familyPersonFromPolicyData(data = {}, role = 'insured') {
  const prefix = role === 'applicant' ? 'applicant' : 'insured';
  const idNumber = normalizeIdNumber(
    data?.[`${prefix}IdNumber`] ||
      data?.[`${prefix}IdentityNumber`] ||
      data?.[`${prefix}IdCard`],
  );
  return {
    name: trim(data?.[prefix]),
    birthday: normalizeDateOnly(data?.[`${prefix}Birthday`] || data?.[`${prefix}BirthDate`]),
    idNumberTail: idNumber ? idNumber.slice(-4) : '',
  };
}

function activeFamilyForOwner(state, owner = {}) {
  return listFamilyProfilesForOwner(state, owner)
    .find((family) => String(family?.status || 'active') === 'active') || null;
}

function activeCoreMemberForFamily(state, family) {
  return listFamilyMembers(state, family.id)
    .find((member) => Number(member?.id || 0) === Number(family?.coreMemberId || 0)) || null;
}

function ensureMemberForPolicyPerson(state, family, person = {}, relationLabel = '待确认') {
  if (!trim(person.name)) return null;
  const members = listFamilyMembers(state, family.id);
  const existing = matchFamilyMemberByPerson(members, person);
  if (existing) {
    enrichFamilyMemberIdentity(existing, person);
    return existing;
  }
  return createFamilyMember(state, family.id, {
    ...person,
    relationLabel,
  });
}

function markFamilyCoreMember(family, member) {
  if (!member) return;
  family.coreMemberId = member.id;
  family.updatedAt = new Date().toISOString();
  member.relationToCore = 'self';
  member.relationLabel = '本人';
  member.role = 'core';
  member.updatedAt = family.updatedAt;
}

function policyMatchesOwnerPrincipal(policy, owner = {}) {
  if (owner.userId) return Number(policy?.userId || 0) === Number(owner.userId);
  if (owner.guestId) return normalizeGuestId(policy?.guestId) === owner.guestId && !Number(policy?.userId || 0);
  return !policy?.userId && !normalizeGuestId(policy?.guestId);
}

function ensureDefaultPolicyFamilyBinding(state, owner = {}, personData = {}) {
  const applicantPerson = familyPersonFromPolicyData(personData, 'applicant');
  const insuredPerson = familyPersonFromPolicyData(personData, 'insured');
  const ownerPolicies = (state.policies || []).filter((policy) => policyMatchesOwnerPrincipal(policy, owner));
  const existingFamily = activeFamilyForOwner(state, owner);
  const family = ownerPolicies.length
    ? ensureDefaultFamilyProfileForPrincipal(state, owner)
    : (existingFamily || createFamilyProfile(state, {}, owner));

  let coreMember = activeCoreMemberForFamily(state, family);
  const applicantMember = ensureMemberForPolicyPerson(
    state,
    family,
    applicantPerson,
    coreMember ? '待确认' : '本人',
  );
  if (!coreMember && applicantMember) {
    markFamilyCoreMember(family, applicantMember);
    coreMember = applicantMember;
  }

  const insuredMember = ensureMemberForPolicyPerson(
    state,
    family,
    insuredPerson,
    coreMember && applicantMember?.id !== coreMember.id ? '待确认' : '本人',
  );
  if (!coreMember && insuredMember) {
    markFamilyCoreMember(family, insuredMember);
    coreMember = insuredMember;
  }

  if (!coreMember) {
    const firstMember = listFamilyMembers(state, family.id)[0];
    coreMember = firstMember || createFamilyMember(state, family.id, { name: '本人', relationLabel: '本人' });
    markFamilyCoreMember(family, coreMember);
  }

  return buildPolicyFamilyBinding(
    state,
    {
      familyId: family.id,
      applicantMemberId: applicantMember?.id || coreMember.id,
      insuredMemberId: insuredMember?.id || applicantMember?.id || coreMember.id,
    },
    owner,
    personData,
    { familyBindingSource: 'default' },
  );
}

function attachPolicyFamilyDisplay(policy, state) {
  const family = (state.familyProfiles || []).find((row) => Number(row.id) === Number(policy.familyId));
  const applicant = (state.familyMembers || []).find((row) => Number(row.id) === Number(policy.applicantMemberId));
  const insured = (state.familyMembers || []).find((row) => Number(row.id) === Number(policy.insuredMemberId));
  const useFamilyRelationLabels = trim(policy.familyBindingSource) === 'explicit';
  return {
    ...policy,
    familyName: family?.familyName || '',
    applicantMemberName: applicant?.name || policy.applicantMemberName || '',
    applicantRelation: useFamilyRelationLabels
      ? applicant?.relationLabel || policy.applicantRelationLabel || policy.applicantRelation || ''
      : policy.applicantRelation || policy.applicantRelationLabel || applicant?.relationLabel || '',
    applicantRelationLabel: useFamilyRelationLabels
      ? applicant?.relationLabel || policy.applicantRelationLabel || ''
      : policy.applicantRelationLabel || applicant?.relationLabel || '',
    insuredMemberName: insured?.name || policy.insuredMemberName || '',
    insuredRelation: useFamilyRelationLabels
      ? insured?.relationLabel || policy.insuredRelationLabel || policy.insuredRelation || ''
      : policy.insuredRelation || policy.insuredRelationLabel || insured?.relationLabel || '',
    insuredRelationLabel: useFamilyRelationLabels
      ? insured?.relationLabel || policy.insuredRelationLabel || ''
      : policy.insuredRelationLabel || insured?.relationLabel || '',
  };
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
  policy.optionalResponsibilities = [];
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
  const familyRows = (Array.isArray(state.familyProfiles) ? state.familyProfiles : [])
    .filter((family) => String(family?.status || 'active') === 'active');
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
      const policyFamilyIds = new Set(policies.map((policy) => Number(policy.familyId || 0)).filter(Boolean));
      const familyCount = familyRows.filter((family) => (
        Number(family?.ownerUserId || 0) === Number(user.id) ||
        (!Number(family?.ownerUserId || 0) && policyFamilyIds.has(Number(family?.id || 0)))
      )).length;
      const insuredNames = new Set(policies.map((policy) => String(policy.insured || '').trim() || '未识别被保人'));
      return {
        id: Number(user.id),
        mobile: String(user.mobile || ''),
        createdAt: user.createdAt,
        familyCount,
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
    policies: policyRows.map((policy) => {
      const {
        ocrText,
        coverageIndicators,
        optionalResponsibilities,
        responsibilityCards,
        responsibilities,
        ...summaryPolicy
      } = attachPolicyFamilyDisplay(policy, state);
      return summaryPolicy;
    }),
    sourceRecords,
    optionalResponsibilityGaps: buildOptionalResponsibilityGaps({
      optionalResponsibilityRecords: state.optionalResponsibilityRecords,
      policies: policyRows,
    }),
    summary: {
      userCount: users.length,
      insuredCount: insuredMap.size,
      policyCount: policyRows.length,
      familyCount: familyRows.length,
      sourceRecordCount: sourceRecords.length,
      knowledgeRecordCount: Array.isArray(state.knowledgeRecords) ? state.knowledgeRecords.length : 0,
      optionalResponsibilityGapCount: buildOptionalResponsibilityGaps({
        optionalResponsibilityRecords: state.optionalResponsibilityRecords,
        policies: policyRows,
      }).length,
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

const responsibilitySuggestionIndexCache = new WeakMap();

function normalizeSuggestionComparableFact(value) {
  return trim(value)
    .replace(/[（(][^）)]*[）)]/gu, '')
    .replace(/\s+/gu, '')
    .replace(/[：:]/gu, '')
    .replace(/[^\p{Script=Han}\p{Letter}\p{Number}]/gu, '')
    .toLowerCase()
    .trim();
}

function normalizeSuggestionComparableCompany(value) {
  return normalizeSuggestionComparableFact(value)
    .replace(/(?:人寿|财产|养老|健康)?保险股份有限公司/gu, '')
    .replace(/(?:人寿|财产|养老|健康)?保险有限责任公司/gu, '')
    .replace(/(?:人寿|财产|养老|健康)?保险有限公司/gu, '')
    .replace(/保险股份有限公司|保险有限责任公司|股份有限公司|有限责任公司|有限公司/gu, '')
    .trim();
}

function profileForSuggestionCompany(company = '', officialDomainProfiles = []) {
  const target = trim(company);
  if (!target) return null;
  return (officialDomainProfiles || []).find((profile) => {
    const aliases = Array.isArray(profile?.aliases) ? profile.aliases : [];
    return aliases.some((alias) => alias && target.includes(alias));
  }) || null;
}

function companyKeysForSuggestionIndex(company = '', officialDomainProfiles = []) {
  const values = [company];
  const profile = profileForSuggestionCompany(company, officialDomainProfiles);
  if (profile) {
    values.push(profile.company);
    values.push(...(Array.isArray(profile.aliases) ? profile.aliases : []));
    values.push(...(Array.isArray(profile.companyAliases) ? profile.companyAliases : []));
  }
  const keys = new Set();
  for (const value of values) {
    const normalized = normalizeSuggestionText(value);
    const comparable = normalizeSuggestionComparableCompany(value);
    if (normalized) keys.add(normalized);
    if (comparable) keys.add(comparable);
  }
  return keys;
}

function latestStateRowMarker(rows = []) {
  let marker = '';
  for (const row of Array.isArray(rows) ? rows : []) {
    const next = [
      row?.updatedAt,
      row?.reviewedAt,
      row?.lastFetchedAt,
      row?.id,
    ].map((value) => String(value || '')).join(':');
    if (next > marker) marker = next;
  }
  return marker;
}

function responsibilitySuggestionIndexSignature(state = {}) {
  const knowledgeRecords = Array.isArray(state.knowledgeRecords) ? state.knowledgeRecords : [];
  const policies = Array.isArray(state.policies) ? state.policies : [];
  const officialDomainProfiles = Array.isArray(state.officialDomainProfiles) ? state.officialDomainProfiles : [];
  return [
    knowledgeRecords.length,
    latestStateRowMarker(knowledgeRecords),
    policies.length,
    latestStateRowMarker(policies),
    officialDomainProfiles.length,
    latestStateRowMarker(officialDomainProfiles),
  ].join('|');
}

function buildResponsibilitySuggestionIndex(state = {}, signature = responsibilitySuggestionIndexSignature(state)) {
  const officialDomainProfiles = buildEffectiveOfficialDomainProfiles(state);
  const companyStats = new Map();
  const addCompany = (company, weight = 1) => {
    const name = trim(company);
    if (!name) return;
    const current = companyStats.get(name) || { company: name, recordCount: 0 };
    current.recordCount += weight;
    companyStats.set(name, current);
  };
  for (const record of state.knowledgeRecords || []) addCompany(record.company, 1);
  for (const policy of state.policies || []) addCompany(policy.company, 1);
  for (const profile of officialDomainProfiles) addCompany(profile.company, 0);

  const productStats = new Map();
  const addProduct = (recordCompany, productName, weight = 1, { official = false, productCodes = [] } = {}) => {
    const sourceCompany = trim(recordCompany);
    const name = trim(productName);
    if (!sourceCompany || !name) return;
    const key = `${sourceCompany}\u001f${name}`;
    const current = productStats.get(key) || {
      company: sourceCompany,
      productName: name,
      canonicalProductId: '',
      productCodes: new Set(),
      recordCount: 0,
    };
    if (official && !current.canonicalProductId) {
      current.canonicalProductId = canonicalProductIdFromOfficialProduct({
        company: sourceCompany,
        productName: name,
      });
    }
    for (const code of productCodes) {
      const normalizedCode = trim(code).normalize('NFKC').replace(/\s+/gu, '').toUpperCase();
      if (/^[A-Z0-9][A-Z0-9_-]{1,23}$/u.test(normalizedCode)) current.productCodes.add(normalizedCode);
    }
    current.recordCount += weight;
    productStats.set(key, current);
  };
  for (const record of state.knowledgeRecords || []) {
    if (!isProductSuggestionKnowledgeRecord(record)) continue;
    addProduct(record.company, record.productName, 1, {
      official: record.official === true,
      productCodes: productIdentityCodesFromRecord(record),
    });
  }

  const productRowsByCompanyKey = new Map();
  const productRows = [...productStats.values()].map((item) => {
    const productCodes = [...item.productCodes];
    const row = {
      ...item,
      productCodes,
      normalizedProduct: normalizeSuggestionText(item.productName),
      normalizedCodes: productCodes.map(normalizeSuggestionText).filter(Boolean),
    };
    for (const companyKey of companyKeysForSuggestionIndex(row.company, officialDomainProfiles)) {
      const rows = productRowsByCompanyKey.get(companyKey) || [];
      rows.push(row);
      productRowsByCompanyKey.set(companyKey, rows);
    }
    return row;
  });

  return {
    signature,
    officialDomainProfiles,
    companyRows: [...companyStats.values()],
    productRows,
    productRowsByCompanyKey,
  };
}

function getResponsibilitySuggestionIndex(state = {}) {
  const signature = responsibilitySuggestionIndexSignature(state);
  const cached = responsibilitySuggestionIndexCache.get(state);
  if (cached?.signature === signature) return cached;
  const next = buildResponsibilitySuggestionIndex(state, signature);
  responsibilitySuggestionIndexCache.set(state, next);
  return next;
}

function buildResponsibilityCompanySuggestions(state, query = '', maxResults = 12) {
  const normalizedQuery = normalizeSuggestionText(query);
  const suggestionIndex = getResponsibilitySuggestionIndex(state);

  return suggestionIndex.companyRows
    .map((item) => {
      const match = normalizedQuery
        ? scoreCompanySuggestionMatch(query, item.company, suggestionIndex.officialDomainProfiles)
        : { matched: true, score: 0, matchType: '' };
      return {
        ...item,
        matched: match.matched,
        score: match.score,
        matchType: match.matchType,
      };
    })
    .filter((item) => !normalizedQuery || item.matched)
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.recordCount - left.recordCount ||
        left.company.localeCompare(right.company, 'zh-CN'),
    )
    .slice(0, maxResults)
    .map(({ company, recordCount, matchType }) => ({ company, recordCount, matchType }));
}

function isProductSuggestionKnowledgeRecord(record = {}) {
  const productName = trim(record.productName || record.name);
  if (!productName) return false;
  const sourceKind = sourceKindForKnowledgeRecord(record);
  const parser = trim(record.parser);
  const qualityStatus = trim(record.qualityStatus);
  const evidenceLevel = trim(record.evidenceLevel || record.sourceLevel);
  const materialType = trim(record.materialType);
  return (
    !isExternalReferenceSourceKind(sourceKind) &&
    record.responsibilityDeferred !== true &&
    evidenceLevel !== LEGACY_EXTERNAL_REFERENCE_LEVEL &&
    materialType !== 'external_reference' &&
    qualityStatus !== 'external_reference_only' &&
    !['deepseek_planned_open_web_search', 'legacy_external_reference_seed', 'external_review_query_source'].includes(parser)
  );
}

function buildResponsibilityProductSuggestions(state, { company = '', query = '', maxResults = 12 } = {}) {
  if (!normalizeSuggestionText(company)) return [];
  const normalizedQuery = normalizeSuggestionText(query);
  const suggestionIndex = getResponsibilitySuggestionIndex(state);
  const candidatesByKey = new Map();
  for (const companyKey of companyKeysForSuggestionIndex(company, suggestionIndex.officialDomainProfiles)) {
    for (const row of suggestionIndex.productRowsByCompanyKey.get(companyKey) || []) {
      candidatesByKey.set(`${row.company}\u001f${row.productName}`, row);
    }
  }
  const candidates = candidatesByKey.size
    ? [...candidatesByKey.values()]
    : suggestionIndex.productRows.filter((row) => companiesMatch(company, row.company, suggestionIndex.officialDomainProfiles));

  return candidates
    .map((item) => {
      const matchIndex = normalizedQuery ? item.normalizedProduct.indexOf(normalizedQuery) : 0;
      const codeMatchIndex = normalizedQuery
        ? item.normalizedCodes.findIndex(
          (code) => code === normalizedQuery || code.startsWith(normalizedQuery) || code.includes(normalizedQuery),
        )
        : -1;
      const fuzzyScore = normalizedQuery ? scoreProductNameMatch(query, item.productName, company) : 1;
      return {
        ...item,
        fuzzyScore,
        matchIndex,
        effectiveMatchIndex: matchIndex >= 0 ? matchIndex : codeMatchIndex >= 0 ? 0 : 9999,
        exact: Boolean(normalizedQuery && item.normalizedProduct === normalizedQuery),
        codeExact: Boolean(normalizedQuery && item.normalizedCodes.includes(normalizedQuery)),
        startsWith: Boolean(normalizedQuery && item.normalizedProduct.startsWith(normalizedQuery)),
        codeStartsWith: Boolean(normalizedQuery && item.normalizedCodes.some((code) => code.startsWith(normalizedQuery))),
        codeMatched: codeMatchIndex >= 0,
      };
    })
    .filter((item) => !normalizedQuery || item.matchIndex >= 0 || item.codeMatched || item.fuzzyScore >= 0.1)
    .sort(
      (left, right) =>
        Number(right.exact || right.codeExact) - Number(left.exact || left.codeExact) ||
        Number(right.startsWith || right.codeStartsWith) - Number(left.startsWith || left.codeStartsWith) ||
        Number(right.matchIndex >= 0 || right.codeMatched) - Number(left.matchIndex >= 0 || left.codeMatched) ||
        left.effectiveMatchIndex - right.effectiveMatchIndex ||
        right.fuzzyScore - left.fuzzyScore ||
        right.recordCount - left.recordCount ||
        left.productName.localeCompare(right.productName, 'zh-CN'),
    )
    .slice(0, maxResults)
    .map(({ company: itemCompany, productName, canonicalProductId, productCodes, recordCount }) => {
      const resolvedProductCodes = productCodes;
      return {
        company: itemCompany,
        productName,
        canonicalProductId: canonicalProductId || undefined,
        productCode: resolvedProductCodes[0] || undefined,
        productCodes: resolvedProductCodes,
        recordCount,
      };
    });
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

function buildRawUploadSnapshot(body = {}) {
  const uploadItem = body?.uploadItem && typeof body.uploadItem === 'object' ? body.uploadItem : null;
  return {
    ocrText: String(body?.ocrText || '').trim(),
    uploadItem: uploadItem ? {
      name: String(uploadItem.name || '').trim(),
      type: String(uploadItem.type || '').trim(),
      size: Number(uploadItem.size || 0) || 0,
      hasDataUrl: Boolean(uploadItem.dataUrl),
    } : null,
    hasProvidedScan: Boolean(body?.scan && typeof body.scan === 'object'),
    hasProvidedAnalysis: Boolean(body?.analysis && typeof body.analysis === 'object'),
  };
}

function storeGuestPendingScan(state, { guestId, scan, analysis = null, rawUpload = null }) {
  if (!guestId) return;
  const now = new Date().toISOString();
  const existing = guestPendingScans(state, guestId)[0] || null;
  if (existing) {
    existing.scan = scan;
    existing.analysis = analysis;
    existing.rawUpload = rawUpload;
    existing.updatedAt = now;
    return;
  }
  state.pendingScans.push({
    id: allocateId(state),
    guestId,
    scan,
    analysis,
    rawUpload,
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
  const mergedManualData = preserveMappedCanonicalIdsInManualData(manualData, scan?.data || {});
  if (!hasOwn(scan?.data || {}, 'applicantMemberId') && hasOwn(mergedManualData, 'applicantMemberId')) {
    mergedManualData.applicantMemberId = keepMatchingParticipantBindingId({
      manualName: manualData.applicant,
      manualMemberId: mergedManualData.applicantMemberId,
      scanName: scan?.data?.applicant,
    });
  }
  if (!hasOwn(scan?.data || {}, 'insuredMemberId') && hasOwn(mergedManualData, 'insuredMemberId')) {
    mergedManualData.insuredMemberId = keepMatchingParticipantBindingId({
      manualName: manualData.insured,
      manualMemberId: mergedManualData.insuredMemberId,
      scanName: scan?.data?.insured,
    });
  }
  if (Array.isArray(manualData.plans) || Array.isArray(scan?.data?.plans)) {
    mergedManualData.plans = mergeManualPlansIntoScan(scan?.data?.plans, mergedManualData.plans, mergedManualData.company || scan?.data?.company || '');
  }
  if (Array.isArray(mergedManualData.plans)) {
    const mainPlanFields = {};
    for (const key of ['amount', 'firstPremium', 'coveragePeriod', 'paymentPeriod']) {
      if (hasOwn(manualData, key) && hasOwn(mergedManualData, key)) mainPlanFields[key] = mergedManualData[key];
    }
    if (Object.keys(mainPlanFields).length) {
      mergedManualData.plans = syncSubmittedMainPlanFields(mergedManualData.plans, mainPlanFields);
    }
  }
  return {
    ...scan,
    data: sharePolicyPersonInfo({
      ...(scan?.data || {}),
      ...mergedManualData,
    }),
  };
}

function scanInputOcrText(body = {}) {
  return body?.uploadItem ? '' : body?.ocrText || '';
}

function safelyEnhancePolicyScanWithOcrMapping(scan, state) {
  try {
    return enhancePolicyScanWithOcrMapping({ scan, state });
  } catch (error) {
    console.error('[policy-ocr-mapping] failed', {
      code: error?.code || '',
      message: error?.message || String(error),
    });
    return scan;
  }
}

async function recognizePolicyInput({ scanner, body, state, applyManualData = true }) {
  assertUploadItemSize(body?.uploadItem || null);
  const ocrContext = buildPolicyOcrVisionContext({ state, body });
  const scan = await scanner({
    uploadItem: body?.uploadItem || null,
    ocrText: scanInputOcrText(body),
    ocrContext,
  });
  const scanWithText = {
    ...scan,
    ocrText: String(scan?.ocrText || body?.ocrText || '').trim(),
  };
  const mappedScan = safelyEnhancePolicyScanWithOcrMapping(scanWithText, state);
  return applyManualData ? mergeManualPolicyDataIntoScan(mappedScan, body) : mappedScan;
}

function normalizeProvidedScan(body, state) {
  const scan = body?.scan && typeof body.scan === 'object' ? body.scan : null;
  if (!scan) return null;
  const scanWithText = {
    ...scan,
    ocrText: String(scan.ocrText || body?.ocrText || '').trim(),
  };
  const mappedScan = safelyEnhancePolicyScanWithOcrMapping(scanWithText, state);
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
  const optionalResponsibilities = normalizeOptionalResponsibilities(value.optionalResponsibilities);
  const responsibilityCards = Array.isArray(value.responsibilityCards)
    ? value.responsibilityCards.filter((card) => card && typeof card === 'object')
    : [];
  const coverageTable = Array.isArray(value.coverageTable)
    ? value.coverageTable
        .map((row) => {
          const normalized = {
            productName: String(row?.productName || '').trim(),
            coverageType: String(row?.coverageType || '').trim(),
            scenario: String(row?.scenario || '').trim(),
            payout: String(row?.payout || '').trim(),
            note: String(row?.note || '').trim(),
            sourceUrl: String(row?.sourceUrl || '').trim(),
            sourceTitle: String(row?.sourceTitle || row?.source || '').trim(),
            sourceExcerpt: String(row?.sourceExcerpt || '').trim(),
            sourceKind: String(row?.sourceKind || '').trim(),
            evidenceLabel: String(row?.evidenceLabel || '').trim(),
            evidenceLevel: String(row?.evidenceLevel || row?.sourceLevel || '').trim(),
            official: row?.official === true,
            responsibilityDeferred: row?.responsibilityDeferred === true,
            referenceOnly: row?.referenceOnly === true,
          };
          return {
            ...normalized,
            ...evidenceVerificationFields(normalized),
          };
        })
        .filter((row) => row.coverageType || row.scenario || row.payout || row.note)
    : [];
  const report = String(value.report || '').trim();
  if (!report && !coverageTable.length && !optionalResponsibilities.length && !responsibilityCards.length) return null;
  return {
    ...value,
    report,
    coverageTable,
    sources: normalizePolicySources(value.sources),
    optionalResponsibilities,
    responsibilityCards,
  };
}

function recordPolicySourceRecords(state, policy, analysis) {
  const sources = normalizePolicySources(analysis?.sources || policy?.sources);
  if (!state || !policy || !sources.length) return;
  if (!Array.isArray(state.sourceRecords)) state.sourceRecords = [];
  const officialDomainProfiles = buildEffectiveOfficialDomainProfiles(state);
  const acceptedSources = sources.filter((source) => {
    const customerPolicyTerms = String(source.sourceKind || '') === 'customer_policy_terms' || String(source.evidenceLevel || '') === 'customer_policy_terms';
    if (customerPolicyTerms) return true;
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
      existing.verificationStatus = source.verificationStatus || existing.verificationStatus;
      existing.verificationLabel = source.verificationLabel || existing.verificationLabel;
      existing.referenceOnly = source.referenceOnly === true;
      existing.sourceKind = source.sourceKind || existing.sourceKind;
      existing.materialType = source.materialType || existing.materialType;
      existing.sourceExcerpt = source.sourceExcerpt || existing.sourceExcerpt;
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
      verificationStatus: source.verificationStatus,
      verificationLabel: source.verificationLabel,
      referenceOnly: source.referenceOnly === true,
      sourceKind: source.sourceKind,
      materialType: source.materialType,
      sourceExcerpt: source.sourceExcerpt,
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
          const customerPolicyTerms = String(source.sourceKind || '') === 'customer_policy_terms' || String(source.evidenceLevel || '') === 'customer_policy_terms';
          return (
            customerPolicyTerms ||
            ((Boolean(source.official) || String(source.evidenceLevel || '') === 'insurer_official') &&
            isPolicyOfficialSourceUrl(
              source.url,
              { company: sourceCompany, name: sourceProductName },
              officialDomainProfiles,
            ))
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
        materialType: source.materialType || (source.sourceType === 'pdf' ? 'pdf' : ''),
        official: true,
        evidenceLabel: source.evidenceLabel || '保险公司官方资料',
        evidenceLevel: source.evidenceLevel || 'insurer_official',
        sourceKind: source.sourceKind,
        verificationStatus: source.verificationStatus,
        verificationLabel: source.verificationLabel,
        referenceOnly: source.referenceOnly === true,
        sourceExcerpt: source.sourceExcerpt,
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
    productName: String(row.productName || '').trim(),
    coverageType: String(row.coverageType || '').trim() || '保险责任',
    scenario: String(row.scenario || '').trim() || '以条款约定为准',
    payout: String(row.payout || '').trim() || '以正式条款为准',
    note: String(row.note || '').trim(),
    sourceUrl: String(row.sourceUrl || '').trim(),
    sourceTitle: String(row.sourceTitle || '').trim(),
    sourceExcerpt: String(row.sourceExcerpt || '').trim(),
    sourceKind: String(row.sourceKind || '').trim(),
    evidenceLabel: String(row.evidenceLabel || '').trim(),
    evidenceLevel: String(row.evidenceLevel || '').trim(),
    verificationStatus: String(row.verificationStatus || '').trim(),
    verificationLabel: String(row.verificationLabel || '').trim(),
    referenceOnly: row.referenceOnly === true,
    official: row.official === true,
  }));
  policy.report = String(normalized.report || '').trim();
  policy.sources = normalizePolicySources(normalized.sources);
  if (Array.isArray(normalized.optionalResponsibilities) && normalized.optionalResponsibilities.length) {
    policy.optionalResponsibilities = normalized.optionalResponsibilities;
  }
  policy.reportStatus = 'ready';
  policy.reportError = '';
  policy.updatedAt = new Date().toISOString();
  return true;
}

function buildRecognizedPolicyAnalysisDraft({ state, scan, officialDomainProfiles = [] } = {}) {
  const data = normalizePolicyScanData(scan?.data || {});
  const policyDraft = {
    ...data,
    plans: normalizePolicyPlans(scan?.data?.plans, data.company),
    optionalResponsibilities: normalizeOptionalResponsibilities(scan?.data?.optionalResponsibilities),
    ocrText: String(scan?.ocrText || '').trim(),
  };
  const primaryPlan = (Array.isArray(policyDraft.plans) ? policyDraft.plans : [])
    .find((plan) => String(plan?.role || '') === 'main') || policyDraft.plans?.[0] || null;
  const knowledgeArtifacts = buildKnowledgeSearchArtifacts({
    policy: policyDraft,
    records: state?.knowledgeRecords || [],
    officialDomainProfiles,
  });
  const matchedProductName = trim(knowledgeArtifacts.records?.[0]?.productName);
  const primaryProductName = matchedProductName
    || trim(primaryPlan?.matchedProductName || primaryPlan?.productName || primaryPlan?.name)
    || policyDraft.name;
  const primaryCompany = trim(primaryPlan?.company) || policyDraft.company;
  const primaryOptionalPolicyDraft = {
    ...policyDraft,
    company: primaryCompany,
    name: primaryProductName,
    plans: primaryProductName
      ? normalizePolicyPlans(
          [
            {
              ...(primaryPlan || {}),
              company: primaryCompany,
              role: 'main',
              name: primaryPlan?.name || primaryProductName,
              productName: primaryProductName,
              matchedProductName: primaryProductName,
            },
          ],
          primaryCompany,
        )
      : [],
  };
  const localAnalysis = buildLocalKnowledgeResponsibilityAnalysis(knowledgeArtifacts.records) || {
    report: '',
    coverageTable: [],
    notes: [],
    sources: knowledgeArtifacts.sources || [],
  };
  const optionalResponsibilities = buildDraftOptionalResponsibilitiesByPlan({
    basePolicy: policyDraft,
    primaryPolicy: primaryOptionalPolicyDraft,
    plans: policyDraft.plans,
    indicatorRecords: state?.insuranceIndicatorRecords || [],
    knowledgeRecords: state?.knowledgeRecords || [],
    optionalResponsibilityRecords: state?.optionalResponsibilityRecords || [],
  });
  if (!localAnalysis.coverageTable?.length && !optionalResponsibilities.length) return null;
  return {
    ...localAnalysis,
    coverageTable: Array.isArray(localAnalysis.coverageTable) ? localAnalysis.coverageTable : [],
    optionalResponsibilities,
    notes: Array.isArray(localAnalysis.notes) ? localAnalysis.notes : [],
    sources: Array.isArray(localAnalysis.sources) ? localAnalysis.sources : knowledgeArtifacts.sources || [],
  };
}

function buildDraftOptionalResponsibilitiesByPlan({
  basePolicy,
  primaryPolicy,
  plans = [],
  indicatorRecords = [],
  knowledgeRecords = [],
  optionalResponsibilityRecords = [],
} = {}) {
  const policies = [];
  const pushPolicy = (policy) => {
    const company = trim(policy?.company);
    const name = trim(policy?.name);
    if (!company || !name) return;
    const key = `${company}\u001f${name}`;
    if (policies.some((item) => item.key === key)) return;
    policies.push({ key, policy });
  };

  pushPolicy(primaryPolicy);
  for (const plan of Array.isArray(plans) ? plans : []) {
    const productName = trim(plan?.matchedProductName || plan?.productName || plan?.name);
    const company = trim(plan?.company) || trim(basePolicy?.company);
    if (!company || !productName) continue;
    pushPolicy({
      ...basePolicy,
      company,
      name: productName,
      canonicalProductId: trim(plan?.canonicalProductId) || '',
      plans: normalizePolicyPlans([
        {
          ...plan,
          company,
          name: trim(plan?.name) || productName,
          productName,
          matchedProductName: productName,
        },
      ], company),
    });
  }

  const byId = new Map();
  for (const { policy } of policies) {
    const indicators = findPolicyCoverageIndicators(policy, indicatorRecords);
    for (const item of buildOptionalResponsibilityReview(policy, indicators, knowledgeRecords, optionalResponsibilityRecords)) {
      if (!item?.id || byId.has(item.id)) continue;
      byId.set(item.id, item);
    }
  }
  return [...byId.values()];
}

function markPolicyReportFailed(policy, error) {
  if (!policy) return;
  policy.reportStatus = 'failed';
  policy.reportError = error instanceof Error ? error.message : '报告生成失败';
  policy.updatedAt = new Date().toISOString();
}

function startPolicyReportGeneration({ state, policy, scan, analyzer, persist, afterApply, performanceLogger, requestMetrics = {} }) {
  if (!policy || policy.reportStatus === 'ready') return;
  void (async () => {
    const analysisStartedAt = nowMs();
    try {
      const analysis = await analyzer({ scan });
      if (!applyAnalysisToPolicy(policy, analysis)) {
        throw new Error('报告生成结果为空');
      }
      recordPolicySourceRecords(state, policy, analysis);
      if (typeof afterApply === 'function') await afterApply({ policy, analysis });
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
      beneficiaryRelation: policy?.beneficiaryRelation || '',
      beneficiaryBirthday: policy?.beneficiaryBirthday || '',
      applicantRelation: policy?.applicantRelation || '',
      applicantBirthday: policy?.applicantBirthday || '',
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

function resolveDefaultWechatPayMode(options = {}) {
  const explicitMode = trim(process.env.WECHAT_PAY_MODE || options.wechatPayMode);
  if (explicitMode) return explicitMode;
  return process.env.NODE_ENV === 'production' ? 'live' : 'mock';
}

export function createPolicyOcrApp(options = {}) {
  const state = options.state || createInitialState();
  const wukongMcpGateway = options.wukongMcpGateway || createWukongMcpGateway({
    state,
    now: typeof options.wukongMcpNow === 'function' ? options.wukongMcpNow : Date.now,
    replayTtlMs: options.wukongMcpReplayTtlMs,
    replayMaxEntries: options.wukongMcpReplayMaxEntries,
    rateLimit: options.wukongMcpRateLimit,
    rateWindowMs: options.wukongMcpRateWindowMs,
    rateMaxPrincipals: options.wukongMcpRateMaxPrincipals,
  });
  const defaultWechatPayMode = resolveDefaultWechatPayMode(options);
  const runtimeInfo = {
    startedAt: String(options.runtimeStartedAt || new Date().toISOString()),
    sessionId: String(options.runtimeSessionId || `runtime-${Date.now().toString(36)}`),
  };
  if (!Array.isArray(state.users)) state.users = [];
  if (!Array.isArray(state.sessions)) state.sessions = [];
  if (!Array.isArray(state.adminSessions)) state.adminSessions = [];
  if (!Array.isArray(state.smsCodes)) state.smsCodes = [];
  if (!Array.isArray(state.policies)) state.policies = [];
  if (!Array.isArray(state.pendingScans)) state.pendingScans = [];
  if (!Array.isArray(state.sourceRecords)) state.sourceRecords = [];
  if (!Array.isArray(state.knowledgeRecords)) state.knowledgeRecords = [];
  if (!Array.isArray(state.insuranceIndicatorRecords)) state.insuranceIndicatorRecords = [];
  if (!Array.isArray(state.optionalResponsibilityRecords)) state.optionalResponsibilityRecords = [];
  if (!Array.isArray(state.policyDerivedResults)) state.policyDerivedResults = [];
  if (!Array.isArray(state.productIndicatorVersions)) state.productIndicatorVersions = [];
  if (!Array.isArray(state.indicatorUpdateBatches)) state.indicatorUpdateBatches = [];
  if (!Array.isArray(state.officialDomainProfiles)) state.officialDomainProfiles = [];
  if (!Array.isArray(state.familyReports)) state.familyReports = [];
  if (!Array.isArray(state.familyReportIssues)) state.familyReportIssues = [];
  if (!Array.isArray(state.familyReportShares)) state.familyReportShares = [];
  if (!Array.isArray(state.familySalesReviews)) state.familySalesReviews = [];
  if (!Array.isArray(state.familySalesChatThreads)) state.familySalesChatThreads = [];
  if (!Array.isArray(state.familySalesChatMessages)) state.familySalesChatMessages = [];
  if (!Array.isArray(state.familySalesMemories)) state.familySalesMemories = [];
  if (!state.membershipConfig) state.membershipConfig = null;
  if (!Array.isArray(state.membershipOrders)) state.membershipOrders = [];
  if (!Array.isArray(state.memberships)) state.memberships = [];
  if (!Array.isArray(state.userWechatIdentities)) state.userWechatIdentities = [];
  if (!Array.isArray(state.userDingtalkIdentities)) state.userDingtalkIdentities = [];
  if (!Array.isArray(state.dingtalkBindingChallenges)) state.dingtalkBindingChallenges = [];
  if (!Array.isArray(state.wechatOAuthStates)) state.wechatOAuthStates = [];
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
        allowExternalReferences: Boolean(input.allowExternalReferences),
        maxAttempts: input.preferLocalKnowledgeAnswer === false ? 1 : 2,
      }));
  const codeGenerator = options.codeGenerator || defaultCodeGenerator;
  const smsDeliveryPlanResolver =
    options.smsDeliveryPlanResolver ||
    (options.codeGenerator ? localSmsDeliveryPlanResolver(codeGenerator) : resolveSmsDeliveryPlan);
  const smsDeliverer = options.smsDeliverer || deliverSmsCode;
  const knowledgeFetchImpl = options.knowledgeFetchImpl || fetch;
  const officialKnowledgeCrawler = options.crawlOfficialKnowledge || crawlOfficialKnowledge;
  const onlineResponsibilityProductMatcher = options.onlineResponsibilityProductMatcher || crawlJrcpcxProductCandidateRecords;
  const externalReferenceProductMatcher = options.externalReferenceProductMatcher || crawlOpenWebProductReferenceRecords;
  const rawPersist = typeof options.persist === 'function' ? options.persist : async () => undefined;
  const optionalResponsibilityGovernanceRebuilder = options.optionalResponsibilityGovernanceRebuilder || rebuildOptionalResponsibilityGovernance;
  const persist = async (nextState = state, persistOptions = {}) => {
    if (persistOptions.refreshOptionalResponsibilityGovernance !== false) {
      Object.assign(nextState, optionalResponsibilityGovernanceRebuilder(nextState));
    }
    await rawPersist(nextState);
  };
  const persistPolicyScanSave = typeof options.persistPolicyScanSave === 'function'
    ? (input = {}) => options.persistPolicyScanSave({ state, ...input })
    : null;
  const persistPendingScan = typeof options.persistPendingScan === 'function'
    ? (input = {}) => options.persistPendingScan({ state, ...input })
    : null;
  const persistFamilyState = typeof options.persistFamilyState === 'function'
    ? (input = {}) => options.persistFamilyState({ state, ...input })
    : null;
  const persistFamilyReportState = typeof options.persistFamilyReportState === 'function'
    ? (input = {}) => options.persistFamilyReportState({ state, ...input })
    : null;
  const persistAdminSession = typeof options.persistAdminSession === 'function'
    ? (input = {}) => options.persistAdminSession({ state, ...input })
    : null;
  const persistAuthSmsCode = typeof options.persistAuthSmsCode === 'function'
    ? (input = {}) => options.persistAuthSmsCode({ state, ...input })
    : null;
  const persistAuthRegistration = typeof options.persistAuthRegistration === 'function'
    ? (input = {}) => options.persistAuthRegistration({ state, ...input })
    : null;
  const persistAuthLogout = typeof options.persistAuthLogout === 'function'
    ? (input = {}) => options.persistAuthLogout({ state, ...input })
    : null;
  const persistPolicyState = typeof options.persistPolicyState === 'function'
    ? (input = {}) => options.persistPolicyState({ state, ...input })
    : null;
  const persistPolicyDelete = typeof options.persistPolicyDelete === 'function'
    ? (input = {}) => options.persistPolicyDelete({ state, ...input })
    : null;
  const persistMembershipConfig = typeof options.persistMembershipConfig === 'function'
    ? (input = {}) => options.persistMembershipConfig({ state, ...input })
    : null;
  const persistStateDocument = typeof options.persistStateDocument === 'function'
    ? (input = {}) => options.persistStateDocument({ state, ...input })
    : null;
  const persistMembershipState = typeof options.persistMembershipState === 'function'
    ? (input = {}) => options.persistMembershipState({ state, ...input })
    : null;
  const persistDingtalkIdentityState = typeof options.persistDingtalkIdentityState === 'function'
    ? (input = {}) => options.persistDingtalkIdentityState({ state, ...input })
    : null;
  const persistOfficialDomainProfiles = typeof options.persistOfficialDomainProfiles === 'function'
    ? (input = {}) => options.persistOfficialDomainProfiles({ state, ...input })
    : null;
  const persistPolicyDerivedResult = typeof options.persistPolicyDerivedResult === 'function'
    ? (input = {}) => options.persistPolicyDerivedResult({ state, ...input })
    : null;
  const persistResponsibilityLookupArtifacts = typeof options.persistResponsibilityLookupArtifacts === 'function'
    ? (input = {}) => options.persistResponsibilityLookupArtifacts({ state, ...input })
    : null;
  const persistProductCustomerResponsibilitySummary = typeof options.persistProductCustomerResponsibilitySummary === 'function'
    ? (input = {}) => options.persistProductCustomerResponsibilitySummary({
        state,
        summary: input?.summary || input,
      })
    : null;
  const persistProductCustomerSummaryGenerationRun = typeof options.persistProductCustomerSummaryGenerationRun === 'function'
    ? (input = {}) => options.persistProductCustomerSummaryGenerationRun({
        state,
        run: input?.run || input,
      })
    : null;
  const findProductCustomerResponsibilitySummary = typeof options.findProductCustomerResponsibilitySummary === 'function'
    ? (input = {}) => options.findProductCustomerResponsibilitySummary(input)
    : null;
  const markPolicyDerivedResultsStaleByProductKeys = typeof options.markPolicyDerivedResultsStaleByProductKeys === 'function'
    ? (input = {}) => options.markPolicyDerivedResultsStaleByProductKeys({ state, ...input })
    : null;
  const upsertProductIndicatorVersions = typeof options.upsertProductIndicatorVersions === 'function'
    ? (input = {}) => options.upsertProductIndicatorVersions({ state, ...input })
    : null;
  const recordIndicatorUpdateBatch = typeof options.recordIndicatorUpdateBatch === 'function'
    ? (input = {}) => options.recordIndicatorUpdateBatch({ state, ...input })
    : null;
  const adminPassword = resolveAdminPassword(options);
  const performanceLogger = createPerformanceLogger(options);

  // Initialize cashflow store: use the shared DB if provided, otherwise use an in-memory DB (for tests)
  let cashflowStore;
  let cashValueStore;
  let cashflowDb;
  let ownsCashflowDb = false;
  if (options.db) {
    cashflowDb = options.db;
    cashflowStore = createCashflowStore(cashflowDb);
    cashValueStore = createCashValueStore(cashflowDb);
  } else {
    const memDb = new DatabaseSync(':memory:');
    // The policy_cashflows table has a FK reference to policies, so ensure a stub exists
    memDb.exec('CREATE TABLE IF NOT EXISTS policies (id INTEGER PRIMARY KEY)');
    cashflowDb = memDb;
    ownsCashflowDb = true;
    cashflowStore = createCashflowStore(memDb);
    cashValueStore = createCashValueStore(memDb);
  }

  function ensureCashflowPolicyParent(policyId) {
    const id = Number(policyId);
    if (!Number.isFinite(id)) return false;
    if (!cashflowDb) return true;
    if (ownsCashflowDb) {
      cashflowDb.prepare('INSERT OR IGNORE INTO policies (id) VALUES (?)').run(id);
      return true;
    }
    try {
      return Boolean(cashflowDb.prepare('SELECT 1 FROM policies WHERE id = ?').get(id));
    } catch {
      return true;
    }
  }

  /**
   * Compute cashflow entries for a policy and persist them to the cashflow store.
   * Returns { cashflowEntries, scenarioEntries, totalCashflow }.
   */
  function computeAndStoreCashflow(policy) {
    const derivedResult = state.policyDerivedResults.find((row) => Number(row?.policyId) === Number(policy?.id)) || null;
    const policyForCashflow = derivedResult ? mergePolicyDerivedResult(policy, derivedResult) : policy;
    const policyIndicators = derivedResult && Array.isArray(policyForCashflow.coverageIndicators)
      ? policyForCashflow.coverageIndicators
      : findPolicyCoverageIndicators(policy, state.insuranceIndicatorRecords);
    const selectedIndicators = selectedCoverageIndicators(policyIndicators);
    const template = findProductCashflowTemplate(policyForCashflow, state.knowledgeRecords);
    const cashflowEntries = computePolicyCashflow(policyForCashflow, template, selectedIndicators);
    const scenarioEntries = computeScenarioEntries(selectedIndicators, policyForCashflow);
    const totalCashflow = cashflowEntries.reduce((sum, e) => sum + e.amount, 0);

    if (!cashflowEntries.length || ensureCashflowPolicyParent(policy.id)) {
      cashflowStore.replaceEntries(policy.id, cashflowEntries);
    }

    return { cashflowEntries, scenarioEntries, totalCashflow };
  }

  /**
   * Recompute cashflow entries for all policies.
   * Used on startup and by the admin recompute endpoint to rebuild derived rows.
   */
  function recomputeAllCashflow() {
    for (const policy of state.policies) {
      try {
        computeAndStoreCashflow(policy);
      } catch (err) {
        console.error('[cashflow] recompute failed for policy', policy.id, err.message);
      }
    }
  }

  if (options.recomputeCashflowOnStartup !== false) {
    recomputeAllCashflow();
  }

  const routeContext = createRouteContext({
    state,
    persist,
    persistPolicyScanSave,
    persistPendingScan,
    persistFamilyState,
    persistFamilyReportState,
    persistAdminSession,
    persistAuthSmsCode,
    persistAuthRegistration,
    persistAuthLogout,
    persistPolicyState,
    persistPolicyDelete,
    persistMembershipConfig,
    persistStateDocument,
    persistMembershipState,
    persistDingtalkIdentityState,
    persistOfficialDomainProfiles,
    persistResponsibilityLookupArtifacts,
    persistPolicyDerivedResult,
    markPolicyDerivedResultsStaleByProductKeys,
    upsertProductIndicatorVersions,
    recordIndicatorUpdateBatch,
    scanner,
    analyzer,
    adminPassword,
    adminSessionTtlMs: ADMIN_SESSION_TTL_MS,
    performanceLogger,
    cashflowStore,
    cashValueStore,
    requireAdmin,
    createAdminSession,
    nowMs,
    elapsedMs,
    resolveOcrServiceUrl,
    computeAndStoreCashflow,
    recomputeAllCashflow,
    generateFamilySalesReview: options.generateFamilySalesReview,
    generateFamilySalesChatReply: options.generateFamilySalesChatReply,
    extractFamilySalesMemories: options.extractFamilySalesMemories,
    generateFamilyPolicyAnalysisReport: options.generateFamilyPolicyAnalysisReport,
    generateFamilyReportQualityIssues: options.generateFamilyReportQualityIssues || generateFamilyReportQualityIssues,
    buildFamilyReport,
    createWechatJsSdkSignature,
    sanitizeClientPerformancePayload,
    logPerformance,
    policyInputMetrics,
    normalizeMobile,
    assertValidMobile,
    assertSmsSendAllowed,
    smsDeliveryPlanResolver,
    smsDeliverer,
    allocateId,
    normalizeSmsSendError,
    latestValidSmsCode,
    hasPendingSmsCode,
    normalizeGuestId,
    assertGuestCanScan,
    recognizePolicyInput,
    resolvePolicyScanInput,
    normalizeFamilyRelation,
    policyHasFamilyBinding,
    familyInputHasBindingFields,
    buildPolicyFamilyBinding,
    normalizeFamilyBindingInput,
    requestOwner,
    resolveAuthUser,
    guestPendingScans,
    storeGuestPendingScan,
    guestRegistrationRequiredNext,
    normalizeProvidedAnalysis,
    ensureDefaultPolicyFamilyBinding,
    buildPolicyFromScan,
    recordPolicySourceRecords,
    clearGuestPendingScans,
    createSession,
    publicUser,
    attachPoliciesCoverageIndicators,
    attachPolicyCoverageIndicators,
    buildPolicyDerivedResult,
    mergePolicyDerivedResult,
    attachPolicyFamilyDisplay,
    selectedCoverageIndicators,
    computeScenarioEntries,
    findPolicyCoverageIndicators,
    getBearerToken,
    deleteSession,
    assistantAnalyzer,
    normalizeResponsibilityQueryInput,
    normalizePolicyScanData,
    normalizePolicyPlans,
    normalizeOptionalResponsibilities,
    buildOptionalResponsibilityReview,
    buildRecognizedPolicyAnalysisDraft,
    buildEffectiveOfficialDomainProfiles,
    buildResponsibilitySummaryReportFromCards,
    buildResponsibilityCardsForPolicy,
    isGeneratedResponsibilityCountReport,
    mergeCoverageTableWithCheckedRows,
    responsibilityRowsFromCards,
    db: options.db,
    buildRawUploadSnapshot,
    findPolicyForReportRequest,
    policyProductIdentity,
    normalizePolicyUpdateData,
    hasOwn,
    birthdayFromIdNumber,
    shouldRebuildPolicyFamilyBinding,
    familyBindingInputFromPolicyUpdate,
    policyOwner,
    clearPolicyReportForRegeneration,
    startPolicyReportGeneration,
    buildPolicyReportScan,
    assertUserCanSavePolicy,
    assertUserReportRefreshAllowed,
    buildMembershipSnapshot,
    createMembershipOrder,
    getMembershipConfig,
    markMembershipOrderPrepayCreated,
    processMembershipPaymentSuccess,
    recordUserReportRefresh,
    updateMembershipConfig,
    createMockJsapiPayParams,
    consumeWechatOAuthState,
    createWechatOAuthState,
    findUserWechatOpenid,
    upsertUserWechatIdentity,
    resolveWechatPayConfig: options.resolveWechatPayConfig || (() => resolveWechatPayConfig({
      ...process.env,
      WECHAT_PAY_MODE: defaultWechatPayMode,
    })),
    createWechatPayJsapiPrepay: options.createWechatPayJsapiPrepay || createWechatPayJsapiPrepay,
    decryptWechatPayResource,
    verifyWechatPaySignature,
    fetchWechatOAuthOpenid: options.fetchWechatOAuthOpenid || fetchWechatOAuthOpenid,
    nowIso: typeof options.now === 'function' ? options.now : () => new Date().toISOString(),
    authenticateDingtalkServiceRequest: options.authenticateDingtalkServiceRequest,
    wukongMcpGateway,
    getDingtalkUserProfile: options.getDingtalkUserProfile,
    dingtalkAllowedUserIds: Array.isArray(options.dingtalkAllowedUserIds) ? options.dingtalkAllowedUserIds : [],
    findAdvisorBindingCandidate,
    createAdvisorBindingChallenge,
    confirmAdvisorBinding,
    revokeAdvisorBinding,
    wechatPayMode: defaultWechatPayMode,
    buildResponsibilityCompanySuggestions,
    buildResponsibilityProductSuggestions,
    findKnowledgeProductCandidates,
    legacyExternalProductReferenceRecords,
    withPolicyProductMatchStatus,
    generateProductCustomerResponsibilitySummary,
    generateProductCustomerResponsibilitySummaryWithDeepSeek: options.generateProductCustomerResponsibilitySummaryWithDeepSeek,
    generateProductCustomerResponsibilityPlannerWithDeepSeek: options.generateProductCustomerResponsibilityPlannerWithDeepSeek,
    findProductCustomerResponsibilitySummary,
    persistProductCustomerResponsibilitySummary,
    persistProductCustomerSummaryGenerationRun,
    buildAdminOverview,
    buildOptionalResponsibilityGaps,
    buildAdminReportIssueDetail,
    buildAdminReportIssueSummaries,
    applyFamilyReportPolicyCorrections,
    familyReportEngineVersion: FAMILY_REPORT_ENGINE_VERSION,
    trustedFamilyReportCorrections,
    syncFamilyReportRuleIssues,
    updateFamilyReportCorrectionStatus,
    updateFamilyReportRecordReport,
    rebuildOptionalResponsibilityGovernance,
    buildAdminOfficialDomainProfiles,
    getDefaultOfficialDomainProfiles,
    normalizeAdminOfficialDomainProfileInput,
    buildAdminKnowledgeRecords,
    normalizeAdminKnowledgeCrawlInput,
    crawlOfficialKnowledge: officialKnowledgeCrawler,
    onlineResponsibilityProductMatcher,
    externalReferenceProductMatcher,
    knowledgeFetchImpl,
    archiveFamilyMember,
    upsertKnowledgeRecords,
    persistResponsibilityLookupArtifacts,
    createFamilyMember,
    createFamilyProfile,
    archiveFamilyGeneratedReports,
    archiveFamilyGeneratedReportsForPolicy,
    archiveFamilyProfile,
    ensureDefaultFamilyProfileForPrincipal,
    familyOwnerMatches,
    listFamilyMembers,
    listFamilyProfilesForOwner,
    repairDuplicateFamilyMembers,
    setFamilyCoreMember,
    updateFamilyProfileName,
    updateFamilyMemberProfile,
    updateFamilyMemberNotes,
    updateFamilyMemberRelation,
    upsertFamilyMember,
    appendFamilyReportIssues,
    appendFamilyReportCorrections,
    clientFamilyReportRecord,
    createFamilyReportRecord,
  });

  const app = express();
  app.locals.state = state;
  app.use(express.json({
    limit: JSON_BODY_LIMIT,
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString('utf8');
    },
  }));

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      service: 'policy-ocr-app',
      startedAt: runtimeInfo.startedAt,
      sessionId: runtimeInfo.sessionId,
    });
  });

  app.use('/api/wechat', createWechatRoutes(routeContext));
  app.use('/api/client-perf', createClientPerformanceRoutes(routeContext));
  app.use('/api/auth', createAuthRoutes(routeContext));
  app.use('/api/dingtalk/identity', createDingtalkIdentityRoutes(routeContext));
  app.use('/api/wukong/mcp', createWukongMcpRoutes(routeContext));
  app.use('/api/policy-responsibilities', createResponsibilityRoutes(routeContext));
  app.use('/api', createFamilyRoutes(routeContext));
  app.use('/api/membership', createMembershipRoutes(routeContext));
  app.use('/api', createPolicyRoutes(routeContext));
  app.use('/api', createCashflowRoutes(routeContext));
  app.use('/api/admin', createAdminRoutes(routeContext));

  app.recomputeAllCashflow = recomputeAllCashflow;
  return app;
}
