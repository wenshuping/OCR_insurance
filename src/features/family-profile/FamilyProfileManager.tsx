import { type FormEvent, useEffect, useState } from 'react';
import {
  CheckCircle2,
  ChevronLeft,
  FileText,
  LayoutDashboard,
  MessageSquareText,
  Pencil,
  Save,
  Trash2,
  UploadCloud,
  UserPlus,
  X,
} from 'lucide-react';
import type { FamilyMember, FamilyProfile } from '../../api/contracts/family';
import {
  FAMILY_MEMBER_RELATION_OPTIONS,
  normalizeDateInputValue,
} from '../../shared/customer-policy-form';
import type { FamilyMemberPolicyReference } from '../../api/contracts/family';
import type { FamilyPlanningProfile } from '../../family-report-engine.mjs';

type MemberProfileDraft = {
  name: string;
  birthday: string;
  relationLabel: string;
};

const responsibilityFields: Array<{ key: keyof FamilyPlanningProfile; label: string; required?: boolean }> = [
  { key: 'annualIncome', label: '家庭年收入', required: true },
  { key: 'annualExpense', label: '家庭年必要支出', required: true },
  { key: 'debt', label: '家庭总负债', required: true },
  { key: 'educationGoal', label: '子女教育责任', required: true },
  { key: 'parentSupportGoal', label: '父母赡养责任', required: true },
  { key: 'availableAssets', label: '家庭现金储备' },
  { key: 'premiumBudget', label: '可接受年保费预算' },
];

function normalizePlanningProfile(profile?: FamilyPlanningProfile | null): FamilyPlanningProfile {
  return {
    annualIncome: Math.max(0, Number(profile?.annualIncome) || 0),
    annualExpense: Math.max(0, Number(profile?.annualExpense) || 0),
    debt: Math.max(0, Number(profile?.debt) || 0),
    educationGoal: Math.max(0, Number(profile?.educationGoal) || 0),
    parentSupportGoal: Math.max(0, Number(profile?.parentSupportGoal) || 0),
    retirementGoal: Math.max(0, Number(profile?.retirementGoal) || 0),
    availableAssets: Math.max(0, Number(profile?.availableAssets) || 0),
    premiumBudget: Math.max(0, Number(profile?.premiumBudget) || 0),
  };
}

function planningValueInWan(profile: FamilyPlanningProfile, key: keyof FamilyPlanningProfile) {
  const value = Number(profile[key] || 0);
  return value > 0 ? String(Number((value / 10000).toFixed(2))) : '';
}

function planningWithWanValue(profile: FamilyPlanningProfile, key: keyof FamilyPlanningProfile, value: string) {
  return {
    ...profile,
    [key]: Math.max(0, Number(value) || 0) * 10000,
  };
}

function normalizedDateDraft(value: string) {
  const normalized = normalizeDateInputValue(value);
  return normalized || value.trim();
}

export function FamilyProfileManager({
  familyProfiles,
  familyPolicyCounts,
  familyPolicyMemberIds,
  familyMemberPolicyRefs,
  selectedFamilyId,
  onSelectFamily,
  onCreateFamily,
  onCreateFamilyMember,
  onUpdateFamily,
  onDeleteFamily,
  onSetCoreMember,
  onUpdateFamilyMember,
  onUpdateFamilyMemberRelation,
  onDeleteFamilyMember,
  onBackToEntry,
  onOpenReport,
  onOpenSalesReview,
  onViewFamilyPolicies,
}: {
  familyProfiles: FamilyProfile[];
  familyPolicyCounts: Record<number, number>;
  familyPolicyMemberIds: Record<number, number[]>;
  familyMemberPolicyRefs: Record<number, Record<number, FamilyMemberPolicyReference[]>>;
  selectedFamilyId: number | null;
  onSelectFamily: (familyId: number) => void;
  onCreateFamily: () => void;
  onCreateFamilyMember: (family: FamilyProfile, input: { name: string; relationLabel: string; birthday?: string; notes?: string; setAsCore?: boolean }) => Promise<FamilyMember | null>;
  onUpdateFamily: (family: FamilyProfile, input: { familyName: string; notes?: string; planningProfile?: FamilyPlanningProfile | null }) => Promise<FamilyProfile>;
  onDeleteFamily: (family: FamilyProfile) => Promise<void>;
  onSetCoreMember: (family: FamilyProfile, member: FamilyMember) => Promise<FamilyProfile>;
  onUpdateFamilyMember: (family: FamilyProfile, member: FamilyMember, input: { name: string; birthday?: string; relationLabel?: string; notes?: string; syncBoundPolicies?: boolean }) => Promise<FamilyProfile>;
  onUpdateFamilyMemberRelation: (family: FamilyProfile, member: FamilyMember, relationLabel: string) => Promise<FamilyProfile>;
  onDeleteFamilyMember: (family: FamilyProfile, member: FamilyMember) => Promise<FamilyProfile>;
  onBackToEntry: () => void;
  onOpenReport: (familyId: number) => void;
  onOpenSalesReview: (familyId: number) => void;
  onViewFamilyPolicies: (familyId: number) => void;
}) {
  const families = Array.isArray(familyProfiles) ? familyProfiles : [];
  const [editingFamilyId, setEditingFamilyId] = useState<number | null>(null);
  const [familyNameDraft, setFamilyNameDraft] = useState('');
  const [familyNotesDraft, setFamilyNotesDraft] = useState('');
  const [familyPlanningDraft, setFamilyPlanningDraft] = useState<FamilyPlanningProfile>({});
  const [deleteConfirmFamilyId, setDeleteConfirmFamilyId] = useState<number | null>(null);
  const [editingMessage, setEditingMessage] = useState('');
  const [editingBusy, setEditingBusy] = useState(false);
  const [deletingFamilyId, setDeletingFamilyId] = useState<number | null>(null);
  const [memberNoteDrafts, setMemberNoteDrafts] = useState<Record<number, string>>({});
  const [editingMemberId, setEditingMemberId] = useState<number | null>(null);
  const [memberProfileDrafts, setMemberProfileDrafts] = useState<Record<number, MemberProfileDraft>>({});
  const [memberPolicySyncConfirmId, setMemberPolicySyncConfirmId] = useState<number | null>(null);
  const [deleteConfirmMemberId, setDeleteConfirmMemberId] = useState<number | null>(null);
  const [memberNameDraft, setMemberNameDraft] = useState('');
  const [memberRelationDraft, setMemberRelationDraft] = useState('待确认');
  const [memberBirthdayDraft, setMemberBirthdayDraft] = useState('');
  const [memberSetAsCore, setMemberSetAsCore] = useState(false);
  const [addingMember, setAddingMember] = useState(false);

  useEffect(() => {
    if (!editingFamilyId) return;
    if (!families.some((family) => Number(family.id) === Number(editingFamilyId))) {
      setEditingFamilyId(null);
    }
  }, [editingFamilyId, families]);

  function activeMembers(family: FamilyProfile) {
    const members = Array.isArray(family.members) ? family.members : [];
    return members.filter((member) => member.status === 'active');
  }

  function corePersonLabel(family: FamilyProfile) {
    const members = activeMembers(family);
    const coreMember = members.find((member) => Number(member.id) === Number(family.coreMemberId || 0));
    return coreMember?.name || '待设置';
  }

  function isCoreMember(family: FamilyProfile, member: FamilyMember) {
    return Number(member.id) === Number(family.coreMemberId || 0);
  }

  function editableRelationOptions(value: string) {
    const options = FAMILY_MEMBER_RELATION_OPTIONS.filter((relation) => relation !== '本人');
    return value && !options.includes(value) ? [value, ...options] : options;
  }

  function addMemberRelationOptions() {
    const options = FAMILY_MEMBER_RELATION_OPTIONS.filter((relation) => relation !== '本人');
    return memberSetAsCore ? ['本人', ...options] : options;
  }

  function policyBoundMemberIds(family: FamilyProfile) {
    return new Set((familyPolicyMemberIds[Number(family.id)] || []).map((id) => Number(id)).filter(Boolean));
  }

  function memberPolicyReferences(family: FamilyProfile, member: FamilyMember) {
    return familyMemberPolicyRefs[Number(family.id)]?.[Number(member.id)] || [];
  }

  function memberNotesFromFamily(family: FamilyProfile) {
    return Object.fromEntries(activeMembers(family).map((member) => [member.id, member.notes || '']));
  }

  function memberProfileDraftFromMember(member: FamilyMember): MemberProfileDraft {
    return {
      name: member.name || '',
      birthday: member.birthday || '',
      relationLabel: member.relationLabel || (member.role === 'core' ? '本人' : '待确认'),
    };
  }

  function memberProfilesFromFamily(family: FamilyProfile) {
    return Object.fromEntries(activeMembers(family).map((member) => [
      member.id,
      memberProfileDraftFromMember(member),
    ]));
  }

  function updateMemberNoteDraft(memberId: number, notes: string) {
    setMemberNoteDrafts((current) => ({ ...current, [memberId]: notes }));
  }

  function updateMemberProfileDraft(memberId: number, input: Partial<MemberProfileDraft>) {
    setMemberProfileDrafts((current) => ({
      ...current,
      [memberId]: {
        name: current[memberId]?.name || '',
        birthday: current[memberId]?.birthday || '',
        relationLabel: current[memberId]?.relationLabel || '待确认',
        ...input,
      },
    }));
  }

  function resetMemberDrafts() {
    setMemberNameDraft('');
    setMemberRelationDraft('待确认');
    setMemberBirthdayDraft('');
    setMemberSetAsCore(false);
  }

  function toggleFamilyEditor(family: FamilyProfile) {
    const nextEditing = Number(editingFamilyId) === Number(family.id) ? null : family.id;
    onSelectFamily(family.id);
    setFamilyNameDraft(family.familyName || `家庭 ${family.id}`);
    setFamilyNotesDraft(family.notes || '');
    setFamilyPlanningDraft(normalizePlanningProfile(family.planningProfile));
    setMemberNoteDrafts(memberNotesFromFamily(family));
    setMemberProfileDrafts(memberProfilesFromFamily(family));
    setEditingFamilyId(nextEditing);
    setDeleteConfirmFamilyId(null);
    setDeleteConfirmMemberId(null);
    setEditingMemberId(null);
    setMemberPolicySyncConfirmId(null);
    setEditingMessage('');
    resetMemberDrafts();
  }

  async function handleUpdateFamily(family: FamilyProfile) {
    const nextName = familyNameDraft.trim();
    if (!nextName) {
      setEditingMessage('家庭名称不能为空');
      return;
    }
    setEditingBusy(true);
    setEditingMessage('');
    try {
      const nextFamily = await onUpdateFamily(family, {
        familyName: nextName,
        notes: familyNotesDraft,
        planningProfile: familyPlanningDraft,
      });
      setFamilyNameDraft(nextFamily.familyName || nextName);
      setFamilyNotesDraft(nextFamily.notes || '');
      setFamilyPlanningDraft(normalizePlanningProfile(nextFamily.planningProfile));
      setEditingMessage('家庭档案已保存');
    } catch (error) {
      setEditingMessage(error instanceof Error ? error.message : '保存家庭档案失败');
    } finally {
      setEditingBusy(false);
    }
  }

  async function handleDeleteFamily(family: FamilyProfile) {
    setDeletingFamilyId(family.id);
    setEditingMessage('');
    try {
      await onDeleteFamily(family);
      setEditingFamilyId(null);
      setDeleteConfirmFamilyId(null);
    } catch (error) {
      setEditingMessage(error instanceof Error ? error.message : '删除家庭失败');
    } finally {
      setDeletingFamilyId(null);
    }
  }

  async function handleSetCoreMember(family: FamilyProfile, member: FamilyMember) {
    setEditingBusy(true);
    setEditingMessage('');
    try {
      await onSetCoreMember(family, member);
      setEditingMessage(`已设置顶梁柱：${member.name}`);
    } catch (error) {
      setEditingMessage(error instanceof Error ? error.message : '设置顶梁柱失败');
    } finally {
      setEditingBusy(false);
    }
  }

  async function handleUpdateFamilyMemberRelation(family: FamilyProfile, member: FamilyMember, relationLabel: string) {
    setEditingBusy(true);
    setEditingMessage('');
    try {
      await onUpdateFamilyMemberRelation(family, member, relationLabel);
      setEditingMessage(`已更新${member.name}的家庭关系`);
    } catch (error) {
      setEditingMessage(error instanceof Error ? error.message : '更新家庭关系失败');
    } finally {
      setEditingBusy(false);
    }
  }

  async function handleUpdateFamilyMember(
    family: FamilyProfile,
    member: FamilyMember,
    options: { syncBoundPolicies?: boolean } = {},
  ) {
    const draft = memberProfileDrafts[member.id] || memberProfileDraftFromMember(member);
    const name = draft.name.trim();
    if (!name) {
      setEditingMessage('成员姓名不能为空');
      return;
    }
    const core = isCoreMember(family, member);
    const birthday = draft.birthday.trim();
    const relationLabel = core ? '本人' : (draft.relationLabel || member.relationLabel || '待确认');
    const notes = memberNoteDrafts[member.id] ?? member.notes ?? '';
    const changed = (
      name !== String(member.name || '') ||
      birthday !== String(member.birthday || '') ||
      relationLabel !== String(member.relationLabel || (core ? '本人' : '待确认')) ||
      notes !== String(member.notes || '')
    );
    if (!changed) {
      setEditingMemberId(null);
      setMemberPolicySyncConfirmId(null);
      setEditingMessage('没有需要保存的修改');
      return;
    }
    const policyRefs = memberPolicyReferences(family, member);
    if (policyRefs.length && !options.syncBoundPolicies) {
      setMemberPolicySyncConfirmId(member.id);
      setEditingMessage(`修改会影响${policyRefs.length}张关联保单，请确认后同步。`);
      return;
    }
    setEditingBusy(true);
    setEditingMessage('');
    try {
      const nextFamily = await onUpdateFamilyMember(family, member, {
        name,
        birthday: birthday || undefined,
        relationLabel,
        notes,
        syncBoundPolicies: options.syncBoundPolicies === true,
      });
      setMemberProfileDrafts(memberProfilesFromFamily(nextFamily));
      setMemberNoteDrafts(memberNotesFromFamily(nextFamily));
      setEditingMemberId(null);
      setMemberPolicySyncConfirmId(null);
      setEditingMessage(options.syncBoundPolicies ? `已保存成员并同步关联保单：${name}` : `已保存成员：${name}`);
    } catch (error) {
      setEditingMessage(error instanceof Error ? error.message : '保存成员失败');
    } finally {
      setEditingBusy(false);
    }
  }

  async function handleDeleteFamilyMember(family: FamilyProfile, member: FamilyMember) {
    setEditingBusy(true);
    setEditingMessage('');
    try {
      const nextFamily = await onDeleteFamilyMember(family, member);
      setMemberNoteDrafts(memberNotesFromFamily(nextFamily));
      setMemberProfileDrafts(memberProfilesFromFamily(nextFamily));
      setDeleteConfirmMemberId(null);
      setEditingMemberId(null);
      setMemberPolicySyncConfirmId(null);
      setEditingMessage(`已删除成员：${member.name}`);
    } catch (error) {
      setEditingMessage(error instanceof Error ? error.message : '删除成员失败');
    } finally {
      setEditingBusy(false);
    }
  }

  async function handleAddFamilyMember(event: FormEvent<HTMLFormElement>, family: FamilyProfile) {
    event.preventDefault();
    const name = memberNameDraft.trim();
    if (!name) {
      setEditingMessage('成员姓名不能为空');
      return;
    }
    setEditingBusy(true);
    setAddingMember(true);
    setEditingMessage('');
    try {
      const member = await onCreateFamilyMember(family, {
        name,
        relationLabel: memberSetAsCore ? '本人' : memberRelationDraft,
        birthday: memberBirthdayDraft.trim() || undefined,
        setAsCore: memberSetAsCore,
      });
      resetMemberDrafts();
      setEditingMessage(member ? `已添加成员：${member.name}` : '成员已添加');
    } catch (error) {
      setEditingMessage(error instanceof Error ? error.message : '添加成员失败');
    } finally {
      setAddingMember(false);
      setEditingBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 pb-28">
      <header className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-100 bg-white/90 px-4 py-4 backdrop-blur">
        <button
          type="button"
          className="flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 text-slate-600 transition-colors hover:bg-slate-200"
          onClick={onBackToEntry}
          aria-label="返回录入保单"
        >
          <ChevronLeft size={20} />
        </button>
        <h1 className="text-lg font-black text-slate-950">家庭列表</h1>
        <button
          type="button"
          className="rounded-full bg-blue-500 px-3 py-2 text-xs font-black text-white shadow-lg shadow-blue-500/20"
          onClick={onCreateFamily}
        >
          新建家庭档案
        </button>
      </header>

      <main className="mx-auto w-full max-w-3xl space-y-3 p-4">
        {families.length ? families.map((family) => {
          const members = activeMembers(family);
          const boundMemberIds = policyBoundMemberIds(family);
          const policyCount = Number(familyPolicyCounts[Number(family.id)] || 0);
          const hasPolicies = policyCount > 0;
          const selected = Number(family.id) === Number(selectedFamilyId);
          const editing = Number(family.id) === Number(editingFamilyId);
          return (
            <section
              key={family.id}
              className={`rounded-2xl border bg-white p-4 shadow-[0_16px_32px_-28px_rgba(15,23,42,0.18)] ${
                selected ? 'border-blue-200 ring-2 ring-blue-100' : 'border-slate-200'
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="truncate text-lg font-black text-slate-950">{family.familyName || `家庭 ${family.id}`}</h2>
                  <p className="mt-1 text-sm font-semibold text-slate-500">
                    {hasPolicies ? `家庭顶梁柱：${corePersonLabel(family)}` : '暂无家庭保单，可先维护成员或录入保单'}
                  </p>
                </div>
                {selected ? (
                  <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-blue-50 px-2.5 py-1 text-xs font-black text-blue-700 ring-1 ring-blue-100">
                    <CheckCircle2 size={14} />
                    当前选择
                  </span>
                ) : null}
              </div>

              <div className="mt-4 grid grid-cols-2 gap-3">
                <div className="rounded-xl bg-slate-50 px-3 py-2">
                  <p className="text-xs font-black text-slate-400">成员数</p>
                  <p className="mt-1 text-xl font-black text-slate-950">{members.length}</p>
                </div>
                <div className="rounded-xl bg-slate-50 px-3 py-2">
                  <p className="text-xs font-black text-slate-400">顶梁柱</p>
                  <p className="mt-1 truncate text-sm font-black text-slate-950">{corePersonLabel(family)}</p>
                </div>
              </div>

              <div className={`mt-4 grid gap-2 ${hasPolicies ? 'grid-cols-2 sm:grid-cols-6' : 'grid-cols-2'}`}>
                {hasPolicies ? (
                  <>
                    <button
                      type="button"
                      className="flex h-11 items-center justify-center gap-1.5 rounded-xl bg-blue-500 text-xs font-black text-white shadow-lg shadow-blue-500/20"
                      onClick={() => onOpenReport(family.id)}
                    >
                      <LayoutDashboard size={16} />
                      查看报告
                    </button>
                    <button
                      type="button"
                      className="flex h-11 items-center justify-center gap-1.5 rounded-xl bg-sky-50 text-xs font-black text-sky-700 ring-1 ring-sky-100"
                      onClick={() => onViewFamilyPolicies(family.id)}
                    >
                      <FileText size={16} />
                      家庭保单
                    </button>
                  </>
                ) : null}
                {hasPolicies || members.length ? (
                  <button
                    type="button"
                    className="flex h-11 items-center justify-center gap-1.5 rounded-xl bg-amber-50 text-xs font-black text-amber-700 ring-1 ring-amber-100"
                    onClick={() => onOpenSalesReview(family.id)}
                  >
                    <MessageSquareText size={16} />
                    销售建议
                  </button>
                ) : null}
                <button
                  type="button"
                  className="flex h-11 items-center justify-center gap-1.5 rounded-xl bg-slate-100 text-xs font-black text-slate-700"
                  onClick={() => toggleFamilyEditor(family)}
                >
                  <Pencil size={16} />
                  {editing ? '收起编辑' : '编辑家庭'}
                </button>
                <button
                  type="button"
                  className="flex h-11 items-center justify-center gap-1.5 rounded-xl bg-rose-50 text-xs font-black text-rose-700 ring-1 ring-rose-100 disabled:opacity-50"
                  disabled={deletingFamilyId === family.id}
                  onClick={() => {
                    onSelectFamily(family.id);
                    setFamilyNameDraft(family.familyName || `家庭 ${family.id}`);
                    setEditingFamilyId(family.id);
                    setDeleteConfirmFamilyId(family.id);
                    setEditingMessage('');
                  }}
                >
                  <Trash2 size={16} />
                  删除家庭
                </button>
                <button
                  type="button"
                  className={`flex h-11 items-center justify-center gap-1.5 rounded-xl bg-emerald-50 text-xs font-black text-emerald-700 ring-1 ring-emerald-100 ${
                    hasPolicies ? '' : 'col-span-2'
                  }`}
                  onClick={() => {
                    onSelectFamily(family.id);
                    onBackToEntry();
                  }}
                >
                  <UploadCloud size={16} />
                  {hasPolicies ? '录入保单' : '录入第一张保单'}
                </button>
              </div>

              {editing ? (
                <div className="mt-4 space-y-3 rounded-2xl border border-slate-200 bg-slate-50 p-3">
                  <div className="rounded-xl bg-white p-3">
                    <label className="text-xs font-black text-slate-400" htmlFor={`family-name-${family.id}`}>家庭名称</label>
                    <input
                      id={`family-name-${family.id}`}
                      value={familyNameDraft}
                      disabled={editingBusy}
                      onChange={(event) => setFamilyNameDraft(event.target.value)}
                      className="mt-2 h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-bold text-slate-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 disabled:opacity-50"
                    />
                    <label className="mt-3 block text-xs font-black text-slate-400" htmlFor={`family-notes-${family.id}`}>家庭备注</label>
                    <textarea
                      id={`family-notes-${family.id}`}
                      value={familyNotesDraft}
                      disabled={editingBusy}
                      onChange={(event) => setFamilyNotesDraft(event.target.value)}
                      className="mt-2 min-h-24 w-full resize-y rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold leading-5 text-slate-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 disabled:opacity-50"
                      placeholder="工作、收入、喜好、家庭目标、沟通记录"
                    />
                    <div className="mt-4 rounded-2xl border border-blue-100 bg-blue-50/40 p-3">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <p className="text-xs font-black text-blue-500">编辑家庭责任</p>
                          <h4 className="mt-1 text-sm font-black text-slate-900">家庭责任信息</h4>
                          <p className="mt-1 text-xs font-semibold leading-5 text-slate-500">
                            保障分析报告和销售建议共用这些信息；未填写时，报告会把对应缺口标记为待补充核实。
                          </p>
                        </div>
                        <span className="rounded-full bg-white px-2.5 py-1 text-[11px] font-black text-blue-600 ring-1 ring-blue-100">
                          已填 {responsibilityFields.filter((field) => Number(familyPlanningDraft[field.key] || 0) > 0).length}/{responsibilityFields.length}
                        </span>
                      </div>
                      <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                        {responsibilityFields.map((field) => (
                          <label key={field.key} className="block rounded-xl border border-slate-200 bg-white px-3 py-2.5">
                            <span className="text-[11px] font-black text-slate-400">
                              {field.label}(万元){field.required ? <span className="text-blue-500"> *</span> : null}
                            </span>
                            <input
                              type="number"
                              min="0"
                              inputMode="decimal"
                              value={planningValueInWan(familyPlanningDraft, field.key)}
                              disabled={editingBusy}
                              onChange={(event) => setFamilyPlanningDraft((current) => planningWithWanValue(current, field.key, event.target.value))}
                              className="mt-1 h-8 w-full bg-transparent text-sm font-black text-slate-900 outline-none disabled:opacity-50"
                              placeholder="0"
                            />
                          </label>
                        ))}
                      </div>
                    </div>
                    <div className="mt-2 flex justify-end">
                      <button
                        type="button"
                        className="flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-xl bg-blue-500 px-3 text-xs font-black text-white shadow-lg shadow-blue-500/20 disabled:opacity-50"
                        disabled={editingBusy || !familyNameDraft.trim()}
                        onClick={() => void handleUpdateFamily(family)}
                      >
                        <Save size={15} />
                        保存家庭
                      </button>
                    </div>
                  </div>

                  {deleteConfirmFamilyId === family.id ? (
                    <div className="rounded-xl border border-rose-100 bg-rose-50 p-3">
                      <p className="text-sm font-black text-rose-900">确认删除 {family.familyName || `家庭 ${family.id}`}？</p>
                      <p className="mt-1 text-xs font-semibold leading-5 text-rose-700">删除后会清空该家庭下保单的家庭关系，保单本身保留。</p>
                      <div className="mt-3 grid grid-cols-2 gap-2">
                        <button
                          type="button"
                          className="flex h-10 items-center justify-center gap-1.5 rounded-xl bg-white text-xs font-black text-slate-700 ring-1 ring-slate-200"
                          disabled={deletingFamilyId === family.id}
                          onClick={() => setDeleteConfirmFamilyId(null)}
                        >
                          <X size={15} />
                          取消
                        </button>
                        <button
                          type="button"
                          className="flex h-10 items-center justify-center gap-1.5 rounded-xl bg-rose-600 text-xs font-black text-white disabled:opacity-50"
                          disabled={deletingFamilyId === family.id}
                          onClick={() => void handleDeleteFamily(family)}
                        >
                          <Trash2 size={15} />
                          {deletingFamilyId === family.id ? '删除中' : '确认删除'}
                        </button>
                      </div>
                    </div>
                  ) : null}

                  <div className="space-y-2">
                    <p className="px-1 text-xs font-black text-slate-400">管理成员</p>
                    <form className="space-y-2 rounded-xl bg-white p-3" onSubmit={(event) => void handleAddFamilyMember(event, family)}>
                      <div className="grid gap-2 sm:grid-cols-[1fr_0.8fr_0.8fr]">
                        <label className="block">
                          <span className="mb-1 block text-xs font-black text-slate-400">成员姓名</span>
                          <input
                            value={memberNameDraft}
                            disabled={editingBusy || addingMember}
                            onChange={(event) => setMemberNameDraft(event.target.value)}
                            className="h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-bold text-slate-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 disabled:opacity-50"
                            placeholder="请输入姓名"
                          />
                        </label>
                        <label className="block">
                          <span className="mb-1 block text-xs font-black text-slate-400">与顶梁柱的关系</span>
                          <select
                            value={memberSetAsCore ? '本人' : memberRelationDraft}
                            disabled={editingBusy || addingMember || memberSetAsCore}
                            onChange={(event) => setMemberRelationDraft(event.target.value)}
                            className="h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-bold text-slate-700 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 disabled:opacity-50"
                          >
                            {addMemberRelationOptions().map((relation) => (
                              <option key={relation} value={relation}>{relation}</option>
                            ))}
                          </select>
                        </label>
                        <label className="block">
                          <span className="mb-1 block text-xs font-black text-slate-400">出生日期</span>
                          <input
                            type="text"
                            inputMode="numeric"
                            value={memberBirthdayDraft}
                            disabled={editingBusy || addingMember}
                            onChange={(event) => setMemberBirthdayDraft(event.target.value)}
                            onBlur={() => setMemberBirthdayDraft(normalizedDateDraft(memberBirthdayDraft))}
                            placeholder="yyyy/mm/dd"
                            autoComplete="off"
                            pattern="[0-9./年-]*"
                            className="h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-bold text-slate-700 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 disabled:opacity-50"
                          />
                        </label>
                      </div>
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                        {!family.coreMemberId ? (
                          <label className="inline-flex items-center gap-2 text-xs font-bold text-slate-600">
                            <input
                              type="checkbox"
                              checked={memberSetAsCore}
                              disabled={editingBusy || addingMember}
                              onChange={(event) => setMemberSetAsCore(event.target.checked)}
                              className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                            />
                            设为顶梁柱
                          </label>
                        ) : (
                          <p className="text-xs font-semibold text-slate-400">顶梁柱已存在，可继续添加家庭成员。</p>
                        )}
                        <button
                          type="submit"
                          className="flex h-10 items-center justify-center gap-1.5 rounded-xl bg-blue-500 px-4 text-xs font-black text-white shadow-lg shadow-blue-500/20 disabled:opacity-50"
                          disabled={editingBusy || addingMember || !memberNameDraft.trim()}
                        >
                          <UserPlus size={15} />
                          {addingMember ? '添加中' : '添加成员'}
                        </button>
                      </div>
                    </form>
                    {members.length ? members.map((member) => {
                      const core = isCoreMember(family, member);
                      const policyRefs = memberPolicyReferences(family, member);
                      const policyBound = boundMemberIds.has(Number(member.id)) || policyRefs.length > 0;
                      const memberNoteDraft = memberNoteDrafts[member.id] ?? member.notes ?? '';
                      const profileDraft = memberProfileDrafts[member.id] || memberProfileDraftFromMember(member);
                      const editingMember = Number(editingMemberId) === Number(member.id);
                      const confirmingDelete = Number(deleteConfirmMemberId) === Number(member.id);
                      const confirmingPolicySync = Number(memberPolicySyncConfirmId) === Number(member.id) && policyRefs.length > 0;
                      return (
                        <div key={member.id} className="rounded-xl bg-white p-3">
                          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                            <div className="min-w-0 flex-1">
                              {editingMember ? (
                                <div className="grid gap-2 sm:grid-cols-[1fr_0.75fr_0.9fr]">
                                  <label className="block">
                                    <span className="mb-1 block text-xs font-black text-slate-400">成员姓名</span>
                                    <input
                                      value={profileDraft.name}
                                      disabled={editingBusy}
                                      onChange={(event) => updateMemberProfileDraft(member.id, { name: event.target.value })}
                                      className="h-9 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 text-sm font-bold text-slate-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 disabled:opacity-50"
                                    />
                                  </label>
                                  <label className="block">
                                    <span className="mb-1 block text-xs font-black text-slate-400">出生日期</span>
                                    <input
                                      type="text"
                                      inputMode="numeric"
                                      value={profileDraft.birthday}
                                      disabled={editingBusy}
                                      onChange={(event) => updateMemberProfileDraft(member.id, { birthday: event.target.value })}
                                      onBlur={() => updateMemberProfileDraft(member.id, { birthday: normalizedDateDraft(profileDraft.birthday) })}
                                      placeholder="yyyy/mm/dd"
                                      autoComplete="off"
                                      pattern="[0-9./年-]*"
                                      className="h-9 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 text-sm font-bold text-slate-700 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 disabled:opacity-50"
                                    />
                                  </label>
                                  <label className="block">
                                    <span className="mb-1 block text-xs font-black text-slate-400">与顶梁柱的关系</span>
                                    <select
                                      value={core ? '本人' : (profileDraft.relationLabel || member.relationLabel || '待确认')}
                                      disabled={editingBusy || core}
                                      onChange={(event) => updateMemberProfileDraft(member.id, { relationLabel: event.target.value })}
                                      className="h-9 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 text-sm font-bold text-slate-700 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 disabled:opacity-50"
                                    >
                                      {(core ? ['本人'] : editableRelationOptions(profileDraft.relationLabel || member.relationLabel || '待确认')).map((relation) => (
                                        <option key={relation} value={relation}>{relation}</option>
                                      ))}
                                    </select>
                                  </label>
                                </div>
                              ) : (
                                <>
                                  <p className="truncate text-sm font-black text-slate-950">{member.name}</p>
                                  {member.birthday ? <p className="mt-0.5 text-xs font-semibold text-slate-400">{member.birthday}</p> : null}
                                </>
                              )}
                              {policyBound ? (
                                <>
                                  {!editingMember ? (
                                    <p className="mt-1 text-xs font-semibold text-slate-500">{member.relationLabel || (core ? '本人' : '待确认')}</p>
                                  ) : null}
                                  <p className="mt-0.5 text-[11px] font-semibold text-slate-400">由保单扫描生成；修改姓名、生日或关系会提示同步关联保单</p>
                                </>
                              ) : core ? (
                                <p className="mt-1 text-xs font-semibold text-slate-500">{member.relationLabel || '本人'}</p>
                              ) : (
                                <select
                                  aria-label={`设置${member.name}家庭关系`}
                                  value={member.relationLabel || '待确认'}
                                  disabled={editingBusy}
                                  onChange={(event) => void handleUpdateFamilyMemberRelation(family, member, event.target.value)}
                                  className="mt-1 h-8 rounded-lg border border-slate-200 bg-slate-50 px-2 text-xs font-bold text-slate-600 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 disabled:opacity-50"
                                >
                                  {editableRelationOptions(member.relationLabel || '待确认').map((relation) => (
                                    <option key={relation} value={relation}>{relation}</option>
                                  ))}
                                </select>
                              )}
                            </div>
                            <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
                              {core ? (
                                <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2.5 py-1 text-xs font-black text-blue-700 ring-1 ring-blue-100">
                                  <CheckCircle2 size={14} />
                                  顶梁柱
                                </span>
                              ) : null}
                              {policyBound ? (
                                <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-black text-slate-500">保单成员</span>
                              ) : null}
                              {!core ? (
                                <button
                                  type="button"
                                  className="rounded-full bg-white px-3 py-1.5 text-xs font-black text-slate-700 ring-1 ring-slate-200 disabled:opacity-50"
                                  disabled={editingBusy}
                                  onClick={() => void handleSetCoreMember(family, member)}
                                >
                                  设为顶梁柱
                                </button>
                              ) : null}
                              {editingMember ? (
                                <>
                                  <button
                                    type="button"
                                    className="rounded-full bg-blue-500 px-3 py-1.5 text-xs font-black text-white shadow-lg shadow-blue-500/20 disabled:opacity-50"
                                    disabled={editingBusy || !profileDraft.name.trim()}
                                    onClick={() => void handleUpdateFamilyMember(family, member)}
                                  >
                                    保存
                                  </button>
                                  <button
                                    type="button"
                                    className="rounded-full bg-white px-3 py-1.5 text-xs font-black text-slate-600 ring-1 ring-slate-200 disabled:opacity-50"
                                    disabled={editingBusy}
                                    onClick={() => {
                                      updateMemberProfileDraft(member.id, memberProfileDraftFromMember(member));
                                      setEditingMemberId(null);
                                      setMemberPolicySyncConfirmId(null);
                                    }}
                                  >
                                    取消
                                  </button>
                                </>
                              ) : (
                                <button
                                  type="button"
                                  className="rounded-full bg-blue-500 px-3 py-1.5 text-xs font-black text-white shadow-lg shadow-blue-500/20 disabled:opacity-50"
                                  disabled={editingBusy}
                                  onClick={() => {
                                    setEditingMemberId(member.id);
                                    setDeleteConfirmMemberId(null);
                                    setMemberPolicySyncConfirmId(null);
                                    updateMemberProfileDraft(member.id, memberProfileDraftFromMember(member));
                                  }}
                                >
                                  编辑
                                </button>
                              )}
                              <button
                                type="button"
                                className="rounded-full bg-rose-50 px-3 py-1.5 text-xs font-black text-rose-700 ring-1 ring-rose-100 disabled:opacity-50"
                                disabled={editingBusy}
                                onClick={() => {
                                  setDeleteConfirmMemberId(member.id);
                                  setEditingMemberId(null);
                                  setMemberPolicySyncConfirmId(null);
                                }}
                              >
                                删除
                              </button>
                            </div>
                          </div>
                          {confirmingPolicySync ? (
                            <div className="mt-3 rounded-xl border border-amber-100 bg-amber-50 p-3">
                              <p className="text-xs font-black text-amber-900">将同步以下保单</p>
                              <div className="mt-2 divide-y divide-amber-100">
                                {policyRefs.map((policy) => (
                                  <div key={policy.id} className="py-2 first:pt-0 last:pb-0">
                                    <p className="truncate text-xs font-black text-slate-900">
                                      {policy.company || '未知公司'} · {policy.name || '未命名保单'}
                                    </p>
                                    <p className="mt-0.5 text-[11px] font-semibold text-amber-800">
                                      {policy.roles.join('、')} · 投保人 {policy.applicant || '未填写'} · 被保人 {policy.insured || '未填写'}
                                    </p>
                                  </div>
                                ))}
                              </div>
                              <div className="mt-3 flex gap-2">
                                <button
                                  type="button"
                                  className="flex h-9 flex-1 items-center justify-center rounded-xl bg-white text-xs font-black text-slate-700 ring-1 ring-slate-200 disabled:opacity-50"
                                  disabled={editingBusy}
                                  onClick={() => setMemberPolicySyncConfirmId(null)}
                                >
                                  取消同步
                                </button>
                                <button
                                  type="button"
                                  className="flex h-9 flex-1 items-center justify-center rounded-xl bg-amber-500 text-xs font-black text-white disabled:opacity-50"
                                  disabled={editingBusy || !profileDraft.name.trim()}
                                  onClick={() => void handleUpdateFamilyMember(family, member, { syncBoundPolicies: true })}
                                >
                                  确认并同步
                                </button>
                              </div>
                            </div>
                          ) : null}
                          {confirmingDelete ? (
                            <div className="mt-3 rounded-xl border border-rose-100 bg-rose-50 p-3">
                              <p className="text-xs font-black text-rose-900">确认删除成员 {member.name}？</p>
                              <p className="mt-1 text-xs font-semibold leading-5 text-rose-700">关联保单会保留，但需要重新确认家庭成员绑定。</p>
                              <div className="mt-2 flex gap-2">
                                <button
                                  type="button"
                                  className="flex h-9 flex-1 items-center justify-center rounded-xl bg-white text-xs font-black text-slate-700 ring-1 ring-slate-200"
                                  disabled={editingBusy}
                                  onClick={() => setDeleteConfirmMemberId(null)}
                                >
                                  取消
                                </button>
                                <button
                                  type="button"
                                  className="flex h-9 flex-1 items-center justify-center rounded-xl bg-rose-600 text-xs font-black text-white disabled:opacity-50"
                                  disabled={editingBusy}
                                  onClick={() => void handleDeleteFamilyMember(family, member)}
                                >
                                  确认删除
                                </button>
                              </div>
                            </div>
                          ) : null}
                          {editingMember ? (
                            <label className="mt-3 block" htmlFor={`member-notes-${family.id}-${member.id}`}>
                              <span className="mb-1 block text-xs font-black text-slate-400">成员备注</span>
                              <textarea
                                id={`member-notes-${family.id}-${member.id}`}
                                value={memberNoteDraft}
                                disabled={editingBusy}
                                onChange={(event) => updateMemberNoteDraft(member.id, event.target.value)}
                                className="min-h-20 w-full resize-y rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold leading-5 text-slate-800 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 disabled:opacity-50"
                                placeholder="工作、收入、喜好、健康关注、沟通记录"
                              />
                            </label>
                          ) : member.notes ? (
                            <div className="mt-3 rounded-xl bg-slate-50 px-3 py-2">
                              <p className="text-xs font-black text-slate-400">成员备注</p>
                              <p className="mt-1 whitespace-pre-wrap text-xs font-semibold leading-5 text-slate-600">{member.notes}</p>
                            </div>
                          ) : null}
                        </div>
                      );
                    }) : (
                      <p className="rounded-xl bg-white px-3 py-3 text-sm font-semibold text-slate-500">暂无成员</p>
                    )}
                  </div>

                  {editingMessage ? <p className="text-xs font-bold text-slate-500">{editingMessage}</p> : null}
                </div>
              ) : null}
            </section>
          );
        }) : (
          <section className="rounded-2xl border border-dashed border-slate-300 bg-white px-5 py-10 text-center">
            <p className="text-base font-black text-slate-950">暂无家庭档案</p>
            <p className="mt-2 text-sm leading-6 text-slate-500">新建后可把成员和保单归入同一个家庭。</p>
            <button
              type="button"
              className="mt-5 rounded-xl bg-blue-500 px-5 py-3 text-sm font-black text-white shadow-lg shadow-blue-500/20"
              onClick={onCreateFamily}
            >
              新建家庭档案
            </button>
          </section>
        )}
      </main>
    </div>
  );
}

export type FamilyProfileManagerProps = Parameters<typeof FamilyProfileManager>[0];
