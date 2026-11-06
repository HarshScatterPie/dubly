/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string) {
    super(message);
    this.name = 'ApiError';
  }
}

// Broadcast when the server says the signed-in session has ended (401) or the account has lost its workspace (403 NO_WORKSPACE), so the
// app can react wherever the request came from: a removed member is moved out within a second, whichever screen they are on.
export const SESSION_ENDED_EVENT = 'dubly:session-ended';
export const ACCESS_LOST_EVENT = 'dubly:access-lost';

// The session is an httpOnly cookie, so a request needs nothing from script: the browser attaches it to same-origin calls on its own.
const SAME_ORIGIN: RequestInit = { credentials: 'same-origin' };

async function readError(res: Response): Promise<{ message: string; code?: string }> {
  let message = res.statusText;
  let code: string | undefined;
  try {
    const body = await res.json();
    // Errors arrive as { error: { code, message, request_id } }; older servers sent { error: 'message' }.
    const error = body?.error;
    if (typeof error === 'string') message = error;
    else if (error?.message) message = error.request_id && res.status >= 500 ? `${error.message} (ref ${String(error.request_id).slice(0, 8)})` : error.message;
    if (typeof error?.code === 'string') code = error.code;
  } catch {
    // response body wasn't JSON — keep statusText
  }
  return { message, code };
}

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const { message, code } = await readError(res);
    if (res.status === 401) window.dispatchEvent(new Event(SESSION_ENDED_EVENT));
    if (res.status === 403 && (code === 'NO_WORKSPACE' || code === 'AWAITING_INVITE' || code === 'EMAIL_NOT_VERIFIED')) {
      window.dispatchEvent(new CustomEvent(ACCESS_LOST_EVENT, { detail: { code, message } }));
    }
    throw new ApiError(message, res.status, code);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

async function send(path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(path, { ...SAME_ORIGIN, ...init });
  } catch {
    throw new ApiError('Could not reach Dubly. Check your connection and try again.', 0, 'NETWORK');
  }
}

/** For the sign-in screens: no session-ended broadcast (there is no session yet), the same error shape. */
export async function authFetch<T>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await send(path, {
    method: opts.method ?? 'GET',
    headers: opts.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    const { message, code } = await readError(res);
    throw new ApiError(message, res.status, code);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json().catch(() => undefined)) as T;
}

export async function apiGet<T>(path: string): Promise<T> {
  return handle<T>(await send(path, {}));
}

export async function apiPost<T>(path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
  return handle<T>(
    await send(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...extraHeaders },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  );
}

// For the few endpoints used before anyone is signed in (a new invitee setting their first password).
export async function apiPostPublic<T>(path: string, body: unknown): Promise<T> {
  const res = await send(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) {
    const { message, code } = await readError(res);
    throw new ApiError(message, res.status, code);
  }
  return res.json() as Promise<T>;
}

export async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  return handle<T>(await send(path, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
}

export async function apiPut<T>(path: string, body: unknown): Promise<T> {
  return handle<T>(await send(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
}

export async function apiDelete(path: string): Promise<void> {
  await handle<void>(await send(path, { method: 'DELETE' }));
}

export async function apiUpload<T>(path: string, file: File): Promise<T> {
  const form = new FormData();
  form.append('file', file);
  return handle<T>(await send(path, { method: 'POST', body: form }));
}
