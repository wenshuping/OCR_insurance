import express from 'express';
import { sendError } from '../http/errors.mjs';

function guestPoliciesToMigrate(state, guestId) {
  if (!guestId) return [];
  return (state.policies || []).filter((policy) => String(policy.guestId || '') === guestId && !policy.userId);
}

function assertCanMigrateGuestPolicies({ state, user, incomingPolicyCount, assertUserCanSavePolicy, now }) {
  if (!incomingPolicyCount || typeof assertUserCanSavePolicy !== 'function') return;
  const quotaUser = user?.id ? user : { id: -1 };
  const projectedState = { ...state, policies: [...(state.policies || [])] };
  for (let index = 0; index < incomingPolicyCount; index += 1) {
    assertUserCanSavePolicy(projectedState, quotaUser, { now });
    projectedState.policies.push({ id: `membership-migration-projection-${index}`, userId: quotaUser.id, guestId: '' });
  }
}

export function createAuthRoutes(context) {
  const router = express.Router();
  const {
    state,
    persist,
    analyzer,
    normalizeMobile,
    assertValidMobile,
    assertSmsSendAllowed,
    persistAuthSmsCode,
    persistAuthRegistration,
    smsDeliveryPlanResolver,
    smsDeliverer,
    allocateId,
    normalizeSmsSendError,
    latestValidSmsCode,
    hasPendingSmsCode,
    normalizeGuestId,
    guestPendingScans,
    normalizeProvidedAnalysis,
    ensureDefaultPolicyFamilyBinding,
    buildPolicyFromScan,
    recordPolicySourceRecords,
    clearGuestPendingScans,
    createSession,
    publicUser,
    attachPoliciesCoverageIndicators,
    attachPolicyFamilyDisplay,
    getBearerToken,
    deleteSession,
    assertUserCanSavePolicy,
    nowIso,
  } = context;

  router.post('/send-code', async (req, res) => {
    try {
      const mobile = normalizeMobile(req.body?.mobile);
      assertValidMobile(mobile);
      assertSmsSendAllowed(state, mobile);
      const deliveryPlan = smsDeliveryPlanResolver({ mobile });
      const code = String(deliveryPlan?.code || '').trim();
      if (!/^\d{6}$/.test(code)) {
        const error = new Error('INVALID_CODE');
        error.status = 500;
        throw error;
      }
      const delivery = await smsDeliverer({
        mobile,
        code,
        plan: deliveryPlan,
      });
      const now = new Date();
      const sms = {
        id: allocateId(state),
        mobile,
        code,
        deliveryMode: String(delivery?.mode || deliveryPlan?.deliveryMode || ''),
        provider: String(delivery?.provider || ''),
        simulated: Boolean(delivery?.simulated),
        used: false,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 10 * 60 * 1000).toISOString(),
      };
      state.smsCodes.push(sms);
      if (persistAuthSmsCode) {
        await persistAuthSmsCode({ sms });
      } else {
        await persist(state);
      }
      const payload = {
        ok: true,
        expiresInSeconds: 600,
        deliveryMode: sms.deliveryMode || (delivery?.simulated ? 'mock' : 'real'),
      };
      if (deliveryPlan.exposeDevCode) payload.devCode = code;
      res.json(payload);
    } catch (error) {
      sendError(res, normalizeSmsSendError(error), 400);
    }
  });

  router.post('/register', async (req, res) => {
    try {
      const mobile = normalizeMobile(req.body?.mobile);
      assertValidMobile(mobile);
      const sms = latestValidSmsCode(state, { mobile, code: req.body?.code });
      if (!sms) {
        const error = new Error(
          hasPendingSmsCode(state, mobile)
            ? '验证码不正确，请输入最新短信中的 6 位验证码'
            : '验证码不正确或已过期，请重新获取验证码',
        );
        error.code = 'INVALID_CODE';
        error.status = 400;
        throw error;
      }
      let user = state.users.find((row) => String(row.mobile || '') === mobile) || null;
      const guestId = normalizeGuestId(req.body?.guestId);
      const guestPolicies = guestPoliciesToMigrate(state, guestId);
      const pendingScans = guestPendingScans(state, guestId);
      const affectedPolicyIds = [];
      assertCanMigrateGuestPolicies({
        state,
        user,
        incomingPolicyCount: guestPolicies.length + pendingScans.length,
        assertUserCanSavePolicy,
        now: typeof nowIso === 'function' ? nowIso() : undefined,
      });
      const pendingAnalyses = [];
      for (const pending of pendingScans) {
        pendingAnalyses.push({
          pending,
          analysis: normalizeProvidedAnalysis(pending.analysis) || (await analyzer({ scan: pending.scan })),
        });
      }

      sms.used = true;

      if (!user) {
        const now = new Date().toISOString();
        user = {
          id: allocateId(state),
          mobile,
          createdAt: now,
          updatedAt: now,
        };
        state.users.push(user);
      }

      let migratedPolicyCount = 0;
      if (guestId) {
        for (const family of state.familyProfiles || []) {
          if (Number(family.ownerUserId || 0)) continue;
          if (normalizeGuestId(family.ownerGuestId) !== guestId) continue;
          family.ownerUserId = Number(user.id);
          family.ownerGuestId = '';
          family.updatedAt = new Date().toISOString();
        }
        for (const policy of guestPolicies) {
          policy.userId = Number(user.id);
          policy.guestId = '';
          policy.updatedAt = new Date().toISOString();
          affectedPolicyIds.push(policy.id);
          migratedPolicyCount += 1;
        }
      }
      for (const { pending, analysis } of pendingAnalyses) {
        const familyBinding = ensureDefaultPolicyFamilyBinding(
          state,
          { userId: user.id },
          pending.scan?.data || {},
        );
        const policy = buildPolicyFromScan({
          state,
          userId: user.id,
          guestId: '',
          scan: pending.scan,
          analysis,
          familyBinding,
        });
        state.policies.push(policy);
        recordPolicySourceRecords(state, policy, analysis);
        affectedPolicyIds.push(policy.id);
        migratedPolicyCount += 1;
      }
      clearGuestPendingScans(state, guestId);

      const token = createSession(state, user.id);
      const session = state.sessions.find((row) => String(row.token || '') === String(token)) || null;
      if (persistAuthRegistration) {
        await persistAuthRegistration({
          user,
          sms,
          session,
          guestId,
          policyIds: affectedPolicyIds,
        });
      } else {
        await persist(state);
      }
      const policies = state.policies.filter((policy) => Number(policy.userId) === Number(user.id));
      res.json({
        ok: true,
        token,
        user: publicUser(user),
        migratedPolicyCount,
        policies: attachPoliciesCoverageIndicators(
          policies.map((policy) => attachPolicyFamilyDisplay(policy, state)),
          state.insuranceIndicatorRecords,
          state.knowledgeRecords,
          state.optionalResponsibilityRecords,
        ),
      });
    } catch (error) {
      sendError(res, error, 400);
    }
  });

  router.post('/logout', async (req, res) => {
    try {
      const token = getBearerToken(req);
      if (token) {
        deleteSession(state, token);
        await persist(state);
      }
      res.json({ ok: true });
    } catch (error) {
      sendError(res, error, 500);
    }
  });

  return router;
}
