/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import {
  Play,
  Pause,
  CheckCircle2,
  Circle,
  Loader2,
  Plus,
  Trash2,
  ArrowRight,
  Edit3,
  Check,
  Languages,
  User,
} from 'lucide-react';
import { TranscriptSegment } from '../../types';
import { VideoPlayer } from '../VideoPlayer';
import { BrandMark } from '../BrandLoader';
import { useSmoothProgress } from '../../lib/useSmoothProgress';
import { StickyActionBar } from './StickyActionBar';

interface StepUnderstandProps {
  isAnalyzing: boolean;
  /** Real server progress, 0–100. */
  analysisProgress: number;
  /** The server's description of what it is doing right now. */
  analysisMessage: string;
  analysisElapsedSeconds: number;
  fileName?: string;
  durationFormatted?: string;
  videoPreviewUrl: string;
  transcriptSegments: TranscriptSegment[];
  wordsCount: number;
  speakersCount: number;
  detectedLanguage: string;
  onUpdateSegment: (segmentId: string, newText: string) => void;
  onAddSegment: () => void;
  onDeleteSegment: (segmentId: string) => void;
  onContinue: () => void;
}

export const StepUnderstand: React.FC<StepUnderstandProps> = ({
  isAnalyzing,
  analysisProgress,
  analysisMessage,
  analysisElapsedSeconds,
  fileName,
  durationFormatted,
  videoPreviewUrl,
  transcriptSegments,
  wordsCount,
  speakersCount,
  detectedLanguage,
  onUpdateSegment,
  onAddSegment,
  onDeleteSegment,
  onContinue,
}) => {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState<string>('');
  const [activePlaySegmentId, setActivePlaySegmentId] = useState<string | null>(null);
  const [videoSeekTime, setVideoSeekTime] = useState<number | undefined>(undefined);

  const shownProgress = useSmoothProgress(analysisProgress, isAnalyzing);

  // Each stage is ticked only once the server's reported progress has actually passed it.
  const stages = [
    { label: 'Preparing the audio', from: 0, to: 12 },
    { label: 'Transcribing the speech', from: 12, to: 78 },
    { label: 'Cleaning up & syncing timing', from: 78, to: 97 },
    { label: 'Identifying speakers', from: 97, to: 100 },
  ].map((stage) => ({
    ...stage,
    status: analysisProgress >= stage.to ? 'done' : analysisProgress >= stage.from ? 'active' : 'pending',
  }));
  const elapsedLabel = `${Math.floor(analysisElapsedSeconds / 60)}:${String(analysisElapsedSeconds % 60).padStart(2, '0')}`;

  const handleStartEdit = (segment: TranscriptSegment) => {
    setEditingId(segment.id);
    setEditText(segment.text);
  };

  const handleSaveEdit = (segmentId: string) => {
    if (editText.trim()) {
      onUpdateSegment(segmentId, editText.trim());
    }
    setEditingId(null);
  };

  const handlePlaySegment = (segment: TranscriptSegment) => {
    // Jumps the real video to this segment and plays its actual original audio —
    // no synthetic narration layered on top.
    setVideoSeekTime(segment.startTime);
    setActivePlaySegmentId(segment.id);
    const durationMs = Math.max(500, (segment.endTime - segment.startTime) * 1000);
    setTimeout(() => {
      setActivePlaySegmentId((cur) => (cur === segment.id ? null : cur));
    }, durationMs);
  };

  const formatTimestamp = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  if (isAnalyzing) {
    return (
      <div className="glass-panel rounded-3xl overflow-hidden animate-fade-in">
        <div className="grid grid-cols-1 lg:grid-cols-5">
          {/* The user's own video, so it is obvious what is being worked on. */}
          <div className="lg:col-span-3 relative bg-[#0F172A] min-h-[240px]">
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
                <h3 className="text-lg font-bold text-[#0F172A] tracking-tight">Understanding your video</h3>
                <p key={analysisMessage} className="text-xs text-[#64748B] mt-0.5 animate-fade-in truncate">
                  {analysisMessage || 'Starting up'}…
                </p>
              </div>
            </div>

            <div className="space-y-2">
              <div className="h-2 rounded-full bg-[#E2E8F0] overflow-hidden">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-coral-400 to-coral-500 transition-[width] duration-150 ease-linear"
                  style={{ width: `${Math.max(3, shownProgress)}%` }}
                />
              </div>
              <div className="flex items-center justify-between text-[11px] font-mono text-[#64748B]">
                <span>{shownProgress}%</span>
                <span>{elapsedLabel} elapsed</span>
              </div>
            </div>

            <ol className="space-y-2">
              {stages.map((stage) => (
                <li
                  key={stage.label}
                  className={`flex items-center gap-3 px-3 py-2.5 rounded-xl border text-xs font-medium transition-colors duration-300 ${
                    stage.status === 'done'
                      ? 'border-emerald-200/70 bg-emerald-50/50 text-emerald-700'
                      : stage.status === 'active'
                      ? 'border-coral-500/40 bg-coral-500/[0.06] text-coral-600'
                      : 'border-[#E2E8F0] text-[#94A3B8]'
                  }`}
                >
                  {stage.status === 'done' ? (
                    <CheckCircle2 className="w-4 h-4 shrink-0" />
                  ) : stage.status === 'active' ? (
                    <Loader2 className="w-4 h-4 shrink-0 animate-spin" />
                  ) : (
                    <Circle className="w-4 h-4 shrink-0" />
                  )}
                  <span>{stage.label}</span>
                </li>
              ))}
            </ol>

            <p className="text-[11px] text-[#94A3B8] leading-relaxed mt-auto">
              Long videos are transcribed in ~30-second parts, so this scales with length. You can keep this tab open and come back.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Top Banner Stats */}
      <div className="flex flex-wrap items-center justify-between gap-4 p-4 rounded-2xl glass-panel">
        <div className="flex items-center gap-4 text-xs">
          <div className="flex items-center gap-2 text-[#0F172A]">
            <User className="w-4 h-4 text-[#F05637]" />
            <span>AI detected <strong className="text-[#0F172A]">{speakersCount} speaker{speakersCount > 1 ? 's' : ''}</strong></span>
          </div>
          <span className="text-[#E2E8F0]">•</span>
          <div className="flex items-center gap-2 text-[#0F172A]">
            <Languages className="w-4 h-4 text-[#F05637]" />
            <span>{detectedLanguage} · <strong className="text-[#0F172A]">{wordsCount} words</strong></span>
          </div>
          <span className="text-[#E2E8F0] hidden sm:inline">•</span>
          <span className="hidden sm:inline-block px-2.5 py-0.5 rounded-full bg-emerald-50/60 text-emerald-600 text-[10px] font-semibold border border-emerald-200/60">
            Confidence 99.2%
          </span>
        </div>
      </div>

      {/* Main Grid: Video on Left, Transcript Editor on Right */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* The player stays pinned while the page scrolls through the transcript, instead of the list having its own scroller. */}
        <div className="lg:col-span-5 space-y-3 lg:sticky lg:top-4">
          <div className="text-[10px] font-bold uppercase tracking-wider text-[#64748B]">
            Synchronized Player
          </div>
          <div className="relative rounded-2xl overflow-hidden border border-[#E2E8F0] shadow-2xl bg-[#FFFFFF]">
            <VideoPlayer
              src={videoPreviewUrl}
              currentTime={videoSeekTime}
              autoPlayOnSeek
              transcriptSegments={transcriptSegments}
              className="w-full aspect-video"
            />
          </div>
          <p className="text-[11px] text-[#64748B] text-center">
            Click any segment on the right to jump and playback that timestamp.
          </p>
        </div>

        {/* Right Transcript Editor Panel */}
        <div className="lg:col-span-7 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold uppercase tracking-wider text-[#64748B]">
              Transcript Segments ({transcriptSegments.length})
            </span>
            <button
              type="button"
              onClick={onAddSegment}
              className="flex items-center gap-1 text-xs text-[#D94B2E] hover:text-coral-600 font-semibold transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Add Segment</span>
            </button>
          </div>

          <div className="space-y-3">
            {transcriptSegments.map((segment) => {
              const isEditing = editingId === segment.id;
              const isPlayingThis = activePlaySegmentId === segment.id;

              return (
                <div
                  key={segment.id}
                  className={`p-4 rounded-xl transition-all ${
                    isPlayingThis
                      ? 'bg-[#F8FAFC] border-l-2 border-[#F05637] border-t border-r border-b border-[#E2E8F0] shadow-[0_0_15px_rgba(240,86,55,0.2)]'
                      : 'bg-[#FFFFFF] border border-[#E2E8F0] hover:border-[#CBD5E1]'
                  }`}
                >
                  <div className="flex items-center justify-between text-xs mb-2">
                    <div className="flex items-center gap-2 font-mono text-[#64748B]">
                      <span className="px-2 py-0.5 rounded bg-[#F8FAFC] text-[#0F172A] text-[10px] border border-[#E2E8F0]">
                        {formatTimestamp(segment.startTime)} — {formatTimestamp(segment.endTime)}
                      </span>
                      <span className="text-[#D94B2E] font-sans font-medium text-[11px]">
                        {segment.speaker}
                      </span>
                    </div>

                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => handlePlaySegment(segment)}
                        className={`p-1.5 rounded-lg transition-colors ${
                          isPlayingThis
                            ? 'bg-[#F05637] text-white'
                            : 'text-[#64748B] hover:text-[#D94B2E] hover:bg-[#F8FAFC]'
                        }`}
                        title="Play segment"
                      >
                        {isPlayingThis ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5 fill-current" />}
                      </button>

                      {!isEditing && (
                        <button
                          type="button"
                          onClick={() => handleStartEdit(segment)}
                          className="p-1.5 text-[#64748B] hover:text-[#D94B2E] hover:bg-[#F8FAFC] rounded-lg transition-colors"
                          title="Edit transcript"
                        >
                          <Edit3 className="w-3.5 h-3.5" />
                        </button>
                      )}

                      <button
                        type="button"
                        onClick={() => onDeleteSegment(segment.id)}
                        className="p-1.5 text-[#94A3B8] hover:text-rose-600 hover:bg-[#F8FAFC] rounded-lg transition-colors"
                        title="Delete segment"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                  {/* Segment Text */}
                  {isEditing ? (
                    <div className="space-y-2 mt-1">
                      <textarea
                        value={editText}
                        onChange={(e) => setEditText(e.target.value)}
                        rows={2}
                        className="w-full p-2.5 rounded-xl bg-[#F8FAFC] border border-[#F05637] text-[#0F172A] text-sm focus:outline-none focus:ring-1 focus:ring-[#F05637] font-sans resize-none"
                      />
                      <div className="flex items-center justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => setEditingId(null)}
                          className="px-3 py-1 rounded-lg text-xs text-[#64748B] hover:text-[#0F172A]"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={() => handleSaveEdit(segment.id)}
                          className="flex items-center gap-1 px-3 py-1 rounded-lg bg-[#F05637] hover:bg-[#D94B2E] text-white text-xs font-semibold shadow-sm"
                        >
                          <Check className="w-3.5 h-3.5" />
                          <span>Save</span>
                        </button>
                      </div>
                    </div>
                  ) : (
                    <p
                      onClick={() => handlePlaySegment(segment)}
                      className="text-sm text-[#0F172A] leading-relaxed cursor-pointer hover:text-[#D94B2E] transition-colors"
                    >
                      "{segment.text}"
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <StickyActionBar
        summary={<span>Transcript looks right? Fix any line by clicking it, then pick your languages.</span>}
      >
        <button
          type="button"
          onClick={onContinue}
          className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-[#F05637] hover:bg-[#D94B2E] text-white text-sm font-semibold shadow-[0_0_20px_rgba(240,86,55,0.3)] transition-all"
        >
          <span>Choose languages</span>
          <ArrowRight className="w-4 h-4" />
        </button>
      </StickyActionBar>
    </div>
  );
};
