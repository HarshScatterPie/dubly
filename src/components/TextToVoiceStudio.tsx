/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from 'react';
import {
  Mic,
  Sparkles,
  Play,
  Pause,
  Download,
  Video,
  Volume2,
  CheckCircle2,
  FileText,
  RotateCcw,
  ArrowRight,
  Languages,
} from 'lucide-react';
import { Language, Voice, VoiceEmotion } from '../types';
import { LANGUAGES, VOICES, SAMPLE_VIDEOS } from '../data/mockData';
import { voiceCloneService } from '../services/voiceCloneService';
import { VoiceCloneStudio } from './VoiceCloneStudio';
import { VoiceProviderBadge } from './VoiceProviderBadge';
import { WaveformVisualizer } from './WaveformVisualizer';
import { textToSpeechService } from '../services/textToSpeechService';
import { renderService } from '../services/renderService';

interface TextToVoiceStudioProps {
  onShowToast: (title: string, desc?: string, type?: 'success' | 'info' | 'error') => void;
  onSendToDubbingWithAudio?: (script: string, voiceId: string, sampleVideoId?: string) => void;
}

export const TextToVoiceStudio: React.FC<TextToVoiceStudioProps> = ({
  onShowToast,
  onSendToDubbingWithAudio,
}) => {
  const [scriptText, setScriptText] = useState<string>(
    'Welcome to Dubly. With our state-of-the-art neural voice engine, you can turn any written script into broadcast-quality speech with natural breathing, authentic emotion, and perfect cadence.'
  );
  const [selectedLanguageCode, setSelectedLanguageCode] = useState<string>('en');
  const [selectedVoiceId, setSelectedVoiceId] = useState<string>('alex');
  // The user's own cloned voices, loaded once and merged into the picker below so they
  // are chosen exactly like a catalog voice.
  const [customVoices, setCustomVoices] = useState<Voice[]>([]);
  const [showCloneStudio, setShowCloneStudio] = useState<boolean>(false);

  const reloadCustomVoices = React.useCallback(() => {
    voiceCloneService
      .list()
      .then((res) => setCustomVoices(res.voices.map((v) => voiceCloneService.toVoice(v))))
      .catch(() => setCustomVoices([]));
  }, []);

  React.useEffect(() => reloadCustomVoices(), [reloadCustomVoices]);

  /** Your voices first — a returning user is looking for those, not for voice #400. */
  const availableVoices = React.useMemo(() => [...customVoices, ...VOICES], [customVoices]);
  const [speed, setSpeed] = useState<number>(1.0);
  const [pitch, setPitch] = useState<number>(1.0);
  const [emotion, setEmotion] = useState<VoiceEmotion>('friendly');
  const [isGenerating, setIsGenerating] = useState<boolean>(false);
  const [generatedAudioUrl, setGeneratedAudioUrl] = useState<string | null>(null);
  const [generatedDuration, setGeneratedDuration] = useState<number>(0);
  const [waveformPeaks, setWaveformPeaks] = useState<number[]>([]);
  const [isPlayingAudio, setIsPlayingAudio] = useState<boolean>(false);
  const [audioProgress, setAudioProgress] = useState<number>(0);
  const [previewingVoiceId, setPreviewingVoiceId] = useState<string | null>(null);
  const [showAddToVideoModal, setShowAddToVideoModal] = useState<boolean>(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    audioRef.current = new Audio();
    const el = audioRef.current;
    el.ontimeupdate = () => {
      if (el.duration) setAudioProgress(el.currentTime / el.duration);
    };
    el.onended = () => setIsPlayingAudio(false);
    el.onpause = () => setIsPlayingAudio(false);
    return () => {
      el.pause();
      el.src = '';
    };
  }, []);

  const scriptPresets = [
    {
      title: 'Tech Keynote Launch',
      lang: 'en',
      voice: 'alex',
      text: 'Today marks a giant leap forward. Dubly enables every creator and enterprise to localize high-definition video across twenty-eight languages in seconds.',
    },
    {
      title: 'Hindi Storytelling & Podcast',
      lang: 'hi',
      voice: 'riya',
      text: 'नमस्ते दोस्तों! आज हम बात करेंगे कि कैसे आर्टिफिशियल इंटेलिजेंस हमारे वीडियो और पॉडकास्ट को दुनिया के हर कोने तक पहुँचा रहा है।',
    },
    {
      title: 'Tamil Tech Review',
      lang: 'ta',
      voice: 'rohan',
      text: 'வணக்கம் நண்பர்களே! இந்த வீடியோவில் நாம் புத்தம் புதிய AI வீடியோ மொழிபெயர்ப்பு தொழில்நுட்பத்தைப் பற்றி விரிவாகப் பார்க்கப் போகிறோம்.',
    },
    {
      title: 'Spanish Brand Story',
      lang: 'es',
      voice: 'mateo',
      text: 'Bienvenidos a una experiencia transformadora. Nuestro compromiso es derribar las barreras del idioma para conectar a millones de personas.',
    },
  ];

  const handleApplyPreset = (preset: typeof scriptPresets[0]) => {
    setScriptText(preset.text);
    setSelectedLanguageCode(preset.lang);
    setSelectedVoiceId(preset.voice);
    setGeneratedAudioUrl(null);
    onShowToast('Preset Applied', `${preset.title} script loaded.`, 'info');
  };

  const handleGenerateVoice = async (): Promise<string | null> => {
    if (!scriptText.trim()) {
      onShowToast('Empty Script', 'Please enter some text to synthesize.', 'error');
      return null;
    }

    setIsGenerating(true);
    const selectedVoice = availableVoices.find((v) => v.id === selectedVoiceId) || VOICES[0];
    const targetLang = LANGUAGES.find((l) => l.code === selectedLanguageCode);

    try {
      const result = await textToSpeechService.generateSpeech(scriptText, {
        voiceId: selectedVoiceId,
        speed,
        pitch,
        emotion,
        languageCode: selectedLanguageCode,
      });
      setGeneratedAudioUrl(result.audioUrl);
      setGeneratedDuration(result.durationSeconds);
      setWaveformPeaks(result.waveformPeaks);
      onShowToast('Voiceover Generated!', `Synthesized with ${selectedVoice.name} (${targetLang?.name || 'Native'}) via ${result.provider}.`, 'success');
      return result.audioUrl;
    } catch (err) {
      onShowToast('Generation Failed', (err as Error).message, 'error');
      return null;
    } finally {
      setIsGenerating(false);
    }
  };

  const handlePlayGeneratedAudio = async () => {
    if (!audioRef.current) return;

    if (isPlayingAudio) {
      audioRef.current.pause();
      setIsPlayingAudio(false);
      return;
    }

    let url = generatedAudioUrl;
    if (!url) {
      url = await handleGenerateVoice();
      if (!url) return;
    }

    audioRef.current.src = url;
    audioRef.current.playbackRate = 1;
    setAudioProgress(0);
    setIsPlayingAudio(true);
    await audioRef.current.play().catch(() => setIsPlayingAudio(false));
  };

  const handleSeek = (ratio: number) => {
    if (audioRef.current && audioRef.current.duration) {
      audioRef.current.currentTime = ratio * audioRef.current.duration;
      setAudioProgress(ratio);
    }
  };

  const handleDownload = async () => {
    if (!generatedAudioUrl) {
      onShowToast('Nothing to Download', 'Generate a voiceover first.', 'error');
      return;
    }
    const selectedVoice = availableVoices.find((v) => v.id === selectedVoiceId) || VOICES[0];
    try {
      await renderService.downloadMedia(`Dubly_Voiceover_${selectedVoice.name}.wav`, generatedAudioUrl);
      onShowToast('Download Started', 'WAV voice track downloaded.', 'success');
    } catch (err) {
      onShowToast('Download Failed', (err as Error).message, 'error');
    }
  };

  const handlePreviewVoice = async (e: React.MouseEvent, voice: Voice) => {
    e.stopPropagation();
    if (previewingVoiceId === voice.id) {
      textToSpeechService.stopPlayback();
      setPreviewingVoiceId(null);
      return;
    }
    setPreviewingVoiceId(voice.id);
    await textToSpeechService.speakText(voice.sampleQuote, voice, voice.languageCode, {
      onEnd: () => setPreviewingVoiceId((cur) => (cur === voice.id ? null : cur)),
      onError: (err) => onShowToast('Voice Preview Failed', err.message, 'error'),
    });
  };

  const handleMergeWithVideo = (sampleId: string) => {
    setShowAddToVideoModal(false);
    onSendToDubbingWithAudio?.(scriptText, selectedVoiceId, sampleId);
    onShowToast('Opening Video Studio', `Start a new dub with ${availableVoices.find((v) => v.id === selectedVoiceId)?.name || 'this voice'} pre-selected.`, 'success');
  };

  const selectedVoice = availableVoices.find((v) => v.id === selectedVoiceId) || VOICES[0];
  const charCount = scriptText.length;
  const wordCount = scriptText.trim().split(/\s+/).filter(Boolean).length;
  const estDurationSec = generatedAudioUrl ? Math.round(generatedDuration) : Math.max(1, Math.round((wordCount / 2.5) / speed));

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8 animate-fade-in">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl sm:text-3xl font-extrabold text-[#0F172A] tracking-tight">
            Text-to-Voice Studio
          </h2>
          <p className="text-xs sm:text-sm text-[#64748B] mt-1">
            Turn your script into natural AI voiceover with neural pacing and intonation.
          </p>
        </div>

        {/* Preset Chips */}
        <div className="flex items-center gap-2 overflow-x-auto pb-1">
          <span className="text-[11px] text-[#94A3B8] font-semibold uppercase tracking-wider shrink-0">
            Presets:
          </span>
          {scriptPresets.map((p, idx) => (
            <button
              key={idx}
              type="button"
              onClick={() => handleApplyPreset(p)}
              className="px-3 py-1 rounded-xl bg-[#F8FAFC] hover:bg-[#E2E8F0] text-[#64748B] hover:text-[#0F172A] border border-[#E2E8F0] text-xs font-medium whitespace-nowrap transition-colors"
            >
              {p.title}
            </button>
          ))}
        </div>
      </div>

      {/* Main Grid: Script Editor on Left, Controls & Voice on Right */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        {/* Left: Script Editor */}
        <div className="lg:col-span-7 space-y-4">
          <div className="rounded-3xl glass-panel p-6 space-y-4 shadow-xl">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold uppercase tracking-wider text-[#64748B] flex items-center gap-2">
                <FileText className="w-4 h-4 text-[#F05637]" />
                <span>Script Editor</span>
              </span>
              <div className="flex items-center gap-3 text-xs font-mono text-[#94A3B8]">
                <span>{charCount} chars</span>
                <span>•</span>
                <span>{wordCount} words</span>
                <span>•</span>
                <span className="text-[#D94B2E] font-semibold">~{estDurationSec}s audio</span>
              </div>
            </div>

            <textarea
              value={scriptText}
              onChange={(e) => {
                setScriptText(e.target.value);
                setGeneratedAudioUrl(null);
              }}
              rows={8}
              placeholder="Paste your script here..."
              className="w-full p-4 rounded-2xl bg-[#F8FAFC] border border-[#E2E8F0] focus:border-[#F05637] text-[#0F172A] text-base leading-relaxed placeholder-[#94A3B8] focus:outline-none focus:ring-1 focus:ring-[#F05637] font-sans resize-none transition-all"
            />

            {/* Quick Helper */}
            <div className="flex items-center justify-between text-xs text-[#94A3B8] pt-1">
              <span>Supports punctuation cadence (commas, ellipses, question intonation)</span>
              <button
                type="button"
                onClick={() => {
                  setScriptText('');
                  setGeneratedAudioUrl(null);
                }}
                className="text-[#94A3B8] hover:text-rose-600 transition-colors"
              >
                Clear
              </button>
            </div>
          </div>

          {/* Waveform Player Box (Shows after generation or for immediate preview) */}
          <div className="rounded-3xl glass-panel p-6 space-y-5 shadow-xl">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-xl bg-[#F05637]/20 text-[#D94B2E] flex items-center justify-center">
                  <Volume2 className="w-4 h-4" />
                </div>
                <div>
                  <h4 className="text-sm font-bold text-[#0F172A]">Audio Waveform Master</h4>
                  <span className="text-xs text-[#64748B]">
                    Voice: {selectedVoice.name} · {selectedVoice.accent}
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-2 font-mono text-xs text-[#64748B]">
                <span className="text-[#D94B2E] font-bold">
                  {isPlayingAudio ? `${Math.round(audioProgress * estDurationSec)}s` : '00:00'}
                </span>
                <span>/</span>
                <span>00:{estDurationSec.toString().padStart(2, '0')}</span>
              </div>
            </div>

            {/* Interactive Dynamic Waveform */}
            <div className="p-4 bg-[#F8FAFC] rounded-2xl border border-[#E2E8F0]">
              <WaveformVisualizer
                isPlaying={isPlayingAudio}
                progress={audioProgress}
                height={54}
                barWidth={3}
                barGap={2}
                progressColor="#F05637"
                color="#CBD5E1"
                peaks={waveformPeaks.length > 0 ? waveformPeaks : undefined}
                onSeek={handleSeek}
              />
            </div>

            {/* Audio Control Bar */}
            <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handlePlayGeneratedAudio}
                  disabled={isGenerating}
                  className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-[#F05637] hover:bg-[#D94B2E] text-white text-xs font-semibold shadow-md shadow-[0_0_15px_rgba(240,86,55,0.3)] transition-all disabled:opacity-50"
                >
                  {isGenerating ? (
                    <>
                      <RotateCcw className="w-4 h-4 animate-spin" />
                      <span>Synthesizing...</span>
                    </>
                  ) : isPlayingAudio ? (
                    <>
                      <Pause className="w-4 h-4" />
                      <span>Pause Speech</span>
                    </>
                  ) : (
                    <>
                      <Play className="w-4 h-4 fill-current" />
                      <span>{generatedAudioUrl ? 'Play Speech' : 'Generate & Play'}</span>
                    </>
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => {
                    audioRef.current?.pause();
                    if (audioRef.current) audioRef.current.currentTime = 0;
                    setIsPlayingAudio(false);
                    setAudioProgress(0);
                  }}
                  className="p-2.5 rounded-xl bg-[#F8FAFC] hover:bg-[#E2E8F0] text-[#64748B] hover:text-[#0F172A] border border-[#E2E8F0] transition-colors"
                  title="Reset"
                >
                  <RotateCcw className="w-4 h-4" />
                </button>
              </div>

              {/* Download & Merge Action Buttons */}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleDownload}
                  disabled={!generatedAudioUrl}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-[#F8FAFC] hover:bg-[#E2E8F0] text-[#0F172A] text-xs font-semibold border border-[#E2E8F0] transition-colors disabled:opacity-40"
                >
                  <Download className="w-3.5 h-3.5 text-[#F05637]" />
                  <span>WAV</span>
                </button>

                <button
                  type="button"
                  onClick={() => setShowAddToVideoModal(true)}
                  className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-[#F05637]/20 hover:bg-[#F05637]/30 border border-[#F05637]/40 text-[#D94B2E] text-xs font-semibold shadow-sm transition-all"
                >
                  <Video className="w-3.5 h-3.5 text-[#F05637]" />
                  <span>Start a Dub</span>
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Right: Language, Voice & Fine Tuning Controls */}
        <div className="lg:col-span-5 space-y-6">
          <div className="rounded-3xl glass-panel p-6 space-y-6 shadow-xl">
            {/* Language Selector */}
            <div className="space-y-2">
              <label className="text-[10px] font-bold uppercase tracking-wider text-[#64748B] flex items-center gap-1.5">
                <Languages className="w-3.5 h-3.5 text-[#F05637]" />
                <span>Select Script Language</span>
              </label>
              <select
                value={selectedLanguageCode}
                onChange={(e) => {
                  setSelectedLanguageCode(e.target.value);
                  setGeneratedAudioUrl(null);
                  const matchingVoice = availableVoices.find((v) => v.languageCode === e.target.value);
                  if (matchingVoice) setSelectedVoiceId(matchingVoice.id);
                }}
                className="w-full p-3 rounded-xl bg-[#F8FAFC] border border-[#E2E8F0] text-[#0F172A] text-xs font-semibold focus:outline-none focus:border-[#F05637]"
              >
                {LANGUAGES.map((lang) => (
                  <option key={lang.code} value={lang.code}>
                    {lang.flag} {lang.name} ({lang.nativeName})
                  </option>
                ))}
              </select>
            </div>

            {/* Voice Cards Picker */}
            <div className="space-y-2.5">
              <div className="flex items-center justify-between">
                <label className="text-[10px] font-bold uppercase tracking-wider text-[#64748B]">
                  Voices
                </label>
                <span className="text-[10px] text-[#94A3B8] font-mono">
                  {availableVoices.length} Voices
                </span>
              </div>

              {/* Clone-your-voice entry point: the reason a user comes to this panel at
                  all is usually to hear their own voice, so it sits above the catalog. */}
              <button
                type="button"
                onClick={() => setShowCloneStudio(true)}
                className="w-full flex items-center gap-2.5 p-3 rounded-2xl border border-dashed border-[#F05637]/50 bg-[#F05637]/5 hover:bg-[#F05637]/10 text-left transition-colors"
              >
                <span className="w-8 h-8 shrink-0 rounded-full bg-[#F05637]/15 text-[#D94B2E] flex items-center justify-center">
                  <Mic className="w-4 h-4" />
                </span>
                <span className="min-w-0">
                  <span className="text-xs font-bold text-[#0F172A] block">
                    {customVoices.length > 0 ? 'Manage your cloned voices' : 'Use my own voice'}
                  </span>
                  <span className="text-[10px] text-[#64748B] block">
                    {customVoices.length > 0
                      ? `${customVoices.length} saved · record another or delete one`
                      : 'Record 5–30 seconds once, then speak any language in your voice'}
                  </span>
                </span>
              </button>

              <div className="space-y-2 max-h-64 overflow-y-auto pr-1 custom-scrollbar">
                {availableVoices.map((v) => {
                  const isSelected = selectedVoiceId === v.id;
                  const isPreviewing = previewingVoiceId === v.id;
                  return (
                    <div
                      key={v.id}
                      onClick={() => {
                        setSelectedVoiceId(v.id);
                        setGeneratedAudioUrl(null);
                      }}
                      className={`flex items-center justify-between p-3 rounded-2xl border cursor-pointer transition-all ${
                        isSelected
                          ? 'bg-[#FFF4F1] border-[#F05637] ring-1 ring-[#F05637] shadow-[0_0_15px_rgba(240,86,55,0.3)]'
                          : 'bg-[#F8FAFC] border-[#E2E8F0] hover:bg-[#E2E8F0]'
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <img
                          src={v.avatarUrl}
                          alt={v.name}
                          className="w-10 h-10 rounded-xl object-cover border border-[#E2E8F0]"
                        />
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-bold text-[#0F172A]">{v.name}</span>
                            <span className="text-[10px] px-1.5 py-0.2 rounded bg-[#E2E8F0] text-[#64748B] font-mono">
                              {v.gender}
                            </span>
                          </div>
                          <span className="text-[11px] text-[#D94B2E] block">{v.accent}</span>
                          <div className="flex items-center gap-1 mt-1">
                            <VoiceProviderBadge provider={v.provider} compact />
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={(e) => handlePreviewVoice(e, v)}
                          className="p-1.5 rounded-lg text-[#64748B] hover:text-[#0F172A] hover:bg-[#E2E8F0] transition-colors"
                          title="Preview Quote"
                        >
                          {isPreviewing ? (
                            <Pause className="w-3.5 h-3.5" />
                          ) : (
                            <Play className="w-3.5 h-3.5 fill-current" />
                          )}
                        </button>
                        {isSelected && <CheckCircle2 className="w-4 h-4 text-[#F05637]" />}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Performance Sliders (Speed, Pitch, Emotion) */}
            <div className="space-y-4 pt-3 border-t border-[#E2E8F0]">
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-[#64748B]">Speed</span>
                  <span className="font-mono text-[#D94B2E] font-bold">{speed.toFixed(2)}x</span>
                </div>
                <input
                  type="range"
                  min={0.8}
                  max={1.2}
                  step={0.05}
                  value={speed}
                  onChange={(e) => {
                    setSpeed(parseFloat(e.target.value));
                    setGeneratedAudioUrl(null);
                  }}
                  className="w-full h-1.5 bg-[#E2E8F0] rounded-lg appearance-none cursor-pointer accent-[#F05637]"
                />
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-[#64748B]">Pitch Shift</span>
                  <span className="font-mono text-[#D94B2E] font-bold">
                    {pitch >= 1 ? `+${Math.round((pitch - 1) * 100)}%` : `-${Math.round((1 - pitch) * 100)}%`}
                  </span>
                </div>
                <input
                  type="range"
                  min={0.9}
                  max={1.1}
                  step={0.02}
                  value={pitch}
                  onChange={(e) => {
                    setPitch(parseFloat(e.target.value));
                    setGeneratedAudioUrl(null);
                  }}
                  className="w-full h-1.5 bg-[#E2E8F0] rounded-lg appearance-none cursor-pointer accent-[#F05637]"
                />
              </div>
            </div>

            {/* Primary Generate Voice CTA */}
            <button
              type="button"
              onClick={() => void handleGenerateVoice()}
              disabled={isGenerating}
              className="w-full flex items-center justify-center gap-2 py-3.5 px-6 rounded-xl bg-[#F05637] hover:bg-[#D94B2E] active:bg-[#B3391F] text-white font-bold text-xs tracking-wide shadow-xl shadow-[0_0_20px_rgba(240,86,55,0.4)] transition-all duration-200 disabled:opacity-50"
            >
              <Sparkles className="w-4 h-4 text-[#ff9d83]" />
              <span>{isGenerating ? 'Synthesizing Neural Speech...' : 'Generate Voice'}</span>
            </button>
          </div>
        </div>
      </div>

      {/* Add to Video Modal */}
      {showAddToVideoModal && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="glass-panel rounded-3xl p-6 max-w-lg w-full space-y-5 shadow-2xl animate-fade-in">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="w-10 h-10 rounded-xl bg-[#F05637]/20 text-[#D94B2E] flex items-center justify-center">
                  <Video className="w-5 h-5" />
                </div>
                <div>
                  <h4 className="text-base font-bold text-[#0F172A]">Start a Video Dub</h4>
                  <p className="text-xs text-[#64748B]">
                    Jump into Video Dubbing Studio with this sample video and {selectedVoice.name} pre-selected.
                  </p>
                </div>
              </div>
            </div>

            <div className="space-y-3">
              <span className="text-xs font-bold text-[#64748B] uppercase tracking-wider block">
                Choose video target:
              </span>
              {SAMPLE_VIDEOS.map((sample) => (
                <div
                  key={sample.id}
                  onClick={() => handleMergeWithVideo(sample.id)}
                  className="group flex items-center gap-3 p-3 rounded-2xl bg-[#F8FAFC] hover:bg-[#E2E8F0] border border-[#E2E8F0] hover:border-[#F05637]/60 cursor-pointer transition-all"
                >
                  <img
                    src={sample.thumbnailUrl}
                    alt={sample.title}
                    className="w-16 h-12 rounded-xl object-cover"
                  />
                  <div className="flex-1 min-w-0">
                    <h5 className="text-xs font-bold text-[#0F172A] group-hover:text-[#D94B2E] truncate">
                      {sample.title}
                    </h5>
                    <span className="text-[11px] text-[#94A3B8] font-mono">
                      {sample.durationFormatted} · {sample.resolution.split(' ')[0]}
                    </span>
                  </div>
                  <ArrowRight className="w-4 h-4 text-[#94A3B8] group-hover:text-[#D94B2E] transition-colors" />
                </div>
              ))}
            </div>

            <div className="flex justify-end gap-2 pt-3 border-t border-[#E2E8F0]">
              <button
                type="button"
                onClick={() => setShowAddToVideoModal(false)}
                className="px-4 py-2 rounded-xl bg-[#F8FAFC] hover:bg-[#E2E8F0] text-xs font-semibold text-[#64748B] hover:text-[#0F172A]"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {showCloneStudio && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 backdrop-blur-sm p-4 sm:p-8"
          onClick={() => setShowCloneStudio(false)}
        >
          <div
            className="w-full max-w-2xl rounded-3xl bg-white border border-[#E2E8F0] shadow-2xl p-6 my-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <VoiceCloneStudio
              onShowToast={onShowToast}
              onVoicesChanged={reloadCustomVoices}
              onClose={() => setShowCloneStudio(false)}
            />
          </div>
        </div>
      )}
    </div>
  );
};
