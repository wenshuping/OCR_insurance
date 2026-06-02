import {
  FileText,
  LayoutDashboard,
  UploadCloud,
  Users,
} from 'lucide-react';

export type CustomerTab = 'entry' | 'policies' | 'families';

export function CustomerBottomTabs({
  activeTab,
  onChange,
  onOpenReport,
  fixed = true,
}: {
  activeTab: CustomerTab;
  onChange: (tab: CustomerTab) => void;
  onOpenReport?: () => void;
  fixed?: boolean;
}) {
  const tabs: Array<{ key: CustomerTab; label: string; icon: typeof UploadCloud }> = [
    { key: 'entry', label: '录入保单', icon: UploadCloud },
    { key: 'policies', label: '我的保单', icon: FileText },
    { key: 'families', label: '家庭档案', icon: Users },
  ];
  return (
    <nav className={fixed ? 'pb-safe fixed bottom-0 left-0 right-0 z-40 border-t border-slate-100 bg-white px-4 pt-2 shadow-[0_-10px_20px_-12px_rgba(15,23,42,0.12)]' : ''}>
      <div className={`grid gap-2 ${onOpenReport ? 'grid-cols-4' : 'grid-cols-3'}`}>
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const active = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => onChange(tab.key)}
              className={`flex h-12 items-center justify-center gap-1.5 rounded-2xl text-xs font-black transition sm:text-sm ${
                active ? 'bg-blue-500 text-white shadow-lg shadow-blue-500/20' : 'bg-slate-50 text-slate-500'
              }`}
            >
              <Icon size={18} />
              {tab.label}
            </button>
          );
        })}
        {onOpenReport ? (
          <button
            type="button"
            onClick={onOpenReport}
            className="flex h-12 items-center justify-center gap-1.5 rounded-2xl bg-blue-50 text-xs font-black text-blue-600 ring-1 ring-blue-100 transition hover:bg-blue-100 active:bg-blue-100 sm:text-sm"
            aria-label="查看家庭保障分析报告"
          >
            <LayoutDashboard size={18} />
            查看报告
          </button>
        ) : null}
      </div>
    </nav>
  );
}
