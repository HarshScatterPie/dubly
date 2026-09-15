/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Voice } from '../types';

/**
 * The little "who synthesizes this voice" chip on a voice card.
 *
 * Exists as one component so every voice card renders the "who synthesizes this" chip
 * identically, and so adding a provider means editing this map, not hunting for
 * ternaries scattered across each voice picker.
 */
const BADGES: Record<Voice['provider'], { label: string; className: string }> = {
  vertex: {
    label: '🔷 Google Cloud',
    className: 'bg-blue-50 text-blue-600 border-blue-200',
  },
  clone: {
    label: '🎙️ Your voice',
    className: 'bg-[#F05637]/10 text-[#D94B2E] border-[#F05637]/30',
  },
};

export const VoiceProviderBadge: React.FC<{ provider: Voice['provider']; compact?: boolean }> = ({
  provider,
  compact = false,
}) => {
  // An unknown provider is labelled by its own name rather than silently borrowing another
  // vendor's badge — a wrong attribution is worse than an ugly one.
  const badge = BADGES[provider] || {
    label: provider,
    className: 'bg-slate-100 text-slate-600 border-slate-200',
  };

  return (
    <span
      className={`rounded font-bold border ${badge.className} ${
        compact ? 'px-1 py-0.2 text-[8px]' : 'px-2 py-0.5 text-[10px]'
      }`}
    >
      {badge.label}
    </span>
  );
};
