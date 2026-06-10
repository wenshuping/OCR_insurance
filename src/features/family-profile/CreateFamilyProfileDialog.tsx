import {
  type FormEvent,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  Loader2,
  UsersRound,
  X,
} from 'lucide-react';

const FAMILY_NAME_PRESETS = ['我的家庭', '父母家庭', '孩子家庭'];

export function CreateFamilyProfileDialog(props: {
  loading: boolean;
  message: string;
  open: boolean;
  onClose: () => void;
  onSubmit: (familyName: string) => Promise<void>;
}) {
  const { loading, message, open, onClose, onSubmit } = props;
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [familyName, setFamilyName] = useState('');
  const [touched, setTouched] = useState(false);
  const normalizedFamilyName = familyName.trim();

  useEffect(() => {
    if (!open) return;
    setFamilyName('');
    setTouched(false);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  if (!open) return null;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTouched(true);
    if (!normalizedFamilyName || loading) return;
    await onSubmit(normalizedFamilyName);
  }

  return (
    <div className="fixed inset-0 z-[85] flex items-end bg-slate-950/35 px-4 pb-4 sm:items-center sm:justify-center" role="dialog" aria-modal="true" aria-labelledby="create-family-profile-title">
      <form className="w-full overflow-hidden rounded-[24px] bg-white shadow-2xl sm:max-w-md" onSubmit={handleSubmit}>
        <div className="bg-gradient-to-br from-slate-900 via-blue-700 to-cyan-500 p-5 text-white">
          <div className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-white/15 ring-1 ring-white/20">
                <UsersRound size={24} />
              </div>
              <div className="min-w-0">
                <p className="text-xs font-bold uppercase text-white/65">Family Profile</p>
                <h2 id="create-family-profile-title" className="mt-1 text-xl font-black leading-tight">新建家庭档案</h2>
              </div>
            </div>
            <button
              aria-label="关闭新建家庭档案"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/15 text-white transition-colors hover:bg-white/25 disabled:opacity-50"
              disabled={loading}
              type="button"
              onClick={onClose}
            >
              <X size={18} />
            </button>
          </div>
        </div>

        <div className="space-y-4 p-5">
          <label className="block">
            <span className="mb-1.5 block text-xs font-black text-slate-500">家庭名称</span>
            <input
              ref={inputRef}
              value={familyName}
              onChange={(event) => setFamilyName(event.target.value)}
              maxLength={24}
              placeholder="例如：温舒萍家庭"
              className="h-12 w-full rounded-xl border border-slate-200 bg-white px-4 text-base font-bold text-slate-950 outline-none transition focus:border-blue-500 focus:ring-4 focus:ring-blue-100"
            />
          </label>

          <div className="flex flex-wrap gap-2" aria-label="家庭名称快捷选项">
            {FAMILY_NAME_PRESETS.map((preset) => (
              <button
                key={preset}
                className="rounded-full bg-slate-100 px-3 py-1.5 text-xs font-black text-slate-600 transition-colors hover:bg-blue-50 hover:text-blue-700 disabled:opacity-50"
                disabled={loading}
                type="button"
                onClick={() => setFamilyName(preset)}
              >
                {preset}
              </button>
            ))}
          </div>

          {touched && !normalizedFamilyName ? (
            <p className="rounded-xl bg-red-50 px-3 py-2 text-xs font-bold text-red-600 ring-1 ring-red-100">请先输入家庭名称</p>
          ) : message ? (
            <p className="rounded-xl bg-blue-50 px-3 py-2 text-xs font-bold leading-5 text-blue-700 ring-1 ring-blue-100">{message}</p>
          ) : null}

          <div className="grid grid-cols-[0.42fr_0.58fr] gap-2">
            <button
              className="flex h-12 items-center justify-center rounded-xl border border-slate-200 bg-white text-sm font-black text-slate-600 transition-colors hover:bg-slate-50 disabled:opacity-50"
              disabled={loading}
              type="button"
              onClick={onClose}
            >
              取消
            </button>
            <button
              className="flex h-12 items-center justify-center gap-2 rounded-xl bg-blue-500 text-sm font-black text-white shadow-lg shadow-blue-500/25 transition-colors hover:bg-blue-600 disabled:opacity-60"
              disabled={loading || !normalizedFamilyName}
              type="submit"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {loading ? '创建中' : '创建家庭档案'}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
