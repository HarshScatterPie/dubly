/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import {
  Video,
  Mic,
  Sparkles,
  ArrowRight,
  Plus,
  Play,
  Languages,
  Clock,
  CheckCircle2,
  Share2,
  Trash2,
  Globe,
  SlidersHorizontal,
} from 'lucide-react';
import { DubbingProject, NavigationTab } from '../types';
import { SAMPLE_VIDEOS, LANGUAGES, VOICES } from '../data/mockData';
import { videoService } from '../services/videoService';

interface DashboardProps {
  projects: DubbingProject[];
  onNavigate: (tab: NavigationTab) => void;
  onOpenProject: (project: DubbingProject) => void;
  onStartWithSample: (sampleId: string) => void;
  onDeleteProject: (projectId: string) => void;
}

export const Dashboard: React.FC<DashboardProps> = ({
  projects,
  onNavigate,
  onOpenProject,
  onStartWithSample,
  onDeleteProject,
}) => {
  const getLangName = (code: string) => {
    const l = LANGUAGES.find((item) => item.code === code);
    return l ? `${l.flag} ${l.name}` : code;
  };

  const getVoiceName = (id: string) => {
    const v = VOICES.find((item) => item.id === id);
    return v ? `${v.name} (${v.accent.split(' ')[0]})` : id;
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-10">
      {/* Hero Section */}
      <div className="relative overflow-hidden rounded-3xl glass-panel border border-[#E2E8F0] p-8 sm:p-12 text-center shadow-2xl">
        {/* Ambient background glow */}
        <div className="absolute -top-24 left-1/2 -translate-x-1/2 w-96 h-96 bg-[#F05637]/15 rounded-full blur-3xl pointer-events-none" />

        <div className="relative z-10 max-w-3xl mx-auto space-y-5">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-[#F05637]/15 border border-[#F05637]/40 text-[#D94B2E] text-xs font-semibold tracking-wide shadow-sm">
            <Sparkles className="w-3.5 h-3.5 text-[#F05637]" />
            <span>Dubly Studio v2.5 · Powered by Neural Speech & Localization</span>
          </div>

          <h1 className="text-3xl sm:text-5xl font-extrabold tracking-tight text-[#0F172A] font-sans leading-tight">
            Bring your content to <span className="text-transparent bg-clip-text bg-gradient-to-r from-coral-600 via-coral-500 to-teal-600">every language.</span>
          </h1>

          <p className="text-base sm:text-lg text-[#64748B] max-w-2xl mx-auto font-normal leading-relaxed">
            Translate, dub and voice your content with AI. Preserve tone and pacing, and reach global audiences in 20+ languages.
          </p>

          <div className="pt-2 flex flex-wrap items-center justify-center gap-3">
            <button
              type="button"
              onClick={() => onNavigate('dubbing')}
              className="flex items-center gap-2.5 px-6 py-3 rounded-xl bg-[#F05637] hover:bg-[#D94B2E] active:bg-[#B3391F] text-white font-semibold text-sm shadow-xl shadow-[0_0_25px_rgba(240,86,55,0.35)] transition-all duration-200"
            >
              <Plus className="w-4 h-4" />
              <span>+ Create new project</span>
            </button>
            <button
              type="button"
              onClick={() => onNavigate('text-to-voice')}
              className="flex items-center gap-2 px-5 py-3 rounded-xl bg-[#F8FAFC] hover:bg-[#E2E8F0] text-[#0F172A] text-sm font-semibold border border-[#E2E8F0] transition-all"
            >
              <Mic className="w-4 h-4 text-[#F05637]" />
              <span>Script to Voiceover</span>
            </button>
          </div>
        </div>
      </div>

      {/* Two Large Creation Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Video Dubbing Card */}
        <div className="relative group overflow-hidden rounded-2xl glass-panel border border-[#E2E8F0] hover:border-[#F05637]/60 p-7 transition-all duration-200 hover:shadow-[0_0_30px_rgba(240,86,55,0.15)]">
          <div className="flex items-start justify-between">
            <div className="w-12 h-12 rounded-xl bg-[#F05637]/20 border border-[#F05637]/30 flex items-center justify-center text-[#D94B2E] mb-5">
              <Video className="w-6 h-6" />
            </div>
            <span className="px-2.5 py-1 rounded-full text-[11px] font-semibold bg-[#F05637]/15 text-[#D94B2E] border border-[#F05637]/40">
              Most Popular
            </span>
          </div>

          <h3 className="text-xl font-bold text-[#0F172A] mb-2 tracking-tight">VIDEO DUBBING</h3>
          <p className="text-sm text-[#64748B] leading-relaxed mb-6">
            Upload a video and automatically translate its existing speech. Full multi-stage transcription, cultural localization, neural voice clone, and export.
          </p>

          <div className="flex items-center justify-between pt-4 border-t border-[#E2E8F0]">
            <div className="flex items-center gap-2 text-xs text-[#64748B]">
              <Languages className="w-4 h-4 text-[#F05637]" />
              <span>Indian & Global dialects</span>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('dubbing')}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-[#F05637] hover:bg-[#D94B2E] text-white text-xs font-semibold shadow-md shadow-[0_0_15px_rgba(240,86,55,0.3)] transition-all"
            >
              <span>Dub a Video</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Text to Voice Card */}
        <div className="relative group overflow-hidden rounded-2xl glass-panel border border-[#E2E8F0] hover:border-[#F05637]/60 p-7 transition-all duration-200 hover:shadow-[0_0_30px_rgba(240,86,55,0.15)]">
          <div className="flex items-start justify-between">
            <div className="w-12 h-12 rounded-xl bg-teal-600/20 border border-teal-500/30 flex items-center justify-center text-teal-600 mb-5">
              <Mic className="w-6 h-6" />
            </div>
            <span className="px-2.5 py-1 rounded-full text-[11px] font-semibold bg-[#F8FAFC] text-[#64748B] border border-[#E2E8F0]">
              Standalone Studio
            </span>
          </div>

          <h3 className="text-xl font-bold text-[#0F172A] mb-2 tracking-tight">TEXT TO VOICE</h3>
          <p className="text-sm text-[#64748B] leading-relaxed mb-6">
            Turn your script into natural AI voiceover. Pick from ultra-realistic Indian and global voices, adjust cadence, and merge into video in one click.
          </p>

          <div className="flex items-center justify-between pt-4 border-t border-[#E2E8F0]">
            <div className="flex items-center gap-2 text-xs text-[#64748B]">
              <SlidersHorizontal className="w-4 h-4 text-teal-600" />
              <span>Fine pitch & emotion tuning</span>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('text-to-voice')}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-[#F8FAFC] hover:bg-[#E2E8F0] text-[#0F172A] text-xs font-semibold border border-[#E2E8F0] transition-all"
            >
              <span>Create Voiceover</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* Try a Sample Video Quick Strip */}
      <div className="rounded-2xl glass-panel p-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-4">
          <div>
            <h4 className="text-sm font-bold text-[#0F172A] flex items-center gap-2">
              <Globe className="w-4 h-4 text-[#F05637]" />
              <span>Test with Ready-to-Dub Sample Videos</span>
            </h4>
            <p className="text-xs text-[#64748B]">
              Try Dubly immediately with pre-loaded videos and verified multi-lingual transcripts.
            </p>
          </div>
          <span className="text-[11px] font-mono text-[#94A3B8]">1-Click Instant Load</span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {SAMPLE_VIDEOS.map((sample) => (
            <div
              key={sample.id}
              onClick={() => onStartWithSample(sample.id)}
              className="group relative flex items-center gap-3 p-2.5 rounded-xl bg-[#FFFFFF] hover:bg-[#F8FAFC] border border-[#E2E8F0] hover:border-[#F05637]/50 cursor-pointer transition-all"
            >
              <div className="relative w-16 h-12 rounded-lg overflow-hidden shrink-0">
                <img
                  src={sample.thumbnailUrl}
                  alt={sample.title}
                  className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                />
                <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
                  <Play className="w-4 h-4 text-white fill-current opacity-90" />
                </div>
              </div>
              <div className="min-w-0 flex-1">
                <h5 className="text-xs font-semibold text-[#0F172A] truncate group-hover:text-[#D94B2E] transition-colors">
                  {sample.title}
                </h5>
                <div className="flex items-center gap-2 mt-1 text-[10px] text-[#94A3B8]">
                  <span>{sample.durationFormatted}</span>
                  <span>•</span>
                  <span className="text-[#D94B2E] font-semibold">{sample.detectedLanguage}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Recent Projects Section */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-bold text-[#0F172A] tracking-tight">Recent Projects</h3>
            <p className="text-xs text-[#64748B]">Manage and export your translated video assets</p>
          </div>
          <button
            type="button"
            onClick={() => onNavigate('history')}
            className="text-xs font-semibold text-[#D94B2E] hover:text-[#ff9d83] flex items-center gap-1 transition-colors"
          >
            <span>View all projects ({projects.length})</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>

        {projects.length === 0 ? (
          <div className="rounded-2xl glass-panel p-12 text-center">
            <Video className="w-10 h-10 text-[#94A3B8] mx-auto mb-3" />
            <h4 className="text-sm font-semibold text-[#0F172A]">No projects yet</h4>
            <p className="text-xs text-[#64748B] mt-1 max-w-sm mx-auto">
              Start by uploading your first video or selecting a sample video above.
            </p>
            <button
              type="button"
              onClick={() => onNavigate('dubbing')}
              className="mt-4 px-4 py-2 rounded-xl bg-[#F05637] hover:bg-[#D94B2E] text-white text-xs font-semibold shadow-[0_0_15px_rgba(240,86,55,0.3)]"
            >
              + Start First Project
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {projects.slice(0, 6).map((project) => (
              <div
                key={project.id}
                className="group relative overflow-hidden rounded-2xl glass-panel border border-[#E2E8F0] hover:border-[#F05637]/50 transition-all duration-200 flex flex-col justify-between"
              >
                {/* Thumbnail Header */}
                <div
                  onClick={() => onOpenProject(project)}
                  className="relative h-36 bg-black cursor-pointer overflow-hidden"
                >
                  {project.videoThumbnailUrl ? (
                    <img
                      src={project.videoThumbnailUrl}
                      alt={project.title}
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center bg-[#1b2233]">
                      <Video className="w-6 h-6 text-slate-500" />
                    </div>
                  )}
                  <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent" />

                  {/* Play Overlay */}
                  <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                    <div className="w-10 h-10 rounded-full bg-[#F05637]/90 text-white flex items-center justify-center shadow-lg shadow-[0_0_15px_rgba(240,86,55,0.5)]">
                      <Play className="w-4 h-4 fill-current translate-x-0.5" />
                    </div>
                  </div>

                  {/* Duration Badge */}
                  <div className="absolute bottom-2 right-2 px-2 py-0.5 rounded bg-black/80 backdrop-blur-sm text-[10px] font-mono text-slate-200 flex items-center gap-1">
                    <Clock className="w-3 h-3 text-slate-300" />
                    <span>{videoService.formatDuration(project.videoDuration)}</span>
                  </div>

                  {/* Status Badge */}
                  <div className="absolute top-2 left-2">
                    {project.status === 'completed' ? (
                      <span className="px-2 py-0.5 rounded-md text-[10px] font-semibold bg-emerald-50/90 text-emerald-600 border border-emerald-200/60 flex items-center gap-1">
                        <CheckCircle2 className="w-3 h-3" />
                        <span>Ready</span>
                      </span>
                    ) : project.status === 'processing' ? (
                      <span className="px-2 py-0.5 rounded-md text-[10px] font-semibold bg-coral-50/90 text-coral-600 border border-coral-200/60">
                        Processing
                      </span>
                    ) : project.status === 'failed' ? (
                      <span className="px-2 py-0.5 rounded-md text-[10px] font-semibold bg-rose-50/90 text-rose-600 border border-rose-200/60">
                        Failed
                      </span>
                    ) : (
                      <span className="px-2 py-0.5 rounded-md text-[10px] font-semibold bg-slate-50/90 text-slate-400 border border-slate-300/60">
                        Draft
                      </span>
                    )}
                  </div>
                </div>

                {/* Content */}
                <div className="p-4 space-y-3 flex-1 flex flex-col justify-between">
                  <div>
                    <h4
                      onClick={() => onOpenProject(project)}
                      className="text-sm font-bold text-[#0F172A] group-hover:text-[#D94B2E] transition-colors cursor-pointer truncate"
                    >
                      {project.title}
                    </h4>

                    {/* Language Translation Mapping */}
                    <div className="flex items-center gap-2 mt-2 text-xs">
                      <span className="px-2 py-0.5 rounded bg-[#F8FAFC] text-[#64748B] border border-[#E2E8F0]">
                        {getLangName(project.sourceLanguage)}
                      </span>
                      <ArrowRight className="w-3.5 h-3.5 text-[#94A3B8]" />
                      <span className="px-2 py-0.5 rounded bg-[#F05637]/20 text-[#D94B2E] border border-[#F05637]/40 font-semibold">
                        {getLangName(project.targetLanguage)}
                      </span>
                    </div>

                    <div className="flex items-center justify-between text-[11px] text-[#64748B] mt-2.5 pt-2 border-t border-[#E2E8F0]">
                      <span>Voice: <strong className="text-[#0F172A]">{getVoiceName(project.selectedVoiceId)}</strong></span>
                      <span className="text-[#94A3B8]">{project.wordsCount} words</span>
                    </div>
                  </div>

                  {/* Card Bottom Actions */}
                  <div className="flex items-center justify-between pt-3 border-t border-[#E2E8F0]/70">
                    <button
                      type="button"
                      onClick={() => onOpenProject(project)}
                      className="text-xs font-semibold text-[#D94B2E] hover:text-[#ff9d83] flex items-center gap-1"
                    >
                      <span>Open Studio</span>
                      <ArrowRight className="w-3 h-3" />
                    </button>

                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => onOpenProject(project)}
                        className="p-1.5 text-[#64748B] hover:text-[#0F172A] rounded hover:bg-[#F8FAFC] transition-colors"
                        title="Share / Export"
                      >
                        <Share2 className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => onDeleteProject(project.id)}
                        className="p-1.5 text-[#94A3B8] hover:text-rose-600 rounded hover:bg-[#F8FAFC] transition-colors"
                        title="Delete"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
