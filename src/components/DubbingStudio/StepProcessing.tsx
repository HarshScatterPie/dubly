/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import {
  Sparkles,
  CheckCircle2,
  CircleDot,
  Circle,
  Cpu,
  Layers,
} from 'lucide-react';
import { WaveformVisualizer } from '../WaveformVisualizer';
import { VideoPlayer } from '../VideoPlayer';

interface StepProcessingProps {
  targetLanguageName: string;
  voiceName: string;
  videoPreviewUrl: string;
  progressPercent: number; // 0 to 100
  elapsedSeconds: number;
  statusMessage?: string;
}

/** mm:ss once a minute has passed; otherwise just "Ns" — no fake precision for a short wait. */
function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}m ${String(rest).padStart(2, '0')}s`;
}

export const StepProcessing: React.FC<StepProcessingProps> = ({
  targetLanguageName,
  voiceName,
  videoPreviewUrl,
  progressPercent,
  elapsedSeconds,
  statusMessage,
}) => {
  const steps = [
    { label: 'Analyzing audio frequencies', threshold: 15 },
    { label: 'Transcribing speech & timestamps', threshold: 35 },
    { label: 'Translating dialogue with cultural nuance', threshold: 55 },
    { label: 'Generating neural voice audio', threshold: 75 },
    { label: 'Synchronizing audio & lip timing', threshold: 90 },
    { label: 'Rendering final dubbed master video', threshold: 100 },
  ];

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-center animate-fade-in my-4">
      {/* Left: Video Preview with Pulsing Rendering Frame */}
      <div className="lg:col-span-6 space-y-3">
        <div className="relative rounded-2xl overflow-hidden border border-coral-500/40 shadow-2xl shadow-coral-500/20">
          <VideoPlayer
            src={videoPreviewUrl}
            className="w-full aspect-video pointer-events-none opacity-80"
          />

          {/* Rendering Pulse Overlay */}
          <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-black/40 flex flex-col items-center justify-center p-6 text-center">
            <div className="w-14 h-14 rounded-2xl bg-coral-600/80 text-white flex items-center justify-center shadow-xl glow-purple animate-pulse mb-3">
              <Cpu className="w-7 h-7" />
            </div>
            <span className="text-sm font-bold text-white tracking-tight">
              AI Rendering Pipeline Active
            </span>
            <span className="text-xs text-coral-600 font-mono mt-1">
              Dubbing into {targetLanguageName} · {voiceName}
            </span>
          </div>
        </div>
      </div>

      {/* Right: Processing Status Panel */}
      <div className="lg:col-span-6 space-y-6">
        <div className="rounded-3xl bg-[#FFFFFF] border border-[#E2E8F0] p-7 space-y-6 shadow-2xl">
          {/* Header Title */}
          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-lg font-bold text-[#0F172A] tracking-tight">
                  Creating your {targetLanguageName} dub...
                </span>
                <span className="flex h-2 w-2 relative">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-coral-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-coral-500" />
                </span>
              </div>
              <p className="text-xs text-slate-400 mt-0.5">
                Neural synthesis powered by Dubly Neural Engine
              </p>
            </div>

            <span className="text-2xl font-black font-mono text-coral-600">
              {progressPercent}%
            </span>
          </div>

          {/* Progress Bar */}
          <div className="space-y-2">
            <div className="w-full h-2.5 bg-slate-100 rounded-full overflow-hidden p-0.5">
              <div
                className="h-full bg-gradient-to-r from-coral-600 via-coral-500 to-teal-500 rounded-full transition-all duration-300 shadow-sm"
                style={{ width: `${Math.min(100, progressPercent)}%` }}
              />
            </div>
            <div className="flex items-center justify-between text-xs text-slate-400 font-mono">
              <span>{statusMessage || 'Status: Synthesizing Audio'}</span>
              <span>Elapsed: {formatElapsed(elapsedSeconds)}</span>
            </div>
          </div>

          {/* Subtle animated purple AI waveform */}
          <div className="p-3 bg-[#F8FAFC] rounded-2xl border border-[#E2E8F0]">
            <WaveformVisualizer
              isPlaying={true}
              progress={progressPercent / 100}
              height={44}
              barWidth={3}
              barGap={2}
              progressColor="#D94B2E"
              color="#CBD5E1"
            />
          </div>

          {/* Step-by-Step Pipeline Statuses */}
          <div className="space-y-2.5 pt-2 border-t border-[#E2E8F0]">
            {steps.map((s, idx) => {
              const isDone = progressPercent >= s.threshold;
              const isActive = !isDone && (idx === 0 || progressPercent >= steps[idx - 1].threshold);

              return (
                <div
                  key={idx}
                  className={`flex items-center justify-between p-2.5 rounded-xl border text-xs transition-all ${
                    isDone
                      ? 'bg-emerald-50/20 border-emerald-200/40 text-emerald-600'
                      : isActive
                      ? 'bg-coral-50/40 border-coral-300/60 text-coral-700 glow-coral-sm font-semibold'
                      : 'bg-slate-50/30 border-slate-200/40 text-slate-500'
                  }`}
                >
                  <div className="flex items-center gap-2.5">
                    {isDone ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                    ) : isActive ? (
                      <CircleDot className="w-4 h-4 text-coral-600 animate-spin shrink-0" />
                    ) : (
                      <Circle className="w-4 h-4 text-slate-600 shrink-0" />
                    )}
                    <span>{s.label}</span>
                  </div>
                  <span className="font-mono text-[10px]">
                    {isDone ? '✓' : isActive ? '●' : '○'}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};
