import express from 'express';
import { sendError } from '../http/errors.mjs';

function routeError(code, status, message = code) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function requiredString(value, code) {
  const normalized = String(value || '').trim();
  if (!normalized) throw routeError(code, 400);
  return normalized;
}

function principalFromBody(body, { requireRequestId = false } = {}) {
  const principal = {
    corpId: requiredString(body?.corpId, 'CORP_ID_REQUIRED'),
    dingUserId: requiredString(body?.dingUserId, 'DING_USER_ID_REQUIRED'),
  };
  if (requireRequestId) requiredString(body?.requestId, 'REQUEST_ID_REQUIRED');
  return principal;
}

function requireCustomer(req, state, resolveAuthUser) {
  const user = resolveAuthUser(req, state);
  if (!user) throw routeError('UNAUTHORIZED', 401);
  return user;
}

function changedChallenges(before, after) {
  return (after || []).filter((row, index) => JSON.stringify(row) !== JSON.stringify(before[index]));
}

function maskedMobileForUser(state, userId) {
  const mobile = String((state.users || []).find((user) => Number(user.id) === Number(userId))?.mobile || '');
  return mobile.length >= 7 ? `${mobile.slice(0, 3)}****${mobile.slice(-4)}` : undefined;
}

function safeTaskRef(value) {
  const taskRef = String(value || '').trim();
  return /^[A-Za-z0-9_-]{1,128}$/.test(taskRef) ? taskRef : undefined;
}

const IDENTITY_ERROR_STATUS = Object.freeze({
  ADVISOR_ACCOUNT_INACTIVE: 409,
  ALREADY_BOUND: 409,
  AMBIGUOUS_PRINCIPAL: 409,
  CHALLENGE_EXPIRED: 409,
  CHALLENGE_INVALIDATED: 409,
  CHALLENGE_NOT_FOUND: 404,
  CHALLENGE_PRINCIPAL_MISMATCH: 403,
  CHALLENGE_USED: 409,
  CHALLENGE_USER_MISMATCH: 403,
  MOBILE_MISMATCH: 403,
  MOBILE_VERIFICATION_REQUIRED: 403,
  PENDING_IDENTITY_NOT_FOUND: 409,
  REBIND_REQUIRES_REVOKE: 409,
});

function sendIdentityError(res, error) {
  const mappedStatus = IDENTITY_ERROR_STATUS[error?.code];
  if (mappedStatus) {
    error.status = mappedStatus;
    return sendError(res, error);
  }
  if (error?.status && /^[A-Z][A-Z0-9_]*$/.test(String(error.code || ''))) {
    return sendError(res, error);
  }
  return sendError(res, routeError('DINGTALK_IDENTITY_FAILED', 500));
}

export function createDingtalkIdentityRoutes(context) {
  const router = express.Router();
  const {
    state,
    resolveAuthUser,
    authenticateDingtalkServiceRequest,
    getDingtalkUserProfile,
    dingtalkAllowedUserIds = [],
    persistDingtalkIdentityState,
    findAdvisorBindingCandidate,
    createAdvisorBindingChallenge,
    confirmAdvisorBinding,
    revokeAdvisorBinding,
    nowIso,
  } = context;

  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  async function requireService(req) {
    if (typeof authenticateDingtalkServiceRequest !== 'function'
      || !await authenticateDingtalkServiceRequest(req)) {
      throw routeError('UNAUTHORIZED', 401);
    }
  }

  function requirePersistence() {
    if (typeof persistDingtalkIdentityState !== 'function') {
      throw routeError('DINGTALK_IDENTITY_PERSISTENCE_NOT_CONFIGURED', 503);
    }
  }

  async function runMutation(mutate) {
    requirePersistence();
    const identitiesBefore = structuredClone(state.userDingtalkIdentities || []);
    const challengesBefore = structuredClone(state.dingtalkBindingChallenges || []);
    try {
      const result = mutate();
      await persistDingtalkIdentityState({
        identity: result.identity,
        challenges: changedChallenges(challengesBefore, state.dingtalkBindingChallenges),
      });
      return result;
    } catch (error) {
      state.userDingtalkIdentities = identitiesBefore;
      state.dingtalkBindingChallenges = challengesBefore;
      throw error;
    }
  }

  router.post('/candidate', async (req, res) => {
    try {
      await requireService(req);
      const principal = principalFromBody(req.body, { requireRequestId: true });
      if (typeof getDingtalkUserProfile !== 'function') {
        throw routeError('DINGTALK_PROFILE_ADAPTER_NOT_CONFIGURED', 503);
      }
      const profile = await getDingtalkUserProfile(principal);
      const candidate = findAdvisorBindingCandidate(state, {
        mobile: String(profile?.mobile || '').trim(),
        allowedUserIds: dingtalkAllowedUserIds,
      });
      if (candidate.status !== 'confirmation_required') {
        throw routeError(
          candidate.status === 'verification_required' ? 'MOBILE_VERIFICATION_REQUIRED' : 'MOBILE_MISMATCH',
          403,
        );
      }
      const { challenge } = await runMutation(() => {
        const createdChallenge = createAdvisorBindingChallenge(state, {
          ...principal,
          userId: candidate.userId,
          mobileFingerprint: candidate.mobileFingerprint,
          now: nowIso(),
        });
        const identity = (state.userDingtalkIdentities || []).find((row) => (
          row.corpId === principal.corpId && row.dingUserId === principal.dingUserId
        ));
        return { identity, challenge: createdChallenge };
      });
      res.json({
        ok: true,
        status: candidate.status,
        maskedMobile: candidate.maskedMobile,
        challenge,
      });
    } catch (error) {
      sendIdentityError(res, error);
    }
  });

  router.post('/confirm', async (req, res) => {
    try {
      await requireService(req);
      const principal = principalFromBody(req.body, { requireRequestId: true });
      const token = requiredString(req.body?.token, 'CHALLENGE_TOKEN_REQUIRED');
      const { identity } = await runMutation(() => ({
        identity: confirmAdvisorBinding(state, { ...principal, token, now: nowIso() }),
      }));
      res.json({
        ok: true,
        status: 'bound',
        maskedMobile: maskedMobileForUser(state, identity.userId),
      });
    } catch (error) {
      sendIdentityError(res, error);
    }
  });

  router.post('/web-bind', async (req, res) => {
    try {
      const user = requireCustomer(req, state, resolveAuthUser);
      const principal = principalFromBody(req.body);
      const token = requiredString(req.body?.token, 'CHALLENGE_TOKEN_REQUIRED');
      if (typeof getDingtalkUserProfile !== 'function') {
        throw routeError('DINGTALK_PROFILE_ADAPTER_NOT_CONFIGURED', 503);
      }
      const profile = await getDingtalkUserProfile(principal);
      const candidate = findAdvisorBindingCandidate(state, {
        mobile: profile?.mobile,
        allowedUserIds: dingtalkAllowedUserIds,
      });
      if (candidate.status === 'verification_required') {
        throw routeError('MOBILE_VERIFICATION_REQUIRED', 403);
      }
      if (candidate.status !== 'confirmation_required' || Number(candidate.userId) !== Number(user.id)) {
        throw routeError('MOBILE_MISMATCH', 403);
      }
      const { identity } = await runMutation(() => ({
        identity: confirmAdvisorBinding(state, {
          ...principal,
          token,
          expectedUserId: user.id,
          expectedMobileFingerprint: candidate.mobileFingerprint,
          now: nowIso(),
        }),
      }));
      const taskRef = safeTaskRef(req.body?.taskRef);
      res.json({ ok: true, status: 'bound', ...(taskRef ? { taskRef } : {}) });
    } catch (error) {
      sendIdentityError(res, error);
    }
  });

  router.delete('/binding', async (req, res) => {
    try {
      const user = requireCustomer(req, state, resolveAuthUser);
      const principal = principalFromBody(req.body);
      const current = (state.userDingtalkIdentities || []).find((row) => (
        row.corpId === principal.corpId && row.dingUserId === principal.dingUserId
        && row.status === 'active' && Number(row.userId) === Number(user.id)
      ));
      if (!current) throw routeError('BINDING_NOT_FOUND', 404);
      await runMutation(() => ({
        identity: revokeAdvisorBinding(state, {
          ...principal,
          reason: 'customer_revoked',
          now: nowIso(),
        }),
      }));
      res.json({ ok: true, status: 'revoked' });
    } catch (error) {
      sendIdentityError(res, error);
    }
  });

  return router;
}
