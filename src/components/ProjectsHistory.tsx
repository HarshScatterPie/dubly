/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import {
  History,
  Search,
  Video,
  Play,
  Download,
  Trash2,
  ExternalLink,
  Filter,
  CheckCircle2,
  Clock,
  ArrowRight,
  Sparkles,
} from 'lucide-react';
import { DubbingProject } from '../types';
import { LANGUAGES, VOICES } from '../data/mockData';
import { ConfirmDialog } from './ConfirmDialog';

interface ProjectsHistoryProps {
  projects: DubbingProject[];
  onOpenProject: (project: DubbingProject) => void;
  onDeleteProject: (projectId: string) => void;
  onNewDub: () => void;
}

export const ProjectsHistory: React.FC<ProjectsHistoryProps> = ({
  projects,
  onOpenProject,
  onDeleteProject,
  onNewDub,
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [filterLang, setFilterLang] = useState('all');
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  const filteredProjects = projects.filter((p) => {
    const matchesSearch =
      p.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
      p.videoFileName.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesLang = filterLang === 'all' || p.targetLanguage === filterLang;
    return matchesSearch && matchesLang;
  });

  const getLang = (code: string) => LANGUAGES.find((l) => l.code === code);
  const getVoice = (id: string) => VOICES.find((v) => v.id === id);

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const formatDate = (isoString: string) => {
    try {
      const d = new Date(isoString);
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    } catch {
      return 'Recent';
    }
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8 animate-fade-in">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl sm:text-3xl font-extrabold text-[#0F172A] tracking-tight">
            Project History
          </h2>
          <p className="text-xs sm:text-sm text-[#64748B] mt-1">
            Browse, manage, and export your translated video and voice library.
          </p>
        </div>

        <button
          type="button"
          onClick={onNewDub}
          className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-[#F05637] hover:bg-[#D94B2E] text-white text-xs font-semibold shadow-md shadow-[0_0_15px_rgba(240,86,55,0.3)] transition-all"
        >
          <Sparkles className="w-4 h-4 text-[#D94B2E]" />
          <span>+ Dub New Video</span>
        </button>
      </div>

      {/* Filter & Search Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-4 p-4 rounded-2xl glass-panel">
        <div className="relative flex-1 min-w-[240px]">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[#94A3B8]" />
          <input
            type="text"
            placeholder="Search projects by title or filename..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-10 pr-4 py-2 rounded-xl bg-[#F8FAFC] border border-[#E2E8F0] text-xs text-[#0F172A] placeholder-[#94A3B8] focus:outline-none focus:border-[#F05637]"
          />
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 text-xs text-[#64748B]">
            <Filter className="w-3.5 h-3.5 text-[#F05637]" />
            <span>Target Language:</span>
          </div>
          <select
            value={filterLang}
            onChange={(e) => setFilterLang(e.target.value)}
            className="px-3 py-2 rounded-xl bg-[#F8FAFC] border border-[#E2E8F0] text-xs text-[#0F172A] font-medium focus:outline-none focus:border-[#F05637]"
          >
            <option value="all">All Languages</option>
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.flag} {l.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Projects Table / Cards */}
      {filteredProjects.length === 0 ? (
        <div className="p-16 rounded-3xl glass-panel text-center space-y-3">
          <History className="w-12 h-12 text-[#94A3B8] mx-auto" />
          <h4 className="text-base font-bold text-[#0F172A]">No projects found</h4>
          <p className="text-xs text-[#64748B] max-w-sm mx-auto">
            Try adjusting your search criteria or create a new video dub project.
          </p>
        </div>
      ) : (
        <div className="rounded-3xl glass-panel overflow-hidden">
          <div className="overflow-x-auto custom-scrollbar">
            <table className="w-full text-left text-xs">
              <thead className="bg-[#F8FAFC] text-[#64748B] uppercase tracking-wider font-semibold border-b border-[#E2E8F0]">
                <tr>
                  <th className="py-3.5 px-5">Project</th>
                  <th className="py-3.5 px-4">Language Pair</th>
                  <th className="py-3.5 px-4">Voice Model</th>
                  <th className="py-3.5 px-4">Duration</th>
                  <th className="py-3.5 px-4">Status</th>
                  <th className="py-3.5 px-4">Date</th>
                  <th className="py-3.5 px-5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E2E8F0] text-[#0F172A]">
                {filteredProjects.map((p) => {
                  const sLang = getLang(p.sourceLanguage);
                  const tLang = getLang(p.targetLanguage);
                  const voice = getVoice(p.selectedVoiceId);

                  return (
                    <tr
                      key={p.id}
                      className="hover:bg-[#F8FAFC]/70 transition-colors group cursor-pointer"
                      onClick={() => onOpenProject(p)}
                    >
                      {/* Title & Thumbnail */}
                      <td className="py-4 px-5">
                        <div className="flex items-center gap-3">
                          <div className="relative w-14 h-10 rounded-lg overflow-hidden shrink-0 bg-black">
                            {p.videoThumbnailUrl ? (
                              <img
                                src={p.videoThumbnailUrl}
                                alt={p.title}
                                className="w-full h-full object-cover"
                              />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center bg-[#1b2233]">
                                <Video className="w-4 h-4 text-slate-500" />
                              </div>
                            )}
                            <div className="absolute inset-0 bg-black/30 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                              <Play className="w-3.5 h-3.5 text-white fill-current" />
                            </div>
                          </div>
                          <div className="min-w-0">
                            <h5 className="font-bold text-[#0F172A] group-hover:text-[#D94B2E] transition-colors truncate max-w-[220px]">
                              {p.title}
                            </h5>
                            <span className="text-[11px] text-[#94A3B8] font-mono block">
                              {p.videoFileName}
                            </span>
                          </div>
                        </div>
                      </td>

                      {/* Language Pair */}
                      <td className="py-4 px-4 whitespace-nowrap">
                        <div className="flex items-center gap-1.5 font-medium">
                          <span>{sLang?.flag} {sLang?.name.split(' ')[0]}</span>
                          <ArrowRight className="w-3 h-3 text-[#94A3B8]" />
                          <span className="text-[#D94B2E] font-semibold">{tLang?.flag} {tLang?.name}</span>
                        </div>
                      </td>

                      {/* Voice Model */}
                      <td className="py-4 px-4 whitespace-nowrap">
                        <div className="flex items-center gap-2">
                          <img
                            src={voice?.avatarUrl}
                            alt={voice?.name}
                            className="w-6 h-6 rounded-full object-cover"
                          />
                          <span className="text-[#64748B]">{voice?.name || p.selectedVoiceId}</span>
                        </div>
                      </td>

                      {/* Duration */}
                      <td className="py-4 px-4 font-mono text-[#64748B] whitespace-nowrap">
                        {formatDuration(p.videoDuration)}
                      </td>

                      {/* Status */}
                      <td className="py-4 px-4 whitespace-nowrap">
                        {p.status === 'completed' ? (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-50/80 text-emerald-600 border border-emerald-200/60 flex items-center gap-1 w-max">
                            <CheckCircle2 className="w-3 h-3" />
                            <span>Completed</span>
                          </span>
                        ) : p.status === 'processing' ? (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-coral-50/80 text-coral-600 border border-coral-200/60 w-max">
                            Processing
                          </span>
                        ) : p.status === 'failed' ? (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-rose-50/80 text-rose-600 border border-rose-200/60 w-max">
                            Failed
                          </span>
                        ) : (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-slate-50/80 text-slate-400 border border-slate-300/60 w-max">
                            Draft
                          </span>
                        )}
                      </td>

                      {/* Date */}
                      <td className="py-4 px-4 font-mono text-[#94A3B8] whitespace-nowrap">
                        {formatDate(p.createdAt)}
                      </td>

                      {/* Actions */}
                      <td className="py-4 px-5 text-right whitespace-nowrap">
                        <div className="flex items-center justify-end gap-1.5" onClick={(e) => e.stopPropagation()}>
                          <button
                            type="button"
                            onClick={() => onOpenProject(p)}
                            className="p-1.5 rounded-lg text-[#D94B2E] hover:text-white hover:bg-[#F05637] transition-colors"
                            title="Open Workspace"
                          >
                            <ExternalLink className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setPendingDeleteId(p.id)}
                            className="p-1.5 rounded-lg text-[#94A3B8] hover:text-rose-600 hover:bg-[#F8FAFC] transition-colors"
                            title="Delete Project"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <ConfirmDialog
        isOpen={pendingDeleteId !== null}
        title="Delete this project?"
        description="This permanently removes the project, its transcript, and any rendered dubs. This can't be undone."
        confirmLabel="Delete Project"
        onCancel={() => setPendingDeleteId(null)}
        onConfirm={() => {
          if (pendingDeleteId) onDeleteProject(pendingDeleteId);
          setPendingDeleteId(null);
        }}
      />
    </div>
  );
};
