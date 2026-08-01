import { evaluateSalesTurnReadiness } from './sales-champion-readiness.service.mjs';
import { selectSalesChampionSkills } from './sales-champion-skill-registry.mjs';
import {
  getSalesChampionTrainingPackBoundaryCandidates,
  getSalesChampionTrainingPacks,
} from './sales-champion-training-catalog.mjs';
import { validateSalesTurnProposal } from './sales-champion-turn.contract.mjs';
import { buildSalesChampionProcessNavigation } from './sales-champion-process-navigator.service.mjs';

const CONTRACT_VERSION = 1;

export function evaluateSalesChampionRoute({
  proposal,
  sourceTexts = [],
  runtimeAvailable = true,
} = {}) {
  let validated;
  try {
    validated = validateSalesTurnProposal(proposal, { sourceTexts });
  } catch (error) {
    return {
      contractVersion: CONTRACT_VERSION,
      status: 'invalid_proposal',
      readiness: null,
      selection: null,
      error: String(error?.message || error),
    };
  }

  const readiness = evaluateSalesTurnReadiness(validated, { runtimeAvailable });
  if (['retry_later', 'stop_contact'].includes(readiness.decision)) {
    return {
      contractVersion: CONTRACT_VERSION,
      status: 'gated',
      readiness,
      selection: null,
      error: '',
    };
  }

  const selection = selectSalesChampionSkills(validated);
  const capabilityKeys = [selection.primary, ...selection.supporting].map((skill) => skill.key);
  const mappingContext = {
    stage: validated.stage.value,
    concerns: validated.concerns.map((concern) => concern.type),
    situations: validated.situations,
    missingInformation: validated.missingInformation,
    signals: validated.signals,
  };
  const boundaryCandidates = getSalesChampionTrainingPackBoundaryCandidates(
    capabilityKeys,
    mappingContext,
  );
  const navigation = buildSalesChampionProcessNavigation({
    proposal: validated,
    selection,
    boundaryCandidates,
  });
  if (readiness.decision !== 'execute') {
    return {
      contractVersion: CONTRACT_VERSION,
      status: 'gated',
      readiness,
      selection: null,
      navigation,
      trainingPacks: [],
      boundaryCandidates,
      error: '',
    };
  }
  return {
    contractVersion: CONTRACT_VERSION,
    status: 'routed',
    readiness,
    selection,
    navigation,
    trainingPacks: getSalesChampionTrainingPacks(capabilityKeys, mappingContext),
    boundaryCandidates,
    error: '',
  };
}
