export function positiveRouteId(value) {
  const id = Number(value || 0);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function parseCustomerRoute(search = '') {
  const params = new URLSearchParams(search);
  return {
    policyImportTaskId: positiveRouteId(params.get('policyImportTaskId')),
    policyId: positiveRouteId(params.get('policyId')),
  };
}

export function removeCustomerRouteParam(path, name) {
  const url = new URL(path, 'https://local.invalid');
  url.searchParams.delete(name);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function resolveOwnedPolicy(requestedPolicyId, policies = []) {
  const id = positiveRouteId(requestedPolicyId);
  return id ? policies.find((policy) => Number(policy?.id) === id) || null : null;
}

export function beginReviewRequest(state) {
  return { ...state, generation: Number(state.generation || 0) + 1 };
}

export function acceptReviewResponse(state, generation, value) {
  return state.mounted && state.generation === generation ? value : null;
}

export function nextPolicyImportPoll(attempt, maxAttempts) {
  if (attempt >= maxAttempts) return { attempt, exhausted: true, delayMs: 0 };
  return { attempt: attempt + 1, exhausted: false, delayMs: Math.min(8000, 1000 * (2 ** attempt)) };
}

export function failedPolicyImportRecoveryUrl(taskId) {
  return `/?policyImportRecoveryTaskId=${positiveRouteId(taskId) || ''}`;
}

export function completedPolicyHref(taskId, completedResult) {
  const policyId = positiveRouteId(completedResult?.policyId);
  return policyId ? `/?policyImportTaskId=${positiveRouteId(taskId)}&policyId=${policyId}` : '';
}
