import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Clock, Copy, ExternalLink, Link2, Loader2, MessageCircle, Subtitles, X } from 'lucide-react';
import { projectService } from '../services/projectService';
import { copyText } from '../lib/clipboard';

interface ShareDialogProps {
  projectId: string;
  projectTitle: string;
  languages: { code: string; name: string; ready: boolean }[];
  initialLanguage: string;
  onClose: () => void;
  onShowToast?: (title: string, desc?: string, type?: 'success' | 'info' | 'error') => void;
}

// Makes a 24-hour public watch link for one dubbed language, so someone without a Dubly account can actually see the video.
export const ShareDialog: React.FC<ShareDialogProps> = ({ projectId, projectTitle, languages, initialLanguage, onClose, onShowToast }) => {
  const ready = languages.filter((l) => l.ready);
  const [languageCode, setLanguageCode] = useState(ready.some((l) => l.code === initialLanguage) ? initialLanguage : ready[0]?.code || '');
  const [link, setLink] = useState<{ url: string; expiresAt: string; shareId: string; captions: boolean } | null>(null);
  // Whether the page people open carries the dub's captions (they can still switch them off with CC); chosen before the link is made.
  const [captions, setCaptions] = useState(true);
  const [isRevoking, setIsRevoking] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const languageName = languages.find((l) => l.code === languageCode)?.name || languageCode;

  const createLink = async () => {
    setIsCreating(true);
    setCopied(false);
    try {
      setLink(await projectService.createShareLink(projectId, languageCode, captions));
    } catch (err) {
      onShowToast?.('Could Not Create Link', (err as Error).message, 'error');
    } finally {
      setIsCreating(false);
    }
  };

  const revokeLink = async () => {
    if (!link) return;
    setIsRevoking(true);
    try {
      await projectService.revokeShareLink(projectId, link.shareId);
      setLink(null);
      setCopied(false);
      onShowToast?.('Link Turned Off', 'The link no longer opens the video.', 'info');
    } catch (err) {
      onShowToast?.('Could Not Turn Off Link', (err as Error).message, 'error');
    } finally {
      setIsRevoking(false);
    }
  };

  const copyLink = async () => {
    if (!link) return;
    if (await copyText(link.url)) {
      setCopied(true);
      onShowToast?.('Link Copied', 'Anyone with this link can watch the video for 24 hours.', 'success');
    } else {
      onShowToast?.('Copy Failed', 'Select the link and copy it manually.', 'error');
    }
  };

  const expiresLabel = link
    ? new Date(link.expiresAt).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
    : '';
  const whatsappText = link ? `${projectTitle} (${languageName} dub): ${link.url}` : '';

  // Drawn on the page itself, not inside the project screen: that screen is animated, which makes it the reference for `fixed`, and the
  // dialog then centred on the whole (taller) screen and ran off the bottom of the window.
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[#0F172A]/40 backdrop-blur-sm animate-fade-in" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-title"
        className="w-full max-w-md max-h-[calc(100vh-2rem)] overflow-y-auto rounded-3xl bg-white border border-[#E2E8F0] shadow-[0_30px_80px_rgba(15,23,42,0.25)] p-6 space-y-5"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-[#FFF4F1] text-[#D94B2E] flex items-center justify-center">
              <Link2 className="w-5 h-5" />
            </div>
            <div>
              <h3 id="share-title" className="text-base font-bold text-[#0F172A]">Share this dub</h3>
              <p className="text-xs text-[#64748B]">A public watch link — no login needed to view.</p>
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="p-1.5 rounded-lg text-[#94A3B8] hover:text-[#0F172A] hover:bg-[#F8FAFC]">
            <X className="w-4 h-4" />
          </button>
        </div>

        {ready.length > 1 && (
          <div className="space-y-2">
            <span className="text-[11px] font-bold uppercase tracking-wider text-[#64748B]">Language</span>
            <div className="flex flex-wrap gap-1.5">
              {ready.map((l) => (
                <button
                  key={l.code}
                  type="button"
                  onClick={() => {
                    setLanguageCode(l.code);
                    setLink(null);
                  }}
                  className={`px-3 py-1.5 rounded-xl text-xs font-semibold border transition-colors ${
                    l.code === languageCode
                      ? 'bg-[#F05637] border-[#F05637] text-white'
                      : 'bg-[#F8FAFC] border-[#E2E8F0] text-[#64748B] hover:text-[#0F172A]'
                  }`}
                >
                  {l.name}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Captions: on the page the viewer sees them word by word with a CC switch, exactly as in this studio's preview */}
        <div className="flex items-center justify-between gap-4 p-3.5 rounded-2xl bg-[#F8FAFC] border border-[#E2E8F0]">
          <div className="flex items-start gap-3 min-w-0">
            <div className="w-8 h-8 rounded-xl bg-white border border-[#E2E8F0] text-[#D94B2E] flex items-center justify-center shrink-0">
              <Subtitles className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <span className="text-sm font-semibold text-[#0F172A] block">Captions</span>
              <span className="text-xs text-[#64748B] block mt-0.5">
                {link
                  ? link.captions
                    ? 'This link shows captions. Viewers can switch them off with CC.'
                    : 'This link has no captions. Make a new link to include them.'
                  : captions
                    ? 'Words light up as they are spoken, and viewers can switch them off with CC.'
                    : 'The video plays with no captions and no CC button.'}
              </span>
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={link ? link.captions : captions}
            aria-label="Include captions"
            disabled={Boolean(link)}
            onClick={() => setCaptions((v) => !v)}
            className={`relative w-10 h-6 rounded-full transition-colors shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#F05637]/40 disabled:opacity-50 disabled:cursor-not-allowed ${
              (link ? link.captions : captions) ? 'bg-[#F05637]' : 'bg-[#CBD5E1]'
            }`}
          >
            <span
              className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white shadow transition-transform ${(link ? link.captions : captions) ? 'translate-x-4' : 'translate-x-0'}`}
            />
          </button>
        </div>

        {!link ? (
          <button
            type="button"
            onClick={createLink}
            disabled={isCreating || !languageCode}
            className="w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-[#F05637] hover:bg-[#D94B2E] text-white text-sm font-semibold shadow-[0_0_20px_rgba(240,86,55,0.3)] transition-all disabled:opacity-60"
          >
            {isCreating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Link2 className="w-4 h-4" />}
            <span>{isCreating ? 'Creating link…' : `Create 24-hour link${ready.length > 1 ? ` for ${languageName}` : ''}`}</span>
          </button>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-2 p-1.5 pl-3 rounded-xl bg-[#F8FAFC] border border-[#E2E8F0]">
              <input
                readOnly
                value={link.url}
                onFocus={(e) => e.currentTarget.select()}
                className="flex-1 min-w-0 bg-transparent text-xs font-mono text-[#0F172A] focus:outline-none"
              />
              <button
                type="button"
                onClick={copyLink}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#F05637] hover:bg-[#D94B2E] text-white text-xs font-semibold"
              >
                {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copied ? 'Copied' : 'Copy'}</span>
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <a
                href={`https://wa.me/?text=${encodeURIComponent(whatsappText)}`}
                target="_blank"
                rel="noreferrer"
                className="flex items-center justify-center gap-2 py-2.5 rounded-xl bg-[#F8FAFC] hover:bg-[#E2E8F0] border border-[#E2E8F0] text-xs font-semibold text-[#0F172A]"
              >
                <MessageCircle className="w-3.5 h-3.5 text-emerald-600" />
                <span>WhatsApp</span>
              </a>
              <a
                href={link.url}
                target="_blank"
                rel="noreferrer"
                className="flex items-center justify-center gap-2 py-2.5 rounded-xl bg-[#F8FAFC] hover:bg-[#E2E8F0] border border-[#E2E8F0] text-xs font-semibold text-[#0F172A]"
              >
                <ExternalLink className="w-3.5 h-3.5 text-[#D94B2E]" />
                <span>Open preview</span>
              </a>
            </div>
            <button
              type="button"
              onClick={revokeLink}
              disabled={isRevoking}
              className="w-full flex items-center justify-center gap-1.5 py-2 rounded-xl text-xs font-semibold text-[#64748B] hover:text-rose-600 hover:bg-rose-50 disabled:opacity-60"
            >
              {isRevoking ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <X className="w-3.5 h-3.5" />}
              <span>{isRevoking ? 'Turning off…' : 'Turn off this link'}</span>
            </button>
          </div>
        )}

        <p className="flex items-center gap-2 text-[11px] text-[#64748B]">
          <Clock className="w-3.5 h-3.5 shrink-0" />
          <span>{link ? `Stops working ${expiresLabel}. Anyone with the link can watch and download until then.` : 'The link and the video behind it stop working 24 hours after you create it.'}</span>
        </p>
      </div>
    </div>,
    document.body
  );
};
