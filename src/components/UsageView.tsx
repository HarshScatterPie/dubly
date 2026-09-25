/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import {
  Clock,
  HardDrive,
  Sparkles,
  ShieldCheck,
  Zap,
  Globe2,
  FileCheck,
} from 'lucide-react';
import { UserUsageStats } from '../types';

interface UsageViewProps {
  usage: UserUsageStats;
  onUpgrade?: () => void;
}

export const UsageView: React.FC<UsageViewProps> = ({ usage, onUpgrade }) => {
  const minutesPercent = Math.min(100, Math.round((usage.minutesDubbed / usage.minutesLimit) * 100));
  const storagePercent = Math.min(100, Math.round((usage.storageUsedMb / usage.storageLimitMb) * 100));

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8 animate-fade-in">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl sm:text-3xl font-extrabold text-[#0F172A] tracking-tight">
            Usage & Analytics
          </h2>
          <p className="text-xs sm:text-sm text-[#64748B] mt-1">
            Track your neural synthesis minutes, API quotas, and storage consumption.
          </p>
        </div>

        <button
          type="button"
          onClick={onUpgrade}
          className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-[#F05637] hover:bg-[#D94B2E] text-white text-xs font-semibold shadow-md shadow-[0_0_15px_rgba(240,86,55,0.3)] transition-all"
        >
          <Sparkles className="w-4 h-4 text-[#D94B2E]" />
          <span>Upgrade to Studio Pro</span>
        </button>
      </div>

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
              {usage.resetsAt
                ? `Refreshes on ${new Date(usage.resetsAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'long' })} · ${Math.max(0, Math.round((usage.minutesLimit - usage.minutesDubbed) * 10) / 10)} min left this month`
                : 'Resets automatically on the 1st of every month'}
            </p>
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

        {/* Neural Voices Quota */}
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
              Across {usage.languagesUsed} languages in {usage.totalProjects} projects
            </p>
          </div>

          <div className="flex items-center gap-1.5 pt-4 text-xs text-emerald-600 font-semibold">
            <ShieldCheck className="w-4 h-4" />
            <span>Studio Neural Quality Enabled</span>
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
              High-speed NVMe video cache & master renders
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
            <h3 className="text-base font-bold text-[#0F172A]">Current Subscription</h3>
            <p className="text-xs text-[#64748B] mt-0.5">
              You are currently on the <strong className="text-[#D94B2E]">{usage.activePlan}</strong> plan
            </p>
            <p className="text-xs text-[#64748B] mt-1">
              {usage.minutesLimit} dubbing minutes a month · {usage.paidExtrasAllowed ? 'Paid extras included' : 'No paid extras'} ·{' '}
              {usage.teamInvites ? 'Invite your team' : 'Just you, no teammates'}
            </p>
          </div>

          <div className="flex items-center gap-2">
            <span className="px-3 py-1 rounded-full text-xs font-semibold bg-[#F05637]/20 text-[#D94B2E] border border-[#F05637]/40">
              Active Billing Cycle
            </span>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="p-4 rounded-2xl bg-[#F8FAFC] border border-[#E2E8F0] space-y-1">
            <span className="text-[10px] text-[#94A3B8] uppercase tracking-wider block font-bold">
              Resolution Cap
            </span>
            <span className="text-sm font-bold text-[#0F172A]">1080p & 4K UHD</span>
          </div>

          <div className="p-4 rounded-2xl bg-[#F8FAFC] border border-[#E2E8F0] space-y-1">
            <span className="text-[10px] text-[#94A3B8] uppercase tracking-wider block font-bold">
              Language Support
            </span>
            <span className="text-sm font-bold text-[#0F172A]">20 Languages</span>
          </div>

          <div className="p-4 rounded-2xl bg-[#F8FAFC] border border-[#E2E8F0] space-y-1">
            <span className="text-[10px] text-[#94A3B8] uppercase tracking-wider block font-bold">
              Audio Sync
            </span>
            <span className="text-sm font-bold text-[#0F172A]">Segment-Timed Dubbing</span>
          </div>

          <div className="p-4 rounded-2xl bg-[#F8FAFC] border border-[#E2E8F0] space-y-1">
            <span className="text-[10px] text-[#94A3B8] uppercase tracking-wider block font-bold">
              Watermark
            </span>
            <span className="text-sm font-bold text-emerald-600">None (Clean Output)</span>
          </div>
        </div>
      </div>
    </div>
  );
};
