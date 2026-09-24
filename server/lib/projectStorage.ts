import { FieldValue, type DocumentReference, type DocumentSnapshot, type Transaction } from 'firebase-admin/firestore';
import { FIRESTORE_MAX_DOCUMENT_BYTES, firestoreDocumentSize } from './documentSize';
import { HttpError } from './httpError';
import type { StoredLanguageOutput, StoredProject } from './projectRepo';

// Project layout: metadata doc + content/transcript + languages/{code} (a single doc overflows 1 MiB, see DATABASE.md); old single-doc projects move on first write.
export const SPLIT = 'split';

const transcriptRef = (project: DocumentReference) => project.collection('content').doc('transcript');
const languageRef = (project: DocumentReference, code: string) => project.collection('languages').doc(code);

type RawProject = StoredProject & { segmentsStorage?: string };

function assemble(data: RawProject, transcript: DocumentSnapshot | null, languages: DocumentSnapshot[]): StoredProject {
  if (data.segmentsStorage !== SPLIT) return data;
  const byCode = new Map(languages.map((d) => [d.id, (d.get('segments') as StoredProject['localizedSegments']) || []]));
  const languageOutputs = data.languageOutputs
    ? Object.fromEntries(
        Object.entries(data.languageOutputs).map(([code, out]) => [code, { ...out, localizedSegments: byCode.get(code) || [] }])
      )
    : data.languageOutputs;
  const { segmentsStorage: _layout, ...rest } = data;
  return {
    ...rest,
    transcriptSegments: (transcript?.get('segments') as StoredProject['transcriptSegments']) || [],
    localizedSegments: byCode.get(data.targetLanguage) || [],
    languageOutputs,
  };
}

// Reads a project in either layout and returns the familiar all-in-one shape; null when it does not exist.
export async function loadProject(ref: DocumentReference): Promise<StoredProject | null> {
  const snap = await ref.get();
  if (!snap.exists) return null;
  const data = snap.data() as RawProject;
  if (data.segmentsStorage !== SPLIT) return data;
  const [transcript, languages] = await Promise.all([transcriptRef(ref).get(), ref.collection('languages').get()]);
  return assemble(data, transcript, languages.docs);
}

export interface WritePlan {
  project: Record<string, unknown>;
  parts: { ref: DocumentReference; data: Record<string, unknown> }[];
}

function checkSize(ref: DocumentReference, data: Record<string, unknown>): void {
  if (firestoreDocumentSize(ref.path, data) > FIRESTORE_MAX_DOCUMENT_BYTES * 0.98) {
    throw new HttpError(413, 'PROJECT_TOO_LARGE', 'This project has grown too large to save. Split the video into shorter parts.');
  }
}

// Splits an all-in-one patch into the metadata merge and segment docs, moving an old-layout project out in the same write; top-level localizedSegments means the primary language.
export function planProjectWrite(ref: DocumentReference, current: RawProject | undefined, patch: Partial<StoredProject>): WritePlan {
  const segmentsByPart = new Map<string, { ref: DocumentReference; segments: unknown[] }>();
  const setPart = (partRef: DocumentReference, segments: unknown[] | undefined) => {
    if (segments !== undefined) segmentsByPart.set(partRef.path, { ref: partRef, segments });
  };
  const project: Record<string, unknown> = {};
  const outputs: Record<string, Record<string, unknown>> = {};

  const legacy = current !== undefined && current.segmentsStorage !== SPLIT;
  if (current === undefined || legacy) project.segmentsStorage = SPLIT;
  if (legacy) {
    setPart(transcriptRef(ref), current.transcriptSegments);
    for (const [code, out] of Object.entries(current.languageOutputs || {})) {
      setPart(languageRef(ref, code), out.localizedSegments);
      outputs[code] = { localizedSegments: FieldValue.delete() };
    }
    // The old reader preferred the top-level copy for the primary language, so it wins here too.
    if (current.localizedSegments?.length && current.targetLanguage) setPart(languageRef(ref, current.targetLanguage), current.localizedSegments);
    project.transcriptSegments = FieldValue.delete();
    project.localizedSegments = FieldValue.delete();
  }

  for (const [key, value] of Object.entries(patch)) {
    if (key === 'transcriptSegments') {
      setPart(transcriptRef(ref), value as unknown[]);
    } else if (key === 'localizedSegments') {
      // Applied after languageOutputs below, matching the reader's precedence.
    } else if (key === 'languageOutputs' && value) {
      for (const [code, out] of Object.entries(value as Record<string, StoredLanguageOutput>)) {
        const { localizedSegments, ...meta } = out;
        setPart(languageRef(ref, code), localizedSegments);
        outputs[code] = { ...(outputs[code] || {}), ...meta };
        if (!legacy) delete outputs[code].localizedSegments;
      }
    } else {
      project[key] = value;
    }
  }
  if (patch.localizedSegments !== undefined) {
    const primary = patch.targetLanguage ?? current?.targetLanguage;
    if (primary) setPart(languageRef(ref, primary), patch.localizedSegments);
  }
  if (Object.keys(outputs).length) project.languageOutputs = outputs;

  const now = new Date().toISOString();
  const parts = [...segmentsByPart.values()].map(({ ref: partRef, segments }) => ({ ref: partRef, data: { segments, updatedAt: now } }));
  parts.forEach((part) => checkSize(part.ref, part.data));
  return { project, parts };
}

// Applies a plan inside a transaction; the metadata is merged, each segment document replaced whole.
export function applyPlan(tx: Transaction, ref: DocumentReference, plan: WritePlan): void {
  tx.set(ref, plan.project, { merge: true });
  for (const part of plan.parts) tx.set(part.ref, part.data);
}
