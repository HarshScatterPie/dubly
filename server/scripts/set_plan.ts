// Operator tool: shows or sets a workspace's plan, by workspace id or a member's email (`npx tsx server/scripts/set_plan.ts owner@acme.com enterprise`).
import '../lib/env';
import { authAdmin, db } from '../lib/firebaseAdmin';
import { getPlan, isPlanId, setWorkspacePlan, workspacePlanId } from '../lib/plans';

// An email resolves to the workspace that person is in right now (their team, or their own).
async function resolveWorkspace(target: string): Promise<string> {
  if (!target.includes('@')) return target;
  const user = await authAdmin.getUserByEmail(target.trim().toLowerCase());
  const workspaceId = (await db.collection('workspaceMembership').doc(user.uid).get()).get('workspaceId');
  if (typeof workspaceId !== 'string' || !workspaceId) throw new Error(`${target} is not in a workspace yet (they have not signed in to Dubly).`);
  return workspaceId;
}

export async function setPlanCommand(target: string, planArg?: string): Promise<string> {
  const workspaceId = await resolveWorkspace(target);
  const workspace = await db.collection('workspaces').doc(workspaceId).get();
  if (!workspace.exists) throw new Error(`No workspace ${workspaceId}`);
  const label = `${workspace.get('name') || 'Unnamed'} (${workspaceId})`;
  if (!planArg) {
    const plan = await getPlan(await workspacePlanId(workspaceId));
    return `${label} is on ${plan.name}: ${plan.minutesPerMonth} min/month, paid extras ${plan.paidExtras ? 'on' : 'off'}, teammates ${plan.teamInvites ? 'allowed' : 'not allowed'}.`;
  }
  if (!isPlanId(planArg)) throw new Error(`Unknown plan "${planArg}". Use starter or enterprise.`);
  await setWorkspacePlan(workspaceId, planArg);
  const plan = await getPlan(planArg);
  return `${label} moved to ${plan.name}: ${plan.minutesPerMonth} min/month. The server picks it up within a minute.`;
}

if (process.argv[1]?.endsWith('set_plan.ts')) {
  const [target, plan] = process.argv.slice(2);
  if (!target) {
    console.log('Usage: npx tsx server/scripts/set_plan.ts <workspace id | member email> [starter | enterprise]');
    process.exit(1);
  }
  setPlanCommand(target, plan).then(
    (message) => {
      console.log(message);
      process.exit(0);
    },
    (err) => {
      console.error((err as Error).message);
      process.exit(1);
    }
  );
}
