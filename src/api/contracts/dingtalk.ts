import { request } from '../client';

export type DingtalkPrincipal = {
  corpId: string;
  dingUserId: string;
};

export type DingtalkChallenge = {
  token: string;
  expiresAt: string;
};

export type DingtalkCandidateResponse =
  | { ok: true; status: 'binding_required' }
  | {
      ok: true;
      status: 'confirmation_required';
      maskedMobile: string;
      challenge: DingtalkChallenge;
    };

export type DingtalkBoundResponse = {
  ok: true;
  status: 'bound';
  maskedMobile?: string;
  taskRef?: string;
};

export function getDingtalkIdentityCandidate(input: DingtalkPrincipal & {
  requestId: string;
  serviceToken?: string;
}) {
  const { serviceToken, ...body } = input;
  return request<DingtalkCandidateResponse>('/api/dingtalk/identity/candidate', {
    token: serviceToken,
    body,
  });
}

export function confirmDingtalkIdentity(input: DingtalkPrincipal & {
  requestId: string;
  challengeToken: string;
  serviceToken?: string;
}) {
  const { serviceToken, challengeToken, ...principal } = input;
  return request<DingtalkBoundResponse>('/api/dingtalk/identity/confirm', {
    token: serviceToken,
    body: { ...principal, token: challengeToken },
  });
}

export function bindDingtalkIdentityFromWeb(input: DingtalkPrincipal & {
  token: string;
  challengeToken: string;
  taskRef?: string;
}) {
  const { token, challengeToken, ...body } = input;
  return request<DingtalkBoundResponse>('/api/dingtalk/identity/web-bind', {
    token,
    body: { ...body, token: challengeToken },
  });
}

export function revokeDingtalkIdentity(input: DingtalkPrincipal & { token: string }) {
  const { token, ...body } = input;
  return request<{ ok: true; status: 'revoked' }>('/api/dingtalk/identity/binding', {
    token,
    method: 'DELETE',
    body,
  });
}
