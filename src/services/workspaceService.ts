import { apiDelete, apiGet, apiPatch, apiPost } from '../lib/apiClient';

export type WorkspaceRole = 'admin' | 'editor';

export interface WorkspaceMember {
  uid: string;
  email: string;
  name: string;
  role: WorkspaceRole;
  addedAt: string;
  addedBy: string;
}

export interface WorkspaceInfo {
  id: string;
  name: string;
  members: WorkspaceMember[];
  myRole: WorkspaceRole;
  myUid: string;
}

export interface WorkspaceInvite {
  id: string;
  email: string;
  role: WorkspaceRole;
  invitedByName: string;
  createdAt: string;
  expiresAt: string;
}

export interface InvitePreview {
  workspaceName: string;
  role: WorkspaceRole;
  invitedByName: string;
  expiresAt: string;
  status: 'pending' | 'accepted';
}

// The link an invitee opens; the token in it is the only copy, the server keeps just its hash.
export const inviteLink = (token: string) => `${window.location.origin}/?invite=${encodeURIComponent(token)}`;

export const workspaceService = {
  get: () => apiGet<WorkspaceInfo>('/api/workspace'),
  rename: (name: string) => apiPatch<WorkspaceInfo>('/api/workspace', { name }),
  listInvites: () => apiGet<{ invites: WorkspaceInvite[] }>('/api/workspace/invites').then((r) => r.invites),
  invite: (input: { email: string; role: WorkspaceRole }) =>
    apiPost<{ invite: WorkspaceInvite; token: string }>('/api/workspace/invites', input),
  revokeInvite: (inviteId: string) => apiDelete(`/api/workspace/invites/${encodeURIComponent(inviteId)}`),
  previewInvite: (token: string) => apiPost<InvitePreview>('/api/invites/preview', { token }),
  acceptInvite: (token: string) => apiPost<{ workspaceId: string; role: WorkspaceRole }>('/api/invites/accept', { token }),
  changeRole: (uid: string, role: WorkspaceRole) => apiPatch<unknown>(`/api/workspace/members/${uid}`, { role }),
  removeMember: (uid: string) => apiDelete(`/api/workspace/members/${uid}`),
};
