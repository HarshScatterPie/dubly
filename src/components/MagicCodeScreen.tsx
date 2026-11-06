/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Languages, ShieldCheck, Smartphone } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import scatterPieLogo from '../assets/scatterpie-logo.png';

/**
 * Shown when a sign-in link is opened on a device that did not ask for it: the code to type on the device that did. It takes the
 * whole screen whatever this device's own state, so a device that is already signed in (to any account) still shows the code
 * instead of quietly opening the studio. "Done" returns to whatever this device had before.
 */
export const MagicCodeScreen: React.FC = () => {
  const { magicCode, cancelMagic } = useAuth();
  if (!magicCode) return null;
  const at = new Date(magicCode.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return (
    <div className="relative min-h-screen bg-background text-foreground flex flex-col antialiased overflow-hidden">
      <div aria-hidden className="pointer-events-none absolute -top-40 -left-40 w-[28rem] h-[28rem] rounded-full bg-[#1D6FE8]/10 blur-3xl" />
      <div aria-hidden className="pointer-events-none absolute -bottom-40 -right-40 w-[28rem] h-[28rem] rounded-full bg-coral-500/10 blur-3xl" />
      <main className="relative z-10 flex-1 flex items-center justify-center px-4 py-10">
        <div className="w-full max-w-sm glass-panel rounded-2xl p-8 space-y-5 shadow-lg">
          <div className="flex flex-col items-center text-center space-y-3">
            <div className="w-12 h-12 bg-coral-500 rounded-2xl flex items-center justify-center shadow-[0_0_20px_rgba(240,86,55,0.35)]">
              <Languages className="w-6 h-6 text-white" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-foreground tracking-tight font-display">Your sign-in code</h1>
              <p className="text-xs text-muted-foreground mt-1">Type it on the device where you asked to sign in. This device stays as it was.</p>
            </div>
          </div>
          <div className="rounded-xl bg-gradient-to-br from-[#FFF4EE] to-[#FFE6DB] border border-[#FFC9B6] p-5 text-center shadow-inner">
            <p className="font-mono text-4xl font-bold tracking-[0.35em] text-[#0F172A] select-all" aria-label={`Code ${magicCode.code.split('').join(' ')}`}>
              {magicCode.code}
            </p>
            <p className="text-[11px] text-[#9A3412] mt-2">Works for 10 minutes</p>
          </div>
          <div className="flex items-start gap-2.5 p-3 rounded-md bg-slate-50 border border-border text-xs text-muted-foreground">
            <Smartphone className="w-4 h-4 shrink-0 mt-0.5" />
            <p>
              Requested from <strong className="text-foreground">{magicCode.device}</strong>
              {magicCode.location ? (
                <>
                  {' '}
                  in <strong className="text-foreground">{magicCode.location}</strong>
                </>
              ) : null}{' '}
              at {at}.
            </p>
          </div>
          <div className="flex items-start gap-2.5 p-3 rounded-md bg-[#F4F2FF] border border-[#D8D1FA] text-xs text-[#3B2D86]">
            <ShieldCheck className="w-4 h-4 shrink-0 mt-0.5" />
            <p>Only type this code on a device you are using yourself. Never read it out or send it to anyone; ScatterPie will never ask for it.</p>
          </div>
          <button
            type="button"
            onClick={cancelMagic}
            className="w-full py-2.5 rounded-md border border-border text-sm font-semibold text-foreground hover:bg-slate-50 transition-colors"
          >
            Done
          </button>
        </div>
      </main>
      <footer className="relative z-10 flex items-center justify-center gap-2 pb-6 text-[11px] text-muted-foreground">
        <span>Powered by</span>
        <img src={scatterPieLogo} alt="ScatterPie" className="h-3.5 w-auto opacity-80" draggable={false} />
      </footer>
    </div>
  );
};
