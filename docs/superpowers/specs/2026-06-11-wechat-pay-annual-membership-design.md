# 微信支付年费会员 — 设计文档

> 日期: 2026-06-11
> 状态: 用户已确认设计
> 范围: 公众号内 JSAPI 支付、300 元一次性年费会员、注册用户免费保单额度、后台配置、订单与会员持久化

## 目标

为 OCR Insurance 增加一套可上线的年费会员购买和权益校验流程。第一期只支持用户在微信公众号内打开现有 H5 页面，通过微信支付 JSAPI 一次性支付 300 元，开通或续费 365 天会员。

会员权益用于解锁保单保存数量。游客仍可免费保存第一张保单；注册用户的免费保存保单数由后台配置；超过免费额度后，只有有效会员可以继续保存保单。

第一期优先保证真实收款链路可靠、权益判断在后端生效、状态可追溯、开发环境可 mock 验证。

## 已确认决策

- 支付场景: 公众号内 H5 页面，使用微信支付 JSAPI。
- 接入模式: 直连商户模式，不走服务商模式。
- 付费方式: 一次性年费，不做自动续费。
- 会员价格: 年费 300 元，服务端固定金额为 `30000` 分。
- 会员时长: 支付成功后开通或顺延 365 天。
- 会员权益: 解锁更多保单保存数量。
- 免费额度: 注册用户免费保存保单数由后台配置。
- 计数口径: 只按成功保存的保单数计数；OCR、分析预览、失败重试不扣额度。

## 范围外

- 自动续费、签约扣款、解约、扣款失败处理。
- 微信外 H5 支付、PC Native 扫码支付、小程序支付。
- 优惠券、促销价、价格版本、退款、发票。
- 会员等级、家庭套餐、多人共享会员。
- 对账和主动查单补偿任务的完整自动化。第一期保留订单查询接口作为人工和后续补偿基础。

## 项目上下文

当前项目是 React/Vite 前端、Node/Express API、SQLite 持久化的单页应用。现有 `server/app.mjs` 中已有游客免费保存一张保单、第二张要求手机号验证的逻辑，核心函数包括 `assertGuestCanScan` 和 `guestRegistrationRequiredNext`。

会员设计复用这条保存入口，不在前端单独判断权益。前端负责展示额度和会员状态；后端在保存保单前做最终放行或拒绝。

项目已有微信公众号 H5 配置基础，`README.md` 记录了 `WECHAT_H5_APP_ID` 和 `WECHAT_H5_APP_SECRET`。JSAPI 支付还需要公众号 `openid`，因此第一期需要增加一个轻量的微信网页授权绑定流程，用于把当前手机号登录用户和公众号 `openid` 关联起来。

## 推荐方案

采用“订单制会员”方案。

后端先创建本地会员订单，再调用微信支付 JSAPI 下单。微信支付异步通知到达后，后端验签、解密、校验金额和订单归属，幂等地把订单置为已支付，并开通或延长会员。前端支付成功回调只触发刷新，不直接开通会员。

没有采用“只存会员有效期”的轻量方案，因为真实收款需要能追踪订单、排查回调、处理重复通知和后续人工补单。没有采用手工收款二维码方案，因为用户体验断裂，且无法自动闭合权益校验。

## 架构

### 后端模块

新增或扩展以下模块:

- `server/membership.domain.mjs`
  - 计算会员是否有效。
  - 计算注册用户免费额度是否用尽。
  - 支付成功后开通或顺延会员。
  - 对重复支付通知保持幂等。

- `server/wechat-pay.service.mjs`
  - 读取微信支付配置。
  - 构造 API v3 请求签名。
  - 调用 `/v3/pay/transactions/jsapi` 创建预支付订单。
  - 生成前端 `WeixinJSBridge` 调起支付参数。
  - 验证微信支付通知签名并解密 `resource`。
  - 不处理会员权益，只处理支付协议。

- `server/wechat-oauth.service.mjs`
  - 生成公众号网页授权 URL。
  - 使用授权 `code` 换取公众号 `openid`。
  - 使用一次性 OAuth state 将 `openid` 绑定到发起授权的登录用户。

- `server/routes/membership.routes.mjs`
  - 用户会员状态。
  - 创建会员订单。
  - 查询会员订单。
  - 微信支付通知。
  - 微信网页授权回调。

- `server/routes/admin.routes.mjs`
  - 增加会员配置读取和更新接口。

- `server/sqlite-state-store.mjs`
  - 增加会员配置、订单、会员、用户微信身份的 SQLite 持久化。

### 前端模块

新增或扩展以下区域:

- `src/api/contracts/membership.ts`
  - 会员状态、下单、查询订单、后台配置类型。

- `src/features/customer-membership/`
  - 会员状态展示。
  - 年费会员购买弹窗。
  - 微信内支付调起和支付后刷新。

- `src/features/customer-auth/CustomerAccountSheet.tsx`
  - 展示会员到期时间或免费额度。

- `src/apps/customer/CustomerApp.tsx`
  - 启动和登录成功后加载会员状态。
  - 保存保单遇到 `MEMBERSHIP_REQUIRED` 时打开会员购买弹窗。

- `src/apps/admin/AdminApp.tsx`
  - 增加会员设置面板。

## 数据模型

### MembershipConfig

会员配置持久化在 SQLite 中，既可以使用独立表，也可以使用 `state_documents` 风格的配置文档。实现时优先选择和现有 store 最贴近的方式。

```ts
type MembershipConfig = {
  enabled: boolean;
  annualPriceCents: 30000;
  annualDurationDays: 365;
  registeredFreePolicyQuota: number;
  updatedAt: string;
};
```

规则:

- `registeredFreePolicyQuota` 后台可编辑，默认建议为 `3`。
- `enabled` 后台可编辑，用于暂时关闭购买入口。
- `annualPriceCents` 和 `annualDurationDays` 第一期固定为服务端常量，不在后台随意编辑，避免真实支付金额和前端文案不一致。

### MembershipOrder

订单记录支付生命周期和排障信息。

```ts
type MembershipOrder = {
  id: number;
  outTradeNo: string;
  userId: number;
  productCode: 'annual_membership';
  amountCents: 30000;
  currency: 'CNY';
  status: 'created' | 'prepay_created' | 'paid' | 'closed' | 'failed';
  prepayId?: string;
  transactionId?: string;
  paidAt?: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  payload: Record<string, unknown>;
};
```

`outTradeNo` 必须在同一商户号下唯一，建议格式为 `mem_<userId>_<timestamp>_<random>`，并限制在微信支付商户订单号允许的字符和长度范围内。

### Membership

会员记录当前权益状态。

```ts
type Membership = {
  userId: number;
  plan: 'annual';
  status: 'active' | 'expired';
  startedAt: string;
  expiresAt: string;
  lastOrderId: number;
  updatedAt: string;
};
```

续费规则:

- 用户没有会员或会员已过期时，从支付成功时间开始加 365 天。
- 用户仍是有效会员时，从当前 `expiresAt` 继续顺延 365 天。
- 同一个订单重复通知只更新订单通知摘要，不重复延长会员。

### UserWechatIdentity

JSAPI 支付需要公众号下的 `openid`。手机号账号仍是主账号，微信身份只作为支付所需身份。

```ts
type UserWechatIdentity = {
  userId: number;
  appId: string;
  openid: string;
  scope: 'snsapi_base';
  createdAt: string;
  updatedAt: string;
};
```

同一 `userId + appId` 只保留一个当前绑定的 `openid`。

### WechatOAuthState

因为当前用户登录态主要保存在前端 bearer token 中，微信 OAuth 回调请求不会自动携带该 token。为避免把 token 放进 URL，后端需要在发起授权前创建一次性 state。

```ts
type WechatOAuthState = {
  state: string;
  userId: number;
  appId: string;
  redirectUrl: string;
  usedAt?: string;
  expiresAt: string;
  createdAt: string;
};
```

规则:

- 创建 state 的接口必须要求用户已登录。
- state 随机生成，短期有效，建议 10 分钟。
- 回调只根据未使用且未过期的 state 绑定 `openid`。
- 回调成功后立即标记 state 已使用。

## 权益规则

保存保单前统一调用会员权益判断。

游客规则:

- 无登录用户且有 `guestId` 时，可保存 1 张免费保单。
- 游客已保存保单数达到 1 张时，继续沿用现有 `REGISTRATION_REQUIRED`，要求手机号验证。

注册用户规则:

- 若存在有效会员，允许保存。
- 若非会员，读取 `registeredFreePolicyQuota`。
- 统计当前用户已成功保存的保单数。
- 当 `savedPolicyCount < registeredFreePolicyQuota` 时允许保存。
- 当 `savedPolicyCount >= registeredFreePolicyQuota` 时拒绝保存，返回 `MEMBERSHIP_REQUIRED`。

保存数量统计只基于已经持久化的 `policies`，不统计 `pendingScans`，不统计 OCR 或分析请求。

## API 设计

### 用户接口

`GET /api/membership/me`

返回当前登录用户的会员和额度状态。未登录返回 401。

```ts
type MembershipMeResponse = {
  ok: true;
  membership: {
    active: boolean;
    plan: 'annual' | null;
    expiresAt: string | null;
  };
  quota: {
    savedPolicyCount: number;
    freeQuota: number;
    requiresMembership: boolean;
  };
  purchase: {
    enabled: boolean;
    annualPriceCents: 30000;
    annualDurationDays: 365;
    wechatOpenidBound: boolean;
  };
};
```

`POST /api/membership/orders`

创建年费会员订单。后端不接受前端传入金额。

前置条件:

- 用户已登录。
- 会员购买已启用。
- live 模式下当前请求来自微信内置浏览器。
- 用户已有绑定的公众号 `openid`。
- 微信支付 live 模式下配置完整。

如果缺少 `openid`，返回 `WECHAT_OPENID_REQUIRED`，并带上静默授权 URL。

成功时返回:

```ts
type CreateMembershipOrderResponse = {
  ok: true;
  order: {
    id: number;
    outTradeNo: string;
    status: 'prepay_created';
    expiresAt: string;
  };
  payParams: {
    appId: string;
    timeStamp: string;
    nonceStr: string;
    package: string;
    signType: 'RSA';
    paySign: string;
  };
};
```

`GET /api/membership/orders/:id`

查询当前用户自己的会员订单状态。用于支付后刷新和支付确认中的兜底展示。

`POST /api/membership/wechat-oauth/start`

登录用户创建一次性 OAuth state，并返回公众号网页授权地址。第一期使用 `snsapi_base` 静默授权获取 `openid`。请求体只接收前端回跳路径，后端必须校验回跳地址属于本站路径。

`GET /api/membership/wechat-oauth/callback`

处理微信网页授权回调，使用 `state` 找到发起授权的用户，绑定 `openid` 后跳回 state 中保存的回跳地址。如果 state 不存在、已过期或已使用，返回错误页或跳回前端提示重新登录。

`POST /api/membership/wechatpay/notify`

微信支付通知地址。不做用户登录校验。必须完成验签、解密、金额校验和幂等处理。

### 保存接口扩展

`POST /api/policies/scan`

保存前检查权益。额度不足时返回:

```json
{
  "ok": false,
  "code": "MEMBERSHIP_REQUIRED",
  "message": "免费保单额度已用完，请开通会员继续录入",
  "membership": {
    "savedPolicyCount": 3,
    "freeQuota": 3,
    "annualPriceCents": 30000
  }
}
```

HTTP 状态建议使用 402。前端根据 `code` 打开会员购买弹窗。

### 后台接口

`GET /api/admin/membership-config`

返回当前会员配置和基础统计。

`PATCH /api/admin/membership-config`

允许更新:

- `enabled`
- `registeredFreePolicyQuota`

不允许更新:

- `annualPriceCents`
- `annualDurationDays`

## 微信支付接入

第一期使用普通商户 JSAPI 下单接口:

- 请求方式: `POST /v3/pay/transactions/jsapi`
- 请求域名: `https://api.mch.weixin.qq.com`
- 支付调起方式: 公众号内 `WeixinJSBridge.invoke('getBrandWCPayRequest', ...)`

下单 body 由服务端生成:

- `appid`: 公众号 AppID。
- `mchid`: 直连商户号。
- `description`: `OCR Insurance 年费会员`。
- `out_trade_no`: 本地订单商户订单号。
- `time_expire`: 当前时间加 30 分钟。
- `notify_url`: 外网 HTTPS 通知地址，不带 query。
- `amount.total`: `30000`。
- `amount.currency`: `CNY`。
- `payer.openid`: 当前登录用户绑定的公众号 `openid`。

服务端需要生成两类签名:

- 调用微信支付 API v3 的 HTTP 请求签名。
- 前端调起 JSAPI 支付的 `paySign`，签名内容使用 `appId`、秒级 `timeStamp`、`nonceStr`、`package`。

通知处理顺序:

1. 读取原始请求体和 `Wechatpay-*` 请求头。
2. 使用微信支付平台公钥或平台证书验签。
3. 使用 API v3 密钥解密 `resource`。
4. 校验 `trade_state === 'SUCCESS'`。
5. 校验 `out_trade_no` 对应本地订单。
6. 校验 `amount.total === order.amountCents`。
7. 校验 `mchid` 和 `appid` 与配置一致。
8. 幂等更新订单为 `paid`。
9. 开通或顺延会员。
10. 返回微信支付成功应答。

## 环境配置

复用:

- `WECHAT_H5_APP_ID`
- `WECHAT_H5_APP_SECRET`

新增:

- `WECHAT_PAY_MODE=mock | live`
- `WECHAT_PAY_MCH_ID`
- `WECHAT_PAY_API_V3_KEY`
- `WECHAT_PAY_SERIAL_NO`
- `WECHAT_PAY_PRIVATE_KEY`
- `WECHAT_PAY_PRIVATE_KEY_PATH`
- `WECHAT_PAY_PLATFORM_PUBLIC_KEY`
- `WECHAT_PAY_PLATFORM_PUBLIC_KEY_PATH`
- `WECHAT_PAY_PLATFORM_PUBLIC_KEY_ID`
- `WECHAT_PAY_NOTIFY_URL`

私钥和 API v3 密钥只允许服务端读取，不返回给前端，不提交到仓库。

微信商户平台需要配置:

- 公众号 AppID 与商户号绑定。
- JSAPI 支付授权目录。
- 公众号网页授权域名。
- API v3 密钥。
- 微信支付公钥或平台证书。
- 可公网访问的 `notify_url`。

## 前端体验

账号页展示:

- 有效会员: `会员有效至 YYYY-MM-DD`。
- 非会员且额度未用完: `已保存 X/N 张免费保单`。
- 非会员且额度用完: `免费额度已用完，开通年费会员继续录入`。

购买弹窗展示:

- 年费会员 300 元。
- 有效期 365 天。
- 当前已保存保单数和免费额度。
- 主按钮: `微信支付 300 元`。

支付流程:

1. 点击购买。
2. 调 `POST /api/membership/orders`。
3. 若返回 `WECHAT_OPENID_REQUIRED`，跳转静默授权 URL，回到页面后重新下单。
4. 若返回支付参数，调用 `WeixinJSBridge.invoke`。
5. 用户完成、取消或失败后，前端都不直接改会员状态。
6. 前端刷新订单和 `/api/membership/me`。
7. 若回调暂未到达，展示 `支付确认中`，允许手动刷新。

非微信内打开:

- 第一版不走 H5 MWEB 支付。
- 创建订单前提示 `请在微信内打开公众号页面完成支付`。

保存保单遇到 `MEMBERSHIP_REQUIRED`:

- 打开会员购买弹窗。
- 支付确认后用户重新点击保存。
- 不自动保存用户上一次草稿，避免支付确认和保单保存耦合过重；现有表单状态保留即可。

## 后台体验

管理后台新增“会员设置”面板:

- 开关: 是否开放会员购买。
- 输入: 注册用户免费保存保单数。
- 只读: 年费价格 300 元。
- 只读: 会员时长 365 天。

保存后立即影响后端权益判断。后台文案需要说明免费额度按“已成功保存保单数”计算。

## 错误处理

- `WECHAT_PAY_NOT_CONFIGURED`: live 模式缺少必要配置，前端提示会员支付暂未开放。
- `WECHAT_OPENID_REQUIRED`: 当前用户未绑定公众号 `openid`，前端跳转静默授权。
- `WECHAT_BROWSER_REQUIRED`: 当前不在微信内，前端提示在微信中打开。
- `MEMBERSHIP_PURCHASE_DISABLED`: 后台关闭购买。
- `MEMBERSHIP_REQUIRED`: 免费额度已用完且不是有效会员。
- `ORDER_NOT_FOUND`: 查询的订单不存在或不属于当前用户。
- `ORDER_EXPIRED`: 本地订单超过支付有效期。
- `WECHAT_NOTIFY_INVALID_SIGNATURE`: 微信支付通知验签失败。
- `WECHAT_NOTIFY_AMOUNT_MISMATCH`: 通知金额和本地订单不一致。

用户取消支付时，订单保持 `prepay_created` 到自然过期，不开通会员。支付成功但通知未及时到达时，前端展示确认中；后续可通过订单查询接口人工确认。

## 开发环境

开发环境默认使用 `WECHAT_PAY_MODE=mock`。

mock 模式规则:

- 创建订单不请求微信支付。
- 返回形状与真实 `payParams` 一致的模拟参数。
- 提供仅开发环境可用的 mock 支付确认入口或测试 helper，把订单标记为已支付并开通会员。
- mock 支付确认必须要求登录用户和订单归属匹配。

生产环境必须使用 `WECHAT_PAY_MODE=live` 且配置齐全，否则不开放购买。

## 测试

后端领域测试:

- 免费额度未满时，注册用户允许保存。
- 免费额度已满且非会员时，注册用户被拒绝。
- 有效会员即使超过免费额度也允许保存。
- 会员过期后重新按免费额度判断。
- 新会员从支付成功时间开通 365 天。
- 有效会员续费从当前 `expiresAt` 顺延 365 天。
- 重复处理同一已支付订单不会重复加天数。

路由测试:

- `POST /api/policies/scan` 在额度用尽时返回 `MEMBERSHIP_REQUIRED`。
- `GET /api/membership/me` 返回会员状态和额度。
- `POST /api/membership/orders` 未登录拒绝。
- mock 模式下创建订单成功。
- mock 支付成功后 `/api/membership/me` 返回 active。
- 后台会员配置更新后影响权益判断。

SQLite 测试:

- 会员配置、订单、会员记录、微信身份可持久化并重新加载。
- OAuth state 可持久化、过期、一次性使用。
- 已支付订单重复加载后不会再次延长会员。

前端验证:

- API contract 类型通过。
- 会员弹窗能处理 `MEMBERSHIP_REQUIRED`。
- 微信支付取消、失败、确认中状态不会破坏原有 OCR 上传和保单表单状态。

实现后按跨 `src/` 和 `server/` 变更执行:

```bash
npm run check
npm run typecheck
npm test
npm run build
```

## 实施顺序建议

1. 增加会员 domain 和 SQLite 持久化，先用 mock 支付打通订单与会员。
2. 把保单保存接口接入会员权益判断。
3. 增加用户侧会员状态和购买弹窗。
4. 增加后台会员配置。
5. 增加公众号 `openid` 绑定。
6. 接入真实微信支付 JSAPI 下单和通知验签解密。

## 参考依据

- 微信支付商户文档中心: JSAPI/小程序下单，`POST /v3/pay/transactions/jsapi`。
- 微信支付商户文档中心: JSAPI 支付需要在微信客户端内通过 `WeixinJSBridge` 调起，并需要公众号下的用户 `openid`。
- 微信支付商户文档中心: API v3 使用商户私钥签名、微信支付公钥或平台证书验签，通知 `resource` 使用 API v3 密钥 AES-256-GCM 解密。
- 本项目 `README.md`、`docs/architecture.md`、`docs/harness.md` 中的本地开发、安全和模块边界约束。
