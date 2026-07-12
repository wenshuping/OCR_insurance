import type { AdminAgentPolicySimulationResponse, AdminAgentQuestionPolicy } from '../../../api';

export function shouldDiscardDirty(dirty: boolean, confirmDiscard: (message: string) => boolean): boolean;
export function validatePolicyDraft(policies: AdminAgentQuestionPolicy[]): string[];
export function createRequestMutex(): { run<T>(request: () => Promise<T>): Promise<T | undefined> };
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
