export function createAgentReportRegenerationQueue({ state, workflow, familyOwnerMatches, loadFreshState = async () => state } = {}) {
  if (!workflow) throw new TypeError('Family report regeneration workflow is required');
  return {
    async enqueueUnique({ familyId, type, userId, dedupeKey } = {}) {
      const snapshot = await loadFreshState();
      const family = (snapshot.familyProfiles || []).find((row) => Number(row.id) === Number(familyId));
      const owner = { userId: Number(userId) };
      if (!family || !familyOwnerMatches(family, owner)) throw new Error('Family regeneration target unavailable');
      const sourceUpdatedAt = [family, ...(snapshot.familyMembers || []), ...(snapshot.policies || [])]
        .filter((row) => row === family || Number(row?.familyId) === Number(familyId))
        .reduce((latest, row) => Math.max(latest, Date.parse(row?.updatedAt || row?.createdAt || 0) || 0), 0);
      const collection = type === 'family_report' ? snapshot.familyReports : snapshot.familySalesReviews;
      const latest = (collection || []).filter((row) => Number(row?.familyId) === Number(familyId) && String(row?.status || 'active') === 'active')
        .sort((a, b) => (Date.parse(b.generatedAt || b.updatedAt || 0) || 0) - (Date.parse(a.generatedAt || a.updatedAt || 0) || 0))[0];
      if (latest && (Date.parse(latest.generatedAt || latest.updatedAt || 0) || 0) >= sourceUpdatedAt) {
        return { jobId: String(dedupeKey), status: 'completed', progress: 100, reused: true };
      }
      if (type === 'family_report') await workflow.regenerateCoverage({ family, owner, system: true, stateSnapshot: snapshot });
      else if (type === 'family_sales_review') await workflow.regenerateSalesReview({ family, owner, system: true, stateSnapshot: snapshot });
      else throw new TypeError('Unsupported family regeneration job type');
      return { jobId: String(dedupeKey), status: 'completed', progress: 100 };
    },
  };
}
