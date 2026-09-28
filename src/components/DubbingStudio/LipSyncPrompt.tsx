/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { Clapperboard, Clock, ScanFace, Sparkles, X } from 'lucide-react';
import type { FaceScan } from '../../types';

interface LipSyncPromptProps {
  faceScan: FaceScan;
  videoUrl: string | null;
  languageName: string;
  durationSeconds: number;
  /** The toggle's starting position. */
  initialEnabled: boolean;
  onConfirm: (enabled: boolean) => void;
  onClose: () => void;
}

/** Rough CPU cost of lip-sync, so the choice is an informed one. */
export function lipSyncEstimate(durationSeconds: number): string {
  const minutes = Math.max(1, Math.round((durationSeconds * 3) / 60));
  return minutes < 60 ? `about ${minutes} min` : `about ${Math.round(minutes / 6) / 10} h`;
}

/**
 * Shown when the uploaded video has a speaker's face on screen: asks whether the dub should
 * re-animate their mouth, with the frame the face was found in and the face marked on it.
 */
export const LipSyncPrompt: React.FC<LipSyncPromptProps> = ({ faceScan, videoUrl, languageName, durationSeconds, initialEnabled, onConfirm, onClose }) => {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [ratio, setRatio] = useState(16 / 9);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const best = faceScan.best;
  const share = faceScan.sampledFrames ? Math.round((faceScan.framesWithFace / faceScan.sampledFrames) * 100) : 0;
  const frontal = faceScan.frontalRatio >= 0.5;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[#0F172A]/50 backdrop-blur-sm animate-fade-in" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="lipsync-title"
        className="w-full max-w-lg rounded-3xl bg-white border border-[#E2E8F0] shadow-[0_30px_80px_rgba(15,23,42,0.3)] overflow-hidden animate-pop-in"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="relative bg-[#0F172A] px-5 pt-5 pb-4">
          <button type="button" onClick={onClose} aria-label="Close" className="absolute top-3 right-3 z-10 p-1.5 rounded-lg text-white/60 hover:text-white hover:bg-white/10">
            <X className="w-4 h-4" />
          </button>
          {videoUrl && best ? (
            <div className="relative mx-auto rounded-2xl overflow-hidden bg-black" style={{ aspectRatio: String(ratio), height: 220, maxWidth: '100%' }}>
              <video
                src={`${videoUrl}#t=${best.time}`}
                muted
                playsInline
                preload="metadata"
                onLoadedMetadata={(e) => e.currentTarget.videoWidth && setRatio(e.currentTarget.videoWidth / e.currentTarget.videoHeight)}
                className="w-full h-full object-fill"
              />
              <div
                className="absolute rounded-xl border-2 border-[#F05637] animate-reticle"
                style={{
                  left: `${best.box[0] * 100}%`,
                  top: `${best.box[1] * 100}%`,
                  width: `${(best.box[2] - best.box[0]) * 100}%`,
                  height: `${(best.box[3] - best.box[1]) * 100}%`,
                }}
              >
                <span className="absolute -top-6 left-0 px-1.5 py-0.5 rounded-md bg-[#F05637] text-white text-[10px] font-bold whitespace-nowrap">Face detected</span>
              </div>
            </div>
          ) : (
            <div className="h-[140px] rounded-2xl bg-white/5 flex items-center justify-center">
              <ScanFace className="w-12 h-12 text-[#F05637]" />
            </div>
          )}
        </div>

        <div className="p-6 space-y-5">
          <div className="space-y-1.5">
            <h3 id="lipsync-title" className="text-lg font-extrabold text-[#0F172A] tracking-tight">
              Someone's face is on screen. Lip-sync it?
            </h3>
            <p className="text-sm text-[#64748B] leading-relaxed">
              We found a speaker in {share}% of the video{frontal ? ', facing the camera' : ''}. Lip-sync re-animates their mouth so it moves with the {languageName} voice instead of the original words.
            </p>
          </div>

          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            onClick={() => setEnabled((v) => !v)}
            className={`w-full flex items-center justify-between gap-4 p-4 rounded-2xl border transition-colors text-left ${
              enabled ? 'bg-[#FFF4F1] border-[#F05637]/50' : 'bg-[#F8FAFC] border-[#E2E8F0]'
            }`}
          >
            <span className="flex items-center gap-3">
              <span className={`w-10 h-10 rounded-xl flex items-center justify-center ${enabled ? 'bg-[#F05637] text-white' : 'bg-white text-[#94A3B8] border border-[#E2E8F0]'}`}>
                <Clapperboard className="w-5 h-5" />
              </span>
              <span>
                <span className="block text-sm font-bold text-[#0F172A]">Lip-sync</span>
                <span className="flex items-center gap-1 text-[11px] text-[#64748B]">
                  <Clock className="w-3 h-3" />
                  Adds {lipSyncEstimate(durationSeconds)} of rendering
                </span>
              </span>
            </span>
            <span className={`relative w-11 h-6 rounded-full shrink-0 transition-colors ${enabled ? 'bg-[#F05637]' : 'bg-[#CBD5E1]'}`}>
              <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${enabled ? 'translate-x-[22px]' : 'translate-x-0.5'}`} />
            </span>
          </button>

          <p className="flex items-start gap-2 text-[11px] text-[#64748B] leading-relaxed">
            <Sparkles className="w-3.5 h-3.5 text-[#F05637] shrink-0 mt-0.5" />
            Either way, every line is timed to when the speaker's mouth opens and closes. You can change this later under Render quality.
          </p>

          <div className="flex items-center justify-end gap-2">
            <button type="button" onClick={onClose} className="px-4 py-2.5 rounded-xl text-xs font-semibold text-[#64748B] hover:text-[#0F172A]">
              Decide later
            </button>
            <button
              type="button"
              onClick={() => onConfirm(enabled)}
              className="px-5 py-2.5 rounded-xl bg-[#F05637] hover:bg-[#D94B2E] text-white text-xs font-bold shadow-[0_0_20px_rgba(240,86,55,0.3)] transition-colors"
            >
              {enabled ? 'Continue with lip-sync' : 'Continue without lip-sync'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
