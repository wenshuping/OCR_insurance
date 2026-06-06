import { UploadCloud, Users } from 'lucide-react';

export type CustomerTab = 'entry' | 'families';

export function CustomerBottomTabs({
  activeTab,
  onChange,
  fixed = true,
}: {
  activeTab: CustomerTab;
  onChange: (tab: CustomerTab) => void;
  fixed?: boolean;
}) {
  const tabs: Array<{ key: CustomerTab; label: string; icon: typeof UploadCloud }> = [
    { key: 'entry', label: '录入保单', icon: UploadCloud },
    { key: 'families', label: '家庭保单', icon: Users },
  ];
  return (
    <nav className={fixed ? 'pb-safe fixed bottom-0 left-0 right-0 z-40 border-t border-slate-100 bg-white px-4 pt-2 shadow-[0_-10px_20px_-12px_rgba(15,23,42,0.12)]' : ''}>
      <div className="grid grid-cols-2 gap-2">
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
      </div>
    </nav>
  );
}
