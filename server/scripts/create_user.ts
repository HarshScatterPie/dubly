// Operator tool: creates a Dubly account with a confirmed email and prints a one-time link to choose its password (valid 30 minutes).
// Useful for the very first account, or when sign-up is closed (ALLOW_SIGNUP=false):
//   npx tsx server/scripts/create_user.ts person@example.com "Their Name"
// No password is ever typed on the command line or stored in shell history; the person sets it through the link.
import { randomBytes } from 'node:crypto';
import '../lib/env';
import { closeMongo, connectMongo } from '../lib/mongo';
import { createUser, getUserByEmail, issueAuthToken } from '../lib/accounts';
import { authLink } from '../lib/authEmail';

async function main(email: string, name?: string): Promise<string> {
  await connectMongo();
  let user = await getUserByEmail(email);
  let created = false;
  if (!user) {
    // A random placeholder nobody knows; the link below replaces it.
    await createUser({ email, password: randomBytes(24).toString('base64url'), displayName: name, emailVerified: true });
    user = (await getUserByEmail(email))!;
    created = true;
  }
  const link = authLink('reset', await issueAuthToken(user._id, user.email, 'reset-password'));
  return `${created ? 'Created' : 'Found'} ${user.email} (${user._id}). Open this link within 30 minutes to set the password:\n${link}`;
}

const [email, name] = process.argv.slice(2);
if (!email) {
  console.log('Usage: npx tsx server/scripts/create_user.ts <email> ["Display name"]');
  process.exit(1);
}
main(email, name).then(
  async (message) => {
    console.log(message);
    await closeMongo();
    process.exit(0);
  },
  async (err) => {
    console.error((err as Error).message);
    await closeMongo().catch(() => undefined);
    process.exit(1);
  }
);
