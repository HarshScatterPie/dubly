import React from 'react';
import { AudioLines, Ear, Sparkles, TriangleAlert } from 'lucide-react';
import type { DubbingProject, LocalizedSegment, QaFlag } from '../types';

export const QA_FLAG_INFO: Record<QaFlag, { label: string; hint: string; severe: boolean }> = {
  untranslated: { label: 'Not translated', hint: 'This line came back in the original language.', severe: true },
  wrong_script: { label: 'Wrong script', hint: 'Written in the wrong script for this language (for example romanized), which the voice mispronounces.', severe: true },
  glossary: { label: 'Glossary', hint: 'A glossary term is not rendered the way the workspace glossary requires.', severe: false },
  condensed: { label: 'Shortened', hint: 'Shortened automatically to fit its slot. Check the meaning survived.', severe: false },
  rushed: { label: 'Rushed', hint: 'Sped up noticeably to fit its slot. A shorter line will sound more natural.', severe: false },
  overflow: { label: 'Runs over', hint: 'Still too long after shortening, so it runs into the next line. Shorten it.', severe: true },
  director: { label: 'AI review', hint: 'The AI reviewer heard a problem in this line even after re-recording it. Listen and adjust.', severe: false },
};

export const needsReview = (seg: LocalizedSegment) => (seg.qaFlags?.length ?? 0) > 0;

// A language's lines as the server saved them; the primary language's live at the top level.
export function languageSegmentsOf(project: DubbingProject, languageCode: string): LocalizedSegment[] {
  if (languageCode === project.targetLanguage && project.localizedSegments?.length) return project.localizedSegments;
  return project.languageOutputs?.[languageCode]?.localizedSegments || [];
}

// `directorNote` is what the AI reviewer heard; it is shown in full next to its badge rather than hidden in a tooltip.
export const QaFlagBadges: React.FC<{ flags?: QaFlag[]; directorNote?: string }> = ({ flags, directorNote }) => {
  if (!flags?.length) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {flags.map((flag) => {
        const info = QA_FLAG_INFO[flag];
        if (!info) return null;
        const note = flag === 'director' ? directorNote : undefined;
        return (
          <span
            key={flag}
            title={note ? `${info.hint} ${note}` : info.hint}
            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border text-[10px] font-semibold font-sans ${
              flag === 'director'
                ? 'bg-sky-50 border-sky-200 text-sky-700'
                : info.severe
                  ? 'bg-red-50 border-red-200 text-red-700'
                  : 'bg-amber-50 border-amber-200 text-amber-700'
            }`}
          >
            {flag === 'director' ? <Ear className="w-3 h-3" /> : <TriangleAlert className="w-3 h-3" />}
            {info.label}
            {note && <span className="font-normal">: {note}</span>}
          </span>
        );
      })}
    </span>
  );
};

// Performance tags a line can carry; the voice acts them and captions leave them out.
const TAG_BUTTONS: { tag: string; label: string }[] = [
  { tag: '[laughing]', label: 'Laugh' },
  { tag: '[sigh]', label: 'Sigh' },
  { tag: '[whispering]', label: 'Whisper' },
  { tag: '[shouting]', label: 'Shout' },
  { tag: '[short pause]', label: 'Pause' },
];

// The line with `tag` placed where the editor's cursor is (at the end when the editor is not focused).
export function insertTagAtCursor(text: string, tag: string, editor: HTMLTextAreaElement | null): string {
  const at = editor && document.activeElement === editor ? editor.selectionStart : text.length;
  const before = text.slice(0, at).trimEnd();
  const after = text.slice(at).trimStart();
  return [before, tag, after].filter(Boolean).join(' ');
}

export const PerformanceTagPicker: React.FC<{ onInsert: (tag: string) => void }> = ({ onInsert }) => (
  <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-[#64748B]">
    <Sparkles className="w-3.5 h-3.5 text-violet-600 shrink-0" />
    <span className="shrink-0" title="Sounds and styles the voice performs at that point of the line. They never appear in captions.">
      Perform
    </span>
    {TAG_BUTTONS.map(({ tag, label }) => (
      <button
        key={tag}
        type="button"
        // Keeps the textarea focused, so the tag lands at its cursor.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onInsert(tag)}
        className="px-2 py-0.5 rounded-md bg-violet-50 border border-violet-200 text-violet-700 font-semibold hover:border-violet-400"
      >
        {label}
      </button>
    ))}
  </div>
);

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
