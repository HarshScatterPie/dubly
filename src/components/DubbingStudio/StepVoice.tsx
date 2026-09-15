/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import {
  Play,
  Pause,
  Sliders,
  Sparkles,
  ArrowRight,
  CheckCircle2,
  Volume2,
  Smile,
  Zap,
  Clapperboard,
  Music,
} from 'lucide-react';
import { TranscriptSegment, Voice, VoiceCategory, VoiceEmotion } from '../../types';
import { VOICES, LANGUAGES } from '../../data/mockData';
import { textToSpeechService } from '../../services/textToSpeechService';
import { VoiceProviderBadge } from '../VoiceProviderBadge';

interface StepVoiceProps {
  selectedVoiceId: string;
  targetLanguageCode: string;
  /** Every language this dub will render into. Each gets its own voice. */
  targetLanguageCodes?: string[];
  /** The user's cloned voices, offered alongside the built-in catalog. */
  customVoices?: Voice[];
  /** Which of those languages the picker below is configuring. */
  voiceLanguageCode?: string;
  onSelectVoiceLanguage?: (code: string) => void;
  voiceSpeed: number;
  voicePitch: number;
  voiceEmotion: VoiceEmotion;
  speakersCount?: number;
  speakerVoiceMap?: Record<string, string>;
  transcriptSegments?: TranscriptSegment[];
  autoLipSync?: boolean;
  lipSyncAvailable?: boolean;
  separateBackground?: boolean;
  separationAvailable?: boolean;
  onToggleSeparateBackground?: (enabled: boolean) => void;
  /** The voice currently assigned to a language, for the tab tooltips. */
  voiceForLanguage?: (code: string) => string;
  onSelectVoice: (voiceId: string) => void;
  onSelectVoiceForSpeaker?: (speaker: string, voiceId: string) => void;
  onChangeSpeed: (speed: number) => void;
  onChangePitch: (pitch: number) => void;
  onChangeEmotion: (emotion: VoiceEmotion) => void;
  onToggleLipSync?: (enabled: boolean) => void;
  onGenerateDub: () => void;
  onShowToast?: (title: string, desc?: string, type?: 'success' | 'info' | 'error') => void;
}

export const StepVoice: React.FC<StepVoiceProps> = ({
  selectedVoiceId,
  targetLanguageCode,
  targetLanguageCodes,
  customVoices = [],
  voiceLanguageCode,
  onSelectVoiceLanguage,
  voiceSpeed,
  voicePitch,
  voiceEmotion,
  speakersCount = 1,
  speakerVoiceMap = {},
  transcriptSegments = [],
  autoLipSync = false,
  lipSyncAvailable = false,
  separateBackground = false,
  separationAvailable = false,
  onToggleSeparateBackground,
  // Typed default: a bare `() => selectedVoiceId` narrows the binding to a zero-argument
  // function, and the tabs below call it with a language code.
  voiceForLanguage = (_code: string) => selectedVoiceId,
  onSelectVoice,
  onSelectVoiceForSpeaker,
  onChangeSpeed,
  onChangePitch,
  onChangeEmotion,
  onToggleLipSync,
  onGenerateDub,
  onShowToast,
}) => {
  const [selectedCategory, setSelectedCategory] = useState<VoiceCategory | 'all'>('all');
  const [activePlayingVoiceId, setActivePlayingVoiceId] = useState<string | null>(null);

  // Everything on this screen configures one language at a time: the voice, the
  // per-speaker overrides and the previews all follow the tab selected above.
  const activeLanguageCode = voiceLanguageCode || targetLanguageCode;
  const targetLang = LANGUAGES.find((l) => l.code === activeLanguageCode) || LANGUAGES[0];
  const allTargetLangs = (targetLanguageCodes?.length ? targetLanguageCodes : [targetLanguageCode])
    .map((code) => LANGUAGES.find((l) => l.code === code))
    .filter((l): l is (typeof LANGUAGES)[number] => Boolean(l));

  const categories: { id: VoiceCategory | 'all'; label: string }[] = [
    { id: 'all', label: 'All Categories' },
    { id: 'indian', label: '🇮🇳 Indian Native' },
    { id: 'professional', label: '👔 Professional' },
    { id: 'conversational', label: '🎙️ Conversational' },
    { id: 'narration', label: '📖 Narration' },
    { id: 'expressive', label: '⚡ Expressive' },
  ];

  const emotions: { id: VoiceEmotion; label: string; icon: string }[] = [
    { id: 'neutral', label: 'Neutral', icon: '🎯' },
    { id: 'friendly', label: 'Friendly', icon: '😊' },
    { id: 'energetic', label: 'Energetic', icon: '⚡' },
    { id: 'professional', label: 'Professional', icon: '👔' },
    { id: 'empathetic', label: 'Empathetic', icon: '🤝' },
  ];

  // The user's own voices lead the list: they are the ones a returning user is looking
  // for, and there are only ever a handful of them against a catalog of thousands.
  const availableVoices = [...customVoices, ...VOICES];

  const filteredVoices = availableVoices.filter(
    (voice) => selectedCategory === 'all' || voice.category === selectedCategory
  );

  const handlePlayVoicePreview = async (e: React.MouseEvent, voice: Voice) => {
    e.stopPropagation();

    if (activePlayingVoiceId === voice.id) {
      textToSpeechService.stopPlayback();
      setActivePlayingVoiceId(null);
      return;
    }

    setActivePlayingVoiceId(voice.id);
    await textToSpeechService.speakText(voice.sampleQuote, voice, activeLanguageCode, {
      onEnd: () => setActivePlayingVoiceId((cur) => (cur === voice.id ? null : cur)),
      onError: (err) => onShowToast?.('Voice Preview Failed', err.message, 'error'),
    });
  };

  const selectedVoice = availableVoices.find((v) => v.id === selectedVoiceId) || VOICES[0];

  const speakers = React.useMemo(() => {
    if (speakersCount <= 1) return [];
    const labels = Array.from(new Set(transcriptSegments.map((s) => s.speaker))).sort();
    return labels.map((label) => ({
      label,
      sample: transcriptSegments.find((s) => s.speaker === label)?.text || '',
    }));
  }, [speakersCount, transcriptSegments]);

  return (
    <div className="space-y-8 animate-fade-in">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h3 className="text-xl font-bold text-[#0F172A] tracking-tight">
            {allTargetLangs.length > 1 ? `Choose your ${targetLang.name} voice` : 'Choose your voice'}
          </h3>
          <p className="text-xs text-slate-400 mt-0.5">
            {allTargetLangs.length > 1
              ? 'Every language gets its own voice — switch language below to set the others'
              : 'Select high-fidelity Google Cloud Chirp3-HD neural voices, or use your own cloned voice'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 p-1 bg-[#F8FAFC] rounded-xl border border-[#E2E8F0] text-xs">
          <span className="text-slate-500 px-2">
            {allTargetLangs.length > 1 ? 'Setting voice for:' : 'Target Language:'}
          </span>
          {allTargetLangs.map((lang) => {
            const isActive = lang.code === activeLanguageCode;
            const langVoice = availableVoices.find((v) => v.id === voiceForLanguage(lang.code));
            return (
              <button
                key={lang.code}
                type="button"
                onClick={() => onSelectVoiceLanguage?.(lang.code)}
                disabled={allTargetLangs.length === 1}
                title={langVoice ? `${lang.name}: ${langVoice.name}` : lang.name}
                className={`font-semibold px-2 py-1 rounded-lg border transition-all disabled:cursor-default ${
                  isActive
                    ? 'text-white bg-[#F05637] border-[#F05637] shadow-[0_0_12px_rgba(240,86,55,0.35)]'
                    : 'text-coral-600 bg-coral-50/70 border-coral-200/40 hover:border-[#F05637]/60'
                }`}
              >
                {lang.flag} {lang.name}
              </button>
            );
          })}
        </div>
      </div>

      {/* Per-Speaker Voice Assignment (multi-speaker videos only) */}
      {speakers.length > 0 && (
        <div className="rounded-3xl glass-panel p-6 space-y-4">
          <div>
            <h4 className="text-sm font-bold text-[#0F172A] flex items-center gap-2">
              <span>{speakers.length} speakers detected</span>
            </h4>
            <p className="text-xs text-[#64748B] mt-0.5">
              AI-estimated from the audio — each speaker got a distinct voice automatically, override any of them below.
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {speakers.map(({ label, sample }) => {
              const assignedId = speakerVoiceMap[label] || selectedVoiceId;
              return (
                <div key={label} className="p-3.5 rounded-2xl bg-[#F8FAFC] border border-[#E2E8F0] space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-[#0F172A]">{label}</span>
                    <span className="text-[10px] text-[#94A3B8] font-mono">
                      {VOICES.find((v) => v.id === assignedId)?.accent.split(' ')[0]}
                    </span>
                  </div>
                  <p className="text-[11px] text-[#64748B] italic truncate">"{sample}"</p>
                  <select
                    value={assignedId}
                    onChange={(e) => onSelectVoiceForSpeaker?.(label, e.target.value)}
                    className="w-full px-2.5 py-1.5 rounded-lg bg-white border border-[#E2E8F0] text-xs text-[#0F172A] font-medium focus:outline-none focus:border-coral-400"
                  >
                    {availableVoices.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name} ({v.gender === 'male' ? 'M' : 'F'}) · {v.accent}
                      </option>
                    ))}
                  </select>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Category Tabs */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 overflow-x-auto custom-scrollbar pb-1">
          {categories.map((cat) => (
            <button
              key={cat.id}
              type="button"
              onClick={() => setSelectedCategory(cat.id)}
              className={`px-3 py-1 rounded-xl text-xs font-semibold whitespace-nowrap transition-all ${
                selectedCategory === cat.id
                  ? 'bg-[#0F172A] text-white shadow-sm'
                  : 'bg-[#F8FAFC] text-[#64748B] hover:text-[#0F172A] border border-[#E2E8F0]'
              }`}
            >
              {cat.label}
            </button>
          ))}
        </div>
        <span className="text-[10px] text-[#94A3B8] font-mono whitespace-nowrap">
          Showing {filteredVoices.length} of {VOICES.length} voices
        </span>
      </div>

      {/* Large Voice Cards Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {filteredVoices.map((voice) => {
          const isSelected = selectedVoiceId === voice.id;
          const isPlayingThis = activePlayingVoiceId === voice.id;

          return (
            <div
              key={voice.id}
              onClick={() => onSelectVoice(voice.id)}
              className={`group relative overflow-hidden rounded-2xl p-5 border cursor-pointer transition-all duration-200 flex flex-col justify-between ${
                isSelected
                  ? 'bg-[#FFF4F1] border-[#F05637] shadow-[0_0_20px_rgba(240,86,55,0.3)] ring-1 ring-[#F05637]'
                  : 'glass-panel border-[#E2E8F0] hover:border-[#CBD5E1] hover:bg-[#F8FAFC]'
              }`}
            >
              {/* Header: Avatar + Info */}
              <div className="space-y-3">
                <div className="flex items-start justify-between">
                  <div className="relative">
                    <img
                      src={voice.avatarUrl}
                      alt={voice.name}
                      className="w-14 h-14 rounded-2xl object-cover border border-[#E2E8F0] group-hover:scale-105 transition-transform"
                    />
                    {isSelected && (
                      <span className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-[#F05637] text-white flex items-center justify-center shadow-md">
                        <CheckCircle2 className="w-3.5 h-3.5 fill-current" />
                      </span>
                    )}
                  </div>

                  {/* Play Voice Sample Button */}
                  <button
                    type="button"
                    onClick={(e) => handlePlayVoicePreview(e, voice)}
                    className={`p-2.5 rounded-xl transition-all shadow-sm ${
                      isPlayingThis
                        ? 'bg-[#F05637] text-white animate-pulse shadow-[0_0_15px_rgba(240,86,55,0.4)]'
                        : 'bg-[#F8FAFC] text-[#0F172A] hover:text-[#D94B2E] hover:bg-[#E2E8F0] border border-[#E2E8F0]'
                    }`}
                    title="Preview Voice Sample"
                  >
                    {isPlayingThis ? (
                      <Pause className="w-4 h-4" />
                    ) : (
                      <Play className="w-4 h-4 fill-current translate-x-0.5" />
                    )}
                  </button>
                </div>

                <div>
                  <div className="flex items-center gap-2">
                    <h4 className="text-base font-bold text-[#0F172A] tracking-tight">
                      {voice.name}
                    </h4>
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-[#E2E8F0] text-[#0F172A] border border-[#CBD5E1]">
                      {voice.gender === 'male' ? 'Male' : 'Female'}
                    </span>
                  </div>

                  <span className="text-xs font-semibold text-[#D94B2E] block mt-0.5">
                    {voice.accent}
                  </span>

                  <p className="text-xs text-[#64748B] line-clamp-2 mt-2 leading-relaxed">
                    {voice.description}
                  </p>
                </div>

                {/* Single Provider Badge & Tags */}
                <div className="flex flex-wrap items-center gap-1.5 pt-1">
                  <VoiceProviderBadge provider={voice.provider} />
                  {voice.tags.map((tag, idx) => (
                    <span
                      key={idx}
                      className="px-2 py-0.5 rounded-md text-[10px] font-mono bg-[#F8FAFC] text-[#64748B] border border-[#E2E8F0]"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              </div>

              {/* Sample Quote Footer */}
              <div className="mt-4 pt-3 border-t border-[#E2E8F0] text-[11px] text-[#94A3B8] italic truncate font-sans">
                "{voice.sampleQuote}"
              </div>
            </div>
          );
        })}
      </div>

      {/* Voice Tuning Controls (Speed, Pitch, Emotion) */}
      <div className="rounded-3xl glass-panel p-6 sm:p-7 space-y-6">
        <div className="flex items-center justify-between pb-4 border-b border-[#E2E8F0]">
          <div className="flex items-center gap-2.5">
            <Sliders className="w-4 h-4 text-[#F05637]" />
            <h4 className="text-sm font-bold text-[#0F172A]">Voice Performance Tuning</h4>
          </div>
          <span className="text-xs text-[#64748B]">
            Selected: <strong className="text-[#D94B2E]">{selectedVoice.name}</strong> ({selectedVoice.accent})
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* Speed */}
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs font-medium">
              <span className="text-[#0F172A]">Speaking Rate (Speed)</span>
              <span className="font-mono text-[#D94B2E] font-bold">{voiceSpeed.toFixed(2)}x</span>
            </div>
            <input
              type="range"
              min={0.8}
              max={1.2}
              step={0.05}
              value={voiceSpeed}
              onChange={(e) => onChangeSpeed(parseFloat(e.target.value))}
              className="w-full h-1.5 bg-[#E2E8F0] rounded-lg appearance-none cursor-pointer accent-[#F05637]"
            />
            <div className="flex items-center justify-between text-[10px] text-[#94A3B8] font-mono">
              <span>0.8x (Slower)</span>
              <span>1.0x (Normal)</span>
              <span>1.2x (Faster)</span>
            </div>
          </div>

          {/* Pitch */}
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs font-medium">
              <span className="text-[#0F172A]">Pitch Shift</span>
              <span className="font-mono text-[#D94B2E] font-bold">
                {voicePitch >= 1 ? `+${Math.round((voicePitch - 1) * 100)}%` : `-${Math.round((1 - voicePitch) * 100)}%`}
              </span>
            </div>
            <input
              type="range"
              min={0.9}
              max={1.1}
              step={0.02}
              value={voicePitch}
              onChange={(e) => onChangePitch(parseFloat(e.target.value))}
              className="w-full h-1.5 bg-[#E2E8F0] rounded-lg appearance-none cursor-pointer accent-[#F05637]"
            />
            <div className="flex items-center justify-between text-[10px] text-[#94A3B8] font-mono">
              <span>-10% Deeper</span>
              <span>Default</span>
              <span>+10% Higher</span>
            </div>
          </div>

          {/* Emotion */}
          <div className="space-y-2">
            <span className="text-xs font-medium text-[#0F172A] block">Emotion & Style</span>
            <div className="flex flex-wrap gap-1.5">
              {emotions.map((emo) => (
                <button
                  key={emo.id}
                  type="button"
                  onClick={() => onChangeEmotion(emo.id)}
                  className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all ${
                    voiceEmotion === emo.id
                      ? 'bg-[#F05637] text-white font-semibold shadow-[0_0_10px_rgba(240,86,55,0.4)]'
                      : 'bg-[#F8FAFC] text-[#64748B] hover:text-[#0F172A] border border-[#E2E8F0]'
                  }`}
                >
                  <span>{emo.icon}</span>
                  <span>{emo.label}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Background Audio Separation Toggle */}
        {separationAvailable && (
          <button
            type="button"
            onClick={() => onToggleSeparateBackground?.(!separateBackground)}
            className="w-full flex items-center justify-between p-3.5 rounded-xl bg-[#F8FAFC] border border-[#E2E8F0]"
          >
            <div className="flex items-center gap-2.5 text-left">
              <Music className="w-4 h-4 text-[#F05637] shrink-0" />
              <div>
                <span className="text-xs font-semibold text-[#0F172A] block">Keep music &amp; ambience under the voice</span>
                <span className="text-[10px] text-[#94A3B8]">
                  Applause and gaps are always kept. This also preserves background <em>during</em> speech — slow (roughly 2× video length).
                </span>
              </div>
            </div>
            <span className={`relative w-9 h-5 rounded-full shrink-0 transition-colors ${separateBackground ? 'bg-[#F05637]' : 'bg-[#CBD5E1]'}`}>
              <span
                className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
                  separateBackground ? 'translate-x-4' : 'translate-x-0.5'
                }`}
              />
            </span>
          </button>
        )}

        {/* Lip-Sync Toggle */}
        {lipSyncAvailable && (
          <button
            type="button"
            onClick={() => onToggleLipSync?.(!autoLipSync)}
            className="w-full flex items-center justify-between p-3.5 rounded-xl bg-[#F8FAFC] border border-[#E2E8F0]"
          >
            <div className="flex items-center gap-2.5 text-left">
              <Clapperboard className="w-4 h-4 text-[#F05637] shrink-0" />
              <div>
                <span className="text-xs font-semibold text-[#0F172A] block">Lip-sync (experimental, free)</span>
                <span className="text-[10px] text-[#94A3B8]">
                  CPU-only — adds several minutes to render time. Best on clear, front-facing faces.
                </span>
              </div>
            </div>
            <span className={`relative w-9 h-5 rounded-full shrink-0 transition-colors ${autoLipSync ? 'bg-[#F05637]' : 'bg-[#CBD5E1]'}`}>
              <span
                className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
                  autoLipSync ? 'translate-x-4' : 'translate-x-0.5'
                }`}
              />
            </span>
          </button>
        )}

        {/* Generate Dub Primary CTA */}
        <div className="pt-2">
          <button
            type="button"
            onClick={onGenerateDub}
            className="w-full flex items-center justify-center gap-2.5 py-4 px-6 rounded-xl bg-[#F05637] hover:bg-[#D94B2E] active:bg-[#B3391F] text-white font-bold text-sm shadow-[0_0_25px_rgba(240,86,55,0.3)] transition-all duration-200"
          >
            <Sparkles className="w-4 h-4 text-[#D94B2E]" />
            <span>
              Generate Dub (
              {allTargetLangs.length > 1 ? `${allTargetLangs.length} languages` : targetLang.name} ·{' '}
              {selectedVoice.name})
            </span>
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
};
