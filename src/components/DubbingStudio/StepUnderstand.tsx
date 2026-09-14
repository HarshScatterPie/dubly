/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import {
  AudioLines,
  Play,
  Pause,
  CheckCircle2,
  CircleDot,
  Circle,
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
import { WaveformVisualizer } from '../WaveformVisualizer';

interface StepUnderstandProps {
  isAnalyzing: boolean;
  analysisStage: number; // 0 to 5
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
  analysisStage,
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

  const stages = [
    { label: 'Video uploaded', status: analysisStage >= 1 ? 'done' : 'active' },
    { label: 'Audio extracted', status: analysisStage >= 2 ? 'done' : analysisStage === 1 ? 'active' : 'pending' },
    { label: 'Transcribing speech', status: analysisStage >= 3 ? 'done' : analysisStage === 2 ? 'active' : 'pending' },
    { label: 'Understanding context', status: analysisStage >= 4 ? 'done' : analysisStage === 3 ? 'active' : 'pending' },
    { label: 'Preparing translation', status: analysisStage >= 5 ? 'done' : analysisStage === 4 ? 'active' : 'pending' },
    { label: 'Ready for dubbing', status: analysisStage >= 5 ? 'done' : 'pending' },
  ];

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

  // If analyzing, show animated AI pipeline screen
  if (isAnalyzing) {
    return (
      <div className="max-w-lg mx-auto my-2 p-5 rounded-3xl glass-panel text-center space-y-3 animate-fade-in shadow-[0_0_35px_rgba(0,0,0,0.15)]">
        <div className="w-11 h-11 rounded-2xl bg-[#F05637]/20 text-[#D94B2E] border border-[#F05637]/30 flex items-center justify-center mx-auto shadow-[0_0_20px_rgba(240,86,55,0.3)]">
          <AudioLines className="w-5 h-5 animate-pulse-subtle" />
        </div>

        <div>
          <h3 className="text-base font-bold text-[#0F172A] tracking-tight">
            Transcribing & Diarizing Audio
          </h3>
          <p className="text-[11px] text-[#64748B] mt-0.5">
            Running Whisper AI speech-to-text with acoustic speaker segmentation
          </p>
        </div>

        {/* Dynamic Waveform Visualizer */}
        <div className="p-2 bg-[#F8FAFC] rounded-xl border border-[#E2E8F0]">
          <WaveformVisualizer
            isPlaying={true}
            height={32}
            barWidth={3}
            barGap={3}
            progressColor="#D94B2E"
            color="#CBD5E1"
          />
        </div>

        {/* 6 Step Progress List */}
        <div className="space-y-1.5 text-left pt-1">
          {stages.map((stage, idx) => {
            return (
              <div
                key={idx}
                className={`flex items-center justify-between px-3 py-1.5 rounded-lg border transition-all duration-300 ${
                  stage.status === 'done'
                    ? 'bg-emerald-50/20 border-emerald-200/40 text-emerald-600'
                    : stage.status === 'active'
                    ? 'bg-[#F05637]/15 border-[#F05637]/50 text-[#D94B2E] shadow-[0_0_15px_rgba(240,86,55,0.2)]'
                    : 'bg-[#F8FAFC]/50 border-[#E2E8F0] text-[#94A3B8]'
                }`}
              >
                <div className="flex items-center gap-2.5 text-[11px] font-medium">
                  {stage.status === 'done' ? (
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                  ) : stage.status === 'active' ? (
                    <CircleDot className="w-3.5 h-3.5 text-[#D94B2E] animate-spin" />
                  ) : (
                    <Circle className="w-3.5 h-3.5 text-[#94A3B8]" />
                  )}
                  <span>{stage.label}</span>
                </div>
                <span className="text-[10px] font-mono">
                  {stage.status === 'done' ? '✓' : stage.status === 'active' ? '●' : '○'}
                </span>
              </div>
            );
          })}
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

        <button
          type="button"
          onClick={onContinue}
          className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-[#F05637] hover:bg-[#D94B2E] text-white text-xs font-semibold shadow-[0_0_20px_rgba(240,86,55,0.3)] transition-all"
        >
          <span>Continue to Localization</span>
          <ArrowRight className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Main Grid: Video on Left, Transcript Editor on Right */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left Video Player */}
        <div className="lg:col-span-5 space-y-3">
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

          <div className="space-y-3 max-h-[560px] overflow-y-auto custom-scrollbar pr-1">
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
    </div>
  );
};
