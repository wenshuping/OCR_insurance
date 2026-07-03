function text(value) {
  return String(value ?? '').trim();
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validateRenderableSummary(summary, issues) {
  if (!isPlainObject(summary)) {
    issues.push({ code: 'invalid_summary_shape', message: 'Summary must be an object.' });
    return false;
  }
  if (!Array.isArray(summary.responsibilities)) {
    issues.push({ code: 'invalid_responsibilities_shape', message: 'Summary responsibilities must be an array.' });
    return false;
  }

  let renderableCount = 0;
  summary.responsibilities.forEach((item, index) => {
    if (!isPlainObject(item)) {
      issues.push({ code: 'invalid_responsibility_shape', index, message: 'Responsibility must be an object.' });
      return;
    }
    const title = text(item.title);
    const hasBody = Boolean(text(item.plainText) || text(item.paymentRule) || text(item.triggerCondition));
    if (!title) issues.push({ code: 'missing_responsibility_title', index });
    if (!hasBody) issues.push({ code: 'missing_responsibility_render_text', index, title });
    if (title && hasBody) renderableCount += 1;
  });

  if (!renderableCount) {
    issues.push({ code: 'empty_responsibilities', message: 'Summary has no renderable customer responsibilities.' });
  }
  return true;
}

export function evaluateResponsibilitySummaryQuality({
  summary = {},
} = {}) {
  const issues = [];
  const shapeUsable = validateRenderableSummary(summary, issues);
  if (!shapeUsable) {
    return { status: 'failed', issues };
  }

  return {
    status: issues.length ? 'failed' : 'passed',
    issues,
  };
}
