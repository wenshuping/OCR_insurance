import { useEffect, useState } from 'react';
import {
  CheckCircle2,
  ChevronLeft,
  LayoutDashboard,
  Pencil,
  UploadCloud,
} from 'lucide-react';
import type { FamilyMember, FamilyProfile } from '../../api/contracts/family';
import {
  FAMILY_MEMBER_RELATION_OPTIONS,
} from '../../shared/customer-policy-form';

export function FamilyProfileManager({
  familyProfiles,
  selectedFamilyId,
  onSelectFamily,
  onCreateFamily,
  onSetCoreMember,
  onUpdateFamilyMemberRelation,
  onBackToEntry,
  onOpenReport,
}: {
  familyProfiles: FamilyProfile[];
  selectedFamilyId: number | null;
  onSelectFamily: (familyId: number) => void;
  onCreateFamily: (familyName: string) => Promise<void>;
  onSetCoreMember: (family: FamilyProfile, member: FamilyMember) => Promise<FamilyProfile>;
  onUpdateFamilyMemberRelation: (family: FamilyProfile, member: FamilyMember, relationLabel: string) => Promise<FamilyProfile>;
  onBackToEntry: () => void;
  onOpenReport: (familyId: number) => void;
}) {
  const families = Array.isArray(familyProfiles) ? familyProfiles : [];
  const [editingFamilyId, setEditingFamilyId] = useState<number | null>(null);
  const [editingMessage, setEditingMessage] = useState('');
  const [editingBusy, setEditingBusy] = useState(false);

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
    return coreMember?.name || members[0]?.name || '待设置';
  }

  function isCoreMember(family: FamilyProfile, member: FamilyMember) {
    return Number(member.id) === Number(family.coreMemberId || 0);
  }

  function editableRelationOptions(value: string) {
    const options = FAMILY_MEMBER_RELATION_OPTIONS.filter((relation) => relation !== '本人');
    return value && !options.includes(value) ? [value, ...options] : options;
  }

  async function handleCreateFamily() {
    const familyName = window.prompt('请输入家庭档案名称', '默认家庭')?.trim();
    if (!familyName) return;
    await onCreateFamily(familyName);
  }

  function toggleFamilyEditor(family: FamilyProfile) {
    const nextEditing = Number(editingFamilyId) === Number(family.id) ? null : family.id;
    onSelectFamily(family.id);
    setEditingFamilyId(nextEditing);
    setEditingMessage('');
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
        <h1 className="text-lg font-black text-slate-950">家庭档案列表</h1>
        <button
          type="button"
          className="rounded-full bg-blue-500 px-3 py-2 text-xs font-black text-white shadow-lg shadow-blue-500/20"
          onClick={() => void handleCreateFamily()}
        >
          新建家庭档案
        </button>
      </header>

      <main className="mx-auto w-full max-w-3xl space-y-3 p-4">
        {families.length ? families.map((family) => {
          const members = activeMembers(family);
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
                  <p className="mt-1 text-sm font-semibold text-slate-500">核心成员：{corePersonLabel(family)}</p>
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
                  <p className="text-xs font-black text-slate-400">核心成员</p>
                  <p className="mt-1 truncate text-sm font-black text-slate-950">{corePersonLabel(family)}</p>
                </div>
              </div>

              <div className="mt-4 grid grid-cols-3 gap-2">
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
                  className="flex h-11 items-center justify-center gap-1.5 rounded-xl bg-slate-100 text-xs font-black text-slate-700"
                  onClick={() => toggleFamilyEditor(family)}
                >
                  <Pencil size={16} />
                  {editing ? '收起管理' : '管理成员'}
                </button>
                <button
                  type="button"
                  className="flex h-11 items-center justify-center gap-1.5 rounded-xl bg-emerald-50 text-xs font-black text-emerald-700 ring-1 ring-emerald-100"
                  onClick={() => {
                    onSelectFamily(family.id);
                    onBackToEntry();
                  }}
                >
                  <UploadCloud size={16} />
                  录入保单
                </button>
              </div>

              {editing ? (
                <div className="mt-4 space-y-3 rounded-2xl border border-slate-200 bg-slate-50 p-3">
                  <div className="space-y-2">
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
              onClick={() => void handleCreateFamily()}
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
