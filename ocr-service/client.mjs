export const DEFAULT_OCR_SERVICE_BASE_URL = 'http://127.0.0.1:4105';
const OCR_SCAN_PATH = '/internal/ocr/policies/scan';

function trimToNull(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

export function resolveOcrServiceBaseUrl(env = process.env) {
  return trimToNull(env.POLICY_OCR_SERVICE_URL)?.replace(/\/+$/, '') || '';
}

export function hasConfiguredOcrServiceBaseUrl(env = process.env) {
  return Boolean(resolveOcrServiceBaseUrl(env));
}

function resolveOcrServiceToken(env = process.env) {
  return trimToNull(env.POLICY_OCR_SERVICE_TOKEN);
}

function buildHeaders() {
  const headers = {
    'content-type': 'application/json',
    'x-internal-service': 'api-v1',
    'x-service-name': 'api-v1',
  };
  const token = resolveOcrServiceToken();
  if (token) headers['x-ocr-service-token'] = token;
  return headers;
}

async function fetchWithTimeout(url, init, timeoutMs, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function parseJson(response) {
  const raw = await response.text();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

export async function scanInsurancePolicyOverHttp({ uploadItem, ocrText }, fetchImpl = fetch) {
  const baseUrl = resolveOcrServiceBaseUrl();
  if (!baseUrl) {
    throw new Error('POLICY_OCR_SERVICE_NOT_CONFIGURED');
  }

  const timeoutMs = Math.max(1000, Number(process.env.POLICY_OCR_SERVICE_TIMEOUT_MS || 180000));
  let response;
  const requestBody = {};
  const normalizedOcrText = String(ocrText || '').trim();
  if (uploadItem) requestBody.uploadItem = uploadItem;
  if (normalizedOcrText) requestBody.ocrText = normalizedOcrText;

  try {
    response = await fetchWithTimeout(
      `${baseUrl}${OCR_SCAN_PATH}`,
      {
        method: 'POST',
        headers: buildHeaders(),
        body: JSON.stringify(requestBody),
      },
      timeoutMs,
      fetchImpl,
    );
  } catch (error) {
    if (String(error?.name || '').includes('AbortError')) {
      throw new Error('POLICY_OCR_UPSTREAM_TIMEOUT');
    }
    const upstreamUnavailable = new Error('POLICY_OCR_UPSTREAM_UNAVAILABLE');
    upstreamUnavailable.cause = error;
    throw upstreamUnavailable;
  }

  const payload = await parseJson(response);
  if (!response.ok) {
    const code = trimToNull(payload?.code);
    if (code) throw new Error(code);
    const contractRejected = new Error('POLICY_OCR_UPSTREAM_REJECTED');
    contractRejected.upstreamStatus = response.status;
    contractRejected.upstreamBody = payload;
    throw contractRejected;
  }

  return payload;
}
