import React from 'react';
import { AudioLines, TriangleAlert } from 'lucide-react';
import type { DubbingProject, LocalizedSegment, QaFlag } from '../types';

export const QA_FLAG_INFO: Record<QaFlag, { label: string; hint: string; severe: boolean }> = {
  untranslated: { label: 'Not translated', hint: 'This line came back in the original language.', severe: true },
  wrong_script: { label: 'Wrong script', hint: 'Written in the wrong script for this language (for example romanized), which the voice mispronounces.', severe: true },
  glossary: { label: 'Glossary', hint: 'A glossary term is not rendered the way the workspace glossary requires.', severe: false },
  condensed: { label: 'Shortened', hint: 'Shortened automatically to fit its slot. Check the meaning survived.', severe: false },
  rushed: { label: 'Rushed', hint: 'Sped up noticeably to fit its slot. A shorter line will sound more natural.', severe: false },
  overflow: { label: 'Runs over', hint: 'Still too long after shortening, so it runs into the next line. Shorten it.', severe: true },
};

export const needsReview = (seg: LocalizedSegment) => (seg.qaFlags?.length ?? 0) > 0;

// A language's lines as the server saved them; the primary language's live at the top level.
export function languageSegmentsOf(project: DubbingProject, languageCode: string): LocalizedSegment[] {
  if (languageCode === project.targetLanguage && project.localizedSegments?.length) return project.localizedSegments;
  return project.languageOutputs?.[languageCode]?.localizedSegments || [];
}

export const QaFlagBadges: React.FC<{ flags?: QaFlag[] }> = ({ flags }) => {
  if (!flags?.length) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {flags.map((flag) => {
        const info = QA_FLAG_INFO[flag];
        if (!info) return null;
        return (
          <span
            key={flag}
            title={info.hint}
            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border text-[10px] font-semibold font-sans ${
              info.severe ? 'bg-red-50 border-red-200 text-red-700' : 'bg-amber-50 border-amber-200 text-amber-700'
            }`}
          >
            <TriangleAlert className="w-3 h-3" />
            {info.label}
          </span>
        );
      })}
    </span>
  );
};

export const DeliveryTag: React.FC<{ delivery?: string }> = ({ delivery }) => {
  if (!delivery) return null;
  return (
    <span
      title="How the voice performs this line. Taken from the original, and editable with the line."
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-violet-50 border border-violet-200 text-violet-700 text-[10px] font-semibold font-sans"
    >
      <AudioLines className="w-3 h-3" />
      {delivery}
    </span>
  );
};

export const DeliveryInput: React.FC<{ value: string; onChange: (value: string) => void }> = ({ value, onChange }) => (
  <label className="flex items-center gap-2 text-[11px] text-[#64748B]">
    <AudioLines className="w-3.5 h-3.5 text-violet-600 shrink-0" />
    <span className="shrink-0">Delivery</span>
    <input
      type="text"
      value={value}
      maxLength={80}
      onChange={(e) => onChange(e.target.value)}
      placeholder="e.g. excited and fast, calm and warm, whispering"
      className="flex-1 min-w-0 px-2.5 py-1 rounded-lg bg-[#FFFFFF] border border-[#E2E8F0] text-xs text-[#0F172A] placeholder-[#94A3B8] focus:outline-none focus:border-violet-400"
    />
  </label>
);

// A "show only lines that need a look" switch with the count, shown only when some line is flagged.
export const ReviewFilterToggle: React.FC<{ count: number; active: boolean; onToggle: () => void }> = ({ count, active, onToggle }) => {
  if (count === 0 && !active) return null;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={active}
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-xs font-semibold transition-all ${
        active ? 'bg-amber-500 border-amber-500 text-white' : 'bg-amber-50 border-amber-200 text-amber-700 hover:border-amber-300'
      }`}
    >
      <TriangleAlert className="w-3.5 h-3.5" />
      {active ? 'Showing lines to review' : `${count} line${count === 1 ? '' : 's'} to review`}
    </button>
  );
};
