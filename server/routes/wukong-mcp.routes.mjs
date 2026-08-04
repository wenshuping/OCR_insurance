import express from 'express';
import { sendError } from '../http/errors.mjs';

function serviceAuthError() {
  const error = new Error('SERVICE_AUTH_REQUIRED');
  error.code = 'SERVICE_AUTH_REQUIRED';
  error.status = 401;
  return error;
}

export function createWukongMcpRoutes({ authenticateDingtalkServiceRequest, wukongMcpGateway }) {
  const router = express.Router();

  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  router.post('/', async (req, res) => {
    try {
      if (typeof authenticateDingtalkServiceRequest !== 'function'
        || !await authenticateDingtalkServiceRequest(req)) throw serviceAuthError();
      const result = await wukongMcpGateway.invoke(req.body);
      res.json({ ok: true, result });
    } catch (error) {
      sendError(res, error);
    }
  });

  return router;
}
