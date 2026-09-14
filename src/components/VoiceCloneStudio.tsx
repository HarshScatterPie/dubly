/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from 'react';
import { Mic, Square, Upload, Trash2, Play, Pause, Loader2, ShieldCheck, X, Wand2, Volume2 } from 'lucide-react';
import { CustomVoice } from '../types';
import { LANGUAGES } from '../data/mockData';
import { voiceCloneService, CloneEngines } from '../services/voiceCloneService';
import { textToSpeechService } from '../services/textToSpeechService';
import { ConfirmDialog } from './ConfirmDialog';

/** Matches the server's own bounds, so the mic UI can warn before an upload is rejected. */
const MIN_SAMPLE_SECONDS = 5;
const MAX_SAMPLE_SECONDS = 120;

/** What the user is asked to read. Phonetically broad on purpose — a clone built from a sample that only covers a few sounds generalizes badly. */
const READING_SCRIPT =
  'Hello, my name is here and this is my natural speaking voice. ' +
  'I am recording a short sample so it can be used to dub my videos into other languages. ' +
  'The quick brown fox jumps over the lazy dog, while five wizards vex the gnome judge.';

interface VoiceCloneStudioProps {
  onShowToast: (title: string, desc?: string, type?: 'success' | 'info' | 'error') => void;
  /** Lets the parent refresh its voice list when this one changes. */
  onVoicesChanged?: (voices: CustomVoice[]) => void;
  onClose?: () => void;
}

export const VoiceCloneStudio: React.FC<VoiceCloneStudioProps> = ({ onShowToast, onVoicesChanged, onClose }) => {
  const [voices, setVoices] = useState<CustomVoice[]>([]);
  const [cloningAvailable, setCloningAvailable] = useState<boolean>(true);
  const [engines, setEngines] = useState<CloneEngines>({ chatterbox: false, indicf5: false });
  const [isLoading, setIsLoading] = useState<boolean>(true);

  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [elapsed, setElapsed] = useState<number>(0);
  const [pendingClip, setPendingClip] = useState<{ blob: Blob; url: string } | null>(null);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [pendingDeleteVoice, setPendingDeleteVoice] = useState<CustomVoice | null>(null);

  // "Try it" panel: which saved voice is being tested, with what words, in what language.
  // Kept per-voice rather than global so switching voices does not lose what was typed.
  const [tryingVoiceId, setTryingVoiceId] = useState<string | null>(null);
  const [tryText, setTryText] = useState<string>(
    'This is my own voice, and it can now speak any language.'
  );
  const [tryLanguage, setTryLanguage] = useState<string>('en');
  const [isSpeaking, setIsSpeaking] = useState<boolean>(false);

  const [name, setName] = useState<string>('My voice');
  const [gender, setGender] = useState<'male' | 'female' | 'non-binary'>('non-binary');
  const [languageCode, setLanguageCode] = useState<string>('en');

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const pendingUrlRef = useRef<string | null>(null);

  const refresh = async () => {
    try {
      const result = await voiceCloneService.list();
      setVoices(result.voices);
      setCloningAvailable(result.cloningAvailable);
      setEngines(result.engines);
      onVoicesChanged?.(result.voices);
    } catch (err) {
      onShowToast('Could not load your voices', (err as Error).message, 'error');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    return () => {
      // The mic stays open until its tracks are stopped — leaving it on keeps the
      // browser's recording indicator lit long after this panel is gone.
      recorderRef.current?.stream.getTracks().forEach((t) => t.stop());
      if (timerRef.current) clearInterval(timerRef.current);
      if (pendingUrlRef.current) URL.revokeObjectURL(pendingUrlRef.current);
      audioRef.current?.pause();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const replacePendingClip = (blob: Blob | null) => {
    if (pendingUrlRef.current) URL.revokeObjectURL(pendingUrlRef.current);
    if (!blob) {
      pendingUrlRef.current = null;
      setPendingClip(null);
      return;
    }
    const url = URL.createObjectURL(blob);
    pendingUrlRef.current = url;
    setPendingClip({ blob, url });
  };

  const stopRecording = () => {
    recorderRef.current?.stop();
    recorderRef.current?.stream.getTracks().forEach((t) => t.stop());
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    setIsRecording(false);
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        // Browser-side cleanup before the clone ever sees the audio: echo and steady
        // background noise are exactly what makes a zero-shot clone sound wrong.
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        replacePendingClip(new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' }));
      };
      recorder.start();
      recorderRef.current = recorder;
      setElapsed(0);
      setIsRecording(true);
      timerRef.current = setInterval(() => {
        setElapsed((prev) => {
          const next = prev + 1;
          // Hard stop at the server's ceiling rather than letting the upload be rejected.
          if (next >= MAX_SAMPLE_SECONDS) stopRecording();
          return next;
        });
      }, 1000);
    } catch (err) {
      onShowToast('Microphone Blocked', (err as Error).message || 'Allow microphone access to record a sample.', 'error');
    }
  };

  const handlePickFile = (file: File) => {
    replacePendingClip(file);
    setElapsed(0);
  };

  const handleSave = async () => {
    if (!pendingClip) return;
    setIsSaving(true);
    try {
      await voiceCloneService.create(pendingClip.blob, { name: name.trim() || 'My voice', gender, languageCode });
      replacePendingClip(null);
      setName('My voice');
      await refresh();
      onShowToast('Voice Saved', 'Your voice is now selectable anywhere a built-in voice is.', 'success');
    } catch (err) {
      onShowToast('Could Not Save Voice', (err as Error).message, 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (voice: CustomVoice) => {
    try {
      await voiceCloneService.delete(voice.id);
      await refresh();
      onShowToast('Voice Deleted', `${voice.name} and its recording were removed.`, 'info');
    } catch (err) {
      onShowToast('Delete Failed', (err as Error).message, 'error');
    }
  };

  /**
   * Speaks whatever the user typed in their own cloned voice.
   *
   * Goes through the same TTS endpoint the dub pipeline uses, with the same cloned voice
   * id — so what you hear here is exactly what a render would produce, not a separate
   * preview path that could drift from it.
   */
  const handleTrySpeak = async (voice: CustomVoice) => {
    if (!tryText.trim()) {
      onShowToast('Nothing to say', 'Type some text to hear it in your voice.', 'info');
      return;
    }
    if (isSpeaking) {
      textToSpeechService.stopPlayback();
      setIsSpeaking(false);
      return;
    }
    audioRef.current?.pause();
    setPlayingId(null);
    setIsSpeaking(true);
    await textToSpeechService.speakText(
      tryText.trim(),
      voiceCloneService.toVoice(voice),
      tryLanguage,
      {
        onEnd: () => setIsSpeaking(false),
        onError: (err) => {
          setIsSpeaking(false);
          onShowToast('Could Not Speak', err.message, 'error');
        },
      }
    );
  };

  const handlePlaySample = (voice: CustomVoice) => {
    if (!voice.sampleAudioUrl) return;
    if (playingId === voice.id) {
      audioRef.current?.pause();
      setPlayingId(null);
      return;
    }
    audioRef.current?.pause();
    const audio = new Audio(voice.sampleAudioUrl);
    audio.onended = () => setPlayingId(null);
    audio.onerror = () => setPlayingId(null);
    audioRef.current = audio;
    setPlayingId(voice.id);
    void audio.play();
  };

  const tooShort = elapsed > 0 && elapsed < MIN_SAMPLE_SECONDS;

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-xl font-bold text-[#0F172A] tracking-tight">Your own voice</h3>
          <p className="text-xs text-[#64748B] mt-1">
            Record about {MIN_SAMPLE_SECONDS}–30 seconds once. Dubly then speaks any language in your voice.
          </p>
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="p-1.5 rounded-lg text-[#64748B] hover:text-[#0F172A] hover:bg-[#F8FAFC] transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {!isLoading && !cloningAvailable && (
        <div className="p-4 rounded-2xl bg-amber-50 border border-amber-200 text-xs text-amber-900 space-y-1.5">
          <p className="font-bold">Voice cloning is not installed on this server yet.</p>
          <p>
            Add an engine to the server venv, then reload — no other setup is needed:
          </p>
          <code className="block p-2 rounded-lg bg-amber-100/70 font-mono text-[11px] leading-relaxed">
            server/lipsync/venv/Scripts/pip install chatterbox-tts{'\n'}
            server/lipsync/venv/Scripts/pip install f5-tts
          </code>
          <p className="text-[11px]">
            Chatterbox covers 23 languages including Hindi and runs faster than realtime on CPU. f5-tts adds the other
            ten Indian languages (Tamil, Telugu, Bengali, Kannada, Malayalam, Marathi, Gujarati, Punjabi, Odia, Assamese).
          </p>
        </div>
      )}

      {cloningAvailable && (
        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 font-semibold">
            <ShieldCheck className="w-3 h-3" />
            Runs on this server — your recording is never sent to a voice vendor
          </span>
          <span className="px-2.5 py-1 rounded-full bg-[#F8FAFC] border border-[#E2E8F0] text-[#64748B]">
            Engines: {engines.chatterbox ? 'Chatterbox' : ''}
            {engines.chatterbox && engines.indicf5 ? ' + ' : ''}
            {engines.indicf5 ? 'IndicF5' : ''}
          </span>
        </div>
      )}

      {/* Recorder */}
      <div className="rounded-3xl glass-panel p-6 space-y-4">
        <div className="p-3 rounded-xl bg-[#F8FAFC] border border-[#E2E8F0]">
          <span className="text-[10px] font-bold uppercase tracking-wider text-[#64748B]">Read this aloud</span>
          <p className="text-xs text-[#0F172A] leading-relaxed mt-1 font-sans">{READING_SCRIPT}</p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {!isRecording ? (
            <button
              type="button"
              onClick={startRecording}
              disabled={!cloningAvailable}
              className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[#F05637] hover:bg-[#D94B2E] text-white text-xs font-bold shadow-[0_0_20px_rgba(240,86,55,0.3)] transition-all disabled:opacity-50"
            >
              <Mic className="w-4 h-4" />
              <span>Record</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={stopRecording}
              className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[#0F172A] hover:bg-slate-800 text-white text-xs font-bold transition-all"
            >
              <Square className="w-4 h-4" />
              <span>Stop ({elapsed}s)</span>
            </button>
          )}

          <label
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[#F8FAFC] hover:bg-[#E2E8F0] border border-[#E2E8F0] text-[#0F172A] text-xs font-semibold transition-colors ${
              cloningAvailable ? 'cursor-pointer' : 'opacity-50 cursor-not-allowed'
            }`}
          >
            <Upload className="w-3.5 h-3.5 text-[#D94B2E]" />
            <span>Upload a recording</span>
            <input
              type="file"
              accept="audio/*"
              disabled={!cloningAvailable}
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handlePickFile(file);
                e.target.value = '';
              }}
            />
          </label>

          {isRecording && (
            <span className="flex items-center gap-1.5 text-xs text-[#D94B2E] font-semibold">
              <span className="w-2 h-2 rounded-full bg-[#F05637] animate-pulse" />
              Recording
            </span>
          )}
        </div>

        {tooShort && !isRecording && (
          <p className="text-[11px] text-amber-700">
            That was only {elapsed}s — record at least {MIN_SAMPLE_SECONDS}s or the clone comes out unstable.
          </p>
        )}

        {pendingClip && (
          <div className="space-y-3 pt-3 border-t border-[#E2E8F0]">
            <audio src={pendingClip.url} controls className="w-full h-9" />
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <label className="space-y-1">
                <span className="text-[10px] font-bold uppercase tracking-wider text-[#64748B]">Name</span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-[#F8FAFC] border border-[#E2E8F0] text-xs text-[#0F172A] focus:outline-none focus:border-[#F05637]"
                />
              </label>
              <label className="space-y-1">
                <span className="text-[10px] font-bold uppercase tracking-wider text-[#64748B]">Voice type</span>
                <select
                  value={gender}
                  onChange={(e) => setGender(e.target.value as typeof gender)}
                  className="w-full px-3 py-2 rounded-xl bg-[#F8FAFC] border border-[#E2E8F0] text-xs text-[#0F172A] focus:outline-none focus:border-[#F05637]"
                >
                  <option value="non-binary">Unspecified</option>
                  <option value="male">Male</option>
                  <option value="female">Female</option>
                </select>
              </label>
              <label className="space-y-1">
                <span className="text-[10px] font-bold uppercase tracking-wider text-[#64748B]">Recorded in</span>
                <select
                  value={languageCode}
                  onChange={(e) => setLanguageCode(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-[#F8FAFC] border border-[#E2E8F0] text-xs text-[#0F172A] focus:outline-none focus:border-[#F05637]"
                >
                  {LANGUAGES.map((l) => (
                    <option key={l.code} value={l.code}>
                      {l.flag} {l.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleSave}
                disabled={isSaving}
                className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[#F05637] hover:bg-[#D94B2E] text-white text-xs font-bold transition-all disabled:opacity-50"
              >
                {isSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5" />}
                <span>{isSaving ? 'Saving & transcribing...' : 'Save this voice'}</span>
              </button>
              <button
                type="button"
                onClick={() => replacePendingClip(null)}
                className="px-3 py-2 rounded-xl text-xs text-[#64748B] hover:text-[#0F172A]"
              >
                Discard
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Saved voices */}
      {voices.length > 0 && (
        <div className="space-y-2">
          <span className="text-xs font-bold uppercase tracking-wider text-[#64748B]">
            Your voices ({voices.length})
          </span>
          {voices.map((voice) => (
            <div key={voice.id} className="p-3 rounded-2xl bg-[#FFFFFF] border border-[#E2E8F0]">
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => handlePlaySample(voice)}
                  disabled={!voice.sampleAudioUrl}
                  className="w-9 h-9 shrink-0 rounded-full bg-[#F05637]/10 text-[#D94B2E] flex items-center justify-center hover:bg-[#F05637]/20 transition-colors disabled:opacity-40"
                  title="Play the recording this voice was built from"
                >
                  {playingId === voice.id ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                </button>
                <div className="min-w-0 flex-1">
                  <span className="text-xs font-bold text-[#0F172A] block truncate">{voice.name}</span>
                  <span className="text-[10px] text-[#64748B] block truncate">
                    {voice.sampleTranscript ? `"${voice.sampleTranscript.slice(0, 90)}..."` : 'No transcript captured'}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setTryingVoiceId((cur) => (cur === voice.id ? null : voice.id));
                    textToSpeechService.stopPlayback();
                    setIsSpeaking(false);
                  }}
                  className={`flex items-center gap-1.5 shrink-0 px-3 py-1.5 rounded-lg text-[11px] font-semibold border transition-colors ${
                    tryingVoiceId === voice.id
                      ? 'bg-[#F05637] text-white border-[#F05637]'
                      : 'bg-[#F8FAFC] text-[#0F172A] border-[#E2E8F0] hover:border-[#F05637]/60'
                  }`}
                  title="Type something and hear it in this voice"
                >
                  <Wand2 className="w-3 h-3" />
                  <span>Try it</span>
                </button>
                <button
                  type="button"
                  onClick={() => setPendingDeleteVoice(voice)}
                  className="p-2 shrink-0 rounded-lg text-[#64748B] hover:text-red-600 hover:bg-red-50 transition-colors"
                  title="Delete this voice and its recording"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>

              {tryingVoiceId === voice.id && (
                <div className="mt-3 pt-3 border-t border-[#E2E8F0] space-y-3">
                  <textarea
                    value={tryText}
                    onChange={(e) => setTryText(e.target.value)}
                    rows={3}
                    placeholder="Type anything — in any language you pick below"
                    className="w-full p-3 rounded-xl bg-[#F8FAFC] border border-[#E2E8F0] text-xs text-[#0F172A] placeholder-[#94A3B8] focus:outline-none focus:border-[#F05637] resize-none font-sans"
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      value={tryLanguage}
                      onChange={(e) => setTryLanguage(e.target.value)}
                      className="px-3 py-2 rounded-xl bg-[#F8FAFC] border border-[#E2E8F0] text-xs text-[#0F172A] focus:outline-none focus:border-[#F05637]"
                    >
                      {LANGUAGES.map((l) => (
                        <option key={l.code} value={l.code}>
                          {l.flag} {l.name}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => handleTrySpeak(voice)}
                      className="flex items-center gap-2 px-4 py-2 rounded-xl bg-[#F05637] hover:bg-[#D94B2E] text-white text-xs font-bold transition-colors"
                    >
                      {isSpeaking ? (
                        <>
                          <Square className="w-3 h-3" />
                          <span>Stop</span>
                        </>
                      ) : (
                        <>
                          <Volume2 className="w-3.5 h-3.5" />
                          <span>Speak in my voice</span>
                        </>
                      )}
                    </button>
                    <span className="text-[10px] text-[#94A3B8]">
                      First line can take a few seconds while the model warms up
                    </span>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <ConfirmDialog
        isOpen={pendingDeleteVoice !== null}
        title="Delete this voice?"
        description={`This permanently removes "${pendingDeleteVoice?.name ?? ''}" and its recording. Any dubs already rendered in this voice are unaffected, but you won't be able to generate new lines in it.`}
        confirmLabel="Delete Voice"
        onCancel={() => setPendingDeleteVoice(null)}
        onConfirm={() => {
          if (pendingDeleteVoice) void handleDelete(pendingDeleteVoice);
          setPendingDeleteVoice(null);
        }}
      />
    </div>
  );
};
