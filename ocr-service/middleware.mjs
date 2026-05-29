function normalizeCorsOrigins(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function corsMiddleware(req, res, next) {
  const configured = normalizeCorsOrigins(process.env.CORS_ORIGIN);
  const origin = String(req.headers.origin || '').trim();
  const allowAny = !configured.length || configured.includes('*');
  if (origin && (allowAny || configured.includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', allowAny ? origin : configured.find((item) => item === origin));
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization, x-ocr-service-token, x-internal-service');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  return next();
}

export function validateBody(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body || {});
    if (!result.success) {
      return res.status(400).json({
        code: 'INVALID_REQUEST_BODY',
        message: '请求参数格式不正确',
        issues: result.error.issues,
      });
    }
    req.body = result.data;
    return next();
  };
}
