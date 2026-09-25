import type { PaidExtra, Plan, PlanId } from '../../src/types';
import { PAID_EXTRAS } from '../../src/lib/planMath';
import { db } from './firebaseAdmin';

// Written to Firestore the first time each plan is read, then owned there: edit dublyPlans/{id} to change a limit, a rate or invites.
export const DEFAULT_PLANS: Record<PlanId, Plan> = {
  starter: {
    id: 'starter',
    name: 'Starter',
    minutesPerMonth: 50,
    paidExtras: false,
    extraRates: { aiReview: 0, premiumVoices: 0, paceRetakes: 0 },
    teamInvites: false,
  },
  enterprise: {
    id: 'enterprise',
    name: 'Enterprise',
    minutesPerMonth: 120,
    paidExtras: true,
    extraRates: { aiReview: 0.25, premiumVoices: 0.5, paceRetakes: 0.25 },
    teamInvites: true,
  },
};

// A workspace with no plan recorded is on Starter.
export const DEFAULT_PLAN_ID: PlanId = 'starter';

const PLAN_IDS = Object.keys(DEFAULT_PLANS) as PlanId[];
// Prefixed because this Firestore project is shared with ScatterStudio, which may have its own `plans`.
const plansCol = () => db.collection('dublyPlans');
const workspaceDoc = (id: string) => db.collection('workspaces').doc(id);

// Plans change by hand and rarely; a minute of staleness saves a read on every usage check.
const CACHE_MS = 60_000;
const planCache = new Map<PlanId, { plan: Plan; at: number }>();
const workspacePlanCache = new Map<string, { id: PlanId; at: number }>();

export function isPlanId(value: unknown): value is PlanId {
  return typeof value === 'string' && (PLAN_IDS as string[]).includes(value);
}

// A stored plan read defensively: a missing or mistyped field keeps the built-in value instead of becoming zero minutes.
export function toPlan(id: PlanId, data: Record<string, unknown> | undefined): Plan {
  const base = DEFAULT_PLANS[id];
  const minutes = Number(data?.minutesPerMonth);
  const rates = (data?.extraRates ?? {}) as Record<string, unknown>;
  return {
    id,
    name: typeof data?.name === 'string' && data.name.trim() ? data.name.trim() : base.name,
    minutesPerMonth: Number.isFinite(minutes) && minutes >= 0 ? minutes : base.minutesPerMonth,
    paidExtras: typeof data?.paidExtras === 'boolean' ? data.paidExtras : base.paidExtras,
    extraRates: Object.fromEntries(
      PAID_EXTRAS.map((key) => {
        const rate = Number(rates[key]);
        return [key, Number.isFinite(rate) && rate >= 0 ? rate : base.extraRates[key]];
      })
    ) as Record<PaidExtra, number>,
    teamInvites: typeof data?.teamInvites === 'boolean' ? data.teamInvites : base.teamInvites,
  };
}

export async function getPlan(id: PlanId): Promise<Plan> {
  const hit = planCache.get(id);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.plan;
  const ref = plansCol().doc(id);
  const snap = await ref.get();
  // create() never overwrites, so a copy an operator (or another request) wrote first always stands.
  if (!snap.exists) await ref.create(DEFAULT_PLANS[id]).catch(() => undefined);
  const plan = toPlan(id, snap.exists ? snap.data() : undefined);
  planCache.set(id, { plan, at: Date.now() });
  return plan;
}

export async function workspacePlanId(workspaceId: string): Promise<PlanId> {
  const hit = workspacePlanCache.get(workspaceId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.id;
  const stored = (await workspaceDoc(workspaceId).get()).get('plan');
  const id = isPlanId(stored) ? stored : DEFAULT_PLAN_ID;
  workspacePlanCache.set(workspaceId, { id, at: Date.now() });
  return id;
}

export async function planForWorkspace(workspaceId: string): Promise<Plan> {
  return getPlan(await workspacePlanId(workspaceId));
}

// Moves a workspace onto a plan; run by operators through server/scripts/set_plan.ts, never exposed to customers.
export async function setWorkspacePlan(workspaceId: string, id: PlanId): Promise<void> {
  const ref = workspaceDoc(workspaceId);
  if (!(await ref.get()).exists) throw new Error(`No workspace ${workspaceId}`);
  await ref.set({ plan: id, planUpdatedAt: new Date().toISOString() }, { merge: true });
  workspacePlanCache.delete(workspaceId);
}

// Test seam: forgets cached plans so a test sees the documents it just wrote.
export function clearPlanCaches(): void {
  planCache.clear();
  workspacePlanCache.clear();
}
