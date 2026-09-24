import { AsyncLocalStorage } from 'node:async_hooks';
import { format } from 'node:util';

/**
 * Structured logging. Every line is one JSON object on stdout/stderr carrying `severity`, `message` and the correlation ids
 * of whatever request or job produced it, which Cloud Logging (and any log shipper) indexes without parsing.
 * Log-based metrics are built on the `event` field; the catalogue is in docs/RUNBOOK.md.
 */
export interface LogContext {
  requestId?: string;
  userId?: string;
  workspaceId?: string;
  jobId?: string;
  projectId?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

// Runs `fn` with these ids attached to every log line written inside it, including from deep library code.
export function withLogContext<T>(context: LogContext, fn: () => T): T {
  return storage.run({ ...storage.getStore(), ...context }, fn);
}

// Adds ids to the current context once they become known (e.g. the user after authentication).
export function addLogContext(fields: LogContext): void {
  const store = storage.getStore();
  if (store) Object.assign(store, fields);
}

// Credentials that must never reach a log line, whatever code tried to print them.
const SECRET_PATTERNS: [RegExp, string][] = [
  [/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [redacted]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '[jwt-redacted]'],
  [/\bhf_[A-Za-z0-9]{10,}/g, '[hf-token-redacted]'],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, '[api-key-redacted]'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[private-key-redacted]'],
  [/(\/api\/share\/)[A-Za-z0-9_-]{8,}/g, '$1[redacted]'],
  [/([?&](?:X-Goog-Signature|Signature|token|access_token)=)[^&\s"']+/gi, '$1[redacted]'],
  [/("?(?:password|idToken|refreshToken|private_key|api_key|apiKey)"?\s*[:=]\s*)"[^"]*"/gi, '$1"[redacted]"'],
];

export function redact(text: string): string {
  return SECRET_PATTERNS.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text);
}

type Severity = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR';

function describeError(err: unknown): Record<string, unknown> | undefined {
  if (!(err instanceof Error)) return undefined;
  return { errorName: err.name, errorMessage: redact(err.message), stack: redact(err.stack || '') };
}

let json = process.env.LOG_FORMAT === 'json' || (process.env.LOG_FORMAT !== 'text' && process.env.NODE_ENV === 'production');

export function setJsonLogging(enabled: boolean): void {
  json = enabled;
}

export function write(severity: Severity, message: string, fields: Record<string, unknown> = {}): void {
  const stream = severity === 'ERROR' || severity === 'WARNING' ? process.stderr : process.stdout;
  const safeMessage = redact(message);
  if (!json) {
    const extra = Object.keys(fields).length ? ` ${redact(JSON.stringify(fields))}` : '';
    stream.write(`${safeMessage}${extra}\n`);
    return;
  }
  const entry = { timestamp: new Date().toISOString(), severity, message: safeMessage, ...storage.getStore(), ...fields };
  stream.write(`${redact(JSON.stringify(entry))}\n`);
}

// Named events with fields: the stable interface metrics and alerts are built on.
export const log = {
  info: (event: string, fields: Record<string, unknown> = {}, message = event) => write('INFO', message, { event, ...fields }),
  warn: (event: string, fields: Record<string, unknown> = {}, message = event) => write('WARNING', message, { event, ...fields }),
  error: (event: string, err: unknown, fields: Record<string, unknown> = {}, message = event) =>
    write('ERROR', message, { event, ...fields, ...describeError(err) }),
};

/**
 * Routes the existing console.* calls through the structured writer, so the many `[module] …` lines across the server gain
 * severity, correlation ids and redaction without rewriting each one. Installed once at startup (server/index.ts).
 */
export function installStructuredConsole(): void {
  const route = (severity: Severity) => (...args: unknown[]) => {
    const err = args.find((a) => a instanceof Error);
    write(severity, format(...args.map((a) => (a instanceof Error ? a.message : a))), err ? describeError(err) : {});
  };
  console.log = route('INFO');
  console.info = route('INFO');
  console.warn = route('WARNING');
  console.error = route('ERROR');
}
