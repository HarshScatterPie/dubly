/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { Languages, Loader2, Mail, Lock, UserPlus, MailCheck, User as UserIcon, KeyRound } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { hasPendingInvite, pendingInviteToken } from './InviteAcceptDialog';
import { workspaceService, type InviteSignupInfo } from '../services/workspaceService';
import scatterPieLogo from '../assets/scatterpie-logo.png';

const MIN_PASSWORD = 8;

const inputClass =
  'w-full pl-10 pr-3 py-2.5 rounded-md bg-white border border-border text-sm text-foreground placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-coral-500/30 focus:border-coral-400';
const primaryButton =
  'w-full flex items-center justify-center gap-2 py-2.5 rounded-md bg-coral-500 hover:bg-coral-600 text-white font-semibold text-sm shadow-sm transition-all disabled:opacity-60';
const linkButton = 'text-xs font-semibold text-coral-600 hover:text-coral-700 disabled:opacity-60';

const Field: React.FC<{ icon: React.ElementType; children: React.ReactNode }> = ({ icon: Icon, children }) => (
  <div className="relative">
    <Icon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
    {children}
  </div>
);

// Checked here for a quick answer; the server checks the same rules again.
function passwordIssue(password: string, confirm: string): string | null {
  if (password.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (password !== confirm) return 'The two passwords do not match.';
  return null;
}

type Mode = 'signin' | 'signup' | 'check-email';

export const Login: React.FC = () => {
  const { signInWithEmail, signUp, sendPasswordReset, completePasswordReset, cancelPasswordReset, resetToken, notice, error, magicAttempt, requestMagicLink, verifyMagicCode, cancelMagic } =
    useAuth();
  // Sign in with an emailed link instead of a password.
  const [useLink, setUseLink] = useState(false);
  const [code, setCode] = useState('');
  const [resendIn, setResendIn] = useState(0);
  const [mode, setMode] = useState<Mode>('signin');
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [invited] = useState(hasPendingInvite);
  const [resetState, setResetState] = useState<'idle' | 'sending' | 'sent' | 'needs-email'>('idle');

  // A link for an email with no account yet opens a "set your password" form here instead of asking for a password nobody has.
  const [inviteToken] = useState(pendingInviteToken);
  const [signup, setSignup] = useState<InviteSignupInfo | null>(null);

  useEffect(() => {
    if (!inviteToken) return;
    workspaceService
      .lookupInviteSignup(inviteToken)
      .then((info) => {
        if (info.accountExists) return;
        setSignup(info);
        setEmail(info.email);
      })
      // An unusable link falls back to the normal sign-in; the join step explains what is wrong once they are in.
      .catch(() => {});
  }, [inviteToken]);

  const switchMode = (next: Mode) => {
    setMode(next);
    setFormError(null);
    setPassword('');
    setConfirm('');
    setResetState('idle');
  };

  const guarded = async (task: () => Promise<void>) => {
    setBusy(true);
    setFormError(null);
    try {
      await task();
    } catch (err) {
      setFormError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleInvitePassword = (e: React.FormEvent) => {
    e.preventDefault();
    if (!signup || !inviteToken) return;
    const issue = passwordIssue(password, confirm);
    if (issue) return setFormError(issue);
    void guarded(async () => {
      try {
        await workspaceService.claimInviteAccount(inviteToken, password);
        await signInWithEmail(signup.email, password);
      } catch (err) {
        // Someone created the account in the meantime: send them to the ordinary sign-in.
        if ((err as { status?: number }).status === 409) setSignup(null);
        throw err;
      }
    });
  };

  const handleReset = (e: React.FormEvent) => {
    e.preventDefault();
    const issue = passwordIssue(password, confirm);
    if (issue) return setFormError(issue);
    void guarded(() => completePasswordReset(password));
  };

  const handleSignUp = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setFormError('Enter your name.');
    const issue = passwordIssue(password, confirm);
    if (issue) return setFormError(issue);
    void guarded(async () => {
      await signUp(name, email, password);
      switchMode('check-email');
    });
  };

  // A new link may be asked for once a short wait has passed.
  useEffect(() => {
    if (resendIn <= 0) return;
    const t = window.setTimeout(() => setResendIn((n) => n - 1), 1000);
    return () => window.clearTimeout(t);
  }, [resendIn]);

  const sendLink = () =>
    guarded(async () => {
      await requestMagicLink(email);
      setCode('');
      setResendIn(30);
    });

  const handleCode = (e: React.FormEvent) => {
    e.preventDefault();
    if (code.replace(/\D/g, '').length !== 6) return setFormError('Enter the 6-digit code.');
    void guarded(() => verifyMagicCode(code));
  };

  const handleSignIn = (e: React.FormEvent) => {
    e.preventDefault();
    if (useLink) {
      if (email) void sendLink();
      return;
    }
    if (!email || !password) return;
    // The context shows the reason in `error`; nothing else to do here.
    void guarded(() => signInWithEmail(email, password).catch(() => undefined));
  };

  const handleForgotPassword = async () => {
    if (!email.trim()) {
      setResetState('needs-email');
      return;
    }
    setResetState('sending');
    try {
      await sendPasswordReset(email);
      setResetState('sent');
    } catch {
      setResetState('idle');
    }
  };

  const heading = magicAttempt
      ? 'Check your inbox'
      : resetToken
        ? 'Choose a new password'
        : signup
          ? 'Join your team'
          : mode === 'signup'
            ? 'Create your account'
            : 'Dubly Studio';
  const subheading = magicAttempt
      ? 'Your sign-in link is on its way.'
      : resetToken
    ? 'Set the password you will use to sign in from now on.'
    : mode === 'signup'
      ? 'Start dubbing in minutes. We will email you a link to confirm your address.'
      : mode === 'check-email'
        ? 'One more step.'
        : 'Sign in to continue.';
  const shownError = formError || (mode === 'signin' && !resetToken && !signup ? error : null);
  const showSignIn = !resetToken && !signup && !magicAttempt && mode === 'signin';

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
              <h1 className="text-xl font-bold text-foreground tracking-tight font-display">{heading}</h1>
              <p className="text-xs text-muted-foreground mt-1">{subheading}</p>
            </div>
          </div>

          {notice && !resetToken && <p className="text-xs text-center text-[#9A3412] bg-[#FFF4F1] border border-[#FFC4B3] rounded-md p-3">{notice}</p>}

          {/* This device asked for a link: wait for it, or take the code it shows on another device. */}
          {magicAttempt && (
            <div className="space-y-4">
              <p className="flex items-start gap-2 text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-md p-3">
                <MailCheck className="w-4 h-4 shrink-0" />
                <span>
                  If <strong>{magicAttempt.email}</strong> has a Dubly account, a sign-in link is on its way. Open it <strong>on this device</strong> and you are in
                  straight away. Opened it on your phone? It shows a 6-digit code: type it below.
                </span>
              </p>
              <form onSubmit={handleCode} className="space-y-3">
                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={7}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/[^\d]/g, '').slice(0, 6))}
                  placeholder="6-digit code"
                  className="w-full px-3 py-3 rounded-md bg-white border border-border text-center font-mono text-2xl tracking-[0.4em] text-foreground placeholder:text-sm placeholder:tracking-normal placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-coral-500/30 focus:border-coral-400"
                />
                <button type="submit" disabled={busy || code.length !== 6} className={primaryButton}>
                  {busy && <Loader2 className="w-4 h-4 animate-spin" />}
                  <span>Sign in with code</span>
                </button>
              </form>
              <div className="flex items-center justify-between">
                <button type="button" onClick={() => { cancelMagic(); setFormError(null); }} className={linkButton}>
                  Use my password instead
                </button>
                <button type="button" onClick={() => void sendLink()} disabled={busy || resendIn > 0} className={linkButton}>
                  {resendIn > 0 ? `Send again in ${resendIn}s` : 'Send a new link'}
                </button>
              </div>
            </div>
          )}

          {/* Opened from a password-reset email. */}
          {resetToken && (
            <form onSubmit={handleReset} className="space-y-3">
              <Field icon={Lock}>
                <input type="password" required minLength={MIN_PASSWORD} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={`New password (${MIN_PASSWORD}+ characters)`} className={inputClass} />
              </Field>
              <Field icon={Lock}>
                <input type="password" required minLength={MIN_PASSWORD} autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Confirm new password" className={inputClass} />
              </Field>
              <button type="submit" disabled={busy} className={primaryButton}>
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <KeyRound className="w-4 h-4" />}
                <span>Save password &amp; sign in</span>
              </button>
              <button type="button" onClick={() => { cancelPasswordReset(); switchMode('signin'); }} className={`${linkButton} block mx-auto`}>
                Back to sign in
              </button>
            </form>
          )}

          {/* A brand-new invitee chooses their first password. */}
          {!resetToken && signup && (
            <>
              <div className="flex items-start gap-2.5 p-3 rounded-md bg-[#FFF4F1] border border-[#FFC4B3] text-xs text-[#9A3412]">
                <UserPlus className="w-4 h-4 shrink-0 mt-0.5" />
                <p>
                  <strong>{signup.invitedByName}</strong> invited you to join <strong>{signup.workspaceName}</strong> as{' '}
                  {signup.role === 'admin' ? 'an Admin' : 'an Editor'}. Choose a password to create your account and join.
                </p>
              </div>
              <form onSubmit={handleInvitePassword} className="space-y-3">
                <Field icon={Mail}>
                  <input type="email" readOnly value={signup.email} className="w-full pl-10 pr-3 py-2.5 rounded-md bg-slate-50 border border-border text-sm text-muted-foreground" />
                </Field>
                <Field icon={Lock}>
                  <input type="password" required minLength={MIN_PASSWORD} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={`Create a password (${MIN_PASSWORD}+ characters)`} className={inputClass} />
                </Field>
                <Field icon={Lock}>
                  <input type="password" required minLength={MIN_PASSWORD} autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Confirm password" className={inputClass} />
                </Field>
                <button type="submit" disabled={busy} className={primaryButton}>
                  {busy && <Loader2 className="w-4 h-4 animate-spin" />}
                  <span>Set password &amp; continue</span>
                </button>
              </form>
            </>
          )}

          {!resetToken && !signup && mode === 'check-email' && (
            <div className="space-y-4">
              <p className="flex items-start gap-2 text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-md p-3">
                <MailCheck className="w-4 h-4 shrink-0" />
                <span>
                  We sent a confirmation link to <strong>{email.trim()}</strong>. Open it to finish creating your account; it works for 24 hours.
                  Check the spam folder too. If this address already has an account, the email explains how to get back in.
                </span>
              </p>
              <button type="button" onClick={() => switchMode('signin')} className={primaryButton}>
                Back to sign in
              </button>
            </div>
          )}

          {!resetToken && !signup && mode === 'signup' && (
            <form onSubmit={handleSignUp} className="space-y-3">
              <Field icon={UserIcon}>
                <input type="text" required maxLength={60} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" className={inputClass} />
              </Field>
              <Field icon={Mail}>
                <input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email address" className={inputClass} />
              </Field>
              <Field icon={Lock}>
                <input type="password" required minLength={MIN_PASSWORD} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={`Password (${MIN_PASSWORD}+ characters)`} className={inputClass} />
              </Field>
              <Field icon={Lock}>
                <input type="password" required minLength={MIN_PASSWORD} autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Confirm password" className={inputClass} />
              </Field>
              <button type="submit" disabled={busy} className={primaryButton}>
                {busy && <Loader2 className="w-4 h-4 animate-spin" />}
                <span>Create account</span>
              </button>
              <p className="text-center text-xs text-muted-foreground">
                Already have an account?{' '}
                <button type="button" onClick={() => switchMode('signin')} className={linkButton}>
                  Sign in
                </button>
              </p>
            </form>
          )}

          {showSignIn && (
            <>
              {invited && (
                <div className="flex items-start gap-2.5 p-3 rounded-md bg-[#FFF4F1] border border-[#FFC4B3] text-xs text-[#9A3412]">
                  <UserPlus className="w-4 h-4 shrink-0 mt-0.5" />
                  <p>
                    You have been invited to a Dubly workspace. Sign in with the <strong>email the invitation was sent to</strong>. Don&apos;t know its
                    password? Use <strong>Forgot password?</strong> below.
                  </p>
                </div>
              )}
              <form onSubmit={handleSignIn} className="space-y-3">
                <Field icon={Mail}>
                  <input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email address" className={inputClass} />
                </Field>
                {!useLink && (
                  <Field icon={Lock}>
                    <input type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" className={inputClass} />
                  </Field>
                )}
                <div className="flex items-center justify-between gap-3">
                  <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none">
                    <input type="checkbox" checked={useLink} onChange={(e) => setUseLink(e.target.checked)} className="w-4 h-4 rounded accent-coral-500" />
                    Email me a sign-in link (no password)
                  </label>
                  {!useLink && (
                    <button type="button" onClick={handleForgotPassword} disabled={resetState === 'sending'} className={`${linkButton} shrink-0`}>
                      {resetState === 'sending' ? 'Sending…' : 'Forgot password?'}
                    </button>
                  )}
                </div>
                <button type="submit" disabled={busy} className={primaryButton}>
                  {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : useLink ? <Mail className="w-4 h-4" /> : null}
                  <span>{useLink ? 'Email me a link' : 'Sign In'}</span>
                </button>
              </form>
              <p className="text-center text-xs text-muted-foreground">
                New to Dubly?{' '}
                <button type="button" onClick={() => switchMode('signup')} className={linkButton}>
                  Create an account
                </button>
              </p>
              {resetState === 'needs-email' && <p className="text-xs text-center text-muted-foreground">Enter your email above first, then press Forgot password? again.</p>}
              {resetState === 'sent' && (
                <p className="flex items-start gap-2 text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-md p-3">
                  <MailCheck className="w-4 h-4 shrink-0" />
                  <span>
                    If an account exists for <strong>{email.trim()}</strong>, a link to set a new password is on its way. It works for 30 minutes. Check
                    the inbox and the spam folder.
                  </span>
                </p>
              )}
            </>
          )}

          {shownError && <p className="text-xs text-danger text-center bg-red-50 border border-red-200 rounded-md p-3">{shownError}</p>}
        </div>
      </main>

      <footer className="relative z-10 flex items-center justify-center gap-2 pb-6 text-[11px] text-muted-foreground">
        <span>Powered by</span>
        <img src={scatterPieLogo} alt="ScatterPie" className="h-3.5 w-auto opacity-80" draggable={false} />
      </footer>
    </div>
  );
};
