import { env } from './env';
import { escapeHtml, isMailConfigured, sendMail, type MailMessage } from './mailer';
import { log } from './log';

// Links in these emails open the app, which finishes the step (see src/context/AuthContext.tsx).
export function authLink(param: 'verify' | 'reset', token: string): string {
  return `${env.webOrigin.replace(/\/+$/, '')}/?${param}=${encodeURIComponent(token)}`;
}

function layout(heading: string, intro: string, button: string, link: string, footer: string): string {
  const e = escapeHtml;
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#0F172A">
  <h2 style="font-size:18px;margin:0 0 12px">${e(heading)}</h2>
  <p style="font-size:14px;line-height:1.5">${e(intro)}</p>
  <p style="margin:24px 0"><a href="${e(link)}" style="background:#F05637;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:bold;font-size:14px;display:inline-block">${e(button)}</a></p>
  <p style="font-size:12px;color:#94A3B8;word-break:break-all">Or copy this link: ${e(link)}</p>
  <p style="font-size:12px;color:#94A3B8">${e(footer)}</p>
</div>`;
}

export function buildVerifyEmail(to: string, link: string): MailMessage {
  const intro = 'Confirm this is your email address to finish setting up your Dubly account.';
  const footer = "The link works for 24 hours. If you didn't create a Dubly account, you can ignore this email.";
  return {
    to,
    subject: 'Confirm your email for Dubly',
    text: [intro, '', link, '', footer].join('\n'),
    html: layout('Confirm your email', intro, 'Confirm email', link, footer),
  };
}

export function buildResetEmail(to: string, link: string): MailMessage {
  const intro = 'Someone asked to reset the password of the Dubly account for this address. Choose a new password with the link below.';
  const footer = "The link works for 30 minutes, once. If you didn't ask for this, ignore this email: your password stays as it is.";
  return {
    to,
    subject: 'Reset your Dubly password',
    text: [intro, '', link, '', footer].join('\n'),
    html: layout('Reset your password', intro, 'Choose a new password', link, footer),
  };
}

// For accounts brought over from the old sign-in: the old password no longer works, so everyone chooses a new one.
export function buildMovedAccountEmail(to: string, link: string, hours: number): MailMessage {
  const intro =
    'Dubly has moved to its own sign-in. Your workspace, projects and team came with you, but your old password did not. Choose a new password with the link below, then sign in with this email address.';
  const footer = `The link works once, for ${hours} hours. After that, use "Forgot password?" on the sign-in page to get a new one.`;
  return {
    to,
    subject: 'Dubly has moved: choose your new password',
    text: [intro, '', link, '', footer].join('\n'),
    html: layout('Choose your new Dubly password', intro, 'Choose a new password', link, footer),
  };
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
