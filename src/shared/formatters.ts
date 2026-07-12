const OCR_MODE_LABELS: Record<string, string> = {
  existing_default: '系统默认',
  macos_vision_local: '快速本机 OCR',
  paddleocr_local: 'PaddleOCR 稳定识别',
  qwen25_vl_3b_instruct_mlx_vlm: 'Qwen2.5-VL',
  paddleocr_vl_1_5: 'PaddleOCR-VL',
  remote_gpu_vision: '4080 视觉识别',
  deepseek_ocr_vllm: 'DeepSeek-OCR',
  minicpm_v_4x_local: 'MiniCPM-V',
};

export function normalizeParticipantName(value: string | null | undefined) {
  return String(value || '').trim().replace(/\s+/g, '');
}

export function areSameParticipantName(left: string | null | undefined, right: string | null | undefined) {
  const normalizedLeft = normalizeParticipantName(left);
  const normalizedRight = normalizeParticipantName(right);
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

export function normalizePolicyPlanRoleLabel(role: string) {
  if (role === 'main') return '主险';
  if (role === 'linked_account') return '万能账户';
  if (role === 'rider') return '附加险';
  return '未分类';
}

export function policyPlanRoleOrder(role: string) {
  if (role === 'main') return 0;
  if (role === 'rider') return 1;
  if (role === 'linked_account') return 2;
  return 3;
}

export function normalizeBeneficiaryValue(value: string | undefined | null) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const text = raw.replace(/\s+/gu, '').replace(/^(身故保险金受益人|身故受益人|受益人)[:：]?/u, '');
  if (/^(?:被保险人)?的?法定(?:继承人|继本人|维承人|受益人)?$/u.test(text)) return '法定';
  if (/法定(?:继承人|继本人|维承人|受益人)/u.test(text)) return '法定';
  return raw;
}

export function formatBeneficiaryValue(value: string | undefined | null) {
  return normalizeBeneficiaryValue(value) || '-';
}

export function formatCoverageAmount(value: number) {
  const amount = Number(value || 0);
  if (!amount) return '-';
  return `${(amount / 10000).toFixed(2)}万`;
}

export function formatCurrency(value: number) {
  const amount = Number(value || 0);
  if (!amount) return '¥0';
  return `¥${amount.toLocaleString('zh-CN')}`;
}

export function formatDateLabel(value: string) {
  const text = String(value || '').trim();
  if (!text) return '-';
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return text.slice(0, 10);
  return parsed.toISOString().slice(0, 10);
}

export function maskMobile(mobile: string) {
  return mobile ? `${mobile.slice(0, 3)}****${mobile.slice(-4)}` : '游客模式';
}

export function formatOcrModeLabel(mode: string) {
  return OCR_MODE_LABELS[mode] || mode || '未配置';
}

export function formatNumberText(value: number) {
  if (!Number.isFinite(value)) return '0';
  return Number.isInteger(value) ? value.toLocaleString('zh-CN') : value.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

export function formatFileSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
