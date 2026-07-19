import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, BrainCircuit, CheckCircle2, ChevronDown, ChevronUp, Clock3, FileUp, Mic2, PackageSearch, RotateCcw, XCircle } from 'lucide-react';

import {
  ApiError,
  type AdminKnowledgeChunk,
  type AdminKnowledgeCorrectionPlan,
  type AdminKnowledgeDocument,
  type AdminKnowledgeReviewIssue,
  type AdminKnowledgeReviewWorkspaceResponse,
  confirmAdminKnowledgeCorrections,
  getAdminKnowledgeDocumentSource,
  getAdminKnowledgePagePreview,
  getAdminProductCatalogCompanies,
  getAdminKnowledgeDocuments,
  getAdminKnowledgeReviewWorkspace,
  planAdminKnowledgeCorrections,
  processAdminKnowledgeDocument,
  reviewAdminKnowledgeDocument,
  reviewAdminKnowledgePage,
  searchAdminProductCatalog,
  startAdminKnowledgePreReview,
  updateAdminKnowledgeChunkBinding,
  uploadAdminKnowledgeDocument,
  uploadAdminKnowledgeDocumentFromUrl,
} from '../../../api';

type KnowledgeUploadMode = 'expert' | 'company_product';
type KnowledgePageTab = 'upload' | 'documents';

const AUDIO_EXTENSIONS = new Set(['mp3', 'm4a', 'wav', 'aac', 'flac']);
const COMPANY_FOCUS_OPTIONS = ['产品优势', '适合客户', '保险责任', '投保规则', '健康告知', '责任免除', '费率与利益', '竞品差异', '销售话术', '合规风险'];
const EXPERT_FOCUS_OPTIONS = ['需求分析', '产品推荐', '成交话术', '异议处理', '家庭保障规划', '保单检视', '客户跟进', '销售案例', '常见错误', '合规提醒'];
const COMPANY_MATERIAL_TYPES = ['产品介绍', '保险条款', '产品培训课件', '销售支持资料', '费率表', '产品对比资料', '常见问题'];
const EXPERT_MATERIAL_TYPES = ['专家课程', '销冠经验', '培训录音', '销售案例', '销售话术', '异议处理', '业务问答'];
const REVIEW_PAGE_SIZE = 5;

function extensionOf(fileName: string) {
  return fileName.split('.').pop()?.toLowerCase() || '';
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

async function fileToBase64(file: File) {
  return bytesToBase64(new Uint8Array(await file.arrayBuffer()));
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function statusInfo(document: AdminKnowledgeDocument) {
  if (document.reviewStatus === 'published') {
    return { label: '已发布到知识库', className: 'bg-emerald-50 text-emerald-700', icon: CheckCircle2 };
  }
  if (document.reviewStatus === 'rejected') {
    return { label: '已拒绝 / 已下架', className: 'bg-rose-50 text-rose-700', icon: XCircle };
  }
  if (document.parseStatus === 'transcription_required') {
    return { label: '已保存，待语音转写', className: 'bg-amber-50 text-amber-700', icon: Clock3 };
  }
  if (document.parseStatus === 'ocr_required') {
    return { label: '待 OCR', className: 'bg-amber-50 text-amber-700', icon: Clock3 };
  }
  if (document.parseStatus === 'parse_failed') {
    return { label: '解析失败', className: 'bg-rose-50 text-rose-700', icon: AlertTriangle };
  }
  if (document.parseStatus === 'reprocess_required') {
    return { label: '质检未通过，需重新处理', className: 'bg-rose-50 text-rose-700', icon: AlertTriangle };
  }
  if (document.parseStatus === 'indexed_pending_review') {
    return { label: '已切片，待审核', className: 'bg-blue-50 text-blue-700', icon: Clock3 };
  }
  return { label: '已上传，待解析', className: 'bg-slate-100 text-slate-600', icon: Clock3 };
}

type QualityCheck = { code?: string; status?: string; message?: string };

function documentQuality(document: AdminKnowledgeDocument) {
  const quality = document.payload?.documentQuality;
  if (!quality || typeof quality !== 'object' || Array.isArray(quality)) return null;
  const value = quality as { decision?: string; checks?: QualityCheck[] };
  return { decision: String(value.decision || ''), checks: Array.isArray(value.checks) ? value.checks : [] };
}

function qualityLabel(decision: string) {
  if (decision === 'pass') return '基础解析检查通过（不代表审核通过）';
  if (decision === 'review_required') return '文档需要人工复核';
  if (decision === 'reprocess_required') return '文档需要重新处理';
  return '等待文档质检';
}

const FACT_KEYWORD_LABELS: Record<string, string> = {
  waiting_period: '等待期', annual_deductible: '免赔额', reimbursement_ratio: '给付比例',
  benefit_limit: '保障限额', entry_age: '投保年龄', renewal_period: '续保条件',
};
const TOPIC_KEYWORD_LABELS: Record<string, string> = {
  product_overview: '产品概览', target_audience: '适用人群', product_advantage: '产品优势',
  underwriting: '投保规则', coverage: '保障责任', exclusions: '责任免除', plan_pricing: '计划与价格',
  health_services: '健康服务', claims: '理赔规则',
};
const CONTENT_KEYWORDS: Array<[string, RegExp]> = [
  ['产品培训', /产品培训/u], ['产品定位', /产品定位/u], ['产品特色', /产品特色|产品优势|产品亮点/u],
  ['适合客户', /适合客户|适用人群|目标客户/u], ['保险责任', /保险责任|保障责任/u],
  ['健康服务', /健康服务|健康管理/u], ['长期护理', /长期护理/u], ['医疗保险', /医疗保险|医疗险/u],
  ['重大疾病', /重大疾病|重疾/u], ['恶性肿瘤', /恶性肿瘤|癌症/u], ['责任免除', /责任免除|免责/u],
  ['理赔', /理赔|保险金申请/u], ['保费费率', /保费|费率/u], ['保障计划', /保障计划/u],
];

function chunkKeywords(chunk: AdminKnowledgeChunk) {
  const semantic = chunk.payload?.semantic && typeof chunk.payload.semantic === 'object'
    ? chunk.payload.semantic as { keywords?: unknown[]; topics?: unknown[]; factKeys?: unknown[]; responsibility?: unknown; planNames?: unknown[] }
    : null;
  const heading = chunk.headingPath?.at(-1) || '';
  return [...new Set([
    ...(Array.isArray(semantic?.keywords) ? semantic.keywords : []),
    ...(Array.isArray(chunk.payload?.businessTopicLabels) ? chunk.payload.businessTopicLabels : []),
    ...(Array.isArray(semantic?.topics) ? semantic.topics.map((item) => TOPIC_KEYWORD_LABELS[String(item)] || String(item)) : []),
    ...(Array.isArray(semantic?.factKeys) ? semantic.factKeys.map((item) => FACT_KEYWORD_LABELS[String(item)] || '') : []),
    semantic?.responsibility,
    ...(Array.isArray(semantic?.planNames) ? semantic.planNames : []),
    ...CONTENT_KEYWORDS.filter(([, pattern]) => pattern.test(chunk.content)).map(([label]) => label),
    heading && !/^(?:目录|未识别章节)$/u.test(heading) && heading.length <= 24 ? heading : '',
  ].map((item) => String(item || '').trim()).filter(Boolean))].slice(0, 8);
}

function RagChunkContent({ chunk }: { chunk: AdminKnowledgeChunk }) {
  if (chunk.chunkType !== 'table') {
    return <p className="mt-2 whitespace-pre-wrap text-xs font-medium leading-5 text-slate-700">{chunk.content}</p>;
  }
  const rows = chunk.content.split('\n').map((line) => line.split('|').map((cell) => cell.trim()));
  const [header = [], ...body] = rows;
  return (
    <div className="mt-2 overflow-x-auto rounded-lg border border-blue-100 bg-white">
      <table className="min-w-max border-collapse text-left text-xs text-slate-700">
        <thead className="bg-blue-50">
          <tr>{header.map((cell, index) => <th key={index} className="whitespace-nowrap border-b border-r border-blue-100 px-3 py-2 font-black last:border-r-0">{cell || '—'}</th>)}</tr>
        </thead>
        <tbody>
          {body.map((row, rowIndex) => <tr key={rowIndex} className="even:bg-slate-50/70">{row.map((cell, cellIndex) => <td key={cellIndex} className="max-w-80 border-b border-r border-slate-100 px-3 py-2 align-top font-medium last:border-r-0">{cell || '—'}</td>)}</tr>)}
        </tbody>
      </table>
    </div>
  );
}

const REVIEW_REASON_OPTIONS = [
  ['ocr_error', 'OCR错误'],
  ['missing_content', '内容缺失'],
  ['content_extra', '内容多余'],
  ['chunk_boundary', '切片边界错误'],
  ['semantic_incomplete', '语义不完整'],
  ['image_error', '图片漏切或错切'],
  ['table_structure', '表格结构错误'],
  ['cross_page_relation', '跨页关系缺失'],
  ['product_binding', '产品或版本绑定错误'],
] as const;

const ISSUE_TYPE_LABELS: Record<string, string> = {
  source_coverage: '来源覆盖',
  missing_content: '内容缺失',
  content_extra: '内容多余',
  semantic_incomplete: '语义不完整',
  missing_relation: '关系缺失',
  image_missing: '图片漏切',
  table_structure: '表格结构',
  product_binding: '产品绑定',
};

const OPERATION_LABELS: Record<string, string> = {
  edit_chunk: '编辑切片',
  split_chunk: '拆分切片',
  merge_chunks: '合并切片',
  add_source_elements: '补入来源内容',
  remove_source_elements: '移除多余来源',
  exclude_chunk: '排除切片',
  create_relation: '建立必要关系',
  remove_relation: '删除错误关系',
};

function correctionOperationDetail(operation: AdminKnowledgeCorrectionPlan['operations'][number]) {
  if (operation.content) return `修改后内容：${operation.content}`;
  if (operation.splitAtText) return `拆分位置：${operation.splitAtText}`;
  if (operation.elementIds?.length) return `来源元素：${operation.elementIds.join('、')}`;
  if (operation.targetChunkIds?.length) return `目标切片：${operation.targetChunkIds.join('、')}`;
  if (operation.relatedChunkId) return `关联切片：${operation.relatedChunkId}${operation.relationType ? `（${operation.relationType}）` : ''}`;
  return '';
}

function issueSeverityClass(severity: string) {
  if (severity === 'high') return 'border-rose-200 bg-rose-50 text-rose-700';
  if (severity === 'medium') return 'border-amber-200 bg-amber-50 text-amber-700';
  return 'border-blue-100 bg-blue-50 text-blue-700';
}

function issueSourceElementCount(issue: AdminKnowledgeReviewIssue) {
  return new Set(issue.sourceRegions.flatMap((region) => region.elementIds)).size;
}

function issueSeverityLabel(severity: string) {
  if (severity === 'high') return '高风险';
  if (severity === 'medium') return '需关注';
  return '提示';
}

function PageReviewWorkbench({
  document,
  chunks,
  token,
  onMessage,
  onChanged,
}: {
  document: AdminKnowledgeDocument;
  chunks: AdminKnowledgeChunk[];
  token: string;
  onMessage: (message: string) => void;
  onChanged: () => Promise<void>;
}) {
  const [workspace, setWorkspace] = useState<AdminKnowledgeReviewWorkspaceResponse | null>(null);
  const [sourceUrl, setSourceUrl] = useState('');
  const [pagePreviewUrls, setPagePreviewUrls] = useState<Record<number, string>>({});
  const [pagePreviewLoading, setPagePreviewLoading] = useState<Set<number>>(new Set());
  const [pagePreviewErrors, setPagePreviewErrors] = useState<Record<number, string>>({});
  const [pagePreviewReloadVersion, setPagePreviewReloadVersion] = useState(0);
  const [reviewPageNo, setReviewPageNo] = useState(1);
  const [expandedPreview, setExpandedPreview] = useState<{ pageNo: number; url: string } | null>(null);
  const [previewZoom, setPreviewZoom] = useState(100);
  const [activePageNo, setActivePageNo] = useState(0);
  const [selectedIssueId, setSelectedIssueId] = useState('');
  const [selectedChunkId, setSelectedChunkId] = useState('');
  const [reasonCode, setReasonCode] = useState('semantic_incomplete');
  const [scope, setScope] = useState('current_chunk');
  const [note, setNote] = useState('');
  const [plan, setPlan] = useState<AdminKnowledgeCorrectionPlan | null>(null);
  const [planError, setPlanError] = useState('');
  const [correctionNotice, setCorrectionNotice] = useState('');
  const [busy, setBusy] = useState<'loading' | 'ai' | 'review' | 'plan' | 'confirm' | ''>('loading');
  const confirmingRef = useRef(false);

  async function loadWorkspace() {
    setBusy('loading');
    try {
      const nextWorkspace = await getAdminKnowledgeReviewWorkspace(token, document.id);
      setWorkspace(nextWorkspace);
      setReviewPageNo((current) => nextWorkspace.pages.some((page) => page.pageNo === current)
        ? current
        : nextWorkspace.pages[0]?.pageNo || 1);
    } catch (error) {
      onMessage(error instanceof Error ? error.message : '审核页面读取失败');
    } finally {
      setBusy('');
    }
  }

  useEffect(() => { void loadWorkspace(); }, [document.id, token]);

  const pageSignature = (workspace?.pages || []).map((page) => page.pageNo).join(',');

  useEffect(() => {
    const allPageNos = pageSignature.split(',').map(Number).filter((pageNo) => pageNo > 0);
    const selectedIndex = Math.max(0, allPageNos.indexOf(reviewPageNo));
    const groupStart = Math.floor(selectedIndex / REVIEW_PAGE_SIZE) * REVIEW_PAGE_SIZE;
    const pageNos = allPageNos.slice(groupStart, groupStart + REVIEW_PAGE_SIZE);
    if (!pageNos.length) return undefined;
    let active = true;
    const objectUrls: string[] = [];
    setPagePreviewUrls({});
    setPagePreviewErrors({});
    setPagePreviewLoading(new Set(pageNos));
    void Promise.all(pageNos.map(async (pageNo) => {
      try {
        let blob: Blob | null = null;
        let lastError: unknown;
        for (let attempt = 0; attempt < 3 && !blob; attempt += 1) {
          try {
            blob = await getAdminKnowledgePagePreview(token, document.id, pageNo);
          } catch (error) {
            lastError = error;
            if (attempt < 2) await new Promise((resolve) => window.setTimeout(resolve, 800 * (attempt + 1)));
          }
        }
        if (!blob) throw lastError;
        const url = URL.createObjectURL(blob);
        objectUrls.push(url);
        if (active) setPagePreviewUrls((current) => ({ ...current, [pageNo]: url }));
      } catch (error) {
        if (active) setPagePreviewErrors((current) => ({ ...current, [pageNo]: error instanceof Error ? error.message : '原页图片生成失败' }));
      } finally {
        if (active) setPagePreviewLoading((current) => {
          const next = new Set(current);
          next.delete(pageNo);
          return next;
        });
      }
    }));
    return () => {
      active = false;
      objectUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [document.id, pagePreviewReloadVersion, pageSignature, reviewPageNo, token]);

  useEffect(() => {
    if (document.mediaType !== 'application/pdf' && !document.mediaType.startsWith('image/')) return undefined;
    let active = true;
    let objectUrl = '';
    void getAdminKnowledgeDocumentSource(token, document.id).then((blob) => {
      if (!active) return;
      objectUrl = URL.createObjectURL(blob);
      setSourceUrl(objectUrl);
    }).catch(() => { if (active) setSourceUrl(''); });
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [document.id, document.mediaType, token]);

  const pages = [...(workspace?.pages || [])].sort((left, right) => left.pageNo - right.pageNo);
  const reviewPageIndex = Math.max(0, pages.findIndex((page) => page.pageNo === reviewPageNo));
  const reviewGroupStart = Math.floor(reviewPageIndex / REVIEW_PAGE_SIZE) * REVIEW_PAGE_SIZE;
  const visiblePages = pages.slice(reviewGroupStart, reviewGroupStart + REVIEW_PAGE_SIZE);
  const reviewGroupPageNo = pages[reviewGroupStart]?.pageNo || reviewPageNo;
  const selectedIssue = workspace?.issues.find((issue) => issue.id === selectedIssueId) || null;
  const selectedChunk = chunks.find((chunk) => chunk.id === selectedChunkId) || null;
  const issuesForPage = (pageNo: number) => (workspace?.issues || []).filter((issue) => issue.pageNos.includes(pageNo)
    || issue.sourceRegions.some((region) => region.pageNo === pageNo));
  const chunksForPage = (pageNo: number) => chunks.filter((chunk) => chunk.chunkType !== 'parent'
    && pageNo >= chunk.pageStart && pageNo <= chunk.pageEnd);
  const productNameForChunk = (chunk: AdminKnowledgeChunk) => document.bindingProducts
    ?.find((product) => product.canonicalProductId === chunk.canonicalProductId)?.officialName || '';

  function openCorrection(pageNo: number, issue: AdminKnowledgeReviewIssue | null, chunkId = '') {
    const pageChunks = chunksForPage(pageNo);
    const savedReview = workspace?.pageReviews.find((item) => item.pageNo === pageNo);
    setActivePageNo(pageNo);
    setSelectedIssueId(issue?.id || '');
    setSelectedChunkId(chunkId || issue?.affectedChunkIds[0] || pageChunks[0]?.id || '');
    setReasonCode(issue?.type === 'content_extra' ? 'content_extra' : issue?.type === 'missing_content' ? 'missing_content' : 'semantic_incomplete');
    setNote(savedReview?.note || issue?.reason || '');
    setPlan(null);
    setPlanError('');
    setCorrectionNotice('');
  }

  async function persistCorrectionNote(announce = false) {
    if (!activePageNo || !note.trim()) return null;
    const result = await reviewAdminKnowledgePage(token, document.id, activePageNo, {
      status: 'needs_correction',
      note: note.trim(),
      indexVersion: workspace?.indexReview?.candidateIndexVersion,
    });
    setWorkspace((current) => current ? {
      ...current,
      pageReviews: [...current.pageReviews.filter((item) => item.pageNo !== activePageNo), result.review]
        .sort((left, right) => left.pageNo - right.pageNo),
    } : current);
    if (announce) onMessage(`第 ${activePageNo} 页不通过原因已保存`);
    return result;
  }

  async function saveCorrectionNote() {
    setBusy('review');
    try {
      await persistCorrectionNote(true);
    } catch (error) {
      onMessage(error instanceof Error ? error.message : '不通过原因保存失败');
    } finally {
      setBusy('');
    }
  }

  async function savePageReview(pageNo: number, status: 'passed' | 'needs_correction' | 'excluded', issue: AdminKnowledgeReviewIssue | null = null, exclusionReason = '') {
    setBusy('review');
    try {
      const result = await reviewAdminKnowledgePage(token, document.id, pageNo, {
        status,
        note: status === 'excluded'
          ? exclusionReason
          : status === 'passed' && issuesForPage(pageNo).length
            ? '人工复核后确认本页通过，AI提示无需修正。'
            : '',
        indexVersion: workspace?.indexReview?.candidateIndexVersion,
      });
      if (status === 'needs_correction') openCorrection(pageNo, issue);
      onMessage(status === 'passed'
        ? result.publishedChunkCount
          ? `第 ${pageNo} 页已人工确认通过，${result.publishedChunkCount} 个合格切片已直接入库`
          : `第 ${pageNo} 页已人工确认通过；跨页或未绑定切片将在满足条件后入库`
        : status === 'excluded'
          ? `第 ${pageNo} 页已设为不入库，原图和 OCR 仍保留`
          : `第 ${pageNo} 页已标记不通过，请填写修正说明`);
      await loadWorkspace();
    } catch (error) {
      onMessage(error instanceof Error ? error.message : '页面审核保存失败');
    } finally {
      setBusy('');
    }
  }

  function excludePage(pageNo: number) {
    const reason = window.prompt('请输入本页不入库原因，例如：封面、目录、版权页、空白页', '封面或目录等非检索内容');
    if (reason === null) return;
    void savePageReview(pageNo, 'excluded', null, reason.trim() || '人工确认本页不参与知识库检索');
  }

  async function runPreReview() {
    setBusy('ai');
    try {
      const result = await startAdminKnowledgePreReview(token, document.id);
      onMessage(`AI预审完成，发现 ${result.issues.length} 项需要复核的问题`);
      await loadWorkspace();
    } catch (error) {
      onMessage(error instanceof Error ? error.message : 'AI预审失败');
    } finally {
      setBusy('');
    }
  }

  async function createPlan() {
    if (!note.trim()) { onMessage('请填写问题和期望修正结果'); return; }
    setBusy('plan');
    setPlanError('');
    try {
      await persistCorrectionNote();
      const result = await planAdminKnowledgeCorrections(token, document.id, {
        pageNo: activePageNo,
        sourceIssueId: selectedIssue?.id,
        reasonCode,
        note: note.trim(),
        scope,
        targetChunkIds: selectedChunk ? [selectedChunk.id] : selectedIssue?.affectedChunkIds || [],
        sourceElementIds: selectedIssue?.sourceRegions.flatMap((region) => region.elementIds) || [],
        operations: selectedIssue?.proposedOperations || [],
      });
      setPlan(result.plan);
      if (result.plan.operations.length) {
        onMessage(`AI 已生成 ${result.plan.operations.length} 个修正操作，请核对预览后确认`);
        window.setTimeout(() => window.document.getElementById(`correction-preview-${document.id}-${activePageNo}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 0);
      }
      else onMessage('AI 未能根据现有证据生成安全修正方案，请补充更具体的修正要求');
    } catch (error) {
      const message = error instanceof Error ? error.message : '修正计划生成失败';
      setPlan(null);
      setPlanError(message);
      onMessage(message);
    } finally {
      setBusy('');
    }
  }

  async function confirmPlan() {
    if (!plan || confirmingRef.current) return;
    confirmingRef.current = true;
    setBusy('confirm');
    setPlanError('');
    try {
      await confirmAdminKnowledgeCorrections(token, document.id, {
        plan,
        pageNo: activePageNo,
        sourceIssueId: selectedIssue?.id,
        indexVersion: workspace?.indexReview?.candidateIndexVersion,
      });
      setPlan(null);
      setSelectedChunkId('');
      setCorrectionNotice('AI 修正已保存为新候选版本。请核对上方更新后的 RAG 切片，确认无误后点击“人工确认通过”入库。');
      onMessage('AI 修正已生成新候选版本，请再次核对该页并点击人工确认通过');
      await onChanged();
      await loadWorkspace();
      window.setTimeout(() => window.document.getElementById(`page-review-${document.id}-${activePageNo}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0);
    } catch (error) {
      const message = error instanceof Error ? error.message : '确认修正失败';
      setPlanError(message);
      onMessage(message);
    } finally {
      confirmingRef.current = false;
      setBusy('');
    }
  }

  return <div id={`page-image-review-${document.id}`} className="rounded-2xl border border-violet-200 bg-white p-3 shadow-sm">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div><p className="flex items-center gap-1.5 text-sm font-black text-slate-900"><BrainCircuit size={16} className="text-violet-600" />逐页原图、OCR、RAG切片三栏对比审核</p><p className="mt-1 text-[11px] font-semibold text-slate-500">每个分页展示5个审核卡片，同时核对原图、OCR文字、RAG切片与AI结论。</p></div>
      <button type="button" disabled={Boolean(busy)} onClick={() => void runPreReview()} className="rounded-lg bg-violet-600 px-3 py-2 text-xs font-black text-white disabled:opacity-50">{busy === 'ai' ? '预审中…' : workspace?.reviewRuns.length ? '重新 AI 预审整份资料' : '开始 AI 预审整份资料'}</button>
    </div>
    {busy === 'loading' && !workspace ? <p className="py-8 text-center text-xs font-semibold text-slate-400">正在读取全部页面…</p> : null}
    {workspace ? <div className="mt-3 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-slate-50 px-3 py-2 text-[11px] font-black text-slate-600"><div className="flex flex-wrap gap-3"><span>共 {pages.length} 页</span><span>每页 5 条</span><span>AI 风险 {workspace.issues.length} 项</span><span>人工已审 {workspace.pageReviews.length} 页</span></div><div className="flex items-center gap-2"><button type="button" disabled={reviewGroupStart <= 0} onClick={() => setReviewPageNo(pages[Math.max(0, reviewGroupStart - REVIEW_PAGE_SIZE)]?.pageNo || reviewPageNo)} className="rounded-lg bg-white px-2.5 py-1.5 text-blue-700 shadow-sm disabled:opacity-40">上一页</button><select aria-label="选择审核分页" value={reviewGroupPageNo} onChange={(event) => setReviewPageNo(Number(event.target.value))} className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-blue-700"><option disabled value={0}>选择分页</option>{pages.filter((_, index) => index % REVIEW_PAGE_SIZE === 0).map((page, groupIndex) => <option key={page.pageNo} value={page.pageNo}>第 {page.pageNo}-{pages[Math.min(groupIndex * REVIEW_PAGE_SIZE + REVIEW_PAGE_SIZE - 1, pages.length - 1)]?.pageNo} 页 / 共 {pages.length} 页</option>)}</select><button type="button" disabled={reviewGroupStart + REVIEW_PAGE_SIZE >= pages.length} onClick={() => setReviewPageNo(pages[reviewGroupStart + REVIEW_PAGE_SIZE]?.pageNo || reviewPageNo)} className="rounded-lg bg-white px-2.5 py-1.5 text-blue-700 shadow-sm disabled:opacity-40">下一页</button></div></div>
      {visiblePages.map((page) => {
        const pageIssues = issuesForPage(page.pageNo);
        const pageChunks = chunksForPage(page.pageNo);
        const review = workspace.pageReviews.find((item) => item.pageNo === page.pageNo);
        const highlighted = new Set(pageIssues.flatMap((issue) => issue.sourceRegions.flatMap((region) => region.pageNo === page.pageNo ? region.elementIds : [])));
        const editorOpen = activePageNo === page.pageNo;
        const previewUrl = pagePreviewUrls[page.pageNo] || page.previewUrl || page.imageUrl || (document.mediaType.startsWith('image/') ? sourceUrl : '');
        return <section id={`page-review-${document.id}-${page.pageNo}`} key={page.id || page.pageNo} className={`rounded-2xl border p-3 ${pageIssues.length ? 'border-amber-200 bg-amber-50/30' : 'border-blue-100 bg-blue-50/20'}`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2"><p className="text-sm font-black text-blue-700">第 {page.pageNo} 页</p><span className={`rounded-full px-2 py-1 text-[10px] font-black ${pageIssues.length ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700'}`}>{pageIssues.length ? `AI 发现 ${pageIssues.length} 项` : 'AI 未发现风险'}</span><span className={`rounded-full px-2 py-1 text-[10px] font-black ${review?.status === 'passed' ? 'bg-emerald-600 text-white' : review?.status === 'needs_correction' ? 'bg-rose-600 text-white' : review?.status === 'excluded' ? 'bg-amber-500 text-white' : review?.status === 'pending_confirmation' ? 'bg-violet-600 text-white' : 'bg-slate-200 text-slate-600'}`}>{review?.status === 'passed' ? (pageChunks.some((chunk) => chunk.reviewStatus === 'published') ? '人工审核通过·已入库' : '人工已通过·待跨页切片') : review?.status === 'needs_correction' ? '人工不通过' : review?.status === 'excluded' ? '本页不入库' : review?.status === 'pending_confirmation' ? 'AI 已修正，待确认' : '人工待审核'}</span></div>
            <div className="flex flex-wrap gap-2">{sourceUrl && document.mediaType === 'application/pdf' ? <a href={`${sourceUrl}#page=${page.pageNo}`} target="_blank" rel="noreferrer" className="rounded-lg bg-white px-3 py-1.5 text-[11px] font-black text-blue-700">打开原始页</a> : null}<button type="button" disabled={Boolean(busy)} onClick={() => void savePageReview(page.pageNo, 'passed')} className="rounded-lg bg-emerald-600 px-3 py-1.5 text-[11px] font-black text-white disabled:opacity-50">{review?.status === 'excluded' ? '恢复入库' : '人工确认通过'}</button>{review?.status !== 'excluded' ? <button type="button" disabled={Boolean(busy)} onClick={() => excludePage(page.pageNo)} className="rounded-lg bg-amber-500 px-3 py-1.5 text-[11px] font-black text-white disabled:opacity-50">本页不入库</button> : null}<button type="button" disabled={Boolean(busy)} onClick={() => void savePageReview(page.pageNo, 'needs_correction', pageIssues[0] || null)} className="rounded-lg bg-rose-600 px-3 py-1.5 text-[11px] font-black text-white disabled:opacity-50">不通过并修正</button></div>
          </div>
          <div className="mt-3 grid gap-3 xl:grid-cols-3">
            <div className="rounded-xl border border-slate-200 bg-white p-3"><p className="text-xs font-black text-slate-800">原页图片 / OCR 文字</p>{previewUrl ? <button type="button" onClick={() => { setExpandedPreview({ pageNo: page.pageNo, url: previewUrl }); setPreviewZoom(100); }} className="group relative mt-2 block w-full overflow-hidden rounded-lg border border-slate-100 bg-slate-50"><img src={previewUrl} alt={`原始资料第${page.pageNo}页`} onError={() => setPagePreviewErrors((current) => ({ ...current, [page.pageNo]: '图片已生成，但浏览器加载失败' }))} className="max-h-80 w-full object-contain" /><span className="absolute bottom-2 right-2 rounded-lg bg-slate-950/75 px-2.5 py-1.5 text-[10px] font-black text-white shadow-sm transition group-hover:bg-blue-600">点击放大查看</span></button> : pagePreviewLoading.has(page.pageNo) ? <div className="mt-2 flex h-40 items-center justify-center rounded-lg bg-slate-50 text-xs font-black text-slate-400">正在生成第 {page.pageNo} 页原图…</div> : <div className="mt-2 flex h-28 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-rose-200 bg-rose-50 px-3 text-center text-xs font-black text-rose-600"><span>{pagePreviewErrors[page.pageNo] || '本页没有可用的原图预览'}</span><button type="button" onClick={() => setPagePreviewReloadVersion((current) => current + 1)} className="rounded-lg bg-white px-3 py-1.5 text-[11px] text-blue-700 shadow-sm">重新加载原图</button></div>}<p className="mt-3 text-[10px] font-black text-slate-400">OCR 识别文字</p><p className="mt-1 max-h-72 overflow-y-auto whitespace-pre-wrap text-xs font-medium leading-5 text-slate-700">{page.rawText || '本页没有可显示的 OCR 文字'}</p>{page.layout?.elements?.length ? <div className="mt-2 space-y-1">{page.layout.elements.map((element) => <div key={element.id} className={`rounded-lg border px-2 py-1.5 text-[11px] ${highlighted.has(element.id) ? 'border-rose-300 bg-rose-50 text-rose-800' : 'border-slate-100 bg-slate-50 text-slate-600'}`}><span className="mr-1 font-black uppercase text-slate-400">{element.kind}</span>{element.text || element.caption || element.assetRef || element.id}</div>)}</div> : null}</div>
            <div className="rounded-xl border border-slate-200 bg-white p-3"><div className="flex items-center justify-between"><p className="text-xs font-black text-slate-800">本页 RAG 切片</p><span className="text-[10px] font-black text-slate-400">{pageChunks.length} 个</span></div><div className="mt-2 max-h-[520px] space-y-2 overflow-y-auto">{pageChunks.map((chunk) => <button key={chunk.id} type="button" onClick={() => openCorrection(page.pageNo, null, chunk.id)} className={`block w-full rounded-xl border p-2.5 text-left ${editorOpen && selectedChunkId === chunk.id ? 'border-violet-400 bg-violet-50' : 'border-blue-100 bg-blue-50/40'}`}><div className="flex flex-wrap gap-1.5 text-[10px] font-black"><span className="text-blue-700">{chunk.headingPath?.join(' / ') || '未识别章节'} · 第 {chunk.pageStart}-{chunk.pageEnd} 页</span><span className={chunk.canonicalProductId ? 'text-emerald-700' : 'text-rose-700'}>产品：{productNameForChunk(chunk) || '未绑定'}</span><span className="text-slate-500">{chunk.chunkType === 'table' ? '表格切片' : '正文切片'}</span><span className="text-fuchsia-700">关键词：{chunkKeywords(chunk).join('、') || '待生成'}</span></div><RagChunkContent chunk={chunk} /></button>)}</div>{!pageChunks.length ? <p className="mt-2 rounded-lg bg-rose-50 p-3 text-xs font-semibold text-rose-600">本页没有关联到可检索切片。</p> : null}</div>
            <div className="rounded-xl border border-slate-200 bg-white p-3"><p className="text-xs font-black text-slate-800">AI 复核与人工结论</p><div className="mt-2 space-y-2">{pageIssues.map((issue) => <button key={issue.id} type="button" onClick={() => openCorrection(page.pageNo, issue)} className={`block w-full rounded-xl border p-2.5 text-left ${editorOpen && selectedIssueId === issue.id ? 'border-violet-400 bg-violet-50' : 'border-amber-100 bg-amber-50/60'}`}><div className="flex flex-wrap items-center gap-1.5"><span className={`rounded-full border px-1.5 py-0.5 text-[10px] font-black ${issueSeverityClass(issue.severity)}`}>{issueSeverityLabel(issue.severity)}</span><span className="text-[10px] font-black text-slate-500">{ISSUE_TYPE_LABELS[issue.type] || issue.type}</span>{issueSourceElementCount(issue) > 1 ? <span className="text-[10px] font-black text-amber-700">涉及 {issueSourceElementCount(issue)} 个原始元素</span> : null}</div><p className="mt-1.5 text-xs font-semibold leading-5 text-slate-700">{issue.reason}</p></button>)}</div>{!pageIssues.length ? <p className="mt-2 rounded-xl bg-emerald-50 p-3 text-xs font-semibold leading-5 text-emerald-700">AI 未发现明显缺失、多余或语义切断，仍需人工确认。</p> : null}{review?.note ? <p className="mt-2 rounded-lg bg-slate-50 p-2 text-[11px] font-semibold text-slate-600">人工说明：{review.note}</p> : null}</div>
          </div>
          {editorOpen ? <div className="mt-3 rounded-xl border border-violet-200 bg-violet-50 p-3">
            <div className="flex items-center justify-between"><p className="text-xs font-black text-violet-900">第 {page.pageNo} 页 AI 修正与人工确认</p><button type="button" onClick={() => { setActivePageNo(0); setPlan(null); setPlanError(''); }} className="text-[11px] font-black text-slate-500">收起</button></div>
            <select value={selectedChunkId} onChange={(event) => { setSelectedChunkId(event.target.value); setPlan(null); setPlanError(''); }} className="mt-2 w-full rounded-lg border border-slate-200 bg-white px-2 py-2 text-xs font-semibold"><option value="">选择本页切片</option>{pageChunks.map((chunk) => <option key={chunk.id} value={chunk.id}>{chunk.headingPath?.join(' / ') || chunk.chunkType} · 第{chunk.pageStart}-{chunk.pageEnd}页</option>)}</select>
            <div className="mt-2 grid gap-2 md:grid-cols-2"><label className="text-[11px] font-black text-slate-600">不通过原因<select value={reasonCode} onChange={(event) => { setReasonCode(event.target.value); setPlan(null); setPlanError(''); }} className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-2 py-2 text-xs font-semibold">{REVIEW_REASON_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="text-[11px] font-black text-slate-600">作用范围<select value={scope} onChange={(event) => { setScope(event.target.value); setPlan(null); setPlanError(''); }} className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-2 py-2 text-xs font-semibold"><option value="current_chunk">仅当前切片</option><option value="document_repeated_regions">整份资料重复区域</option><option value="product_page_range">产品页面范围</option></select></label></div>
            <textarea value={note} onChange={(event) => { setNote(event.target.value); setPlan(null); setPlanError(''); setCorrectionNotice(''); }} onBlur={() => { if (note.trim() && !plan) void persistCorrectionNote(); }} placeholder="说明本页哪里缺失、多余或切错，以及期望如何修正；失焦自动保存，AI 只生成方案，不会直接写入知识库" className="mt-2 min-h-24 w-full rounded-xl border border-slate-200 bg-white p-2.5 text-xs font-medium leading-5" />
            <div className="mt-2 grid gap-2 sm:grid-cols-[auto_1fr]"><button type="button" disabled={Boolean(busy) || !note.trim()} onClick={() => void saveCorrectionNote()} className="rounded-lg bg-white px-4 py-2 text-xs font-black text-blue-700 shadow-sm disabled:opacity-50">{busy === 'review' ? '保存中…' : '保存不通过原因'}</button><button type="button" disabled={Boolean(busy) || !note.trim()} onClick={() => void createPlan()} className="rounded-lg bg-slate-900 px-3 py-2 text-xs font-black text-white disabled:opacity-50">{busy === 'plan' ? 'AI 正在生成修正预览…' : '保存原因并生成 AI 修正预览'}</button></div>
            {planError ? <div role="alert" className="mt-2 rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs font-semibold text-rose-700"><p className="font-black">AI 修正预览生成失败</p><p className="mt-1 break-all">{planError}</p></div> : null}
            {correctionNotice ? <div role="status" className="mt-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs font-semibold leading-5 text-emerald-800">{correctionNotice}</div> : null}
            {plan ? <div id={`correction-preview-${document.id}-${page.pageNo}`} className="mt-2 rounded-xl border border-violet-200 bg-white p-3 shadow-sm"><p className="text-xs font-black text-violet-900">AI 修正执行前预览 · {plan.operations.length} 个操作</p><p className="mt-1 text-[11px] font-semibold text-slate-500">请核对目标切片和修改后内容，确认后才会生成新候选版本。</p>{plan.operations.map((operation, index) => <div key={`${operation.type}-${index}`} className="mt-2 rounded-lg border border-slate-200 bg-slate-50 p-2.5"><p className="text-[11px] font-black text-slate-800">{index + 1}. {OPERATION_LABELS[operation.type] || operation.type}</p>{operation.targetChunkId ? <p className="mt-1 break-all text-[10px] font-semibold text-slate-500">目标切片：{operation.targetChunkId}</p> : null}{correctionOperationDetail(operation) ? <p className="mt-1 whitespace-pre-wrap text-[11px] font-semibold leading-5 text-blue-800">{correctionOperationDetail(operation)}</p> : null}</div>)}<button type="button" disabled={Boolean(busy) || !plan.operations.length} onClick={() => void confirmPlan()} className="mt-3 w-full rounded-lg bg-violet-600 px-3 py-2 text-xs font-black text-white disabled:opacity-50">{busy === 'confirm' ? '正在生成候选版本…' : '确认修正并生成新候选版本'}</button></div> : null}
          </div> : null}
        </section>;
      })}
    </div> : null}
    {expandedPreview ? <div role="dialog" aria-modal="true" aria-label={`第 ${expandedPreview.pageNo} 页原图`} onClick={() => setExpandedPreview(null)} className="fixed inset-0 z-[100] flex flex-col bg-slate-950/95 p-4">
      <div className="mx-auto flex w-full max-w-[96vw] flex-wrap items-center justify-between gap-3 rounded-xl bg-slate-900 px-4 py-3 text-white" onClick={(event) => event.stopPropagation()}>
        <p className="text-sm font-black">第 {expandedPreview.pageNo} 页原图 · {previewZoom}%</p>
        <div className="flex items-center gap-2"><button type="button" onClick={() => setPreviewZoom((value) => Math.max(50, value - 25))} className="rounded-lg bg-slate-700 px-3 py-2 text-xs font-black">缩小</button><button type="button" onClick={() => setPreviewZoom(100)} className="rounded-lg bg-slate-700 px-3 py-2 text-xs font-black">恢复 100%</button><button type="button" onClick={() => setPreviewZoom((value) => Math.min(300, value + 25))} className="rounded-lg bg-blue-600 px-3 py-2 text-xs font-black">放大</button><button type="button" onClick={() => setExpandedPreview(null)} className="rounded-lg bg-rose-600 px-3 py-2 text-xs font-black">关闭</button></div>
      </div>
      <div className="mt-3 flex-1 overflow-auto rounded-xl bg-slate-900/70 p-3" onClick={(event) => event.stopPropagation()}><img src={expandedPreview.url} alt={`第 ${expandedPreview.pageNo} 页放大原图`} className="mx-auto h-auto max-w-none rounded-lg bg-white shadow-2xl" style={{ width: `${previewZoom}%` }} /></div>
    </div> : null}
  </div>;
}

export function AdminKnowledgeUploadPage({
  mode,
  token,
  onMessage,
}: {
  mode: KnowledgeUploadMode;
  token: string;
  onMessage: (message: string) => void;
}) {
  const expertMode = mode === 'expert';
  const [documents, setDocuments] = useState<AdminKnowledgeDocument[]>([]);
  const [catalogCompanies, setCatalogCompanies] = useState<string[]>([]);
  const [productSearchResults, setProductSearchResults] = useState<Array<{ company: string; productName: string; score: number }>>([]);
  const [productDropdownOpen, setProductDropdownOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [contributorName, setContributorName] = useState('');
  const [contributorRole, setContributorRole] = useState(expertMode ? '保险业务专家' : '');
  const [materialType, setMaterialType] = useState(expertMode ? '专家课程' : '产品介绍');
  const [materialUsages, setMaterialUsages] = useState<string[]>(['销售建议资料']);
  const [company, setCompany] = useState('');
  const [productName, setProductName] = useState('');
  const [productNames, setProductNames] = useState<string[]>([]);
  const [versionLabel, setVersionLabel] = useState('');
  const [focusTags, setFocusTags] = useState<string[]>([]);
  const [customTag, setCustomTag] = useState('');
  const [specialInstructions, setSpecialInstructions] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [textContent, setTextContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState('');
  const [documentActionErrors, setDocumentActionErrors] = useState<Record<string, string>>({});
  const [chunkBindingSelections, setChunkBindingSelections] = useState<Record<string, string>>({});
  const [chunkBusyId, setChunkBusyId] = useState('');
  const [activeTab, setActiveTab] = useState<KnowledgePageTab>('upload');
  const [expandedId, setExpandedId] = useState('');
  const [documentChunks, setDocumentChunks] = useState<Record<string, AdminKnowledgeChunk[]>>({});

  const filteredDocuments = useMemo(
    () => documents.filter((document) => expertMode
      ? document.sourceAuthority === 'expert_training'
      : document.sourceAuthority === 'company_material'),
    [documents, expertMode],
  );
  const companyOptions = useMemo(() => [...new Set([
    ...catalogCompanies,
    ...documents.map((document) => String(document.payload?.company || '')),
  ].map((item) => item.trim()).filter(Boolean))].sort((left, right) => left.localeCompare(right, 'zh-CN')), [catalogCompanies, documents]);

  async function loadDocuments() {
    setLoading(true);
    try {
      const payload = await getAdminKnowledgeDocuments(token, { includeReviewChunks: true });
      setDocuments(payload.documents);
      setDocumentChunks(Object.fromEntries(payload.documents.map((document) => [document.id, document.reviewChunks || []])));
      try {
        const catalog = await getAdminProductCatalogCompanies(token);
        setCatalogCompanies(catalog.companies);
      } catch {
        setCatalogCompanies([]);
      }
    } catch (error) {
      onMessage(error instanceof Error ? error.message : '资料读取失败');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setContributorRole(expertMode ? '保险业务专家' : '');
    setMaterialType(expertMode ? '专家课程' : '产品介绍');
    setMaterialUsages(['销售建议资料']);
    setFile(null);
    setTitle('');
    setTextContent('');
    setCompany('');
    setProductName('');
    setProductNames([]);
    setVersionLabel('');
    setFocusTags([]);
    setCustomTag('');
    setSpecialInstructions('');
    setSourceUrl('');
    void loadDocuments();
  }, [expertMode, token]);

  useEffect(() => {
    if (!token || (!company.trim() && productName.trim().length < 2)) {
      setProductSearchResults([]);
      return undefined;
    }
    let active = true;
    const timer = window.setTimeout(() => {
      void searchAdminProductCatalog(token, { company: company.trim(), query: productName.trim(), limit: 30 })
        .then((payload) => { if (active) setProductSearchResults(payload.products); })
        .catch(() => { if (active) setProductSearchResults([]); });
    }, 180);
    return () => { active = false; window.clearTimeout(timer); };
  }, [company, productName, token]);

  async function upload() {
    const resolvedProductNames = [...new Set([...productNames, productName.trim()].filter(Boolean))];
    if (!file && !textContent.trim() && !sourceUrl.trim()) {
      onMessage('请选择文件、填写资料链接，或粘贴一段文字资料');
      return;
    }
    if (materialUsages.some((item) => /责任指标/u.test(item)) && (!company.trim() || !resolvedProductNames.length)) {
      onMessage('产品责任指标补充资料必须选择或填写保险公司和至少一个产品名称');
      return;
    }
    if (!expertMode && !materialUsages.length) {
      onMessage('请至少选择一个资料用途');
      return;
    }
    if (file && file.size > 16 * 1024 * 1024) {
      onMessage('单个资料不能超过 16MB');
      return;
    }
    setLoading(true);
    try {
      const metadata = {
        libraryType: mode,
        contributorName: contributorName.trim(),
        contributorRole: contributorRole.trim(),
        title: title.trim(),
        materialType: materialType.trim(),
        materialUsages,
        company: company.trim(),
        productName: resolvedProductNames[0] || '',
        productNames: resolvedProductNames,
        versionLabel: versionLabel.trim(),
        focusTags,
        specialInstructions: specialInstructions.trim(),
      };
      let audio = false;
      const created = sourceUrl.trim()
        ? await uploadAdminKnowledgeDocumentFromUrl(token, { ...metadata, sourceUrl: sourceUrl.trim() })
        : await (async () => {
          const uploadFile = file || new File(
            [textContent.trim()],
            `${title.trim() || (expertMode ? '专家经验' : '公司产品资料')}.txt`,
            { type: 'text/plain' },
          );
          audio = AUDIO_EXTENSIONS.has(extensionOf(uploadFile.name));
          return uploadAdminKnowledgeDocument(token, {
            ...metadata,
            fileName: uploadFile.name,
            mediaType: uploadFile.type || 'application/octet-stream',
            dataBase64: await fileToBase64(uploadFile),
          });
        })();
      try {
        await processAdminKnowledgeDocument(token, created.document.id);
        onMessage(created.deduplicated ? '资料已存在，已重新检查解析状态' : '上传成功，已完成解析和切片');
      } catch (error) {
        if (audio && error instanceof ApiError && error.code === 'PRODUCT_DOCUMENT_TRANSCRIPTION_REQUIRED') {
          onMessage('语音已安全保存，当前等待转写服务处理');
        } else {
          onMessage(`资料已保存；${error instanceof Error ? error.message : '解析暂未完成'}`);
        }
      }
      setFile(null);
      setTextContent('');
      setTitle('');
      setProductName('');
      setProductNames([]);
      setFocusTags([]);
      setCustomTag('');
      setSpecialInstructions('');
      setSourceUrl('');
      await loadDocuments();
      setActiveTab('documents');
    } catch (error) {
      onMessage(error instanceof Error ? error.message : '资料上传失败');
    } finally {
      setLoading(false);
    }
  }

  async function processDocument(documentId: string) {
    setBusyId(documentId);
    try {
      await processAdminKnowledgeDocument(token, documentId);
      onMessage('资料已完成解析和切片');
    } catch (error) {
      onMessage(error instanceof Error ? error.message : '资料解析失败');
    } finally {
      setBusyId('');
      await loadDocuments();
    }
  }

  async function publishDocument(documentId: string) {
    setBusyId(documentId);
    setDocumentActionErrors((current) => ({ ...current, [documentId]: '' }));
    try {
      const result = await reviewAdminKnowledgeDocument(token, documentId, 'publish');
      onMessage(result.registeredKnowledgeRecords?.length
        ? `资料已发布，并已为 ${result.registeredKnowledgeRecords.length} 个产品登记责任与指标候选材料`
        : '资料已审核发布，可以被销售建议 RAG 检索使用');
    } catch (error) {
      const message = error instanceof Error ? error.message : '资料发布失败';
      setDocumentActionErrors((current) => ({ ...current, [documentId]: message }));
      onMessage(message);
    } finally {
      setBusyId('');
      await loadDocuments();
    }
  }

  async function updateChunkBinding(document: AdminKnowledgeDocument, chunk: AdminKnowledgeChunk, action: 'bind' | 'exclude') {
    const canonicalProductId = action === 'bind'
      ? chunkBindingSelections[chunk.id] || chunk.canonicalProductId || ''
      : '';
    if (action === 'bind' && !canonicalProductId) {
      setDocumentActionErrors((current) => ({ ...current, [document.id]: '请先为这个切片选择具体产品' }));
      return;
    }
    setChunkBusyId(chunk.id);
    setDocumentActionErrors((current) => ({ ...current, [document.id]: '' }));
    try {
      const result = await updateAdminKnowledgeChunkBinding(token, document.id, chunk.id, { action, canonicalProductId });
      onMessage(action === 'exclude'
        ? '该切片已排除，不会进入 RAG 检索'
        : `切片已绑定产品；当前${result.publishReadiness.decision === 'pass' ? '可以发布' : '仍有其他切片需要标注'}`);
      await loadDocuments();
    } catch (error) {
      const message = error instanceof Error ? error.message : '切片标注保存失败';
      setDocumentActionErrors((current) => ({ ...current, [document.id]: message }));
      onMessage(message);
    } finally {
      setChunkBusyId('');
    }
  }

  async function rejectDocument(documentId: string) {
    setBusyId(documentId);
    try {
      await reviewAdminKnowledgeDocument(token, documentId, 'reject');
      onMessage('资料已拒绝，不会进入 RAG 检索');
    } catch (error) {
      onMessage(error instanceof Error ? error.message : '资料拒绝失败');
    } finally {
      setBusyId('');
      await loadDocuments();
    }
  }

  async function changePublishedVersion(documentId: string, action: 'rollback' | 'unpublish') {
    setBusyId(documentId);
    try {
      await reviewAdminKnowledgeDocument(token, documentId, action);
      onMessage(action === 'rollback' ? '已回滚到上一RAG索引版本' : '当前RAG索引已下架');
    } catch (error) {
      onMessage(error instanceof Error ? error.message : action === 'rollback' ? '索引回滚失败' : '资料下架失败');
    } finally {
      setBusyId('');
      await loadDocuments();
    }
  }

  function toggleReviewDetail(documentId: string) {
    if (expandedId === documentId) {
      setExpandedId('');
      return;
    }
    setExpandedId(documentId);
  }

  const Icon = expertMode ? Mic2 : PackageSearch;
  const focusOptions = expertMode ? EXPERT_FOCUS_OPTIONS : COMPANY_FOCUS_OPTIONS;
  const materialTypes = expertMode ? EXPERT_MATERIAL_TYPES : COMPANY_MATERIAL_TYPES;
  const accept = expertMode
    ? '.mp3,.m4a,.wav,.aac,.flac,.pdf,.pptx,.docx,.txt,.md'
    : '.pdf,.pptx,.docx,.xlsx,.txt,.md';

  function toggleFocusTag(tag: string) {
    setFocusTags((current) => current.includes(tag)
      ? current.filter((item) => item !== tag)
      : [...current, tag]);
  }

  function toggleMaterialUsage(usage: string) {
    setMaterialUsages((current) => current.includes(usage)
      ? current.filter((item) => item !== usage)
      : [...current, usage]);
  }

  function addProductName(value = productName) {
    const name = value.trim();
    if (!name) return;
    setProductNames((current) => current.includes(name) ? current : [...current, name]);
    setProductName('');
    setProductDropdownOpen(false);
  }

  function addCustomTag() {
    const tag = customTag.trim();
    if (!tag) return;
    setFocusTags((current) => current.includes(tag) ? current : [...current, tag]);
    setCustomTag('');
  }

  return (
    <div className="max-w-6xl space-y-5">
      <div className="inline-flex rounded-2xl border border-slate-200 bg-white p-1 shadow-sm">
        <button type="button" onClick={() => setActiveTab('upload')} className={activeTab === 'upload' ? 'rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-black text-white' : 'rounded-xl px-5 py-2.5 text-sm font-black text-slate-500 hover:bg-slate-50'}>上传资料</button>
        <button type="button" onClick={() => setActiveTab('documents')} className={activeTab === 'documents' ? 'rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-black text-white' : 'rounded-xl px-5 py-2.5 text-sm font-black text-slate-500 hover:bg-slate-50'}>已上传资料 · 运营审核{filteredDocuments.length ? `（${filteredDocuments.length}）` : ''}</button>
      </div>

      {activeTab === 'upload' ? <section className="rounded-[22px] border border-slate-200 bg-white p-5 shadow-[0_18px_50px_-42px_rgba(15,23,42,0.45)]">
        <div className="flex items-start gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-blue-50 text-blue-700"><Icon size={21} /></div>
          <div>
            <h2 className="text-base font-black text-slate-950">{expertMode ? '上传保险专家 / 销冠知识' : '上传公司产品资料'}</h2>
            <p className="mt-1 text-sm font-medium text-slate-500">
              {expertMode
                ? '支持语音、PDF、PPTX、Word 和文字；语音先保存为待转写，其他文字型资料上传后自动解析切片。'
                : '支持 PDF、PPTX、Word、Excel 和文字；上传后自动识别文档结构、产品边界并切片，审核发布后才进入 RAG。'}
            </p>
          </div>
        </div>

        <div className="mt-5 grid gap-3 md:grid-cols-2">
          <input className="h-11 rounded-xl border border-slate-200 bg-slate-50 px-3 text-sm outline-none focus:border-blue-300 focus:bg-white" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="资料标题（选填）" />
          {expertMode ? (
            <div className="grid grid-cols-2 gap-3">
              <input className="h-11 rounded-xl border border-slate-200 bg-slate-50 px-3 text-sm outline-none focus:border-blue-300 focus:bg-white" value={contributorName} onChange={(event) => setContributorName(event.target.value)} placeholder="专家 / 销冠姓名" />
              <select className="h-11 rounded-xl border border-slate-200 bg-slate-50 px-3 text-sm outline-none focus:border-blue-300 focus:bg-white" value={contributorRole} onChange={(event) => setContributorRole(event.target.value)}>
                <option>保险业务专家</option>
                <option>销售冠军</option>
                <option>产品培训讲师</option>
              </select>
            </div>
          ) : <div />}
        </div>

        <div className="mt-4 rounded-2xl border border-blue-100 bg-blue-50/35 p-4">
          <div>
            <h3 className="text-sm font-black text-slate-900">上传标注</h3>
            <p className="mt-1 text-xs font-semibold text-slate-500">可以选择预设内容，也可以直接填写自己的分类和重点。</p>
          </div>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <label className="text-xs font-black text-slate-600">资料类型（可选择或自己写）
              <input list={`${mode}-material-types`} value={materialType} onChange={(event) => setMaterialType(event.target.value)} className="mt-1 h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-semibold outline-none focus:border-blue-300" />
              <datalist id={`${mode}-material-types`}>{materialTypes.map((item) => <option key={item} value={item} />)}</datalist>
            </label>
            {!expertMode ? <div className="text-xs font-black text-slate-600">资料用途（多选）
              <div className="mt-1 flex min-h-11 flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white px-2 py-1.5">
                {['销售建议资料', '产品责任指标补充资料'].map((usage) => <button key={usage} type="button" onClick={() => toggleMaterialUsage(usage)} className={materialUsages.includes(usage) ? 'rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-black text-white' : 'rounded-lg bg-slate-100 px-3 py-1.5 text-xs font-black text-slate-600'}>{usage}</button>)}
              </div>
            </div> : null}
            <label className="text-xs font-black text-slate-600">保险公司（选填）
              <input list={`${mode}-company-options`} value={company} onChange={(event) => { setCompany(event.target.value); setProductName(''); setProductNames([]); }} placeholder="选择或输入保险公司" className="mt-1 h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-semibold outline-none focus:border-blue-300" />
              <datalist id={`${mode}-company-options`}>{companyOptions.map((item) => <option key={item} value={item} />)}</datalist>
            </label>
            <div className="text-xs font-black text-slate-600">产品名称（多选 · 实时查库）
              <div className="relative mt-1 flex gap-2">
                <input value={productName} onFocus={() => setProductDropdownOpen(true)} onChange={(event) => { setProductName(event.target.value); setProductDropdownOpen(true); }} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addProductName(); } }} placeholder={company ? '输入产品名称，实时搜索数据库' : '先选公司，或输入至少两个字搜索'} className="h-11 min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 text-sm font-semibold outline-none focus:border-blue-300" />
                <button type="button" onClick={() => addProductName()} className="rounded-xl bg-blue-600 px-4 text-xs font-black text-white">添加</button>
                {productDropdownOpen && productSearchResults.length ? <div className="absolute left-0 right-20 top-12 z-30 max-h-64 overflow-y-auto rounded-xl border border-blue-100 bg-white p-1 shadow-xl">
                  {productSearchResults.map((item) => <button key={`${item.company}-${item.productName}`} type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => addProductName(item.productName)} className="block w-full rounded-lg px-3 py-2 text-left hover:bg-blue-50">
                    <span className="block text-sm font-black text-slate-800">{item.productName}</span>
                    <span className="mt-0.5 block text-[11px] font-semibold text-slate-400">{item.company}</span>
                  </button>)}
                </div> : null}
              </div>
              {productNames.length ? <div className="mt-2 flex flex-wrap gap-2">{productNames.map((name) => <button key={name} type="button" onClick={() => setProductNames((current) => current.filter((item) => item !== name))} className="rounded-full bg-blue-100 px-3 py-1.5 text-xs font-black text-blue-700">{name} ×</button>)}</div> : null}
            </div>
            <label className="text-xs font-black text-slate-600">产品版本（选填）
              <input value={versionLabel} onChange={(event) => setVersionLabel(event.target.value)} placeholder="例如：2026版、智享版" className="mt-1 h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-semibold outline-none focus:border-blue-300" />
            </label>
          </div>
          <div className="mt-4">
            <p className="text-xs font-black text-slate-600">重点标识（多选）</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {focusOptions.map((tag) => <button key={tag} type="button" onClick={() => toggleFocusTag(tag)} className={focusTags.includes(tag) ? 'rounded-full bg-blue-600 px-3 py-1.5 text-xs font-black text-white' : 'rounded-full border border-blue-100 bg-white px-3 py-1.5 text-xs font-black text-slate-600'}>{tag}</button>)}
              {focusTags.filter((tag) => !focusOptions.includes(tag)).map((tag) => <button key={tag} type="button" onClick={() => toggleFocusTag(tag)} className="rounded-full bg-violet-100 px-3 py-1.5 text-xs font-black text-violet-700">{tag} ×</button>)}
            </div>
            <div className="mt-2 flex gap-2">
              <input value={customTag} onChange={(event) => setCustomTag(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addCustomTag(); } }} placeholder="输入不在选择范围内的重点，按回车添加" className="h-10 min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-300" />
              <button type="button" onClick={addCustomTag} className="rounded-xl bg-violet-600 px-4 text-xs font-black text-white">添加</button>
            </div>
          </div>
          <label className="mt-4 block text-xs font-black text-slate-600">特别说明（可自由填写）
            <textarea value={specialInstructions} onChange={(event) => setSpecialInstructions(event.target.value)} placeholder="例如：重点提取客户担心流动性时的异议处理；涉及保险责任必须回查正式条款。" className="mt-1 min-h-24 w-full resize-y rounded-xl border border-slate-200 bg-white p-3 text-sm font-medium leading-6 outline-none focus:border-blue-300" />
          </label>
          <p className="mt-2 text-xs font-semibold text-amber-700">自定义标注用于指导检索和解析，不会被当作产品事实或条款证据。</p>
        </div>

        <label className="mt-3 block text-xs font-black text-slate-600">资料链接（可选）
          <input type="url" value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} placeholder="粘贴产品网页、PDF、PPTX或Word链接" className="mt-1 h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-semibold outline-none focus:border-blue-300" />
          <span className="mt-1 block text-xs font-semibold text-slate-400">填写链接时优先读取链接内容；链接会经过内网地址拦截和大小校验。</span>
        </label>

        <label className="mt-3 flex min-h-28 cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed border-blue-200 bg-blue-50/40 px-4 text-center transition hover:border-blue-400 hover:bg-blue-50">
          <FileUp className="text-blue-600" size={24} />
          <span className="mt-2 text-sm font-black text-blue-800">{file ? file.name : '点击选择资料文件'}</span>
          <span className="mt-1 text-xs font-semibold text-slate-500">单个文件不超过 16MB · {expertMode ? '语音 / PDF / PPTX / DOCX / TXT' : 'PDF / PPTX / DOCX / XLSX / TXT'}</span>
          <input className="sr-only" type="file" accept={accept} onChange={(event) => setFile(event.target.files?.[0] || null)} />
        </label>

        <div className="my-3 flex items-center gap-3 text-xs font-black text-slate-300"><span className="h-px flex-1 bg-slate-100" />或者直接粘贴文字<span className="h-px flex-1 bg-slate-100" /></div>
        <textarea className="min-h-32 w-full resize-y rounded-2xl border border-slate-200 bg-slate-50 p-3 text-sm leading-6 outline-none focus:border-blue-300 focus:bg-white" value={textContent} onChange={(event) => setTextContent(event.target.value)} placeholder={expertMode ? '粘贴专家经验、销售话术、异议处理方法或培训字幕……' : '粘贴公司产品介绍、产品优势、投保规则或销售支持资料……'} />
        <button type="button" disabled={loading || (!file && !textContent.trim() && !sourceUrl.trim())} onClick={() => void upload()} className="mt-4 flex h-11 w-full items-center justify-center rounded-xl bg-blue-600 text-sm font-black text-white transition hover:bg-blue-700 disabled:opacity-50">
          {loading ? '处理中…' : '上传并解析'}
        </button>
      </section> : null}

      {activeTab === 'documents' ? <section className="rounded-[22px] border border-slate-200 bg-white p-5 shadow-[0_18px_50px_-42px_rgba(15,23,42,0.45)]">
        <div className="flex items-center justify-between gap-3">
          <div><h2 className="text-base font-black text-slate-950">已上传资料</h2><p className="mt-1 text-xs font-semibold text-slate-400">{filteredDocuments.length} 份</p></div>
          <button type="button" disabled={loading} onClick={() => void loadDocuments()} className="rounded-xl bg-slate-100 px-3 py-2 text-xs font-black text-slate-600">刷新</button>
        </div>
        <div className="mt-4 space-y-3">
          {filteredDocuments.map((document) => {
            const status = statusInfo(document);
            const StatusIcon = status.icon;
            const pending = busyId === document.id;
            const quality = documentQuality(document);
            const chunkQuality = document.payload?.chunkQuality && typeof document.payload.chunkQuality === 'object'
              ? document.payload.chunkQuality as { blockedChunkCount?: number; reviewChunkCount?: number }
              : null;
            const failedChecks = quality?.checks.filter((check) => check.status === 'blocked' || check.status === 'warning') || [];
            const chunks = documentChunks[document.id] || [];
            const readyChunks = chunks.filter((chunk) => chunk.chunkType !== 'parent' && chunk.indexStatus === 'ready');
            const candidateChunks = chunks.filter((chunk) => chunk.chunkType !== 'parent');
            const abnormalChunks = chunks.filter((chunk) => chunk.indexStatus === 'blocked' || chunk.payload?.quality?.decision === 'review_required');
            const indexReview = document.indexReview;
            const hasCandidate = Boolean(indexReview?.candidateIndexVersion);
            const canReview = document.parseStatus === 'indexed_pending_review' && hasCandidate;
            const publishBlocker = document.publishReadiness?.decision === 'blocked'
              ? document.publishReadiness.blockingReasons[0]
              : null;
            const published = Boolean(indexReview?.activeIndexVersion);
            return (
              <article key={document.id} className="rounded-2xl border border-slate-100 bg-slate-50 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-black text-slate-900">{document.payload?.title || document.fileName}</p>
                    <p className="mt-1 text-xs font-semibold text-slate-500">{document.fileName} · {formatBytes(document.byteSize)}{document.payload?.contributorName ? ` · ${document.payload.contributorRole || '贡献者'}：${document.payload.contributorName}` : ''}</p>
                    {document.payload?.materialType || document.payload?.productName || document.payload?.productNames?.length ? <p className="mt-1 text-xs font-semibold text-blue-600">{[document.payload.materialType, ...(document.payload.materialUsages || []), document.payload.company, ...(document.payload.productNames?.length ? document.payload.productNames : [document.payload.productName]), document.payload.versionLabel].filter(Boolean).join(' · ')}</p> : null}
                    {document.payload?.focusTags?.length ? <div className="mt-2 flex flex-wrap gap-1.5">{document.payload.focusTags.map((tag) => <span key={tag} className="rounded-full bg-white px-2 py-1 text-[11px] font-black text-slate-500">{tag}</span>)}</div> : null}
                    {document.payload?.specialInstructions ? <p className="mt-2 rounded-lg border border-amber-100 bg-amber-50 px-2.5 py-2 text-[11px] font-semibold leading-5 text-amber-800">资料备注（非原文证据）：{document.payload.specialInstructions}</p> : null}
                  </div>
                  <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-black ${status.className}`}><StatusIcon size={13} />{status.label}</span>
                </div>
                {document.job?.errorMessage && document.parseStatus === 'parse_failed' ? <p className="mt-2 text-xs font-semibold text-rose-600">{document.job.errorMessage}</p> : null}
                {quality ? <div className={`mt-3 rounded-xl border px-3 py-2 ${quality.decision === 'pass' ? 'border-emerald-100 bg-emerald-50/60' : 'border-amber-200 bg-amber-50/70'}`}>
                  <p className="text-xs font-black text-slate-800">{qualityLabel(quality.decision)}</p>
                  <p className="mt-1 text-xs font-semibold text-slate-500">异常规则 {failedChecks.length} 项 · 隔离切片 {Number(chunkQuality?.blockedChunkCount || 0)} 个 · 待复核切片 {Number(chunkQuality?.reviewChunkCount || 0)} 个</p>
                  {failedChecks.slice(0, 3).map((check, index) => <p key={`${check.code || 'quality'}-${index}`} className="mt-1 text-xs font-semibold text-amber-800">• {check.message || check.code}</p>)}
                </div> : null}
                {hasCandidate ? <div className="mt-3 rounded-xl border border-violet-200 bg-violet-50/70 px-3 py-2">
                  <p className="text-xs font-black text-violet-800">候选RAG索引等待审核</p>
                  <p className="mt-1 text-xs font-semibold text-violet-700">新增 {indexReview?.diff?.added || 0} 个 · 删除 {indexReview?.diff?.removed || 0} 个 · 未变化 {indexReview?.diff?.unchanged || 0} 个</p>
                  {published ? <p className="mt-1 text-[11px] font-semibold text-violet-600">审核期间当前已发布版本继续提供检索，发布候选版本后才会原子切换。</p> : null}
                </div> : null}
                {documentActionErrors[document.id] || publishBlocker ? <div role="alert" className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700">
                  <p className="font-black">当前暂不能发布</p>
                  <p className="mt-1">{documentActionErrors[document.id] || `${publishBlocker?.message || '资料尚未满足发布条件'}${publishBlocker?.affectedCount ? `（影响 ${publishBlocker.affectedCount} 个切片）` : ''}，请先修正产品绑定后再发布。`}</p>
                </div> : null}
                <div className="mt-3 flex flex-wrap gap-2">
                  {['uploaded', 'parse_failed', 'reprocess_required', 'indexed_pending_review'].includes(document.parseStatus) ? <button type="button" disabled={pending} onClick={() => void processDocument(document.id)} className="inline-flex items-center gap-1 rounded-lg bg-blue-50 px-3 py-1.5 text-xs font-black text-blue-700"><RotateCcw size={13} />{pending ? '处理中' : '重新处理'}</button> : null}
                  {quality || canReview || published ? <button type="button" onClick={() => toggleReviewDetail(document.id)} className="inline-flex items-center gap-1 rounded-lg bg-slate-200 px-3 py-1.5 text-xs font-black text-slate-700">{expandedId === document.id ? <ChevronUp size={13} /> : <ChevronDown size={13} />}查看原图三栏对比审核</button> : null}
                  {canReview ? <button type="button" disabled={pending || Boolean(publishBlocker)} onClick={() => void publishDocument(document.id)} className="rounded-lg bg-emerald-50 px-3 py-1.5 text-xs font-black text-emerald-700 disabled:cursor-not-allowed disabled:opacity-50">{pending ? '处理中' : publishBlocker ? '暂不能发布' : '发布可用切片'}</button> : null}
                  {canReview ? <button type="button" disabled={pending} onClick={() => void rejectDocument(document.id)} className="inline-flex items-center gap-1 rounded-lg bg-rose-50 px-3 py-1.5 text-xs font-black text-rose-700"><XCircle size={13} />拒绝资料</button> : null}
                  {published ? <button type="button" disabled={pending} onClick={() => void changePublishedVersion(document.id, 'unpublish')} className="inline-flex items-center gap-1 rounded-lg bg-rose-50 px-3 py-1.5 text-xs font-black text-rose-700"><XCircle size={13} />下架RAG资料</button> : null}
                  {indexReview?.previousActiveIndexVersion ? <button type="button" disabled={pending} onClick={() => void changePublishedVersion(document.id, 'rollback')} className="inline-flex items-center gap-1 rounded-lg bg-amber-50 px-3 py-1.5 text-xs font-black text-amber-700"><RotateCcw size={13} />随时回滚上一版本</button> : null}
                </div>
                {expandedId === document.id ? <div className="mt-3 space-y-2 border-t border-slate-200 pt-3">
                  <PageReviewWorkbench document={document} chunks={chunks} token={token} onMessage={onMessage} onChanged={loadDocuments} />
                  <p className="text-xs font-black text-slate-700">规则检查</p>
                  {quality?.checks.map((check, index) => <div key={`${check.code || 'check'}-${index}`} className="flex gap-2 text-xs font-semibold">
                    <span className={check.status === 'passed' ? 'text-emerald-600' : check.status === 'blocked' ? 'text-rose-600' : 'text-amber-600'}>{check.status === 'passed' ? '通过' : check.status === 'blocked' ? '阻断' : '复核'}</span>
                    <span className="text-slate-600">{check.message || check.code}</span>
                  </div>)}
                  <div className="pt-3">
                    <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs font-black text-slate-700">切片产品标注与发布状态（可检索 {readyChunks.length} / 全部 {candidateChunks.length}）</p><button type="button" onClick={() => window.document.getElementById(`page-image-review-${document.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })} className="rounded-lg bg-violet-100 px-3 py-1.5 text-[11px] font-black text-violet-700">返回上方原图三栏对比</button></div>
                    <p className="mt-1 text-[11px] font-semibold text-slate-400">本区域仅用于产品绑定；审核内容请在上方原图、OCR、RAG切片三栏分页对比中完成。</p>
                  </div>
                  {candidateChunks.slice(0, 50).map((chunk) => {
                    const product = document.bindingProducts?.find((item) => item.canonicalProductId === chunk.canonicalProductId);
                    const manuallyExcluded = chunk.payload?.manualBinding && typeof chunk.payload.manualBinding === 'object'
                      && (chunk.payload.manualBinding as { action?: string }).action === 'exclude';
                    const qualityBlocked = chunk.indexStatus === 'blocked' && !manuallyExcluded;
                    const selectedProductId = chunkBindingSelections[chunk.id] ?? chunk.canonicalProductId ?? '';
                    const stateLabel = manuallyExcluded ? '人工已排除' : qualityBlocked ? '质量隔离' : chunk.canonicalProductId ? '可发布' : '未绑定产品';
                    return <div key={chunk.id} className={`rounded-xl border p-3 ${chunk.canonicalProductId && chunk.indexStatus === 'ready' ? 'border-blue-100 bg-blue-50/40' : 'border-amber-200 bg-amber-50/50'}`}>
                      <div className="flex flex-wrap items-center gap-2 text-[11px] font-black">
                        <span className="text-blue-700">第 {chunk.pageStart}{chunk.pageEnd !== chunk.pageStart ? `-${chunk.pageEnd}` : ''} 页</span>
                        <span className="text-slate-600">{chunk.chunkType === 'table' ? '表格切片' : '正文切片'}</span>
                        <span className={product ? 'text-emerald-700' : 'text-rose-700'}>产品：{product?.officialName || '未绑定'}</span>
                        <span className={stateLabel === '可发布' ? 'text-emerald-700' : stateLabel === '质量隔离' ? 'text-rose-700' : 'text-amber-700'}>状态：{stateLabel}</span>
                        {chunk.headingPath?.length ? <span className="text-violet-700">章节：{chunk.headingPath.join(' / ')}</span> : <span className="text-slate-400">章节：未识别</span>}
                        <span className="text-fuchsia-700">关键词：{chunkKeywords(chunk).join('、') || '待生成'}</span>
                      </div>
<RagChunkContent chunk={chunk} />
                      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-200 pt-3">
                        <select value={selectedProductId} disabled={qualityBlocked || chunkBusyId === chunk.id} onChange={(event) => setChunkBindingSelections((current) => ({ ...current, [chunk.id]: event.target.value }))} className="min-w-64 flex-1 rounded-lg border border-slate-200 bg-white px-2 py-2 text-xs font-semibold disabled:opacity-50">
                          <option value="">选择具体产品</option>
                          {(document.bindingProducts || []).map((item) => <option key={item.canonicalProductId} value={item.canonicalProductId}>{item.officialName}</option>)}
                        </select>
                        <button type="button" disabled={qualityBlocked || chunkBusyId === chunk.id || !selectedProductId} onClick={() => void updateChunkBinding(document, chunk, 'bind')} className="rounded-lg bg-blue-600 px-3 py-2 text-xs font-black text-white disabled:opacity-50">{chunkBusyId === chunk.id ? '保存中…' : chunk.canonicalProductId ? '更新产品标注' : '保存产品标注'}</button>
                        <button type="button" disabled={qualityBlocked || chunkBusyId === chunk.id} onClick={() => void updateChunkBinding(document, chunk, 'exclude')} className="rounded-lg bg-rose-50 px-3 py-2 text-xs font-black text-rose-700 disabled:opacity-50">排除本切片</button>
                      </div>
                    </div>;
                  })}
                  {candidateChunks.length > 50 ? <p className="text-xs font-semibold text-slate-400">当前展示前50个候选切片，共{candidateChunks.length}个。</p> : null}
                  {!readyChunks.length ? <p className="text-xs font-semibold text-rose-500">没有可供RAG检索的有效切片，不能发布。</p> : null}
                  <p className="pt-2 text-xs font-black text-slate-700">异常切片（{abnormalChunks.length}）</p>
                  {abnormalChunks.slice(0, 20).map((chunk) => <div key={chunk.id} className="rounded-xl border border-amber-100 bg-white p-3">
                    <p className="text-[11px] font-black text-amber-700">第 {chunk.pageStart}{chunk.pageEnd !== chunk.pageStart ? `-${chunk.pageEnd}` : ''} 页 · {chunk.indexStatus === 'blocked' ? '已隔离' : '待复核'}</p>
                    <p className="mt-1 line-clamp-4 whitespace-pre-wrap text-xs font-medium leading-5 text-slate-600">{chunk.content}</p>
                    {chunk.payload?.quality?.checks?.map((check, index) => <p key={`${check.code || 'chunk-check'}-${index}`} className="mt-1 text-[11px] font-semibold text-amber-700">• {check.message || check.code}</p>)}
                  </div>)}
                  {!abnormalChunks.length ? <p className="text-xs font-semibold text-slate-400">没有异常切片。</p> : null}
                </div> : null}
              </article>
            );
          })}
          {!filteredDocuments.length ? <p className="rounded-2xl bg-slate-50 px-4 py-10 text-center text-sm font-bold text-slate-400">还没有上传资料</p> : null}
        </div>
      </section> : null}
    </div>
  );
}
