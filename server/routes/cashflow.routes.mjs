import express from 'express';
import { sendError } from '../http/errors.mjs';

export function createCashflowRoutes(context) {
  const router = express.Router();
  const {
    state,
    persist,
    persistFamilyState,
    requireAdmin,
    adminPassword,
    cashflowStore,
    cashValueStore,
    computeAndStoreCashflow,
    resolveAuthUser,
    normalizeGuestId,
    resolveOcrServiceUrl,
    archiveFamilyGeneratedReportsForPolicy,
  } = context;
  const familyPersistOptions = { refreshOptionalResponsibilityGovernance: false };

  async function archiveGeneratedFamilyReportsForPolicy(policy) {
    if (typeof archiveFamilyGeneratedReportsForPolicy !== 'function') {
      return { archivedShareCount: 0, archivedSalesReviewCount: 0 };
    }
    const result = archiveFamilyGeneratedReportsForPolicy(state, policy);
    if ((result.archivedShareCount || 0) || (result.archivedSalesReviewCount || 0)) {
      if (persistFamilyState) await persistFamilyState({ includePolicies: false });
      else await persist(state, familyPersistOptions);
    }
    return result;
  }

  router.post('/admin/cashflow/recompute', async (req, res) => {
    const session = requireAdmin(req, res, state, adminPassword);
    if (!session) return;
    try {
      const productFilter = String(req.query?.product || '').trim().toLowerCase();
      const policies = productFilter
        ? state.policies.filter((p) => {
            const name = String(p.name || '').toLowerCase();
            const productName = String(p.productName || '').toLowerCase();
            return name.includes(productFilter) || productName.includes(productFilter);
          })
        : state.policies;

      let recomputed = 0;
      for (const policy of policies) {
        const { cashflowEntries } = computeAndStoreCashflow(policy);
        if (cashflowEntries.length) recomputed++;
      }

      res.json({ ok: true, recomputed });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/admin/cashflow/status', async (req, res) => {
    const session = requireAdmin(req, res, state, adminPassword);
    if (!session) return;
    try {
      res.json({ ok: true, ...cashflowStore.getStatus() });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/policies/:id/cash-value/scan', async (req, res) => {
    try {
      const user = resolveAuthUser(req, state);
      const guestId = normalizeGuestId(req.query?.guestId);
      if (!user && !guestId) {
        return res.status(401).json({ ok: false, code: 'UNAUTHORIZED', message: '缺少游客标识' });
      }

      const policyId = Number(req.params.id);
      const policy = state.policies.find((row) => {
        if (Number(row.id) !== policyId) return false;
        if (user) return Number(row.userId) === Number(user.id);
        return String(row.guestId || '') === guestId && !row.userId;
      });
      if (!policy) {
        return res.status(404).json({ ok: false, code: 'POLICY_NOT_FOUND', message: '保单不存在' });
      }

      const { uploadItem } = req.body || {};
      if (!uploadItem?.dataUrl) {
        return res.status(400).json({ ok: false, error: 'MISSING_UPLOAD', message: '缺少上传图片' });
      }

      // Try OCR service first
      let result = { ok: false, error: 'PARSE_FAILED' };
      try {
        const ocrBaseUrl = resolveOcrServiceUrl();
        if (ocrBaseUrl) {
          const ocrResponse = await fetch(`${ocrBaseUrl}/internal/ocr/policies/cash-value/scan`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-internal-service': 'policy-ocr-app',
              ...(process.env.POLICY_OCR_SERVICE_TOKEN ? { 'x-ocr-service-token': process.env.POLICY_OCR_SERVICE_TOKEN } : {}),
            },
            body: JSON.stringify({ uploadItem }),
            signal: AbortSignal.timeout(120000),
          });
          if (ocrResponse.ok) {
            result = await ocrResponse.json();
          }
        }
      } catch (error) {
        result = {
          ok: false,
          error: 'OCR_SERVICE_UNAVAILABLE',
          message: error instanceof Error ? error.message : 'OCR 服务不可用',
        };
      }

      if (!result.ok) {
        return res.json(result);
      }

      return res.json({
        ok: true,
        source: result.source || 'ocr',
        tableType: result.tableType || 2,
        rows: result.rows,
        rowCount: result.rowCount || result.rows.length,
        confidence: result.confidence || 0.5,
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: 'CASH_VALUE_SCAN_FAILED',
        message: error instanceof Error ? error.message : '现金价值表扫描失败',
      });
    }
  });

  router.post('/policies/:id/cash-value/confirm', async (req, res) => {
    try {
      const user = resolveAuthUser(req, state);
      const guestId = normalizeGuestId(req.query?.guestId);
      if (!user && !guestId) {
        return res.status(401).json({ ok: false, code: 'UNAUTHORIZED', message: '缺少游客标识' });
      }

      const policyId = Number(req.params.id);
      const policy = state.policies.find((row) => {
        if (Number(row.id) !== policyId) return false;
        if (user) return Number(row.userId) === Number(user.id);
        return String(row.guestId || '') === guestId && !row.userId;
      });
      if (!policy) {
        return res.status(404).json({ ok: false, code: 'POLICY_NOT_FOUND', message: '保单不存在' });
      }

      const { rows } = req.body || {};
      if (!Array.isArray(rows) || rows.length === 0) {
        return res.status(400).json({ ok: false, code: 'INVALID_ROWS', message: '缺少现金价值数据' });
      }

      cashValueStore.replaceValues(policyId, rows);
      await archiveGeneratedFamilyReportsForPolicy(policy);

      return res.json({ ok: true, savedCount: rows.length });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: 'CASH_VALUE_SAVE_FAILED',
        message: error instanceof Error ? error.message : '现金价值数据保存失败',
      });
    }
  });

  return router;
}
