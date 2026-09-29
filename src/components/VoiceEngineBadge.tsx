/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Lock } from 'lucide-react';
import type { VoiceEngine } from '../types';
import { VOICE_ENGINE_INFO } from '../lib/voiceEngines';

/**
 * The "which model voices this" chip on a voice card, in one place so every voice picker
 * labels engines the same way. `locked` marks an engine the workspace's plan does not include.
 */
const ENGINE_CLASS: Record<VoiceEngine, string> = {
  'gemini-flash-lite': 'bg-sky-50 text-sky-700 border-sky-200',
  'gemini-flash': 'bg-violet-50 text-violet-700 border-violet-200',
  chirp: 'bg-blue-50 text-blue-600 border-blue-200',
};

export const VoiceEngineBadge: React.FC<{ engine: VoiceEngine; locked?: boolean; compact?: boolean }> = ({ engine, locked = false, compact = false }) => (
  <span
    title={VOICE_ENGINE_INFO[engine].description}
    className={`inline-flex items-center gap-1 rounded font-bold border ${
      locked ? 'bg-slate-100 text-slate-500 border-slate-200' : ENGINE_CLASS[engine]
    } ${compact ? 'px-1 py-0.5 text-[8px]' : 'px-2 py-0.5 text-[10px]'}`}
  >
    {locked && <Lock className={compact ? 'w-2 h-2' : 'w-2.5 h-2.5'} />}
    {VOICE_ENGINE_INFO[engine].label}
  </span>
);
