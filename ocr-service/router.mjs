import express from 'express';
import { respondInsurancePolicyScanError } from './insurance-scan-error.mjs';
import { recognizeDocumentText, recognizePaddleOcrVl16Upload, scanCashValueTable, scanInsurancePolicyLocal } from './insurance-ocr.service.mjs';
import { scanPolicyBodySchema } from './insurance.schemas.mjs';
import { validateBody } from './middleware.mjs';
import { resolvePolicyOcrRuntimePayload } from './ocr-config.service.mjs';

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
        ocrContext: req.body.ocrContext,
        provider: req.body.provider,
      });
      return res.json(payload);
    } catch (err) {
      console.error('[ocr-policy-scan] failed', {
        code: err?.code || err?.message,
        message: err?.message,
        status: err?.status,
      });
      return respondInsurancePolicyScanError(res, err);
    }
  });

  router.post('/internal/ocr/policies/cash-value/scan', requireOcrServiceToken, async (req, res) => {
    try {
      const { uploadItem } = req.body || {};
      if (!uploadItem) {
        return res.status(400).json({ ok: false, error: 'MISSING_UPLOAD', message: '缺少上传图片' });
      }
      const result = await scanCashValueTable({ uploadItem, provider: req.body?.provider });
      return res.json(result);
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: 'CASH_VALUE_SCAN_FAILED',
        message: err instanceof Error ? err.message : '现金价值表扫描失败',
      });
    }
  });

  router.post('/internal/ocr/text/recognize', requireOcrServiceToken, async (req, res) => {
    try {
      const { uploadItem } = req.body || {};
      if (!uploadItem) {
        return res.status(400).json({ ok: false, code: 'MISSING_UPLOAD', message: '缺少上传文件' });
      }
      const ocrText = await recognizeDocumentText(uploadItem, { provider: req.body?.provider });
      return res.json({ ok: true, ocrText });
    } catch (err) {
      return respondInsurancePolicyScanError(res, err);
    }
  });

  router.post('/internal/ocr/product-pages/parse', requireOcrServiceToken, async (req, res) => {
    try {
      const uploadItem = req.body?.uploadItem;
      const pageNo = Math.trunc(Number(req.body?.pageNo || 0));
      if (!uploadItem || pageNo < 1) {
        return res.status(400).json({ ok: false, code: 'INVALID_PRODUCT_PAGE', message: '缺少有效的产品资料页面' });
      }
      const promptVersion = String(req.body?.promptVersion || 'product-ppt-paddle-vl16-v1').trim();
      const result = await recognizePaddleOcrVl16Upload(uploadItem);
      return res.json({
        ok: true,
        provider: 'paddleocr_vl16_autodl',
        model: String(process.env.POLICY_OCR_PADDLEOCR_VL16_MODEL || 'PaddleOCR-VL-1.6').trim(),
        promptVersion,
        pageNo,
        ocrText: result.ocrText,
        markdown: result.markdown,
        boxes: result.boxes,
        tables: result.tables,
      });
    } catch (err) {
      const timeout = String(err?.message || '').includes('POLICY_OCR_UPSTREAM_TIMEOUT');
      return res.status(timeout ? 504 : 503).json({
        ok: false,
        code: timeout ? 'PRODUCT_PPT_PADDLE_VL16_TIMEOUT' : 'PRODUCT_PPT_PADDLE_VL16_UNAVAILABLE',
        message: timeout ? 'PaddleOCR-VL 1.6 产品页面解析超时' : 'PaddleOCR-VL 1.6 产品页面解析服务当前不可用',
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
    res.json(resolvePolicyOcrRuntimePayload());
  });

  return router;
}
