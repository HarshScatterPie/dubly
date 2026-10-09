/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { createContext, useContext, useEffect, useState } from 'react';
import {
  onAuthStateChanged,
  signInWithPopup,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  signOut as firebaseSignOut,
  type User,
} from 'firebase/auth';
import { auth, googleProvider } from '../lib/firebase';
import { clearBootCaches } from '../lib/bootCache';
import { SESSION_ENDED_EVENT } from '../lib/apiClient';

export interface UserProfile {
  name: string;
  role: string;
  workspace: string;
  // A small image (data: URL) the person chose in Dubly's Settings.
  avatar?: string | null;
}

// What Firebase says when a session can never be renewed: signed out everywhere, disabled, or the login deleted.
const DEAD_SESSION = /user-token-expired|user-disabled|user-not-found|invalid-user-token/;

interface AuthContextValue {
  user: User | null;
  /**
   * The `users/{uid}` record from ScatterStudio's shared Firestore project — name, role,
   * workspace. Firebase Auth's own displayName is usually empty (only Google sign-in fills
   * it in), so this, not that, is the real source of truth for a user's name here; it is
   * also what every other ScatterStudio tool already shows. `null` once loaded if the
   * signed-in account has no such record (e.g. a test account created directly in Firebase
   * Auth rather than through ScatterStudio's own onboarding); `undefined` while loading.
   */
  profile: UserProfile | null | undefined;
  loading: boolean;
  error: string | null;
  signInWithGoogle: () => Promise<void>;
  signInWithEmail: (email: string, password: string) => Promise<void>;
  // Emails a set-a-new-password link through Firebase itself; says nothing about whether the account exists.
  sendPasswordReset: (email: string) => Promise<void>;
  // The profile arrives with the app's startup data (GET /api/bootstrap) rather than in a request of its own.
  primeProfile: (profile: UserProfile | null) => void;
  signOut: () => Promise<void>;
}

// Firebase's error codes in words a person signing in can act on.
export function friendlyAuthError(err: unknown): string {
  const code = String((err as { code?: string })?.code ?? '');
  if (/invalid-credential|wrong-password|user-not-found|invalid-login-credentials/.test(code)) {
    return 'That email and password do not match. Use your ScatterPie account password (the same one as ScatterStudio), or reset it with "Forgot password?".';
  }
  if (code.includes('too-many-requests')) return 'Too many attempts. Wait a few minutes, or reset your password with "Forgot password?".';
  if (code.includes('user-disabled')) return 'This account has been disabled. Contact ScatterPie.';
  if (code.includes('invalid-email')) return 'Enter a valid email address.';
  if (code.includes('network-request-failed')) return 'Could not reach the sign-in service. Check your connection and try again.';
  return (err as Error)?.message || 'Sign-in failed';
}

const AuthContext = createContext<AuthContextValue | null>(null);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setLoading(false);
    });
    return unsubscribe;
  }, []);

  // Signing out forgets the profile; on sign-in the app primes it (child effects run first, so this must not reset a primed one).
  useEffect(() => {
    if (!user) setProfile(undefined);
  }, [user]);

  // The server turned a request away as unauthenticated. If the session can be renewed that was a hiccup and nothing changes; if it cannot
  // (an admin removed this account, or it signed out everywhere) the person is signed out on the spot instead of staring at failing screens.
  useEffect(() => {
    let checking = false;
    const onSessionEnded = async () => {
      const current = auth.currentUser;
      if (!current || checking) return;
      checking = true;
      try {
        await current.getIdToken(true);
      } catch (err) {
        if (DEAD_SESSION.test(String((err as { code?: string })?.code ?? ''))) {
          clearBootCaches();
          setError('Your access to Dubly has ended. Sign in again, or ask your workspace admin if you were removed.');
          await firebaseSignOut(auth);
        }
      } finally {
        checking = false;
      }
    };
    window.addEventListener(SESSION_ENDED_EVENT, onSessionEnded);
    return () => window.removeEventListener(SESSION_ENDED_EVENT, onSessionEnded);
  }, []);

  const signInWithGoogle = async () => {
    setError(null);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      setError((err as Error).message || 'Sign-in failed');
      throw err;
    }
  };

  const signInWithEmail = async (email: string, password: string) => {
    setError(null);
    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch (err) {
      setError(friendlyAuthError(err));
      throw err;
    }
  };

  const sendPasswordReset = async (email: string) => {
    setError(null);
    try {
      await sendPasswordResetEmail(auth, email.trim());
    } catch (err) {
      // An unknown email is not reported, so nobody can use this to find out who has an account.
      if (/user-not-found/.test(String((err as { code?: string })?.code ?? ''))) return;
      setError(friendlyAuthError(err));
      throw err;
    }
  };

  const signOut = async () => {
    clearBootCaches();
    await firebaseSignOut(auth);
  };

  return (
    <AuthContext.Provider
      value={{ user, profile, loading, error, signInWithGoogle, signInWithEmail, sendPasswordReset, primeProfile: setProfile, signOut }}
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
