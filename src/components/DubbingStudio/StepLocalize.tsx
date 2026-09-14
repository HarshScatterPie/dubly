/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import {
  Sparkles,
  ArrowRight,
  RefreshCw,
  Check,
  Edit3,
  Volume2,
  Sliders,
  CheckCircle2,
} from 'lucide-react';
import {
  Language,
  LocalizedSegment,
  TranscriptSegment,
  TranslationStyle,
} from '../../types';
import { LANGUAGES, VOICES } from '../../data/mockData';
import { textToSpeechService } from '../../services/textToSpeechService';

interface StepLocalizeProps {
  sourceLanguageCode: string;
  /** Every language this project will be dubbed into. The first is the primary one. */
  targetLanguageCodes: string[];
  /** Which of those languages the transcript table below is showing and editing. */
  activeLanguageCode: string;
  translationStyle: TranslationStyle;
  adaptExpressions: boolean;
  transcriptSegments: TranscriptSegment[];
  /** The active language's translated lines — the parent picks them out of the per-language map. */
  localizedSegments: LocalizedSegment[];
  isTranslating: boolean;
  hasGeneratedTranslation: boolean;
  /** Which languages already have a translation, so the tabs can mark the rest as pending. */
  translatedLanguageCodes: string[];
  onToggleTargetLanguage: (code: string) => void;
  onSelectActiveLanguage: (code: string) => void;
  onChangeStyle: (style: TranslationStyle) => void;
  onToggleAdaptExpressions: () => void;
  onGenerateTranslation: () => void;
  onUpdateLocalizedSegment: (id: string, text: string) => void;
  onContinueToVoice: () => void;
  onShowToast?: (title: string, desc?: string, type?: 'success' | 'info' | 'error') => void;
}

export const StepLocalize: React.FC<StepLocalizeProps> = ({
  sourceLanguageCode,
  targetLanguageCodes,
  activeLanguageCode,
  translationStyle,
  adaptExpressions,
  transcriptSegments,
  localizedSegments,
  isTranslating,
  hasGeneratedTranslation,
  translatedLanguageCodes,
  onToggleTargetLanguage,
  onSelectActiveLanguage,
  onChangeStyle,
  onToggleAdaptExpressions,
  onGenerateTranslation,
  onUpdateLocalizedSegment,
  onContinueToVoice,
  onShowToast,
}) => {
  const [selectedFilter, setSelectedFilter] = useState<'all' | 'indian' | 'global' | 'asian'>('indian');
  const [searchQuery, setSearchQuery] = useState('');
  const [editingLocId, setEditingLocId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [activeSpeechLocId, setActiveSpeechLocId] = useState<string | null>(null);

  const sourceLang = LANGUAGES.find((l) => l.code === sourceLanguageCode) || LANGUAGES[10];
  const targetLang = LANGUAGES.find((l) => l.code === activeLanguageCode) || LANGUAGES[0];
  const selectedLangs = targetLanguageCodes
    .map((code) => LANGUAGES.find((l) => l.code === code))
    .filter((l): l is Language => Boolean(l));

  const filteredLanguages = LANGUAGES.filter((l) => {
    const matchesFilter =
      selectedFilter === 'all' || l.category === selectedFilter;
    const matchesSearch =
      l.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      l.nativeName.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesFilter && matchesSearch;
  });

  const stylesList: { id: TranslationStyle; label: string; desc: string }[] = [
    { id: 'natural', label: 'Natural', desc: 'Idiomatic native phrasing with emotional flow (Recommended)' },
    { id: 'literal', label: 'Literal', desc: 'Exact direct word-for-word accuracy' },
    { id: 'professional', label: 'Professional', desc: 'Formal business and keynote presentation tone' },
    { id: 'casual', label: 'Casual', desc: 'Relaxed creator tone for YouTube and social media' },
    { id: 'marketing', label: 'Marketing', desc: 'Persuasive, high-impact phrasing with localized punch' },
  ];

  const handleStartEdit = (seg: LocalizedSegment) => {
    setEditingLocId(seg.id);
    setEditText(seg.translatedText);
  };

  const handleSaveEdit = (segId: string) => {
    if (editText.trim()) {
      onUpdateLocalizedSegment(segId, editText.trim());
    }
    setEditingLocId(null);
  };

  const handleSpeakSegment = async (seg: LocalizedSegment) => {
    if (activeSpeechLocId === seg.id) {
      textToSpeechService.stopPlayback();
      setActiveSpeechLocId(null);
      return;
    }
    setActiveSpeechLocId(seg.id);
    const previewVoice = VOICES.find((v) => v.languageCode === activeLanguageCode) || VOICES[0];
    await textToSpeechService.speakText(seg.translatedText, previewVoice, activeLanguageCode, {
      onEnd: () => setActiveSpeechLocId((cur) => (cur === seg.id ? null : cur)),
      onError: (err) => onShowToast?.('Playback Failed', err.message, 'error'),
    });
  };

  const formatTimestamp = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const totalWordsTranslated = localizedSegments.reduce(
    (sum, s) => sum + (s.translatedText.split(/\s+/).filter(Boolean).length || 1),
    0
  );

  return (
    <div className="space-y-8 animate-fade-in">
      {/* Header & Language Selection Card */}
      <div className="glass-panel p-6 sm:p-8 space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-6 border-b border-[#E2E8F0]">
          <div>
            <h3 className="text-xl font-bold text-[#0F172A] tracking-tight">
              Choose your target languages
            </h3>
            <p className="text-xs text-[#64748B] mt-1">
              Pick as many as you need — they all dub from this one upload, in a single run
            </p>
          </div>

          {/* Source to Target Visual Badge */}
          <div className="flex items-center gap-3 p-2 bg-[#F8FAFC] rounded-2xl border border-[#E2E8F0]">
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-[#E2E8F0] text-xs font-semibold text-[#0F172A] shrink-0">
              <span>{sourceLang.flag}</span>
              <span>{sourceLang.name}</span>
            </div>
            <ArrowRight className="w-4 h-4 text-[#F05637] shrink-0" />
            <div className="flex flex-wrap items-center gap-1.5 max-w-[22rem]">
              {selectedLangs.map((lang) => (
                <span
                  key={lang.code}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl bg-[#F05637] text-xs font-semibold text-white shadow-[0_0_15px_rgba(240,86,55,0.3)]"
                >
                  <span>{lang.flag}</span>
                  <span>{lang.name}</span>
                </span>
              ))}
              {selectedLangs.length === 0 && (
                <span className="px-2.5 py-1.5 rounded-xl bg-[#E2E8F0] text-xs font-semibold text-[#64748B]">
                  None selected
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Filter Tabs & Search */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-1.5 p-1 bg-[#F8FAFC] rounded-xl border border-[#E2E8F0] text-xs">
            <button
              type="button"
              onClick={() => setSelectedFilter('indian')}
              className={`px-3 py-1.5 rounded-lg font-semibold transition-all ${
                selectedFilter === 'indian'
                  ? 'bg-[#F05637] text-white shadow-[0_0_10px_rgba(240,86,55,0.4)]'
                  : 'text-[#64748B] hover:text-[#0F172A]'
              }`}
            >
              🇮🇳 Indian Languages (Featured)
            </button>
            <button
              type="button"
              onClick={() => setSelectedFilter('global')}
              className={`px-3 py-1.5 rounded-lg font-semibold transition-all ${
                selectedFilter === 'global'
                  ? 'bg-[#F05637] text-white shadow-[0_0_10px_rgba(240,86,55,0.4)]'
                  : 'text-[#64748B] hover:text-[#0F172A]'
              }`}
            >
              🌍 Global & Americas
            </button>
            <button
              type="button"
              onClick={() => setSelectedFilter('asian')}
              className={`px-3 py-1.5 rounded-lg font-semibold transition-all ${
                selectedFilter === 'asian'
                  ? 'bg-[#F05637] text-white shadow-[0_0_10px_rgba(240,86,55,0.4)]'
                  : 'text-[#64748B] hover:text-[#0F172A]'
              }`}
            >
              🌏 Asian & Middle East
            </button>
            <button
              type="button"
              onClick={() => setSelectedFilter('all')}
              className={`px-3 py-1.5 rounded-lg font-semibold transition-all ${
                selectedFilter === 'all'
                  ? 'bg-[#F05637] text-white shadow-[0_0_10px_rgba(240,86,55,0.4)]'
                  : 'text-[#64748B] hover:text-[#0F172A]'
              }`}
            >
              All ({LANGUAGES.length})
            </button>
          </div>

          <div className="w-full sm:w-64">
            <input
              type="text"
              placeholder="Search language (e.g. Hindi, Tamil)..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full px-3.5 py-1.5 rounded-xl bg-[#F8FAFC] border border-[#E2E8F0] text-xs text-[#0F172A] placeholder-[#94A3B8] focus:outline-none focus:border-[#F05637]"
            />
          </div>
        </div>

        {/* Language Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3 max-h-56 overflow-y-auto custom-scrollbar pr-1">
          {filteredLanguages.map((lang: Language) => {
            const isSelected = targetLanguageCodes.includes(lang.code);
            return (
              <button
                key={lang.code}
                type="button"
                aria-pressed={isSelected}
                onClick={() => onToggleTargetLanguage(lang.code)}
                className={`flex items-center gap-3 p-3 rounded-xl border text-left transition-all duration-150 ${
                  isSelected
                    ? 'bg-[#F05637]/10 border-[#F05637] text-[#D94B2E] shadow-[0_0_15px_rgba(240,86,55,0.25)] ring-1 ring-[#F05637]'
                    : 'bg-[#F8FAFC] border-[#E2E8F0] text-[#0F172A] hover:border-[#CBD5E1] hover:bg-[#E2E8F0]/40'
                }`}
              >
                <span className="text-xl shrink-0">{lang.flag}</span>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-bold truncate flex items-center justify-between">
                    <span>{lang.name}</span>
                    {isSelected && <CheckCircle2 className="w-3.5 h-3.5 text-[#D94B2E]" />}
                  </div>
                  <div className="text-[10px] text-[#64748B] truncate font-sans">
                    {lang.nativeName}
                  </div>
                </div>
              </button>
            );
          })}
        </div>

        {/* Advanced Settings Row: Style + Toggles */}
        <div className="grid grid-cols-1 md:grid-cols-12 gap-6 pt-4 border-t border-[#E2E8F0]">
          {/* Style Selector */}
          <div className="md:col-span-7 space-y-2">
            <label className="text-xs font-bold uppercase tracking-wider text-[#64748B] flex items-center gap-1.5">
              <Sliders className="w-3.5 h-3.5 text-[#F05637]" />
              <span>Translation Style</span>
            </label>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {stylesList.map((style) => (
                <button
                  key={style.id}
                  type="button"
                  onClick={() => onChangeStyle(style.id)}
                  className={`p-2.5 rounded-xl border text-left transition-all ${
                    translationStyle === style.id
                      ? 'bg-[#F05637]/20 border-[#F05637] text-[#0F172A]'
                      : 'bg-[#F8FAFC] border-[#E2E8F0] text-[#64748B] hover:text-[#0F172A]'
                  }`}
                >
                  <span className="text-xs font-bold block">{style.label}</span>
                  <span className="text-[10px] text-[#94A3B8] line-clamp-1 block mt-0.5">
                    {style.desc}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* Toggles */}
          <div className="md:col-span-5 space-y-3">
            <label className="text-xs font-bold uppercase tracking-wider text-[#64748B] block">
              AI Localization Features
            </label>

            {/* Cultural Adaptation Toggle */}
            <div
              onClick={onToggleAdaptExpressions}
              className="flex items-center justify-between p-3 rounded-xl bg-[#F8FAFC] border border-[#E2E8F0] cursor-pointer hover:border-[#CBD5E1] transition-colors"
            >
              <div>
                <span className="text-xs font-bold text-[#0F172A] block">
                  Adapt expressions for native speakers
                </span>
                <span className="text-[10px] text-[#64748B] block">
                  Translates idioms & cultural metaphors naturally
                </span>
              </div>
              <div
                className={`w-9 h-5 rounded-full p-0.5 transition-colors ${
                  adaptExpressions ? 'bg-[#F05637]' : 'bg-slate-100'
                }`}
              >
                <div
                  className={`w-4 h-4 rounded-full bg-white transition-transform ${
                    adaptExpressions ? 'translate-x-4' : 'translate-x-0'
                  }`}
                />
              </div>
            </div>
          </div>
        </div>

        {/* Generate Translation CTA Button */}
        <div className="pt-2">
          <button
            type="button"
            onClick={onGenerateTranslation}
            disabled={isTranslating || selectedLangs.length === 0}
            className="w-full flex items-center justify-center gap-2 py-3.5 px-6 rounded-xl bg-[#F05637] hover:bg-[#D94B2E] active:bg-[#B3391F] text-white font-semibold text-sm shadow-[0_0_25px_rgba(240,86,55,0.3)] transition-all duration-200 disabled:opacity-50"
          >
            {isTranslating ? (
              <>
                <RefreshCw className="w-4 h-4 animate-spin" />
                <span>
                  {selectedLangs.length > 1
                    ? `Translating into ${selectedLangs.length} languages...`
                    : `Translating into ${targetLang.name}...`}
                </span>
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4 text-[#D94B2E]" />
                <span>
                  {hasGeneratedTranslation ? 'Regenerate' : 'Generate'}{' '}
                  {selectedLangs.length > 1
                    ? `Translations (${selectedLangs.length} languages)`
                    : `Translation (${selectedLangs[0]?.name ?? 'no language selected'})`}
                </span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Side-by-Side Translation Comparison */}
      {hasGeneratedTranslation && (
        <div className="space-y-4 animate-fade-in">
          {/* One tab per language: the table below shows and edits whichever is active,
              because reviewing five translations side by side is unreadable. */}
          {selectedLangs.length > 1 && (
            <div className="flex items-center gap-2 overflow-x-auto custom-scrollbar p-1.5 rounded-2xl glass-panel">
              {selectedLangs.map((lang) => {
                const isActive = lang.code === activeLanguageCode;
                const isReady = translatedLanguageCodes.includes(lang.code);
                return (
                  <button
                    key={lang.code}
                    type="button"
                    onClick={() => onSelectActiveLanguage(lang.code)}
                    className={`flex items-center gap-2 shrink-0 px-3.5 py-2 rounded-xl text-xs font-semibold transition-all ${
                      isActive
                        ? 'bg-[#F05637] text-white shadow-[0_0_15px_rgba(240,86,55,0.3)]'
                        : 'bg-[#F8FAFC] text-[#64748B] border border-[#E2E8F0] hover:text-[#0F172A]'
                    }`}
                  >
                    <span>{lang.flag}</span>
                    <span>{lang.name}</span>
                    {isReady ? (
                      <CheckCircle2 className={`w-3.5 h-3.5 ${isActive ? 'text-white' : 'text-emerald-600'}`} />
                    ) : (
                      <span className={`text-[10px] ${isActive ? 'text-white/80' : 'text-[#94A3B8]'}`}>pending</span>
                    )}
                  </button>
                );
              })}
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-4 p-4 rounded-2xl glass-panel">
            <div className="flex items-center gap-3">
              <span className="px-2.5 py-1 rounded-full bg-[#F05637]/20 text-[#D94B2E] text-xs font-semibold border border-[#F05637]/30">
                AI localized {totalWordsTranslated} words into {targetLang.name}
              </span>
              <span className="text-xs text-[#64748B]">
                Aligned across {localizedSegments.length} timestamp segments
                {selectedLangs.length > 1 && ` · ${selectedLangs.length} languages queued for dubbing`}
              </span>
            </div>

            <button
              type="button"
              onClick={onContinueToVoice}
              className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-[#F05637] hover:bg-[#D94B2E] text-white text-xs font-semibold shadow-[0_0_20px_rgba(240,86,55,0.3)] transition-all"
            >
              <span>Continue to Voice</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Dual Column Side-by-Side Table Header */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Left Header */}
            <div className="p-3 rounded-xl bg-[#FFFFFF] border border-[#E2E8F0] flex items-center justify-between text-xs font-bold text-[#0F172A]">
              <div className="flex items-center gap-2">
                <span>{sourceLang.flag}</span>
                <span>Original ({sourceLang.name})</span>
              </div>
              <span className="text-[10px] text-[#64748B] font-mono">Source Cadence</span>
            </div>

            {/* Right Header */}
            <div className="p-3 rounded-xl bg-[#F8FAFC] border border-[#F05637]/40 flex items-center justify-between text-xs font-bold text-[#0F172A]">
              <div className="flex items-center gap-2">
                <span>{targetLang.flag}</span>
                <span>Dubbed ({targetLang.name})</span>
              </div>
              <span className="text-[10px] text-[#D94B2E] font-mono">Editable Translation</span>
            </div>
          </div>

          {/* Dual Column Rows */}
          <div className="space-y-3 max-h-[580px] overflow-y-auto custom-scrollbar pr-1">
            {localizedSegments.map((loc) => {
              const orig = transcriptSegments.find((t) => t.id === loc.segmentId);
              const isEditing = editingLocId === loc.id;
              const isSpeakingThis = activeSpeechLocId === loc.id;

              return (
                <div
                  key={loc.id}
                  className="grid grid-cols-1 lg:grid-cols-2 gap-4 p-4 rounded-xl bg-[#FFFFFF] border border-[#E2E8F0] hover:border-[#CBD5E1] transition-all"
                >
                  {/* Left Column: Original */}
                  <div className="space-y-1.5 pr-2 border-b lg:border-b-0 lg:border-r border-[#E2E8F0] pb-3 lg:pb-0">
                    <div className="flex items-center justify-between text-[11px] font-mono text-[#94A3B8]">
                      <span>
                        {formatTimestamp(loc.startTime)} — {formatTimestamp(loc.endTime)}
                      </span>
                      <span className="text-[#64748B] font-sans">{loc.speaker}</span>
                    </div>
                    <p className="text-xs sm:text-sm text-[#0F172A] leading-relaxed font-sans">
                      "{orig ? orig.text : loc.sourceText}"
                    </p>
                  </div>

                  {/* Right Column: Localized */}
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-[11px] font-mono text-[#D94B2E]">
                      <span className="px-1.5 py-0.5 rounded bg-[#F05637]/20 border border-[#F05637]/30 text-xs">
                        {targetLang.name}
                      </span>

                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => handleSpeakSegment(loc)}
                          className={`p-1.5 rounded-lg transition-colors ${
                            isSpeakingThis
                              ? 'bg-[#F05637] text-white'
                              : 'text-[#64748B] hover:text-[#D94B2E] hover:bg-[#F8FAFC]'
                          }`}
                          title="Preview Pronunciation"
                        >
                          <Volume2 className="w-3.5 h-3.5" />
                        </button>
                        {!isEditing && (
                          <button
                            type="button"
                            onClick={() => handleStartEdit(loc)}
                            className="p-1.5 text-[#64748B] hover:text-[#D94B2E] hover:bg-[#F8FAFC] rounded-lg transition-colors"
                            title="Edit translation"
                          >
                            <Edit3 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </div>

                    {isEditing ? (
                      <div className="space-y-2 mt-1">
                        <textarea
                          value={editText}
                          onChange={(e) => setEditText(e.target.value)}
                          rows={2}
                          className="w-full p-2.5 rounded-xl bg-[#F8FAFC] border border-[#F05637] text-[#0F172A] text-sm focus:outline-none font-sans resize-none"
                        />
                        <div className="flex items-center justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => setEditingLocId(null)}
                            className="px-3 py-1 rounded-lg text-xs text-[#64748B]"
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            onClick={() => handleSaveEdit(loc.id)}
                            className="flex items-center gap-1 px-3 py-1 rounded-lg bg-[#F05637] hover:bg-[#D94B2E] text-white text-xs font-semibold"
                          >
                            <Check className="w-3.5 h-3.5" />
                            <span>Save</span>
                          </button>
                        </div>
                      </div>
                    ) : (
                      <p
                        onClick={() => handleStartEdit(loc)}
                        className="text-xs sm:text-sm text-[#0F172A] font-medium leading-relaxed cursor-pointer hover:text-[#D94B2E] transition-colors"
                      >
                        "{loc.translatedText}"
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
