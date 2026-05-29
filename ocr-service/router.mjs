import express from 'express';
import { respondInsurancePolicyScanError } from './insurance-scan-error.mjs';
import { scanCashValueTable, scanInsurancePolicyLocal } from './insurance-ocr.service.mjs';
import { scanPolicyBodySchema } from './insurance.schemas.mjs';
import { validateBody } from './middleware.mjs';
import {
  resolvePolicyOcrAdminPayload,
  resolvePolicyOcrRuntimePayload,
  savePolicyOcrConfig,
} from './ocr-config.service.mjs';

function requireOcrServiceToken(req, res, next) {
  const expected = String(process.env.POLICY_OCR_SERVICE_TOKEN || '').trim();
  if (!expected) return next();
  const actual = String(req.headers['x-ocr-service-token'] || '').trim();
  if (actual !== expected) {
    return res.status(401).json({ code: 'OCR_SERVICE_UNAUTHORIZED', message: 'OCR service token invalid' });
  }
  return next();
}

export function createOcrServiceRouter() {
  const router = express.Router();

  router.post('/internal/ocr/policies/scan', requireOcrServiceToken, validateBody(scanPolicyBodySchema), async (req, res) => {
    try {
      const payload = await scanInsurancePolicyLocal({
        uploadItem: req.body.uploadItem,
        ocrText: req.body.ocrText,
      });
      return res.json(payload);
    } catch (err) {
      return respondInsurancePolicyScanError(res, err);
    }
  });

  router.post('/internal/ocr/policies/cash-value/scan', requireOcrServiceToken, async (req, res) => {
    try {
      const { uploadItem } = req.body || {};
      if (!uploadItem) {
        return res.status(400).json({ ok: false, error: 'MISSING_UPLOAD', message: '缺少上传图片' });
      }
      const result = await scanCashValueTable({ uploadItem });
      return res.json(result);
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: 'CASH_VALUE_SCAN_FAILED',
        message: err instanceof Error ? err.message : '现金价值表扫描失败',
      });
    }
  });

  router.get('/internal/ocr-service/health', (_req, res) => {
    const payload = resolvePolicyOcrRuntimePayload();
    res.json({
      ok: true,
      service: 'ocr-service',
      provider: payload.runtime.provider,
      providerLabel: payload.runtime.providerLabel,
      mode: payload.config.mode,
    });
  });

  router.get('/internal/ocr-service/ready', (_req, res) => {
    const payload = resolvePolicyOcrRuntimePayload();
    res.json({
      ok: true,
      service: 'ocr-service',
      ready: true,
      provider: payload.runtime.provider,
      providerLabel: payload.runtime.providerLabel,
      mode: payload.config.mode,
    });
  });

  router.get('/internal/ocr-service/config', requireOcrServiceToken, (_req, res) => {
    res.json(resolvePolicyOcrAdminPayload());
  });

  router.post('/internal/ocr-service/config', requireOcrServiceToken, async (req, res) => {
    try {
      const payload = await savePolicyOcrConfig({
        mode: req.body?.mode,
        updatedByActorId: req.body?.updatedByActorId,
      });
      return res.json(payload);
    } catch (error) {
      const code = String(error?.code || error?.message || 'POLICY_OCR_CONFIG_UPDATE_FAILED');
      const status = code === 'POLICY_OCR_MODE_INVALID' ? 400 : code === 'POLICY_OCR_MODE_NOT_READY' ? 409 : 500;
      const message =
        code === 'POLICY_OCR_MODE_INVALID'
          ? 'OCR 识别方式无效'
          : code === 'POLICY_OCR_MODE_NOT_READY'
            ? '当前 OCR 识别方式未就绪'
            : 'OCR 识别方式更新失败';
      return res.status(status).json({ ok: false, code, message });
    }
  });

  return router;
}
