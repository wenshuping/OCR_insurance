export const OCR_SCENARIO_ROUTING_STATE_KEY = 'ocrScenarioRouting';

export const OCR_SCENARIOS = [
  { key: 'policy_entry', label: '保单录入' },
  { key: 'insurance_material', label: '上传保险资料' },
  { key: 'cash_value', label: '现金价值表' },
];

export const OCR_MODEL_OPTIONS = [
  { value: 'default', label: '系统默认模型' },
  { value: 'unlimited_ocr_vllm', label: 'Unlimited-OCR（AutoDL）' },
  { value: 'glm_ocr_vllm', label: 'GLM-OCR（AutoDL）' },
  { value: 'paddleocr_vl16_autodl', label: 'PaddleOCR-VL-1.6（AutoDL）' },
  { value: 'deepseek_ocr_vllm', label: 'DeepSeek-OCR（AutoDL）' },
  { value: 'paddle_local', label: 'PaddleOCR' },
  { value: 'remote_gpu_vision', label: '远程视觉模型' },
];

const MODEL_VALUES = new Set(OCR_MODEL_OPTIONS.map((item) => item.value));
const SCENARIO_KEYS = new Set(OCR_SCENARIOS.map((item) => item.key));

function normalizeProvider(value, fallback = 'default') {
  const provider = String(value || '').trim().toLowerCase();
  return MODEL_VALUES.has(provider) ? provider : fallback;
}

export function normalizeOcrScenarioRoutingConfig(config = {}, { now = '' } = {}) {
  const source = config && typeof config === 'object' && !Array.isArray(config) ? config : {};
  const routes = source.routes && typeof source.routes === 'object' && !Array.isArray(source.routes)
    ? source.routes
    : {};
  return {
    routes: Object.fromEntries(OCR_SCENARIOS.map(({ key }) => [
      key,
      normalizeProvider(routes[key]),
    ])),
    updatedAt: String(source.updatedAt || now || '').trim(),
  };
}

export function getOcrScenarioRoutingConfig(state = {}) {
  return normalizeOcrScenarioRoutingConfig(state?.[OCR_SCENARIO_ROUTING_STATE_KEY]);
}

export function resolveOcrProviderForScenario(state = {}, scenario = '') {
  const key = String(scenario || '').trim().toLowerCase();
  if (!SCENARIO_KEYS.has(key)) return '';
  const provider = getOcrScenarioRoutingConfig(state).routes[key] || 'default';
  return provider === 'default' ? '' : provider;
}

export function buildAdminOcrScenarioRoutingPayload(state = {}) {
  return {
    config: getOcrScenarioRoutingConfig(state),
    scenarios: OCR_SCENARIOS,
    models: OCR_MODEL_OPTIONS,
  };
}
