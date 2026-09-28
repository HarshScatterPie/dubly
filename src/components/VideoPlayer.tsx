/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Maximize2, Minimize2, Pause, Play, RotateCcw, Subtitles, Volume2, VolumeX } from 'lucide-react';
import { LocalizedSegment, TranscriptSegment } from '../types';
import { activeCaptionCard, buildCaptionCards, spokenSpan, type CaptionLine } from '../lib/captionCues';

interface VideoPlayerProps {
  src: string;
  /** Original (pre-dub) source — when provided, the "Original" switch actually swaps to this file instead of being cosmetic. */
  originalSrc?: string;
  poster?: string;
  transcriptSegments?: TranscriptSegment[];
  localizedSegments?: LocalizedSegment[];
  activeLanguageName?: string;
  currentTime?: number;
  /** When true, an external `currentTime` seek also starts playback (used for "play this line" jump-to actions). */
  autoPlayOnSeek?: boolean;
  onTimeUpdate?: (time: number) => void;
  showAudioTrackSwitch?: boolean;
  activeAudioTrack?: 'original' | 'dubbed';
  onToggleAudioTrack?: (track: 'original' | 'dubbed') => void;
  className?: string;
  autoPlay?: boolean;
  onSegmentClick?: (segment: TranscriptSegment | LocalizedSegment) => void;
  /** Tallest the picture may get; vertical videos stay inside it instead of pushing the page down. */
  maxHeightClass?: string;
}

const formatTime = (seconds: number) => {
  if (!Number.isFinite(seconds)) return '00:00';
  const whole = Math.max(0, Math.floor(seconds));
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};

const SPEEDS = [0.75, 1, 1.25, 1.5, 2];

export const VideoPlayer: React.FC<VideoPlayerProps> = ({
  src,
  originalSrc,
  poster,
  transcriptSegments = [],
  localizedSegments = [],
  activeLanguageName = 'Dubbed',
  currentTime: externalCurrentTime,
  autoPlayOnSeek = false,
  onTimeUpdate,
  showAudioTrackSwitch = false,
  activeAudioTrack = 'dubbed',
  onToggleAudioTrack,
  className = '',
  autoPlay = false,
  maxHeightClass = 'max-h-[560px]',
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const scrubberRef = useRef<HTMLDivElement | null>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [isWaiting, setIsWaiting] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(0.9);
  const [isMuted, setIsMuted] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [showSubtitles, setShowSubtitles] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [hover, setHover] = useState<{ x: number; time: number } | null>(null);
  const hideControlsTimer = useRef<number | null>(null);
  const playingRef = useRef(false);
  playingRef.current = isPlaying;

  const showingOriginal = showAudioTrackSwitch && activeAudioTrack === 'original' && Boolean(originalSrc);
  const activeSrc = showingOriginal ? originalSrc! : src;

  // Sync with an external seek (a transcript line clicked, say).
  useEffect(() => {
    const el = videoRef.current;
    if (externalCurrentTime === undefined || !el) return;
    if (Math.abs(el.currentTime - externalCurrentTime) > 0.25) {
      el.currentTime = externalCurrentTime;
      setCurrentTime(externalCurrentTime);
    }
    if (autoPlayOnSeek) el.play().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalCurrentTime]);

  // Swapping the audio track swaps the whole file (a browser cannot switch the audio of two separate files), so keep position and play state across it.
  const resumeRef = useRef<{ at: number; play: boolean } | null>(null);
  const previousSrc = useRef(activeSrc);
  if (previousSrc.current !== activeSrc) {
    resumeRef.current = { at: videoRef.current?.currentTime ?? currentTime, play: playingRef.current };
    previousSrc.current = activeSrc;
  }

  useEffect(() => {
    const onChange = () => setIsFullscreen(document.fullscreenElement === containerRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  // Captions: the dubbed lines when there are any, otherwise the transcript. Cards are timed to where the dub speaks each line.
  const captionLines: CaptionLine[] = useMemo(
    () =>
      localizedSegments.length
        ? localizedSegments
        : transcriptSegments.map((s) => ({ startTime: s.startTime, endTime: s.endTime, translatedText: s.text })),
    [localizedSegments, transcriptSegments]
  );
  const cards = useMemo(() => buildCaptionCards(captionLines), [captionLines]);
  const card = showSubtitles ? activeCaptionCard(cards, currentTime) : null;
  // Faint marks on the scrubber where someone is speaking, so a line is easy to find.
  const dialogueMarks = useMemo(
    () => (duration > 0 ? captionLines.filter((l) => l.translatedText.trim()).map(spokenSpan) : []),
    [captionLines, duration]
  );

  const play = () => videoRef.current?.play().catch(() => undefined);
  const togglePlay = () => {
    const el = videoRef.current;
    if (!el) return;
    if (el.paused) play();
    else el.pause();
  };

  const seekTo = (time: number) => {
    const el = videoRef.current;
    if (!el) return;
    const clamped = Math.max(0, Math.min(duration || el.duration || 0, time));
    el.currentTime = clamped;
    setCurrentTime(clamped);
    onTimeUpdate?.(clamped);
  };

  const timeAtPointer = (clientX: number) => {
    const rect = scrubberRef.current?.getBoundingClientRect();
    if (!rect || !duration) return 0;
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * duration;
  };

  const dragging = useRef(false);
  const onScrubDown = (e: React.PointerEvent<HTMLDivElement>) => {
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    seekTo(timeAtPointer(e.clientX));
  };
  const onScrubMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = scrubberRef.current?.getBoundingClientRect();
    if (rect) setHover({ x: Math.max(0, Math.min(rect.width, e.clientX - rect.left)), time: timeAtPointer(e.clientX) });
    if (dragging.current) seekTo(timeAtPointer(e.clientX));
  };

  const setVolumeLevel = (value: number) => {
    const el = videoRef.current;
    setVolume(value);
    setIsMuted(value === 0);
    if (el) {
      el.volume = value;
      el.muted = value === 0;
    }
  };

  const toggleMute = () => {
    const el = videoRef.current;
    if (!el) return;
    el.muted = !isMuted;
    setIsMuted(!isMuted);
  };

  const cycleSpeed = () => {
    const next = SPEEDS[(SPEEDS.indexOf(playbackRate) + 1) % SPEEDS.length];
    setPlaybackRate(next);
    if (videoRef.current) videoRef.current.playbackRate = next;
  };

  const toggleFullscreen = () => {
    if (!containerRef.current) return;
    if (!document.fullscreenElement) containerRef.current.requestFullscreen().catch(() => undefined);
    else document.exitFullscreen().catch(() => undefined);
  };

  const revealControls = () => {
    setShowControls(true);
    if (hideControlsTimer.current) window.clearTimeout(hideControlsTimer.current);
    hideControlsTimer.current = window.setTimeout(() => {
      if (playingRef.current) setShowControls(false);
    }, 2600);
  };

  // Shortcuts only while the player has focus, so typing elsewhere on the page is never hijacked.
  const onKeyDown = (e: React.KeyboardEvent) => {
    const el = videoRef.current;
    if (!el || (e.target as HTMLElement).tagName === 'INPUT') return;
    const key = e.key.toLowerCase();
    const handled = [' ', 'k', 'j', 'l', 'arrowleft', 'arrowright', 'm', 'c', 'f'].includes(key);
    if (!handled) return;
    e.preventDefault();
    revealControls();
    if (key === ' ' || key === 'k') togglePlay();
    else if (key === 'j' || key === 'arrowleft') seekTo(el.currentTime - 5);
    else if (key === 'l' || key === 'arrowright') seekTo(el.currentTime + 5);
    else if (key === 'm') toggleMute();
    else if (key === 'c') setShowSubtitles((v) => !v);
    else if (key === 'f') toggleFullscreen();
  };

  const progress = duration ? (currentTime / duration) * 100 : 0;
  const controlsVisible = showControls || !isPlaying;

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onMouseMove={revealControls}
      onMouseLeave={() => isPlaying && setShowControls(false)}
      className={`player-stage group relative overflow-hidden rounded-2xl bg-black flex items-center justify-center outline-none focus-visible:ring-2 focus-visible:ring-coral-400 ${isFullscreen ? '' : className}`}
    >
      <video
        ref={videoRef}
        src={activeSrc}
        poster={poster}
        playsInline
        preload="metadata"
        autoPlay={autoPlay}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onEnded={() => setIsPlaying(false)}
        onWaiting={() => setIsWaiting(true)}
        onPlaying={() => setIsWaiting(false)}
        onCanPlay={() => setIsWaiting(false)}
        onTimeUpdate={(e) => {
          const t = e.currentTarget.currentTime;
          setCurrentTime(t);
          onTimeUpdate?.(t);
        }}
        onProgress={(e) => {
          const el = e.currentTarget;
          if (el.buffered.length && el.duration) setBuffered((el.buffered.end(el.buffered.length - 1) / el.duration) * 100);
        }}
        onLoadedMetadata={(e) => {
          const el = e.currentTarget;
          setDuration(el.duration || 0);
          el.volume = volume;
          el.muted = isMuted;
          el.playbackRate = playbackRate;
          const resume = resumeRef.current;
          if (resume) {
            el.currentTime = Math.min(resume.at, el.duration || resume.at);
            if (resume.play) el.play().catch(() => undefined);
            resumeRef.current = null;
          }
        }}
        onClick={togglePlay}
        className={`w-full h-full object-contain cursor-pointer ${isFullscreen ? 'max-h-screen' : maxHeightClass}`}
      />

      {/* Dubbed / Original switch */}
      {showAudioTrackSwitch && originalSrc && (
        <div className={`absolute top-3 left-3 z-20 flex items-center p-1 rounded-xl bg-black/55 backdrop-blur-md border border-white/10 transition-opacity ${controlsVisible ? 'opacity-100' : 'opacity-0'}`}>
          {(['dubbed', 'original'] as const).map((track) => (
            <button
              key={track}
              type="button"
              onClick={() => onToggleAudioTrack?.(track)}
              className={`px-3 py-1.5 rounded-lg text-[11px] font-semibold transition-all ${
                activeAudioTrack === track ? 'bg-white text-[#0F172A] shadow' : 'text-white/75 hover:text-white'
              }`}
            >
              {track === 'dubbed' ? activeLanguageName : 'Original'}
            </button>
          ))}
        </div>
      )}

      {/* Captions: the spoken words light up as the voice reaches them */}
      {card && (
        <div className={`absolute left-0 right-0 z-20 flex justify-center px-[6%] pointer-events-none transition-[bottom] duration-300 ${controlsVisible ? 'bottom-[76px]' : 'bottom-[7%]'}`}>
          <p
            key={card.start}
            className="caption-text max-w-[88%] text-center font-semibold leading-snug px-[0.6em] py-[0.25em] rounded-[0.45em] bg-black/65 backdrop-blur-sm [text-shadow:0_1px_2px_rgba(0,0,0,0.6)] animate-fade-in"
          >
            {card.words.map((w, i) => {
              const state = currentTime >= w.end ? 'spoken' : currentTime >= w.start ? 'current' : 'upcoming';
              return (
                <span
                  key={i}
                  className={`transition-colors duration-100 ${state === 'current' ? 'text-coral-300' : state === 'spoken' ? 'text-white' : 'text-white/55'}`}
                >
                  {w.text}
                  {w.space && i < card.words.length - 1 ? ' ' : ''}
                </span>
              );
            })}
          </p>
        </div>
      )}

      {isWaiting && isPlaying && (
        <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
          <Loader2 className="w-10 h-10 text-white/90 animate-spin" />
        </div>
      )}

      {!isPlaying && (
        <button
          type="button"
          onClick={togglePlay}
          aria-label="Play"
          className="absolute z-10 w-16 h-16 rounded-full bg-white/95 text-[#0F172A] flex items-center justify-center shadow-2xl hover:scale-105 active:scale-95 transition-transform"
        >
          <Play className="w-7 h-7 fill-current translate-x-0.5" />
        </button>
      )}

      {/* Controls */}
      <div
        className={`absolute bottom-0 left-0 right-0 z-30 px-3 sm:px-4 pb-3 pt-10 bg-gradient-to-t from-black/85 via-black/45 to-transparent transition-opacity duration-300 ${
          controlsVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
      >
        <div
          ref={scrubberRef}
          role="slider"
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(currentTime)}
          onPointerDown={onScrubDown}
          onPointerMove={onScrubMove}
          onPointerUp={() => (dragging.current = false)}
          onPointerLeave={() => setHover(null)}
          className="relative h-4 flex items-center cursor-pointer group/scrub touch-none"
        >
          <div className="relative w-full h-1 group-hover/scrub:h-1.5 transition-all rounded-full bg-white/20 overflow-hidden">
            <div className="absolute inset-y-0 left-0 bg-white/25" style={{ width: `${buffered}%` }} />
            {dialogueMarks.map((m, i) => (
              <div
                key={i}
                className="absolute inset-y-0 bg-white/20"
                style={{ left: `${(m.start / duration) * 100}%`, width: `${Math.max(0.3, ((m.end - m.start) / duration) * 100)}%` }}
              />
            ))}
            <div className="absolute inset-y-0 left-0 bg-coral-500" style={{ width: `${progress}%` }} />
          </div>
          <div
            className="absolute w-3 h-3 -ml-1.5 rounded-full bg-white shadow opacity-0 group-hover/scrub:opacity-100 transition-opacity"
            style={{ left: `${progress}%` }}
          />
          {hover && (
            <span
              className="absolute -top-7 -translate-x-1/2 px-1.5 py-0.5 rounded bg-black/80 text-[10px] font-mono text-white pointer-events-none"
              style={{ left: hover.x }}
            >
              {formatTime(hover.time)}
            </span>
          )}
        </div>

        <div className="mt-1.5 flex items-center justify-between gap-3">
          <div className="flex items-center gap-1.5 sm:gap-2">
            <button type="button" onClick={togglePlay} className="p-1.5 text-white rounded-lg hover:bg-white/10" title={isPlaying ? 'Pause (K)' : 'Play (K)'}>
              {isPlaying ? <Pause className="w-5 h-5 fill-current" /> : <Play className="w-5 h-5 fill-current" />}
            </button>
            <button type="button" onClick={() => { seekTo(0); play(); }} className="hidden sm:block p-1.5 text-white/80 hover:text-white rounded-lg hover:bg-white/10" title="Restart">
              <RotateCcw className="w-4 h-4" />
            </button>
            <div className="flex items-center gap-1 group/vol">
              <button type="button" onClick={toggleMute} className="p-1.5 text-white/80 hover:text-white rounded-lg hover:bg-white/10" title="Mute (M)">
                {isMuted || volume === 0 ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
              </button>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={isMuted ? 0 : volume}
                onChange={(e) => setVolumeLevel(parseFloat(e.target.value))}
                aria-label="Volume"
                className="w-0 group-hover/vol:w-16 focus:w-16 transition-all h-1 accent-white cursor-pointer"
              />
            </div>
            <span className="text-[11px] font-mono text-white/85 tabular-nums">
              {formatTime(currentTime)} <span className="text-white/40">/</span> {formatTime(duration)}
            </span>
          </div>

          <div className="flex items-center gap-1">
            {cards.length > 0 && (
              <button
                type="button"
                onClick={() => setShowSubtitles((v) => !v)}
                aria-pressed={showSubtitles}
                className={`flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-bold transition-colors ${
                  showSubtitles ? 'bg-white text-[#0F172A]' : 'text-white/80 hover:text-white hover:bg-white/10'
                }`}
                title="Captions (C)"
              >
                <Subtitles className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">CC</span>
              </button>
            )}
            <button type="button" onClick={cycleSpeed} className="px-2 py-1 rounded-lg text-[11px] font-mono font-semibold text-white/85 hover:text-white hover:bg-white/10" title="Playback speed">
              {playbackRate}x
            </button>
            <button type="button" onClick={toggleFullscreen} className="p-1.5 text-white/80 hover:text-white rounded-lg hover:bg-white/10" title="Fullscreen (F)">
              {isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
