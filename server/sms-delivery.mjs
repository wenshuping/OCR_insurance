import crypto from 'node:crypto';
import fs from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Dysmsapi20170525Sdk from '@alicloud/dysmsapi20170525';
import * as OpenApiSdk from '@alicloud/openapi-client';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_SMS_MODE = 'mock';
const DEFAULT_SMS_MOCK_CODE = '123456';
const DEFAULT_SMS_REAL_PROVIDER = 'webhook';
const DEFAULT_SMS_REAL_WEBHOOK_TIMEOUT_MS = 10000;
const DEFAULT_SMS_ALIYUN_ENDPOINT = 'dysmsapi.aliyuncs.com';
const DEFAULT_SMS_ALIYUN_TEMPLATE_PARAM_KEY = 'code';
const DEFAULT_SMS_ALIYUN_DETAIL_POLL_ATTEMPTS = 5;
const DEFAULT_SMS_ALIYUN_DETAIL_POLL_INTERVAL_MS = 500;
const VALID_SMS_MODES = new Set(['mock', 'real', 'hybrid']);
const VALID_SMS_REAL_PROVIDERS = new Set(['webhook', 'aliyun']);
const VALID_SMS_WEBHOOK_AUTH_MODES = new Set(['none', 'bearer', 'header']);
const defaultConfigPath = path.resolve(__dirname, '../.runtime/sms-delivery-config.json');
const aliyunSmsClientCache = new Map();
const Dysmsapi20170525Client = Dysmsapi20170525Sdk.default?.default;
const OpenApiConfig = OpenApiSdk.default?.Config || OpenApiSdk.Config;

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeSmsMode(value, fallback = DEFAULT_SMS_MODE) {
  const normalized = normalizeText(value).toLowerCase();
  return VALID_SMS_MODES.has(normalized) ? normalized : fallback;
}

function normalizeSmsRealProvider(value, fallback = DEFAULT_SMS_REAL_PROVIDER) {
  const normalized = normalizeText(value).toLowerCase();
  return VALID_SMS_REAL_PROVIDERS.has(normalized) ? normalized : fallback;
}

function normalizeWebhookAuthMode(value) {
  const normalized = normalizeText(value).toLowerCase();
  return VALID_SMS_WEBHOOK_AUTH_MODES.has(normalized) ? normalized : 'none';
}

function normalizePositiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function parseMockCode(value) {
  const normalized = normalizeText(value);
  return /^\d{6}$/.test(normalized) ? normalized : '';
}

function normalizeMockCode(value, fallback = DEFAULT_SMS_MOCK_CODE) {
  return parseMockCode(value) || fallback;
}

function normalizeMobileList(value) {
  const source = Array.isArray(value)
    ? value
    : value instanceof Set
      ? Array.from(value.values())
      : normalizeText(value).split(/[,\n;]/);
  const seen = new Set();
  const rows = [];
  for (const item of source) {
    const mobile = normalizeText(item);
    if (!mobile || seen.has(mobile)) continue;
    seen.add(mobile);
    rows.push(mobile);
  }
  return rows;
}

function normalizeMobileSet(value) {
  return new Set(normalizeMobileList(value));
}

function normalizeTemplateParamKey(value) {
  const normalized = normalizeText(value);
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(normalized) ? normalized : DEFAULT_SMS_ALIYUN_TEMPLATE_PARAM_KEY;
}

function sleep(ms) {
  const timeoutMs = Math.max(0, Number(ms || 0));
  return new Promise((resolve) => setTimeout(resolve, timeoutMs));
}

function createSmsDeliveryError(code, extra = {}) {
  const error = new Error(code);
  error.code = code;
  for (const [key, value] of Object.entries(extra)) {
    if (typeof value === 'undefined') continue;
    error[key] = value;
  }
  return error;
}

function createAuthCode() {
  return String(crypto.randomInt(100000, 1000000));
}

function buildWebhookHeaders(config) {
  const headers = {
    'content-type': 'application/json',
  };
  if (config.realWebhookAuthMode === 'bearer' && config.realWebhookToken) {
    headers.authorization = `Bearer ${config.realWebhookToken}`;
  }
  if (config.realWebhookAuthMode === 'header' && config.realWebhookToken) {
    headers[config.realWebhookAuthHeader] = config.realWebhookToken;
  }
  return headers;
}

function readConfigFileSync(configFilePath) {
  try {
    const raw = fs.readFileSync(configFilePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function resolveBaseSmsEnvConfig(env = process.env) {
  const nodeEnv = normalizeText(env.NODE_ENV).toLowerCase();
  const isProd = nodeEnv === 'production';
  const fallbackMode = isProd ? 'real' : DEFAULT_SMS_MODE;
  return {
    isProd,
    allowMockInProduction: normalizeText(env.SMS_ALLOW_MOCK_IN_PRODUCTION).toLowerCase() === 'true',
    mode: normalizeSmsMode(env.SMS_MODE, fallbackMode),
    mockCode: normalizeMockCode(env.SMS_MOCK_CODE || env.DEV_SMS_CODE),
    testMobiles: normalizeMobileList(env.SMS_TEST_MOBILES),
    realProvider: normalizeSmsRealProvider(env.SMS_REAL_PROVIDER, DEFAULT_SMS_REAL_PROVIDER),
    realWebhookUrl: normalizeText(env.SMS_REAL_WEBHOOK_URL),
    realWebhookTimeoutMs: normalizePositiveInt(
      env.SMS_REAL_WEBHOOK_TIMEOUT_MS,
      DEFAULT_SMS_REAL_WEBHOOK_TIMEOUT_MS,
    ),
    realWebhookAuthMode: normalizeWebhookAuthMode(env.SMS_REAL_WEBHOOK_AUTH_MODE),
    realWebhookAuthHeader: normalizeText(env.SMS_REAL_WEBHOOK_AUTH_HEADER) || 'x-sms-token',
    realWebhookToken: normalizeText(env.SMS_REAL_WEBHOOK_TOKEN),
    realSignName: normalizeText(env.SMS_REAL_SIGN_NAME),
    realTemplateId: normalizeText(env.SMS_REAL_TEMPLATE_ID),
    aliyunAccessKeyId: normalizeText(env.ALIYUN_SMS_ACCESS_KEY_ID || env.ALIBABA_CLOUD_ACCESS_KEY_ID),
    aliyunAccessKeySecret: normalizeText(env.ALIYUN_SMS_ACCESS_KEY_SECRET || env.ALIBABA_CLOUD_ACCESS_KEY_SECRET),
    aliyunSignName: normalizeText(env.ALIYUN_SMS_SIGN_NAME || env.SMS_REAL_SIGN_NAME),
    aliyunTemplateCode: normalizeText(env.ALIYUN_SMS_TEMPLATE_CODE || env.SMS_REAL_TEMPLATE_ID),
    aliyunTemplateParamKey: normalizeTemplateParamKey(env.ALIYUN_SMS_TEMPLATE_PARAM_KEY),
    aliyunEndpoint: normalizeText(env.ALIYUN_SMS_ENDPOINT) || DEFAULT_SMS_ALIYUN_ENDPOINT,
  };
}

function resolveRealSmsProviderNotReadyReason(config) {
  if (config.realProvider === 'webhook') {
    if (!config.realWebhookUrl) {
      return '当前未配置真实短信 Webhook 地址，请先设置 SMS_REAL_WEBHOOK_URL。';
    }
    return '';
  }

  if (config.realProvider === 'aliyun') {
    if (!config.aliyunAccessKeyId) {
      return '当前未配置阿里云 AccessKey ID，请先设置 ALIYUN_SMS_ACCESS_KEY_ID。';
    }
    if (!config.aliyunAccessKeySecret) {
      return '当前未配置阿里云 AccessKey Secret，请先设置 ALIYUN_SMS_ACCESS_KEY_SECRET。';
    }
    if (!config.aliyunSignName) {
      return '当前未配置阿里云短信签名，请先设置 ALIYUN_SMS_SIGN_NAME。';
    }
    if (!config.aliyunTemplateCode) {
      return '当前未配置阿里云短信模板，请先设置 ALIYUN_SMS_TEMPLATE_CODE。';
    }
    if (!config.aliyunTemplateParamKey) {
      return '当前未配置阿里云模板变量名，请先设置 ALIYUN_SMS_TEMPLATE_PARAM_KEY。';
    }
    return '';
  }

  return '当前仅支持 Webhook 短信网关或阿里云短信，请先设置 SMS_REAL_PROVIDER=webhook 或 aliyun。';
}

function realProviderLabel(provider) {
  if (provider === 'webhook') return 'Webhook 短信网关';
  if (provider === 'aliyun') return '阿里云短信';
  return '未支持的短信提供商';
}

export function resolveSmsDeliveryConfigPath(env = process.env) {
  return normalizeText(env.SMS_DELIVERY_CONFIG_PATH) || defaultConfigPath;
}

export function resolveStoredSmsDeliveryConfig(env = process.env) {
  const baseConfig = resolveBaseSmsEnvConfig(env);
  const configPath = resolveSmsDeliveryConfigPath(env);
  const stored = readConfigFileSync(configPath);
  return {
    mode: normalizeSmsMode(stored?.mode, baseConfig.mode),
    mockCode: parseMockCode(stored?.mockCode) || baseConfig.mockCode,
    testMobiles: stored?.testMobiles == null ? baseConfig.testMobiles : normalizeMobileList(stored.testMobiles),
    updatedAt: stored?.updatedAt || null,
    updatedByActorId: Number(stored?.updatedByActorId || 0) || null,
    configPath,
  };
}

export function resolveSmsDeliveryRuntime(env = process.env) {
  const baseConfig = resolveBaseSmsEnvConfig(env);
  const realProviderNotReadyReason = resolveRealSmsProviderNotReadyReason(baseConfig);
  const mockSelectable = !baseConfig.isProd || baseConfig.allowMockInProduction;

  return {
    isProd: baseConfig.isProd,
    allowMockInProduction: baseConfig.allowMockInProduction,
    realProvider: baseConfig.realProvider,
    realProviderLabel: realProviderLabel(baseConfig.realProvider),
    realProviderReady: !realProviderNotReadyReason,
    realProviderNotReadyReason,
    mockSelectable,
    mockNotReadyReason: mockSelectable
      ? ''
      : '生产环境未允许固定验证码发送，请开启 SMS_ALLOW_MOCK_IN_PRODUCTION 或切换到 hybrid / real。',
  };
}

export function listSmsDeliveryModeOptions(env = process.env) {
  const runtime = resolveSmsDeliveryRuntime(env);
  return [
    {
      value: 'mock',
      implemented: true,
      selectable: runtime.mockSelectable,
      description: runtime.mockSelectable
        ? '始终发送固定 6 位验证码，适合本地联调、回归测试和演示环境。'
        : runtime.mockNotReadyReason,
      notReadyReason: runtime.mockSelectable ? '' : runtime.mockNotReadyReason,
    },
    {
      value: 'real',
      implemented: true,
      selectable: runtime.realProviderReady,
      description: runtime.realProviderReady
        ? `每次生成随机 6 位验证码，并通过${runtime.realProviderLabel}发送。`
        : runtime.realProviderNotReadyReason,
      notReadyReason: runtime.realProviderReady ? '' : runtime.realProviderNotReadyReason,
    },
    {
      value: 'hybrid',
      implemented: true,
      selectable: runtime.realProviderReady,
      description: runtime.realProviderReady
        ? `测试手机号仍走固定验证码，其余手机号通过${runtime.realProviderLabel}发送。`
        : runtime.realProviderNotReadyReason,
      notReadyReason: runtime.realProviderReady ? '' : runtime.realProviderNotReadyReason,
    },
  ];
}

export function resolveSmsDeliveryAdminPayload(env = process.env) {
  const storedConfig = resolveStoredSmsDeliveryConfig(env);
  return {
    ok: true,
    config: {
      mode: storedConfig.mode,
      mockCode: storedConfig.mockCode,
      testMobiles: storedConfig.testMobiles,
      updatedAt: storedConfig.updatedAt,
      updatedByActorId: storedConfig.updatedByActorId,
    },
    runtime: resolveSmsDeliveryRuntime(env),
    options: listSmsDeliveryModeOptions(env),
  };
}

function assertSmsModeSelectable(mode, env = process.env) {
  const option = listSmsDeliveryModeOptions(env).find((item) => item.value === mode);
  if (!option) throw new Error('SMS_MODE_INVALID');
  if (!option.selectable) {
    if (mode === 'mock') throw new Error('SMS_MODE_NOT_ALLOWED');
    throw new Error('SMS_PROVIDER_NOT_READY');
  }
}

export function resolveSmsDeliveryConfig(env = process.env) {
  const baseConfig = resolveBaseSmsEnvConfig(env);
  const storedConfig = resolveStoredSmsDeliveryConfig(env);
  const mode = normalizeSmsMode(storedConfig.mode, baseConfig.mode);

  if (baseConfig.isProd && mode === 'mock' && !baseConfig.allowMockInProduction) {
    throw new Error('SMS_MODE_NOT_ALLOWED');
  }

  return {
    isProd: baseConfig.isProd,
    allowMockInProduction: baseConfig.allowMockInProduction,
    mode,
    mockCode: parseMockCode(storedConfig.mockCode) || baseConfig.mockCode,
    testMobiles: normalizeMobileSet(storedConfig.testMobiles),
    realProvider: baseConfig.realProvider,
    realWebhookUrl: baseConfig.realWebhookUrl,
    realWebhookTimeoutMs: baseConfig.realWebhookTimeoutMs,
    realWebhookAuthMode: baseConfig.realWebhookAuthMode,
    realWebhookAuthHeader: baseConfig.realWebhookAuthHeader,
    realWebhookToken: baseConfig.realWebhookToken,
    realSignName: baseConfig.realSignName,
    realTemplateId: baseConfig.realTemplateId,
    aliyunAccessKeyId: baseConfig.aliyunAccessKeyId,
    aliyunAccessKeySecret: baseConfig.aliyunAccessKeySecret,
    aliyunSignName: baseConfig.aliyunSignName,
    aliyunTemplateCode: baseConfig.aliyunTemplateCode,
    aliyunTemplateParamKey: baseConfig.aliyunTemplateParamKey,
    aliyunEndpoint: baseConfig.aliyunEndpoint,
    updatedAt: storedConfig.updatedAt,
    updatedByActorId: storedConfig.updatedByActorId,
    configPath: storedConfig.configPath,
  };
}

export async function saveSmsDeliveryConfig({
  mode,
  mockCode,
  testMobiles,
  updatedByActorId = null,
  env = process.env,
} = {}) {
  const storedConfig = resolveStoredSmsDeliveryConfig(env);
  const normalizedMode = normalizeSmsMode(mode, '');
  if (!normalizedMode) throw new Error('SMS_MODE_INVALID');
  assertSmsModeSelectable(normalizedMode, env);

  const nextMockCode = mockCode == null ? storedConfig.mockCode : parseMockCode(mockCode);
  if (!nextMockCode) throw new Error('SMS_MOCK_CODE_INVALID');

  const nextPayload = {
    mode: normalizedMode,
    mockCode: nextMockCode,
    testMobiles: testMobiles == null ? storedConfig.testMobiles : normalizeMobileList(testMobiles),
    updatedAt: new Date().toISOString(),
    updatedByActorId: Number(updatedByActorId || 0) || null,
  };

  const configPath = resolveSmsDeliveryConfigPath(env);
  await mkdir(path.dirname(configPath), { recursive: true });
  const tmpPath = `${configPath}.tmp`;
  await writeFile(tmpPath, JSON.stringify(nextPayload, null, 2), 'utf-8');
  await rename(tmpPath, configPath);
  return resolveSmsDeliveryAdminPayload(env);
}

export function resolveSmsDeliveryPlan({ mobile, env = process.env } = {}) {
  const normalizedMobile = normalizeText(mobile);
  const config = resolveSmsDeliveryConfig(env);
  const isMockDelivery =
    config.mode === 'mock' || (config.mode === 'hybrid' && config.testMobiles.has(normalizedMobile));

  return {
    config,
    mobile: normalizedMobile,
    code: isMockDelivery ? config.mockCode : createAuthCode(),
    deliveryMode: isMockDelivery ? 'mock' : 'real',
    exposeDevCode: !config.isProd && isMockDelivery,
  };
}

function getAliyunSmsClient(config) {
  const cacheKey = JSON.stringify({
    endpoint: config.aliyunEndpoint,
    accessKeyId: config.aliyunAccessKeyId,
    accessKeySecret: config.aliyunAccessKeySecret,
  });
  const cached = aliyunSmsClientCache.get(cacheKey);
  if (cached) return cached;

  const client = new Dysmsapi20170525Client(
    new OpenApiConfig({
      accessKeyId: config.aliyunAccessKeyId,
      accessKeySecret: config.aliyunAccessKeySecret,
      endpoint: config.aliyunEndpoint,
    }),
  );
  aliyunSmsClientCache.set(cacheKey, client);
  return client;
}

function buildAliyunTemplateParam(config, code) {
  return JSON.stringify({
    [config.aliyunTemplateParamKey]: String(code || ''),
  });
}

function formatAliyunSendDate(date = new Date()) {
  return new Date(date).toISOString().slice(0, 10).replace(/-/g, '');
}

function normalizeAliyunSendDetailRows(responseBody) {
  const dto = responseBody?.smsSendDetailDTOs?.smsSendDetailDTO;
  if (Array.isArray(dto)) return dto.filter((item) => item && typeof item === 'object');
  if (dto && typeof dto === 'object') return [dto];
  return [];
}

function resolveAliyunDeliveryFailure(rows = []) {
  for (const row of rows) {
    const providerErrCode = normalizeText(row?.errCode).toUpperCase();
    if (!providerErrCode) continue;
    if (providerErrCode === 'DELIVERED') continue;
    return {
      providerErrCode,
      sendStatus: Number(row?.sendStatus || 0) || null,
      content: normalizeText(row?.content),
      sendDate: normalizeText(row?.sendDate),
      phoneNum: normalizeText(row?.phoneNum),
      templateCode: normalizeText(row?.templateCode),
    };
  }
  return null;
}

async function queryAliyunSendDetails({
  mobile,
  providerBizId,
  config,
  aliyunQuerySendDetailsImpl = null,
} = {}) {
  if (
    !providerBizId
    || !config.aliyunAccessKeyId
    || !config.aliyunAccessKeySecret
    || !config.aliyunEndpoint
  ) {
    return { rows: [], providerRequestId: '', providerQueryCode: '' };
  }

  const requestPayload = {
    phoneNumber: normalizeText(mobile),
    bizId: String(providerBizId || ''),
    sendDate: formatAliyunSendDate(),
    currentPage: 1,
    pageSize: 10,
  };
  const response = typeof aliyunQuerySendDetailsImpl === 'function'
    ? await aliyunQuerySendDetailsImpl(requestPayload)
    : await getAliyunSmsClient(config).querySendDetails(new Dysmsapi20170525Sdk.QuerySendDetailsRequest(requestPayload));
  const responseBody = response?.body || response || {};
  return {
    rows: normalizeAliyunSendDetailRows(responseBody),
    providerRequestId: String(responseBody?.requestId || ''),
    providerQueryCode: String(responseBody?.code || ''),
  };
}

async function verifyAliyunDeliveryOutcome({
  mobile,
  providerBizId,
  config,
  aliyunQuerySendDetailsImpl = null,
} = {}) {
  if (!providerBizId) return { verified: false, rows: [], providerRequestId: '', providerQueryCode: '' };

  let lastResult = { rows: [], providerRequestId: '', providerQueryCode: '' };
  const attempts = DEFAULT_SMS_ALIYUN_DETAIL_POLL_ATTEMPTS;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      lastResult = await queryAliyunSendDetails({
        mobile,
        providerBizId,
        config,
        aliyunQuerySendDetailsImpl,
      });
      const failure = resolveAliyunDeliveryFailure(lastResult.rows);
      if (failure) {
        throw createSmsDeliveryError('SMS_DELIVERY_FAILED', {
          provider: 'aliyun',
          providerBizId: String(providerBizId || ''),
          providerRequestId: lastResult.providerRequestId,
          providerQueryCode: lastResult.providerQueryCode,
          ...failure,
        });
      }
      if (lastResult.rows.length > 0) {
        return {
          verified: true,
          rows: lastResult.rows,
          providerRequestId: lastResult.providerRequestId,
          providerQueryCode: lastResult.providerQueryCode,
        };
      }
    } catch (error) {
      if (String(error?.code || error?.message || '') === 'SMS_DELIVERY_FAILED' && error?.providerErrCode) {
        throw error;
      }
      return {
        verified: false,
        rows: [],
        providerRequestId: '',
        providerQueryCode: '',
      };
    }
    if (attempt < attempts - 1) {
      await sleep(DEFAULT_SMS_ALIYUN_DETAIL_POLL_INTERVAL_MS);
    }
  }

  return {
    verified: false,
    rows: lastResult.rows,
    providerRequestId: lastResult.providerRequestId,
    providerQueryCode: lastResult.providerQueryCode,
  };
}

async function deliverSmsCodeViaWebhook({ mobile, code, tenantId, config, fetchImpl }) {
  if (!config.realWebhookUrl || typeof fetchImpl !== 'function') {
    throw createSmsDeliveryError('SMS_PROVIDER_NOT_READY');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.realWebhookTimeoutMs);
  try {
    const response = await fetchImpl(config.realWebhookUrl, {
      method: 'POST',
      headers: buildWebhookHeaders(config),
      body: JSON.stringify({
        scene: 'auth_code',
        mobile: normalizeText(mobile),
        code: String(code || ''),
        tenantId: Number(tenantId || 0) > 0 ? Number(tenantId) : null,
        signName: config.realSignName || null,
        templateId: config.realTemplateId || null,
      }),
      signal: controller.signal,
    });
    if (!response?.ok) throw createSmsDeliveryError('SMS_DELIVERY_FAILED', { provider: 'webhook' });
    return {
      ok: true,
      mode: 'real',
      provider: 'webhook',
      simulated: false,
    };
  } catch (error) {
    if (String(error?.code || error?.message || '') === 'SMS_PROVIDER_NOT_READY') throw error;
    throw createSmsDeliveryError('SMS_DELIVERY_FAILED', { provider: 'webhook' });
  } finally {
    clearTimeout(timeout);
  }
}

async function deliverSmsCodeViaAliyun({
  mobile,
  code,
  config,
  aliyunSendSmsImpl = null,
  aliyunQuerySendDetailsImpl = null,
}) {
  if (
    !config.aliyunAccessKeyId
    || !config.aliyunAccessKeySecret
    || !config.aliyunSignName
    || !config.aliyunTemplateCode
    || !config.aliyunTemplateParamKey
  ) {
    throw createSmsDeliveryError('SMS_PROVIDER_NOT_READY');
  }

  const requestPayload = {
      phoneNumbers: normalizeText(mobile),
      signName: config.aliyunSignName,
      templateCode: config.aliyunTemplateCode,
      templateParam: buildAliyunTemplateParam(config, code),
    };

  try {
    const response = typeof aliyunSendSmsImpl === 'function'
      ? await aliyunSendSmsImpl(requestPayload)
      : await getAliyunSmsClient(config).sendSms(new Dysmsapi20170525Sdk.SendSmsRequest(requestPayload));
    const responseBody = response?.body || response || {};
    if (String(responseBody?.code || '').trim().toUpperCase() !== 'OK') {
      throw createSmsDeliveryError('SMS_DELIVERY_FAILED', {
        provider: 'aliyun',
        providerRequestId: String(responseBody?.requestId || ''),
        providerBizId: String(responseBody?.bizId || ''),
        providerResponseCode: String(responseBody?.code || ''),
      });
    }
    const providerBizId = String(responseBody?.bizId || '');
    let deliveryVerification = {
      verified: false,
      rows: [],
      providerRequestId: '',
      providerQueryCode: '',
      providerErrCode: '',
      sendStatus: null,
    };
    try {
      deliveryVerification = await verifyAliyunDeliveryOutcome({
        mobile,
        providerBizId,
        config,
        aliyunQuerySendDetailsImpl,
      });
    } catch (error) {
      if (String(error?.code || error?.message || '') === 'SMS_PROVIDER_NOT_READY') throw error;
      deliveryVerification = {
        verified: false,
        rows: [],
        providerRequestId: error?.providerRequestId || '',
        providerQueryCode: error?.providerQueryCode || '',
        providerErrCode: error?.providerErrCode || 'DELIVERY_STATUS_UNVERIFIED',
        sendStatus: error?.sendStatus || null,
      };
    }
    return {
      ok: true,
      mode: 'real',
      provider: 'aliyun',
      simulated: false,
      providerRequestId: String(responseBody?.requestId || ''),
      providerBizId,
      deliveryVerified: Boolean(deliveryVerification.verified),
      deliveryWarning: deliveryVerification.verified
        ? ''
        : String(deliveryVerification.providerErrCode || 'DELIVERY_STATUS_UNVERIFIED'),
      providerQueryCode: deliveryVerification.providerQueryCode || '',
      sendStatus: deliveryVerification.sendStatus || null,
    };
  } catch (error) {
    if (String(error?.code || error?.message || '') === 'SMS_PROVIDER_NOT_READY') throw error;
    throw createSmsDeliveryError('SMS_DELIVERY_FAILED', {
      provider: 'aliyun',
      providerErrCode: error?.providerErrCode,
      providerBizId: error?.providerBizId,
      providerRequestId: error?.providerRequestId,
      providerQueryCode: error?.providerQueryCode,
      providerResponseCode: error?.providerResponseCode,
      sendStatus: error?.sendStatus,
    });
  }
}

export async function deliverSmsCode({
  mobile,
  code,
  tenantId = null,
  plan = null,
  fetchImpl = globalThis.fetch,
  aliyunSendSmsImpl = null,
  aliyunQuerySendDetailsImpl = null,
} = {}) {
  const effectivePlan = plan || resolveSmsDeliveryPlan({ mobile });
  if (effectivePlan.deliveryMode !== 'real') {
    return {
      ok: true,
      mode: 'mock',
      provider: 'mock',
      simulated: true,
    };
  }

  const { config } = effectivePlan;
  if (config.realProvider === 'webhook') {
    return deliverSmsCodeViaWebhook({
      mobile: effectivePlan.mobile,
      code: String(code || effectivePlan.code || ''),
      tenantId,
      config,
      fetchImpl,
    });
  }
  if (config.realProvider === 'aliyun') {
    return deliverSmsCodeViaAliyun({
      mobile: effectivePlan.mobile,
      code: String(code || effectivePlan.code || ''),
      config,
      aliyunSendSmsImpl,
      aliyunQuerySendDetailsImpl,
    });
  }

  throw new Error('SMS_PROVIDER_NOT_READY');
}
