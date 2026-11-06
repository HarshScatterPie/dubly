/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { clearBootCaches } from '../lib/bootCache';
import { ApiError, SESSION_ENDED_EVENT, authFetch } from '../lib/apiClient';

export interface UserProfile {
  name: string;
  role: string;
  workspace: string;
  // A small image (data: URL) the person chose in Dubly's Settings.
  avatar?: string | null;
}

/**
 * The signed-in account. The session itself is an httpOnly cookie the browser sends with every request; no script, this one
 * included, can read it. `displayName` and `photoURL` keep the shape the screens already use; the real name and picture are in `profile`.
 */
export interface AuthUser {
  uid: string;
  email: string;
  emailVerified: boolean;
  displayName: string | null;
  photoURL: string | null;
}

interface AuthContextValue {
  user: AuthUser | null;
  /** The name and picture chosen at sign-up or in Settings; `null` once loaded if there is none, `undefined` while loading. */
  profile: UserProfile | null | undefined;
  loading: boolean;
  error: string | null;
  /** Set when the page was opened from a password-reset email; the sign-in screen then asks for the new password. */
  resetToken: string | null;
  /** A message to show on the sign-in screen after an email link was used (or could not be). */
  notice: string | null;
  signInWithEmail: (email: string, password: string) => Promise<void>;
  /** Creates an account; it is used once the emailed link confirms the address. */
  signUp: (name: string, email: string, password: string) => Promise<void>;
  // Emails a set-a-new-password link; says nothing about whether the account exists.
  sendPasswordReset: (email: string) => Promise<void>;
  completePasswordReset: (password: string) => Promise<void>;
  cancelPasswordReset: () => void;
  resendVerification: () => Promise<boolean>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  // The profile arrives with the app's startup data (GET /api/bootstrap) rather than in a request of its own.
  primeProfile: (profile: UserProfile | null) => void;
  signOut: () => Promise<void>;
}

interface ServerUser {
  uid: string;
  email: string;
  emailVerified: boolean;
  displayName?: string | null;
}

const toAuthUser = (u: ServerUser): AuthUser => ({ uid: u.uid, email: u.email, emailVerified: u.emailVerified, displayName: u.displayName ?? null, photoURL: null });

export function friendlyAuthError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 429) return 'Too many attempts. Wait a few minutes, or reset your password with "Forgot password?".';
    if (err.status === 0) return 'Could not reach Dubly. Check your connection and try again.';
    return err.message;
  }
  return (err as Error)?.message || 'Something went wrong. Please try again.';
}

// Takes a one-time token from the address bar (an emailed link), so it is not left in the history or sent on as a Referer.
function takeParam(name: 'verify' | 'reset'): string | null {
  const url = new URL(window.location.href);
  const value = url.searchParams.get(name);
  if (!value) return null;
  url.searchParams.delete(name);
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  return value;
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  return authFetch<T>(path, { method: 'POST', body });
}

const AuthContext = createContext<AuthContextValue | null>(null);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [profile, setProfile] = useState<UserProfile | null | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [resetToken, setResetToken] = useState<string | null>(null);

  // On load: finish an emailed link if the page was opened from one, otherwise ask the server whether this browser has a session.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const verify = takeParam('verify');
      const reset = takeParam('reset');
      if (reset) setResetToken(reset);
      try {
        if (verify) {
          try {
            const { user: verified } = await post<{ user: ServerUser }>('/api/auth/verify-email', { token: verify });
            if (!cancelled) {
              setUser(toAuthUser(verified));
              setNotice(null);
            }
            return;
          } catch (err) {
            if (!cancelled) setNotice(friendlyAuthError(err));
          }
        }
        const { user: current } = await authFetch<{ user: ServerUser }>('/api/auth/me');
        if (!cancelled) setUser(toAuthUser(current));
      } catch {
        if (!cancelled) setUser(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Signing out forgets the profile; on sign-in the app primes it (child effects run first, so this must not reset a primed one).
  useEffect(() => {
    if (!user) setProfile(undefined);
  }, [user]);

  // The server turned a request away as unauthenticated: the session ended (signed out everywhere, password changed, removed by an admin).
  // The person is signed out on the spot instead of staring at failing screens.
  useEffect(() => {
    let checking = false;
    const onSessionEnded = async () => {
      if (checking) return;
      checking = true;
      try {
        await authFetch('/api/auth/me');
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          clearBootCaches();
          setError('Your session has ended. Sign in again, or ask your workspace admin if you were removed.');
          setUser(null);
        }
      } finally {
        checking = false;
      }
    };
    window.addEventListener(SESSION_ENDED_EVENT, onSessionEnded);
    return () => window.removeEventListener(SESSION_ENDED_EVENT, onSessionEnded);
  }, []);

  const run = useCallback(async <T,>(task: () => Promise<T>): Promise<T> => {
    setError(null);
    try {
      return await task();
    } catch (err) {
      setError(friendlyAuthError(err));
      throw err;
    }
  }, []);

  const signInWithEmail = (email: string, password: string) =>
    run(async () => {
      const { user: signedIn } = await post<{ user: ServerUser }>('/api/auth/login', { email: email.trim(), password });
      setNotice(null);
      setUser(toAuthUser(signedIn));
    });

  const signUp = (name: string, email: string, password: string) =>
    run(async () => {
      await post('/api/auth/signup', { name: name.trim(), email: email.trim(), password });
    });

  const sendPasswordReset = (email: string) =>
    run(async () => {
      await post('/api/auth/forgot-password', { email: email.trim() });
    });

  const completePasswordReset = (password: string) =>
    run(async () => {
      if (!resetToken) throw new Error('This reset link is no longer open. Ask for a new one with "Forgot password?".');
      const { user: signedIn } = await post<{ user: ServerUser }>('/api/auth/reset-password', { token: resetToken, password });
      setResetToken(null);
      setUser(toAuthUser(signedIn));
    });

  const resendVerification = async () => {
    const result = await post<{ emailed?: boolean } | undefined>('/api/auth/resend-verification');
    return result?.emailed !== false;
  };

  // Every other device is signed out; this one gets a fresh session.
  const changePassword = async (currentPassword: string, newPassword: string) => {
    const { user: signedIn } = await post<{ user: ServerUser }>('/api/auth/change-password', { currentPassword, newPassword });
    setUser(toAuthUser(signedIn));
  };

  const signOut = async () => {
    clearBootCaches();
    await post('/api/auth/logout').catch(() => undefined);
    setUser(null);
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        profile,
        loading,
        error,
        resetToken,
        notice,
        signInWithEmail,
        signUp,
        sendPasswordReset,
        completePasswordReset,
        cancelPasswordReset: () => setResetToken(null),
        resendVerification,
        changePassword,
        primeProfile: setProfile,
        signOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
