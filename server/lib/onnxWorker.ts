import { parentPort } from 'node:worker_threads';
import { sampleFacesLocal } from './faceScan';
import { detectSpeechRegionsVadLocal } from './vad';
import type { OffThreadTask } from './onnxPool';

// Entry point of the worker threads started by onnxPool.ts: runs one task at a time, in the order they arrive.
if (!parentPort) throw new Error('onnxWorker.ts must run as a worker thread');
const port = parentPort;

const handlers: Record<OffThreadTask, (args: never) => Promise<unknown>> = {
  faceScan: (args: { video: string; durationSeconds: number; deadline: number }) => sampleFacesLocal(args.video, args.durationSeconds, args.deadline),
  vad: (args: { audioPath: string; totalDuration: number }) => detectSpeechRegionsVadLocal(args.audioPath, args.totalDuration),
};

port.on('message', async (message: { id: number; task: OffThreadTask; args: never }) => {
  try {
    port.postMessage({ id: message.id, result: await handlers[message.task](message.args) });
  } catch (err) {
    port.postMessage({ id: message.id, error: err instanceof Error ? err.message : String(err) });
  }
});
