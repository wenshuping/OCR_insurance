export function codeFromError(error) {
  return String(error?.code || error?.message || 'INTERNAL_ERROR');
}

export function statusFromError(error) {
  return Number(error?.status || 500);
}

export function sendError(res, error, fallbackStatus = 500) {
  const code = codeFromError(error);
  const payload = {
    ok: false,
    code,
    message: error?.message && error.message !== code ? error.message : code,
  };
  if (error?.registrationRequiredNext) payload.registrationRequiredNext = true;
  return res.status(statusFromError(error) || fallbackStatus).json(payload);
}
