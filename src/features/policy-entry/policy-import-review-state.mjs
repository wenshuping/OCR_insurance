export function positiveRouteId(value) {
  const id = Number(value || 0);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function parseCustomerRoute(search = '') {
  const params = new URLSearchParams(search);
  return {
    policyImportTaskId: positiveRouteId(params.get('policyImportTaskId')),
    policyImportRecoveryTaskId: positiveRouteId(params.get('policyImportRecoveryTaskId')),
    policyId: positiveRouteId(params.get('policyId')),
  };
}

export function principalKey(token, guestId) {
  return token ? `token:${token}` : `guest:${guestId}`;
}

export function beginPrincipalLoad(state, nextPrincipalKey) {
  return { ...state, generation: Number(state.generation || 0) + 1, principalKey: nextPrincipalKey };
}

export function acceptPrincipalPolicies(state, generation, expectedPrincipalKey, policies) {
  return state.mounted && state.generation === generation && state.principalKey === expectedPrincipalKey ? policies : null;
}

export function acquireRequestLock(lock) {
  if (lock.current) return false;
  lock.current = true;
  return true;
}

export function createLatestRequestController(options = {}) {
  const AbortControllerImpl = options.AbortControllerImpl || AbortController;
  const setTimer = options.setTimer || setTimeout;
  const clearTimer = options.clearTimer || clearTimeout;
  let generation = 0;
  let disposed = false;
  let locked = false;
  let controller = null;
  let timer = null;
  return {
    async run(operation, runOptions = {}) {
      if (disposed || (runOptions.lock && locked)) return { accepted: false, value: undefined };
      if (runOptions.lock) locked = true;
      controller?.abort();
      controller = new AbortControllerImpl();
      const currentController = controller;
      const currentGeneration = ++generation;
      try {
        const value = await operation(currentController.signal);
        return !disposed && generation === currentGeneration
          ? { accepted: true, value }
          : { accepted: false, value: undefined };
      } catch (error) {
        if (currentController.signal.aborted || disposed || generation !== currentGeneration) return { accepted: false, value: undefined };
        throw error;
      } finally {
        if (runOptions.lock) locked = false;
      }
    },
    schedule(delayMs, callback) {
      if (timer != null) clearTimer(timer);
      if (disposed) return;
      timer = setTimer(() => {
        timer = null;
        if (!disposed) callback();
      }, delayMs);
    },
    clearScheduled() {
      if (timer != null) clearTimer(timer);
      timer = null;
    },
    active() {
      return !disposed;
    },
    dispose() {
      disposed = true;
      generation += 1;
      controller?.abort();
      if (timer != null) clearTimer(timer);
      timer = null;
    },
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
