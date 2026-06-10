import { useEffect, useState } from 'react';
import {
  CheckCircle2,
  ChevronLeft,
  FileText,
  LayoutDashboard,
  Pencil,
  Save,
  Trash2,
  UploadCloud,
  X,
} from 'lucide-react';
import type { FamilyMember, FamilyProfile } from '../../api/contracts/family';
import {
  FAMILY_MEMBER_RELATION_OPTIONS,
} from '../../shared/customer-policy-form';

export function FamilyProfileManager({
  familyProfiles,
  familyPolicyCounts,
  selectedFamilyId,
  onSelectFamily,
  onCreateFamily,
  onUpdateFamilyName,
  onDeleteFamily,
  onSetCoreMember,
  onUpdateFamilyMemberRelation,
  onBackToEntry,
  onOpenReport,
  onViewFamilyPolicies,
}: {
  familyProfiles: FamilyProfile[];
  familyPolicyCounts: Record<number, number>;
  selectedFamilyId: number | null;
  onSelectFamily: (familyId: number) => void;
  onCreateFamily: () => void;
  onUpdateFamilyName: (family: FamilyProfile, familyName: string) => Promise<FamilyProfile>;
  onDeleteFamily: (family: FamilyProfile) => Promise<void>;
  onSetCoreMember: (family: FamilyProfile, member: FamilyMember) => Promise<FamilyProfile>;
  onUpdateFamilyMemberRelation: (family: FamilyProfile, member: FamilyMember, relationLabel: string) => Promise<FamilyProfile>;
  onBackToEntry: () => void;
  onOpenReport: (familyId: number) => void;
  onViewFamilyPolicies: (familyId: number) => void;
}) {
  const families = Array.isArray(familyProfiles) ? familyProfiles : [];
  const [editingFamilyId, setEditingFamilyId] = useState<number | null>(null);
  const [familyNameDraft, setFamilyNameDraft] = useState('');
  const [deleteConfirmFamilyId, setDeleteConfirmFamilyId] = useState<number | null>(null);
  const [editingMessage, setEditingMessage] = useState('');
  const [editingBusy, setEditingBusy] = useState(false);
  const [deletingFamilyId, setDeletingFamilyId] = useState<number | null>(null);

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

  function toggleFamilyEditor(family: FamilyProfile) {
    const nextEditing = Number(editingFamilyId) === Number(family.id) ? null : family.id;
    onSelectFamily(family.id);
    setFamilyNameDraft(family.familyName || `家庭 ${family.id}`);
    setEditingFamilyId(nextEditing);
    setDeleteConfirmFamilyId(null);
    setEditingMessage('');
  }

  async function handleUpdateFamilyName(family: FamilyProfile) {
    const nextName = familyNameDraft.trim();
    if (!nextName) {
      setEditingMessage('家庭名称不能为空');
      return;
    }
    setEditingBusy(true);
    setEditingMessage('');
    try {
      const nextFamily = await onUpdateFamilyName(family, nextName);
      setFamilyNameDraft(nextFamily.familyName || nextName);
      setEditingMessage('家庭名称已保存');
    } catch (error) {
      setEditingMessage(error instanceof Error ? error.message : '保存家庭名称失败');
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
      setEditingMessage(`已设置核心成员：${member.name}`);
    } catch (error) {
      setEditingMessage(error instanceof Error ? error.message : '设置核心成员失败');
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
                    {hasPolicies ? `核心成员：${corePersonLabel(family)}` : '暂无家庭保单，录入后再展示成员和报告'}
                  </p>
                </div>
                {selected ? (
                  <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-blue-50 px-2.5 py-1 text-xs font-black text-blue-700 ring-1 ring-blue-100">
                    <CheckCircle2 size={14} />
                    当前选择
                  </span>
                ) : null}
              </div>

              {hasPolicies ? (
                <div className="mt-4 grid grid-cols-2 gap-3">
                  <div className="rounded-xl bg-slate-50 px-3 py-2">
                    <p className="text-xs font-black text-slate-400">成员数</p>
                    <p className="mt-1 text-xl font-black text-slate-950">{members.length}</p>
                  </div>
                  <div className="rounded-xl bg-slate-50 px-3 py-2">
                    <p className="text-xs font-black text-slate-400">核心成员</p>
                    <p className="mt-1 truncate text-sm font-black text-slate-950">{corePersonLabel(family)}</p>
                  </div>
                </div>
              ) : null}

              <div className={`mt-4 grid gap-2 ${hasPolicies ? 'grid-cols-2 sm:grid-cols-5' : 'grid-cols-2'}`}>
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
                    <button
                      type="button"
                      className="flex h-11 items-center justify-center gap-1.5 rounded-xl bg-slate-100 text-xs font-black text-slate-700"
                      onClick={() => toggleFamilyEditor(family)}
                    >
                      <Pencil size={16} />
                      {editing ? '收起编辑' : '编辑家庭'}
                    </button>
                  </>
                ) : null}
                {!hasPolicies ? (
                  <button
                    type="button"
                    className="flex h-11 items-center justify-center gap-1.5 rounded-xl bg-slate-100 text-xs font-black text-slate-700"
                    onClick={() => toggleFamilyEditor(family)}
                  >
                    <Pencil size={16} />
                    {editing ? '收起编辑' : '编辑家庭'}
                  </button>
                ) : null}
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
                    <div className="mt-2 flex gap-2">
                      <input
                        id={`family-name-${family.id}`}
                        value={familyNameDraft}
                        disabled={editingBusy}
                        onChange={(event) => setFamilyNameDraft(event.target.value)}
                        className="h-10 min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 text-sm font-bold text-slate-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 disabled:opacity-50"
                      />
                      <button
                        type="button"
                        className="flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-xl bg-blue-500 px-3 text-xs font-black text-white shadow-lg shadow-blue-500/20 disabled:opacity-50"
                        disabled={editingBusy || !familyNameDraft.trim()}
                        onClick={() => void handleUpdateFamilyName(family)}
                      >
                        <Save size={15} />
                        保存名称
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

                  {hasPolicies ? (
                    <div className="space-y-2">
                      <p className="px-1 text-xs font-black text-slate-400">管理成员</p>
                      {members.length ? members.map((member) => (
                        <div key={member.id} className="flex items-center justify-between gap-3 rounded-xl bg-white px-3 py-2">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-black text-slate-950">{member.name}</p>
                            {isCoreMember(family, member) ? (
                              <p className="mt-0.5 text-xs font-semibold text-slate-500">{member.relationLabel || '本人'}</p>
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
                          {isCoreMember(family, member) ? (
                            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-blue-50 px-2.5 py-1 text-xs font-black text-blue-700 ring-1 ring-blue-100">
                              <CheckCircle2 size={14} />
                              核心
                            </span>
                          ) : (
                            <button
                              type="button"
                              className="shrink-0 rounded-full bg-white px-3 py-1.5 text-xs font-black text-slate-700 ring-1 ring-slate-200 disabled:opacity-50"
                              disabled={editingBusy}
                              onClick={() => void handleSetCoreMember(family, member)}
                            >
                              设为核心
                            </button>
                          )}
                        </div>
                      )) : (
                        <p className="rounded-xl bg-white px-3 py-3 text-sm font-semibold text-slate-500">暂无成员</p>
                      )}
                    </div>
                  ) : null}

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
