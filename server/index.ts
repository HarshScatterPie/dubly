import cluster from 'node:cluster';
// First, so server/.env is loaded before the limits read it.
import './lib/env';
import { limits } from './lib/limits';

// One process serves on its own; when there may be several (a fixed number above one, or scaling with the load), this one only
// supervises them, and they share the port.
if (cluster.isPrimary && limits.maxProcesses > 1) await import('./primary');
else await import('./worker');
