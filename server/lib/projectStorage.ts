import { BSON, type ClientSession } from 'mongodb';
import { col, mergeUpdate, DELETE_FIELD } from './mongo';
import { HttpError } from './httpError';
import type { StoredLanguageOutput, StoredProject } from './projectRepo';
import type { SegmentCounts } from '../../src/types';

/**
 * Project layout: one metadata document in `projects` plus its lines in `projectSegments`, one document for the transcript and one
 * per language. Progress polls and the project list then read only the small metadata document, and a progress write never
 * rewrites hours of transcript. A project is reassembled into the familiar all-in-one shape on read.
 */
export type ProjectDoc = Omit<StoredProject, 'transcriptSegments' | 'localizedSegments'> & { _id: string; workspaceId: string };

export interface SegmentsDoc {
  _id: string;
  workspaceId: string;
  projectId: string;
  kind: 'transcript' | 'language';
  code?: string;
  segments: unknown[];
  updatedAt: string;
}

export const projectsCol = () => col<ProjectDoc>('projects');
export const segmentsCol = () => col<SegmentsDoc>('projectSegments');

const transcriptId = (projectId: string) => `${projectId}:transcript`;
const languageId = (projectId: string, code: string) => `${projectId}:lang:${code}`;

// MongoDB refuses documents over 16 MiB; a write that would come close is refused with a clear message instead.
export const MONGO_MAX_DOCUMENT_BYTES = 16 * 1024 * 1024;
const SIZE_GUARD = 0.95;

export function documentBytes(doc: Record<string, unknown>): number {
  return BSON.calculateObjectSize(doc, { ignoreUndefined: true });
}

function checkSize(doc: Record<string, unknown>): void {
  if (documentBytes(doc) > MONGO_MAX_DOCUMENT_BYTES * SIZE_GUARD) {
    throw new HttpError(413, 'PROJECT_TOO_LARGE', 'This project has grown too large to save. Split the video into shorter parts.');
  }
}

function toStored(doc: ProjectDoc): Omit<StoredProject, 'transcriptSegments' | 'localizedSegments'> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { _id, workspaceId, ...rest } = doc;
  return rest;
}

function assemble(doc: ProjectDoc, parts: SegmentsDoc[]): StoredProject {
  const transcript = parts.find((p) => p.kind === 'transcript');
  const byCode = new Map(parts.filter((p) => p.kind === 'language').map((p) => [p.code!, p.segments as StoredProject['localizedSegments']]));
  const meta = toStored(doc);
  const languageOutputs = meta.languageOutputs
    ? Object.fromEntries(Object.entries(meta.languageOutputs).map(([code, out]) => [code, { ...out, localizedSegments: byCode.get(code) || [] }]))
    : meta.languageOutputs;
  return {
    ...meta,
    transcriptSegments: (transcript?.segments as StoredProject['transcriptSegments']) || [],
    localizedSegments: byCode.get(meta.targetLanguage) || [],
    languageOutputs,
  } as StoredProject;
}

/** Reads a whole project (metadata and all its lines); null when it does not exist in this workspace. */
export async function loadProject(workspaceId: string, projectId: string, session?: ClientSession): Promise<StoredProject | null> {
  const doc = await projectsCol().findOne({ _id: projectId, workspaceId }, { session });
  if (!doc) return null;
  const parts = await segmentsCol().find({ projectId, workspaceId }, { session }).toArray();
  return assemble(doc, parts);
}

/** Many projects at once, two queries in all. */
export async function loadProjects(workspaceId: string, docs: ProjectDoc[]): Promise<StoredProject[]> {
  if (!docs.length) return [];
  const parts = await segmentsCol()
    .find({ workspaceId, projectId: { $in: docs.map((d) => d._id) } })
    .toArray();
  const byProject = new Map<string, SegmentsDoc[]>();
  for (const part of parts) byProject.set(part.projectId, [...(byProject.get(part.projectId) || []), part]);
  return docs.map((doc) => assemble(doc, byProject.get(doc._id) || []));
}

/**
 * Every project of a workspace without its lines (empty arrays), newest first: what lists and the dashboard need, from the small
 * metadata documents alone. Projects written before line counts were kept are counted once here and the counts saved.
 */
export async function loadProjectSummaries(workspaceId: string): Promise<StoredProject[]> {
  const docs = await projectsCol().find({ workspaceId }).sort({ createdAt: -1 }).toArray();
  const uncounted = docs.filter((d) => d.segmentCounts?.complete !== true);
  if (uncounted.length) {
    const rows = await segmentsCol()
      .aggregate<{ projectId: string; kind: string; code?: string; n: number }>([
        { $match: { workspaceId, projectId: { $in: uncounted.map((d) => d._id) } } },
        { $project: { _id: 0, projectId: 1, kind: 1, code: 1, n: { $size: { $ifNull: ['$segments', []] } } } },
      ])
      .toArray();
    for (const doc of uncounted) {
      const counts: SegmentCounts = { transcript: 0, languages: {}, complete: true };
      for (const row of rows) {
        if (row.projectId !== doc._id) continue;
        if (row.kind === 'transcript') counts.transcript = row.n;
        else if (row.code) counts.languages![row.code] = row.n;
      }
      doc.segmentCounts = counts;
      await projectsCol().updateOne({ _id: doc._id, workspaceId, 'segmentCounts.complete': { $ne: true } }, { $set: { segmentCounts: counts } });
    }
  }
  return docs.map((doc) => assemble(doc, []));
}

/** Just the metadata document, for checks that never look at the lines (job ownership, progress). */
export async function loadProjectMeta(workspaceId: string, projectId: string, session?: ClientSession): Promise<ProjectDoc | null> {
  return projectsCol().findOne({ _id: projectId, workspaceId }, { session });
}

export interface WritePlan {
  project: Record<string, unknown>;
  parts: SegmentsDoc[];
}

/**
 * Splits an all-in-one patch into the metadata merge and the segment documents to replace. Top-level `localizedSegments` means
 * the primary language's lines (the patch's `targetLanguage`, else the project's current one).
 */
export function planProjectWrite(
  workspaceId: string,
  projectId: string,
  current: Pick<StoredProject, 'targetLanguage' | 'languageOutputs'> | null | undefined,
  patch: Partial<StoredProject>
): WritePlan {
  const now = new Date().toISOString();
  const parts = new Map<string, SegmentsDoc>();
  const setPart = (kind: 'transcript' | 'language', segments: unknown[] | undefined, code?: string) => {
    if (segments === undefined) return;
    const _id = kind === 'transcript' ? transcriptId(projectId) : languageId(projectId, code!);
    parts.set(_id, { _id, workspaceId, projectId, kind, ...(code ? { code } : {}), segments, updatedAt: now });
  };
  const project: Record<string, unknown> = {};
  const outputs: Record<string, Record<string, unknown>> = {};

  for (const [key, value] of Object.entries(patch)) {
    if (key === 'transcriptSegments') {
      setPart('transcript', value as unknown[]);
    } else if (key === 'localizedSegments') {
      // Applied after languageOutputs below, matching the reader's precedence.
    } else if (key === 'languageOutputs' && value) {
      for (const [code, out] of Object.entries(value as Record<string, StoredLanguageOutput>)) {
        const { localizedSegments, ...meta } = out;
        setPart('language', localizedSegments, code);
        outputs[code] = { ...(outputs[code] || {}), ...meta };
      }
    } else if (key !== 'id') {
      project[key] = value;
    }
  }
  if (patch.localizedSegments !== undefined) {
    const primary = patch.targetLanguage ?? current?.targetLanguage;
    if (primary) setPart('language', patch.localizedSegments, primary);
  }
  // A language whose patch carried only its lines keeps its stored fields; one the project does not have yet is created empty.
  for (const [code, meta] of Object.entries(outputs)) {
    if (!Object.keys(meta).length && current?.languageOutputs?.[code]) delete outputs[code];
  }
  if (Object.keys(outputs).length) project.languageOutputs = outputs;

  const planned = [...parts.values()];
  planned.forEach((part) => checkSize(part as unknown as Record<string, unknown>));
  // The line count of every part written goes on the project too (merged field by field), so lists never need the lines themselves.
  const languages: Record<string, number> = {};
  const counts: Record<string, unknown> = {};
  for (const part of planned) {
    if (part.kind === 'transcript') counts.transcript = part.segments.length;
    else if (part.code) languages[part.code] = part.segments.length;
  }
  if (Object.keys(languages).length) counts.languages = languages;
  if (Object.keys(counts).length) project.segmentCounts = counts;
  return { project, parts: planned };
}

/** Creates the project from a plan (inside the caller's transaction). */
export async function insertPlan(workspaceId: string, projectId: string, plan: WritePlan, session: ClientSession): Promise<void> {
  // A new project's parts are all in this plan, so its counts are whole from the start.
  const counts = { transcript: 0, languages: {}, ...((plan.project.segmentCounts as object) ?? {}), complete: true };
  const doc = { ...stripDeletes(plan.project), segmentCounts: counts, _id: projectId, id: projectId, workspaceId } as ProjectDoc;
  checkSize(doc as unknown as Record<string, unknown>);
  await projectsCol().insertOne(doc, { session });
  await writeParts(plan.parts, session);
}

/** Applies a plan to an existing project inside the caller's transaction: the metadata is merged field by field, each segment document replaced. */
export async function applyPlan(workspaceId: string, projectId: string, plan: WritePlan, session: ClientSession): Promise<void> {
  const update = mergeUpdate(plan.project);
  if (update.$set || update.$unset) await projectsCol().updateOne({ _id: projectId, workspaceId }, update, { session });
  await writeParts(plan.parts, session);
}

async function writeParts(parts: SegmentsDoc[], session: ClientSession): Promise<void> {
  for (const part of parts) await segmentsCol().replaceOne({ _id: part._id }, part, { upsert: true, session });
}

export async function deleteProjectDocuments(workspaceId: string, projectId: string, session: ClientSession): Promise<void> {
  await segmentsCol().deleteMany({ projectId, workspaceId }, { session });
  await projectsCol().deleteOne({ _id: projectId, workspaceId }, { session });
}

function stripDeletes(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== DELETE_FIELD && v !== undefined));
}
