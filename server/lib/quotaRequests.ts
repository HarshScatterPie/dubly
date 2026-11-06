import { randomUUID } from 'node:crypto';
import { col } from './mongo';
import { env } from './env';
import { isMailConfigured, sendMail, type MailMessage } from './mailer';
import { composeEmail } from './emailTemplates';
import type { UserUsageStats } from '../../src/types';

// A workspace asking ScatterPie for more dubbing minutes (Usage page). Plans are changed by an operator (server/scripts/set_plan.ts), never here.
export interface QuotaRequestInput {
  name: string;
  company?: string;
  phone?: string;
  plan: 'starter' | 'enterprise' | 'custom';
  minutesPerMonth: number;
  message: string;
}

export interface StoredQuotaRequest extends QuotaRequestInput {
  id: string;
  workspaceId: string;
  workspaceName: string;
  uid: string;
  email: string;
  currentPlan: string;
  minutesUsed: number;
  minutesLimit: number;
  status: 'open';
  createdAt: string;
}

// Read by operators only (Compass or a script); no route returns them.
const requestsCol = () => col<StoredQuotaRequest & { _id: string }>('quotaRequests');

const PLAN_LABELS: Record<QuotaRequestInput['plan'], string> = { starter: 'Starter', enterprise: 'Enterprise', custom: 'Custom' };

// Text from the form never reaches a header with its line breaks.
const oneLine = (text: string) => text.replace(/[\r\n]+/g, ' ').trim();

export function buildQuotaRequestEmail(request: StoredQuotaRequest, to: string): MailMessage {
  const wanted = `${PLAN_LABELS[request.plan]}, ${request.minutesPerMonth} min/month`;
  return composeEmail({
    to,
    subject: oneLine(`Dubly quota request: ${request.name} (${request.currentPlan} → ${wanted})`),
    preheader: `${request.name} from ${request.workspaceName} asked for more dubbing minutes.`,
    hero: 'dusk',
    eyebrow: 'Quota request',
    title: 'A workspace wants more minutes',
    paragraphs: [`${request.name} asked for more Dubly dubbing minutes. Their message is below; reply to them at ${request.email}.`],
    details: [
      ['Name', request.name],
      ['Email', request.email],
      ['Company', request.company || '—'],
      ['Phone', request.phone || '—'],
      ['Workspace', `${request.workspaceName} (${request.workspaceId})`],
      ['Current plan', `${request.currentPlan}: ${request.minutesUsed} of ${request.minutesLimit} min used`],
      ['Asking for', wanted],
    ],
    quote: request.message,
    footnote: `Request id ${request.id}. Change the plan with: npx tsx server/scripts/set_plan.ts ${request.email} <free|starter|enterprise>`,
  });
}

// The copy the person who asked gets, so they know it arrived.
export function buildQuotaReceiptEmail(request: StoredQuotaRequest): MailMessage {
  return composeEmail({
    to: request.email,
    subject: 'We got your request for more Dubly minutes',
    preheader: 'Our team will get back to you soon.',
    hero: 'dusk',
    eyebrow: 'Request received',
    title: 'Thanks, we have your request',
    paragraphs: [
      `Hi ${request.name.split(/s+/)[0]}, your request for more dubbing minutes for **${request.workspaceName}** reached the ScatterPie team. Someone will get back to you, usually within one working day.`,
    ],
    details: [
      ['You asked for', `${PLAN_LABELS[request.plan]}, ${request.minutesPerMonth} min/month`],
      ['Plan today', `${request.currentPlan}: ${request.minutesUsed} of ${request.minutesLimit} min used`],
      ['Reference', request.id],
    ],
    callout: { tone: 'success', text: 'Nothing changes on your workspace until the new plan is set up; you can keep using the minutes you have.' },
    footnote: 'Want to add something? Reply to this email.',
  });
}

// Saved first, so a request is never lost to a mail failure; the email is a notification of what is already on record.
export async function submitQuotaRequest(
  input: QuotaRequestInput,
  who: { workspaceId: string; workspaceName: string; uid: string; email: string },
  usage: Pick<UserUsageStats, 'activePlan' | 'minutesDubbed' | 'minutesLimit'>
): Promise<{ id: string; emailed: boolean }> {
  const request: StoredQuotaRequest = {
    ...input,
    id: `qr-${randomUUID()}`,
    workspaceId: who.workspaceId,
    workspaceName: who.workspaceName,
    uid: who.uid,
    email: who.email,
    currentPlan: usage.activePlan,
    minutesUsed: usage.minutesDubbed,
    minutesLimit: usage.minutesLimit,
    status: 'open',
    createdAt: new Date().toISOString(),
  };
  await requestsCol().insertOne({ _id: request.id, ...request });
  const to = env.quotaRequestTo || env.smtpUser;
  const emailed = to ? await sendMail(buildQuotaRequestEmail(request, to)) : false;
  // A receipt for the person who asked; it never decides whether the request counts as sent.
  if (request.email && isMailConfigured()) await sendMail(buildQuotaReceiptEmail(request));
  return { id: request.id, emailed };
}
