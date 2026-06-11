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

function trim(value) {
  return String(value || '').trim();
}

function isMockPayMode(config) {
  return (
    trim(config?.mode) === 'mock' &&
    (trim(config?.nodeEnv) !== 'production' || config?.allowMockInProduction === true)
  );
}

function mockPayDisabled(config) {
  return trim(config?.mode) === 'mock' && !isMockPayMode(config);
}

function requireWechatBrowser(req) {
  if (/MicroMessenger/i.test(trim(req.get('user-agent')))) return;
  throw routeError('WECHAT_BROWSER_REQUIRED', 400);
}

function requirePurchaseEnabled(state, getMembershipConfig) {
  const config = getMembershipConfig ? getMembershipConfig(state) : { enabled: true };
  if (config.enabled !== false) return;
  throw routeError('MEMBERSHIP_PURCHASE_DISABLED', 403);
}

function removeOrder(state, order) {
  state.membershipOrders = (state.membershipOrders || []).filter((row) => row !== order);
}

function requestOrigin(req) {
  const forwardedProto = trim(req.get('x-forwarded-proto')).split(',')[0].trim();
  const forwardedHost = trim(req.get('x-forwarded-host')).split(',')[0].trim();
  const proto = forwardedProto || req.protocol || 'http';
  const host = forwardedHost || trim(req.get('host'));
  if (!host) throw routeError('WECHAT_OAUTH_HOST_REQUIRED', 400);
  return `${proto}://${host}`;
}

function buildWechatOAuthAuthorizeUrl(req, appId, stateToken) {
  const callbackUrl = new URL('/api/membership/wechat-oauth/callback', requestOrigin(req)).toString();
  const url = new URL('https://open.weixin.qq.com/connect/oauth2/authorize');
  url.searchParams.set('appid', appId);
  url.searchParams.set('redirect_uri', callbackUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'snsapi_base');
  url.searchParams.set('state', stateToken);
  return `${url.toString()}#wechat_redirect`;
}

function rawBodyFromRequest(req) {
  return typeof req.rawBody === 'string' ? req.rawBody : JSON.stringify(req.body || {});
}

function normalizedPaidAt(value, fallback) {
  const time = new Date(value || '').getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : fallback;
}

function validateWechatNotifyTransaction(transaction, config) {
  if (trim(transaction?.trade_state) !== 'SUCCESS') {
    throw routeError('WECHAT_NOTIFY_TRADE_STATE_UNSUPPORTED', 400);
  }
  if (trim(transaction?.appid) !== trim(config.appId) || trim(transaction?.mchid) !== trim(config.mchId)) {
    throw routeError('WECHAT_NOTIFY_MERCHANT_MISMATCH', 400);
  }
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
    getMembershipConfig,
    createMembershipOrder,
    markMembershipOrderPrepayCreated,
    processMembershipPaymentSuccess,
    createMockJsapiPayParams,
    nowIso,
    wechatPayMode = 'live',
    createWechatPayJsapiPrepay,
    createWechatOAuthState,
    consumeWechatOAuthState,
    upsertUserWechatIdentity,
    findUserWechatOpenid,
    resolveWechatPayConfig = () => ({ mode: wechatPayMode, ready: wechatPayMode === 'mock', appId: '' }),
    decryptWechatPayResource,
    verifyWechatPaySignature,
    fetchWechatOAuthOpenid,
  } = context;

  router.get('/me', async (req, res) => {
    try {
      const user = requireUser(req, state, resolveAuthUser);
      const config = resolveWechatPayConfig();
      res.json({ ok: true, ...buildMembershipSnapshot(state, user, { now: nowIso(), appId: config.appId }) });
    } catch (error) {
      sendError(res, error, 401);
    }
  });

  router.post('/orders', async (req, res) => {
    try {
      const user = requireUser(req, state, resolveAuthUser);
      const config = resolveWechatPayConfig();
      if (!config.ready || mockPayDisabled(config)) throw routeError('WECHAT_PAY_NOT_CONFIGURED', 503);
      requirePurchaseEnabled(state, getMembershipConfig);
      if (!isMockPayMode(config)) {
        const openid = findUserWechatOpenid(state, { userId: user.id, appId: config.appId });
        if (!openid) throw routeError('WECHAT_OPENID_REQUIRED', 400);
        requireWechatBrowser(req);
        const order = createMembershipOrder(state, { userId: user.id, now: nowIso() });
        let prepay;
        try {
          prepay = await createWechatPayJsapiPrepay({ config, order, openid });
        } catch (error) {
          removeOrder(state, order);
          throw error;
        }
        markMembershipOrderPrepayCreated(state, order.outTradeNo, {
          prepayId: prepay.prepayId,
          now: nowIso(),
          payload: { mode: 'live' },
        });
        await persist(state);
        res.json({ ok: true, order: orderSummary(order), payParams: prepay.payParams });
        return;
      }
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
      if (!isMockPayMode(resolveWechatPayConfig())) throw routeError('ORDER_NOT_FOUND', 404);
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

  router.post('/wechat-oauth/start', async (req, res) => {
    try {
      const user = requireUser(req, state, resolveAuthUser);
      const config = resolveWechatPayConfig();
      const appId = trim(config.appId);
      if (!appId) throw routeError('WECHAT_OAUTH_NOT_CONFIGURED', 503);
      const oauth = createWechatOAuthState(state, {
        userId: user.id,
        appId,
        redirectUrl: req.body?.redirectUrl || '/',
        now: nowIso(),
      });
      await persist(state);
      res.json({ ok: true, authorizeUrl: buildWechatOAuthAuthorizeUrl(req, appId, oauth.state) });
    } catch (error) {
      sendError(res, error, 400);
    }
  });

  router.get('/wechat-oauth/callback', async (req, res) => {
    try {
      const code = trim(req.query?.code);
      if (!code) throw routeError('WECHAT_OAUTH_CODE_REQUIRED', 400);
      const oauth = consumeWechatOAuthState(state, req.query?.state, { now: nowIso() });
      const identitiesBefore = (state.userWechatIdentities || []).map((identity) => ({ ...identity }));
      try {
        const openid = await fetchWechatOAuthOpenid(code);
        upsertUserWechatIdentity(state, {
          userId: oauth.userId,
          appId: oauth.appId,
          openid,
          now: nowIso(),
        });
        await persist(state);
        res.redirect(oauth.redirectUrl || '/');
      } catch (error) {
        oauth.usedAt = '';
        state.userWechatIdentities = identitiesBefore;
        throw error;
      }
    } catch (error) {
      sendError(res, error, 400);
    }
  });

  router.post('/wechatpay/notify', async (req, res) => {
    try {
      const config = resolveWechatPayConfig();
      if (config.mode !== 'live' || !config.ready) throw routeError('WECHAT_PAY_NOT_CONFIGURED', 503);
      const rawBody = rawBodyFromRequest(req);
      if (trim(req.get('wechatpay-serial')) !== trim(config.platformPublicKeyId)) {
        throw routeError('WECHAT_NOTIFY_SERIAL_MISMATCH', 401);
      }
      const verified = verifyWechatPaySignature({
        timestamp: req.get('wechatpay-timestamp'),
        nonce: req.get('wechatpay-nonce'),
        body: rawBody,
        signature: req.get('wechatpay-signature'),
        publicKey: config.platformPublicKey,
        maxAgeSeconds: 300,
      });
      if (!verified) throw routeError('WECHAT_NOTIFY_SIGNATURE_INVALID', 401);
      const resource = req.body?.resource || {};
      const transaction = decryptWechatPayResource({
        apiV3Key: config.apiV3Key,
        nonce: resource.nonce,
        associatedData: resource.associated_data,
        ciphertext: resource.ciphertext,
      });
      validateWechatNotifyTransaction(transaction, config);
      processMembershipPaymentSuccess(state, {
        outTradeNo: transaction.out_trade_no,
        transactionId: transaction.transaction_id,
        amountCents: transaction.amount?.total,
        paidAt: normalizedPaidAt(transaction.success_time, nowIso()),
        notifyPayload: transaction,
      });
      await persist(state);
      res.json({ code: 'SUCCESS', message: '成功' });
    } catch (error) {
      sendError(res, error, 400);
    }
  });

  return router;
}
