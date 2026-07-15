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

  function inputFor({ family, owner }) {
    return buildInput(family, owner);
  }

  function currentInputVersion({ family, owner }) {
    return String(inputFor({ family, owner })?.expertInputVersion || '').trim();
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

  async function generateAndSave({ family, owner, input }) {
    const generated = await generateReport({ input });
    if (!completeReport({ ...generated, expertInputVersion: generated.expertInputVersion || input.expertInputVersion })) {
      throw new Error('FAMILY_POLICY_ANALYSIS_GENERATION_FAILED');
    }
    const version = String(input.expertInputVersion || '').trim();
    if (currentInputVersion({ family, owner }) !== version) return generated;
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
      if (previousReport === undefined) delete record.report.familyPolicyAnalysisReport;
      else record.report.familyPolicyAnalysisReport = previousReport;
      record.updatedAt = previousUpdatedAt;
      throw error;
    }
    return saved;
  }

  function ensureFresh({ family, owner, explicitRefresh = false }) {
    const input = inputFor({ family, owner });
    const version = String(input?.expertInputVersion || '').trim();
    const key = `${ownerKey(owner)}|family:${Number(family?.id || 0)}|version:${version}`;
    const existingWork = inFlight.get(key);
    if (existingWork) return existingWork;
    const report = currentReport({ family, owner });
    if (!explicitRefresh && completeReport(report) && report.expertInputVersion === version) {
      return Promise.resolve(report);
    }
    const work = generateAndSave({ family, owner, input });
    inFlight.set(key, work);
    work.finally(() => {
      if (inFlight.get(key) === work) inFlight.delete(key);
    }).catch(() => {});
    return work;
  }

  return { currentInputVersion, ensureFresh, getStatus };
}
