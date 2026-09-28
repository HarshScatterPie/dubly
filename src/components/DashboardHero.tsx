/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from 'react';
import { Plus, Mic, Languages, Check, Sparkles } from 'lucide-react';
import { DubbingProject, NavigationTab } from '../types';
import { LANGUAGES } from '../data/mockData';
import { projectProgress } from '../lib/projectProgress';
import { useAuth } from '../context/AuthContext';
import scatterPieLogoWhite from '../assets/scatterpie-logo-white.png';

interface DashboardHeroProps {
  projects: DubbingProject[];
  onNavigate: (tab: NavigationTab) => void;
}

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

// A fixed, speech-like envelope for the illustration, so it renders the same every time.
const SOURCE_WAVE = Array.from({ length: 56 }, (_, i) => Math.round(18 + 78 * Math.abs(Math.sin(i * 0.62) * Math.cos(i * 0.21))));
const DUB_WAVE = Array.from({ length: 10 }, (_, i) => Math.round(25 + 70 * Math.abs(Math.sin(i * 0.9 + 1))));

// The illustration: one English line fanned out into dubs, which is the whole product in one picture.
const SAMPLE_DUBS = [
  { code: 'hi', line: 'हमारे नए प्रोडक्ट के लॉन्च में आपका स्वागत है।' },
  { code: 'ta', line: 'எங்கள் புதிய தயாரிப்பின் வெளியீட்டுக்கு வரவேற்கிறோம்.' },
  { code: 'es', line: 'Bienvenidos al lanzamiento de nuestro nuevo producto.' },
].map((d) => ({ ...d, language: LANGUAGES.find((l) => l.code === d.code)! }));

// "Every language." in a few of the languages Dubly speaks; the headline cycles through them.
const EVERY_LANGUAGE = [
  { lang: 'en', text: 'Every language.' },
  { lang: 'hi', text: 'हर भाषा में।' },
  { lang: 'es', text: 'Cada idioma.' },
  { lang: 'ta', text: 'ஒவ்வொரு மொழி.' },
  { lang: 'ja', text: 'すべての言語で。' },
  { lang: 'bn', text: 'প্রতিটি ভাষায়।' },
];
const WORD_MS = 2600;

// The pipeline loop: transcribe, voice each language in turn, then hold on the finished result.
const STEP_MS = 1300;
const PHASES = SAMPLE_DUBS.length + 4;
const LOOP_MS = PHASES * STEP_MS;
type RowState = 'queued' | 'dubbing' | 'ready';
const rowState = (phase: number, i: number): RowState => (phase > i + 1 ? 'ready' : phase === i + 1 ? 'dubbing' : 'queued');

const Wave: React.FC<{ bars: number[]; className?: string; style?: React.CSSProperties }> = ({ bars, className = '', style }) => (
  <div className={`flex items-center gap-[3px] ${className}`} style={style}>
    {bars.map((h, i) => (
      <span key={i} className="w-[3px] shrink-0 rounded-full bg-current" style={{ height: `${h}%` }} />
    ))}
  </div>
);

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

// Eases from the number on screen to the new one, so late-arriving project data counts up rather than jumps.
function useCountUp(target: number, duration = 1100): number {
  const [value, setValue] = useState(() => (prefersReducedMotion() ? target : 0));
  const shown = useRef(value);
  useEffect(() => {
    const from = shown.current;
    if (from === target) return;
    if (prefersReducedMotion()) {
      shown.current = target;
      setValue(target);
      return;
    }
    const start = performance.now();
    let frame = requestAnimationFrame(function step(now) {
      const t = Math.min(1, (now - start) / duration);
      shown.current = Math.round(from + (target - from) * (1 - Math.pow(1 - t, 3)));
      setValue(shown.current);
      if (t < 1) frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, [target, duration]);
  return value;
}

const Stat: React.FC<{ label: string; value: number }> = ({ label, value }) => {
  const shown = useCountUp(value);
  return (
    <div className="flex flex-col px-5 sm:px-8 first:pl-0">
      <dt className="order-2 mt-2 text-xs font-medium text-slate-400 whitespace-nowrap">{label}</dt>
      <dd className="order-1 text-3xl font-bold font-display tabular-nums leading-none text-white">{shown}</dd>
    </div>
  );
};

const RotatingLanguage: React.FC = () => {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (prefersReducedMotion()) return;
    const id = window.setInterval(() => setIndex((i) => (i + 1) % EVERY_LANGUAGE.length), WORD_MS);
    return () => window.clearInterval(id);
  }, []);
  const { lang, text } = EVERY_LANGUAGE[index];
  return (
    <span aria-hidden className="block h-[1.3em] whitespace-nowrap">
      {/* Taller line box than the headline's, so the gradient reaches Indic matras and descenders. */}
      <span
        key={lang}
        lang={lang}
        className="hero-word inline-block leading-[1.3] text-transparent bg-clip-text bg-gradient-to-r from-coral-400 via-amber-200 to-coral-400"
      >
        {text}
      </span>
    </span>
  );
};

const DubPreview: React.FC = () => {
  const [tick, setTick] = useState(() => (prefersReducedMotion() ? PHASES - 1 : 0));
  useEffect(() => {
    if (prefersReducedMotion()) return;
    const id = window.setInterval(() => setTick((t) => t + 1), STEP_MS);
    return () => window.clearInterval(id);
  }, []);

  const phase = tick % PHASES;
  // Remounting the playhead each loop restarts its CSS sweep in step with the timer.
  const loop = Math.floor(tick / PHASES);
  const voicing = SAMPLE_DUBS[phase - 1];
  const status =
    phase === 0
      ? { Icon: Sparkles, text: 'Transcribing the source' }
      : voicing
        ? { Icon: Sparkles, text: `Voicing ${voicing.language.name}` }
        : { Icon: Check, text: `${SAMPLE_DUBS.length} dubs ready` };
  const seconds = Math.round((phase / (PHASES - 1)) * 12);

  return (
    <>
      <div className="rounded-xl bg-white/[0.04] border border-white/10 p-4 backdrop-blur-sm">
        <div className="flex items-center justify-between text-[11px]">
          <span className="flex items-center gap-2 font-semibold uppercase tracking-wider text-slate-300">
            <span className="relative flex w-1.5 h-1.5">
              <span className="absolute inset-0 rounded-full bg-emerald-400 motion-safe:animate-ping" />
              <span className="relative w-1.5 h-1.5 rounded-full bg-emerald-400" />
            </span>
            Source · English
          </span>
          <span className="font-mono tabular-nums text-slate-500">00:{String(seconds).padStart(2, '0')} / 00:12</span>
        </div>
        <div className="relative mt-3 h-10">
          <Wave bars={SOURCE_WAVE} className="absolute inset-0 justify-between text-white/20" />
          <Wave
            key={`lit-${loop}`}
            bars={SOURCE_WAVE}
            className="hero-playhead-lit absolute inset-0 justify-between text-white/80"
            style={{ animationDuration: `${LOOP_MS}ms` }}
          />
          <span
            key={`head-${loop}`}
            className="hero-playhead absolute -top-1 -bottom-1 w-0.5 -ml-px rounded-full bg-coral-400 shadow-[0_0_10px_rgba(250,114,79,0.9)]"
            style={{ animationDuration: `${LOOP_MS}ms` }}
          />
        </div>
        <p className="mt-3 text-sm text-white">&ldquo;Welcome to the launch of our new product.&rdquo;</p>
      </div>

      <div className="relative flex justify-center py-3">
        <span className="absolute inset-y-0 left-1/2 w-px bg-gradient-to-b from-white/15 via-coral-400/50 to-white/15" />
        <span className="hero-flow-dot absolute left-1/2 -ml-[3px] w-1.5 h-1.5 rounded-full bg-coral-300 shadow-[0_0_8px_2px_rgba(250,114,79,0.7)]" />
        <span
          key={status.text}
          className="relative animate-fade-in inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-ink-800 border border-coral-500/40 text-[11px] font-semibold text-coral-300"
        >
          <status.Icon className="w-3 h-3" />
          {status.text}
        </span>
      </div>

      <div className="space-y-2">
        {SAMPLE_DUBS.map(({ code, line, language }, i) => {
          const state = rowState(phase, i);
          return (
            <div
              key={code}
              className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 transition-all duration-500 ${
                state === 'dubbing'
                  ? 'bg-coral-500/[0.08] border-coral-500/50 shadow-[0_0_24px_rgba(240,86,55,0.18)]'
                  : state === 'ready'
                    ? 'bg-white/[0.04] border-white/10'
                    : 'bg-white/[0.02] border-white/5 opacity-50'
              }`}
            >
              <span
                className={`w-9 h-9 shrink-0 rounded-md border font-mono text-[11px] font-bold uppercase flex items-center justify-center transition-colors duration-500 ${
                  state === 'queued' ? 'bg-white/5 border-white/10 text-slate-400' : 'bg-coral-500/15 border-coral-500/25 text-coral-300'
                }`}
              >
                {code}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span lang={code} className="text-xs font-semibold text-white">
                    {language.nativeName}
                  </span>
                  <span className="text-[10px] text-slate-500">{language.name}</span>
                </div>
                <div className="mt-0.5 h-4">
                  {state === 'queued' ? (
                    <span className="block mt-[5px] h-1.5 w-2/3 rounded-full bg-white/10" />
                  ) : (
                    <p lang={code} className="hero-type text-xs leading-4 text-slate-300 truncate">
                      {line}
                    </p>
                  )}
                </div>
              </div>
              <div className="w-[104px] shrink-0 flex items-center justify-end gap-2">
                {state === 'ready' && (
                  <>
                    <Wave bars={DUB_WAVE} className="h-6 text-coral-400/70" />
                    <span className="animate-pop-in w-5 h-5 rounded-full bg-emerald-500/15 text-emerald-400 flex items-center justify-center">
                      <Check className="w-3 h-3" />
                    </span>
                  </>
                )}
                {state === 'dubbing' && (
                  <span className="flex items-center gap-2 text-coral-400">
                    <span className="flex items-center h-6">
                      {Array.from({ length: 6 }, (_, b) => (
                        <span key={b} className="wave-bar" />
                      ))}
                    </span>
                    <span className="text-[10px] font-semibold uppercase tracking-wider">Dubbing</span>
                  </span>
                )}
                {state === 'queued' && <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Queued</span>}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
};

export const DashboardHero: React.FC<DashboardHeroProps> = ({ projects, onNavigate }) => {
  const { user, profile } = useAuth();
  // Same name source as the sidebar; an email is no name to greet anyone by.
  const firstName = (profile?.name || user?.displayName || '').trim().split(/\s+/)[0];

  const progress = projects.map(projectProgress);
  const stats = [
    { label: 'Projects', value: projects.length },
    { label: 'Dubs ready', value: progress.filter((p) => p.complete).length },
    { label: 'Languages', value: new Set(progress.flatMap((p) => p.targetLanguageNames)).size },
  ];

  return (
    <section className="relative overflow-hidden rounded-2xl bg-ink-900 text-white shadow-xl shadow-ink-900/10">
      {/* ScatterPie blue meets Dubly coral, as on the sign-in screen, drifting slowly */}
      <div aria-hidden className="hero-drift pointer-events-none absolute -top-40 -left-32 w-[30rem] h-[30rem] rounded-full bg-[#1D4ED8]/25 blur-3xl" />
      <div aria-hidden className="hero-drift-alt pointer-events-none absolute -bottom-48 -right-24 w-[32rem] h-[32rem] rounded-full bg-coral-500/20 blur-3xl" />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage: 'radial-gradient(rgba(255,255,255,0.07) 1px, transparent 1px)',
          backgroundSize: '22px 22px',
          maskImage: 'radial-gradient(ellipse at 75% 45%, black 10%, transparent 70%)',
          WebkitMaskImage: 'radial-gradient(ellipse at 75% 45%, black 10%, transparent 70%)',
        }}
      />

      {/* minmax(0, …) keeps the columns fixed: sized by content, the rotating headline and the long dub lines reflowed the whole hero */}
      <div className="relative grid lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] gap-10 p-6 sm:p-10">
        {/* Pitch and actions; a size container so the headline scales to fit it */}
        <div className="@container flex flex-col justify-center">
          <div className="hero-rise flex items-center gap-3 text-xs">
            <span className="inline-flex items-center gap-2 font-semibold text-white">
              <span className="w-6 h-6 rounded-md bg-coral-500 flex items-center justify-center shadow-[0_0_15px_rgba(240,86,55,0.45)]">
                <Languages className="w-3.5 h-3.5" />
              </span>
              Dubly Studio
            </span>
            <span className="h-3.5 w-px bg-white/20" />
            <span className="inline-flex items-center gap-2 text-slate-400">
              by
              <img src={scatterPieLogoWhite} alt="ScatterPie" className="h-3 w-auto opacity-90 select-none" draggable={false} />
            </span>
          </div>

          <p className="hero-rise mt-7 text-sm text-slate-400" style={{ animationDelay: '90ms' }}>
            {greeting()}
            {firstName && (
              <>
                , <span className="font-semibold text-white">{firstName}</span>
              </>
            )}
          </p>
          {/* Sized to the column: the widest phrase (~8em) always fits on one line, whichever language is showing */}
          <h2
            className="hero-rise mt-2 text-[length:clamp(1.75rem,11cqw,3rem)] font-extrabold tracking-tight leading-[1.1]"
            style={{ animationDelay: '160ms' }}
          >
            <span className="sr-only">One video. Every language.</span>
            <span aria-hidden className="block">
              One video.
            </span>
            <RotatingLanguage />
          </h2>
          <p className="hero-rise mt-3 text-sm sm:text-base text-slate-300 max-w-lg leading-relaxed" style={{ animationDelay: '240ms' }}>
            ScatterPie&apos;s AI dubbing studio transcribes, translates and re-voices your videos in {LANGUAGES.length} Indian and
            global languages, keeping the speaker&apos;s tone and pacing.
          </p>

          <div className="hero-rise mt-7 flex flex-wrap items-center gap-3" style={{ animationDelay: '320ms' }}>
            <button
              type="button"
              onClick={() => onNavigate('dubbing')}
              className="group relative overflow-hidden flex items-center gap-2 px-5 py-3 rounded-xl bg-coral-500 hover:bg-coral-600 active:bg-coral-700 text-white font-semibold text-sm shadow-[0_0_25px_rgba(240,86,55,0.4)] hover:shadow-[0_0_35px_rgba(240,86,55,0.6)] transition-all duration-200"
            >
              {/* Sheen that sweeps across on hover and snaps back unseen */}
              <span
                aria-hidden
                className="pointer-events-none absolute inset-y-0 -left-1/2 w-1/2 -skew-x-12 bg-gradient-to-r from-transparent via-white/35 to-transparent transition-transform duration-0 group-hover:duration-700 group-hover:translate-x-[300%]"
              />
              <Plus className="relative w-4 h-4 transition-transform duration-300 group-hover:rotate-90" />
              <span className="relative">Start a new dub</span>
            </button>
            <button
              type="button"
              onClick={() => onNavigate('text-to-voice')}
              className="group flex items-center gap-2 px-5 py-3 rounded-xl bg-white/5 hover:bg-white/10 text-white text-sm font-semibold border border-white/15 hover:border-white/25 transition-all"
            >
              <Mic className="w-4 h-4 text-coral-300 transition-transform duration-300 group-hover:scale-110" />
              <span>Script to voiceover</span>
            </button>
          </div>

          <div className="hero-rise mt-9 pt-6 border-t border-white/10" style={{ animationDelay: '400ms' }}>
            {projects.length > 0 ? (
              <dl className="flex divide-x divide-white/10">
                {stats.map((s) => (
                  <Stat key={s.label} label={s.label} value={s.value} />
                ))}
              </dl>
            ) : (
              <ol className="flex flex-wrap gap-x-6 gap-y-3 text-xs text-slate-300">
                {['Upload a video', 'Pick languages and voices', 'Export the dub'].map((step, i) => (
                  <li key={step} className="flex items-center gap-2">
                    <span className="w-5 h-5 rounded-full bg-white/10 text-[10px] font-bold text-white flex items-center justify-center">{i + 1}</span>
                    {step}
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>

        {/* What Dubly does, drawn and looping: one source line becoming several dubs */}
        <div aria-hidden className="hero-rise hidden lg:flex flex-col justify-center" style={{ animationDelay: '220ms' }}>
          <DubPreview />
        </div>
      </div>
    </section>
  );
};
