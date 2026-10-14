import { randomUUID } from 'node:crypto';
import { db } from './firebaseAdmin';
import { env } from './env';
import { escapeHtml, sendMail, type MailMessage } from './mailer';
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

// Prefixed like dublyPlans: the Firestore project is shared with ScatterStudio. Closed to clients like every Dubly path.
const requestsCol = () => db.collection('dublyQuotaRequests');

const PLAN_LABELS: Record<QuotaRequestInput['plan'], string> = { starter: 'Starter', enterprise: 'Enterprise', custom: 'Custom' };

// Text from the form never reaches a header with its line breaks.
const oneLine = (text: string) => text.replace(/[\r\n]+/g, ' ').trim();

export function buildQuotaRequestEmail(request: StoredQuotaRequest, to: string): MailMessage {
  const e = escapeHtml;
  const wanted = `${PLAN_LABELS[request.plan]}, ${request.minutesPerMonth} min/month`;
  const rows: [string, string][] = [
    ['Name', request.name],
    ['Email', request.email],
    ['Company', request.company || '—'],
    ['Phone', request.phone || '—'],
    ['Workspace', `${request.workspaceName} (${request.workspaceId})`],
    ['Current plan', `${request.currentPlan}: ${request.minutesUsed} of ${request.minutesLimit} min used`],
    ['Asking for', wanted],
  ];
  const text = [
    `${request.name} asked for more Dubly dubbing minutes.`,
    '',
    ...rows.map(([label, value]) => `${label}: ${value}`),
    '',
    'Message:',
    request.message,
    '',
    `Request id: ${request.id}. Change the plan with: npx tsx server/scripts/set_plan.ts ${request.email} <free|starter|enterprise>`,
  ].join('\n');
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;color:#0F172A">
  <h2 style="font-size:18px;margin:0 0 12px">Dubly quota increase request</h2>
  <table style="font-size:14px;border-collapse:collapse">${rows
    .map(([label, value]) => `<tr><td style="padding:4px 12px 4px 0;color:#64748B">${e(label)}</td><td style="padding:4px 0">${e(value)}</td></tr>`)
    .join('')}</table>
  <p style="font-size:14px;line-height:1.5;white-space:pre-wrap;border-left:3px solid #F05637;padding-left:10px">${e(request.message)}</p>
  <p style="font-size:12px;color:#94A3B8">Request id ${e(request.id)}. Change the plan with <code>npx tsx server/scripts/set_plan.ts ${e(request.email)} &lt;free|starter|enterprise&gt;</code></p>
</div>`;
  return { to, subject: oneLine(`Dubly quota request: ${request.name} (${request.currentPlan} → ${wanted})`), text, html };
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
  await requestsCol().doc(request.id).set(request);
  const to = env.quotaRequestTo || env.smtpUser;
  const emailed = to ? await sendMail(buildQuotaRequestEmail(request, to)) : false;
  return { id: request.id, emailed };
}
