import { FileText, LayoutDashboard, MessageSquareText, Users } from 'lucide-react';
import type { AdminUserFamiliesResponse, AdminUserFamilySummary, AdminUserSummary } from '../../../api';
import { formatDateLabel, maskMobile } from '../../../shared/formatters';

export function AdminUsersPage({
  users,
  selectedUserId,
  familiesPayload,
  loadingFamilies,
  onSelectUser,
  onOpenFamilyReport,
  onViewFamilyPolicies,
  onOpenSalesReview,
}: {
  users: AdminUserSummary[];
  selectedUserId: number | null;
  familiesPayload: AdminUserFamiliesResponse | null;
  loadingFamilies: boolean;
  onSelectUser: (userId: number) => void;
  onOpenFamilyReport: (familyId: number) => void;
  onViewFamilyPolicies: (familyId: number) => void;
  onOpenSalesReview: (familyId: number) => void;
}) {
  const selectedUser = users.find((user) => Number(user.id) === Number(selectedUserId)) || null;
  const families = familiesPayload?.families || [];
  return (
    <div className="grid grid-cols-[360px_minmax(0,1fr)] gap-5 max-[1100px]:grid-cols-1">
      <section className="rounded-[18px] border border-slate-200 bg-white p-4 shadow-[0_20px_60px_-46px_rgba(15,23,42,0.42)]">
        <div className="mb-4 flex items-center justify-between gap-3 border-b border-slate-100 pb-3">
          <div>
            <h2 className="text-base font-black text-slate-950">用户列表</h2>
            <p className="mt-1 text-xs font-semibold text-slate-500">选择用户后查看家庭列表</p>
          </div>
          <span className="rounded-full bg-blue-50 px-2.5 py-1 text-xs font-black text-blue-700">{users.length}</span>
        </div>
        <div className="max-h-[calc(100vh-190px)] space-y-2 overflow-auto pr-1">
          {users.map((user) => {
            const active = Number(user.id) === Number(selectedUserId);
            return (
              <button
                key={user.id}
                type="button"
                onClick={() => onSelectUser(Number(user.id))}
                className={[
                  'w-full rounded-[14px] border px-3 py-3 text-left transition',
                  active ? 'border-blue-600 bg-blue-600 text-white shadow-lg shadow-blue-500/20' : 'border-blue-50 bg-blue-50/60 text-slate-950 hover:border-blue-200 hover:bg-white',
                ].join(' ')}
              >
                <p className="font-mono text-lg font-black leading-none">{user.mobile || '未绑定手机号'}</p>
                <div className="mt-3 grid grid-cols-3 gap-2 text-xs font-black">
                  <span className={active ? 'text-white/70' : 'text-slate-500'}>{user.familyCount || 0} 家庭</span>
                  <span className={active ? 'text-white/70' : 'text-slate-500'}>{user.policyCount || 0} 保单</span>
                  <span className={active ? 'text-white/70' : 'text-slate-500'}>{user.insuredCount || 0} 被保人</span>
                </div>
              </button>
            );
          })}
          {!users.length ? <p className="rounded-xl bg-slate-50 px-3 py-8 text-center text-sm font-bold text-slate-400">没有匹配的用户</p> : null}
        </div>
      </section>

      <section className="min-w-0 rounded-[18px] border border-slate-200 bg-white p-4 shadow-[0_20px_60px_-46px_rgba(15,23,42,0.42)]">
        <div className="mb-4 flex items-start justify-between gap-3 border-b border-slate-100 pb-3">
          <div className="min-w-0">
            <h2 className="truncate text-base font-black text-slate-950">家庭列表</h2>
            <p className="mt-1 text-xs font-semibold text-slate-500">
              {selectedUser ? `${maskMobile(selectedUser.mobile)} 的家庭档案，只读查看` : '请先选择左侧用户'}
            </p>
          </div>
          {loadingFamilies ? <span className="rounded-full bg-blue-50 px-2.5 py-1 text-xs font-black text-blue-700">读取中</span> : null}
        </div>
        <div className="space-y-3">
          {families.map((family) => (
            <AdminFamilyCard
              key={family.id}
              family={family}
              onOpenFamilyReport={onOpenFamilyReport}
              onViewFamilyPolicies={onViewFamilyPolicies}
              onOpenSalesReview={onOpenSalesReview}
            />
          ))}
          {selectedUser && !loadingFamilies && !families.length ? (
            <p className="rounded-xl bg-slate-50 px-3 py-12 text-center text-sm font-bold text-slate-400">该用户暂无家庭档案</p>
          ) : null}
          {!selectedUser ? (
            <div className="flex min-h-[320px] items-center justify-center rounded-xl bg-slate-50 text-center text-sm font-bold text-slate-400">
              <div>
                <Users className="mx-auto mb-2 h-7 w-7" />
                从用户列表选择一个用户
              </div>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function AdminFamilyCard({
  family,
  onOpenFamilyReport,
  onViewFamilyPolicies,
  onOpenSalesReview,
}: {
  family: AdminUserFamilySummary;
  onOpenFamilyReport: (familyId: number) => void;
  onViewFamilyPolicies: (familyId: number) => void;
  onOpenSalesReview: (familyId: number) => void;
}) {
  const hasPolicies = Number(family.policyCount || 0) > 0;
  return (
    <article className="rounded-[16px] border border-slate-200 bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-lg font-black text-slate-950">{family.familyName || `家庭 ${family.id}`}</h3>
          <p className="mt-1 text-sm font-semibold text-slate-500">家庭顶梁柱：{family.coreMemberName || '待设置'}</p>
        </div>
        {family.latestPolicyAt ? <span className="shrink-0 rounded-full bg-blue-50 px-2.5 py-1 text-xs font-black text-blue-700">{formatDateLabel(family.latestPolicyAt)}</span> : null}
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3">
        <div className="rounded-xl bg-blue-50/60 px-3 py-2">
          <p className="text-xs font-black text-blue-400">成员数</p>
          <p className="mt-1 text-xl font-black text-slate-950">{family.memberCount || 0}</p>
        </div>
        <div className="rounded-xl bg-blue-50/60 px-3 py-2">
          <p className="text-xs font-black text-blue-400">保单数</p>
          <p className="mt-1 text-xl font-black text-slate-950">{family.policyCount || 0}</p>
        </div>
      </div>
      <div className="mt-4 grid grid-cols-3 gap-2 max-[760px]:grid-cols-1">
        <button
          type="button"
          className="flex h-11 items-center justify-center gap-1.5 rounded-xl bg-blue-600 text-xs font-black text-white shadow-lg shadow-blue-500/20 transition hover:bg-blue-700 disabled:opacity-50"
          disabled={!hasPolicies}
          onClick={() => onOpenFamilyReport(family.id)}
        >
          <LayoutDashboard size={16} />
          查看报告
        </button>
        <button
          type="button"
          className="flex h-11 items-center justify-center gap-1.5 rounded-xl bg-blue-50 text-xs font-black text-blue-700 ring-1 ring-blue-100 transition hover:bg-blue-100 disabled:opacity-50"
          disabled={!hasPolicies}
          onClick={() => onViewFamilyPolicies(family.id)}
        >
          <FileText size={16} />
          家庭保单
        </button>
        <button
          type="button"
          className="flex h-11 items-center justify-center gap-1.5 rounded-xl bg-blue-50 text-xs font-black text-blue-700 ring-1 ring-blue-100 transition hover:bg-blue-100"
          onClick={() => onOpenSalesReview(family.id)}
        >
          <MessageSquareText size={16} />
          销售建议
        </button>
      </div>
    </article>
  );
}
