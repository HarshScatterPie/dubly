/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, AudioLines, CheckCircle2, Clapperboard, Gauge, Info, ListChecks, Music, ScanFace, XCircle } from 'lucide-react';
import type { DubbingProject, Language, LocalizedSegment, RenderReport } from '../types';
import { LANGUAGES } from '../data/mockData';
import { spokenSpan } from '../lib/captionCues';
import { stripPerformanceTags } from '../lib/performanceTags';
import { QaFlagBadges, needsReview } from './LineReview';

/** One rendered (or attempted) language of a project, flattened from the primary top-level fields and `languageOutputs`. */
export interface DubbedLanguage {
  code: string;
  language: Language;
  status: 'completed' | 'failed' | 'draft' | 'processing';
  videoUrl?: string;
  audioUrl?: string;
  segments: LocalizedSegment[];
  message?: string;
  report?: RenderReport;
}

export function dubbedLanguagesOf(project: DubbingProject): DubbedLanguage[] {
  const codes = project.targetLanguages?.length ? project.targetLanguages : [project.targetLanguage];
  return codes
    .map((code): DubbedLanguage | null => {
      const language = LANGUAGES.find((l) => l.code === code);
      if (!language) return null;
      const output = project.languageOutputs?.[code];
      const isPrimary = code === project.targetLanguage;
      const videoUrl = isPrimary ? project.finalDubbedVideoUrl || output?.finalDubbedVideoUrl : output?.finalDubbedVideoUrl;
      return {
        code,
        language,
        status: videoUrl ? 'completed' : output?.status || 'draft',
        videoUrl,
        audioUrl: isPrimary ? project.dubbedAudioUrl || output?.dubbedAudioUrl : output?.dubbedAudioUrl,
        segments: isPrimary && project.localizedSegments?.length ? project.localizedSegments : output?.localizedSegments || [],
        message: output?.message,
        report: output?.renderReport,
      };
    })
    .filter((entry): entry is DubbedLanguage => entry !== null);
}

export const formatClock = (seconds: number) => {
  const whole = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};

/** Language pills above the player; languages that did not render are shown but cannot be picked. */
export const LanguageTabs: React.FC<{
  languages: DubbedLanguage[];
  active: string;
  onSelect: (code: string) => void;
}> = ({ languages, active, onSelect }) => {
  if (languages.length < 2) return null;
  return (
    <div className="flex items-center gap-1.5 overflow-x-auto custom-scrollbar pb-1" role="tablist" aria-label="Dubbed language">
      {languages.map((entry) => {
        const isActive = entry.code === active;
        const ready = Boolean(entry.videoUrl);
        return (
          <button
            key={entry.code}
            type="button"
            role="tab"
            aria-selected={isActive}
            disabled={!ready}
            onClick={() => ready && onSelect(entry.code)}
            title={ready ? `Watch the ${entry.language.name} dub` : entry.message || 'This language did not render'}
            className={`shrink-0 inline-flex items-center gap-1.5 pl-2 pr-3 py-1.5 rounded-full text-xs font-semibold border transition-all disabled:opacity-45 disabled:cursor-not-allowed ${
              isActive
                ? 'bg-[#0F172A] border-[#0F172A] text-white shadow-sm'
                : 'bg-white border-[#E2E8F0] text-[#475569] hover:border-[#CBD5E1] hover:text-[#0F172A]'
            }`}
          >
            <span className="text-sm leading-none">{entry.language.flag}</span>
            <span>{entry.language.name}</span>
            {!ready && <span className="text-[10px] font-medium text-rose-500">failed</span>}
          </button>
        );
      })}
    </div>
  );
};

type Tone = 'good' | 'info' | 'warn' | 'bad' | 'muted';
const TONE: Record<Tone, string> = {
  good: 'text-emerald-700 bg-emerald-50 border-emerald-200/70',
  info: 'text-sky-700 bg-sky-50 border-sky-200/70',
  warn: 'text-amber-700 bg-amber-50 border-amber-200/70',
  bad: 'text-rose-700 bg-rose-50 border-rose-200/70',
  muted: 'text-[#64748B] bg-[#F8FAFC] border-[#E2E8F0]',
};

const Row: React.FC<{ icon: React.ElementType; tone: Tone; title: string; detail: string }> = ({ icon: Icon, tone, title, detail }) => (
  <div className="flex items-start gap-3">
    <span className={`mt-0.5 w-8 h-8 shrink-0 rounded-xl border flex items-center justify-center ${TONE[tone]}`}>
      <Icon className="w-4 h-4" />
    </span>
    <div className="min-w-0">
      <p className="text-xs font-semibold text-[#0F172A]">{title}</p>
      <p className="text-[11px] text-[#64748B] leading-relaxed">{detail}</p>
    </div>
  </div>
);

const LIP_SYNC_ROW: Record<RenderReport['lipSync'], { tone: Tone; title: string; detail: string; icon: React.ElementType }> = {
  applied: { tone: 'good', icon: Clapperboard, title: 'Lip-synced', detail: "The speaker's mouth was re-animated to the new voice." },
  off: { tone: 'muted', icon: Clapperboard, title: 'Lip-sync off', detail: 'The picture is untouched. Turn lip-sync on when a speaker faces the camera.' },
  skipped_no_face: { tone: 'warn', icon: ScanFace, title: 'Lip-sync skipped', detail: 'No clear, front-facing face was found, so the original picture was kept.' },
  unavailable: { tone: 'muted', icon: Clapperboard, title: 'Lip-sync unavailable', detail: 'Lip-sync is not set up on this server.' },
  failed: { tone: 'bad', icon: XCircle, title: 'Lip-sync failed', detail: 'The original picture was kept so the dub could still finish.' },
};

/** What the last render of a language did: how well it follows the speaker, and what happened to the picture and the soundtrack. */
export const QualityPanel: React.FC<{
  report?: RenderReport;
  faceDetected?: boolean;
  onReviewLines?: () => void;
  className?: string;
}> = ({ report, faceDetected, onReviewLines, className = '' }) => {
  if (!report) {
    return (
      <div className={`rounded-3xl glass-panel p-5 ${className}`}>
        <div className="flex items-center gap-2 text-sm font-bold text-[#0F172A]">
          <Gauge className="w-4 h-4 text-[#F05637]" />
          Dub quality
        </div>
        <p className="mt-2 text-xs text-[#64748B] flex items-start gap-2">
          <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          This language was rendered before quality reports existed. Re-dub it to see timing and lip-sync details.
        </p>
      </div>
    );
  }
  const score = report.lines ? Math.round((report.inSync / report.lines) * 100) : 100;
  const toReview = report.condensed + report.rushed + report.overflow;
  const ring = score >= 85 ? '#10B981' : score >= 65 ? '#F59E0B' : '#F05637';
  const lip = LIP_SYNC_ROW[report.lipSync];
  const lipRow = report.lipSync === 'off' && faceDetected ? { ...lip, tone: 'info' as Tone, detail: 'A face is on screen: re-dub with lip-sync on for the mouth to follow the new voice.' } : lip;

  return (
    <div className={`rounded-3xl glass-panel p-5 space-y-4 ${className}`}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-bold text-[#0F172A]">
          <Gauge className="w-4 h-4 text-[#F05637]" />
          Dub quality
        </div>
        <span className="text-[10px] text-[#94A3B8]">{new Date(report.renderedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</span>
      </div>

      <div className="flex items-center gap-4">
        <div
          className="relative w-16 h-16 shrink-0 rounded-full"
          style={{ background: `conic-gradient(${ring} ${score * 3.6}deg, #E2E8F0 0deg)` }}
          aria-label={`${score}% of lines in sync`}
        >
          <div className="absolute inset-[5px] rounded-full bg-white flex items-center justify-center">
            <span className="text-sm font-extrabold text-[#0F172A] tabular-nums">{score}%</span>
          </div>
        </div>
        <div className="min-w-0">
          <p className="text-sm font-bold text-[#0F172A]">Timing match</p>
          <p className="text-[11px] text-[#64748B] leading-relaxed">
            {report.inSync} of {report.lines} lines start and end with the speaker.
            {report.onsetsSnapped > 0 && ` ${report.onsetsSnapped} were snapped to the exact moment the speaker starts.`}
          </p>
        </div>
      </div>

      <div className="space-y-3 pt-3 border-t border-[#E2E8F0]">
        <Row icon={lipRow.icon} tone={lipRow.tone} title={lipRow.title} detail={lipRow.detail} />
        <Row
          icon={Music}
          tone={report.background === 'separated' ? 'good' : 'info'}
          title={report.background === 'separated' ? 'Background preserved' : 'Background kept between lines'}
          detail={
            report.background === 'separated'
              ? 'Music and ambience keep playing under the voice; the original voice was removed.'
              : 'The original track plays between lines and fades out under speech. Turn on background separation to keep music under the voice.'
          }
        />
        <Row icon={AudioLines} tone="good" title={`${report.channels === 'stereo' ? 'Stereo' : 'Mono'} mix, loudness matched`} detail="The voice sits at the original speaker's level and the whole mix matches the source's loudness." />
        {toReview > 0 ? (
          <div className="flex items-start gap-3">
            <span className={`mt-0.5 w-8 h-8 shrink-0 rounded-xl border flex items-center justify-center ${TONE.warn}`}>
              <AlertTriangle className="w-4 h-4" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold text-[#0F172A]">
                {toReview} line{toReview === 1 ? '' : 's'} worth a listen
              </p>
              <p className="text-[11px] text-[#64748B]">
                {[report.condensed && `${report.condensed} shortened`, report.rushed && `${report.rushed} sped up`, report.overflow && `${report.overflow} running long`]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
              {onReviewLines && (
                <button type="button" onClick={onReviewLines} className="mt-1 text-[11px] font-semibold text-[#D94B2E] hover:underline">
                  Review these lines →
                </button>
              )}
            </div>
          </div>
        ) : (
          <Row icon={CheckCircle2} tone="good" title="Every line fits naturally" detail="No line had to be shortened or noticeably sped up." />
        )}
      </div>
    </div>
  );
};

/**
 * The dubbed script, following playback: the line being spoken is highlighted and kept in
 * view, and clicking any line jumps the player there.
 */
export const SyncedScript: React.FC<{
  segments: LocalizedSegment[];
  currentTime: number;
  onSeek: (time: number) => void;
  languageName: string;
  className?: string;
  maxHeightClass?: string;
}> = ({ segments, currentTime, onSeek, languageName, className = '', maxHeightClass = 'max-h-[420px]' }) => {
  const [showOriginal, setShowOriginal] = useState(false);
  const [reviewOnly, setReviewOnly] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const spoken = useMemo(() => segments.filter((s) => stripPerformanceTags(s.translatedText).trim()), [segments]);
  const shown = reviewOnly ? spoken.filter(needsReview) : spoken;
  const flagged = spoken.filter(needsReview).length;
  const activeId = useMemo(() => {
    const hit = shown.find((s) => {
      const span = spokenSpan(s);
      return currentTime >= span.start - 0.05 && currentTime <= span.end + 0.25;
    });
    return hit?.id ?? null;
  }, [shown, currentTime]);

  // Keeps the spoken line in view inside the list, without scrolling the page.
  useEffect(() => {
    if (!activeId || !listRef.current) return;
    const row = listRef.current.querySelector<HTMLElement>(`[data-line="${CSS.escape(activeId)}"]`);
    if (!row) return;
    const list = listRef.current;
    const top = row.offsetTop - list.offsetTop;
    if (top < list.scrollTop || top + row.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTo({ top: Math.max(0, top - list.clientHeight / 3), behavior: 'smooth' });
    }
  }, [activeId]);

  return (
    <div className={`rounded-3xl glass-panel overflow-hidden ${className}`}>
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 border-b border-[#E2E8F0]">
        <div className="flex items-center gap-2">
          <ListChecks className="w-4 h-4 text-[#F05637]" />
          <h4 className="text-sm font-bold text-[#0F172A]">{languageName} script</h4>
          <span className="text-[11px] text-[#94A3B8]">{spoken.length} lines</span>
        </div>
        <div className="flex items-center gap-1.5">
          {flagged > 0 && (
            <button
              type="button"
              onClick={() => setReviewOnly((v) => !v)}
              aria-pressed={reviewOnly}
              className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold border transition-colors ${
                reviewOnly ? 'bg-amber-500 border-amber-500 text-white' : 'bg-amber-50 border-amber-200 text-amber-700'
              }`}
            >
              {flagged} to review
            </button>
          )}
          <button
            type="button"
            onClick={() => setShowOriginal((v) => !v)}
            aria-pressed={showOriginal}
            className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold border transition-colors ${
              showOriginal ? 'bg-[#0F172A] border-[#0F172A] text-white' : 'bg-white border-[#E2E8F0] text-[#64748B] hover:text-[#0F172A]'
            }`}
          >
            Show original
          </button>
        </div>
      </div>
      <div ref={listRef} className={`${maxHeightClass} overflow-y-auto custom-scrollbar p-2`}>
        {shown.length === 0 && <p className="text-xs text-[#94A3B8] text-center py-10">No lines to show.</p>}
        {shown.map((seg) => {
          const span = spokenSpan(seg);
          const isActive = seg.id === activeId;
          return (
            <button
              key={seg.id}
              type="button"
              data-line={seg.id}
              onClick={() => onSeek(span.start)}
              className={`w-full text-left flex gap-3 px-3 py-2.5 rounded-2xl transition-colors ${
                isActive ? 'bg-[#FFF4F1] ring-1 ring-[#F05637]/40' : 'hover:bg-[#F8FAFC]'
              }`}
            >
              <span className={`mt-0.5 shrink-0 w-12 text-[11px] font-mono tabular-nums ${isActive ? 'text-[#D94B2E] font-bold' : 'text-[#94A3B8]'}`}>
                {formatClock(span.start)}
              </span>
              <span className="min-w-0 flex-1 space-y-1">
                <span className={`block text-[13px] leading-relaxed ${isActive ? 'text-[#0F172A] font-medium' : 'text-[#334155]'}`}>
                  {stripPerformanceTags(seg.translatedText)}
                </span>
                {showOriginal && <span className="block text-[11px] text-[#94A3B8] italic">{seg.sourceText}</span>}
                {seg.qaFlags?.length ? <QaFlagBadges flags={seg.qaFlags} directorNote={seg.directorNote} /> : null}
              </span>
              {seg.speaker && <span className="hidden sm:block shrink-0 text-[10px] text-[#94A3B8] mt-1">{seg.speaker.replace('Speaker ', 'S')}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
};

export const StatTile: React.FC<{ label: string; value: string; icon?: React.ElementType }> = ({ label, value, icon: Icon }) => (
  <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-2xl bg-white border border-[#E2E8F0] min-w-0">
    {Icon && <Icon className="w-4 h-4 text-[#94A3B8] shrink-0" />}
    <div className="min-w-0">
      <span className="text-[10px] uppercase tracking-wider text-[#94A3B8] block">{label}</span>
      <span className="text-xs font-bold text-[#0F172A] block truncate">{value}</span>
    </div>
  </div>
);
