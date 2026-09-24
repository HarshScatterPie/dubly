import React, { useEffect, useRef, useState } from 'react';
import { CheckCircle2, ChevronDown, Download, Loader2, AlertCircle } from 'lucide-react';

export interface DownloadableLanguage {
  code: string;
  name: string;
  nativeName?: string;
  /** Ready to download when set; otherwise the row shows `statusLabel` instead. */
  ready: boolean;
  statusLabel?: string;
}

interface DownloadMenuProps {
  languages: DownloadableLanguage[];
  /** Downloads one language; throws on failure so the menu can report it. */
  onDownload: (code: string) => Promise<void>;
  onShowToast?: (title: string, desc?: string, type?: 'success' | 'info' | 'error') => void;
  label?: string;
  sublabel?: string;
  /** 'large' is the Export step's hero button, 'compact' fits a toolbar. */
  size?: 'large' | 'compact';
  align?: 'left' | 'right';
}

// One download button for every dubbed language: pick a single language from the dropdown, or save them all in one go.
export const DownloadMenu: React.FC<DownloadMenuProps> = ({
  languages,
  onDownload,
  onShowToast,
  label = 'Download Video',
  sublabel,
  size = 'large',
  align = 'right',
}) => {
  const [open, setOpen] = useState(false);
  const [busyCode, setBusyCode] = useState<string | null>(null);
  const [doneCodes, setDoneCodes] = useState<string[]>([]);
  const [allProgress, setAllProgress] = useState<{ done: number; total: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const readyLanguages = languages.filter((l) => l.ready);
  const isBusy = busyCode !== null || allProgress !== null;

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const downloadOne = async (code: string): Promise<boolean> => {
    setBusyCode(code);
    try {
      await onDownload(code);
      setDoneCodes((prev) => (prev.includes(code) ? prev : [...prev, code]));
      return true;
    } catch (err) {
      const name = languages.find((l) => l.code === code)?.name || code;
      onShowToast?.('Download Failed', `${name}: ${(err as Error).message}`, 'error');
      return false;
    } finally {
      setBusyCode(null);
    }
  };

  // Sequential on purpose: each video is fetched whole before saving, so parallel downloads would multiply memory use.
  const downloadAll = async () => {
    setAllProgress({ done: 0, total: readyLanguages.length });
    let succeeded = 0;
    for (let i = 0; i < readyLanguages.length; i++) {
      if (await downloadOne(readyLanguages[i].code)) succeeded++;
      setAllProgress({ done: i + 1, total: readyLanguages.length });
    }
    setAllProgress(null);
    onShowToast?.(
      'Downloads Complete',
      `${succeeded} of ${readyLanguages.length} dubbed videos saved to your computer.`,
      succeeded === readyLanguages.length ? 'success' : 'info'
    );
  };

  // A single-language project needs no menu: the button just downloads.
  const handleMainClick = () => {
    if (languages.length === 1 && readyLanguages.length === 1) void downloadOne(readyLanguages[0].code);
    else setOpen((o) => !o);
  };

  const mainText = allProgress
    ? `Downloading ${Math.min(allProgress.done + 1, allProgress.total)} of ${allProgress.total}…`
    : busyCode
    ? 'Preparing…'
    : label;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={handleMainClick}
        disabled={readyLanguages.length === 0 || (isBusy && languages.length === 1)}
        aria-haspopup={languages.length > 1 ? 'menu' : undefined}
        aria-expanded={languages.length > 1 ? open : undefined}
        className={
          size === 'large'
            ? 'w-full flex items-center justify-between p-3.5 rounded-2xl bg-[#F05637] hover:bg-[#D94B2E] active:bg-[#B3391F] text-white shadow-[0_0_25px_rgba(240,86,55,0.3)] transition-all group disabled:opacity-60'
            : 'flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#F05637] hover:bg-[#D94B2E] text-white text-xs font-semibold shadow-[0_0_15px_rgba(240,86,55,0.3)] transition-all disabled:opacity-60'
        }
      >
        {size === 'large' ? (
          <>
            <div className="flex items-center gap-3 text-left">
              <div className="w-10 h-10 rounded-xl bg-white/20 flex items-center justify-center">
                {isBusy ? <Loader2 className="w-5 h-5 animate-spin" /> : <Download className="w-5 h-5" />}
              </div>
              <div>
                <span className="text-sm font-bold block">{mainText}</span>
                <span className="text-[11px] text-white/80 block font-mono">
                  {languages.length > 1 ? `${readyLanguages.length} of ${languages.length} languages ready` : sublabel}
                </span>
              </div>
            </div>
            {languages.length > 1 && <ChevronDown className={`w-5 h-5 transition-transform ${open ? 'rotate-180' : ''}`} />}
          </>
        ) : (
          <>
            {isBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
            <span>{mainText}</span>
            {languages.length > 1 && <ChevronDown className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />}
          </>
        )}
      </button>

      {open && languages.length > 1 && (
        <div
          role="menu"
          className={`absolute z-30 mt-2 w-full min-w-[18rem] rounded-2xl bg-white border border-[#E2E8F0] shadow-[0_18px_50px_rgba(15,23,42,0.16)] overflow-hidden animate-fade-in ${
            align === 'right' ? 'right-0' : 'left-0'
          }`}
        >
          <button
            type="button"
            role="menuitem"
            onClick={downloadAll}
            disabled={isBusy || readyLanguages.length === 0}
            className="w-full flex items-center justify-between gap-3 px-4 py-3 bg-[#FFF4F1] hover:bg-[#FFE9E3] text-left border-b border-[#E2E8F0] disabled:opacity-60"
          >
            <div>
              <span className="text-sm font-bold text-[#0F172A] block">
                {allProgress ? `Downloading ${Math.min(allProgress.done + 1, allProgress.total)} of ${allProgress.total}…` : 'Download all'}
              </span>
              <span className="text-[11px] text-[#64748B]">
                {readyLanguages.length} video{readyLanguages.length === 1 ? '' : 's'}, saved one after another
              </span>
            </div>
            {allProgress ? <Loader2 className="w-4 h-4 text-[#D94B2E] animate-spin" /> : <Download className="w-4 h-4 text-[#D94B2E]" />}
          </button>

          <ul className="max-h-72 overflow-y-auto py-1">
            {languages.map((lang) => {
              const isThisBusy = busyCode === lang.code;
              const isDone = doneCodes.includes(lang.code);
              return (
                <li key={lang.code}>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => void downloadOne(lang.code)}
                    disabled={!lang.ready || isBusy}
                    className="w-full flex items-center justify-between gap-3 px-4 py-2.5 text-left hover:bg-[#F8FAFC] disabled:hover:bg-transparent disabled:cursor-not-allowed"
                  >
                    <div className="min-w-0">
                      <span className={`text-xs font-semibold block truncate ${lang.ready ? 'text-[#0F172A]' : 'text-[#94A3B8]'}`}>
                        {lang.name}
                        {lang.nativeName && <span className="font-normal text-[#94A3B8]"> · {lang.nativeName}</span>}
                      </span>
                      {!lang.ready && <span className="text-[10px] text-[#94A3B8]">{lang.statusLabel || 'Not ready'}</span>}
                    </div>
                    {isThisBusy ? (
                      <Loader2 className="w-4 h-4 text-[#D94B2E] animate-spin shrink-0" />
                    ) : !lang.ready ? (
                      <AlertCircle className="w-4 h-4 text-[#CBD5E1] shrink-0" />
                    ) : isDone ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                    ) : (
                      <Download className="w-4 h-4 text-[#64748B] shrink-0" />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
};
