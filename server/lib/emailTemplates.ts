import { readFileSync } from 'node:fs';
import path from 'node:path';
import { serverRoot } from './paths';
import type { MailAttachment, MailMessage } from './mailer';

/**
 * One look for every email Dubly sends: a card on a warm background with the Dubly mark, a hero picture (server/assets/email,
 * rendered by server/scripts/render_email_art.mjs), a title, the message, a button and a quiet footer, plus a plain-text copy.
 *
 * Email clients are not browsers: layout is tables and inline styles, gradients and shadows sit on top of solid colours that
 * Outlook falls back to, and pictures travel inside the message (cid:), so they show even when the machine serving Dubly is off.
 * Everything a person supplied (names, workspace names, messages) is escaped; `**text**` in our own copy becomes bold.
 */
export type HeroMood = 'sunrise' | 'dusk' | 'night';

export interface EmailContent {
  to: string;
  subject: string;
  // Shown by inboxes next to the subject.
  preheader: string;
  hero: HeroMood;
  eyebrow: string;
  title: string;
  paragraphs: string[];
  button?: { label: string; url: string };
  // A box under the text: a hint, a warning or a security note.
  callout?: { tone: 'info' | 'warning' | 'security' | 'success'; title?: string; text: string };
  // Label/value rows, e.g. a workspace and its plan.
  details?: [string, string][];
  // Numbered steps (the welcome email).
  steps?: { title: string; text: string }[];
  // A minutes meter: how much of the allowance is used.
  meter?: { used: number; limit: number; caption: string };
  // A quoted block of someone's own words (a quota request's message).
  quote?: string;
  footnote?: string;
}

const C = {
  page: '#F6EEE7',
  card: '#FFFFFF',
  ink: '#0F172A',
  body: '#334155',
  muted: '#64748B',
  faint: '#94A3B8',
  line: '#EFE6DF',
  coral: '#F05637',
  coralDeep: '#D9432A',
  coralSoft: '#FFF2EC',
  coralLine: '#FFD3C4',
};
const FONT = "'Figtree','Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const DISPLAY = "'Manrope','Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Escaped text with our own **bold** and line breaks.
function rich(text: string): string {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, `<strong style="color:${C.ink};font-weight:700">$1</strong>`)
    .replace(/\n/g, '<br>');
}
const plain = (text: string) => text.replace(/\*\*(.+?)\*\*/g, '$1');

const ASSETS = path.join(serverRoot, 'assets');
const files = new Map<string, Buffer>();
function asset(file: string): Buffer {
  let data = files.get(file);
  if (!data) {
    data = readFileSync(path.join(ASSETS, file));
    files.set(file, data);
  }
  return data;
}

function attachmentsFor(hero: HeroMood): MailAttachment[] {
  return [
    { filename: `dubly-${hero}.jpg`, content: asset(`email/hero-${hero}.jpg`), cid: `hero-${hero}@dubly`, contentType: 'image/jpeg' },
    { filename: 'dubly-mark.png', content: asset('email/dubly-mark.png'), cid: 'mark@dubly', contentType: 'image/png' },
    { filename: 'scatterpie.png', content: asset('scatterpie-logo.png'), cid: 'logo@dubly', contentType: 'image/png' },
  ];
}

const TONES = {
  info: { bg: '#F2F7FF', line: '#CFE0FB', ink: '#1E3A8A', icon: '&#9432;' },
  warning: { bg: '#FFF7EB', line: '#FBDDA9', ink: '#8A4B08', icon: '&#9888;' },
  security: { bg: '#F4F2FF', line: '#D8D1FA', ink: '#3B2D86', icon: '&#128274;' },
  success: { bg: '#EFFAF4', line: '#C5EBD5', ink: '#14653A', icon: '&#10003;' },
} as const;

function button(label: string, url: string): string {
  const href = escapeHtml(url);
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:30px 0 8px">
  <tr><td align="center" bgcolor="${C.coral}" style="border-radius:14px;background-color:${C.coral};background-image:linear-gradient(135deg,#FF8159 0%,${C.coral} 52%,${C.coralDeep} 100%);box-shadow:0 10px 22px rgba(217,67,42,0.32),inset 0 1px 0 rgba(255,255,255,0.35)">
    <a href="${href}" target="_blank" style="display:inline-block;padding:16px 32px;font-family:${DISPLAY};font-size:16px;line-height:20px;font-weight:800;color:#FFFFFF;text-decoration:none;border-radius:14px;letter-spacing:0.2px">${escapeHtml(label)}&nbsp;&rarr;</a>
  </td></tr></table>`;
}

function meter(m: NonNullable<EmailContent['meter']>): string {
  const pct = m.limit > 0 ? Math.max(0, Math.min(100, Math.round((m.used / m.limit) * 100))) : 100;
  const fill = pct >= 100 ? `${C.coralDeep}` : pct >= 80 ? '#F28C38' : C.coral;
  const fillGradient = pct >= 100 ? `linear-gradient(90deg,#F26443,${C.coralDeep})` : `linear-gradient(90deg,#FFB067,${fill})`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 4px">
  <tr><td style="font-family:${FONT};font-size:13px;color:${C.muted};padding-bottom:8px">${escapeHtml(m.caption)}</td>
      <td align="right" style="font-family:${DISPLAY};font-size:13px;font-weight:800;color:${C.ink};padding-bottom:8px">${pct}%</td></tr>
  <tr><td colspan="2" style="background:#F3EAE3;border-radius:999px;padding:3px;box-shadow:inset 0 1px 2px rgba(15,23,42,0.08)">
    <table role="presentation" width="${Math.max(pct, 3)}%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td height="12" bgcolor="${fill}" style="height:12px;line-height:12px;font-size:0;border-radius:999px;background-color:${fill};background-image:${fillGradient};box-shadow:inset 0 1px 0 rgba(255,255,255,0.45)">&nbsp;</td>
    </tr></table>
  </td></tr></table>`;
}

function details(rows: [string, string][]): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 4px;border:1px solid ${C.line};border-radius:16px;border-collapse:separate;overflow:hidden">
  ${rows
    .map(
      ([label, value], i) => `<tr>
    <td style="padding:13px 18px;font-family:${FONT};font-size:13px;color:${C.muted};width:38%;${i ? `border-top:1px solid ${C.line};` : ''}background:#FCF8F5">${escapeHtml(label)}</td>
    <td style="padding:13px 18px;font-family:${FONT};font-size:14px;color:${C.ink};font-weight:600;${i ? `border-top:1px solid ${C.line};` : ''}word-break:break-word">${escapeHtml(value)}</td>
  </tr>`
    )
    .join('')}
  </table>`;
}

function steps(list: NonNullable<EmailContent['steps']>): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:22px 0 0">
  ${list
    .map(
      (s, i) => `<tr><td valign="top" width="44" style="padding:0 0 18px">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td width="32" height="32" align="center" bgcolor="${C.coralSoft}" style="width:32px;height:32px;border-radius:12px;background-color:${C.coralSoft};background-image:linear-gradient(145deg,#FFF6F1,#FFE3D8);box-shadow:inset 0 1px 0 #FFFFFF,0 2px 6px rgba(240,86,55,0.18);font-family:${DISPLAY};font-size:14px;font-weight:800;color:${C.coralDeep}">${i + 1}</td></tr></table>
    </td><td valign="top" style="padding:4px 0 18px;font-family:${FONT}">
      <div style="font-size:15px;font-weight:700;color:${C.ink};line-height:22px">${escapeHtml(s.title)}</div>
      <div style="font-size:14px;color:${C.body};line-height:21px">${rich(s.text)}</div>
    </td></tr>`
    )
    .join('')}
  </table>`;
}

function callout(c: NonNullable<EmailContent['callout']>): string {
  const t = TONES[c.tone];
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 4px">
  <tr><td style="background:${t.bg};border:1px solid ${t.line};border-radius:16px;padding:16px 18px;font-family:${FONT};font-size:14px;line-height:21px;color:${t.ink}">
    ${c.title ? `<div style="font-weight:800;margin-bottom:4px">${t.icon}&nbsp; ${escapeHtml(c.title)}</div>` : ''}${rich(c.text)}
  </td></tr></table>`;
}

function quote(text: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:20px 0 4px">
  <tr><td style="border-left:4px solid ${C.coral};background:#FFF8F5;border-radius:0 14px 14px 0;padding:14px 18px;font-family:${FONT};font-size:14px;line-height:22px;color:${C.body}">${escapeHtml(text).replace(/\n/g, '<br>')}</td></tr></table>`;
}

export function renderHtml(e: EmailContent): string {
  const preheader = escapeHtml(e.preheader) + '&nbsp;&zwnj;'.repeat(40);
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">
<title>${escapeHtml(e.subject)}</title>
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@600;700;800&amp;family=Figtree:wght@400;500;600;700&amp;display=swap" rel="stylesheet">
<style>
  @media (max-width:640px){ .card{border-radius:0 !important} .px{padding-left:24px !important;padding-right:24px !important} .title{font-size:25px !important;line-height:33px !important} .hero{padding:0 !important} .hero img{border-radius:0 !important} }
  a{color:${C.coralDeep}}
</style>
</head>
<body style="margin:0;padding:0;background:${C.page};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all">${preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.page}" style="background-color:${C.page};background-image:linear-gradient(180deg,#FCE4D8 0px,${C.page} 380px)">
<tr><td align="center" style="padding:36px 12px 28px">

  <table role="presentation" class="card" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.card}" style="width:600px;max-width:600px;background:${C.card};border-radius:28px;border:1px solid #F1E4DA;box-shadow:0 24px 60px rgba(120,48,24,0.14),0 3px 8px rgba(120,48,24,0.06)">
    <tr><td class="px" style="padding:24px 36px 18px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td valign="middle">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
            <td width="38" height="38" align="center" bgcolor="${C.coral}" style="width:38px;height:38px;border-radius:12px;background-color:${C.coral};background-image:linear-gradient(145deg,#FF8A63,${C.coral} 55%,${C.coralDeep});box-shadow:0 6px 14px rgba(217,67,42,0.35),inset 0 1px 0 rgba(255,255,255,0.4);font-family:${DISPLAY};font-size:20px;font-weight:800;color:#FFFFFF;line-height:0"><img src="cid:mark@dubly" width="38" height="38" alt="Dubly" style="display:block;width:38px;height:38px;border:0;border-radius:12px"></td>
            <td style="padding-left:11px;font-family:${DISPLAY};font-size:21px;font-weight:800;color:${C.ink};letter-spacing:-0.3px">Dubly</td>
          </tr></table>
        </td>
        <td align="right" valign="middle" style="font-family:${FONT};font-size:12px;color:${C.faint}">AI dubbing studio</td>
      </tr></table>
    </td></tr>

    <tr><td class="hero" style="padding:0 14px">
      <img src="cid:hero-${e.hero}@dubly" width="572" alt="" style="display:block;width:100%;max-width:572px;height:auto;border:0;border-radius:20px;background:#F9D8C8">
    </td></tr>

    <tr><td class="px" style="padding:34px 40px 8px;font-family:${FONT}">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="background:${C.coralSoft};border:1px solid ${C.coralLine};border-radius:999px;padding:5px 12px;font-family:${DISPLAY};font-size:11px;font-weight:800;letter-spacing:1.2px;text-transform:uppercase;color:${C.coralDeep}">${escapeHtml(e.eyebrow)}</td></tr></table>
      <h1 class="title" style="margin:16px 0 6px;font-family:${DISPLAY};font-size:29px;line-height:37px;font-weight:800;color:${C.ink};letter-spacing:-0.6px">${escapeHtml(e.title)}</h1>
      ${e.paragraphs.map((p) => `<p style="margin:14px 0 0;font-size:16px;line-height:26px;color:${C.body}">${rich(p)}</p>`).join('\n      ')}
      ${e.meter ? meter(e.meter) : ''}
      ${e.steps ? steps(e.steps) : ''}
      ${e.details ? details(e.details) : ''}
      ${e.quote ? quote(e.quote) : ''}
      ${e.callout ? callout(e.callout) : ''}
      ${e.button ? button(e.button.label, e.button.url) : ''}
      ${e.button ? `<p style="margin:14px 0 0;font-size:12px;line-height:18px;color:${C.faint};word-break:break-all">Button not working? Copy this link into your browser:<br><a href="${escapeHtml(e.button.url)}" style="color:${C.muted}">${escapeHtml(e.button.url)}</a></p>` : ''}
    </td></tr>

    <tr><td class="px" style="padding:26px 40px 30px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-top:1px solid ${C.line};padding-top:20px;font-family:${FONT};font-size:13px;line-height:20px;color:${C.muted}">
        ${e.footnote ? rich(e.footnote) : 'You are getting this because you have a Dubly account.'}
      </td></tr></table>
    </td></tr>
  </table>

  <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px">
    <tr><td align="center" style="padding:22px 20px 0;font-family:${FONT};font-size:12px;color:${C.faint}">
      <img src="cid:logo@dubly" width="96" alt="ScatterPie" style="display:block;margin:0 auto 10px;width:96px;height:auto;border:0;opacity:0.85">
      Dubly by ScatterPie Analytics &middot; Videos in every language, in the speaker's own style.
    </td></tr>
  </table>

</td></tr></table>
</body></html>`;
}

export function renderText(e: EmailContent): string {
  const lines = [e.title, '', ...e.paragraphs.map(plain).flatMap((p) => [p, ''])];
  if (e.meter) lines.push(`${e.meter.caption}: ${e.meter.used} of ${e.meter.limit} min`, '');
  if (e.steps) e.steps.forEach((s, i) => lines.push(`${i + 1}. ${s.title}: ${plain(s.text)}`));
  if (e.steps) lines.push('');
  if (e.details) e.details.forEach(([k, v]) => lines.push(`${k}: ${v}`));
  if (e.details) lines.push('');
  if (e.quote) lines.push(e.quote, '');
  if (e.callout) lines.push(`${e.callout.title ? `${e.callout.title}: ` : ''}${plain(e.callout.text)}`, '');
  if (e.button) lines.push(`${e.button.label}: ${e.button.url}`, '');
  lines.push(plain(e.footnote ?? 'You are getting this because you have a Dubly account.'), '', 'Dubly by ScatterPie Analytics');
  return lines.join('\n');
}

/** The finished message: HTML, its plain-text twin and the pictures it shows. */
export function composeEmail(e: EmailContent): MailMessage {
  return { to: e.to, subject: e.subject.replace(/[\r\n]+/g, ' ').trim(), html: renderHtml(e), text: renderText(e), attachments: attachmentsFor(e.hero) };
}
