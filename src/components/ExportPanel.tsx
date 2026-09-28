/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { Captions, FileText, Share2, Subtitles, Volume2 } from 'lucide-react';
import type { DubbingProject } from '../types';
import { projectService } from '../services/projectService';
import { renderService } from '../services/renderService';
import { DownloadMenu } from './DownloadMenu';
import type { DubbedLanguage } from './DubResult';

interface ExportPanelProps {
  project: DubbingProject;
  languages: DubbedLanguage[];
  /** The language the formats below (subtitles, voice track) are for. */
  active: DubbedLanguage | undefined;
  defaultBurnCaptions?: boolean;
  onShare: () => void;
  onShowToast: (title: string, desc?: string, type?: 'success' | 'info' | 'error') => void;
  className?: string;
}

/** Everything a finished dub can be taken away as: the video (clean or with captions), subtitle files, the voice track, a share link. */
export const ExportPanel: React.FC<ExportPanelProps> = ({ project, languages, active, defaultBurnCaptions = false, onShare, onShowToast, className = '' }) => {
  const [burnCaptions, setBurnCaptions] = useState(defaultBurnCaptions);
  const [captionWait, setCaptionWait] = useState<number | null>(null);
  const baseName = renderService.safeName(project.title);
  const resolution = project.videoResolution?.split(' (')[0]?.replace(/\s/g, '') || 'MP4';

  const downloadLanguageVideo = async (code: string) => {
    const entry = languages.find((l) => l.code === code);
    const name = entry?.language.name || code;
    if (!entry?.videoUrl) throw new Error(`The ${name} dub has not finished rendering.`);
    let url = entry.videoUrl;
    if (burnCaptions) {
      if (!entry.segments.length) throw new Error(`There are no ${name} lines to caption.`);
      onShowToast('Adding captions', `Rendering ${name} captions into the video. Long videos take a minute or two.`, 'info');
      setCaptionWait(0);
      try {
        url = (await projectService.exportVideo(project.id, true, code, setCaptionWait)).url;
      } finally {
        setCaptionWait(null);
      }
    }
    await renderService.downloadMedia(`${baseName}_${name}_${burnCaptions ? 'Dub_Captions' : 'Dub'}.mp4`, url);
  };

  const handleSubtitles = (format: 'srt' | 'vtt') => {
    if (!active?.segments.length) {
      onShowToast('No Captions Yet', 'This language has no translated lines.', 'error');
      return;
    }
    const content = format === 'srt' ? renderService.generateSRT(active.segments) : renderService.generateVTT(active.segments);
    renderService.downloadTextFile(`${baseName}_${active.language.name}.${format}`, content, format === 'srt' ? 'application/x-subrip' : 'text/vtt');
    onShowToast('Subtitles Downloaded', `${active.language.name} ${format.toUpperCase()} file saved, timed to the dubbed voice.`, 'success');
  };

  const handleAudio = async () => {
    if (!active?.audioUrl) {
      onShowToast('Audio Not Ready', 'The dubbed audio track is still rendering.', 'error');
      return;
    }
    try {
      await renderService.downloadMedia(`${baseName}_${active.language.name}_Audio.wav`, active.audioUrl);
      onShowToast('Audio Downloaded', `${active.language.name} soundtrack saved as WAV.`, 'success');
    } catch (err) {
      onShowToast('Download Failed', (err as Error).message, 'error');
    }
  };

  return (
    <div className={`relative z-20 rounded-3xl glass-panel p-5 space-y-4 ${className}`}>
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-bold text-[#0F172A]">Download</h4>
        <span className="text-[11px] text-[#94A3B8] font-mono">MP4 · {resolution}</span>
      </div>

      <div className="grid grid-cols-2 p-1 rounded-2xl bg-[#F1F5F9] text-xs font-semibold" role="radiogroup" aria-label="Captions">
        {[
          { value: false, label: 'Clean video', icon: Subtitles },
          { value: true, label: 'Captions in video', icon: Captions },
        ].map(({ value, label, icon: Icon }) => (
          <button
            key={label}
            type="button"
            role="radio"
            aria-checked={burnCaptions === value}
            onClick={() => setBurnCaptions(value)}
            className={`flex items-center justify-center gap-1.5 py-2 rounded-xl transition-all ${
              burnCaptions === value ? 'bg-white text-[#0F172A] shadow-sm' : 'text-[#64748B] hover:text-[#0F172A]'
            }`}
          >
            <Icon className="w-3.5 h-3.5" />
            {label}
          </button>
        ))}
      </div>

      <DownloadMenu
        languages={languages.map((entry) => ({
          code: entry.code,
          name: entry.language.name,
          nativeName: entry.language.nativeName,
          ready: Boolean(entry.videoUrl),
          statusLabel: entry.status === 'failed' ? entry.message || 'Dubbing failed' : 'Not dubbed yet',
        }))}
        onDownload={downloadLanguageVideo}
        onShowToast={onShowToast}
        label="Download video"
        busyLabel={captionWait !== null ? `Adding captions… ${captionWait}s` : undefined}
        sublabel={burnCaptions ? 'Captions burned into the picture' : 'Switchable captions track included'}
      />
      <p className="text-[11px] text-[#94A3B8] leading-relaxed">
        {burnCaptions
          ? 'Captions are drawn into the picture, timed word by word to the dubbed voice — right for social feeds.'
          : 'Every video carries a captions track you can switch on in VLC, QuickTime, phones and most editors.'}
      </p>

      <div className="pt-4 border-t border-[#E2E8F0]">
        <span className="text-[11px] font-bold uppercase tracking-wider text-[#94A3B8] block mb-2">
          More formats{languages.length > 1 && active ? ` · ${active.language.name}` : ''}
        </span>
        <div className="grid grid-cols-3 gap-2">
          {[
            { label: 'SRT', hint: 'Subtitles', icon: FileText, onClick: () => handleSubtitles('srt'), disabled: !active?.segments.length },
            { label: 'VTT', hint: 'Web captions', icon: FileText, onClick: () => handleSubtitles('vtt'), disabled: !active?.segments.length },
            { label: 'WAV', hint: 'Soundtrack', icon: Volume2, onClick: handleAudio, disabled: !active?.audioUrl },
          ].map(({ label, hint, icon: Icon, onClick, disabled }) => (
            <button
              key={label}
              type="button"
              onClick={onClick}
              disabled={disabled}
              className="flex flex-col items-center gap-1 py-3 rounded-2xl bg-white hover:bg-[#FFF4F1] border border-[#E2E8F0] hover:border-[#F05637]/40 transition-colors disabled:opacity-50 disabled:hover:bg-white"
            >
              <Icon className="w-4 h-4 text-[#D94B2E]" />
              <span className="text-xs font-bold text-[#0F172A]">{label}</span>
              <span className="text-[10px] text-[#94A3B8]">{hint}</span>
            </button>
          ))}
        </div>
      </div>

      <button
        type="button"
        onClick={onShare}
        className="w-full flex items-center justify-center gap-2 py-2.5 rounded-2xl bg-white hover:bg-[#F8FAFC] border border-[#E2E8F0] text-xs font-semibold text-[#0F172A] transition-colors"
      >
        <Share2 className="w-3.5 h-3.5 text-[#D94B2E]" />
        Share a watch link
      </button>
    </div>
  );
};
