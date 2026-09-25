import { env } from './env';
import { escapeHtml, sendMail, type MailMessage } from './mailer';
import type { InviteSummary } from './workspaces';

// The same link the Team page shows; WEB_ORIGIN must be the address people open Dubly at.
export function inviteUrl(token: string): string {
  return `${env.webOrigin.replace(/\/+$/, '')}/?invite=${encodeURIComponent(token)}`;
}

export function buildInviteEmail(invite: InviteSummary, workspaceName: string, link: string): MailMessage {
  const role = invite.role === 'admin' ? 'an Admin' : 'an Editor';
  const until = new Date(invite.expiresAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });
  const inviter = invite.invitedByName || 'A teammate';
  const subject = `${inviter} invited you to ${workspaceName} on Dubly`;
  const text = [
    `${inviter} invited you to join the ${workspaceName} workspace on Dubly as ${role}.`,
    '',
    `Open this link, sign in with ${invite.email}, and press Join workspace:`,
    link,
    '',
    `The link works until ${until}, and only for ${invite.email}. If you don't know your password, use "Forgot password?" on the sign-in page.`,
    "If you weren't expecting this invitation, you can ignore this email.",
  ].join('\n');
  const e = escapeHtml;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#0F172A">
  <h2 style="font-size:18px;margin:0 0 12px">Join ${e(workspaceName)} on Dubly</h2>
  <p style="font-size:14px;line-height:1.5">${e(inviter)} invited you to join the <strong>${e(workspaceName)}</strong> workspace as ${role}.</p>
  <p style="margin:24px 0"><a href="${e(link)}" style="background:#F05637;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:bold;font-size:14px;display:inline-block">Open invitation</a></p>
  <p style="font-size:13px;line-height:1.5;color:#475569">Sign in with <strong>${e(invite.email)}</strong>, then press <em>Join workspace</em>. The link works until ${e(until)}, and only for that email. If you don't know your password, use <em>Forgot password?</em> on the sign-in page.</p>
  <p style="font-size:12px;color:#94A3B8;word-break:break-all">Or copy this link: ${e(link)}</p>
  <p style="font-size:12px;color:#94A3B8">If you weren't expecting this invitation, you can ignore this email.</p>
</div>`;
  return { to: invite.email, subject, text, html };
}

// Emails the invitation when mail is configured; false means the admin shares the link by hand, as before.
export function emailInvite(invite: InviteSummary, workspaceName: string, token: string): Promise<boolean> {
  return sendMail(buildInviteEmail(invite, workspaceName, inviteUrl(token)));
}
