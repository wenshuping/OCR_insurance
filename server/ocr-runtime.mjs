function trim(value) {
  return String(value || '').trim();
}

const DEFAULT_OCR_SERVICE_URL = 'http://127.0.0.1:4105';
const DEFAULT_OCR_TIMEOUT_MS = 600000;

const COMPANY_ALIASES = [
  { value: '新华保险', patterns: [/NCI\s*新华保险/i, /新华(?:人寿)?保险(?:股份有限公司|有限责任公司)?/] },
  {
    value: '中国平安保险',
    patterns: [
      /中国平安(?:人寿|健康|养老)?(?:保险)?(?:股份有限公司|有限责任公司)?/,
      /平安人寿(?:保险)?(?:股份有限公司)?/,
      /平安保险/,
      /PING\s*AN(?:\s+INSURANCE\s+COMPANY\s+OF\s+CHINA(?:,?\s*LTD\.?)?)?/i,
    ],
  },
  { value: '中国人寿保险', patterns: [/中国人寿(?:保险)?(?:股份有限公司)?/, /国寿(?:保险)?/] },
  { value: '中国太平洋保险', patterns: [/中国太平洋(?:人寿|健康)?保险(?:股份有限公司|有限责任公司)?/, /太平洋保险/, /太保寿险/, /中国太保/] },
  { value: '太平人寿', patterns: [/中国太平人寿保险(?:股份有限公司|有限责任公司)?/, /太平人寿/] },
  { value: '中国太平', patterns: [/中国太平保险集团(?:有限责任公司)?/, /中国太平(?!人寿)/, /太平保险集团/] },
  { value: '泰康保险', patterns: [/泰康人寿保险(?:有限责任公司|股份有限公司)?/, /泰康(?:人寿|养老|在线)?保险/, /泰康保险/] },
  { value: '友邦保险', patterns: [/友邦人寿保险(?:有限公司|股份有限公司)?/, /友邦保险/, /\bAIA\b/i] },
  { value: '阳光保险', patterns: [/阳光人寿保险(?:股份有限公司|有限责任公司)?/, /阳光保险/] },
  { value: '人保寿险', patterns: [/中国人民人寿保险股份有限公司/, /人保寿险/, /中国人保寿险/] },
  { value: '人保健康', patterns: [/中国人民健康保险股份有限公司/, /人保健康/] },
  { value: '中邮保险', patterns: [/中邮人寿保险股份有限公司/, /中邮保险/, /中邮人寿/] },
  { value: '招商信诺', patterns: [/招商信诺人寿保险(?:有限公司|股份有限公司)?/, /招商信诺/] },
  { value: '中信保诚', patterns: [/中信保诚人寿保险(?:有限公司|股份有限公司)?/, /信诚人寿/, /中信保诚/] },
  { value: '工银安盛', patterns: [/工银安盛人寿保险(?:有限公司|股份有限公司)?/, /工银安盛/] },
  { value: '建信人寿', patterns: [/建信人寿保险(?:有限公司|股份有限公司)?/, /建信人寿/] },
  { value: '农银人寿', patterns: [/农银人寿保险(?:股份有限公司|有限公司)?/, /农银人寿/] },
  { value: '大家保险', patterns: [/大家人寿保险(?:股份有限公司|有限责任公司)?/, /大家保险/, /大家人寿/] },
  { value: '华夏保险', patterns: [/华夏人寿保险(?:股份有限公司|有限责任公司)?/, /华夏保险/] },
  { value: '富德生命人寿', patterns: [/富德生命人寿保险(?:股份有限公司|有限责任公司)?/, /富德生命人寿/, /生命人寿/] },
  { value: '国华人寿', patterns: [/国华人寿保险(?:股份有限公司|有限责任公司)?/, /国华人寿/] },
  { value: '百年人寿', patterns: [/百年人寿保险(?:股份有限公司|有限责任公司)?/, /百年人寿/] },
  { value: '信泰保险', patterns: [/信泰人寿保险(?:股份有限公司|有限责任公司)?/, /信泰保险/, /信泰人寿/] },
  { value: '中英人寿', patterns: [/中英人寿保险(?:有限公司|股份有限公司)?/, /中英人寿/] },
  { value: '陆家嘴国泰人寿', patterns: [/陆家嘴国泰人寿保险(?:有限责任公司|股份有限公司)?/, /国泰人寿/, /陆家嘴国泰人寿/] },
];

function pickAmount(text) {
  const wan = text.match(/(\d+(?:\.\d+)?)\s*万/);
  if (wan) return Math.round(Number(wan[1]) * 10000);
  const yuan = text.match(/(\d{4,})\s*元/);
  if (yuan) return Number(yuan[1]);
  return 0;
}

function inferCompany(text) {
  const normalized = trim(text);
  const matched = COMPANY_ALIASES.find((item) => item.patterns.some((pattern) => pattern.test(normalized)));
  return matched?.value || '';
}

function inferPolicyName(text) {
  const known = [
    '多倍保障重大疾病保险',
    '平安福',
    '尊享e生',
    '百万医疗保险',
    '终身寿险',
    '年金保险',
  ];
  return known.find((name) => text.includes(name)) || '';
}

function hasUploadData(uploadItem) {
  return Boolean(trim(uploadItem?.dataUrl));
}

function resolveOcrServiceUrl(env) {
  return trim(env.POLICY_OCR_SERVICE_URL || env.POLICY_OCR_LOCAL_SERVICE_URL || DEFAULT_OCR_SERVICE_URL).replace(/\/+$/, '');
}

function resolveOcrTimeoutMs(env) {
  const configured = Number(env.POLICY_OCR_SERVICE_TIMEOUT_MS || 0);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_OCR_TIMEOUT_MS;
}

function fallbackScan({ uploadItem, ocrText }) {
  const text = trim(ocrText) || trim(uploadItem?.name) || '图片已上传，未配置 OCR 服务时仅保留原始文件名。';
  return {
    ok: true,
    ocrText: text,
    data: {
      company: inferCompany(text),
      name: inferPolicyName(text) || 'OCR识别保单',
      applicant: '',
      insured: '',
      insuredIdNumber: '',
      insuredBirthday: '',
      date: '',
      paymentPeriod: text.match(/(\d+年交|趸交)/)?.[1] || '',
      coveragePeriod: text.includes('终身') ? '终身' : '',
      amount: pickAmount(text),
      firstPremium: 0,
    },
  };
}

function enrichScanWithLocalHints(scan, input) {
  const text = trim(scan?.ocrText) || trim(input?.ocrText) || trim(input?.uploadItem?.name);
  const hints = fallbackScan({ uploadItem: input?.uploadItem, ocrText: text });
  return {
    ...scan,
    ocrText: trim(scan?.ocrText) || hints.ocrText,
    data: {
      ...hints.data,
      ...(scan?.data || {}),
      company: trim(scan?.data?.company) || hints.data.company,
      name: trim(scan?.data?.name) || hints.data.name,
      paymentPeriod: trim(scan?.data?.paymentPeriod) || hints.data.paymentPeriod,
      coveragePeriod: trim(scan?.data?.coveragePeriod) || hints.data.coveragePeriod,
      amount: Number(scan?.data?.amount || 0) || hints.data.amount,
      firstPremium: Number(scan?.data?.firstPremium || 0) || hints.data.firstPremium,
    },
  };
}

export async function scanPolicyWithConfiguredRuntime(input, fetchImpl = fetch, env = process.env) {
  const baseUrl = resolveOcrServiceUrl(env);
  if (!baseUrl) return fallbackScan(input);

  const headers = { 'content-type': 'application/json', 'x-internal-service': 'policy-ocr-app' };
  const token = trim(env.POLICY_OCR_SERVICE_TOKEN);
  if (token) headers['x-ocr-service-token'] = token;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), resolveOcrTimeoutMs(env));
  let response;
  try {
    response = await fetchImpl(`${baseUrl}/internal/ocr/policies/scan`, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        uploadItem: input.uploadItem || undefined,
        ocrText: trim(input.ocrText) || undefined,
        ocrContext: input.ocrContext || undefined,
        scenario: trim(input.scenario) || undefined,
        provider: trim(input.provider) || undefined,
      }),
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      const timeoutError = new Error('OCR 识别超时，请压缩图片或稍后重试');
      timeoutError.code = 'POLICY_OCR_UPSTREAM_TIMEOUT';
      timeoutError.status = 504;
      throw timeoutError;
    }
    if (hasUploadData(input.uploadItem)) {
      const unavailable = new Error('本机 OCR 服务未连接，无法识别图片内容');
      unavailable.code = 'POLICY_OCR_SERVICE_UNAVAILABLE';
      unavailable.status = 503;
      throw unavailable;
    }
    return fallbackScan(input);
  } finally {
    clearTimeout(timeout);
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(payload?.message || payload?.code || 'POLICY_OCR_FAILED');
    error.code = payload?.code || 'POLICY_OCR_FAILED';
    error.status = response.status;
    throw error;
  }
  const scanPayload = payload?.scan && typeof payload.scan === 'object' ? payload.scan : payload;
  return enrichScanWithLocalHints(scanPayload, input);
}

export async function recognizeDocumentTextWithConfiguredRuntime(uploadItem, fetchImpl = fetch, env = process.env, provider = '') {
  const baseUrl = resolveOcrServiceUrl(env);
  if (!baseUrl) {
    const error = new Error('本机 OCR 服务未配置，无法识别文件内容');
    error.code = 'POLICY_OCR_SERVICE_UNAVAILABLE';
    error.status = 503;
    throw error;
  }
  const headers = { 'content-type': 'application/json', 'x-internal-service': 'policy-ocr-app' };
  const token = trim(env.POLICY_OCR_SERVICE_TOKEN);
  if (token) headers['x-ocr-service-token'] = token;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), resolveOcrTimeoutMs(env));
  try {
    const response = await fetchImpl(`${baseUrl}/internal/ocr/text/recognize`, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({ uploadItem, scenario: 'insurance_material', provider: trim(provider) || undefined }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(payload?.message || payload?.code || 'OCR 识别失败');
      error.code = payload?.code || 'POLICY_OCR_FAILED';
      error.status = response.status;
      throw error;
    }
    return trim(payload?.ocrText);
  } catch (error) {
    if (error?.name === 'AbortError') {
      const timeoutError = new Error('OCR 识别超时，请压缩文件或稍后重试');
      timeoutError.code = 'POLICY_OCR_UPSTREAM_TIMEOUT';
      timeoutError.status = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function parseProductPageWithPaddleVl16Runtime(input, fetchImpl = fetch, env = process.env) {
  const baseUrl = resolveOcrServiceUrl(env);
  if (!baseUrl) {
    const error = new Error('PaddleOCR-VL 1.6 产品页面解析服务未配置');
    error.code = 'PRODUCT_PPT_PADDLE_VL16_UNAVAILABLE';
    error.status = 503;
    throw error;
  }
  const headers = { 'content-type': 'application/json', 'x-internal-service': 'policy-ocr-app' };
  const token = trim(env.POLICY_OCR_SERVICE_TOKEN);
  if (token) headers['x-ocr-service-token'] = token;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), resolveOcrTimeoutMs(env));
  try {
    const response = await fetchImpl(`${baseUrl}/internal/ocr/product-pages/parse`, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify(input),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) {
      const error = new Error(payload?.message || payload?.code || 'PaddleOCR-VL 1.6 产品页面解析失败');
      error.code = payload?.code || 'PRODUCT_PPT_PADDLE_VL16_FAILED';
      error.status = response.status;
      throw error;
    }
    return payload;
  } catch (error) {
    if (error?.name === 'AbortError') {
      const timeoutError = new Error('PaddleOCR-VL 1.6 产品页面解析超时');
      timeoutError.code = 'PRODUCT_PPT_PADDLE_VL16_TIMEOUT';
      timeoutError.status = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function analyzePolicyLocally({ scan }) {
  const text = `${trim(scan?.ocrText)} ${trim(scan?.data?.name)}`;
  const amount = pickAmount(text) || Number(scan?.data?.amount || 0) || 0;
  const payout = amount > 0 ? `给付基本保险金额${amount >= 10000 ? `${(amount / 10000).toFixed(0)}万元` : `${amount}元`}` : '按合同约定给付';
  const rows = [];

  if (/重疾|重大疾病/.test(text)) {
    rows.push({
      coverageType: '重大疾病保险金',
      scenario: '确诊合同约定重大疾病',
      payout,
      note: '通常给付后该项重大疾病责任终止，具体以条款为准。',
    });
  }
  if (/医疗|住院|门诊/.test(text)) {
    rows.push({
      coverageType: '医疗保险金',
      scenario: '发生合同约定医疗费用',
      payout: amount > 0 ? `最高按${amount >= 10000 ? `${(amount / 10000).toFixed(0)}万元` : `${amount}元`}限额报销` : '按免赔额、赔付比例和责任限额报销',
      note: '医疗责任通常需要结合免赔额、社保结算和医院范围核对。',
    });
  }
  if (/身故|全残/.test(text)) {
    rows.push({
      coverageType: '身故或全残保险金',
      scenario: '被保险人身故或达到合同约定全残状态',
      payout,
      note: '给付后合同通常终止，需以正式条款为准。',
    });
  }
  if (!rows.length) {
    rows.push({
      coverageType: '主险责任',
      scenario: '以保单条款载明责任为准',
      payout,
      note: '当前 OCR 文本较少，建议补充上传责任页后重新识别。',
    });
  }

  return {
    report: `${trim(scan?.data?.company) || '保险公司'} ${trim(scan?.data?.name) || '保单'}已完成识别。请重点核对责任名称、给付条件、责任限额和免责说明。`,
    coverageTable: rows,
  };
}
