import type { AdminAgentPolicySimulationResponse, AdminAgentQuestionPolicy } from '../../../api';

export function shouldDiscardDirty(dirty: boolean, confirmDiscard: (message: string) => boolean): boolean;
export function validatePolicyDraft(policies: AdminAgentQuestionPolicy[]): string[];
export function createRequestMutex(): { run<T>(request: () => Promise<T>): Promise<T | undefined> };
export type AgentPolicyLatestRequestScope = { commit(update: () => void): boolean };
export function createLatestRequestController(): {
  begin(): AgentPolicyLatestRequestScope;
  invalidate(): void;
  dispose(): void;
};
export type AgentPolicyLifecycleScope = {
  token: string;
  isCurrent(): boolean;
  commit(update: () => void): boolean;
  run(action: () => void): boolean;
  invalidate(): void;
};
export function createLifecycleController(): { activate(token: string): AgentPolicyLifecycleScope; capture(token: string): AgentPolicyLifecycleScope };
export function normalizePolicyIdentifier(value: unknown): string;
export function unknownQuestionViewModel(item: unknown): { id: number; userRef: string; category: string; fallbackDecision: string; occurrenceCount: number; status: string; createdAt: string };
export function simulationViewModel(response: AdminAgentPolicySimulationResponse): {
  previewOnly: boolean;
  intent: string;
  policySource: string;
  familyResolved: boolean;
  handler: string;
  tool: string | null;
  decision: string;
  confirmationRequired: boolean;
  outputMode: string;
  result: string;
  explanation: string;
  lowConfidence: boolean;
  writePreview: boolean;
};
export function policyValidationViewModel(input: { loading: boolean; loadError: string; loaded?: boolean; policies: AdminAgentQuestionPolicy[] }): { ready: boolean; errors: string[] };
export const fallbackPolicyKeys: readonly string[];
