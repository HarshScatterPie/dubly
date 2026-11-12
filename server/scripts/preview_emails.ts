// Renders every email Dubly sends, with sample data, into a folder you can open in a browser (index.html shows them side by side).
// Nothing is sent and no database is touched.   npx tsx server/scripts/preview_emails.ts [out-folder]
process.env.WEB_ORIGIN = process.env.PREVIEW_ORIGIN || 'https://dubly.example.com';
const { mkdirSync, writeFileSync } = await import('node:fs');
const path = await import('node:path');
const os = await import('node:os');
const {
  buildConfirmedNoPasswordEmail,
  buildMagicLinkEmail,
  buildMovedAccountEmail,
  buildNewDeviceEmail,
  buildPasswordChangedEmail,
  buildResetEmail,
  buildVerifyEmail,
  buildWelcomeEmail,
} = await import('../lib/authEmail');
const { buildInviteEmail } = await import('../lib/inviteEmail');
const { buildQuotaReceiptEmail, buildQuotaRequestEmail } = await import('../lib/quotaRequests');
const { buildUsageEmail } = await import('../lib/notifications');
type MailMessage = import('../lib/mailer').MailMessage;

const out = path.resolve(process.argv[2] || path.join(os.homedir(), 'dubly-email-preview'));
mkdirSync(out, { recursive: true });
const origin = process.env.WEB_ORIGIN;
const to = 'aarav.sharma@example.com';
const nextMonth = new Date(Date.UTC(2026, 11, 1) - 5.5 * 3600_000).toISOString();
const request = {
  id: 'qr-7c1e2f',
  workspaceId: 'ws-7ee963cf',
  workspaceName: 'ScatterPie Developers',
  uid: 'u-1',
  email: to,
  name: 'Aarav Sharma',
  company: 'ScatterPie Analytics',
  phone: '+91 98765 43210',
  plan: 'enterprise' as const,
  minutesPerMonth: 300,
  message: 'We are dubbing our training series into Hindi, Tamil and Bengali this quarter and expect about 250 minutes a month.',
  currentPlan: 'Starter',
  minutesUsed: 46,
  minutesLimit: 50,
  status: 'open' as const,
  createdAt: new Date().toISOString(),
};

const emails: [string, MailMessage][] = [
  ['Dubly has moved (to everyone)', buildMovedAccountEmail(to, `${origin}/?reset=SAMPLE-TOKEN`, 72)],
  ['Welcome (first sign-in)', buildWelcomeEmail(to, { name: 'Aarav Sharma', workspaceName: 'ScatterPie Developers', planName: 'Enterprise', minutesLeft: 96.4 })],
  ['Welcome back (moved accounts)', buildWelcomeEmail(to, { name: 'Aarav Sharma', workspaceName: 'ScatterPie Developers', planName: 'Enterprise', minutesLeft: 96.4, returning: true })],
  ['Confirm email (sign-up)', buildVerifyEmail(to, `${origin}/?verify=SAMPLE-TOKEN`)],
  ['Sign-in link (no password)', buildMagicLinkEmail(to, `${origin}/?magic=SAMPLE-TOKEN`, { device: 'Chrome on Windows', location: 'Mumbai, Maharashtra, India', ip: '49.36.112.18', at: new Date() }, 15)],
  ['New device sign-in (security)', buildNewDeviceEmail(to, { device: 'Safari on iPhone', location: 'Pune, Maharashtra, India', ip: '103.21.58.7', at: new Date(), method: 'Code from a sign-in email' })],
  ['Password reset', buildResetEmail(to, `${origin}/?reset=SAMPLE-TOKEN`)],
  ['Password changed (security)', buildPasswordChangedEmail(to, 'reset')],
  ['Email confirmed, no password (security)', buildConfirmedNoPasswordEmail(to)],
  ['Usage 80% (admins)', buildUsageEmail(to, 'low', 'ScatterPie Developers', { used: 41.5, limit: 50, period: '2026-11', renewsMonthly: true, planName: 'Starter', resetsAt: nextMonth })],
  ['Usage 100% (admins)', buildUsageEmail(to, 'out', 'Aarav’s workspace', { used: 5, limit: 5, period: 'lifetime', renewsMonthly: false, planName: 'Free' })],
  ['Invitation', buildInviteEmail({ id: 'i', email: to, role: 'editor', invitedByName: 'Shaurya Sharma', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString() }, 'ScatterPie Developers', `${origin}/?invite=SAMPLE`)],
  ['Quota request (to ScatterPie)', buildQuotaRequestEmail(request, 'sales@scatterpie.io')],
  ['Quota request receipt (to requester)', buildQuotaReceiptEmail(request)],
];

// The pictures travel inside each email as cid: attachments; for a browser they are written next to the pages.
const cards: string[] = [];
emails.forEach(([label, message], i) => {
  let html = message.html;
  for (const a of message.attachments ?? []) {
    writeFileSync(path.join(out, a.filename), a.content);
    html = html.split(`cid:${a.cid}`).join(a.filename);
  }
  const file = `${String(i + 1).padStart(2, '0')}-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-$/, '')}.html`;
  writeFileSync(path.join(out, file), html);
  writeFileSync(path.join(out, file.replace(/\.html$/, '.txt')), `Subject: ${message.subject}\n\n${message.text}`);
  cards.push(`<section><header><span>${i + 1}</span><div><b>${label}</b><small>Subject: ${message.subject.replace(/</g, '&lt;')}</small></div><a href="${file}" target="_blank">Open full size</a></header><iframe src="${file}" loading="lazy"></iframe></section>`);
});

writeFileSync(
  path.join(out, 'index.html'),
  `<!doctype html><meta charset="utf-8"><title>Dubly emails: preview</title>
<style>body{margin:0;background:#1A1526;font-family:Segoe UI,system-ui,sans-serif;color:#F8EDE7}h1{font-weight:800;margin:32px 40px 4px}p{margin:0 40px 24px;color:#C9B8C8}
main{display:grid;grid-template-columns:repeat(auto-fill,minmax(680px,1fr));gap:28px;padding:0 40px 60px}section{background:#241D33;border-radius:18px;overflow:hidden;box-shadow:0 10px 30px rgba(0,0,0,.35)}
header{display:flex;gap:14px;align-items:center;padding:14px 18px}header span{background:#F05637;color:#fff;border-radius:10px;width:30px;height:30px;display:grid;place-items:center;font-weight:800}
header div{flex:1;display:flex;flex-direction:column}header small{color:#B9A9BC}header a{color:#FFB59E;font-size:13px}iframe{width:100%;height:1500px;border:0;background:#F6EEE7}</style>
<h1>Dubly emails</h1><p>${emails.length} emails with sample data. Pictures are embedded in the real emails; here they are files next to this page. Nothing was sent.</p><main>${cards.join('')}</main>`
);
console.log(path.join(out, 'index.html'));
