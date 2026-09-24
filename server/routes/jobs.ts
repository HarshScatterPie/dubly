import { Router } from '../lib/router';
import { getJob, requestCancel, settleJob, toClientJob, type DubJob } from '../lib/jobs';
import { DUB_CANCELLED_MESSAGE } from './dub';

// A project's jobs (dubs and transcriptions). Mounted behind requireAuth + requireWorkspace.
export const jobsRouter = Router();

// Another workspace's (or project's) job looks exactly like a missing one.
async function jobOf(workspaceId: string, projectId: string, jobId: string): Promise<DubJob | null> {
  const job = await getJob(jobId);
  return job && job.workspaceId === workspaceId && job.projectId === projectId ? job : null;
}

jobsRouter.get('/:id/jobs/:jobId', async (req, res) => {
  const job = await jobOf(req.workspaceId!, req.params.id, req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(toClientJob(job));
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
