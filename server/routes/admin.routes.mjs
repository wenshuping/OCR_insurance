import express from 'express';
import { sendError } from '../http/errors.mjs';

export function createAdminRoutes(context) {
  const router = express.Router();
  const {
    state,
    persist,
    adminPassword,
    adminSessionTtlMs,
    requireAdmin,
    createAdminSession,
    buildAdminOverview,
    rebuildOptionalResponsibilityGovernance,
    requestOcrServiceConfig,
    buildAdminOfficialDomainProfiles,
    getDefaultOfficialDomainProfiles,
    normalizeAdminOfficialDomainProfileInput,
    buildAdminKnowledgeRecords,
    normalizeAdminKnowledgeCrawlInput,
    crawlOfficialKnowledge,
    buildEffectiveOfficialDomainProfiles,
    knowledgeFetchImpl,
    upsertKnowledgeRecords,
    getMembershipConfig,
    updateMembershipConfig,
    allocateId,
  } = context;

  router.post('/login', async (req, res) => {
    try {
      if (!adminPassword) {
        const error = new Error('后台密码未配置');
        error.code = 'ADMIN_PASSWORD_NOT_CONFIGURED';
        error.status = 503;
        throw error;
      }
      if (String(req.body?.password || '') !== adminPassword) {
        const error = new Error('后台密码不正确');
        error.code = 'INVALID_ADMIN_PASSWORD';
        error.status = 401;
        throw error;
      }
      const token = createAdminSession(state);
      await persist(state);
      res.json({ ok: true, token, expiresInSeconds: Math.floor(adminSessionTtlMs / 1000) });
    } catch (error) {
      sendError(res, error, 401);
    }
  });

  router.get('/overview', async (req, res) => {
    const session = requireAdmin(req, res, state, adminPassword);
    if (!session) return;
    res.json({ ok: true, ...buildAdminOverview(state) });
  });

  router.post('/optional-responsibilities/:id/not-quantifiable', async (req, res) => {
    const session = requireAdmin(req, res, state, adminPassword);
    if (!session) return;
    try {
      const id = String(req.params.id || '').trim();
      const record = (state.optionalResponsibilityRecords || []).find((row) => String(row.id || '') === id);
      if (!record) {
        return res.status(404).json({ ok: false, code: 'OPTIONAL_RESPONSIBILITY_NOT_FOUND', message: '可选责任不存在' });
      }
      record.quantificationStatus = 'not_quantifiable';
      record.quantificationReason = String(req.body?.reason || '不进入量化计算').trim();
      record.updatedAt = new Date().toISOString();
      await persist(state);
      res.json({ ok: true, record });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/optional-responsibilities/reextract', async (req, res) => {
    const session = requireAdmin(req, res, state, adminPassword);
    if (!session) return;
    try {
      Object.assign(state, rebuildOptionalResponsibilityGovernance(state));
      await persist(state);
      res.json({
        ok: true,
        optionalResponsibilityCount: (state.optionalResponsibilityRecords || []).length,
        optionalIndicatorCount: (state.insuranceIndicatorRecords || []).filter((row) => row.responsibilityScope === 'optional').length,
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/ocr-config', async (req, res) => {
    const session = requireAdmin(req, res, state, adminPassword);
    if (!session) return;
    try {
      res.json(await requestOcrServiceConfig());
    } catch (error) {
      sendError(res, error, 503);
    }
  });

  router.post('/ocr-config', async (req, res) => {
    const session = requireAdmin(req, res, state, adminPassword);
    if (!session) return;
    try {
      res.json(
        await requestOcrServiceConfig({
          method: 'POST',
          body: {
            mode: req.body?.mode,
          },
        }),
      );
    } catch (error) {
      sendError(res, error, 400);
    }
  });

  router.get('/official-domain-profiles', async (req, res) => {
    const session = requireAdmin(req, res, state, adminPassword);
    if (!session) return;
    res.json({
      ok: true,
      profiles: buildAdminOfficialDomainProfiles(state),
      defaultCount: getDefaultOfficialDomainProfiles().length,
      customCount: (state.officialDomainProfiles || []).length,
    });
  });

  router.post('/official-domain-profiles', async (req, res) => {
    const session = requireAdmin(req, res, state, adminPassword);
    if (!session) return;
    try {
      const profile = normalizeAdminOfficialDomainProfileInput(state, req.body);
      state.officialDomainProfiles.push(profile);
      await persist(state);
      res.status(201).json({ ok: true, profile, profiles: buildAdminOfficialDomainProfiles(state) });
    } catch (error) {
      sendError(res, error, 400);
    }
  });

  router.post('/official-domain-profiles/:id', async (req, res) => {
    const session = requireAdmin(req, res, state, adminPassword);
    if (!session) return;
    try {
      const id = String(req.params.id || '').trim();
      const existing = (state.officialDomainProfiles || []).find((profile) => String(profile.id || '') === id) || null;
      const profile = normalizeAdminOfficialDomainProfileInput(state, { ...req.body, createdAt: existing?.createdAt }, id);
      state.officialDomainProfiles = (state.officialDomainProfiles || []).filter((row) => String(row.id || '') !== id);
      state.officialDomainProfiles.push(profile);
      await persist(state);
      res.json({ ok: true, profile, profiles: buildAdminOfficialDomainProfiles(state) });
    } catch (error) {
      sendError(res, error, 400);
    }
  });

  router.delete('/official-domain-profiles/:id', async (req, res) => {
    const session = requireAdmin(req, res, state, adminPassword);
    if (!session) return;
    const id = String(req.params.id || '').trim();
    state.officialDomainProfiles = (state.officialDomainProfiles || []).filter((row) => String(row.id || '') !== id);
    await persist(state);
    res.json({ ok: true, profiles: buildAdminOfficialDomainProfiles(state) });
  });

  router.get('/knowledge-records', async (req, res) => {
    const session = requireAdmin(req, res, state, adminPassword);
    if (!session) return;
    const records = buildAdminKnowledgeRecords(state);
    res.json({
      ok: true,
      records,
      summary: {
        count: records.length,
        officialCount: records.filter((record) => record.official).length,
      },
    });
  });

  router.post('/knowledge-crawl', async (req, res) => {
    const session = requireAdmin(req, res, state, adminPassword);
    if (!session) return;
    try {
      const policy = normalizeAdminKnowledgeCrawlInput(req.body);
      const discovered = await crawlOfficialKnowledge({
        policy,
        officialDomainProfiles: buildEffectiveOfficialDomainProfiles(state),
        fetchImpl: knowledgeFetchImpl,
      });
      const saved = upsertKnowledgeRecords(state, discovered, {
        allocateId,
        officialDomainProfiles: buildEffectiveOfficialDomainProfiles(state),
      });
      await persist(state);
      res.json({
        ok: true,
        policy,
        savedCount: saved.length,
        records: buildAdminKnowledgeRecords(state),
        discovered,
      });
    } catch (error) {
      sendError(res, error, 400);
    }
  });

  router.get('/membership-config', async (req, res) => {
    const session = requireAdmin(req, res, state, adminPassword);
    if (!session) return;
    res.json({ ok: true, config: getMembershipConfig(state) });
  });

  router.patch('/membership-config', async (req, res) => {
    const session = requireAdmin(req, res, state, adminPassword);
    if (!session) return;
    try {
      const patch = {};
      if (Object.hasOwn(req.body || {}, 'enabled')) patch.enabled = req.body.enabled;
      if (Object.hasOwn(req.body || {}, 'registeredFreePolicyQuota')) {
        patch.registeredFreePolicyQuota = req.body.registeredFreePolicyQuota;
      }
      const config = updateMembershipConfig(state, patch);
      await persist(state);
      res.json({ ok: true, config });
    } catch (error) {
      sendError(res, error, 400);
    }
  });

  return router;
}
