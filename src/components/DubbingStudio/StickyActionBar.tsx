import React from 'react';

interface StickyActionBarProps {
  summary: React.ReactNode;
  children: React.ReactNode;
}

// Pins a step's primary action to the bottom of the viewport so the user never has to scroll to find "what next".
export const StickyActionBar: React.FC<StickyActionBarProps> = ({ summary, children }) => (
  <div className="sticky bottom-[5.5rem] md:bottom-4 z-20 mt-6">
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3 sm:p-4 rounded-2xl bg-white/95 backdrop-blur border border-[#E2E8F0] shadow-[0_-8px_30px_rgba(15,23,42,0.10)]">
      <div className="min-w-0 text-xs text-[#64748B]">{summary}</div>
      <div className="flex items-center gap-2 shrink-0">{children}</div>
    </div>
  </div>
);
