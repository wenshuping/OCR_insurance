import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, Clock3, FileUp, Mic2, PackageSearch, RotateCcw, XCircle } from 'lucide-react';

import {
  ApiError,
  type AdminKnowledgeChunk,
  type AdminKnowledgeDocument,
  getAdminProductCatalogCompanies,
  getAdminKnowledgeDocuments,
  processAdminKnowledgeDocument,
  reviewAdminKnowledgeDocument,
  searchAdminProductCatalog,
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
  if (decision === 'pass') return '文档质检通过';
  if (decision === 'review_required') return '文档需要人工复核';
  if (decision === 'reprocess_required') return '文档需要重新处理';
  return '等待文档质检';
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
    try {
      const result = await reviewAdminKnowledgeDocument(token, documentId, 'publish');
      onMessage(result.registeredKnowledgeRecords?.length
        ? `资料已发布，并已为 ${result.registeredKnowledgeRecords.length} 个产品登记责任与指标候选材料`
        : '资料已审核发布，可以被销售建议 RAG 检索使用');
    } catch (error) {
      onMessage(error instanceof Error ? error.message : '资料发布失败');
    } finally {
      setBusyId('');
      await loadDocuments();
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
            const abnormalChunks = chunks.filter((chunk) => chunk.indexStatus === 'blocked' || chunk.payload?.quality?.decision === 'review_required');
            const indexReview = document.indexReview;
            const hasCandidate = Boolean(indexReview?.candidateIndexVersion);
            const canReview = document.parseStatus === 'indexed_pending_review' && hasCandidate;
            const published = Boolean(indexReview?.activeIndexVersion);
            return (
              <article key={document.id} className="rounded-2xl border border-slate-100 bg-slate-50 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-black text-slate-900">{document.payload?.title || document.fileName}</p>
                    <p className="mt-1 text-xs font-semibold text-slate-500">{document.fileName} · {formatBytes(document.byteSize)}{document.payload?.contributorName ? ` · ${document.payload.contributorRole || '贡献者'}：${document.payload.contributorName}` : ''}</p>
                    {document.payload?.materialType || document.payload?.productName || document.payload?.productNames?.length ? <p className="mt-1 text-xs font-semibold text-blue-600">{[document.payload.materialType, ...(document.payload.materialUsages || []), document.payload.company, ...(document.payload.productNames?.length ? document.payload.productNames : [document.payload.productName]), document.payload.versionLabel].filter(Boolean).join(' · ')}</p> : null}
                    {document.payload?.focusTags?.length ? <div className="mt-2 flex flex-wrap gap-1.5">{document.payload.focusTags.map((tag) => <span key={tag} className="rounded-full bg-white px-2 py-1 text-[11px] font-black text-slate-500">{tag}</span>)}</div> : null}
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
                <div className="mt-3 flex flex-wrap gap-2">
                  {['uploaded', 'parse_failed', 'reprocess_required'].includes(document.parseStatus) ? <button type="button" disabled={pending} onClick={() => void processDocument(document.id)} className="inline-flex items-center gap-1 rounded-lg bg-blue-50 px-3 py-1.5 text-xs font-black text-blue-700"><RotateCcw size={13} />{pending ? '处理中' : '重新处理'}</button> : null}
                  {quality || canReview || published ? <button type="button" onClick={() => toggleReviewDetail(document.id)} className="inline-flex items-center gap-1 rounded-lg bg-slate-200 px-3 py-1.5 text-xs font-black text-slate-700">{expandedId === document.id ? <ChevronUp size={13} /> : <ChevronDown size={13} />}查看质检与RAG内容</button> : null}
                  {canReview ? <button type="button" disabled={pending} onClick={() => void publishDocument(document.id)} className="rounded-lg bg-emerald-50 px-3 py-1.5 text-xs font-black text-emerald-700">{pending ? '处理中' : '发布可用切片'}</button> : null}
                  {canReview ? <button type="button" disabled={pending} onClick={() => void rejectDocument(document.id)} className="inline-flex items-center gap-1 rounded-lg bg-rose-50 px-3 py-1.5 text-xs font-black text-rose-700"><XCircle size={13} />拒绝资料</button> : null}
                  {published ? <button type="button" disabled={pending} onClick={() => void changePublishedVersion(document.id, 'unpublish')} className="inline-flex items-center gap-1 rounded-lg bg-rose-50 px-3 py-1.5 text-xs font-black text-rose-700"><XCircle size={13} />下架RAG资料</button> : null}
                  {indexReview?.previousActiveIndexVersion ? <button type="button" disabled={pending} onClick={() => void changePublishedVersion(document.id, 'rollback')} className="inline-flex items-center gap-1 rounded-lg bg-amber-50 px-3 py-1.5 text-xs font-black text-amber-700"><RotateCcw size={13} />回滚上一版本</button> : null}
                </div>
                {expandedId === document.id ? <div className="mt-3 space-y-2 border-t border-slate-200 pt-3">
                  <p className="text-xs font-black text-slate-700">规则检查</p>
                  {quality?.checks.map((check, index) => <div key={`${check.code || 'check'}-${index}`} className="flex gap-2 text-xs font-semibold">
                    <span className={check.status === 'passed' ? 'text-emerald-600' : check.status === 'blocked' ? 'text-rose-600' : 'text-amber-600'}>{check.status === 'passed' ? '通过' : check.status === 'blocked' ? '阻断' : '复核'}</span>
                    <span className="text-slate-600">{check.message || check.code}</span>
                  </div>)}
                  <div className="pt-3">
                    <p className="text-xs font-black text-slate-700">RAG可检索内容（{readyChunks.length}）</p>
                    <p className="mt-1 text-[11px] font-semibold text-slate-400">以下内容是发布后问答检索实际可召回的证据切片；请核对产品、版本、章节、页码和正文是否一致。</p>
                  </div>
                  {readyChunks.slice(0, 50).map((chunk) => <div key={chunk.id} className="rounded-xl border border-blue-100 bg-blue-50/40 p-3">
                    <div className="flex flex-wrap items-center gap-2 text-[11px] font-black text-blue-700">
                      <span>第 {chunk.pageStart}{chunk.pageEnd !== chunk.pageStart ? `-${chunk.pageEnd}` : ''} 页</span>
                      <span>{chunk.chunkType === 'table' ? '表格证据' : '正文证据'}</span>
                      {chunk.headingPath?.length ? <span>章节：{chunk.headingPath.join(' / ')}</span> : null}
                    </div>
                    <RagChunkContent chunk={chunk} />
                  </div>)}
                  {readyChunks.length > 50 ? <p className="text-xs font-semibold text-slate-400">当前展示前50个可检索切片，共{readyChunks.length}个。</p> : null}
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
