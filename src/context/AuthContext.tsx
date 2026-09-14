/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { createContext, useContext, useEffect, useState } from 'react';
import {
  onAuthStateChanged,
  signInWithPopup,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut as firebaseSignOut,
  type User,
} from 'firebase/auth';
import { auth, googleProvider } from '../lib/firebase';
import { apiGet } from '../lib/apiClient';

export interface UserProfile {
  name: string;
  role: string;
  workspace: string;
}

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
  signUpWithEmail: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
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

  useEffect(() => {
    if (!user) {
      setProfile(undefined);
      return;
    }
    let cancelled = false;
    setProfile(undefined);
    apiGet<UserProfile | null>('/api/profile')
      .then((p) => {
        if (!cancelled) setProfile(p);
      })
      .catch(() => {
        // No ScatterStudio record for this account — not an error the user needs to see,
        // callers fall back to Firebase Auth's own displayName/email.
        if (!cancelled) setProfile(null);
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

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
      setError((err as Error).message || 'Sign-in failed');
      throw err;
    }
  };

  const signUpWithEmail = async (email: string, password: string) => {
    setError(null);
    try {
      await createUserWithEmailAndPassword(auth, email, password);
    } catch (err) {
      setError((err as Error).message || 'Account creation failed');
      throw err;
    }
  };

  const signOut = async () => {
    await firebaseSignOut(auth);
  };

  return (
    <AuthContext.Provider
      value={{ user, profile, loading, error, signInWithGoogle, signInWithEmail, signUpWithEmail, signOut }}
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
