import express from 'express';
import { sendError } from '../http/errors.mjs';

export function createPolicyUploadLinkRoutes({ policyUploadLinks, policyImports }) {
  const router = express.Router();
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const context = (token) => {
    if (!policyUploadLinks) throw Object.assign(new Error('UPLOAD_LINKS_NOT_CONFIGURED'), { code: 'UPLOAD_LINKS_NOT_CONFIGURED', status: 503 });
    const claims = policyUploadLinks.verify(token);
    return { claims, owner: { userId: claims.userId } };
  };
  router.get('/:token', async (req, res) => {
    try {
      const { claims, owner } = context(req.params.token);
      const task = await policyImports.get({ familyId: claims.familyId, taskId: claims.taskId, owner });
      res.json({ ok: true, expiresAt: claims.expiresAt, task });
    } catch (error) { sendError(res, error); }
  });
  router.post('/:token/files', async (req, res) => {
    try {
      const { claims, owner } = context(req.params.token);
      const current = await policyImports.get({ familyId: claims.familyId, taskId: claims.taskId, owner });
      const task = await policyImports.append({ familyId: claims.familyId, taskId: claims.taskId, owner, stateVersion: current.stateVersion, files: req.body?.files });
      res.json({ ok: true, task });
    } catch (error) { sendError(res, error); }
  });
  return router;
}
