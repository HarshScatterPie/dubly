// Worker threads do not inherit the TypeScript loader the server starts with (`node --import tsx`), so this plain-JS stub brings its own
// and then loads the real entry point. See onnxPool.ts for what the workers are for.
import { tsImport } from 'tsx/esm/api';

await tsImport('./onnxWorker.ts', import.meta.url);
