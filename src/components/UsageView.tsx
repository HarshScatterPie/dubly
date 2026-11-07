/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import {
  Clock,
  HardDrive,
  Gauge,
  Zap,
  Globe2,
  FileCheck,
} from 'lucide-react';
import { DubbingProject, UserUsageStats } from '../types';
import { LANGUAGES } from '../data/mockData';
import { projectProgress } from '../lib/projectProgress';
import { languageVoiced } from '../lib/voiceEngines';
import { QuotaRequestDialog } from './QuotaRequestDialog';

interface UsageViewProps {
  usage: UserUsageStats;
  /** The workspace's projects, so these counts match the Dashboard's. */
  projects: DubbingProject[];
  onShowToast: (title: string, description?: string, type?: 'success' | 'error' | 'info' | 'warning') => void;
}

const PlanFact: React.FC<{ label: string; value: string; note: string }> = ({ label, value, note }) => (
  <div className="p-4 rounded-2xl bg-[#F8FAFC] border border-[#E2E8F0] space-y-1">
    <span className="text-[10px] text-[#94A3B8] uppercase tracking-wider block font-bold">{label}</span>
    <span className="text-sm font-bold text-[#0F172A] block">{value}</span>
    <span className="text-[11px] text-[#64748B] block">{note}</span>
  </div>
);

export const UsageView: React.FC<UsageViewProps> = ({ usage, projects, onShowToast }) => {
  const languagesDubbed = new Set(projects.flatMap((p) => projectProgress(p).targetLanguageNames)).size;
  const [requestOpen, setRequestOpen] = useState(false);
  const minutesPercent = Math.min(100, Math.round((usage.minutesDubbed / usage.minutesLimit) * 100));
  const storagePercent = Math.min(100, Math.round((usage.storageUsedMb / usage.storageLimitMb) * 100));
  const minutesLeft = Math.max(0, Math.round((usage.minutesLimit - usage.minutesDubbed) * 10) / 10);
  const refreshDate = usage.resetsAt ? new Date(usage.resetsAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'long' }) : null;
  const languagesOffered = LANGUAGES.filter((l) => languageVoiced(l.code, usage.voiceEngines)).length;

  return (
    <div className="max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8 animate-fade-in">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl sm:text-3xl font-extrabold text-[#0F172A] tracking-tight">
            Usage & Limits
          </h2>
          <p className="text-xs sm:text-sm text-[#64748B] mt-1">
            Track your dubbing minutes, words translated and storage.
          </p>
        </div>

        <button
          type="button"
          onClick={() => setRequestOpen(true)}
          className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-[#F05637] hover:bg-[#D94B2E] text-white text-xs font-semibold shadow-md shadow-[0_0_15px_rgba(240,86,55,0.3)] transition-all"
        >
          <Gauge className="w-4 h-4" />
          <span>Request Quota Increase</span>
        </button>
      </div>

      <QuotaRequestDialog isOpen={requestOpen} usage={usage} onClose={() => setRequestOpen(false)} onShowToast={onShowToast} />

      {/* Primary Quota Metric Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Minutes Used */}
        <div className="p-6 rounded-3xl glass-panel space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold uppercase tracking-wider text-[#64748B]">
              Dubbing Minutes
            </span>
            <Clock className="w-4 h-4 text-[#F05637]" />
          </div>

          <div className="space-y-1">
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-extrabold text-[#0F172A] font-mono">
                {usage.minutesDubbed.toFixed(1)}
              </span>
              <span className="text-sm text-[#94A3B8] font-mono">/ {usage.minutesLimit} mins</span>
            </div>
            <p className="text-[11px] text-[#64748B]">
              {usage.renewsMonthly === false
                ? `${minutesLeft} free min left · a one-time allowance that does not refresh`
                : refreshDate
                  ? `Refreshes on ${refreshDate} · ${minutesLeft} min left this month`
                  : 'Resets automatically on the 1st of every month'}
            </p>
            <p className="text-[11px] text-[#94A3B8]">Dubs use their video's length; Studio voiceovers and line previews use the length of the voice.</p>
          </div>

          <div className="space-y-1.5 pt-2">
            <div className="w-full h-2 bg-[#E2E8F0] rounded-full overflow-hidden">
              <div
                className="h-full bg-[#F05637] rounded-full shadow-sm"
                style={{ width: `${minutesPercent}%` }}
              />
            </div>
            <span className="text-[10px] text-[#94A3B8] font-mono block text-right">
              {minutesPercent}% capacity used
            </span>
          </div>
        </div>

        {/* Words Localized */}
        <div className="p-6 rounded-3xl glass-panel space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold uppercase tracking-wider text-[#64748B]">
              Words Localized
            </span>
            <Globe2 className="w-4 h-4 text-amber-600" />
          </div>

          <div className="space-y-1">
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-extrabold text-[#0F172A] font-mono">
                {usage.wordsTranslated.toLocaleString()}
              </span>
              <span className="text-sm text-[#94A3B8] font-mono">words</span>
            </div>
            <p className="text-[11px] text-[#64748B]">
              Dubbed into {languagesDubbed} {languagesDubbed === 1 ? 'language' : 'languages'} across {projects.length} {projects.length === 1 ? 'project' : 'projects'}
            </p>
          </div>
        </div>

        {/* Cloud Media Storage */}
        <div className="p-6 rounded-3xl glass-panel space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold uppercase tracking-wider text-[#64748B]">
              Media Storage
            </span>
            <HardDrive className="w-4 h-4 text-teal-600" />
          </div>

          <div className="space-y-1">
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-extrabold text-[#0F172A] font-mono">
                {usage.storageUsedMb} MB
              </span>
              <span className="text-sm text-[#94A3B8] font-mono">/ {usage.storageLimitMb} MB</span>
            </div>
            <p className="text-[11px] text-[#64748B]">
              Your uploaded videos and finished dubs
            </p>
          </div>

          <div className="space-y-1.5 pt-2">
            <div className="w-full h-2 bg-[#E2E8F0] rounded-full overflow-hidden">
              <div
                className="h-full bg-teal-600 rounded-full shadow-sm"
                style={{ width: `${storagePercent}%` }}
              />
            </div>
            <span className="text-[10px] text-[#94A3B8] font-mono block text-right">
              {storagePercent}% storage used
            </span>
          </div>
        </div>
      </div>

      {/* Plan Breakdown & Features */}
      <div className="rounded-3xl glass-panel p-7 space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-[#E2E8F0]">
          <div>
            <h3 className="text-base font-bold text-[#0F172A]">Current Plan</h3>
            <p className="text-xs text-[#64748B] mt-0.5">
              You are currently on the <strong className="text-[#D94B2E]">{usage.activePlan}</strong> plan
            </p>
            <p className="text-xs text-[#64748B] mt-1">
              {usage.renewsMonthly !== false ? `${usage.minutesLimit} dubbing minutes a month` : `${usage.minutesLimit} free dubbing minutes in total`} ·{' '}
              {usage.paidExtrasAllowed ? 'Paid extras available, each uses more minutes' : 'No paid extras'} · {usage.teamInvites ? 'Invite your team' : 'Just you, no teammates'}
            </p>
          </div>

          <div className="flex items-center gap-2">
            <span className="px-3 py-1 rounded-full text-xs font-semibold bg-[#F05637]/20 text-[#D94B2E] border border-[#F05637]/40">
              {usage.renewsMonthly === false ? 'One-Time Allowance' : refreshDate ? `Refreshes ${refreshDate}` : 'Monthly Allowance'}
            </span>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <PlanFact label="Video Limit" value={`${usage.maxUploadMb} MB · ${usage.maxVideoMinutes} min`} note="Per video. A dub keeps your video's resolution." />
          <PlanFact label="Language Support" value={`${languagesOffered} Languages`} note="Some dialects use a related language's voice." />
          <PlanFact label="Audio Sync" value="Segment-Timed Dubbing" note="Each line is placed at its own time." />
          <PlanFact
            label="AI Label"
            value={usage.visibleWatermark ? 'Visible on Dubbed Videos' : 'Not Visible'}
            note={usage.visibleWatermark ? '"Dubbed by Dubly Studio", plus an AI tag in the file.' : 'An AI tag stays in the file.'}
          />
        </div>
      </div>
    </div>
  );
};
