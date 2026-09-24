/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { Languages, Loader2, Mail, Lock } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import scatterPieLogo from '../assets/scatterpie-logo.png';

export const Login: React.FC = () => {
  const { signInWithEmail, error } = useAuth();
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const handleEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) return;
    setIsSigningIn(true);
    try {
      await signInWithEmail(email, password);
    } catch {
      // error surfaced via useAuth().error
    } finally {
      setIsSigningIn(false);
    }
  };

  return (
    <div className="relative min-h-screen bg-background text-foreground flex flex-col antialiased overflow-hidden">
      {/* Soft brand glow behind the card, echoing the ScatterPie blue and the Dubly coral. */}
      <div aria-hidden className="pointer-events-none absolute -top-40 -left-40 w-[28rem] h-[28rem] rounded-full bg-[#1D6FE8]/10 blur-3xl" />
      <div aria-hidden className="pointer-events-none absolute -bottom-40 -right-40 w-[28rem] h-[28rem] rounded-full bg-coral-500/10 blur-3xl" />

      <header className="relative z-10 flex items-center justify-between px-6 sm:px-10 py-6">
        <img src={scatterPieLogo} alt="ScatterPie" className="h-7 sm:h-8 w-auto select-none" draggable={false} />
      </header>

      <main className="relative z-10 flex-1 flex items-center justify-center px-4 pb-10">
        <div className="w-full max-w-sm glass-panel rounded-2xl p-8 space-y-6 shadow-lg">
          <div className="flex flex-col items-center text-center space-y-3">
            <div className="w-12 h-12 bg-coral-500 rounded-2xl flex items-center justify-center shadow-[0_0_20px_rgba(240,86,55,0.35)]">
              <Languages className="w-6 h-6 text-white" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-foreground tracking-tight font-display">Dubly Studio</h1>
              <p className="text-xs text-muted-foreground mt-1">
                Sign in with your ScatterPie account to continue.
              </p>
            </div>
          </div>

          <form onSubmit={handleEmailSubmit} className="space-y-3">
            <div className="relative">
              <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Email address"
                className="w-full pl-10 pr-3 py-2.5 rounded-md bg-white border border-border text-sm text-foreground placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-coral-500/30 focus:border-coral-400"
              />
            </div>
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input
                type="password"
                required
                minLength={6}
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Password"
                className="w-full pl-10 pr-3 py-2.5 rounded-md bg-white border border-border text-sm text-foreground placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-coral-500/30 focus:border-coral-400"
              />
            </div>

            <button
              type="submit"
              disabled={isSigningIn}
              className="w-full flex items-center justify-center gap-2 py-2.5 rounded-md bg-coral-500 hover:bg-coral-600 text-white font-semibold text-sm shadow-sm transition-all disabled:opacity-60"
            >
              {isSigningIn && <Loader2 className="w-4 h-4 animate-spin" />}
              <span>Sign In</span>
            </button>
          </form>

          {/* Accounts are provisioned by ScatterPie, so there is deliberately no self-serve sign-up here. */}
          <p className="text-center text-xs text-muted-foreground">
            Don&apos;t have an account? Contact <span className="font-semibold text-foreground">ScatterPie</span> to get access.
          </p>

          {error && (
            <p className="text-xs text-danger text-center bg-red-50 border border-red-200 rounded-md p-3">
              {error}
            </p>
          )}
        </div>
      </main>

      <footer className="relative z-10 flex items-center justify-center gap-2 pb-6 text-[11px] text-muted-foreground">
        <span>Powered by</span>
        <img src={scatterPieLogo} alt="ScatterPie" className="h-3.5 w-auto opacity-80" draggable={false} />
      </footer>
    </div>
  );
};
