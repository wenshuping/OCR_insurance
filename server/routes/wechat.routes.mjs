import express from 'express';
import { sendError } from '../http/errors.mjs';

export function createWechatRoutes(context) {
  const router = express.Router();
  const { createWechatJsSdkSignature } = context;

  router.get('/js-sdk-signature', async (req, res) => {
    try {
      const payload = await createWechatJsSdkSignature(req.query?.url);
      return res.json({ ok: true, ...payload });
    } catch (error) {
      return sendError(res, error);
    }
  });

  return router;
}
