import express from 'express';
import { sendError } from '../http/errors.mjs';

function requireUser(req, state, resolveAuthUser) {
  const user = resolveAuthUser(req, state);
  if (user) return user;
  const error = new Error('缺少登录信息');
  error.code = 'UNAUTHORIZED';
  error.status = 401;
  throw error;
}

function findUserOrder(state, user, rawId) {
  return (state.membershipOrders || []).find(
    (row) => Number(row.id) === Number(rawId) && Number(row.userId) === Number(user.id),
  ) || null;
}

function orderSummary(order) {
  return {
    id: order.id,
    outTradeNo: order.outTradeNo,
    status: order.status,
    expiresAt: order.expiresAt,
  };
}

function routeError(code, status, message = code) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function isMockPayMode(wechatPayMode) {
  return String(wechatPayMode || '').trim() === 'mock';
}

function requireOrder(state, user, rawId) {
  const order = findUserOrder(state, user, rawId);
  if (order) return order;
  const error = new Error('ORDER_NOT_FOUND');
  error.code = 'ORDER_NOT_FOUND';
  error.status = 404;
  throw error;
}

export function createMembershipRoutes(context) {
  const router = express.Router();
  const {
    state,
    persist,
    resolveAuthUser,
    buildMembershipSnapshot,
    createMembershipOrder,
    markMembershipOrderPrepayCreated,
    processMembershipPaymentSuccess,
    createMockJsapiPayParams,
    nowIso,
    wechatPayMode = 'live',
  } = context;

  router.get('/me', async (req, res) => {
    try {
      const user = requireUser(req, state, resolveAuthUser);
      res.json({ ok: true, ...buildMembershipSnapshot(state, user, { now: nowIso() }) });
    } catch (error) {
      sendError(res, error, 401);
    }
  });

  router.post('/orders', async (req, res) => {
    try {
      const user = requireUser(req, state, resolveAuthUser);
      if (!isMockPayMode(wechatPayMode)) throw routeError('WECHAT_PAY_NOT_CONFIGURED', 503);
      const order = createMembershipOrder(state, { userId: user.id, now: nowIso() });
      const payParams = createMockJsapiPayParams(order);
      markMembershipOrderPrepayCreated(state, order.outTradeNo, {
        prepayId: payParams.package.replace('prepay_id=', ''),
        now: nowIso(),
        payload: { mode: 'mock' },
      });
      await persist(state);
      res.json({ ok: true, order: orderSummary(order), payParams });
    } catch (error) {
      sendError(res, error, 400);
    }
  });

  router.get('/orders/:id', async (req, res) => {
    try {
      const user = requireUser(req, state, resolveAuthUser);
      const order = requireOrder(state, user, req.params.id);
      res.json({ ok: true, order: orderSummary(order) });
    } catch (error) {
      sendError(res, error, 404);
    }
  });

  router.post('/orders/:id/mock-confirm', async (req, res) => {
    try {
      if (!isMockPayMode(wechatPayMode)) throw routeError('ORDER_NOT_FOUND', 404);
      const user = requireUser(req, state, resolveAuthUser);
      const order = requireOrder(state, user, req.params.id);
      processMembershipPaymentSuccess(state, {
        outTradeNo: order.outTradeNo,
        transactionId: `mock_${order.outTradeNo}`,
        amountCents: order.amountCents,
        paidAt: nowIso(),
        notifyPayload: { mode: 'mock' },
      });
      await persist(state);
      res.json({ ok: true, order: orderSummary(order), ...buildMembershipSnapshot(state, user, { now: nowIso() }) });
    } catch (error) {
      sendError(res, error, 400);
    }
  });

  return router;
}
