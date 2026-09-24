import React, { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Film, Loader2, Maximize2, Pause, PictureInPicture2, Play, Volume2, VolumeX, X } from 'lucide-react';
import type { StudioStatus } from '../lib/studioSession';
import { ConfirmDialog } from './ConfirmDialog';

interface StudioMiniPlayerProps {
  status: StudioStatus;
  onExpand: () => void;
  onClose: () => void;
}

// The dub you are working on, kept in a corner while you use the rest of Dubly; clicking it brings the studio back.
export const StudioMiniPlayer: React.FC<StudioMiniPlayerProps> = ({ status, onExpand, onClose }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(true);
  const [muted, setMuted] = useState(true);
  const [confirmClose, setConfirmClose] = useState(false);
  const canPopOut = typeof document !== 'undefined' && 'pictureInPictureEnabled' in document && document.pictureInPictureEnabled;

  // A different video (the finished dub replacing the source, say) starts playing on its own again.
  useEffect(() => {
    setPlaying(true);
  }, [status.videoUrl]);

  const togglePlay = (e: React.MouseEvent) => {
    e.stopPropagation();
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play().catch(() => undefined);
    else video.pause();
  };

  const toggleMute = (e: React.MouseEvent) => {
    e.stopPropagation();
    setMuted((m) => !m);
  };

  // The browser's own floating window, which also stays on top of other apps.
  const popOut = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await videoRef.current?.requestPictureInPicture();
    } catch {
      // Refused (no video loaded yet, or the browser disallows it); the in-page player keeps working.
    }
  };

  const handleClose = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (status.busy) setConfirmClose(true);
    else onClose();
  };

  const iconButton = 'p-1.5 rounded-lg bg-black/55 text-white hover:bg-black/75 transition-colors';

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        aria-label={`Open ${status.title} in the dubbing studio`}
        onClick={onExpand}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onExpand();
          }
        }}
        className="fixed z-40 bottom-20 right-3 left-3 sm:left-auto md:bottom-6 md:right-6 sm:w-[340px] rounded-2xl overflow-hidden bg-[#0F172A] text-white shadow-2xl ring-1 ring-white/10 cursor-pointer group animate-fade-in"
        data-testid="studio-mini-player"
      >
        <div className="relative aspect-video bg-black">
          {status.videoUrl ? (
            <video
              ref={videoRef}
              key={status.videoUrl}
              src={status.videoUrl}
              muted={muted}
              autoPlay
              loop
              playsInline
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              className="w-full h-full object-contain"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-slate-500">
              <Film className="w-8 h-8" />
            </div>
          )}

          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-center justify-center">
            <span className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-black/60 text-xs font-semibold">
              <Maximize2 className="w-3.5 h-3.5" /> Open studio
            </span>
          </div>

          <div className="absolute top-2 right-2 flex items-center gap-1.5">
            {canPopOut && status.videoUrl && (
              <button type="button" onClick={popOut} className={iconButton} aria-label="Pop out into a floating window" title="Pop out">
                <PictureInPicture2 className="w-3.5 h-3.5" />
              </button>
            )}
            <button type="button" onClick={handleClose} className={iconButton} aria-label="Close mini player" title="Close">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          {status.videoUrl && (
            <div className="absolute bottom-2 left-2 flex items-center gap-1.5">
              <button type="button" onClick={togglePlay} className={iconButton} aria-label={playing ? 'Pause' : 'Play'}>
                {playing ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
              </button>
              <button type="button" onClick={toggleMute} className={iconButton} aria-label={muted ? 'Unmute' : 'Mute'}>
                {muted ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
              </button>
            </div>
          )}

          {status.progress !== null && (
            <div className="absolute bottom-0 inset-x-0 h-1 bg-white/15">
              <div className="h-full bg-[#F05637] transition-all" style={{ width: `${Math.max(3, status.progress)}%` }} />
            </div>
          )}
        </div>

        <div className="px-3.5 py-2.5 flex items-center gap-2.5">
          <div className="min-w-0 flex-1">
            <p className="text-xs font-bold truncate">{status.title}</p>
            <p className="text-[11px] text-slate-400 flex items-center gap-1.5 mt-0.5">
              {status.busy ? (
                <Loader2 className="w-3 h-3 animate-spin text-[#F05637]" />
              ) : status.done ? (
                <CheckCircle2 className="w-3 h-3 text-emerald-400" />
              ) : (
                <span className="w-1.5 h-1.5 rounded-full bg-[#F05637]" />
              )}
              <span className="truncate">
                {status.label}
                {status.progress !== null ? ` · ${Math.round(status.progress)}%` : ''}
              </span>
            </p>
          </div>
          <Maximize2 className="w-4 h-4 text-slate-400 group-hover:text-white shrink-0" />
        </div>
      </div>

      <ConfirmDialog
        isOpen={confirmClose}
        title="Close the mini player?"
        description={`"${status.label}" keeps running on the server. You can reopen the project from History at any time.`}
        confirmLabel="Close"
        onConfirm={() => {
          setConfirmClose(false);
          onClose();
        }}
        onCancel={() => setConfirmClose(false)}
      />
    </>
  );
};
