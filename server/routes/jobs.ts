import { Router } from '../lib/router';
import { getJob, requestCancel, settleJob, toClientJob, type DubJob } from '../lib/jobs';
import { revisionOf, waitForChange } from '../lib/changeWait';
import { getProjectProgress } from '../lib/projectRepo';
import { DUB_CANCELLED_MESSAGE } from './dub';

// A project's jobs (dubs and transcriptions). Mounted behind requireAuth + requireWorkspace.
export const jobsRouter = Router();

// Another workspace's (or project's) job looks exactly like a missing one.
async function jobOf(workspaceId: string, projectId: string, jobId: string): Promise<DubJob | null> {
  const job = await getJob(jobId);
  return job && job.workspaceId === workspaceId && job.projectId === projectId ? job : null;
}

// The job with what its project shows the user, so following a job takes one request and not two. With ?since=<revision> the answer
// waits until there is something new (see changeWait.ts).
async function jobWithProgress(workspaceId: string, projectId: string, jobId: string) {
  const job = await jobOf(workspaceId, projectId, jobId);
  if (!job) return null;
  const progress = await getProjectProgress(workspaceId, projectId);
  const view = { ...toClientJob(job), progressPercent: progress?.progressPercent ?? 0, progressMessage: progress?.currentProcessingMessage ?? null };
  return { ...view, revision: revisionOf(view.status, view.stage, view.progress, view.progressPercent, view.progressMessage) };
}

jobsRouter.get('/:id/jobs/:jobId', async (req, res) => {
  const job = await waitForChange(
    {
      read: () => jobWithProgress(req.workspaceId!, req.params.id, req.params.jobId),
      revision: (view) => view.revision,
      isFinal: (view) => view.settled,
      since: typeof req.query.since === 'string' ? req.query.since : '',
    },
    (stop) => res.once('close', stop)
  );
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// Cancels a job: a queued dub is settled at once with a full refund, a running job stops at its next step, a finished one is reported as is.
jobsRouter.post('/:id/jobs/:jobId/cancel', async (req, res) => {
  const job = await jobOf(req.workspaceId!, req.params.id, req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (!job.settled && (await requestCancel(job.id, 'user')) && job.status === 'queued') {
    await settleJob(job.id, {
      status: 'cancelled',
      refundMinutes: job.minutesReserved,
      errorCode: 'CANCELLED',
      errorMessage: 'Cancelled while queued',
      userMessage: DUB_CANCELLED_MESSAGE,
      projectPatch: { status: 'failed', currentProcessingMessage: DUB_CANCELLED_MESSAGE },
    });
  }
  res.status(202).json(toClientJob((await getJob(job.id))!));
});
