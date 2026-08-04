import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acceptReviewResponse,
  beginReviewRequest,
  completedPolicyHref,
  createLatestRequestController,
  failedPolicyImportRecoveryUrl,
  acquireRequestLock,
  acceptPrincipalPolicies,
  beginPrincipalLoad,
  principalKey,
  nextPolicyImportPoll,
  parseCustomerRoute,
  removeCustomerRouteParam,
  resolveOwnedPolicy,
} from '../src/features/policy-entry/policy-import-review-state.mjs';

test('customer route parses both task and exact policy while preserving the other parameter', () => {
  assert.deepEqual(parseCustomerRoute('?policyImportTaskId=41&policyId=91'), { policyImportTaskId: 41, policyImportRecoveryTaskId: null, policyId: 91 });
  assert.equal(removeCustomerRouteParam('/?policyImportTaskId=41&policyId=91', 'policyId'), '/?policyImportTaskId=41');
  assert.deepEqual(parseCustomerRoute('?policyId=forged'), { policyImportTaskId: null, policyImportRecoveryTaskId: null, policyId: null });
});

test('component request controller aborts stale loads and ignores completion after dispose', async () => {
  const deferred = [];
  const controller = createLatestRequestController();
  const first = controller.run((signal) => new Promise((resolve) => deferred.push({ resolve, signal })));
  const second = controller.run((signal) => new Promise((resolve) => deferred.push({ resolve, signal })));
  assert.equal(deferred[0].signal.aborted, true);
  deferred[0].resolve('guest');
  deferred[1].resolve('auth');
  assert.deepEqual(await first, { accepted: false, value: undefined });
  assert.deepEqual(await second, { accepted: true, value: 'auth' });
  const after = controller.run(() => Promise.resolve('late'));
  controller.dispose();
  assert.deepEqual(await after, { accepted: false, value: undefined });
});

test('component request controller locks rapid confirms and cleans scheduled polling', async () => {
  let resolve;
  let calls = 0;
  let timerCleared = false;
  const controller = createLatestRequestController({
    setTimer: (callback) => ({ callback }),
    clearTimer: () => { timerCleared = true; },
  });
  const first = controller.run(() => { calls += 1; return new Promise((done) => { resolve = done; }); }, { lock: true });
  assert.deepEqual(await controller.run(() => { calls += 1; return Promise.resolve(); }, { lock: true }), { accepted: false, value: undefined });
  assert.equal(calls, 1);
  controller.schedule(1000, () => {});
  controller.dispose();
  assert.equal(timerCleared, true);
  resolve('saved');
  assert.deepEqual(await first, { accepted: false, value: undefined });
});

test('a deferred guest policy response is ignored after authentication changes principal', () => {
  const guest = beginPrincipalLoad({ generation: 0, principalKey: '', mounted: true }, principalKey('', 'guest-1'));
  const auth = beginPrincipalLoad(guest, principalKey('token-1', 'guest-1'));
  assert.equal(acceptPrincipalPolicies(auth, guest.generation, guest.principalKey, [{ id: 1 }]), null);
  assert.deepEqual(acceptPrincipalPolicies(auth, auth.generation, auth.principalKey, [{ id: 2 }]), [{ id: 2 }]);
});

test('request lock rejects a synchronous duplicate until released', () => {
  const lock = { current: false };
  assert.equal(acquireRequestLock(lock), true);
  assert.equal(acquireRequestLock(lock), false);
  lock.current = false;
  assert.equal(acquireRequestLock(lock), true);
});

test('a task completed elsewhere produces an exact policy link from its safe GET result', () => {
  assert.equal(completedPolicyHref(41, { policyId: 91, completedAt: 'now' }), '/?policyImportTaskId=41&policyId=91');
  assert.equal(completedPolicyHref(41, undefined), '');
});

test('exact policy routing resolves only a policy in the loaded owner collection', () => {
  const policies = [{ id: 91, name: 'owned' }];
  assert.deepEqual(resolveOwnedPolicy(91, policies), policies[0]);
  assert.equal(resolveOwnedPolicy(92, policies), null);
});

test('review request generations ignore stale and unmounted responses', () => {
  const first = beginReviewRequest({ generation: 0, mounted: true });
  const second = beginReviewRequest(first);
  assert.equal(acceptReviewResponse(second, first.generation, { stateVersion: 1 }), null);
  assert.deepEqual(acceptReviewResponse(second, second.generation, { stateVersion: 2 }), { stateVersion: 2 });
  assert.equal(acceptReviewResponse({ ...second, mounted: false }, second.generation, { stateVersion: 3 }), null);
});

test('policy import polling stops at its bounded maximum', () => {
  assert.deepEqual(nextPolicyImportPoll(0, 60), { attempt: 1, exhausted: false, delayMs: 1000 });
  assert.deepEqual(nextPolicyImportPoll(60, 60), { attempt: 60, exhausted: true, delayMs: 0 });
});

test('failed recovery routes back to policy entry with the task context', () => {
  assert.equal(failedPolicyImportRecoveryUrl(41), '/?policyImportRecoveryTaskId=41');
  assert.equal(removeCustomerRouteParam('/?policyImportTaskId=42&policyImportRecoveryTaskId=41&policyId=91', 'policyImportRecoveryTaskId'), '/?policyImportTaskId=42&policyId=91');
});
