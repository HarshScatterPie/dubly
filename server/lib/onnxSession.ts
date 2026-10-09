import * as ort from 'onnxruntime-node';

// One inference thread per session: these models are small, and ONNX Runtime's default (a thread per core, spinning while idle)
// takes CPU from ffmpeg and the API on a 2 vCPU machine. Parallelism comes from the worker pool instead (see onnxPool.ts).
const CPU_SESSION_OPTIONS: ort.InferenceSession.SessionOptions = {
  intraOpNumThreads: 1,
  interOpNumThreads: 1,
  executionMode: 'sequential',
  graphOptimizationLevel: 'all',
};

export function createCpuSession(modelPath: string): Promise<ort.InferenceSession> {
  return ort.InferenceSession.create(modelPath, CPU_SESSION_OPTIONS);
}
