import React, { useEffect, useState } from 'react';
import { Check, Clock, Copy, Loader2, Lock, Pencil, ShieldCheck, Trash2, UserPlus, Users, X } from 'lucide-react';
import { ConfirmDialog } from './ConfirmDialog';
import {
  inviteLink,
  workspaceService,
  type WorkspaceInfo,
  type WorkspaceInvite,
  type WorkspaceMember,
  type WorkspaceRole,
} from '../services/workspaceService';

interface TeamViewProps {
  workspace: WorkspaceInfo;
  onChanged: (workspace: WorkspaceInfo) => void;
  onShowToast: (title: string, desc?: string, type?: 'success' | 'info' | 'error') => void;
  /** The workspace plan, once usage has loaded; a plan without teammates hides the invite form. */
  plan?: { name: string; teamInvites: boolean };
}

const ROLE_INFO: Record<WorkspaceRole, { label: string; desc: string }> = {
  admin: { label: 'Admin', desc: 'Everything, including deleting projects and managing the team' },
  editor: { label: 'Editor', desc: 'Upload, translate, dub, edit and download — cannot delete projects' },
};

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('') || '?';
}

// The team screen: everyone sees who is in the workspace; admins invite people by link, change roles and remove them.
export const TeamView: React.FC<TeamViewProps> = ({ workspace, onChanged, onShowToast, plan }) => {
  const isAdmin = workspace.myRole === 'admin';
  const [form, setForm] = useState({ email: '', role: 'editor' as WorkspaceRole });
  const [isAdding, setIsAdding] = useState(false);
  const [newLink, setNewLink] = useState<{ email: string; link: string } | null>(null);
  const [invites, setInvites] = useState<WorkspaceInvite[]>([]);
  const [busyInviteId, setBusyInviteId] = useState<string | null>(null);
  const [busyUid, setBusyUid] = useState<string | null>(null);
  const [pendingRemove, setPendingRemove] = useState<WorkspaceMember | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(workspace.name);

  const refresh = async () => onChanged(await workspaceService.get());

  const loadInvites = async () => {
    try {
      setInvites(await workspaceService.listInvites());
    } catch {
      // The pending list is informational; members and invite creation still work without it.
    }
  };

  useEffect(() => {
    if (isAdmin) void loadInvites();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, workspace.id]);

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsAdding(true);
    try {
      const { invite, token } = await workspaceService.invite({ email: form.email, role: form.role });
      setNewLink({ email: invite.email, link: inviteLink(token) });
      onShowToast('Invitation Created', `Send the link to ${invite.email}. They join once they open it and accept.`, 'success');
      setForm({ email: '', role: 'editor' });
      await loadInvites();
    } catch (err) {
      onShowToast('Could Not Invite', (err as Error).message, 'error');
    } finally {
      setIsAdding(false);
    }
  };

  const handleRevoke = async (invite: WorkspaceInvite) => {
    setBusyInviteId(invite.id);
    try {
      await workspaceService.revokeInvite(invite.id);
      if (newLink?.email === invite.email) setNewLink(null);
      await loadInvites();
      onShowToast('Invitation Withdrawn', `The link sent to ${invite.email} no longer works.`, 'info');
    } catch (err) {
      onShowToast('Could Not Withdraw', (err as Error).message, 'error');
    } finally {
      setBusyInviteId(null);
    }
  };

  const handleRoleChange = async (member: WorkspaceMember, role: WorkspaceRole) => {
    setBusyUid(member.uid);
    try {
      await workspaceService.changeRole(member.uid, role);
      await refresh();
      onShowToast('Role Updated', `${member.name} is now ${ROLE_INFO[role].label === 'Admin' ? 'an Admin' : 'an Editor'}.`, 'success');
    } catch (err) {
      onShowToast('Could Not Change Role', (err as Error).message, 'error');
    } finally {
      setBusyUid(null);
    }
  };

  const handleRemove = async (member: WorkspaceMember) => {
    setBusyUid(member.uid);
    try {
      await workspaceService.removeMember(member.uid);
      await refresh();
      onShowToast('Member Removed', `${member.name} no longer has access to this workspace.`, 'info');
    } catch (err) {
      onShowToast('Could Not Remove Member', (err as Error).message, 'error');
    } finally {
      setBusyUid(null);
    }
  };

  const handleRename = async () => {
    try {
      onChanged(await workspaceService.rename(nameDraft));
      setEditingName(false);
    } catch (err) {
      onShowToast('Could Not Rename', (err as Error).message, 'error');
    }
  };

  const copyLink = async () => {
    if (!newLink) return;
    await navigator.clipboard.writeText(newLink.link);
    onShowToast('Copied', 'Invitation link copied — send it to your teammate privately.', 'success');
  };

  const inputClass =
    'w-full px-3 py-2.5 rounded-xl bg-white border border-[#E2E8F0] text-sm text-[#0F172A] placeholder-[#94A3B8] focus:outline-none focus:ring-2 focus:ring-[#F05637]/25 focus:border-[#F05637]/60';

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <span className="text-[11px] font-bold uppercase tracking-wider text-[#94A3B8]">Workspace</span>
          {editingName ? (
            <div className="flex items-center gap-2 mt-1">
              <input autoFocus value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} className={`${inputClass} text-lg font-bold`} />
              <button type="button" onClick={handleRename} className="p-2 rounded-lg bg-[#F05637] text-white" aria-label="Save name">
                <Check className="w-4 h-4" />
              </button>
              <button type="button" onClick={() => setEditingName(false)} className="p-2 rounded-lg text-[#64748B] hover:bg-[#F8FAFC]" aria-label="Cancel">
                <X className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <h2 className="text-2xl sm:text-3xl font-extrabold text-[#0F172A] tracking-tight flex items-center gap-2">
              {workspace.name}
              {isAdmin && (
                <button type="button" onClick={() => { setNameDraft(workspace.name); setEditingName(true); }} className="p-1.5 rounded-lg text-[#94A3B8] hover:text-[#0F172A] hover:bg-[#F8FAFC]" aria-label="Rename workspace">
                  <Pencil className="w-4 h-4" />
                </button>
              )}
            </h2>
          )}
          <p className="text-sm text-[#64748B] mt-1">
            {workspace.members.length} member{workspace.members.length === 1 ? '' : 's'} · projects and the monthly dubbing minutes are shared by everyone here
          </p>
        </div>
        <span className="self-start sm:self-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#F05637]/10 border border-[#F05637]/30 text-xs font-semibold text-[#D94B2E]">
          <ShieldCheck className="w-3.5 h-3.5" />
          You are {isAdmin ? 'an Admin' : 'an Editor'}
        </span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6 items-start">
        {/* Members */}
        <div className="lg:col-span-3 rounded-3xl glass-panel overflow-hidden">
          <div className="flex items-center gap-2 px-5 py-4 border-b border-[#E2E8F0]">
            <Users className="w-4 h-4 text-[#F05637]" />
            <h3 className="text-sm font-bold text-[#0F172A]">Members</h3>
          </div>
          <ul className="divide-y divide-[#E2E8F0]">
            {workspace.members.map((m) => {
              const isMe = m.uid === workspace.myUid;
              return (
                <li key={m.uid} className="flex items-center gap-3 px-5 py-3.5">
                  <div className={`w-9 h-9 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${m.role === 'admin' ? 'bg-[#F05637] text-white' : 'bg-[#E2E8F0] text-[#0F172A]'}`}>
                    {initials(m.name)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <span className="text-sm font-semibold text-[#0F172A] block truncate">
                      {m.name}
                      {isMe && <span className="ml-1.5 text-[11px] font-normal text-[#94A3B8]">(you)</span>}
                    </span>
                    <span className="text-xs text-[#64748B] block truncate">{m.email}</span>
                  </div>
                  {isAdmin && !isMe ? (
                    <div className="flex items-center gap-1.5 shrink-0">
                      {busyUid === m.uid && <Loader2 className="w-4 h-4 text-[#94A3B8] animate-spin" />}
                      <select
                        value={m.role}
                        disabled={busyUid === m.uid}
                        onChange={(e) => handleRoleChange(m, e.target.value as WorkspaceRole)}
                        aria-label={`Role for ${m.name}`}
                        className="px-2.5 py-1.5 rounded-lg bg-white border border-[#E2E8F0] text-xs font-semibold text-[#0F172A] focus:outline-none focus:border-[#F05637]/60"
                      >
                        <option value="admin">Admin</option>
                        <option value="editor">Editor</option>
                      </select>
                      <button
                        type="button"
                        onClick={() => setPendingRemove(m)}
                        disabled={busyUid === m.uid}
                        className="p-1.5 rounded-lg text-[#94A3B8] hover:text-rose-600 hover:bg-rose-50"
                        aria-label={`Remove ${m.name}`}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  ) : (
                    <span className={`shrink-0 px-2.5 py-1 rounded-lg text-[11px] font-semibold ${m.role === 'admin' ? 'bg-[#FFF4F1] text-[#D94B2E]' : 'bg-[#F1F5F9] text-[#64748B]'}`}>
                      {ROLE_INFO[m.role].label}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>

        {/* Add member (admins) / role explainer (editors) */}
        <div className="lg:col-span-2 space-y-4">
          {isAdmin && plan && !plan.teamInvites ? (
            <div className="rounded-3xl glass-panel p-5 space-y-2">
              <div className="flex items-center gap-2">
                <Lock className="w-4 h-4 text-[#F05637]" />
                <h3 className="text-sm font-bold text-[#0F172A]">Teammates are on the Enterprise plan</h3>
              </div>
              <p className="text-xs text-[#64748B]">
                This workspace is on the <strong>{plan.name}</strong> plan, which is for one person, so no one can be added to it. Contact ScatterPie to move to Enterprise and invite your team.
              </p>
            </div>
          ) : isAdmin ? (
            <form onSubmit={handleInvite} className="rounded-3xl glass-panel p-5 space-y-3">
              <div className="flex items-center gap-2">
                <UserPlus className="w-4 h-4 text-[#F05637]" />
                <h3 className="text-sm font-bold text-[#0F172A]">Invite a member</h3>
              </div>
              <p className="text-xs text-[#64748B]">
                Creates a private link for this email. They sign in to Dubly with that email, open the link and accept. The link works for 7 days.
              </p>
              <input className={inputClass} type="email" required placeholder="Email (their login ID)" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
              <div className="grid grid-cols-2 gap-2">
                {(['editor', 'admin'] as WorkspaceRole[]).map((role) => (
                  <button
                    key={role}
                    type="button"
                    onClick={() => setForm({ ...form, role })}
                    className={`p-2.5 rounded-xl border text-left transition-colors ${form.role === role ? 'bg-[#F05637]/10 border-[#F05637]' : 'bg-white border-[#E2E8F0] hover:border-[#CBD5E1]'}`}
                  >
                    <span className="text-xs font-bold text-[#0F172A] block">{ROLE_INFO[role].label}</span>
                    <span className="text-[10px] text-[#64748B] leading-snug block mt-0.5">{ROLE_INFO[role].desc}</span>
                  </button>
                ))}
              </div>
              <button
                type="submit"
                disabled={isAdding || !form.email}
                className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl bg-[#F05637] hover:bg-[#D94B2E] text-white text-sm font-semibold shadow-[0_0_20px_rgba(240,86,55,0.3)] disabled:opacity-60"
              >
                {isAdding ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4" />}
                <span>{isAdding ? 'Creating link…' : 'Create invitation link'}</span>
              </button>
            </form>
          ) : (
            <div className="rounded-3xl glass-panel p-5 space-y-2">
              <h3 className="text-sm font-bold text-[#0F172A]">What you can do</h3>
              <p className="text-xs text-[#64748B]">{ROLE_INFO.editor.desc}. Ask an admin if you need a project deleted or someone invited.</p>
            </div>
          )}

          {newLink && (
            <div className="rounded-3xl border border-emerald-200 bg-emerald-50/60 p-5 space-y-3">
              <h3 className="text-sm font-bold text-emerald-800">Invitation link for {newLink.email}</h3>
              <p className="text-xs font-mono text-[#0F172A] break-all">{newLink.link}</p>
              <p className="text-[11px] text-emerald-800/80">This link is shown once. Send it privately; nobody signed in with a different email can use it.</p>
              <div className="flex gap-2">
                <button type="button" onClick={copyLink} className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl bg-white border border-emerald-200 text-xs font-semibold text-emerald-800">
                  <Copy className="w-3.5 h-3.5" /> Copy invitation link
                </button>
                <button type="button" onClick={() => setNewLink(null)} className="px-3 rounded-xl text-xs text-emerald-800/80 hover:bg-white">
                  Done
                </button>
              </div>
            </div>
          )}

          {isAdmin && invites.length > 0 && (
            <div className="rounded-3xl glass-panel overflow-hidden">
              <div className="flex items-center gap-2 px-5 py-4 border-b border-[#E2E8F0]">
                <Clock className="w-4 h-4 text-[#F05637]" />
                <h3 className="text-sm font-bold text-[#0F172A]">Pending invitations</h3>
              </div>
              <ul className="divide-y divide-[#E2E8F0]">
                {invites.map((inv) => (
                  <li key={inv.id} className="flex items-center gap-3 px-5 py-3">
                    <div className="min-w-0 flex-1">
                      <span className="text-sm font-semibold text-[#0F172A] block truncate">{inv.email}</span>
                      <span className="text-xs text-[#64748B] block truncate">
                        {ROLE_INFO[inv.role].label} · expires {new Date(inv.expiresAt).toLocaleDateString()}
                      </span>
                    </div>
                    {busyInviteId === inv.id && <Loader2 className="w-4 h-4 text-[#94A3B8] animate-spin" />}
                    <button
                      type="button"
                      onClick={() => handleRevoke(inv)}
                      disabled={busyInviteId === inv.id}
                      className="p-1.5 rounded-lg text-[#94A3B8] hover:text-rose-600 hover:bg-rose-50"
                      aria-label={`Withdraw invitation for ${inv.email}`}
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>

      <ConfirmDialog
        isOpen={Boolean(pendingRemove)}
        title={`Remove ${pendingRemove?.name ?? 'member'}?`}
        description="They lose access to this workspace and its projects straight away. Their login itself is not deleted, and you can invite them back later."
        confirmLabel="Remove"
        onCancel={() => setPendingRemove(null)}
        onConfirm={() => {
          if (pendingRemove) void handleRemove(pendingRemove);
          setPendingRemove(null);
        }}
      />
    </div>
  );
};
