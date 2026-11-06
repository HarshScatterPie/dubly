import { sendMail, type MailMessage } from './mailer';
import { composeEmail } from './emailTemplates';
import { appUrl } from './authEmail';
import type { InviteSummary } from './workspaces';

// The same link the Team page shows; WEB_ORIGIN must be the address people open Dubly at.
export function inviteUrl(token: string): string {
  return `${appUrl()}/?invite=${encodeURIComponent(token)}`;
}

export function buildInviteEmail(invite: InviteSummary, workspaceName: string, link: string): MailMessage {
  const role = invite.role === 'admin' ? 'Admin' : 'Editor';
  const until = new Date(invite.expiresAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });
  const inviter = invite.invitedByName || 'A teammate';
  return composeEmail({
    to: invite.email,
    subject: `${inviter} invited you to ${workspaceName} on Dubly`,
    preheader: `Join ${workspaceName} and start dubbing videos together.`,
    hero: 'sunrise',
    eyebrow: "You're invited",
    title: `Join ${workspaceName} on Dubly`,
    paragraphs: [
      `${inviter} invited you to the **${workspaceName}** workspace. You will share its projects, voices and glossary with the rest of the team.`,
      `New to Dubly? You'll choose a password first. Already have an account? Sign in with **${invite.email}**, then press **Join workspace**.`,
    ],
    details: [
      ['Workspace', workspaceName],
      ['Your role', role],
      ['Invited by', inviter],
      ['Link works until', until],
    ],
    button: { label: 'Open invitation', url: link },
    footnote: `The link works only for **${invite.email}**. If you weren't expecting this invitation, you can ignore this email.`,
  });
}

// Emails the invitation when mail is configured; false means the admin shares the link by hand, as before.
export function emailInvite(invite: InviteSummary, workspaceName: string, token: string): Promise<boolean> {
  return sendMail(buildInviteEmail(invite, workspaceName, inviteUrl(token)));
}
