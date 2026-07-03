import express from 'express';
import { sendError } from '../http/errors.mjs';

function trim(value) {
  return String(value || '').trim();
}

function positiveIntegerOrFallback(value, fallback, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(Math.round(number), max);
}

function scoreThresholdOrFallback(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(1, number));
}

function nowMs() {
  return Date.now();
}

function elapsedMs(startedAt) {
  return Math.max(0, nowMs() - startedAt);
}

export function createResponsibilityRoutes(context) {
  const router = express.Router();
  const {
    state,
    performanceLogger,
    logPerformance,
    assistantAnalyzer,
    normalizeResponsibilityQueryInput,
    normalizePolicyScanData,
    normalizePolicyPlans,
    normalizeOptionalResponsibilities,
    buildRecognizedPolicyAnalysisDraft,
    buildEffectiveOfficialDomainProfiles,
    buildKnowledgeSearchArtifacts,
    buildResponsibilitySummaryReportFromCards,
    buildResponsibilityCardsForPolicy,
    isGeneratedResponsibilityCountReport,
    mergeCoverageTableWithCheckedRows,
    responsibilityRowsFromCards,
    findPolicyCoverageIndicators,
    buildResponsibilityCompanySuggestions,
    buildResponsibilityProductSuggestions,
    findKnowledgeProductCandidates,
    db,
    findProductCustomerResponsibilitySummary,
    persistProductCustomerResponsibilitySummary,
    persistProductCustomerSummaryGenerationRun,
    generateProductCustomerResponsibilitySummary,
    generateProductCustomerResponsibilitySummaryWithDeepSeek,
    generateProductCustomerResponsibilityPlannerWithDeepSeek,
  } = context;

  function responsibilityReportFor({ current = '', rows = [], cards = [], optionalResponsibilities = [] } = {}) {
    const existing = String(current || '').trim();
    if (existing && !(typeof isGeneratedResponsibilityCountReport === 'function' && isGeneratedResponsibilityCountReport(existing))) {
      return existing;
    }
    const cardReport = typeof buildResponsibilitySummaryReportFromCards === 'function'
      ? buildResponsibilitySummaryReportFromCards(cards, { optionalResponsibilities })
      : '';
    if (cardReport) return cardReport;
    return rows.length ? `已整理 ${rows.length} 项保险责任。` : existing;
  }

  function filteredKnowledgeRecordsForPolicy(policyDraft) {
    if (typeof buildKnowledgeSearchArtifacts !== 'function') return [];
    return buildKnowledgeSearchArtifacts({
      policy: policyDraft,
      records: state?.knowledgeRecords || [],
      officialDomainProfiles: buildEffectiveOfficialDomainProfiles(state),
    }).records || [];
  }

  function attachResponsibilityCards(analysis, policyDraft, optionalResponsibilityRecords = state?.optionalResponsibilityRecords) {
    if (!analysis || typeof analysis !== 'object') return analysis;
    if (Array.isArray(analysis.responsibilityCards)) return analysis;
    const coverageIndicators = typeof findPolicyCoverageIndicators === 'function'
      ? findPolicyCoverageIndicators(policyDraft, state?.insuranceIndicatorRecords || [])
      : [];
    const responsibilityCards = typeof buildResponsibilityCardsForPolicy === 'function'
      ? buildResponsibilityCardsForPolicy({
          policy: policyDraft,
          responsibilities: analysis.coverageTable,
          coverageIndicators,
          knowledgeRecords: filteredKnowledgeRecordsForPolicy(policyDraft),
          optionalResponsibilityRecords: optionalResponsibilityRecords || [],
        })
      : [];
    const checkedCoverageTable = typeof responsibilityRowsFromCards === 'function'
      ? responsibilityRowsFromCards(responsibilityCards, { optionalResponsibilities: analysis.optionalResponsibilities || [] })
      : [];
    const effectiveCoverageTable = typeof mergeCoverageTableWithCheckedRows === 'function'
      ? mergeCoverageTableWithCheckedRows(analysis.coverageTable, checkedCoverageTable)
      : (checkedCoverageTable.length ? checkedCoverageTable : analysis.coverageTable);
    return {
      ...analysis,
      report: responsibilityReportFor({
        current: analysis.report,
        rows: checkedCoverageTable,
        cards: responsibilityCards,
        optionalResponsibilities: analysis.optionalResponsibilities || [],
      }),
      coverageTable: effectiveCoverageTable,
      responsibilityCards,
    };
  }

  router.post('/query', async (req, res) => {
    const routeStartedAt = nowMs();
    try {
      const input = normalizeResponsibilityQueryInput(req.body);
      const scan = {
        ocrText: `${input.company} ${input.name}`,
        data: input,
      };
      const preferLocalKnowledgeAnswer = req.body?.preferLocalKnowledgeAnswer !== false;
      const analysisStartedAt = nowMs();
      const analysis = await assistantAnalyzer({ scan, preferLocalKnowledgeAnswer });
      const analysisWithCards = attachResponsibilityCards(analysis, {
        company: input.company,
        name: input.name,
      });
      logPerformance(performanceLogger, 'policy.responsibility.assistant.analysis', {
        route: '/api/policy-responsibilities/query',
        durationMs: elapsedMs(analysisStartedAt),
        inputOcrChars: scan.ocrText.length,
        outputOcrChars: scan.ocrText.length,
        responsibilityCount: Array.isArray(analysis?.coverageTable) ? analysis.coverageTable.length : 0,
      });
      logPerformance(performanceLogger, 'policy.responsibility.assistant.complete', {
        route: '/api/policy-responsibilities/query',
        durationMs: elapsedMs(routeStartedAt),
        inputOcrChars: scan.ocrText.length,
      });
      res.json({ ok: true, analysis: analysisWithCards });
    } catch (error) {
      sendError(res, error, 400);
    }
  });

  router.post('/local-draft', (req, res) => {
    try {
      const manualData = req.body?.manualData && typeof req.body.manualData === 'object' ? req.body.manualData : req.body;
      const data = normalizePolicyScanData(manualData || {});
      const scan = {
        ocrText: trim(req.body?.ocrText) || `${data.company} ${data.name}`.trim(),
        data: {
          ...data,
          plans: normalizePolicyPlans(manualData?.plans, data.company),
          optionalResponsibilities: normalizeOptionalResponsibilities(manualData?.optionalResponsibilities),
        },
      };
      const analysis = buildRecognizedPolicyAnalysisDraft({
        state,
        scan,
        officialDomainProfiles: buildEffectiveOfficialDomainProfiles(state),
      });
      res.json({
        ok: true,
        analysis: attachResponsibilityCards(
          analysis,
          { ...data, plans: scan.data.plans },
          analysis?.optionalResponsibilities,
        ),
      });
    } catch (error) {
      sendError(res, error, 400);
    }
  });

  router.get('/company-suggestions', async (req, res) => {
    const q = trim(req.query?.q);
    const limit = Number(req.query?.limit || 12);
    res.json({
      ok: true,
      suggestions: buildResponsibilityCompanySuggestions(state, q, Number.isFinite(limit) && limit > 0 ? Math.min(limit, 50) : 12),
    });
  });

  router.get('/product-suggestions', async (req, res) => {
    const company = trim(req.query?.company);
    const q = trim(req.query?.q);
    const limit = Number(req.query?.limit || 12);
    res.json({
      ok: true,
      suggestions: buildResponsibilityProductSuggestions(state, {
        company,
        query: q,
        maxResults: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 50) : 12,
      }),
    });
  });

  router.post('/customer-summary', async (req, res) => {
    const routeStartedAt = nowMs();
    try {
      const input = normalizeResponsibilityQueryInput(req.body);
      const result = await generateProductCustomerResponsibilitySummary({
        state,
        db,
        input,
        findSummary: findProductCustomerResponsibilitySummary,
        persistSummary: persistProductCustomerResponsibilitySummary,
        persistGenerationRun: typeof persistProductCustomerSummaryGenerationRun === 'function'
          ? (run) => persistProductCustomerSummaryGenerationRun({ state, run })
          : undefined,
        generateWithDeepSeek: generateProductCustomerResponsibilitySummaryWithDeepSeek,
        generatePlannerWithDeepSeek: generateProductCustomerResponsibilityPlannerWithDeepSeek,
        generateOfficialAnalysis: async ({ company, productName }) => assistantAnalyzer({
          scan: {
            ocrText: `${company} ${productName}`,
            data: { company, name: productName },
          },
          preferLocalKnowledgeAnswer: false,
        }),
      });
      logPerformance(performanceLogger, 'policy.responsibility.customer_summary.complete', {
        route: '/api/policy-responsibilities/customer-summary',
        durationMs: elapsedMs(routeStartedAt),
        source: result?.source || result?.status || '',
      });
      res.json(result);
    } catch (error) {
      sendError(res, error, 400);
    }
  });

  router.post('/matches', async (req, res) => {
    try {
      const input = normalizeResponsibilityQueryInput(req.body);
      const policy = { company: input.company, name: input.name };
      const officialDomainProfiles = buildEffectiveOfficialDomainProfiles(state);
      const maxResults = positiveIntegerOrFallback(req.body?.limit, 3, 50);
      const minScore = scoreThresholdOrFallback(req.body?.minScore, 0.32);
      const matches = findKnowledgeProductCandidates({
        policy,
        records: state.knowledgeRecords || [],
        officialDomainProfiles,
        maxResults,
        minScore,
      });
      res.json({ ok: true, matches });
    } catch (error) {
      sendError(res, error, 400);
    }
  });

  return router;
}
