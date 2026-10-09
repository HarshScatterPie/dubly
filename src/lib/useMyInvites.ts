import { useCallback, useEffect, useRef, useState } from 'react';
import { workspaceService, type MyInvite } from '../services/workspaceService';

// How often the bell looks for new invitations while the tab is open, and the least time between looks when the tab regains focus.
const POLL_MS = 3 * 60 * 1000;
const FOCUS_THROTTLE_MS = 30 * 1000;

// The invitations waiting for the signed-in person. One small read now and then, never a per-second poll like the studio's job status.
export function useMyInvites(enabled: boolean): { invites: MyInvite[]; refresh: () => Promise<void> } {
  const [invites, setInvites] = useState<MyInvite[]>([]);
  const lastAskedRef = useRef(0);

  const refresh = useCallback(async () => {
    lastAskedRef.current = Date.now();
    try {
      setInvites(await workspaceService.myInvites());
    } catch {
      // A failed look keeps the last list; the bell is a convenience and the emailed link still works.
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      setInvites([]);
      return;
    }
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastAskedRef.current > FOCUS_THROTTLE_MS) void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [enabled, refresh]);

  return { invites, refresh };
}
