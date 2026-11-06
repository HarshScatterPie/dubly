import type { GlossaryEntry } from '../../src/types';
import { col } from './mongo';

// One document per workspace (glossaries/{workspaceId}): a few hundred short terms.
const glossaries = () => col<{ _id: string; entries: GlossaryEntry[]; updatedAt: string; updatedBy: string }>('glossaries');

export async function getGlossary(workspaceId: string): Promise<GlossaryEntry[]> {
  const entries = (await glossaries().findOne({ _id: workspaceId }))?.entries;
  return Array.isArray(entries) ? entries : [];
}

// Drops empty optional fields so the stored document holds only what was actually set.
function normalizeEntry(entry: GlossaryEntry): GlossaryEntry {
  const translations = Object.fromEntries(Object.entries(entry.translations ?? {}).filter(([, value]) => value.trim().length > 0));
  return {
    id: entry.id,
    term: entry.term.trim(),
    mode: entry.mode,
    ...(entry.mode === 'translate' && Object.keys(translations).length ? { translations } : {}),
    ...(entry.spokenAs?.trim() ? { spokenAs: entry.spokenAs.trim() } : {}),
    ...(entry.note?.trim() ? { note: entry.note.trim() } : {}),
  };
}

export async function saveGlossary(workspaceId: string, entries: GlossaryEntry[], updatedBy: string): Promise<GlossaryEntry[]> {
  const normalized = entries.map(normalizeEntry);
  await glossaries().replaceOne({ _id: workspaceId }, { entries: normalized, updatedAt: new Date().toISOString(), updatedBy }, { upsert: true });
  return normalized;
}
