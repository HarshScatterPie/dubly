import { Router } from '../lib/router';
import { createHash, randomBytes } from 'node:crypto';
import { bucket, db, signReadUrl } from '../lib/firebaseAdmin';
import { getStoredProject, projectLanguages } from '../lib/projectRepo';
import { getLanguageName } from '../lib/languageMeta';
import { rateLimit } from '../lib/rateLimit';
import { rateRules } from '../lib/limits';
import { schemas, validateBody } from '../lib/validation';

// Public share links for a finished dub: anyone with the link can watch and download it for 24 hours, then it is dead.
const SHARE_TTL_MS = 24 * 60 * 60 * 1000;
// Media URLs on the share page live at most this long, so turning a link off also stops its copied video URL soon after.
const SHARE_MEDIA_URL_MAX_MS = 2 * 60 * 60 * 1000;
const sharesCol = () => db.collection('shares');
// Like invitations, a share is stored under the token's hash: the link is the only copy of the token.
export const shareIdFor = (token: string) => createHash('sha256').update(token).digest('hex');

interface StoredShare {
  uid: string;
  workspaceId?: string;
  projectId: string;
  languageCode: string;
  storagePath: string;
  title: string;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
  revokedBy?: string;
}

// Removes every share of a project, e.g. when the project itself is deleted.
export async function deleteSharesForProject(projectId: string): Promise<void> {
  const snap = await sharesCol().where('projectId', '==', projectId).get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
}

// Mounted behind requireAuth + requireWorkspace: any member of the project's workspace can mint a link.
export const shareCreateRouter = Router();

shareCreateRouter.post('/:id/share', validateBody(schemas.share), async (req, res) => {
  const uid = req.uid!;
  const stored = await getStoredProject(req.workspaceId!, req.params.id);
  if (!stored) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  const languageCode: string = req.body?.languageCode || stored.targetLanguage;
  if (!projectLanguages(stored).includes(languageCode)) {
    res.status(404).json({ error: `Project is not being dubbed into ${languageCode}` });
    return;
  }
  const storagePath =
    languageCode === stored.targetLanguage
      ? stored.finalDubbedVideoStoragePath
      : stored.languageOutputs?.[languageCode]?.finalDubbedVideoStoragePath;
  if (!storagePath) {
    res.status(400).json({ error: `The ${getLanguageName(languageCode)} dub is not ready yet` });
    return;
  }

  // 16 random bytes: unguessable, so the link itself is the only key to the video.
  const token = randomBytes(16).toString('base64url');
  const now = Date.now();
  const share: StoredShare = {
    uid,
    workspaceId: req.workspaceId!,
    projectId: stored.id,
    languageCode,
    storagePath,
    title: stored.title,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + SHARE_TTL_MS).toISOString(),
  };
  const shareId = shareIdFor(token);
  await sharesCol().doc(shareId).set(share);
  res.status(201).json({ token, shareId, path: `/api/share/${token}`, expiresAt: share.expiresAt });
});

// Live links of a project, so members can see what is out there and turn links off.
shareCreateRouter.get('/:id/shares', async (req, res) => {
  const snap = await sharesCol().where('projectId', '==', req.params.id).get();
  const now = Date.now();
  const shares = snap.docs
    .map((d) => ({ id: d.id, ...(d.data() as StoredShare) }))
    .filter((s) => s.workspaceId === req.workspaceId && !s.revokedAt && new Date(s.expiresAt).getTime() > now)
    .map((s) => ({ id: s.id, languageCode: s.languageCode, createdAt: s.createdAt, expiresAt: s.expiresAt }));
  res.json({ shares });
});

shareCreateRouter.delete('/:id/shares/:shareId', async (req, res) => {
  const ref = sharesCol().doc(req.params.shareId);
  const snap = await ref.get();
  const share = snap.exists ? (snap.data() as StoredShare) : null;
  // Another workspace's link looks exactly like a missing one.
  if (!share || share.workspaceId !== req.workspaceId || share.projectId !== req.params.id) {
    res.status(404).json({ error: 'Share link not found' });
    return;
  }
  if (!share.revokedAt) await ref.update({ revokedAt: new Date().toISOString(), revokedBy: req.uid });
  res.status(204).send();
});

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${escapeHtml(title)}</title>
<style>
:root{--coral:#F05637;--coral-d:#D94B2E;--ink:#0F172A;--muted:#64748B;--bg:#FAFAF7;--line:#E2E8F0}
*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--ink);min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:24px 16px}
header{width:100%;max-width:960px;display:flex;align-items:center;gap:10px;margin-bottom:20px}
.logo{width:34px;height:34px;border-radius:10px;background:var(--coral);color:#fff;display:grid;place-items:center;font-weight:800}
.brand{font-weight:800;font-size:18px}.card{width:100%;max-width:960px;background:#fff;border:1px solid var(--line);border-radius:20px;overflow:hidden;box-shadow:0 20px 60px rgba(15,23,42,.08)}
video{display:block;width:100%;max-height:70vh;background:#000}
.meta{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;padding:18px 20px}
h1{font-size:18px;margin:0 0 4px}.sub{font-size:13px;color:var(--muted)}
.btn{display:inline-flex;align-items:center;gap:8px;background:var(--coral);color:#fff;text-decoration:none;font-weight:600;font-size:14px;padding:11px 18px;border-radius:12px}
.btn:hover{background:var(--coral-d)}.pill{display:inline-block;font-size:12px;font-weight:600;color:var(--coral-d);background:#FFF4F1;border:1px solid #FFC4B3;border-radius:999px;padding:3px 10px;margin-left:6px}
.empty{padding:56px 24px;text-align:center}.empty h1{font-size:22px;margin-bottom:8px}
footer{margin-top:20px;font-size:12px;color:var(--muted)}
</style></head><body><header><div class="logo">D</div><span class="brand">Dubly</span></header>${body}<footer>Shared with Dubly · A ScatterPie product</footer></body></html>`;
}

function expiredPage(res: import('express').Response, status: number, heading: string, text: string) {
  res.status(status).type('html').send(page(heading, `<div class="card empty"><h1>${heading}</h1><p class="sub">${text}</p></div>`));
}

// Mounted without auth: this is what the recipient opens.
export const publicShareRouter = Router();

// The share page is plain server-rendered HTML with inline styles and a video from Cloud Storage; nothing else may load or run.
const SHARE_PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; media-src https://storage.googleapis.com; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

publicShareRouter.get('/:token', rateLimit('share-view', [['ip', rateRules.shareViewPerIp]]), async (req, res) => {
  res.setHeader('Content-Security-Policy', SHARE_PAGE_CSP);
  res.setHeader('Referrer-Policy', 'no-referrer');
  // Links made before tokens were hashed were stored under the raw token; they expire within a day of this change.
  const hashed = await sharesCol().doc(shareIdFor(req.params.token)).get();
  const snap = hashed.exists ? hashed : await sharesCol().doc(req.params.token).get();
  if (!snap.exists) {
    expiredPage(res, 404, 'Link not found', 'This share link does not exist. Ask the sender for a new one.');
    return;
  }
  const share = snap.data() as StoredShare;
  if (share.revokedAt) {
    expiredPage(res, 410, 'This link was turned off', 'The person who shared this video has turned the link off.');
    return;
  }
  const msLeft = new Date(share.expiresAt).getTime() - Date.now();
  if (msLeft <= 0) {
    expiredPage(res, 410, 'This link has expired', 'Shared videos stay available for 24 hours. Ask the sender for a new link.');
    return;
  }

  const file = bucket.file(share.storagePath);
  const [exists] = await file.exists();
  if (!exists) {
    expiredPage(res, 404, 'Video no longer available', 'The owner has removed or re-rendered this video.');
    return;
  }
  // The media URLs die with the share itself, so a copied video URL cannot outlive the 24-hour window.
  const expires = Date.now() + Math.min(msLeft, SHARE_MEDIA_URL_MAX_MS);
  const languageName = getLanguageName(share.languageCode);
  const fileName = `${share.title.replace(/[^\p{L}\p{N}]+/gu, '_')}_${languageName}.mp4`;
  const [streamUrl, downloadUrl] = await Promise.all([signReadUrl(share.storagePath, expires), signReadUrl(share.storagePath, expires, fileName)]);

  const hoursLeft = Math.max(1, Math.round(msLeft / 3_600_000));
  res
    .status(200)
    .type('html')
    .setHeader('Cache-Control', 'no-store')
    .send(
      page(
        `${share.title} · ${languageName} dub`,
        `<div class="card"><video controls playsinline preload="metadata" src="${escapeHtml(streamUrl)}"></video>
<div class="meta"><div><h1>${escapeHtml(share.title)}<span class="pill">${escapeHtml(languageName)}</span></h1>
<div class="sub">This link expires in about ${hoursLeft} hour${hoursLeft === 1 ? '' : 's'}.</div></div>
<a class="btn" href="${escapeHtml(downloadUrl)}">Download video</a></div></div>`
      )
    );
});
