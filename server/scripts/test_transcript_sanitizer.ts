/**
 * Guards the transcript sanitiser against both kinds of mistake: leaving a speech model's
 * repetition loop in, and eating a transcript that was fine all along.
 *
 *     node node_modules/tsx/dist/cli.mjs server/scripts/test_transcript_sanitizer.ts
 *
 * Written after a real 113-second interview came back as 223 segments, 204 of them the word
 * "Okay." — the sanitiser cuts that to 20 while keeping every real line. These cases pin
 * down the rule that makes it safe: it only ever collapses a *consecutive* run of something
 * short, so genuine repetition with speech in between survives untouched.
 */
import { sanitizeTranscript } from '../lib/transcriptSanitizer';
import type { TranscriptSegment } from '../../src/types';

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
};

let counter = 0;
const seg = (text: string, start = 0, end = 1): TranscriptSegment => ({
  id: `s-${counter++}`,
  startTime: start,
  endTime: end,
  text,
  speaker: 'Speaker 1',
  wordsCount: text.split(/\s+/).filter(Boolean).length,
  confidence: 0.9,
});

console.log('== leaves good transcripts alone ==');
{
  const r = sanitizeTranscript([seg('Hello there'), seg('How are you'), seg('Good to see you')]);
  check('a clean transcript is untouched', r.segments.length === 3 && r.removed === 0);
}
{
  const r = sanitizeTranscript([seg('Okay'), seg('So what happened next'), seg('Okay'), seg('Then we launched'), seg('Okay')]);
  check('non-consecutive repeats are kept (real dialogue)', r.segments.length === 5 && r.removed === 0);
}
{
  const r = sanitizeTranscript([seg('No'), seg('No'), seg('I disagree')]);
  check('a run of two is normal speech, not a loop', r.segments.length === 3 && r.removed === 0);
}
{
  const line = 'we are going to walk through the entire launch sequence today';
  const r = sanitizeTranscript([seg(line), seg(line), seg(line), seg(line)]);
  check('a long sentence repeating is left alone', r.segments.length === 4, r.segments.length);
}

console.log('\n== strips model repetition loops ==');
{
  const loop = Array.from({ length: 40 }, (_, i) => seg('Okay.', 30 + i * 0.1, 30.5 + i * 0.1));
  const r = sanitizeTranscript([seg('Real line one'), ...loop, seg('Real line two')]);
  check('a 40-long loop collapses to one', r.segments.length === 3, r.segments.map((s) => s.text));
  check('  reports what it removed', r.removed === 39, r.removed);
  check('  keeps the real lines either side', r.segments[0].text === 'Real line one' && r.segments[2].text === 'Real line two');
}
{
  const r = sanitizeTranscript([seg('Okay!'), seg('okay'), seg('Okay.'), seg('OKAY')]);
  check('case and punctuation differences still count as one loop', r.segments.length === 1, r.segments.map((s) => s.text));
}
{
  const loopA = Array.from({ length: 10 }, () => seg('Okay'));
  const loopB = Array.from({ length: 10 }, () => seg('Thank you'));
  const r = sanitizeTranscript([...loopA, seg('Actual content here'), ...loopB]);
  check('two separate loops both collapse', r.segments.length === 3, r.segments.map((s) => s.text));
  check('  the note mentions both runs', r.note.includes('2 separate runs'), r.note);
}
{
  // The shape actually observed: one enormous run, real speech only after it.
  const loop = Array.from({ length: 204 }, (_, i) => seg('Okay.', 30 + i * 0.06, 30.3 + i * 0.06));
  const real = Array.from({ length: 19 }, (_, i) => seg(`Real sentence number ${i} with some length`, 56 + i, 57 + i));
  const r = sanitizeTranscript([...loop, ...real]);
  check('the real 223-segment shape reduces to 20', r.segments.length === 20, r.segments.length);
  check('  every real line survives', r.segments.filter((s) => s.text.startsWith('Real')).length === 19);
}

console.log('\n== degenerate input ==');
{
  const r = sanitizeTranscript([seg('Hello'), seg('   '), seg('World')]);
  check('blank segments are dropped', r.segments.length === 2 && r.removed === 1);
}
{
  const r = sanitizeTranscript([]);
  check('empty input is safe', r.segments.length === 0 && r.removed === 0);
}
{
  const r = sanitizeTranscript(Array.from({ length: 5 }, () => seg('   ')));
  check('an all-blank transcript comes back empty, not looping', r.segments.length === 0);
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
