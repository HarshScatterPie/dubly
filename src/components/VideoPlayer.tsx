/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useRef, useState, useEffect } from 'react';
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  Maximize2,
  Minimize2,
  Subtitles,
  Sparkles,
  RotateCcw,
} from 'lucide-react';
import { LocalizedSegment, TranscriptSegment } from '../types';

interface VideoPlayerProps {
  src: string;
  /** Original (pre-dub) source — when provided, the "Original Audio" toggle actually swaps to this file instead of being cosmetic. */
  originalSrc?: string;
  poster?: string;
  transcriptSegments?: TranscriptSegment[];
  localizedSegments?: LocalizedSegment[];
  activeLanguageName?: string;
  currentTime?: number;
  /** When true, an external `currentTime` seek also starts playback (used for "play this transcript segment" jump-to actions). */
  autoPlayOnSeek?: boolean;
  onTimeUpdate?: (time: number) => void;
  showAudioTrackSwitch?: boolean;
  activeAudioTrack?: 'original' | 'dubbed';
  onToggleAudioTrack?: (track: 'original' | 'dubbed') => void;
  className?: string;
  autoPlay?: boolean;
  onSegmentClick?: (segment: TranscriptSegment | LocalizedSegment) => void;
}

export const VideoPlayer: React.FC<VideoPlayerProps> = ({
  src,
  originalSrc,
  poster,
  transcriptSegments = [],
  localizedSegments = [],
  activeLanguageName = 'Hindi',
  currentTime: externalCurrentTime,
  autoPlayOnSeek = false,
  onTimeUpdate,
  showAudioTrackSwitch = false,
  activeAudioTrack = 'dubbed',
  onToggleAudioTrack,
  className = '',
  autoPlay = false,
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(0.9);
  const [isMuted, setIsMuted] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [showSubtitles, setShowSubtitles] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const hideControlsTimer = useRef<number | null>(null);

  // Sync with external time seek if provided
  useEffect(() => {
    if (externalCurrentTime !== undefined && videoRef.current) {
      if (Math.abs(videoRef.current.currentTime - externalCurrentTime) > 0.5) {
        videoRef.current.currentTime = externalCurrentTime;
        setCurrentTime(externalCurrentTime);
        if (autoPlayOnSeek) {
          videoRef.current.play().catch(() => {});
          setIsPlaying(true);
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalCurrentTime]);

  const activeSrc = showAudioTrackSwitch && activeAudioTrack === 'original' && originalSrc ? originalSrc : src;
  const wasPlayingBeforeSwitch = useRef(false);

  // Swapping the audio track means swapping the whole <video> src (browsers can't
  // switch just the audio stream of two separate files) — preserve playback position
  // and play/pause state across that swap so it feels like a real track toggle.
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    wasPlayingBeforeSwitch.current = isPlaying;
    const resumeAt = currentTime;
    const handleLoaded = () => {
      el.currentTime = resumeAt;
      if (wasPlayingBeforeSwitch.current) {
        el.play().catch(() => {});
      }
    };
    el.addEventListener('loadedmetadata', handleLoaded, { once: true });
    return () => el.removeEventListener('loadedmetadata', handleLoaded);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSrc]);

  const handlePlayPause = () => {
    if (!videoRef.current) return;
    if (videoRef.current.paused) {
      videoRef.current.play().catch(() => {});
      setIsPlaying(true);
    } else {
      videoRef.current.pause();
      setIsPlaying(false);
    }
  };

  const handleTimeUpdate = () => {
    if (!videoRef.current) return;
    const time = videoRef.current.currentTime;
    setCurrentTime(time);
    onTimeUpdate?.(time);
  };

  const handleLoadedMetadata = () => {
    if (!videoRef.current) return;
    setDuration(videoRef.current.duration || 30);
    if (autoPlay) {
      videoRef.current.play().catch(() => {});
      setIsPlaying(true);
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newTime = parseFloat(e.target.value);
    if (videoRef.current) {
      videoRef.current.currentTime = newTime;
      setCurrentTime(newTime);
      onTimeUpdate?.(newTime);
    }
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newVol = parseFloat(e.target.value);
    setVolume(newVol);
    if (videoRef.current) {
      videoRef.current.volume = newVol;
      videoRef.current.muted = newVol === 0;
      setIsMuted(newVol === 0);
    }
  };

  const toggleMute = () => {
    if (!videoRef.current) return;
    const nextMuted = !isMuted;
    setIsMuted(nextMuted);
    videoRef.current.muted = nextMuted;
  };

  const changeSpeed = () => {
    const speeds = [0.75, 1, 1.25, 1.5, 2];
    const nextIdx = (speeds.indexOf(playbackRate) + 1) % speeds.length;
    const nextRate = speeds[nextIdx];
    setPlaybackRate(nextRate);
    if (videoRef.current) {
      videoRef.current.playbackRate = nextRate;
    }
  };

  const toggleFullscreen = () => {
    if (!containerRef.current) return;
    if (!document.fullscreenElement) {
      containerRef.current.requestFullscreen().catch(() => {});
      setIsFullscreen(true);
    } else {
      document.exitFullscreen().catch(() => {});
      setIsFullscreen(false);
    }
  };

  const restartVideo = () => {
    if (videoRef.current) {
      videoRef.current.currentTime = 0;
      videoRef.current.play().catch(() => {});
      setIsPlaying(true);
    }
  };

  // Karaoke-style caption cue: whichever segment is active gets split into ~1.5-line
  // "cards" of a handful of words each, with each word given an estimated [start,end]
  // proportional to its character length across the card's slice of the segment's real
  // timing — a standard approximation when exact per-translated-word timestamps aren't
  // available, and precise enough for a word-by-word highlight to read as in-sync.
  const WORDS_PER_CAPTION_CARD = 9;
  const captionCue = React.useMemo(() => {
    if (!showSubtitles) return null;

    const active =
      localizedSegments.find((s) => currentTime >= s.startTime && currentTime <= s.endTime + 0.3) ||
      transcriptSegments.find((s) => currentTime >= s.startTime && currentTime <= s.endTime + 0.3);
    if (!active) return null;

    const text = 'translatedText' in active ? active.translatedText : active.text;
    const words = text.split(/\s+/).filter(Boolean);
    if (words.length === 0) return null;

    const totalChars = words.reduce((sum, w) => sum + w.length, 0) || words.length;
    let cursor = active.startTime;
    const timedWords = words.map((w) => {
      const share = (Math.max(1, w.length) / totalChars) * (active.endTime - active.startTime);
      const start = cursor;
      const end = Math.min(active.endTime, cursor + share);
      cursor = end;
      return { text: w, start, end };
    });

    for (let i = 0; i < timedWords.length; i += WORDS_PER_CAPTION_CARD) {
      const card = timedWords.slice(i, i + WORDS_PER_CAPTION_CARD);
      const cardEnd = card[card.length - 1].end;
      if (currentTime <= cardEnd + 0.3 || i + WORDS_PER_CAPTION_CARD >= timedWords.length) {
        return card;
      }
    }
    return timedWords.slice(-WORDS_PER_CAPTION_CARD);
  }, [currentTime, showSubtitles, localizedSegments, transcriptSegments]);

  const formatTime = (timeInSec: number) => {
    const mins = Math.floor(timeInSec / 60);
    const secs = Math.floor(timeInSec % 60);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const handleMouseMove = () => {
    setShowControls(true);
    if (hideControlsTimer.current) window.clearTimeout(hideControlsTimer.current);
    hideControlsTimer.current = window.setTimeout(() => {
      if (isPlaying) {
        setShowControls(false);
      }
    }, 2800);
  };

  return (
    <div
      ref={containerRef}
      id="video-player-container"
      onMouseMove={handleMouseMove}
      onMouseLeave={() => isPlaying && setShowControls(false)}
      className={`group relative overflow-hidden rounded-2xl bg-black border border-[#E2E8F0] shadow-2xl flex flex-col justify-center items-center ${className}`}
    >
      {/* Video Element */}
      <video
        ref={videoRef}
        src={activeSrc}
        poster={poster}
        playsInline
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleLoadedMetadata}
        onEnded={() => setIsPlaying(false)}
        onClick={handlePlayPause}
        className="w-full h-full object-contain cursor-pointer max-h-[520px]"
      />

      {/* Audio Track Badge */}
      {showAudioTrackSwitch && (
        <div className="absolute top-4 left-4 z-20 flex items-center gap-1.5 p-1 bg-[#FFFFFF]/90 backdrop-blur-md rounded-lg border border-[#E2E8F0]">
          <button
            type="button"
            onClick={() => onToggleAudioTrack?.('dubbed')}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-semibold transition-all ${
              activeAudioTrack === 'dubbed'
                ? 'bg-coral-600 text-white shadow-sm glow-coral-sm'
                : 'text-slate-400 hover:text-slate-700'
            }`}
          >
            <Sparkles className="w-3.5 h-3.5 text-coral-600" />
            AI Dubbed ({activeLanguageName})
          </button>
          <button
            type="button"
            onClick={() => onToggleAudioTrack?.('original')}
            className={`px-2.5 py-1 rounded text-xs font-semibold transition-all ${
              activeAudioTrack === 'original'
                ? 'bg-slate-100 text-slate-800 border border-slate-300'
                : 'text-slate-400 hover:text-slate-700'
            }`}
          >
            Original Audio
          </button>
        </div>
      )}

      {/* Karaoke Subtitle Overlay — capped width keeps this to ~1.5 lines, each word
          lights up in the accent color the instant playback passes its estimated start. */}
      {captionCue && (
        <div className="absolute bottom-20 left-4 right-4 z-20 flex justify-center pointer-events-none transition-all duration-200">
          <div className="max-w-[70%] sm:max-w-[480px] px-4 py-2 bg-black/85 backdrop-blur-md rounded-xl border border-white/10 text-center text-sm md:text-base font-medium leading-snug shadow-xl animate-fade-in">
            {captionCue.map((w, i) => (
              <span
                key={i}
                className={currentTime >= w.start ? 'text-coral-400 font-semibold' : 'text-white/85'}
              >
                {w.text}
                {i < captionCue.length - 1 ? ' ' : ''}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Big Center Play/Pause Overlay Button */}
      {!isPlaying && (
        <button
          type="button"
          onClick={handlePlayPause}
          className="absolute z-10 w-16 h-16 rounded-full bg-coral-600/90 text-white flex items-center justify-center shadow-2xl glow-purple hover:scale-110 active:scale-95 transition-all duration-200 backdrop-blur-sm border border-coral-400/40"
        >
          <Play className="w-7 h-7 fill-current translate-x-0.5" />
        </button>
      )}

      {/* Video Control Bar */}
      <div
        className={`absolute bottom-0 left-0 right-0 z-30 bg-gradient-to-t from-black/95 via-black/70 to-transparent p-4 transition-opacity duration-300 ${
          showControls || !isPlaying ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
      >
        {/* Progress Bar / Scrubber */}
        <div className="relative mb-3 flex items-center group/scrubber">
          <input
            type="range"
            min={0}
            max={duration || 100}
            step={0.1}
            value={currentTime}
            onChange={handleSeek}
            className="w-full h-1.5 bg-white/20 rounded-lg appearance-none cursor-pointer accent-coral-500 hover:h-2 transition-all"
          />
        </div>

        {/* Action Controls */}
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handlePlayPause}
              className="p-1.5 text-slate-200 hover:text-white rounded-lg hover:bg-white/10 transition-colors"
              title={isPlaying ? 'Pause' : 'Play'}
            >
              {isPlaying ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5 fill-current" />}
            </button>

            <button
              type="button"
              onClick={restartVideo}
              className="p-1.5 text-slate-300 hover:text-white rounded-lg hover:bg-white/10 transition-colors"
              title="Restart"
            >
              <RotateCcw className="w-4 h-4" />
            </button>

            {/* Volume */}
            <div className="flex items-center gap-1.5 group/vol">
              <button
                type="button"
                onClick={toggleMute}
                className="p-1.5 text-slate-300 hover:text-white rounded-lg hover:bg-white/10 transition-colors"
              >
                {isMuted || volume === 0 ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
              </button>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={isMuted ? 0 : volume}
                onChange={handleVolumeChange}
                className="w-16 h-1 bg-white/20 rounded-lg appearance-none cursor-pointer accent-coral-500"
              />
            </div>

            {/* Time Stamp */}
            <span className="text-xs font-mono text-slate-300 ml-1">
              {formatTime(currentTime)} <span className="text-slate-500">/</span> {formatTime(duration)}
            </span>
          </div>

          <div className="flex items-center gap-2">
            {/* Subtitles Toggle */}
            <button
              type="button"
              onClick={() => setShowSubtitles(!showSubtitles)}
              className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors ${
                showSubtitles ? 'bg-coral-50/80 text-coral-600 border border-coral-300/50' : 'text-slate-300 hover:text-white'
              }`}
              title="Toggle Subtitles"
            >
              <Subtitles className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">CC</span>
            </button>

            {/* Playback Rate */}
            <button
              type="button"
              onClick={changeSpeed}
              className="px-2 py-1 rounded text-xs font-mono font-medium text-slate-300 hover:text-white hover:bg-white/10 transition-colors"
              title="Playback Speed"
            >
              {playbackRate}x
            </button>

            {/* Fullscreen */}
            <button
              type="button"
              onClick={toggleFullscreen}
              className="p-1.5 text-slate-300 hover:text-white rounded-lg hover:bg-white/10 transition-colors"
              title={isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
            >
              {isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
