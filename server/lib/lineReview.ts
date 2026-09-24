import type { GlossaryEntry, LocalizedSegment, QaFlag } from '../../src/types';
import { glossaryMisses, withoutKeptTerms } from './glossary';
import { isInExpectedScript } from './languageMeta';
import { cleanDelivery } from './speechStyle';

const RENDER_FLAGS: QaFlag[] = ['condensed', 'rushed', 'overflow'];
// A line sped up past this is audibly hurried, though still inside the stitcher's limit.
export const RUSHED_RATIO = 1.15;

export interface ReviewContext {
  languageCode: string;
  sourceLanguageCode: string;
  glossary: GlossaryEntry[];
}

// Flags that follow from the text alone, so they are recomputed whenever a line is translated or saved.
export function textQaFlags(seg: Pick<LocalizedSegment, 'sourceText' | 'translatedText'>, ctx: ReviewContext): QaFlag[] {
  const source = seg.sourceText.trim();
  const translated = seg.translatedText.trim();
  if (!source) return [];
  const flags: QaFlag[] = [];
  // A failed translation falls back to the source text, so an unchanged line usually means nothing was translated.
  if (!translated || (ctx.languageCode !== ctx.sourceLanguageCode && translated === source)) flags.push('untranslated');
  else if (!isInExpectedScript(withoutKeptTerms(translated, ctx.glossary), ctx.languageCode)) flags.push('wrong_script');
  if (translated && glossaryMisses(source, translated, ctx.glossary, ctx.languageCode).length) flags.push('glossary');
  return flags;
}

// How a rendered line fit its slot: shortened by the model, audibly sped up, or still too long and running into the next line.
export function renderQaFlags(opts: { condensed: boolean; spokenSeconds: number; availableSeconds: number; maxCompression: number }): QaFlag[] {
  const flags: QaFlag[] = [];
  if (opts.condensed) flags.push('condensed');
  const ratio = opts.availableSeconds > 0 ? opts.spokenSeconds / opts.availableSeconds : 0;
  if (ratio > opts.maxCompression) flags.push('overflow');
  else if (ratio > RUSHED_RATIO) flags.push('rushed');
  return flags;
}

export function withFlags<T extends LocalizedSegment>(seg: T, flags: QaFlag[]): T {
  const { qaFlags: _old, ...rest } = seg;
  return (flags.length ? { ...rest, qaFlags: flags } : rest) as T;
}

// Applies the server's rules to lines a client saved: its fingerprints and render flags are ignored, text flags are recomputed.
export function reconcileSavedSegments(incoming: LocalizedSegment[], stored: LocalizedSegment[], ctx: ReviewContext): LocalizedSegment[] {
  const storedById = new Map(stored.map((s) => [s.id, s]));
  return incoming.map((seg) => {
    const previous = storedById.get(seg.id);
    const { renderKey: _clientKey, qaFlags: _clientFlags, delivery, ...rest } = seg;
    // Render flags describe audio that was made from this exact text; an edit makes them stale.
    const renderFlags =
      previous && previous.translatedText === seg.translatedText ? (previous.qaFlags ?? []).filter((f) => RENDER_FLAGS.includes(f)) : [];
    const cleanedDelivery = cleanDelivery(delivery);
    // Timing and origin come from analysis, not the editor; pinning them keeps a retake's charge tied to the real slot lengths.
    const pinned = previous
      ? { segmentId: previous.segmentId, startTime: previous.startTime, endTime: previous.endTime, speaker: previous.speaker, sourceText: previous.sourceText }
      : {};
    const line: LocalizedSegment = {
      ...rest,
      ...pinned,
      ...(cleanedDelivery ? { delivery: cleanedDelivery } : {}),
      ...(previous?.renderKey ? { renderKey: previous.renderKey } : {}),
    };
    return withFlags(line, [...textQaFlags(line, ctx), ...renderFlags]);
  });
}
