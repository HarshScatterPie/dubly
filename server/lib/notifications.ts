import { col } from './mongo';
import { isMailConfigured, sendMail, type MailMessage } from './mailer';
import { composeEmail } from './emailTemplates';
import { appUrl, buildConfirmedNoPasswordEmail, buildNewDeviceEmail, buildPasswordChangedEmail, buildWelcomeEmail, type RequestOrigin } from './authEmail';
import { getMinuteStatus, type MinuteStatus } from './projectRepo';
import { getWorkspaceName } from './workspaces';
import { log } from './log';

/**
 * Emails that follow from something happening, rather than from a request for them: welcome on the first sign-in, usage warnings
 * as the minutes run low, and a notice whenever a password changes. Each is sent in the background and never fails the request
 * that caused it; each "only once" is a conditional database write, so two requests at the same moment send one email.
 */
function inBackground(task: () => Promise<unknown>, event: string, context: Record<string, unknown> = {}): void {
  setImmediate(() => void task().catch((err) => log.error(event, err, context)));
}

// --- Welcome ------------------------------------------------------------------------------------------------------------

interface UserMarks {
  _id: string;
  email: string;
  emailVerified: boolean;
  displayName?: string;
  welcomedAt?: Date;
  importedFromFirebaseAt?: Date;
}

/** The welcome email, once per account, on its first sign-in with a confirmed email or a workspace to go to. */
export async function welcomeOnce(uid: string): Promise<boolean> {
  if (!isMailConfigured()) return false;
  const users = col<UserMarks>('users');
  const pointer = await col<{ _id: string; workspaceId: string | null }>('memberships').findOne({ _id: uid });
  const user = await users.findOne({ _id: uid }, { projection: { email: 1, emailVerified: 1, displayName: 1, welcomedAt: 1, importedFromFirebaseAt: 1 } });
  if (!user || user.welcomedAt) return false;
  // A sign-up that has not confirmed its email yet is welcomed once it has.
  if (!user.emailVerified && !pointer?.workspaceId) return false;
  const claimed = await users.updateOne({ _id: uid, welcomedAt: { $exists: false } }, { $set: { welcomedAt: new Date() } });
  if (!claimed.modifiedCount) return false;

  const workspaceId = pointer?.workspaceId;
  const [workspaceName, status] = workspaceId
    ? await Promise.all([getWorkspaceName(workspaceId), getMinuteStatus(workspaceId).catch(() => null)])
    : [undefined, null];
  return sendMail(
    buildWelcomeEmail(user.email, {
      name: user.displayName,
      workspaceName,
      planName: status?.planName,
      minutesLeft: status ? Math.max(0, Math.round((status.limit - status.used) * 10) / 10) : undefined,
      returning: Boolean(user.importedFromFirebaseAt),
    })
  );
}

export function scheduleWelcome(uid: string): void {
  inBackground(() => welcomeOnce(uid), 'welcome_email_failed', { userId: uid });
}

// --- New device ---------------------------------------------------------------------------------------------------------

export function notifyNewDevice(email: string, sign: RequestOrigin & { method: string }): void {
  if (!isMailConfigured()) return;
  inBackground(() => sendMail(buildNewDeviceEmail(email, sign)), 'new_device_notice_failed');
}

// --- Password changed -----------------------------------------------------------------------------------------------------

export function notifyPasswordChanged(email: string, how: 'reset' | 'change'): void {
  if (!isMailConfigured()) return;
  inBackground(() => sendMail(buildPasswordChangedEmail(email, how)), 'password_notice_failed');
}

// The first confirmation of the address left the account with no password.
export function notifyConfirmedWithoutPassword(email: string): void {
  if (!isMailConfigured()) return;
  inBackground(() => sendMail(buildConfirmedNoPasswordEmail(email)), 'confirmed_notice_failed');
}

// --- Usage ---------------------------------------------------------------------------------------------------------------

export type UsageLevel = 'low' | 'out';
// Share of the allowance at which the "running low" email goes out.
export const LOW_SHARE = 0.8;

export function usageLevel(status: Pick<MinuteStatus, 'used' | 'limit'>): UsageLevel | null {
  if (status.limit <= 0) return null;
  if (status.used >= status.limit - 0.05) return 'out';
  if (status.used >= status.limit * LOW_SHARE) return 'low';
  return null;
}

const resetDate = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', timeZone: 'Asia/Kolkata' });

export function buildUsageEmail(to: string, level: UsageLevel, workspaceName: string, status: MinuteStatus): MailMessage {
  const left = Math.max(0, Math.round((status.limit - status.used) * 10) / 10);
  const pct = Math.min(100, Math.round((status.used / status.limit) * 100));
  const resets = status.renewsMonthly && status.resetsAt ? `Your minutes refresh on **${resetDate(status.resetsAt)}**.` : 'Minutes on this plan do not refresh by themselves.';
  const rows: [string, string][] = [
    ['Workspace', workspaceName],
    ['Plan', status.planName],
    ['Minutes left', `${left} of ${status.limit} min`],
    ['Refreshes', status.renewsMonthly && status.resetsAt ? resetDate(status.resetsAt) : 'On request'],
  ];
  if (level === 'low') {
    return composeEmail({
      to,
      subject: `You've used ${pct}% of your Dubly minutes`,
      preheader: `${left} dubbing minutes left in ${workspaceName}.`,
      hero: 'dusk',
      eyebrow: 'Usage update',
      title: 'Your dubbing minutes are running low',
      paragraphs: [`**${workspaceName}** has used **${status.used} of ${status.limit} minutes**. ${resets}`],
      meter: { used: status.used, limit: status.limit, caption: 'Minutes used' },
      details: rows,
      callout: { tone: 'info', text: 'Need more before then? Press **Request quota increase** on the Usage page and we will sort it out.' },
      button: { label: 'See usage', url: appUrl() },
      footnote: 'Admins of the workspace get this once each time the minutes reach 80%.',
    });
  }
  return composeEmail({
    to,
    subject: "You've used all your Dubly minutes",
    preheader: `New dubs in ${workspaceName} are paused until more minutes are added.`,
    hero: 'dusk',
    eyebrow: 'Usage limit reached',
    title: "You're out of dubbing minutes",
    paragraphs: [`**${workspaceName}** has used all **${status.limit} minutes** of the ${status.planName} plan. New dubs, re-takes and voice clips wait until there are minutes again. ${resets}`],
    meter: { used: status.used, limit: status.limit, caption: 'Minutes used' },
    details: rows,
    callout: { tone: 'warning', title: 'Your work is safe', text: 'Projects, transcripts and finished dubs stay as they are; you can still open, edit, download and share them.' },
    button: { label: 'Request more minutes', url: appUrl() },
    footnote: 'Admins of the workspace get this once each time the minutes run out.',
  });
}

/** Sends the "running low" or "used up" email to the workspace's admins, at most once of each per usage period. */
export async function checkUsageAlerts(workspaceId: string): Promise<UsageLevel | null> {
  if (!isMailConfigured()) return null;
  const status = await getMinuteStatus(workspaceId);
  const level = usageLevel(status);
  if (!level) return null;
  const usage = col<{ _id: string; alerts?: Record<string, string> }>('usage');
  const claimed = await usage.updateOne({ _id: workspaceId, [`alerts.${level}`]: { $ne: status.period } }, { $set: { [`alerts.${level}`]: status.period } });
  if (!claimed.modifiedCount) return null;
  // Running out also covers running low: no "80%" email after the "used up" one in the same period.
  if (level === 'out') await usage.updateOne({ _id: workspaceId }, { $set: { 'alerts.low': status.period } });
  const [workspaceName, admins] = await Promise.all([
    getWorkspaceName(workspaceId),
    col<{ _id: string; email: string; workspaceId: string; role: string }>('members').find({ workspaceId, role: 'admin' }, { projection: { email: 1 } }).toArray(),
  ]);
  for (const admin of admins) await sendMail(buildUsageEmail(admin.email, level, workspaceName, status));
  log.info('usage_alert_sent', { workspaceId, level, admins: admins.length });
  return level;
}

export function scheduleUsageCheck(workspaceId: string): void {
  inBackground(() => checkUsageAlerts(workspaceId), 'usage_alert_failed', { workspaceId });
}
