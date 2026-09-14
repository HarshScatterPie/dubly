/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { Languages, Loader2, Mail, Lock } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

export const Login: React.FC = () => {
  const { signInWithEmail, signUpWithEmail, error } = useAuth();
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const handleEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) return;
    setIsSigningIn(true);
    try {
      if (mode === 'signin') {
        await signInWithEmail(email, password);
      } else {
        await signUpWithEmail(email, password);
      }
    } catch {
      // error surfaced via useAuth().error
    } finally {
      setIsSigningIn(false);
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground flex items-center justify-center px-4 antialiased">
      <div className="w-full max-w-sm glass-panel rounded-2xl p-8 space-y-6 shadow-lg">
        <div className="flex flex-col items-center text-center space-y-3">
          <div className="w-12 h-12 bg-coral-500 rounded-2xl flex items-center justify-center shadow-[0_0_20px_rgba(240,86,55,0.35)]">
            <Languages className="w-6 h-6 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-foreground tracking-tight font-display">Dubly Studio</h1>
            <p className="text-xs text-muted-foreground mt-1">
              Sign in with your ScatterStudio account to continue.
            </p>
          </div>
        </div>

        <form onSubmit={handleEmailSubmit} className="space-y-3">
          <div className="relative">
            <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              type="email"
              required
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
            <span>{mode === 'signin' ? 'Sign In' : 'Create Account'}</span>
          </button>
        </form>

        <button
          type="button"
          onClick={() => setMode(mode === 'signin' ? 'signup' : 'signin')}
          className="w-full text-center text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          {mode === 'signin' ? "Don't have an account? " : 'Already have an account? '}
          <span className="text-coral-600 font-semibold">
            {mode === 'signin' ? 'Create one' : 'Sign in'}
          </span>
        </button>

        {error && (
          <p className="text-xs text-danger text-center bg-red-50 border border-red-200 rounded-md p-3">
            {error}
          </p>
        )}
      </div>
    </div>
  );
};
