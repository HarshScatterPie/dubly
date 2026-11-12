/**
 * Passwords anyone would try first. Sign-in is rate limited, so the danger is the handful of passwords guessers start with, not a
 * slow search: these are the long end of the published most-common-password lists, common Indian choices, keyboard runs, and Dubly's
 * own names. Only 8+ characters matter (anything shorter is refused already). A password also counts as one of these when, with the
 * digits and symbols around it taken off and look-alike characters read as letters, what remains is on the list: "Password123!",
 * "P@ssw0rd" and "dubly2026" are all "password" or "dubly".
 */
const COMMON = new Set(
  [
    // Words and names at the top of the leaked-password lists.
    'password', 'passwort', 'pass', 'qwerty', 'qwertz', 'azerty', 'qwertyuiop', 'asdfgh', 'asdfghjkl', 'zxcvbnm', 'qwe', 'qwer', 'asdf',
    'abc', 'abcd', 'abcde', 'abcdef', 'iloveyou', 'loveyou', 'lovelove', 'love', 'welcome', 'letmein', 'admin', 'administrator', 'root',
    'login', 'changeme', 'default', 'secret', 'test', 'testing', 'tester', 'guest', 'user', 'hello', 'helloworld', 'monkey', 'dragon',
    'master', 'shadow', 'killer', 'trustno', 'whatever', 'football', 'baseball', 'soccer', 'hockey', 'sunshine', 'princess', 'superman',
    'batman', 'starwars', 'pokemon', 'naruto', 'computer', 'internet', 'freedom', 'forever', 'family', 'friends', 'happy', 'lucky',
    'angel', 'babygirl', 'butterfly', 'chocolate', 'sweetheart', 'beautiful', 'michael', 'jennifer', 'michelle', 'jordan', 'charlie',
    'thomas', 'robert', 'daniel', 'andrew', 'joshua', 'george', 'hunter', 'ranger', 'harley', 'mercedes', 'corvette', 'liverpool',
    'chelsea', 'arsenal', 'manchester', 'summer', 'winter', 'spring', 'autumn', 'monday', 'sunday', 'january', 'december', 'money',
    'jesus', 'god', 'allah', 'anything', 'nothing', 'something', 'google', 'facebook', 'instagram', 'youtube', 'gmail', 'yahoo',
    'hotmail', 'outlook', 'microsoft', 'windows', 'samsung', 'nokia', 'iphone', 'apple',
    // Common in India.
    'india', 'iloveindia', 'bharat', 'hindustan', 'cricket', 'sachin', 'dhoni', 'virat', 'krishna', 'harekrishna', 'radhekrishna',
    'ganesh', 'ganesha', 'hanuman', 'saibaba', 'omsairam', 'jaishriram', 'jaishreeram', 'jaimatadi', 'omnamahshivaya', 'mumbai', 'delhi',
    'bangalore', 'bengaluru', 'kolkata', 'chennai', 'hyderabad', 'pune',
    // Dubly's own names, which a guesser tries on Dubly first.
    'dubly', 'dublyai', 'scatterpie', 'scatter',
    // Patterns with digits inside, which taking off the ends does not reduce.
    '1q2w3e4r', '1q2w3e4r5t', '1q2w3e4r5t6y', 'q1w2e3r4', 'q1w2e3r4t5', '1qaz2wsx', '1qaz2wsx3edc', 'zaq12wsx', 'qazwsxedc', 'a1b2c3d4',
    'blink182', 'pa55word', 'passw0rd',
  ].map((w) => w.toLowerCase())
);

// Keyboard rows and the alphabet: any 8+ character run along one of them, either way, is a pattern rather than a password.
const RUNS = ['1234567890', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm', 'abcdefghijklmnopqrstuvwxyz', '0987654321'];

const LOOK_ALIKES: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', $: 's', '!': 'i' };
const readAsLetters = (text: string) => text.replace(/[013457@$!]/g, (c) => LOOK_ALIKES[c] ?? c);
// Digits, symbols and spaces before and after the letters ("123password!" -> "password").
const core = (text: string) => text.replace(/^[^a-z]+|[^a-z]+$/g, '');

/** Why a password is too easy to guess, or null when it is not one of the obvious ones. `email` adds its name part to the list. */
export function guessableReason(password: string, email?: string): string | null {
  const lower = password.normalize('NFKC').toLowerCase();
  const local = (email ?? '').trim().toLowerCase().split('@')[0];
  const cores = new Set([core(lower), readAsLetters(core(lower)), core(readAsLetters(lower))]);
  if (local.length >= 3 && (lower === local || cores.has(local))) return 'The password cannot be based on your email address.';
  const easy =
    COMMON.has(lower) ||
    [...cores].some((c) => COMMON.has(c)) ||
    // One character, or a short piece, over and over ("aaaaaaaa", "abcabcabc", "12121212").
    /^(.{1,4})\1+$/.test(lower) ||
    RUNS.some((run) => run.includes(lower) || [...run].reverse().join('').includes(lower)) ||
    // Only digits and short enough to be a date or a phone-pad pattern ("01011990").
    /^\d{8,9}$/.test(lower);
  return easy ? 'That password is too easy to guess. Use a few unrelated words together, or a longer mix of letters and numbers.' : null;
}
