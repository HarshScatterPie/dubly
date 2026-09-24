/**
 * Rollback helper for the project storage split (docs/DATABASE.md). Copies each split project's transcript and language
 * segments back into its metadata document, so code from before the split can read it again. The subdocuments are left in
 * place (harmless to old code, and needed if the rollback is itself rolled back).
 *
 *   npx tsx server/scripts/unsplit_projects.ts            dry run: reports what would change
 *   npx tsx server/scripts/unsplit_projects.ts --apply    writes
 *
 * Projects that would exceed Firestore's 1 MiB document limit when rejoined cannot be unsplit; they are listed and skipped.
 */
import '../lib/env';
import { db } from '../lib/firebaseAdmin';
import { loadProject } from '../lib/projectStorage';
import { FIRESTORE_MAX_DOCUMENT_BYTES, firestoreDocumentSize } from '../lib/documentSize';

export async function unsplitProjects(apply: boolean): Promise<{ unsplit: string[]; tooLarge: string[] }> {
  const unsplit: string[] = [];
  const tooLarge: string[] = [];
  // Walked per workspace (collection-scope queries need no custom index, unlike a collection-group query).
  const docs = [];
  for (const workspace of await db.collection('workspaces').listDocuments()) {
    docs.push(...(await workspace.collection('projects').where('segmentsStorage', '==', 'split').get()).docs);
  }
  for (const doc of docs) {
    const project = await loadProject(doc.ref);
    if (!project) continue;
    const inline = {
      ...project,
      segmentsStorage: null,
      localizedSegments: project.localizedSegments,
      transcriptSegments: project.transcriptSegments,
      languageOutputs: project.languageOutputs,
    };
    if (firestoreDocumentSize(doc.ref.path, inline) > FIRESTORE_MAX_DOCUMENT_BYTES * 0.98) {
      tooLarge.push(doc.ref.path);
      continue;
    }
    if (apply) await doc.ref.set(inline);
    unsplit.push(doc.ref.path);
  }
  return { unsplit, tooLarge };
}

if (process.argv[1]?.endsWith('unsplit_projects.ts')) {
  const apply = process.argv.includes('--apply');
  unsplitProjects(apply).then(({ unsplit, tooLarge }) => {
    console.log(`${apply ? 'Unsplit' : 'Would unsplit'} ${unsplit.length} project(s).`);
    if (tooLarge.length) console.log(`Too large to rejoin (left split): ${tooLarge.join(', ')}`);
    process.exit(0);
  });
}
