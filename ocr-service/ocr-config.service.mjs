import { spawnSync } from 'node:child_process';

export const POLICY_OCR_MODE_EXISTING_DEFAULT = 'existing_default';
export const POLICY_OCR_MODE_MACOS_VISION_LOCAL = 'macos_vision_local';
export const POLICY_OCR_MODE_PADDLEOCR_LOCAL = 'paddleocr_local';
export const POLICY_OCR_MODE_QWEN25_VL_3B_INSTRUCT_MLX_VLM = 'qwen25_vl_3b_instruct_mlx_vlm';
export const POLICY_OCR_MODE_PADDLEOCR_VL_1_5 = 'paddleocr_vl_1_5';
export const POLICY_OCR_MODE_REMOTE_GPU_VISION = 'remote_gpu_vision';
export const POLICY_OCR_MODE_DEEPSEEK_OCR_VLLM = 'deepseek_ocr_vllm';
export const POLICY_OCR_MODE_UNLIMITED_OCR_VLLM = 'unlimited_ocr_vllm';
export const POLICY_OCR_MODE_GLM_OCR_VLLM = 'glm_ocr_vllm';
export const POLICY_OCR_MODE_PADDLEOCR_VL16_AUTODL = 'paddleocr_vl16_autodl';
export const POLICY_OCR_MODE_HUAWEI_CLOUD_INSURANCE = 'huawei_cloud_insurance';
export const POLICY_OCR_MODE_MINICPM_V_4X_LOCAL = 'minicpm_v_4x_local';
export const POLICY_OCR_MODE_PDF_EXTRACT_KIT_LOCAL = 'pdf_extract_kit_local';

export const OCR_PROVIDER_LOCAL = 'local';
export const OCR_PROVIDER_BAIDU_PRIVATE = 'baidu_private';
export const OCR_PROVIDER_PADDLE_LOCAL = 'paddle_local';
export const OCR_PROVIDER_PADDLEOCR_VL_LOCAL = 'paddleocr_vl_local';
export const OCR_PROVIDER_OLLAMA_VISION_LOCAL = 'ollama_vision_local';
export const OCR_PROVIDER_MLX_QWEN25_VL_LOCAL = 'mlx_qwen25_vl_local';
export const OCR_PROVIDER_REMOTE_GPU_VISION = 'remote_gpu_vision';
export const OCR_PROVIDER_DEEPSEEK_OCR_VLLM = 'deepseek_ocr_vllm';
export const OCR_PROVIDER_UNLIMITED_OCR_VLLM = 'unlimited_ocr_vllm';
export const OCR_PROVIDER_GLM_OCR_VLLM = 'glm_ocr_vllm';
export const OCR_PROVIDER_PADDLEOCR_VL16_AUTODL = 'paddleocr_vl16_autodl';
export const OCR_PROVIDER_HUAWEI_CLOUD_INSURANCE = 'huawei_cloud_insurance';
export const OCR_PROVIDER_PDF_EXTRACT_KIT_LOCAL = 'pdf_extract_kit_local';

function fallbackProviderForDeprecatedProvider(provider) {
  return provider === OCR_PROVIDER_PDF_EXTRACT_KIT_LOCAL ? OCR_PROVIDER_PADDLE_LOCAL : provider;
}

const MODE_META = [
  {
    value: POLICY_OCR_MODE_EXISTING_DEFAULT,
    implemented: true,
    selectable: true,
    description: '沿用当前系统已经存在的保单 OCR 识别链路。',
  },
  {
    value: POLICY_OCR_MODE_MACOS_VISION_LOCAL,
    implemented: true,
    selectable: true,
    description: '使用 macOS Vision 本机 OCR，速度快，适合图片保单优先识别。',
  },
  {
    value: POLICY_OCR_MODE_PADDLEOCR_LOCAL,
    implemented: true,
    selectable: true,
    description: '使用 PaddleOCR 本机识别，首次加载和识别会更慢，但要尽量跑出结果。',
  },
  {
    value: POLICY_OCR_MODE_QWEN25_VL_3B_INSTRUCT_MLX_VLM,
    implemented: true,
    selectable: true,
    description: '使用 Qwen2.5-VL-3B-Instruct + MLX-VLM 在本机完成保单识别。',
  },
  {
    value: POLICY_OCR_MODE_PADDLEOCR_VL_1_5,
    implemented: true,
    selectable: true,
    description: '使用 PaddleOCR-VL-1.5 在本机完成保单版面解析与识别。',
  },
  {
    value: POLICY_OCR_MODE_REMOTE_GPU_VISION,
    implemented: true,
    selectable: true,
    description: '使用 4080 远程视觉模型按页面版面直接解析保单。',
  },
  {
    value: POLICY_OCR_MODE_DEEPSEEK_OCR_VLLM,
    implemented: true,
    selectable: true,
    description: '使用 AutoDL 本机 vLLM DeepSeek-OCR 解析为 Markdown，再进入本系统字段匹配。',
  },
  {
    value: POLICY_OCR_MODE_UNLIMITED_OCR_VLLM,
    implemented: true,
    selectable: true,
    description: '使用 AutoDL 本机 vLLM Unlimited-OCR 解析长文档为 Markdown，再进入本系统字段匹配。',
  },
  {
    value: POLICY_OCR_MODE_GLM_OCR_VLLM,
    implemented: true,
    selectable: true,
    description: '使用 AutoDL 本机 vLLM GLM-OCR 识别保险文档，再进入本系统字段匹配。',
  },
  {
    value: POLICY_OCR_MODE_PADDLEOCR_VL16_AUTODL,
    implemented: true,
    selectable: true,
    description: '使用 AutoDL 本地部署的 PaddleOCR-VL-1.6 完成版面分析与文字识别。',
  },
  {
    value: POLICY_OCR_MODE_HUAWEI_CLOUD_INSURANCE,
    implemented: true,
    selectable: true,
    description: '使用华为云保险单识别 API 返回结构化保单字段。',
  },
  {
    value: POLICY_OCR_MODE_MINICPM_V_4X_LOCAL,
    implemented: false,
    selectable: false,
    description: '待接入。',
  },
];

function envFlag(env, key, defaultValue = false) {
  const raw = env?.[key];
  if (raw == null) return defaultValue;
  return !['0', 'false', 'no', 'off', ''].includes(String(raw).trim().toLowerCase());
}

function hasHuaweiCloudInsuranceRuntimeConfig(env = process.env) {
  const projectId = String(env.POLICY_OCR_HUAWEI_PROJECT_ID || '').trim();
  const token = String(env.POLICY_OCR_HUAWEI_X_AUTH_TOKEN || env.POLICY_OCR_HUAWEI_AUTH_TOKEN || '').trim();
  const ak = String(env.POLICY_OCR_HUAWEI_AK || env.CLOUD_SDK_AK || '').trim();
  const sk = String(env.POLICY_OCR_HUAWEI_SK || env.CLOUD_SDK_SK || '').trim();
  return Boolean(projectId && (token || (ak && sk)));
}

function hasDeepSeekOcrVllmRuntimeConfig(env = process.env) {
  return Boolean(String(env.POLICY_OCR_DEEPSEEK_OCR_BASE_URL || '').trim());
}

function hasUnlimitedOcrVllmRuntimeConfig(env = process.env) {
  return Boolean(String(env.POLICY_OCR_UNLIMITED_OCR_BASE_URL || '').trim());
}

function hasGlmOcrVllmRuntimeConfig(env = process.env) {
  return Boolean(String(env.POLICY_OCR_GLM_OCR_BASE_URL || '').trim());
}

function hasPaddleOcrVl16RuntimeConfig(env = process.env) {
  return Boolean(String(env.POLICY_OCR_PADDLEOCR_VL16_BASE_URL || '').trim());
}

export function resolveLocalVisionFallbackRuntime(env = process.env) {
  return {
    enabled: envFlag(env, 'POLICY_OCR_LOCAL_VISION_FALLBACK', false),
    provider: String(env.POLICY_OCR_LOCAL_VISION_FALLBACK_PROVIDER || OCR_PROVIDER_MLX_QWEN25_VL_LOCAL).trim()
      || OCR_PROVIDER_MLX_QWEN25_VL_LOCAL,
    scope: 'image_only',
  };
}

function getAssumedReadyModesFromEnv(env = process.env) {
  return new Set(
    String(env.POLICY_OCR_ASSUME_READY_MODES || '')
      .split(',')
      .map((item) => normalizePolicyOcrMode(item))
      .filter(Boolean),
  );
}

export function runPythonReadinessProbe({ pythonCommand, projectDir = '', code, env = process.env }) {
  const result = spawnSync(pythonCommand, ['-c', code], {
    cwd: projectDir || undefined,
    encoding: 'utf-8',
    timeout: 15000,
    env: {
      ...env,
      PYTHONIOENCODING: 'utf-8',
    },
  });
  return {
    ok: result.status === 0,
    detail: [String(result.stdout || ''), String(result.stderr || ''), String(result.error?.message || '')]
      .join('\n')
      .trim(),
  };
}

/**
 * Check if Docker daemon is running and the given MinerU image exists.
 * Used as a fallback when magic_pdf is not installed locally.
 */
export function isMineruDockerAvailable(dockerImage = 'mineru-ocr') {
  try {
    const info = spawnSync('docker', ['info'], { encoding: 'utf-8', timeout: 10000 });
    if (info.status !== 0) return false;
    const inspect = spawnSync('docker', ['image', 'inspect', dockerImage], {
      encoding: 'utf-8', timeout: 10000,
    });
    return inspect.status === 0;
  } catch {
    return false;
  }
}

export function buildPolicyOcrPaddleReadinessProbeCode(importLine = 'from paddleocr import PaddleOCRVL') {
  return [
    'import os, sys',
    'project_dir = os.environ.get("POLICY_OCR_PADDLE_PROJECT_DIR", "").strip()',
    'if project_dir and project_dir not in sys.path:',
    '    sys.path.insert(0, project_dir)',
    importLine,
  ].join('\n');
}

export function buildPolicyOcrMlxReadinessProbeCode() {
  return [
    'import mlx_vlm',
    'import torch',
    'import torchvision',
  ].join('\n');
}

export function resolvePolicyOcrModeReadiness(mode, env = process.env) {
  const normalizedMode = normalizePolicyOcrMode(mode);
  if (!normalizedMode || normalizedMode === POLICY_OCR_MODE_EXISTING_DEFAULT) {
    return { ready: true, notReadyReason: '' };
  }
  const assumedReady = getAssumedReadyModesFromEnv(env);
  if (assumedReady.has(normalizedMode)) {
    return { ready: true, notReadyReason: '' };
  }
  if (normalizedMode === POLICY_OCR_MODE_MACOS_VISION_LOCAL) {
    return process.platform === 'darwin'
      ? { ready: true, notReadyReason: '' }
      : { ready: false, notReadyReason: 'macOS Vision OCR 只能在 macOS 本机运行。' };
  }
  if (normalizedMode === POLICY_OCR_MODE_PADDLEOCR_LOCAL) {
    const pythonCommand = String(env.POLICY_OCR_PADDLE_PYTHON || 'python3').trim() || 'python3';
    const projectDir = String(env.POLICY_OCR_PADDLE_PROJECT_DIR || '').trim();
    const probe = runPythonReadinessProbe({
      pythonCommand,
      projectDir,
      code: buildPolicyOcrPaddleReadinessProbeCode('from paddleocr import PaddleOCR'),
      env,
    });
    return probe.ok
      ? { ready: true, notReadyReason: '' }
      : { ready: false, notReadyReason: '当前机器未安装 PaddleOCR 普通识别环境。' };
  }
  if (normalizedMode === POLICY_OCR_MODE_QWEN25_VL_3B_INSTRUCT_MLX_VLM) {
    const pythonCommand = String(env.POLICY_OCR_MLX_PYTHON || 'python3').trim() || 'python3';
    const probe = runPythonReadinessProbe({
      pythonCommand,
      code: buildPolicyOcrMlxReadinessProbeCode(),
      env,
    });
    return probe.ok
      ? { ready: true, notReadyReason: '' }
      : { ready: false, notReadyReason: '当前机器未完成 MLX-VLM 运行环境安装，请补齐 mlx_vlm、torch、torchvision。' };
  }
  if (normalizedMode === POLICY_OCR_MODE_PADDLEOCR_VL_1_5) {
    if (!envFlag(env, 'POLICY_OCR_ENABLE_PADDLEOCR_VL', false)) {
      return {
        ready: false,
        notReadyReason: '当前机器未启用 PaddleOCR-VL-1.5。本地 CPU 模式耗时过长，默认关闭。',
      };
    }
    const pythonCommand = String(env.POLICY_OCR_PADDLE_PYTHON || 'python3').trim() || 'python3';
    const projectDir = String(env.POLICY_OCR_PADDLE_PROJECT_DIR || '').trim();
    const probe = runPythonReadinessProbe({
      pythonCommand,
      projectDir,
      code: buildPolicyOcrPaddleReadinessProbeCode(),
      env,
    });
    return probe.ok
      ? { ready: true, notReadyReason: '' }
      : { ready: false, notReadyReason: '当前机器未安装 paddleocr[doc-parser] / PaddleOCRVL 运行环境。' };
  }
  if (normalizedMode === POLICY_OCR_MODE_REMOTE_GPU_VISION) {
    return String(env.POLICY_OCR_REMOTE_VISION_BASE_URL || '').trim()
      ? { ready: true, notReadyReason: '' }
      : { ready: false, notReadyReason: '请先配置 POLICY_OCR_REMOTE_VISION_BASE_URL 指向 4080 视觉识别服务。' };
  }
  if (normalizedMode === POLICY_OCR_MODE_DEEPSEEK_OCR_VLLM) {
    return hasDeepSeekOcrVllmRuntimeConfig(env)
      ? { ready: true, notReadyReason: '' }
      : { ready: false, notReadyReason: '请先配置 POLICY_OCR_DEEPSEEK_OCR_BASE_URL 指向 AutoDL 本机 DeepSeek-OCR vLLM 服务。' };
  }
  if (normalizedMode === POLICY_OCR_MODE_UNLIMITED_OCR_VLLM) {
    return hasUnlimitedOcrVllmRuntimeConfig(env)
      ? { ready: true, notReadyReason: '' }
      : { ready: false, notReadyReason: '请先配置 POLICY_OCR_UNLIMITED_OCR_BASE_URL 指向 AutoDL Unlimited-OCR vLLM 服务。' };
  }
  if (normalizedMode === POLICY_OCR_MODE_GLM_OCR_VLLM) {
    return hasGlmOcrVllmRuntimeConfig(env)
      ? { ready: true, notReadyReason: '' }
      : { ready: false, notReadyReason: '请先配置 POLICY_OCR_GLM_OCR_BASE_URL 指向 AutoDL GLM-OCR vLLM 服务。' };
  }
  if (normalizedMode === POLICY_OCR_MODE_PADDLEOCR_VL16_AUTODL) {
    return hasPaddleOcrVl16RuntimeConfig(env)
      ? { ready: true, notReadyReason: '' }
      : { ready: false, notReadyReason: '请先配置 POLICY_OCR_PADDLEOCR_VL16_BASE_URL 指向 AutoDL PaddleOCR-VL-1.6 服务。' };
  }
  if (normalizedMode === POLICY_OCR_MODE_HUAWEI_CLOUD_INSURANCE) {
    return hasHuaweiCloudInsuranceRuntimeConfig(env)
      ? { ready: true, notReadyReason: '' }
      : { ready: false, notReadyReason: '请先配置 POLICY_OCR_HUAWEI_PROJECT_ID 以及华为云 OCR Token 或 AK/SK。' };
  }
  if (normalizedMode === POLICY_OCR_MODE_PDF_EXTRACT_KIT_LOCAL) {
    // Check if mineru CLI is on PATH
    const which = spawnSync('sh', ['-c', 'command -v mineru'], { encoding: 'utf-8', timeout: 5000 });
    if (which.status === 0 && String(which.stdout || '').trim()) {
      return { ready: true, notReadyReason: '' };
    }
    // Fallback: check if Docker with mineru-ocr image is available
    const dockerImage = String(env.POLICY_OCR_MINERU_DOCKER_IMAGE || 'mineru-ocr').trim() || 'mineru-ocr';
    if (isMineruDockerAvailable(dockerImage)) {
      return { ready: true, notReadyReason: '' };
    }
    return { ready: false, notReadyReason: '当前机器未安装 mineru CLI，也未找到 Docker 镜像。请运行 pip install "mineru[pipeline]" 或 docker build -t mineru-ocr -f ocr-service/Dockerfile.mineru . 构建镜像。' };
  }
  return { ready: false, notReadyReason: '待接入。' };
}

export function resolvePolicyOcrModeAdminReadiness(mode, env = process.env) {
  const normalizedMode = normalizePolicyOcrMode(mode);
  if (!normalizedMode || normalizedMode === POLICY_OCR_MODE_EXISTING_DEFAULT) {
    return { ready: true, notReadyReason: '' };
  }
  if (normalizedMode === POLICY_OCR_MODE_MACOS_VISION_LOCAL) {
    return process.platform === 'darwin'
      ? { ready: true, notReadyReason: '' }
      : { ready: false, notReadyReason: 'macOS Vision OCR 只能在 macOS 本机运行。' };
  }
  if (normalizedMode === POLICY_OCR_MODE_PADDLEOCR_LOCAL) {
    return { ready: true, notReadyReason: '' };
  }
  if (normalizedMode === POLICY_OCR_MODE_QWEN25_VL_3B_INSTRUCT_MLX_VLM) {
    return { ready: true, notReadyReason: '' };
  }
  if (normalizedMode === POLICY_OCR_MODE_PADDLEOCR_VL_1_5) {
    return envFlag(env, 'POLICY_OCR_ENABLE_PADDLEOCR_VL', false)
      ? { ready: true, notReadyReason: '' }
      : {
          ready: false,
          notReadyReason: '当前机器未启用 PaddleOCR-VL-1.5。本地 CPU 模式耗时过长，默认关闭。',
        };
  }
  if (normalizedMode === POLICY_OCR_MODE_REMOTE_GPU_VISION) {
    return { ready: true, notReadyReason: '' };
  }
  if (normalizedMode === POLICY_OCR_MODE_DEEPSEEK_OCR_VLLM) {
    return { ready: true, notReadyReason: '' };
  }
  if (normalizedMode === POLICY_OCR_MODE_UNLIMITED_OCR_VLLM) {
    return { ready: true, notReadyReason: '' };
  }
  if (normalizedMode === POLICY_OCR_MODE_GLM_OCR_VLLM) {
    return { ready: true, notReadyReason: '' };
  }
  if (normalizedMode === POLICY_OCR_MODE_PADDLEOCR_VL16_AUTODL) {
    return { ready: true, notReadyReason: '' };
  }
  if (normalizedMode === POLICY_OCR_MODE_HUAWEI_CLOUD_INSURANCE) {
    return hasHuaweiCloudInsuranceRuntimeConfig(env)
      ? { ready: true, notReadyReason: '' }
      : { ready: false, notReadyReason: '请先配置 POLICY_OCR_HUAWEI_PROJECT_ID 以及华为云 OCR Token 或 AK/SK。' };
  }
  if (normalizedMode === POLICY_OCR_MODE_PDF_EXTRACT_KIT_LOCAL) {
    return { ready: true, notReadyReason: '' };
  }
  return { ready: false, notReadyReason: '待接入。' };
}

export function normalizePolicyOcrMode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return POLICY_OCR_MODE_EXISTING_DEFAULT;
  if (normalized === POLICY_OCR_MODE_PDF_EXTRACT_KIT_LOCAL) return POLICY_OCR_MODE_PDF_EXTRACT_KIT_LOCAL;
  if (MODE_META.some((item) => item.value === normalized)) return normalized;
  return '';
}

export function listPolicyOcrModeOptions({ probeRuntime = true } = {}) {
  return MODE_META.map((item) => {
    const readiness = probeRuntime
      ? resolvePolicyOcrModeReadiness(item.value)
      : resolvePolicyOcrModeAdminReadiness(item.value);
    return {
      ...item,
      ready: readiness.ready,
      selectable: item.implemented && item.selectable !== false && readiness.ready,
      notReadyReason: readiness.notReadyReason,
      description: readiness.ready ? item.description : readiness.notReadyReason || item.description,
    };
  });
}

export function getLegacyPolicyOcrProviderFromEnv(env = process.env) {
  const provider = String(env.POLICY_OCR_PROVIDER || OCR_PROVIDER_REMOTE_GPU_VISION)
    .trim()
    .toLowerCase();
  return fallbackProviderForDeprecatedProvider(provider || OCR_PROVIDER_REMOTE_GPU_VISION);
}

export function policyOcrProviderLabel(provider) {
  const normalized = String(provider || '').trim().toLowerCase();
  if (normalized === OCR_PROVIDER_BAIDU_PRIVATE) return '百度私有 OCR';
  if (normalized === OCR_PROVIDER_PADDLE_LOCAL) return 'PaddleOCR 本地识别';
  if (normalized === OCR_PROVIDER_PADDLEOCR_VL_LOCAL) return 'PaddleOCR-VL-1.5';
  if (normalized === OCR_PROVIDER_OLLAMA_VISION_LOCAL) return 'Ollama 本地视觉识别';
  if (normalized === OCR_PROVIDER_MLX_QWEN25_VL_LOCAL) return 'Qwen2.5-VL-3B-Instruct + MLX-VLM';
  if (normalized === OCR_PROVIDER_REMOTE_GPU_VISION) return '4080 远程视觉识别';
  if (normalized === OCR_PROVIDER_DEEPSEEK_OCR_VLLM) return 'DeepSeek-OCR 本机 vLLM';
  if (normalized === OCR_PROVIDER_UNLIMITED_OCR_VLLM) return 'Unlimited-OCR 本机 vLLM';
  if (normalized === OCR_PROVIDER_GLM_OCR_VLLM) return 'GLM-OCR 本机 vLLM';
  if (normalized === OCR_PROVIDER_PADDLEOCR_VL16_AUTODL) return 'PaddleOCR-VL-1.6（AutoDL 本地）';
  if (normalized === OCR_PROVIDER_HUAWEI_CLOUD_INSURANCE) return '华为云保险单识别';
  if (normalized === OCR_PROVIDER_PDF_EXTRACT_KIT_LOCAL) return 'PDF-Extract-Kit / MinerU 本地识别';
  return '当前本地默认识别';
}

export function resolveEffectivePolicyOcrProvider() {
  return getLegacyPolicyOcrProviderFromEnv();
}

export function resolveEffectivePolicyOcrProviderFast(env = process.env) {
  return getLegacyPolicyOcrProviderFromEnv(env);
}

export function resolvePolicyOcrRuntimePayload() {
  const legacyProvider = getLegacyPolicyOcrProviderFromEnv();
  const provider = resolveEffectivePolicyOcrProviderFast();
  return {
    ok: true,
    config: {
      mode: POLICY_OCR_MODE_EXISTING_DEFAULT,
      updatedAt: null,
      updatedByActorId: null,
    },
    runtime: {
      provider,
      providerLabel: policyOcrProviderLabel(provider),
      legacyProvider,
      legacyProviderLabel: policyOcrProviderLabel(legacyProvider),
      localVisionFallback: resolveLocalVisionFallbackRuntime(),
    },
  };
}
