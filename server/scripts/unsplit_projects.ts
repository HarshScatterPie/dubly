// Rollback for the storage split: rejoins split projects into single docs (dry run by default, --apply to write; too-large ones are skipped).
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
