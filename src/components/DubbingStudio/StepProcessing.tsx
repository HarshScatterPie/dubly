/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { CheckCircle2, Circle, Loader2 } from 'lucide-react';
import { BrandMark } from '../BrandLoader';
import { useSmoothProgress } from '../../lib/useSmoothProgress';

interface StepProcessingProps {
  targetLanguageName: string;
  voiceName: string;
  videoPreviewUrl: string;
  progressPercent: number; // 0 to 100
  elapsedSeconds: number;
  statusMessage?: string;
  fileName?: string;
  durationFormatted?: string;
}

/** mm:ss once a minute has passed; otherwise just "Ns" — no fake precision for a short wait. */
function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}m ${String(rest).padStart(2, '0')}s`;
}

// The dub pipeline's real phases, recognised from the status message the server writes as it works.
const STAGES = [
  { label: 'Preparing the source audio', match: /preparing|separating|starting/i },
  { label: 'Generating the dubbed voice', match: /generating neural voice/i },
  { label: 'Syncing voice to the video timeline', match: /synchroniz/i },
  { label: 'Rendering the final video', match: /rendering|lip-sync|uploading/i },
];

export const StepProcessing: React.FC<StepProcessingProps> = ({
  targetLanguageName,
  voiceName,
  videoPreviewUrl,
  progressPercent,
  elapsedSeconds,
  statusMessage = '',
  fileName,
  durationFormatted,
}) => {
  const shownProgress = useSmoothProgress(progressPercent, progressPercent < 100);

  // Multi-language runs prefix the message with "[2/9]"; pulled out into its own badge.
  const languageStep = statusMessage.match(/^\[(\d+)\/(\d+)\]\s*/);
  const message = languageStep ? statusMessage.slice(languageStep[0].length) : statusMessage;
  const currentLanguage = message.match(/^([^:]+):/)?.[1];

  // Setup covers the first 15% of the bar; after that the message says which phase the current language is in.
  const matched = STAGES.findIndex((stage, i) => i > 0 && stage.match.test(message));
  const currentStage = progressPercent >= 100 ? STAGES.length : progressPercent < 15 || matched < 0 ? 0 : matched;

  return (
    <div className="glass-panel rounded-3xl overflow-hidden animate-fade-in">
      <div className="grid grid-cols-1 lg:grid-cols-5">
        <div className="lg:col-span-3 relative bg-[#0F172A] min-h-[260px]">
          {videoPreviewUrl && (
            <video src={videoPreviewUrl} autoPlay muted loop playsInline className="absolute inset-0 w-full h-full object-contain opacity-70" />
          )}
          <div aria-hidden className="absolute inset-0 overflow-hidden pointer-events-none">
            <div className="animate-scan absolute left-0 right-0 h-1/5 bg-gradient-to-b from-transparent via-coral-400/25 to-transparent" />
          </div>
          <div className="absolute inset-x-0 bottom-0 p-4 bg-gradient-to-t from-black/70 to-transparent flex items-center justify-between gap-3 text-white">
            <span className="text-xs font-semibold truncate">{fileName || 'Your video'}</span>
            {durationFormatted && <span className="text-[11px] font-mono text-white/80 shrink-0">{durationFormatted}</span>}
          </div>
        </div>

        <div className="lg:col-span-2 p-6 sm:p-8 flex flex-col gap-6">
          <div className="flex items-center gap-4">
            <BrandMark size={52} />
            <div className="min-w-0">
              <h3 className="text-lg font-bold text-[#0F172A] tracking-tight truncate">Creating your {targetLanguageName} dub</h3>
              <p className="text-xs text-[#64748B] mt-0.5 truncate">Voice: {voiceName}</p>
            </div>
          </div>

          {languageStep && (
            <div className="flex items-center justify-between px-3 py-2 rounded-xl bg-coral-50 border border-coral-200/60 text-xs">
              <span className="font-semibold text-coral-700">
                Language {languageStep[1]} of {languageStep[2]}
                {currentLanguage ? ` · ${currentLanguage}` : ''}
              </span>
              <span className="font-mono text-coral-600">
                {Number(languageStep[1]) - 1} done
              </span>
            </div>
          )}

          <div className="space-y-2">
            <div className="h-2 rounded-full bg-[#E2E8F0] overflow-hidden">
              <div
                className="h-full rounded-full bg-gradient-to-r from-coral-400 to-coral-500 transition-[width] duration-150 ease-linear"
                style={{ width: `${Math.max(3, shownProgress)}%` }}
              />
            </div>
            <div className="flex items-center justify-between gap-3 text-[11px] font-mono text-[#64748B]">
              <span className="truncate" key={message}>{message || 'Starting…'}</span>
              <span className="shrink-0">{shownProgress}% · {formatElapsed(elapsedSeconds)}</span>
            </div>
          </div>

          <ol className="space-y-2">
            {STAGES.map((stage, i) => {
              const status = i < currentStage ? 'done' : i === currentStage ? 'active' : 'pending';
              return (
                <li
                  key={stage.label}
                  className={`flex items-center gap-3 px-3 py-2.5 rounded-xl border text-xs font-medium transition-colors duration-300 ${
                    status === 'done'
                      ? 'border-emerald-200/70 bg-emerald-50/50 text-emerald-700'
                      : status === 'active'
                      ? 'border-coral-500/40 bg-coral-500/[0.06] text-coral-600'
                      : 'border-[#E2E8F0] text-[#94A3B8]'
                  }`}
                >
                  {status === 'done' ? (
                    <CheckCircle2 className="w-4 h-4 shrink-0" />
                  ) : status === 'active' ? (
                    <Loader2 className="w-4 h-4 shrink-0 animate-spin" />
                  ) : (
                    <Circle className="w-4 h-4 shrink-0" />
                  )}
                  <span>{stage.label}</span>
                </li>
              );
            })}
          </ol>

          <p className="text-[11px] text-[#94A3B8] leading-relaxed mt-auto">
            {languageStep
              ? 'Each language is voiced and rendered in turn; finished ones are ready to download as soon as they complete.'
              : 'Every line is voiced, fitted to its moment on screen, then mixed back under your video. You can keep this tab open and come back.'}
          </p>
        </div>
      </div>
    </div>
  );
};
