import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { MAX_DELIVERY_LENGTH } from './speechStyle';

// Runtime shapes for every write endpoint; limits are generous next to real UI use (a 60-minute video is ~750 segments).
const MAX_SEGMENTS = 5000;
const MAX_TEXT = 5000;
const MAX_MAP_ENTRIES = 50;
const MAX_GLOSSARY_ENTRIES = 300;

const id = z.string().min(1).max(200);
const languageCode = z.string().min(2).max(32).regex(/^[A-Za-z]{2,10}([-_][A-Za-z0-9]{1,8})*$/, 'Invalid language code');
const voiceId = z.string().min(1).max(120);
// Timings come from models and alignment, so small negative or rounding artefacts are tolerated; absurd values are not.
const seconds = z.number().finite().min(-60).max(24 * 60 * 60);
const multiplier = z.number().finite().min(0.5).max(2);

const emptyToUndefined = (value: unknown) => (value === '' ? undefined : value);

const boundedRecord = <T extends z.ZodTypeAny>(value: T) =>
  z.record(z.string().min(1).max(100), value).refine((obj) => Object.keys(obj).length <= MAX_MAP_ENTRIES, `At most ${MAX_MAP_ENTRIES} entries`);

export const translationStyle = z.enum(['natural', 'literal', 'professional', 'casual', 'marketing']);
export const voiceEmotion = z.enum(['neutral', 'friendly', 'energetic', 'professional', 'empathetic']);
const dubbingStep = z.enum(['upload', 'understand', 'localize', 'voice', 'export']);
const provider = z.enum(['auto', 'vertex']);
const role = z.enum(['admin', 'editor']);
// Delivery direction for the voice; the server flattens it further (speechStyle.cleanDelivery).
const delivery = z.string().max(MAX_DELIVERY_LENGTH);

const glossaryEntry = z.object({
  id: z.string().trim().min(1).max(64),
  term: z.string().trim().min(1).max(100),
  mode: z.enum(['keep', 'translate']),
  translations: z
    .record(languageCode, z.string().trim().max(200))
    .refine((obj) => Object.keys(obj).length <= MAX_MAP_ENTRIES, `At most ${MAX_MAP_ENTRIES} entries`)
    .optional(),
  spokenAs: z.string().trim().max(100).optional(),
  note: z.string().trim().max(300).optional(),
});

// Segments keep any extra fields the editor attaches (passthrough); the known ones are type-checked and bounded.
const transcriptSegment = z
  .object({
    id,
    startTime: seconds,
    endTime: seconds,
    text: z.string().max(MAX_TEXT),
    speaker: z.string().max(100).nullable().optional(),
    wordsCount: z.number().int().min(0).max(10_000).nullable().optional(),
    confidence: z.number().finite().nullable().optional(),
    words: z.array(z.object({ text: z.string().max(200), start: seconds, end: seconds }).passthrough()).max(2000).optional(),
    delivery: delivery.optional(),
  })
  .passthrough();

const localizedSegment = z
  .object({
    id,
    segmentId: id,
    startTime: seconds,
    endTime: seconds,
    speaker: z.string().max(100).nullable().optional(),
    sourceText: z.string().max(MAX_TEXT),
    translatedText: z.string().max(MAX_TEXT),
    isEdited: z.boolean().nullable().optional(),
    delivery: delivery.optional(),
  })
  .passthrough();

const voiceChoices = {
  voiceId: voiceId.optional(),
  selectedVoiceId: voiceId.optional(),
  voiceSpeed: multiplier.optional(),
  voicePitch: multiplier.optional(),
  voiceEmotion: voiceEmotion.optional(),
  speakerVoiceMap: boundedRecord(voiceId).optional(),
  languageVoiceMap: boundedRecord(voiceId).optional(),
  languageSpeakerVoiceMap: boundedRecord(boundedRecord(voiceId)).optional(),
  autoLipSync: z.boolean().optional(),
};

export const schemas = {
  createProject: z.object({
    title: z.string().trim().max(200).optional(),
    sourceLanguage: languageCode.optional(),
    targetLanguage: languageCode.optional(),
  }),
  patchProject: z.object({
    title: z.string().trim().min(1).max(200).optional(),
    targetLanguage: languageCode.optional(),
    ...voiceChoices,
    translationStyle: translationStyle.optional(),
    adaptExpressions: z.boolean().optional(),
    transcriptSegments: z.array(transcriptSegment).max(MAX_SEGMENTS).optional(),
    localizedSegments: z.array(localizedSegment).max(MAX_SEGMENTS).optional(),
    currentStep: dubbingStep.optional(),
  }),
  patchLanguageSegments: z.object({ localizedSegments: z.array(localizedSegment).max(MAX_SEGMENTS) }),
  translate: z.object({
    style: translationStyle.optional(),
    adaptExpressions: z.boolean().optional(),
    targetLanguageCode: languageCode.optional(),
    targetLanguageCodes: z.array(languageCode).max(20).optional(),
    regenerate: z.boolean().optional(),
  }),
  dub: z.object({
    ...voiceChoices,
    separateBackground: z.boolean().optional(),
    languages: z.array(languageCode).max(20).optional(),
  }),
  exportVideo: z.object({ languageCode: languageCode.optional(), captions: z.boolean().optional() }),
  share: z.object({ languageCode: languageCode.optional() }),
  importSample: z.object({ sampleId: z.string().max(100).optional(), sourceUrl: z.string().max(2000).optional(), fileName: z.string().max(300).optional() }),
  // No length cap on the text itself (product decision); the 2 MB request limit bounds it.
  tts: z.object({
    text: z.string().trim().min(1),
    voiceId,
    languageCode: languageCode.optional(),
    speed: multiplier.optional(),
    pitch: multiplier.optional(),
    emotion: voiceEmotion.optional(),
    delivery: delivery.optional(),
  }),
  // Terms are unique regardless of case, or two entries could demand different renderings of one word.
  glossary: z.object({
    entries: z
      .array(glossaryEntry)
      .max(MAX_GLOSSARY_ENTRIES)
      .refine((entries) => new Set(entries.map((e) => e.term.toLocaleLowerCase())).size === entries.length, 'Each term may appear only once'),
  }),
  settings: z.object({
    sttProvider: provider.optional(),
    translateProvider: provider.optional(),
    ttsProvider: provider.optional(),
    preferences: z
      .object({
        defaultTargetLanguages: z.array(languageCode).max(10).optional(),
        defaultVoiceId: voiceId.optional(),
        translationStyle: translationStyle.optional(),
        adaptExpressions: z.boolean().optional(),
        voiceEmotion: voiceEmotion.optional(),
        voiceSpeed: z.number().finite().min(0.75).max(1.25).optional(),
        expressiveVoices: z.boolean().optional(),
        separateBackground: z.boolean().optional(),
        autoLipSync: z.boolean().optional(),
        burnCaptions: z.boolean().optional(),
        aiReview: z.boolean().optional(),
        premiumVoices: z.boolean().optional(),
        paceRetakes: z.boolean().optional(),
      })
      .optional(),
  }),
  renameWorkspace: z.object({ name: z.string().trim().min(1).max(80) }),
  invite: z.object({ email: z.string().trim().min(3).max(254), role }),
  changeRole: z.object({ role }),
  inviteToken: z.object({ token: z.string().min(10).max(200) }),
  // Multipart form fields arrive as strings; an empty one means "not given".
  voiceSample: z.object({
    name: z.preprocess(emptyToUndefined, z.string().trim().max(80).optional()),
    gender: z.preprocess(emptyToUndefined, z.enum(['male', 'female', 'non-binary']).optional()),
    languageCode: z.preprocess(emptyToUndefined, languageCode.optional()),
  }),
};

// Replaces req.body with its parsed value (unknown top-level fields dropped) or answers 400 naming the bad fields, never echoing values.
export function validateBody(schema: z.ZodTypeAny) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body ?? {});
    if (!result.success) {
      const fields = [...new Set(result.error.issues.map((issue) => issue.path.join('.') || '(body)'))].slice(0, 10);
      res.status(400).json({ error: `Invalid request: check ${fields.join(', ')}.`, code: 'VALIDATION_FAILED', fields });
      return;
    }
    req.body = result.data;
    next();
  };
}
