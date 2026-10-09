import React, { useEffect, useRef, useState } from 'react';
import { Bell, Loader2, UserPlus } from 'lucide-react';
import type { MyInvite } from '../services/workspaceService';

interface InviteCardProps {
  invite: MyInvite;
  joining: boolean;
  // Another join is running; only one workspace can be joined at a time.
  disabled: boolean;
  onJoin: (invite: MyInvite) => void;
}

const roleLabel = (role: MyInvite['role']) => (role === 'admin' ? 'an Admin' : 'an Editor');

// One invitation with its Join button: the same card in the notification bell and on the "join your workspace" screen.
export const InviteCard: React.FC<InviteCardProps> = ({ invite, joining, disabled, onJoin }) => (
  <div className="p-3.5 rounded-2xl border border-[#FFC4B3] bg-[#FFF4F1]/60 space-y-3">
    <div className="flex items-start gap-3">
      <div className="w-9 h-9 rounded-xl bg-white border border-[#FFC4B3] text-[#D94B2E] flex items-center justify-center shrink-0">
        <UserPlus className="w-4 h-4" />
      </div>
      <div className="min-w-0">
        <p className="text-sm font-semibold text-[#0F172A] leading-snug">
          {invite.invitedByName} invited you to join <span className="text-[#D94B2E]">{invite.workspaceName}</span>
        </p>
        <p className="text-xs text-[#64748B] mt-0.5">
          As {roleLabel(invite.role)} · valid until {new Date(invite.expiresAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}
        </p>
      </div>
    </div>
    <button
      type="button"
      onClick={() => onJoin(invite)}
      disabled={disabled || joining}
      className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl bg-[#F05637] hover:bg-[#D94B2E] text-white text-xs font-semibold shadow-md transition-colors disabled:opacity-60"
    >
      {joining && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
      Join workspace
    </button>
  </div>
);

interface NotificationBellProps {
  invites: MyInvite[];
  joiningInviteId: string | null;
  onJoin: (invite: MyInvite) => void;
}

// The header bell: pending workspace invitations, each with a Join workspace button.
export const NotificationBell: React.FC<NotificationBellProps> = ({ invites, joiningInviteId, onJoin }) => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={invites.length ? `Notifications, ${invites.length} new` : 'Notifications'}
        aria-expanded={open}
        className="relative p-2 rounded-md text-slate-500 hover:text-foreground hover:bg-slate-100 transition-colors"
      >
        <Bell className="w-4 h-4" />
        {invites.length > 0 && (
          <span className="absolute top-0.5 right-0.5 min-w-4 h-4 px-1 rounded-full bg-[#F05637] text-white text-[10px] font-bold flex items-center justify-center leading-none">
            {invites.length}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Notifications"
          className="absolute right-0 mt-2 w-[min(22rem,calc(100vw-2rem))] rounded-2xl bg-white border border-[#E2E8F0] shadow-[0_20px_60px_rgba(15,23,42,0.18)] z-50 animate-fade-in"
        >
          <div className="px-4 py-3 border-b border-[#E2E8F0]">
            <h3 className="text-sm font-bold text-[#0F172A]">Notifications</h3>
          </div>
          <div className="p-3 space-y-3 max-h-[70vh] overflow-y-auto">
            {invites.length === 0 ? (
              <div className="py-8 text-center space-y-1.5">
                <Bell className="w-5 h-5 mx-auto text-[#CBD5E1]" />
                <p className="text-sm font-semibold text-[#0F172A]">You&apos;re all caught up</p>
                <p className="text-xs text-[#64748B]">Workspace invitations show up here.</p>
              </div>
            ) : (
              <>
                {invites.map((invite) => (
                  <InviteCard key={invite.id} invite={invite} joining={joiningInviteId === invite.id} disabled={joiningInviteId !== null} onJoin={onJoin} />
                ))}
                <p className="text-[11px] text-[#94A3B8] px-1">Joining switches you to that team&apos;s workspace. Projects in your current workspace are not moved.</p>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
