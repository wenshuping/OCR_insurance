import express from 'express';

export function createClientPerformanceRoutes(context) {
  const router = express.Router();
  const { performanceLogger, sanitizeClientPerformancePayload, logPerformance } = context;

  router.post('/', (req, res) => {
    const payload = sanitizeClientPerformancePayload(req.body);
    logPerformance(performanceLogger, payload.event, payload);
    return res.json({ ok: true });
  });

  return router;
}
