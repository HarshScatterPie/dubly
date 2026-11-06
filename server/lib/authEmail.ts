import { env } from './env';
import { isMailConfigured, sendMail, type MailMessage } from './mailer';
import { composeEmail } from './emailTemplates';
import { log } from './log';

// Links in these emails open the app, which finishes the step (see src/context/AuthContext.tsx).
export function authLink(param: 'verify' | 'reset' | 'magic', token: string): string {
  return `${appUrl()}/?${param}=${encodeURIComponent(token)}`;
}

export const appUrl = () => env.webOrigin.replace(/\/+$/, '');

const IST = (date: Date) =>
  date.toLocaleString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }) + ' IST';

export function buildVerifyEmail(to: string, link: string): MailMessage {
  return composeEmail({
    to,
    subject: 'Confirm your email for Dubly',
    preheader: 'One click and your Dubly account is ready.',
    hero: 'sunrise',
    eyebrow: 'Almost there',
    title: 'Confirm your email',
    paragraphs: [
      'Thanks for signing up for Dubly. Confirm this is your address and your workspace opens straight away, with your free dubbing minutes ready to use.',
    ],
    button: { label: 'Confirm email', url: link },
    footnote: "The link works for **24 hours**. If you didn't create a Dubly account, you can ignore this email; nothing will happen.",
  });
}

export function buildResetEmail(to: string, link: string): MailMessage {
  return composeEmail({
    to,
    subject: 'Reset your Dubly password',
    preheader: 'Choose a new password for your Dubly account.',
    hero: 'night',
    eyebrow: 'Password reset',
    title: 'Choose a new password',
    paragraphs: ['Someone, hopefully you, asked to reset the password of the Dubly account for this address. Use the button to choose a new one.'],
    button: { label: 'Choose a new password', url: link },
    callout: { tone: 'security', title: "Didn't ask for this?", text: 'Ignore this email. Your password stays as it is, and the link stops working on its own.' },
    footnote: 'The link works **once**, for **30 minutes**. Choosing a new password signs you out on every other device.',
  });
}

// For accounts brought over from the old sign-in: the old password no longer works, so everyone chooses a new one.
export function buildMovedAccountEmail(to: string, link: string, hours: number): MailMessage {
  return composeEmail({
    to,
    subject: 'Dubly has moved: choose your new password',
    preheader: 'Your workspace, projects and videos came along. Pick a new password to get back in.',
    hero: 'sunrise',
    eyebrow: 'A new home for Dubly',
    title: 'Dubly has moved, and everything came with you',
    paragraphs: [
      'Dubly now runs on its own sign-in. Your **workspace, projects, videos and team** are already there, exactly as you left them.',
      'Your old password did not make the move, so choose a new one with the button below. Then sign in with this email address.',
    ],
    details: [
      ['Dubly is now at', appUrl()],
      ['Sign in with', to],
    ],
    button: { label: 'Choose my new password', url: link },
    callout: { tone: 'info', text: `Bookmark **${appUrl().replace(/^https?:\/\//, '')}**: that is Dubly's address from now on.` },
    footnote: `The link works once, for **${hours} hours**. After that, use **Forgot password?** on the sign-in page to get a new one.`,
  });
}

export interface WelcomeFacts {
  name?: string;
  workspaceName?: string;
  planName?: string;
  minutesLeft?: number;
  // An account brought over from the old sign-in: welcomed back rather than introduced.
  returning?: boolean;
}

export function buildWelcomeEmail(to: string, facts: WelcomeFacts): MailMessage {
  const first = facts.name?.trim().split(/\s+/)[0];
  const rows: [string, string][] = [];
  if (facts.workspaceName) rows.push(['Workspace', facts.workspaceName]);
  if (facts.planName) rows.push(['Plan', facts.planName]);
  if (facts.minutesLeft !== undefined) rows.push(['Dubbing minutes left', `${facts.minutesLeft} min`]);
  const hello = facts.returning ? 'Welcome back' : 'Welcome aboard';
  return composeEmail({
    to,
    subject: facts.returning ? 'Welcome back to Dubly' : first ? `Welcome to Dubly, ${first}` : 'Welcome to Dubly',
    preheader: facts.returning ? 'You are signed in to the new Dubly. Everything is where you left it.' : 'Your first dub is four steps away.',
    hero: 'sunrise',
    eyebrow: facts.returning ? 'Signed in' : 'Welcome',
    title: first ? `${hello}, ${first}` : hello,
    paragraphs: facts.returning
      ? ["You're signed in to the new Dubly, and your projects, videos and team are all where you left them. A quick reminder of how a dub goes:"]
      : ["You're in. Dubly turns one video into many languages, in voices that keep the speaker's tone. Here is how a dub goes:"],
    steps: [
      { title: 'Upload a video', text: 'Any talk, ad or explainer up to an hour long.' },
      { title: 'Check what was said', text: 'Dubly writes down every line with its speaker. Fix a word if you need to.' },
      { title: 'Pick languages and voices', text: 'Hindi, Tamil, Bengali and 40 more, each speaker with a voice of their own.' },
      { title: 'Dub, review and share', text: 'Listen line by line, re-take any line, then download or share a link.' },
    ],
    ...(rows.length ? { details: rows } : {}),
    button: { label: 'Open Dubly', url: appUrl() },
    footnote: 'Questions or ideas? Just reply to this email; a real person reads it.',
  });
}

export interface RequestOrigin {
  device: string;
  location: string | null;
  ip: string | null;
  at: Date;
}

const originRows = (o: RequestOrigin): [string, string][] => [
  ['When', IST(o.at)],
  ['Device', o.device],
  ['Location', o.location ?? 'Not known'],
  ['IP address', o.ip ?? 'Not known'],
];

export function buildMagicLinkEmail(to: string, link: string, from: RequestOrigin, minutes: number): MailMessage {
  return composeEmail({
    to,
    subject: 'Your Dubly sign-in link',
    preheader: 'Tap to sign in, no password needed.',
    hero: 'sunrise',
    eyebrow: 'Sign in',
    title: 'Your sign-in link',
    paragraphs: [
      'Tap the button to sign in to Dubly. On the **same device and browser** you asked from, you are in straight away.',
      'Opened it somewhere else, like your phone? It shows a **6-digit code**: type it on the device where you asked to sign in.',
    ],
    button: { label: 'Sign in to Dubly', url: link },
    details: originRows(from),
    callout: { tone: 'security', title: "Didn't ask for this?", text: 'Ignore this email. Nobody can sign in without opening it, and never read the code out to anyone.' },
    footnote: `The link works **once**, for **${minutes} minutes**.`,
  });
}

export function buildNewDeviceEmail(to: string, sign: RequestOrigin & { method: string }): MailMessage {
  return composeEmail({
    to,
    subject: `New sign-in to Dubly from ${sign.device}`,
    preheader: `${sign.device}${sign.location ? `, ${sign.location}` : ''}. If this was you, there is nothing to do.`,
    hero: 'night',
    eyebrow: 'Security notice',
    title: 'New sign-in to your account',
    paragraphs: ['Your Dubly account was just signed in on a device it has not used before. If this was you, there is nothing to do.'],
    details: [...originRows(sign), ['Signed in with', sign.method]],
    callout: {
      tone: 'security',
      title: "Wasn't you?",
      text: 'Reset your password with **Forgot password?** on the sign-in page, then use **Sign out everywhere** in Settings. Tell your workspace admin too.',
    },
    button: { label: 'Secure my account', url: appUrl() },
    footnote: 'We send this the first time each device signs in to your account. Location is approximate, worked out from the network address.',
  });
}

export function buildPasswordChangedEmail(to: string, how: 'reset' | 'change', when = new Date()): MailMessage {
  return composeEmail({
    to,
    subject: 'Your Dubly password was changed',
    preheader: 'If this was you, there is nothing to do.',
    hero: 'night',
    eyebrow: 'Security notice',
    title: 'Your password was changed',
    paragraphs: [
      `The password of your Dubly account was ${how === 'reset' ? 'reset with an emailed link' : 'changed from Settings'} on **${IST(when)}**. Every other device was signed out.`,
    ],
    callout: {
      tone: 'security',
      title: "Wasn't you?",
      text: 'Reset your password right away with **Forgot password?** on the sign-in page, and tell your workspace admin.',
    },
    button: { label: 'Go to Dubly', url: appUrl() },
    footnote: 'We send this every time the password changes, so you always know.',
  });
}

/**
 * Sends a verification or reset email. Without SMTP outside production the link goes to the server log instead, so a local
 * install works without a mail account; in production it is never logged (the link is as good as the password).
 */
export async function deliverAuthEmail(message: MailMessage, link: string): Promise<boolean> {
  if (isMailConfigured()) return sendMail(message);
  if (process.env.NODE_ENV !== 'production') {
    log.warn('auth_email_not_sent', { subject: message.subject }, `[auth] SMTP is not configured; open this link to continue (${message.subject}): ${link}`);
    return false;
  }
  log.error('auth_email_not_sent', new Error('SMTP is not configured'), { subject: message.subject });
  return false;
}
