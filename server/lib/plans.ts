import type { PaidExtra, Plan, PlanId, VoiceEngine } from '../../src/types';
import { PAID_EXTRAS } from '../../src/lib/planMath';
import { CLOUD_ENGINES, GEMINI_API_ENGINES, isVoiceEngine } from '../../src/lib/voiceEngines';
import { col } from './mongo';
import { env } from './env';

// Written to the `plans` collection the first time each plan is read, then owned there: edit plans/{id} to change a limit, a rate, invites or voice engines.
export const DEFAULT_PLANS: Record<PlanId, Plan> = {
  // Where every new workspace starts: a few minutes to try Dubly, once. More comes through a quota request (Usage page).
  free: {
    id: 'free',
    name: 'Free',
    minutesPerMonth: 5,
    renewsMonthly: false,
    paidExtras: false,
    extraRates: { aiReview: 0, premiumVoices: 0, paceRetakes: 0 },
    teamInvites: false,
    voiceEngines: ['gemini-flash-lite'],
    visibleWatermark: true,
  },
  starter: {
    id: 'starter',
    name: 'Starter',
    minutesPerMonth: 50,
    renewsMonthly: true,
    paidExtras: false,
    extraRates: { aiReview: 0, premiumVoices: 0, paceRetakes: 0 },
    teamInvites: false,
    // Gemini 3.8 Flash and Chirp 3 HD voices are shown to Starter workspaces, locked.
    voiceEngines: ['gemini-flash-lite'],
    visibleWatermark: true,
  },
  enterprise: {
    id: 'enterprise',
    name: 'Enterprise',
    minutesPerMonth: 120,
    renewsMonthly: true,
    paidExtras: true,
    extraRates: { aiReview: 0.25, premiumVoices: 0.5, paceRetakes: 0.25 },
    teamInvites: true,
    voiceEngines: [...GEMINI_API_ENGINES],
    // Enterprise dubs carry the AI metadata only. docs/AI-LABELLING.md says why that needs a legal check before relying on it.
    visibleWatermark: false,
  },
};

// A workspace with no plan recorded (every one made before Free existed) is on Starter.
export const DEFAULT_PLAN_ID: PlanId = 'starter';

// The plan a newly created workspace is put on (NEW_WORKSPACE_PLAN, Free unless set).
export function newWorkspacePlanId(): PlanId {
  return isPlanId(env.newWorkspacePlan) ? env.newWorkspacePlan : 'free';
}

const PLAN_IDS = Object.keys(DEFAULT_PLANS) as PlanId[];
const plansCol = () => col<Plan & { _id: string }>('plans');
const workspacesCol = () => col<{ _id: string; plan?: string; planUpdatedAt?: string }>('workspaces');

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
  const engines = Array.isArray(data?.voiceEngines) ? [...new Set(data.voiceEngines.filter(isVoiceEngine))] : [];
  return {
    id,
    name: typeof data?.name === 'string' && data.name.trim() ? data.name.trim() : base.name,
    minutesPerMonth: Number.isFinite(minutes) && minutes >= 0 ? minutes : base.minutesPerMonth,
    renewsMonthly: typeof data?.renewsMonthly === 'boolean' ? data.renewsMonthly : base.renewsMonthly,
    paidExtras: typeof data?.paidExtras === 'boolean' ? data.paidExtras : base.paidExtras,
    extraRates: Object.fromEntries(
      PAID_EXTRAS.map((key) => {
        const rate = Number(rates[key]);
        return [key, Number.isFinite(rate) && rate >= 0 ? rate : base.extraRates[key]];
      })
    ) as Record<PaidExtra, number>,
    teamInvites: typeof data?.teamInvites === 'boolean' ? data.teamInvites : base.teamInvites,
    // A plan left with no usable engine could not voice anything, so an empty or unreadable list keeps the built-in one.
    voiceEngines: engines.length ? engines : base.voiceEngines,
    visibleWatermark: typeof data?.visibleWatermark === 'boolean' ? data.visibleWatermark : base.visibleWatermark,
  };
}

// The engines this server voices with, whatever a plan lists: TTS_ENGINE picks Google Cloud's (the default), Chirp 3 HD alone, or Gemini 3.8.
export function offeredVoiceEngines(): VoiceEngine[] {
  if (env.ttsEngine === 'chirp') return ['chirp'];
  return [...(env.ttsEngine === 'gemini' ? GEMINI_API_ENGINES : CLOUD_ENGINES)];
}

// A plan engine this server does not offer becomes the closest one it does: a Gemini engine stays Gemini where there is one, anything else becomes Chirp 3 HD.
function offeredEngineFor(engine: VoiceEngine, offered: VoiceEngine[]): VoiceEngine {
  if (offered.includes(engine)) return engine;
  const gemini = engine !== 'chirp' ? offered.find((e) => e !== 'chirp') : undefined;
  return gemini ?? (offered.includes('chirp') ? 'chirp' : offered[0]);
}

// The plan as it applies on this server, e.g. Enterprise's Gemini 3.8 voices becoming Gemini 2.5 Flash while only Cloud TTS is offered.
export function withOfferedEngines(plan: Plan): Plan {
  const offered = offeredVoiceEngines();
  return { ...plan, voiceEngines: [...new Set(plan.voiceEngines.map((engine) => offeredEngineFor(engine, offered)))] };
}

export async function getPlan(id: PlanId): Promise<Plan> {
  const hit = planCache.get(id);
  if (hit && Date.now() - hit.at < CACHE_MS) return withOfferedEngines(hit.plan);
  // $setOnInsert never overwrites, so a copy an operator (or another request) wrote first always stands.
  const stored = await plansCol().findOneAndUpdate(
    { _id: id },
    { $setOnInsert: { ...DEFAULT_PLANS[id] } },
    { upsert: true, returnDocument: 'after', projection: { _id: 0 } }
  );
  const plan = toPlan(id, (stored ?? undefined) as Record<string, unknown> | undefined);
  planCache.set(id, { plan, at: Date.now() });
  return withOfferedEngines(plan);
}

export async function workspacePlanId(workspaceId: string): Promise<PlanId> {
  const hit = workspacePlanCache.get(workspaceId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.id;
  const stored = (await workspacesCol().findOne({ _id: workspaceId }, { projection: { plan: 1 } }))?.plan;
  const id = isPlanId(stored) ? stored : DEFAULT_PLAN_ID;
  workspacePlanCache.set(workspaceId, { id, at: Date.now() });
  return id;
}

export async function planForWorkspace(workspaceId: string): Promise<Plan> {
  return getPlan(await workspacePlanId(workspaceId));
}

// Moves a workspace onto a plan; run by operators through server/scripts/set_plan.ts, never exposed to customers.
export async function setWorkspacePlan(workspaceId: string, id: PlanId): Promise<void> {
  const result = await workspacesCol().updateOne({ _id: workspaceId }, { $set: { plan: id, planUpdatedAt: new Date().toISOString() } });
  if (!result.matchedCount) throw new Error(`No workspace ${workspaceId}`);
  workspacePlanCache.delete(workspaceId);
}

// Test seam: forgets cached plans so a test sees the documents it just wrote.
export function clearPlanCaches(): void {
  planCache.clear();
  workspacePlanCache.clear();
}
