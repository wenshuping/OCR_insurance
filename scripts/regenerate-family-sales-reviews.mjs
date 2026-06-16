import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createFamilySalesReviewRecord,
  loadRuntimeEnv,
  resolveOwnerFields,
  shouldSkipFamilySalesReviewInput,
} from './regenerate-family-sales-reviews.shared.mjs';
import { createSqliteStateStore } from '../server/sqlite-state-store.mjs';
import { createCashflowStore, createCashValueStore } from '../server/cashflow-store.mjs';
import { allocateId, normalizeGuestId } from '../server/policy-ocr.domain.mjs';
import { familyOwnerMatches, listFamilyMembers } from '../server/family-profile.domain.mjs';
import { familySharePolicyMatchesOwner } from '../server/services/family-workflow.service.mjs';
import { attachPolicyCoverageIndicators } from '../server/policy-ocr.domain.mjs';
import { mergePolicyDerivedResult } from '../server/policy-derived-results.service.mjs';
import { buildFamilyReport } from '../src/family-report-engine.mjs';
import { buildFamilySalesReviewInput, generateFamilySalesReview } from '../server/family-sales-review.service.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

function usage() {
  return [
    'Usage: node scripts/regenerate-family-sales-reviews.mjs [--dry-run] [--family-id=ID]',
    '',
    'Env:',
    '  POLICY_OCR_APP_DB_PATH  SQLite database path. Defaults to .runtime/local/policy-ocr.sqlite.',
    '',
    'Examples:',
    '  npm run family-sales-reviews:regenerate -- --dry-run',
    '  POLICY_OCR_APP_DB_PATH=/path/to/policy-ocr.sqlite npm run family-sales-reviews:regenerate',
  ].join('\n');
}

function parseArgs(argv) {
  const options = { dryRun: false, familyId: null };
  for (const arg of argv) {
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg.startsWith('--family-id=')) {
      const id = Number(arg.slice('--family-id='.length));
      if (!Number.isInteger(id) || id <= 0) throw new Error(`Invalid --family-id: ${arg}`);
      options.familyId = id;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function activeFamilies(state, familyId = null) {
  return (Array.isArray(state.familyProfiles) ? state.familyProfiles : [])
    .filter((family) => String(family?.status || 'active') === 'active')
    .filter((family) => !familyId || Number(family?.id || 0) === familyId)
    .sort((left, right) => Number(left.id || 0) - Number(right.id || 0));
}

function attachPolicyFamilyDisplay(policy, state) {
  const family = (state.familyProfiles || []).find((row) => Number(row.id) === Number(policy.familyId));
  const applicant = (state.familyMembers || []).find((row) => Number(row.id) === Number(policy.applicantMemberId));
  const insured = (state.familyMembers || []).find((row) => Number(row.id) === Number(policy.insuredMemberId));
  const useFamilyRelationLabels = String(policy.familyBindingSource || '').trim() === 'explicit';
  return {
    ...policy,
    familyName: family?.familyName || '',
    applicantMemberName: applicant?.name || policy.applicantMemberName || '',
    applicantRelation: useFamilyRelationLabels
      ? applicant?.relationLabel || policy.applicantRelationLabel || policy.applicantRelation || ''
      : policy.applicantRelation || policy.applicantRelationLabel || applicant?.relationLabel || '',
    applicantRelationLabel: useFamilyRelationLabels
      ? applicant?.relationLabel || policy.applicantRelationLabel || ''
      : policy.applicantRelationLabel || applicant?.relationLabel || '',
    insuredMemberName: insured?.name || policy.insuredMemberName || '',
    insuredRelation: useFamilyRelationLabels
      ? insured?.relationLabel || policy.insuredRelationLabel || policy.insuredRelation || ''
      : policy.insuredRelation || policy.insuredRelationLabel || insured?.relationLabel || '',
    insuredRelationLabel: useFamilyRelationLabels
      ? insured?.relationLabel || policy.insuredRelationLabel || ''
      : policy.insuredRelationLabel || insured?.relationLabel || '',
  };
}

function attachPolicyForFamilyReview(policy, state, { cashflowStore, cashValueStore }) {
  let displayed = attachPolicyFamilyDisplay(policy, state);
  const derivedResult = (Array.isArray(state.policyDerivedResults) ? state.policyDerivedResults : [])
    .find((row) => Number(row?.policyId || 0) === Number(policy?.id || 0)) || null;
  if (derivedResult) {
    displayed = mergePolicyDerivedResult(displayed, derivedResult);
  } else {
    displayed = attachPolicyCoverageIndicators(
      displayed,
      state.insuranceIndicatorRecords || [],
      state.knowledgeRecords || [],
      state.optionalResponsibilityRecords || [],
    );
  }
  const cashflowEntries = cashflowStore.getEntries(policy.id);
  const cashValues = cashValueStore.getValues(policy.id);
  return {
    ...displayed,
    ...(cashflowEntries.length ? { cashflowEntries } : {}),
    ...(cashValues.length ? { cashValues } : {}),
  };
}

function buildReviewInputForFamily(state, family, stores) {
  const owner = resolveOwnerFields(family, normalizeGuestId);
  const members = listFamilyMembers(state, family.id);
  const policies = (state.policies || [])
    .filter((policy) => (
      Number(policy?.familyId || 0) === Number(family.id) &&
      familySharePolicyMatchesOwner(policy, owner, { normalizeGuestId })
    ))
    .map((policy) => attachPolicyForFamilyReview(policy, state, stores));
  const familyReport = buildFamilyReport(policies, null, { familyId: family.id });
  const input = buildFamilySalesReviewInput({
    family,
    members,
    policies,
    familyReport,
    knowledgeRecords: state.knowledgeRecords || [],
    indicatorRecords: state.insuranceIndicatorRecords || [],
    optionalResponsibilityRecords: state.optionalResponsibilityRecords || [],
  });
  return { owner, members, policies, familyReport, input };
}

function archiveSalesReviewsForFamily(state, familyId) {
  state.familySalesReviews = Array.isArray(state.familySalesReviews) ? state.familySalesReviews : [];
  const now = new Date().toISOString();
  for (const review of state.familySalesReviews) {
    if (Number(review?.familyId || 0) !== Number(familyId)) continue;
    if (String(review?.status || 'active') !== 'active') continue;
    review.status = 'archived';
    review.updatedAt = now;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  await loadRuntimeEnv(projectRoot);
  const dbPath = process.env.POLICY_OCR_APP_DB_PATH || path.join(projectRoot, '.runtime/local/policy-ocr.sqlite');
  const store = await createSqliteStateStore({ dbPath });
  try {
    const state = await store.load();
    const families = activeFamilies(state, options.familyId);
    const stores = {
      cashflowStore: createCashflowStore(store.db),
      cashValueStore: createCashValueStore(store.db),
    };
    console.log(JSON.stringify({
      dryRun: options.dryRun,
      dbPath,
      familyCount: families.length,
      familyIds: families.map((family) => family.id),
    }, null, 2));

    let generatedCount = 0;
    for (const family of families) {
      if (!familyOwnerMatches(family, resolveOwnerFields(family, normalizeGuestId))) {
        console.log(`[skip] family=${family.id} owner mismatch`);
        continue;
      }
      const reviewInput = buildReviewInputForFamily(state, family, stores);
      const activeBefore = (state.familySalesReviews || [])
        .filter((review) => Number(review?.familyId || 0) === Number(family.id) && String(review?.status || 'active') === 'active')
        .length;
      console.log(`[family] id=${family.id} members=${reviewInput.members.length} policies=${reviewInput.policies.length} activeReviews=${activeBefore}`);
      if (shouldSkipFamilySalesReviewInput(reviewInput)) {
        console.log(`[skip] family=${family.id} empty family`);
        continue;
      }
      if (options.dryRun) continue;

      const review = await generateFamilySalesReview({ input: reviewInput.input });
      const reviewRecord = createFamilySalesReviewRecord({
        state,
        family,
        owner: reviewInput.owner,
        review,
        allocateId,
      });
      archiveSalesReviewsForFamily(state, family.id);
      state.familySalesReviews = Array.isArray(state.familySalesReviews) ? state.familySalesReviews : [];
      state.familySalesReviews.push(reviewRecord);
      generatedCount += 1;
      console.log(`[saved] family=${family.id} review=${reviewRecord.id} generatedAt=${reviewRecord.generatedAt}`);
    }

    if (!options.dryRun && generatedCount > 0) {
      await store.persistFamilyState({ state, includePolicies: false });
    }
    const activeAfter = (state.familySalesReviews || [])
      .filter((review) => String(review?.status || 'active') === 'active')
      .length;
    console.log(JSON.stringify({ ok: true, generatedCount, activeAfter }, null, 2));
  } finally {
    store.close();
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || error);
  process.exitCode = 1;
});
