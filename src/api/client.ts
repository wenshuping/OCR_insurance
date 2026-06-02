import type { Policy } from './contracts/policy';

export type ApiOptions = {
  token?: string;
  body?: unknown;
  method?: string;
};

export class ApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

export async function request<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  const response = await fetch(path, {
    method: options.method || (options.body === undefined ? 'GET' : 'POST'),
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const payload = (await response.json().catch(() => null)) as { code?: string; message?: string } | null;
  if (!response.ok) {
    throw new ApiError(response.status, payload?.code || 'REQUEST_FAILED', payload?.message || '请求失败');
  }
  return payload as T;
}

export function authQuery(input: { guestId?: string } = {}) {
  return input.guestId ? `?guestId=${encodeURIComponent(input.guestId)}` : '';
}

export async function requestJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload && typeof payload === 'object' && 'message' in payload
      ? String((payload as { message?: unknown }).message || '')
      : `请求失败: ${response.status}`;
    throw new Error(message);
  }
  return payload as T;
}

export type User = {
  id: number;
  mobile: string;
  createdAt: string;
};

export type WechatJsSdkSignature = {
  ok: true;
  appId: string;
  nonceStr: string;
  timestamp: number;
  signature: string;
  jsApiList: string[];
};

export function sendCode(mobile: string) {
  return request<{ ok: true; devCode?: string; expiresInSeconds: number }>('/api/auth/send-code', {
    body: { mobile },
  });
}

export function register(input: { mobile: string; code: string; guestId: string }) {
  return request<{
    ok: true;
    token: string;
    user: User;
    migratedPolicyCount: number;
    policies: Policy[];
  }>('/api/auth/register', {
    body: input,
  });
}

export function logoutCustomer(token: string) {
  return request<{ ok: true }>('/api/auth/logout', {
    token,
    body: {},
  });
}

export function getWechatJsSdkSignature(url: string) {
  return request<WechatJsSdkSignature>(`/api/wechat/js-sdk-signature?url=${encodeURIComponent(url)}`);
}

export function logClientPerformance(input: Record<string, unknown>) {
  const body = JSON.stringify({
    ...input,
    page: window.location.pathname,
  });
  const blob = new Blob([body], { type: 'application/json' });
  if (navigator.sendBeacon && navigator.sendBeacon('/api/client-perf', blob)) {
    return;
  }
  void fetch('/api/client-perf', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    keepalive: true,
  }).catch(() => undefined);
}
