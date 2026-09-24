import React from 'react';
import { AlertCircle, CheckCircle2, Clock3, Loader2 } from 'lucide-react';
import type { ProjectProgress } from '../lib/projectProgress';

// One badge for a project's real state, used wherever projects are listed.
export const ProjectStatusBadge: React.FC<{ progress: ProjectProgress }> = ({ progress }) => {
  const { stage, badge, nextStep } = progress;
  const style =
    stage === 'done'
      ? 'bg-emerald-50/90 text-emerald-600 border-emerald-200/60'
      : progress.running
        ? 'bg-coral-50/90 text-coral-600 border-coral-200/60'
        : stage === 'failed'
          ? 'bg-rose-50/90 text-rose-600 border-rose-200/60'
          : 'bg-amber-50/95 text-amber-700 border-amber-200/70';
  const Icon = stage === 'done' ? CheckCircle2 : progress.running ? Loader2 : stage === 'failed' ? AlertCircle : Clock3;
  return (
    <span
      title={nextStep || undefined}
      className={`px-2 py-0.5 rounded-md text-[10px] font-semibold border flex items-center gap-1 w-max ${style}`}
    >
      <Icon className={`w-3 h-3 ${progress.running ? 'animate-spin' : ''}`} />
      <span>{badge}</span>
    </span>
  );
};
