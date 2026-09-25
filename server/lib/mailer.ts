import nodemailer, { type Transporter } from 'nodemailer';
import { env } from './env';
import { log } from './log';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

type Send = (message: MailMessage & { from: string }) => Promise<unknown>;

let transport: Transporter | null = null;
let sendOverride: Send | null = null;

// Mail goes out only when an SMTP account is configured (the same one Firebase's custom SMTP uses works); without it invitations are shared by link.
export function isMailConfigured(): boolean {
  return Boolean(sendOverride || (env.smtpHost && env.mailFrom));
}

function send(): Send {
  if (sendOverride) return sendOverride;
  if (!transport) {
    transport = nodemailer.createTransport({
      host: env.smtpHost,
      port: env.smtpPort,
      // Port 465 speaks TLS from the start; 587 and 25 upgrade with STARTTLS, which nodemailer requires when it is offered.
      secure: env.smtpPort === 465,
      auth: env.smtpUser ? { user: env.smtpUser, pass: env.smtpPass } : undefined,
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 30_000,
    });
  }
  const active = transport;
  return (message) => active.sendMail(message);
}

// True once the server accepted the message; failures are logged with the reason and reported as false, never thrown.
export async function sendMail(message: MailMessage): Promise<boolean> {
  if (!isMailConfigured()) return false;
  try {
    await send()({ ...message, from: env.mailFrom || 'Dubly <no-reply@localhost>' });
    log.info('mail_sent', { subject: message.subject });
    return true;
  } catch (err) {
    log.error('mail_failed', err, { subject: message.subject });
    return false;
  }
}

// Test seam: captures outgoing mail instead of opening an SMTP connection.
export function setMailSenderForTests(fn: Send | null): void {
  sendOverride = fn;
}

// Names and messages come from users, so they are escaped before they reach an HTML email.
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
