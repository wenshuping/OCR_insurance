import express from 'express';
import { corsMiddleware } from './middleware.mjs';
import { resolvePolicyOcrRuntimePayload } from './ocr-config.service.mjs';
import { createOcrServiceRouter } from './router.mjs';

export const createOcrServiceApp = () => {
  const app = express();

  app.use(express.json({ limit: '30mb' }));
  app.use(corsMiddleware);

  app.get('/health', (_req, res) => {
    const payload = resolvePolicyOcrRuntimePayload();
    res.json({
      ok: true,
      service: 'ocr-service',
      provider: payload.runtime.provider,
      providerLabel: payload.runtime.providerLabel,
      mode: payload.config.mode,
    });
  });

  app.get('/ready', (_req, res) => {
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

  app.use(createOcrServiceRouter());

  app.use((req, res) => {
    res.status(404).json({
      code: 'NOT_FOUND',
      message: 'ocr-service route not found',
      path: req.originalUrl || req.url || '',
    });
  });

  return app;
};
