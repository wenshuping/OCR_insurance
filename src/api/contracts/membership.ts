import { request } from '../client';

export type MembershipStatus = {
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

export type MembershipOrder = {
  id: number;
  outTradeNo: string;
  status: 'created' | 'prepay_created' | 'paid' | 'closed' | 'failed';
  expiresAt: string;
};

export type WechatPayParams = {
  appId: string;
  timeStamp: string;
  nonceStr: string;
  package: string;
  signType: 'RSA';
  paySign: string;
};

export function getMembershipStatus(token: string) {
  return request<MembershipStatus>('/api/membership/me', { token });
}

export function createMembershipOrder(token: string) {
  return request<{ ok: true; order: MembershipOrder; payParams: WechatPayParams }>('/api/membership/orders', {
    token,
    body: {},
  });
}

export function getMembershipOrder(token: string, id: number) {
  return request<{ ok: true; order: MembershipOrder }>(`/api/membership/orders/${id}`, { token });
}

export function startMembershipWechatOAuth(token: string, redirectUrl: string) {
  return request<{ ok: true; authorizeUrl: string }>('/api/membership/wechat-oauth/start', {
    token,
    body: { redirectUrl },
  });
}

export function confirmMockMembershipOrder(token: string, id: number) {
  return request<MembershipStatus & { order: MembershipOrder }>(`/api/membership/orders/${id}/mock-confirm`, {
    token,
    body: {},
  });
}
