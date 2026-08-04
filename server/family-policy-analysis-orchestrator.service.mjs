function ownerKey(owner = {}) {
  const userId = Number(owner.userId || 0);
  if (userId) return `user:${userId}`;
  return `guest:${String(owner.guestId || '').trim()}`;
}

function completeReport(report = null) {
  return Boolean(
    report &&
    ['complete', 'completed', 'ready', 'success'].includes(String(report.status || '').trim().toLowerCase()) &&
    String(report.content || '').trim() &&
    String(report.expertInputVersion || '').trim(),
  );
}

export function createFamilyPolicyAnalysisOrchestrator({
  getReportRecord,
  buildInput,
  generateReport,
  persistReport,
} = {}) {
  if (![getReportRecord, buildInput, generateReport, persistReport].every((value) => typeof value === 'function')) {
    throw new Error('FAMILY_POLICY_ANALYSIS_ORCHESTRATOR_DEPS_REQUIRED');
  }
  const inFlight = new Map();

  function inputFor({ family, owner, ...requestContext }) {
    return buildInput(family, owner, requestContext);
  }

  function currentInputVersion({ family, owner, ...requestContext }) {
    return String(inputFor({ family, owner, ...requestContext })?.expertInputVersion || '').trim();
  }

  function currentReport({ family, owner }) {
    return getReportRecord(family, owner)?.report?.familyPolicyAnalysisReport || null;
  }

  function getStatus({ family, owner }) {
    const version = currentInputVersion({ family, owner });
    const key = `${ownerKey(owner)}|family:${Number(family?.id || 0)}|version:${version}`;
    if (inFlight.has(key)) return { status: 'pending', expertInputVersion: version, report: currentReport({ family, owner }) };
    const report = currentReport({ family, owner });
    if (['pending', 'queued', 'running', 'processing'].includes(String(report?.status || '').trim().toLowerCase())) {
      return { status: 'pending', expertInputVersion: version, report };
    }
    if (completeReport(report) && report.expertInputVersion === version) {
      return { status: 'fresh', expertInputVersion: version, report };
    }
    return { status: report ? 'stale' : 'missing', expertInputVersion: version, report };
  }

  async function generateAndSave({ family, owner, input, requestContext }) {
    const generated = await generateReport({ input });
    if (!completeReport({ ...generated, expertInputVersion: generated.expertInputVersion || input.expertInputVersion })) {
      throw new Error('FAMILY_POLICY_ANALYSIS_GENERATION_FAILED');
    }
    const version = String(input.expertInputVersion || '').trim();
    if (currentInputVersion({ family, owner, ...requestContext }) !== version) return null;
    const record = getReportRecord(family, owner);
    if (!record) throw new Error('FAMILY_REPORT_NOT_FOUND');
    record.report = record.report || {};
    const saved = {
      status: generated.status || 'complete',
      content: generated.content || '',
      structuredResult: generated.structuredResult ?? null,
      expertInputVersion: version,
      model: generated.model || '',
      generatedAt: generated.generatedAt || new Date().toISOString(),
    };
    const previousReport = record.report.familyPolicyAnalysisReport;
    const previousUpdatedAt = record.updatedAt;
    record.report.familyPolicyAnalysisReport = saved;
    record.updatedAt = saved.generatedAt;
    try {
      await persistReport({ record, family, owner });
    } catch (error) {
      if (record.report.familyPolicyAnalysisReport === saved && record.updatedAt === saved.generatedAt) {
        if (previousReport === undefined) delete record.report.familyPolicyAnalysisReport;
        else record.report.familyPolicyAnalysisReport = previousReport;
        record.updatedAt = previousUpdatedAt;
      }
      throw error;
    }
    return saved;
  }

  function ensureFresh(request) {
    return ensureFreshAttempt(request, 0, new Set());
  }

  function inputChangedError() {
    const error = new Error('FAMILY_POLICY_ANALYSIS_INPUT_CHANGED');
    error.code = 'FAMILY_POLICY_ANALYSIS_INPUT_CHANGED';
    error.status = 409;
    return error;
  }

  function ensureFreshAttempt({ family, owner, explicitRefresh = false, ...requestContext }, attempt, visitedKeys) {
    const input = inputFor({ family, owner, ...requestContext });
    const version = String(input?.expertInputVersion || '').trim();
    const key = `${ownerKey(owner)}|family:${Number(family?.id || 0)}|version:${version}`;
    if (visitedKeys.has(key)) return Promise.reject(inputChangedError());
    const existingWork = inFlight.get(key);
    if (existingWork) return existingWork;
    const report = currentReport({ family, owner });
    if (!explicitRefresh && completeReport(report) && report.expertInputVersion === version) {
      return Promise.resolve(report);
    }
    const work = generateAndSave({ family, owner, input, requestContext }).then((saved) => {
      if (saved) return saved;
      if (attempt >= 3) throw inputChangedError();
      const nextVisitedKeys = new Set(visitedKeys);
      nextVisitedKeys.add(key);
      return ensureFreshAttempt({ family, owner, ...requestContext }, attempt + 1, nextVisitedKeys);
    });
    inFlight.set(key, work);
    work.finally(() => {
      if (inFlight.get(key) === work) inFlight.delete(key);
    }).catch(() => {});
    return work;
  }

  return { currentInputVersion, ensureFresh, getStatus };
}
