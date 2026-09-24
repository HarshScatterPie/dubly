import type { GlossaryEntry } from '../../src/types';
import { db } from './firebaseAdmin';

// One document per workspace: a few hundred short terms sit far below Firestore's 1 MiB limit.
const glossaryDoc = (workspaceId: string) => db.collection('workspaces').doc(workspaceId).collection('meta').doc('glossary');

export async function getGlossary(workspaceId: string): Promise<GlossaryEntry[]> {
  const snap = await glossaryDoc(workspaceId).get();
  const entries = snap.exists ? (snap.get('entries') as GlossaryEntry[] | undefined) : undefined;
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
  await glossaryDoc(workspaceId).set({ entries: normalized, updatedAt: new Date().toISOString(), updatedBy });
  return normalized;
}
