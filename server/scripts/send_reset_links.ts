// Operator tool: emails "choose your new password" links to accounts, e.g. everyone brought over from the old Firebase sign-in.
//   npx tsx server/scripts/send_reset_links.ts                     dry run: lists who would get a link, sends nothing
//   npx tsx server/scripts/send_reset_links.ts --send              sends to every account that is not disabled
//   npx tsx server/scripts/send_reset_links.ts --send --only a@x.com,b@y.com
// Links point at WEB_ORIGIN and work once, for 72 hours (--hours N). Sending is refused while WEB_ORIGIN is a localhost address,
// because nobody else could open such a link. Each new link replaces that account's earlier one.
import '../lib/env';
import { env } from '../lib/env';
import { closeMongo, col, connectMongo } from '../lib/mongo';
import { issueAuthToken, normalizeEmail } from '../lib/accounts';
import { authLink, buildMovedAccountEmail } from '../lib/authEmail';
import { isMailConfigured, sendMail } from '../lib/mailer';

const args = process.argv.slice(2);
const send = args.includes('--send');
const onlyAt = args.indexOf('--only');
const only = onlyAt >= 0 ? new Set(String(args[onlyAt + 1] ?? '').split(',').map(normalizeEmail).filter(Boolean)) : null;
const hoursAt = args.indexOf('--hours');
const hours = hoursAt >= 0 ? Number(args[hoursAt + 1]) : 72;

async function main(): Promise<void> {
  if (!Number.isFinite(hours) || hours < 1 || hours > 24 * 7) throw new Error('--hours must be between 1 and 168');
  const origin = new URL(env.webOrigin);
  const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(origin.hostname);
  await connectMongo();
  const accounts = await col<{ _id: string; email: string; disabled: boolean }>('users')
    .find({ disabled: { $ne: true } }, { projection: { email: 1, disabled: 1 } })
    .sort({ email: 1 })
    .toArray();
  const targets = accounts.filter((a) => !only || only.has(a.email));
  if (only) for (const email of only) if (!targets.some((t) => t.email === email)) console.warn(`no active account for ${email}; skipped`);

  console.log(`${targets.length} account(s); links open ${env.webOrigin} and work for ${hours} h:`);
  for (const t of targets) console.log(`  ${t.email}`);
  if (!send) {
    console.log('Dry run: nothing sent. Add --send to email them.');
    return;
  }
  if (local) throw new Error(`WEB_ORIGIN is ${env.webOrigin}; nobody else can open that. Set WEB_ORIGIN to the address people use, then send.`);
  if (!isMailConfigured()) throw new Error('SMTP is not configured (SMTP_HOST and MAIL_FROM); nothing sent.');

  let sent = 0;
  for (const t of targets) {
    const link = authLink('reset', await issueAuthToken(t._id, t.email, 'reset-password', hours * 3600_000));
    if (await sendMail(buildMovedAccountEmail(t.email, link, hours))) sent++;
    else console.error(`  sending to ${t.email} failed (see the log); run again with --only ${t.email}`);
  }
  console.log(`sent ${sent} of ${targets.length}`);
}

main().then(
  async () => {
    await closeMongo();
    process.exit(0);
  },
  async (err) => {
    console.error((err as Error).message);
    await closeMongo().catch(() => undefined);
    process.exit(1);
  }
);
