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
  Music,
  Lock,
} from 'lucide-react';
import { SpeakerProfile, TranscriptSegment, Voice, VoiceCategory, VoiceEmotion, VoiceEngine } from '../../types';
import { VOICES, LANGUAGES } from '../../data/mockData';
import { enginesLabel, hasGeminiVoices, listedEngines, VOICE_ENGINE_INFO, VOICE_ENGINES, voiceAllowed } from '../../lib/voiceEngines';
import { textToSpeechService } from '../../services/textToSpeechService';
import { StickyActionBar } from './StickyActionBar';
import { VoiceEngineBadge } from '../VoiceEngineBadge';

interface StepVoiceProps {
  selectedVoiceId: string;
  targetLanguageCode: string;
  /** Every language this dub will render into. Each gets its own voice. */
  targetLanguageCodes?: string[];
  /** The engines the workspace's plan includes; voices on the others are shown locked. */
  voiceEngines?: VoiceEngine[];
  /** Which of those languages the picker below is configuring. */
  voiceLanguageCode?: string;
  onSelectVoiceLanguage?: (code: string) => void;
  voiceSpeed: number;
  voicePitch: number;
  voiceEmotion: VoiceEmotion;
  speakersCount?: number;
  speakerVoiceMap?: Record<string, string>;
  /** Who each speaker is, heard during analysis. */
  speakerProfiles?: Record<string, SpeakerProfile>;
  transcriptSegments?: TranscriptSegment[];
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
  onGenerateDub: () => void;
  onShowToast?: (title: string, desc?: string, type?: 'success' | 'info' | 'error') => void;
}

export const StepVoice: React.FC<StepVoiceProps> = ({
  selectedVoiceId,
  targetLanguageCode,
  targetLanguageCodes,
  voiceEngines = VOICE_ENGINES,
  voiceLanguageCode,
  onSelectVoiceLanguage,
  voiceSpeed,
  voicePitch,
  voiceEmotion,
  speakersCount = 1,
  speakerVoiceMap = {},
  speakerProfiles = {},
  transcriptSegments = [],
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
  onGenerateDub,
  onShowToast,
}) => {
  const [selectedCategory, setSelectedCategory] = useState<VoiceCategory | 'all'>('all');
  const [selectedEngine, setSelectedEngine] = useState<VoiceEngine | 'all'>('all');
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

  const shownEngines = listedEngines(voiceEngines);
  const availableVoices = VOICES.filter((voice) => shownEngines.includes(voice.engine));
  const isLocked = (voice: Voice) => !voiceAllowed(voice, voiceEngines);
  const allLocked = voiceEngines.length < shownEngines.length;

  // Voices the plan can use first, then voices native to the language being set, so the likely pick is at the top.
  const rank = (voice: Voice) => (isLocked(voice) ? 2 : 0) + (voice.languageCode === activeLanguageCode ? 0 : 1);
  const filteredVoices = availableVoices
    .filter((voice) => selectedCategory === 'all' || voice.category === selectedCategory)
    .filter((voice) => selectedEngine === 'all' || voice.engine === selectedEngine)
    .sort((a, b) => rank(a) - rank(b));
  const [showAdvanced, setShowAdvanced] = useState(false);

  const handleSelectVoice = (voice: Voice) => {
    if (isLocked(voice)) {
      onShowToast?.(`${VOICE_ENGINE_INFO[voice.engine].label} is an Enterprise voice`, `Your plan includes ${enginesLabel(voiceEngines)} voices. Upgrade to Enterprise to use this one.`, 'info');
      return;
    }
    onSelectVoice(voice.id);
  };

  const handlePlayVoicePreview = async (e: React.MouseEvent, voice: Voice) => {
    e.stopPropagation();
    // A locked voice would be previewed by a different engine, which would misrepresent it.
    if (isLocked(voice)) {
      handleSelectVoice(voice);
      return;
    }

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
              : !hasGeminiVoices(voiceEngines)
                ? 'Chirp 3 HD voices from Google Cloud. Dialects are read by a related language’s voice, such as Bhojpuri by a Hindi voice.'
                : shownEngines.includes('gemini-2.5-flash')
                  ? allLocked
                    ? 'Gemini 2.5 Flash voices follow emotion and delivery. Chirp 3 HD voices come with Enterprise.'
                    : 'Gemini 2.5 Flash voices follow emotion and delivery; Chirp 3 HD voices read steadily. Dialects use a related language’s voice.'
                : allLocked
                  ? 'Gemini 3.8 Flash-Lite voices speak every Indian language and dialect. Gemini 3.8 Flash and Chirp 3 HD voices come with Enterprise.'
                  : 'Gemini 3.8 Flash-Lite, Gemini 3.8 Flash and Chirp 3 HD voices, for every Indian language and dialect'}
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
              Heard in the audio: each speaker got a distinct voice of their own gender automatically. Override any of them below.
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {speakers.map(({ label, sample }) => {
              const assignedId = speakerVoiceMap[label] || selectedVoiceId;
              const profile = speakerProfiles[label];
              const assigned = availableVoices.find((v) => v.id === assignedId);
              // A voice of the other gender than the one heard is allowed, but worth a second look.
              const mismatch = profile && profile.gender !== 'unknown' && assigned && assigned.gender !== profile.gender;
              return (
                <div key={label} className="p-3.5 rounded-2xl bg-[#F8FAFC] border border-[#E2E8F0] space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-[#0F172A] flex items-center gap-1.5">
                      {label}
                      {profile && profile.gender !== 'unknown' && (
                        <span
                          title="Heard in the original audio; translation uses it for gendered grammar."
                          className="px-1.5 py-0.5 rounded-md bg-sky-50 border border-sky-200 text-sky-700 text-[10px] font-semibold"
                        >
                          {profile.gender === 'male' ? 'Male' : 'Female'}
                          {profile.age ? ` · ${profile.age}` : ''}
                        </span>
                      )}
                      {mismatch && (
                        <span title="This voice is not the gender heard for this speaker." className="text-[10px] font-semibold text-amber-700">
                          voice gender differs
                        </span>
                      )}
                    </span>
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
                    {shownEngines.map((engine) => {
                      const locked = !voiceEngines.includes(engine);
                      return (
                        <optgroup key={engine} label={`${VOICE_ENGINE_INFO[engine].label}${locked ? ' · Enterprise' : ''}`}>
                          {availableVoices
                            .filter((v) => v.engine === engine)
                            .map((v) => (
                              <option key={v.id} value={v.id} disabled={locked}>
                                {v.name.replace(/\s*\(.*\)$/, '')} ({v.gender === 'male' ? 'M' : 'F'}) · {v.accent}
                              </option>
                            ))}
                        </optgroup>
                      );
                    })}
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
          Showing {filteredVoices.length} of {availableVoices.length} voices
        </span>
      </div>

      {/* Engine Tabs: which Google model voices the line */}
      <div className="flex items-center gap-2 overflow-x-auto custom-scrollbar pb-1 -mt-5">
        {(['all', ...shownEngines] as const).map((engine) => {
          const locked = engine !== 'all' && !voiceEngines.includes(engine);
          return (
            <button
              key={engine}
              type="button"
              onClick={() => setSelectedEngine(engine)}
              title={engine === 'all' ? undefined : VOICE_ENGINE_INFO[engine].description}
              className={`flex items-center gap-1 px-3 py-1 rounded-xl text-xs font-semibold whitespace-nowrap transition-all ${
                selectedEngine === engine
                  ? 'bg-[#F05637] text-white shadow-sm'
                  : 'bg-[#F8FAFC] text-[#64748B] hover:text-[#0F172A] border border-[#E2E8F0]'
              }`}
            >
              {locked && <Lock className="w-3 h-3" />}
              {engine === 'all' ? 'All engines' : VOICE_ENGINE_INFO[engine].label}
              {locked && <span className="text-[10px] font-normal opacity-80">· Enterprise</span>}
            </button>
          );
        })}
      </div>

      {/* Large Voice Cards Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {filteredVoices.map((voice) => {
          const isSelected = selectedVoiceId === voice.id;
          const isPlayingThis = activePlayingVoiceId === voice.id;
          const locked = isLocked(voice);

          return (
            <div
              key={voice.id}
              onClick={() => handleSelectVoice(voice)}
              aria-disabled={locked}
              title={locked ? `${VOICE_ENGINE_INFO[voice.engine].label} voices are available on the Enterprise plan` : undefined}
              className={`group relative overflow-hidden rounded-2xl p-5 border transition-all duration-200 flex flex-col justify-between ${
                locked
                  ? 'glass-panel border-dashed border-[#CBD5E1] opacity-60 cursor-not-allowed'
                  : isSelected
                    ? 'bg-[#FFF4F1] border-[#F05637] shadow-[0_0_20px_rgba(240,86,55,0.3)] ring-1 ring-[#F05637] cursor-pointer'
                    : 'glass-panel border-[#E2E8F0] hover:border-[#CBD5E1] hover:bg-[#F8FAFC] cursor-pointer'
              }`}
            >
              {locked && (
                <span className="absolute top-3 right-14 flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-[#0F172A] text-white text-[10px] font-semibold">
                  <Lock className="w-3 h-3" /> Enterprise
                </span>
              )}
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
                      {voice.name.replace(/\s*\(.*\)$/, '')}
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
                  <VoiceEngineBadge engine={voice.engine} locked={locked} />
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
      <div className="rounded-3xl glass-panel p-5 sm:p-6 space-y-6">
        {/* Optional tuning stays folded away; the defaults are right for most dubs. */}
        <button
          type="button"
          onClick={() => setShowAdvanced((open) => !open)}
          aria-expanded={showAdvanced}
          className="w-full flex items-center justify-between text-left"
        >
          <div className="flex items-center gap-2.5">
            <Sliders className="w-4 h-4 text-[#F05637]" />
            <h4 className="text-sm font-bold text-[#0F172A]">Advanced: speed, pitch &amp; emotion</h4>
          </div>
          <span className="text-xs font-semibold text-[#64748B]">{showAdvanced ? 'Hide' : 'Show'}</span>
        </button>

        {showAdvanced && (
        <>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 pt-4 border-t border-[#E2E8F0]">
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
            <span className="text-[10px] text-[#64748B] block">
              The overall tone. Each line also keeps the delivery heard in the original (excited, calm, whispering…), which you can edit per line.
            </span>
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

        </>
        )}
      </div>

      {/* Render quality: what happens to the soundtrack */}
      {separationAvailable && (
        <div className="rounded-3xl glass-panel p-5 sm:p-6 space-y-4">
          <div>
            <h4 className="text-sm font-bold text-[#0F172A]">Render quality</h4>
            <p className="text-xs text-[#64748B] mt-0.5">Every line is timed to the moment the original speaker starts talking. These add more.</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <button
              type="button"
              role="switch"
              aria-checked={separateBackground}
              onClick={() => onToggleSeparateBackground?.(!separateBackground)}
              className={`flex items-start justify-between gap-3 p-4 rounded-2xl border text-left transition-colors ${
                separateBackground ? 'bg-[#FFF4F1] border-[#F05637]/50' : 'bg-white border-[#E2E8F0] hover:border-[#CBD5E1]'
              }`}
            >
              <span className="flex items-start gap-3">
                <span className={`w-9 h-9 shrink-0 rounded-xl flex items-center justify-center ${separateBackground ? 'bg-[#F05637] text-white' : 'bg-[#F8FAFC] text-[#94A3B8] border border-[#E2E8F0]'}`}>
                  <Music className="w-4 h-4" />
                </span>
                <span>
                  <span className="text-xs font-bold text-[#0F172A] block">Keep music under the voice</span>
                  <span className="text-[11px] text-[#64748B] block leading-relaxed">
                    Removes the original voice and keeps music and ambience playing underneath the dub. Off, the background plays only between lines. Done once per video, then reused.
                  </span>
                </span>
              </span>
              <span className={`relative mt-1 w-9 h-5 rounded-full shrink-0 transition-colors ${separateBackground ? 'bg-[#F05637]' : 'bg-[#CBD5E1]'}`}>
                <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${separateBackground ? 'translate-x-4' : 'translate-x-0.5'}`} />
              </span>
            </button>
          </div>
        </div>
      )}

      <StickyActionBar
        summary={
          <span className="flex flex-wrap gap-x-3 gap-y-1">
            {allTargetLangs.map((lang) => (
              <span key={lang.code}>
                {lang.name}:{' '}
                <strong className="text-[#0F172A]">
                  {availableVoices.find((v) => v.id === voiceForLanguage(lang.code))?.name.replace(/\s*\(.*\)$/, '') || '—'}
                </strong>
              </span>
            ))}
          </span>
        }
      >
        <button
          type="button"
          onClick={onGenerateDub}
          className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-[#F05637] hover:bg-[#D94B2E] active:bg-[#B3391F] text-white font-semibold text-sm shadow-[0_0_20px_rgba(240,86,55,0.3)] transition-all"
        >
          <Sparkles className="w-4 h-4" />
          <span>Generate Dub{allTargetLangs.length > 1 ? ` (${allTargetLangs.length} languages)` : ''}</span>
          <ArrowRight className="w-4 h-4" />
        </button>
      </StickyActionBar>
    </div>
  );
};
