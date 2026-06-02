import type { UploadItem } from './policy';
import { authQuery, request } from '../client';

export type CashflowEntry = {
  year: number;
  age: number;
  amount: number;
  cumulative: number;
  liability: string;
  policyId: number;
  productName: string;
  calculationText: string;
  /** Alias used by the server DB store (calc_text column) */
  calcText?: string | null;
  cashValue?: number | null;
};

export type CashValueRow = {
  policyYear: number;
  age: number | null;
  cashValue: number;
  source?: string;
};

export type CashValueScanResult = {
  ok: boolean;
  source?: 'ocr' | 'macos_vision' | 'vision_llm' | 'manual';
  tableType?: 2 | 3;
  rows: CashValueRow[];
  rowCount?: number;
  confidence?: number;
  error?: string;
  message?: string;
};

export type ScenarioEntry = {
  scenario: string;
  formula: string;
  amount: number;
  condition: string;
  policyId: number;
  productName: string;
  calculationText: string;
};

export type PolicyCashflowPlan = {
  policyId: number;
  productName: string;
  company: string;
  insured: string;
  insuredBirthday: string;
  effectiveDate: string;
  annualEntries: CashflowEntry[];
  scenarioEntries: ScenarioEntry[];
  totalDeterministicCashflow: number;
  expired: boolean;
};

export type MemberYearEntry = {
  year: number;
  age: number;
  totalAmount: number;
  cumulative: number;
  details: CashflowEntry[];
};

export type MemberAnnualSummary = {
  member: string;
  birthday: string;
  entries: MemberYearEntry[];
  totalCashflow: number;
};

export function scanCashValue(input: { token?: string; guestId?: string; policyId: number; uploadItem: UploadItem }) {
  return request<CashValueScanResult>(`/api/policies/${input.policyId}/cash-value/scan${authQuery(input)}`, {
    token: input.token,
    body: { uploadItem: input.uploadItem },
  });
}

export function confirmCashValue(input: { token?: string; guestId?: string; policyId: number; rows: CashValueRow[] }) {
  return request<{ ok: true; savedCount: number }>(`/api/policies/${input.policyId}/cash-value/confirm${authQuery(input)}`, {
    token: input.token,
    body: { rows: input.rows },
  });
}
