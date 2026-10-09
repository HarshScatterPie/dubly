/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { auth } from './firebase';

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

async function authHeader(): Promise<Record<string, string>> {
  const user = auth.currentUser;
  if (!user) throw new ApiError('Not signed in', 401);
  const token = await user.getIdToken();
  return { Authorization: `Bearer ${token}` };
}

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
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
    // Only for calls that carried a session: the sign-in screen's own requests never reach here.
    if (res.status === 401 && auth.currentUser) window.dispatchEvent(new Event(SESSION_ENDED_EVENT));
    if (res.status === 403 && (code === 'NO_WORKSPACE' || code === 'AWAITING_INVITE')) {
      window.dispatchEvent(new CustomEvent(ACCESS_LOST_EVENT, { detail: { code, message } }));
    }
    throw new ApiError(message, res.status, code);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: await authHeader() });
  return handle<T>(res);
}

export async function apiPost<T>(path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { ...(await authHeader()), 'Content-Type': 'application/json', ...extraHeaders },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return handle<T>(res);
}

// For the few endpoints used before anyone is signed in (a new invitee setting their first password).
export async function apiPostPublic<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return handle<T>(res);
}

export async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'PATCH',
    headers: { ...(await authHeader()), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return handle<T>(res);
}

export async function apiPut<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'PUT',
    headers: { ...(await authHeader()), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return handle<T>(res);
}

export async function apiDelete(path: string): Promise<void> {
  const res = await fetch(path, { method: 'DELETE', headers: await authHeader() });
  await handle<void>(res);
}

export async function apiUpload<T>(path: string, file: File): Promise<T> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(path, { method: 'POST', headers: await authHeader(), body: form });
  return handle<T>(res);
}
