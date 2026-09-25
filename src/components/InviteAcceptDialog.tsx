import React, { useEffect, useState } from 'react';
import { Loader2, UserPlus } from 'lucide-react';
import { workspaceService, type InvitePreview } from '../services/workspaceService';

const STORAGE_KEY = 'dubly.pendingInvite';

// Pulls ?invite=… off the URL once and keeps it for the session, so it survives the sign-in screen.
export function takeInviteTokenFromUrl(): void {
  try {
    const url = new URL(window.location.href);
    const token = url.searchParams.get('invite');
    if (!token) return;
    sessionStorage.setItem(STORAGE_KEY, token);
    url.searchParams.delete('invite');
    window.history.replaceState(null, '', url.pathname + (url.search ? url.search : '') + url.hash);
  } catch {
    // No URL or storage access: the link simply has to be opened again.
  }
}

// Whether this visit came through an invitation link that has not been used yet.
export function hasPendingInvite(): boolean {
  return Boolean(readToken());
}

function readToken(): string | null {
  try {
    return sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function clearToken(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing stored, nothing to clear.
  }
}

interface InviteAcceptDialogProps {
  // Called as the join starts, so the app can cover everything with a joining screen until the new workspace is loaded.
  onJoining?: (workspaceName: string) => void;
  onJoinFailed?: () => void;
  onJoined: (workspaceName: string) => void;
  onShowToast: (title: string, desc?: string, type?: 'success' | 'info' | 'error') => void;
}

// Shown after sign-in when the user arrived through an invitation link; nothing changes until they press Join.
export const InviteAcceptDialog: React.FC<InviteAcceptDialogProps> = ({ onJoining, onJoinFailed, onJoined, onShowToast }) => {
  const [token] = useState(readToken);
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [isJoining, setIsJoining] = useState(false);

  useEffect(() => {
    if (!token) return;
    workspaceService
      .previewInvite(token)
      .then((p) => {
        if (p.status === 'accepted') {
          clearToken();
          return;
        }
        setPreview(p);
      })
      .catch((err) => {
        clearToken();
        onShowToast('Invitation Not Available', (err as Error).message, 'error');
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  if (!token || !preview) return null;

  const dismiss = () => {
    clearToken();
    setPreview(null);
  };

  const join = async () => {
    const workspaceName = preview.workspaceName;
    setIsJoining(true);
    onJoining?.(workspaceName);
    try {
      await workspaceService.acceptInvite(token);
      clearToken();
      setPreview(null);
      onJoined(workspaceName);
    } catch (err) {
      onJoinFailed?.();
      onShowToast('Could Not Join', (err as Error).message, 'error');
    } finally {
      setIsJoining(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="invite-dialog-title"
        className="glass-panel rounded-2xl max-w-sm w-full p-6 shadow-2xl animate-fade-in space-y-4"
      >
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-xl bg-[#FFF4F1] border border-[#FFC4B3] text-[#D94B2E] flex items-center justify-center shrink-0">
            <UserPlus className="w-4.5 h-4.5" />
          </div>
          <div className="min-w-0">
            <h3 id="invite-dialog-title" className="text-sm font-bold text-[#0F172A] tracking-tight">
              Join {preview.workspaceName}?
            </h3>
            <p className="text-xs text-[#64748B] mt-1 leading-relaxed">
              {preview.invitedByName} invited you as {preview.role === 'admin' ? 'an Admin' : 'an Editor'}. You will work in this
              team&apos;s workspace. Projects in your current workspace stay there, and you return to them if you leave the team.
            </p>
          </div>
        </div>
        <div className="flex items-center justify-end gap-3 pt-1">
          <button
            type="button"
            onClick={dismiss}
            disabled={isJoining}
            className="px-4 py-2 rounded-xl text-xs font-semibold text-[#64748B] hover:text-[#0F172A] hover:bg-[#F8FAFC] transition-colors"
          >
            Not now
          </button>
          <button
            type="button"
            onClick={join}
            disabled={isJoining}
            className="px-4 py-2 rounded-xl bg-[#F05637] hover:bg-[#D94B2E] text-white text-xs font-semibold shadow-md transition-colors flex items-center gap-1.5 disabled:opacity-60"
          >
            {isJoining && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            Join workspace
          </button>
        </div>
      </div>
    </div>
  );
};
