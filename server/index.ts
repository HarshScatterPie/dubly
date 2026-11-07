import cluster from 'node:cluster';
// First, so server/.env is loaded before the limits read it.
import './lib/env';
import { limits } from './lib/limits';

// One process serves on its own; with several, this one only supervises them, and they share the port.
if (cluster.isPrimary && limits.processCount > 1) await import('./primary');
else await import('./worker');
