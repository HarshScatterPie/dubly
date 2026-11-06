import { Router } from '../lib/router';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Response } from 'express';
import { col } from '../lib/mongo';
import { fileExists, signReadUrl } from '../lib/mediaStore';
import { getStoredProject, projectLanguages, segmentsForLanguage } from '../lib/projectRepo';
import { toVtt, type CaptionLine } from '../../src/lib/captionCues';
import { getLanguageName } from '../lib/languageMeta';
import { rateLimit } from '../lib/rateLimit';
import { rateRules } from '../lib/limits';
import { serverRoot } from '../lib/paths';
import { schemas, validateBody } from '../lib/validation';
import { renderMessagePage, renderSharePage, shareCsp } from '../lib/sharePage';

// Public share links for a finished dub: anyone with the link can watch and download it for 24 hours, then it is dead.
const SHARE_TTL_MS = 24 * 60 * 60 * 1000;
// Media URLs on the share page live at most this long, so turning a link off also stops its copied video URL soon after.
const SHARE_MEDIA_URL_MAX_MS = 2 * 60 * 60 * 1000;
const sharesCol = () => col<StoredShare & { _id: string }>('shares');
// Like invitations, a share is stored under the token's hash: the link is the only copy of the token.
export const shareIdFor = (token: string) => createHash('sha256').update(token).digest('hex');

interface StoredShare {
  uid: string;
  workspaceId?: string;
  projectId: string;
  languageCode: string;
  storagePath: string;
  title: string;
  // Whether the page carries the dub's captions (with a CC switch). Links made before this existed have none recorded and keep theirs.
  captions?: boolean;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
  revokedBy?: string;
}

// Removes every share of a project, e.g. when the project itself is deleted.
export async function deleteSharesForProject(projectId: string): Promise<void> {
  await sharesCol().deleteMany({ projectId });
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
  const captions = req.body?.captions !== false;
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
    captions,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + SHARE_TTL_MS).toISOString(),
  };
  const shareId = shareIdFor(token);
  await sharesCol().insertOne({ _id: shareId, ...share });
  res.status(201).json({ token, shareId, path: `/api/share/${token}`, expiresAt: share.expiresAt, captions });
});

// Live links of a project, so members can see what is out there and turn links off.
shareCreateRouter.get('/:id/shares', async (req, res) => {
  const docs = await sharesCol().find({ projectId: req.params.id, workspaceId: req.workspaceId }).toArray();
  const now = Date.now();
  const shares = docs
    .map(({ _id, ...share }) => ({ id: _id, ...share }))
    .filter((s) => s.workspaceId === req.workspaceId && !s.revokedAt && new Date(s.expiresAt).getTime() > now)
    .map((s) => ({ id: s.id, languageCode: s.languageCode, captions: s.captions !== false, createdAt: s.createdAt, expiresAt: s.expiresAt }));
  res.json({ shares });
});

shareCreateRouter.delete('/:id/shares/:shareId', async (req, res) => {
  const share = await sharesCol().findOne({ _id: req.params.shareId });
  // Another workspace's link looks exactly like a missing one.
  if (!share || share.workspaceId !== req.workspaceId || share.projectId !== req.params.id) {
    res.status(404).json({ error: 'Share link not found' });
    return;
  }
  if (!share.revokedAt) await sharesCol().updateOne({ _id: req.params.shareId }, { $set: { revokedAt: new Date().toISOString(), revokedBy: req.uid } });
  res.status(204).send();
});

// Mounted without auth: this is what the recipient opens.
export const publicShareRouter = Router();

// Only ever by the token's hash: a share's id is not secret (members list it, and it appears in request logs), so it must not open the link.
// Links stored under their raw token, from before hashing (2026-09-24), all expired within a day.
async function findShare(token: string): Promise<{ id: string; share: StoredShare | null }> {
  const id = shareIdFor(token);
  return { id, share: await sharesCol().findOne({ _id: id }, { projection: { _id: 0 } }) };
}

// The page carries the dub's captions inline, read from the database; a burst of viewers of one link shares a single read for a few minutes.
const CAPTION_LINES_TTL_MS = 5 * 60 * 1000;
const captionLinesCache = new Map<string, { lines: CaptionLine[]; at: number }>();

async function captionLinesFor(shareId: string, share: StoredShare): Promise<CaptionLine[]> {
  const hit = captionLinesCache.get(shareId);
  if (hit && Date.now() - hit.at < CAPTION_LINES_TTL_MS) return hit.lines;
  const stored = share.workspaceId ? await getStoredProject(share.workspaceId, share.projectId) : null;
  const lines = stored ? segmentsForLanguage(stored, share.languageCode).filter((s) => s.translatedText.trim()) : [];
  if (captionLinesCache.size > 200) captionLinesCache.clear();
  captionLinesCache.set(shareId, { lines, at: Date.now() });
  return lines;
}

// The ScatterPie logo on the page, served from here so the page needs nothing from any other site.
let logoPng: Buffer | null = null;
// Public like the page, so limited by address like it, in a bucket of its own so loading the logo never uses up page views.
publicShareRouter.get('/_assets/scatterpie-logo.png', rateLimit('share-asset', [['ip', rateRules.shareViewPerIp]]), async (_req, res) => {
  logoPng ??= await readFile(path.join(serverRoot, 'assets', 'scatterpie-logo.png'));
  res.status(200).type('png').setHeader('Cache-Control', 'public, max-age=86400').send(logoPng);
});

// The dub's captions as a WebVTT file; the page itself carries them inline. They die with the link, and with the captions switch.
publicShareRouter.get('/:token/captions.vtt', rateLimit('share-view', [['ip', rateRules.shareViewPerIp]]), async (req, res) => {
  const { id: shareId, share } = await findShare(req.params.token);
  if (!share || share.revokedAt || share.captions === false || new Date(share.expiresAt).getTime() <= Date.now() || !share.workspaceId) {
    res.status(404).type('text/plain').send('Not found');
    return;
  }
  const lines = await captionLinesFor(shareId, share);
  res.status(200).type('text/vtt').setHeader('Cache-Control', 'no-store').send(toVtt(lines, share.title));
});

function messagePage(res: Response, status: number, heading: string, text: string) {
  res.status(status).type('html').setHeader('Cache-Control', 'no-store').send(renderMessagePage(heading, text));
}

publicShareRouter.get('/:token', rateLimit('share-view', [['ip', rateRules.shareViewPerIp]]), async (req, res) => {
  // Nothing may run on the error pages; the player page swaps in a policy with its own nonce below.
  res.setHeader('Content-Security-Policy', shareCsp());
  res.setHeader('Referrer-Policy', 'no-referrer');
  const { id: shareId, share } = await findShare(req.params.token);
  if (!share) {
    messagePage(res, 404, 'Link not found', 'This share link does not exist. Ask the sender for a new one.');
    return;
  }
  if (share.revokedAt) {
    messagePage(res, 410, 'This link was turned off', 'The person who shared this video has turned the link off.');
    return;
  }
  const msLeft = new Date(share.expiresAt).getTime() - Date.now();
  if (msLeft <= 0) {
    messagePage(res, 410, 'This link has expired', 'Shared videos stay available for 24 hours. Ask the sender for a new link.');
    return;
  }

  if (!(await fileExists(share.storagePath))) {
    messagePage(res, 404, 'Video no longer available', 'The owner has removed or re-rendered this video.');
    return;
  }
  // The media URLs die with the share itself, so a copied video URL cannot outlive the 24-hour window.
  const expires = Date.now() + Math.min(msLeft, SHARE_MEDIA_URL_MAX_MS);
  const languageName = getLanguageName(share.languageCode);
  const fileName = `${share.title.replace(/[^\p{L}\p{N}]+/gu, '_')}_${languageName}.mp4`;
  const [streamUrl, downloadUrl, captions] = await Promise.all([
    signReadUrl(share.storagePath, expires),
    signReadUrl(share.storagePath, expires, fileName),
    share.captions === false ? Promise.resolve(null) : captionLinesFor(shareId, share),
  ]);

  const nonce = randomBytes(16).toString('base64');
  res.setHeader('Content-Security-Policy', shareCsp(nonce));
  res
    .status(200)
    .type('html')
    .setHeader('Cache-Control', 'no-store')
    .send(
      renderSharePage({
        title: share.title,
        languageName,
        streamUrl,
        downloadUrl,
        hoursLeft: Math.max(1, Math.round(msLeft / 3_600_000)),
        captions,
        nonce,
      })
    );
});
