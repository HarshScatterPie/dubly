/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { DubbingProject, NavigationTab, ToastMessage, UserPreferences, UserUsageStats } from './types';
import { Sidebar } from './components/Sidebar';
import { Header } from './components/Header';
import { BrandLoader, BrandSplash } from './components/BrandLoader';
import { Dashboard } from './components/Dashboard';
import { ToastContainer } from './components/Toast';
import { Login } from './components/Login';
import { useAuth } from './context/AuthContext';
import { textToSpeechService } from './services/textToSpeechService';
import { projectService } from './services/projectService';
import { apiGet, type ApiError } from './lib/apiClient';
import type { WorkspaceInfo } from './services/workspaceService';
import { hasPendingInvite, InviteAcceptDialog, takeInviteTokenFromUrl } from './components/InviteAcceptDialog';
import { hasLegacyPreferences, settingsService } from './services/settingsService';
import { loadBootData, readBootCache, updateBootCache, writeBootCache, type BootData } from './lib/bootCache';
import { StudioMiniPlayer } from './components/StudioMiniPlayer';
import { forgetStudioProject, recalledStudioProject, rememberStudioProject, type StudioStatus } from './lib/studioSession';
import { projectProgress } from './lib/projectProgress';
import { randomId } from './lib/randomId';
import { allowanceRate, effectiveExtras } from './lib/planMath';
import { DEFAULT_PREFERENCES } from './data/preferences';

takeInviteTokenFromUrl();

// Code-split everything past the landing dashboard: the single bundle these used to share
// with it was 600KB+ and loaded in full before a first paint, even for a user who only ever
// looks at the dashboard. Each of these is its own chunk now, fetched the first time its tab
// is actually opened.
const DubbingStudio = lazy(() =>
  import('./components/DubbingStudio/DubbingStudio').then((m) => ({ default: m.DubbingStudio }))
);
const TextToVoiceStudio = lazy(() =>
  import('./components/TextToVoiceStudio').then((m) => ({ default: m.TextToVoiceStudio }))
);
const VoiceCloneStudio = lazy(() =>
  import('./components/VoiceCloneStudio').then((m) => ({ default: m.VoiceCloneStudio }))
);
const ProjectsHistory = lazy(() =>
  import('./components/ProjectsHistory').then((m) => ({ default: m.ProjectsHistory }))
);
const UsageView = lazy(() => import('./components/UsageView').then((m) => ({ default: m.UsageView })));
const TeamView = lazy(() => import('./components/TeamView').then((m) => ({ default: m.TeamView })));
const GlossaryView = lazy(() => import('./components/GlossaryView').then((m) => ({ default: m.GlossaryView })));
const ProjectWorkspace = lazy(() =>
  import('./components/ProjectWorkspace').then((m) => ({ default: m.ProjectWorkspace }))
);
const SettingsView = lazy(() => import('./components/SettingsView').then((m) => ({ default: m.SettingsView })));

// One dubbing studio at a time. It stays mounted while the user is on other screens, so its work and polling carry on behind the mini player.
interface StudioSession {
  key: string;
  sampleId: string | null;
  redubProject: DubbingProject | null;
  resumeProject: DubbingProject | null;
}

const newStudioSession = (spec: Partial<Omit<StudioSession, 'key'>> = {}): StudioSession => ({
  key: randomId(),
  sampleId: null,
  redubProject: null,
  resumeProject: null,
  ...spec,
});

// How long a first visit (nothing cached) keeps the loading screen up before opening the app and filling it in as data lands.
const BOOT_WAIT_MS = 10_000;

const EMPTY_USAGE: UserUsageStats = {
  minutesDubbed: 0,
  minutesLimit: 50,
  totalProjects: 0,
  storageUsedMb: 0,
  storageLimitMb: 2048,
  languagesUsed: 0,
  wordsTranslated: 0,
  activePlan: 'Starter',
  planId: 'starter',
  paidExtrasAllowed: false,
  extraRates: { aiReview: 0, premiumVoices: 0, paceRetakes: 0 },
  teamInvites: false,
};

export default function App() {
  const { user, loading: authLoading, signOut, primeProfile } = useAuth();
  // True while a visit with nothing cached waits for its startup data behind the loading screen.
  const [booting, setBooting] = useState(false);
  // Set once startup data is in, so tab switches refresh lists only after that and never race it.
  const bootedRef = useRef(false);
  // The workspace an invitation is joining, shown full screen until the new workspace's data is loaded.
  const [joiningWorkspace, setJoiningWorkspace] = useState<string | null>(null);
  // The caller's team and role; `accessError` is set when they were removed from their workspace.
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [workspaceAccessError, setWorkspaceAccessError] = useState<string | null>(null);
  const isAdmin = workspace?.myRole === 'admin';

  const [activeTab, setActiveTab] = useState<NavigationTab>('dashboard');
  const [projects, setProjects] = useState<DubbingProject[]>([]);
  const [activeWorkspaceProject, setActiveWorkspaceProject] = useState<DubbingProject | null>(null);
  const [studioSession, setStudioSession] = useState<StudioSession | null>(null);
  const [studioStatus, setStudioStatus] = useState<StudioStatus | null>(null);
  const studioContainerRef = useRef<HTMLDivElement>(null);
  const rememberedStudioIdRef = useRef<string | null>(null);
  const restoreTriedRef = useRef(false);
  // The user's saved defaults; null until loaded, when every consumer falls back to the built-in defaults.
  const [preferences, setPreferences] = useState<UserPreferences | null>(null);
  const [usage, setUsage] = useState<UserUsageStats>(EMPTY_USAGE);
  // Plan-gated screens wait for the real plan instead of treating the placeholder as Starter.
  const usageLoaded = usage !== EMPTY_USAGE;
  // How much allowance a dubbed minute uses with this user's paid extras, as the server will charge it.
  const extrasRate = allowanceRate(usage.extraRates, effectiveExtras(usageLoaded && usage.paidExtrasAllowed, preferences ?? DEFAULT_PREFERENCES));
  const [isMobileOpen, setIsMobileOpen] = useState<boolean>(false);
  const [isPlayingAudio, setIsPlayingAudio] = useState<boolean>(false);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  // Bumped on every header search so ProjectsHistory remounts (via `key`) even when the
  // term is unchanged from last time — otherwise its own useState would keep the old value.
  const [historySearch, setHistorySearch] = useState<{ term: string; nonce: number }>({ term: '', nonce: 0 });

  const handleHeaderSearch = (query: string) => {
    setHistorySearch((prev) => ({ term: query, nonce: prev.nonce + 1 }));
    setActiveTab('history');
  };

  const showToast = (
    title: string,
    description?: string,
    type: 'success' | 'error' | 'info' | 'warning' = 'info'
  ) => {
    const newToast: ToastMessage = {
      id: `toast-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
      title,
      description,
      type,
      timestamp: Date.now(),
    };
    setToasts((prev) => [...prev, newToast]);

    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== newToast.id));
    }, 4000);
  };

  const lastFetchedAtRef = React.useRef(0);
  const REFRESH_THROTTLE_MS = 15000;

  const refreshProjectsAndUsage = async (force = false) => {
    // Tab-switch triggers this often (dashboard <-> history <-> workspace and back) —
    // without a throttle, flipping between tabs re-reads the whole project list and
    // usage doc from Firestore every time even when nothing could have changed in the
    // last few seconds. Explicit callers (post-upload, post-save) can still force it.
    if (!force && Date.now() - lastFetchedAtRef.current < REFRESH_THROTTLE_MS) return;
    lastFetchedAtRef.current = Date.now();
    try {
      const [proj, usg] = await Promise.all([projectService.list(), apiGet<UserUsageStats>('/api/usage')]);
      setProjects(proj);
      setUsage(usg);
      if (user) updateBootCache(user.uid, { projects: proj, usage: usg });
    } catch (err) {
      showToast('Failed to Load Studio Data', (err as Error).message, 'error');
    }
  };

  // Projects created/completed/failed elsewhere (e.g. a dub finishing, or one that got
  // interrupted) only land in Firestore, not this cached list — re-pull the real state
  // whenever the user looks at a view that's supposed to reflect it (including on first
  // load, since activeTab already defaults to 'dashboard').
  useEffect(() => {
    if (!user || !bootedRef.current) return;
    if (activeTab === 'dashboard' || activeTab === 'history' || activeTab === 'settings') {
      void refreshProjectsAndUsage();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, user]);

  // Startup data in one piece; lastFetchedAtRef keeps the tab-switch refresh from asking again straight away.
  const applyBoot = (data: BootData) => {
    setWorkspace(data.workspace);
    setWorkspaceAccessError(null);
    setPreferences(data.preferences);
    setUsage(data.usage);
    setProjects(data.projects);
    primeProfile(data.profile);
    lastFetchedAtRef.current = Date.now();
    bootedRef.current = true;
  };

  // Opens from this browser's copy when there is one (then refreshes it quietly); otherwise waits for the server behind the loading screen.
  useEffect(() => {
    if (!user) {
      setWorkspace(null);
      setWorkspaceAccessError(null);
      setBooting(false);
      bootedRef.current = false;
      return;
    }
    let cancelled = false;
    const cached = readBootCache(user.uid);
    if (cached) applyBoot(cached);
    else setBooting(true);
    const giveUp = setTimeout(() => {
      if (!cancelled) setBooting(false);
    }, BOOT_WAIT_MS);
    loadBootData()
      .then((data) => {
        if (cancelled) return;
        applyBoot(data);
        writeBootCache(user.uid, data);
        if (hasLegacyPreferences()) settingsService.getPreferences().then(setPreferences).catch(() => undefined);
      })
      .catch((err) => {
        if (cancelled) return;
        bootedRef.current = true;
        if ((err as ApiError).status === 403) setWorkspaceAccessError((err as Error).message);
        else if (!cached) {
          primeProfile(null);
          showToast('Failed to Load Studio Data', (err as Error).message, 'error');
        }
      })
      .finally(() => {
        clearTimeout(giveUp);
        if (!cancelled) setBooting(false);
      });
    return () => {
      cancelled = true;
      clearTimeout(giveUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  useEffect(() => {
    if (!user) {
      // Signed out: nothing of the last account's studio may carry over to the next one.
      setPreferences(null);
      setStudioSession(null);
      setStudioStatus(null);
      rememberedStudioIdRef.current = null;
      restoreTriedRef.current = false;
    }
  }, [user]);

  // Opening the dubbing screen with no studio running starts a fresh one.
  useEffect(() => {
    if (activeTab === 'dubbing' && !studioSession) setStudioSession(newStudioSession());
  }, [activeTab, studioSession]);

  // The studio's own video must not keep playing behind other screens; the mini player shows it instead.
  useEffect(() => {
    if (activeTab !== 'dubbing') studioContainerRef.current?.querySelectorAll('video').forEach((video) => video.pause());
  }, [activeTab]);

  // Remembers the studio's project so a reload or a closed tab can bring it back; starting over or a new dub replaces it.
  useEffect(() => {
    if (!user || !studioStatus) return;
    const id = studioStatus.projectId;
    if (id && id !== rememberedStudioIdRef.current) {
      rememberStudioProject(user.uid, id);
      rememberedStudioIdRef.current = id;
    } else if (!id && rememberedStudioIdRef.current) {
      forgetStudioProject();
      rememberedStudioIdRef.current = null;
    }
  }, [user, studioStatus]);

  // After a reload, unfinished work comes back in the mini player; finished dubs are in History instead.
  useEffect(() => {
    if (!user || !workspace || restoreTriedRef.current) return;
    restoreTriedRef.current = true;
    const id = recalledStudioProject(user.uid);
    if (!id) return;
    projectService
      .get(id)
      .then((project) => {
        const unfinished = project.status !== 'completed' || Boolean(project.activeJobId);
        if (!project.videoUrl || !unfinished) {
          forgetStudioProject();
          return;
        }
        setStudioSession((current) => current ?? newStudioSession({ resumeProject: project }));
      })
      .catch(() => forgetStudioProject());
  }, [user, workspace]);

  const handleCloseStudio = () => {
    setStudioSession(null);
    setStudioStatus(null);
    forgetStudioProject();
    rememberedStudioIdRef.current = null;
    if (activeTab === 'dubbing') setActiveTab('dashboard');
  };

  // A new dub replaces the open one; that project is already saved and any job it started keeps running on the server.
  const openStudio = (spec: Partial<Omit<StudioSession, 'key'>> = {}) => {
    if (studioStatus?.projectId) {
      showToast('Previous Dub Kept', 'Your earlier project is in History, and anything it was running carries on.', 'info');
    }
    setStudioStatus(null);
    setStudioSession(newStudioSession(spec));
    setActiveTab('dubbing');
  };

  // After joining a team through an invitation everything the app holds belongs to the old workspace, so it is all re-read behind the joining screen.
  const handleJoinedWorkspace = async (workspaceName: string) => {
    setActiveWorkspaceProject(null);
    setStudioSession(null);
    setStudioStatus(null);
    forgetStudioProject();
    rememberedStudioIdRef.current = null;
    setActiveTab('dashboard');
    try {
      const data = await loadBootData();
      applyBoot(data);
      if (user) writeBootCache(user.uid, data);
      showToast('Joined Workspace', `You are now working in ${workspaceName}.`, 'success');
    } catch (err) {
      showToast('Joined, but Could Not Load It Yet', (err as Error).message, 'error');
    } finally {
      setJoiningWorkspace(null);
    }
  };

  const joiningScreen = joiningWorkspace && (
    <div className="fixed inset-0 z-[80]">
      <BrandSplash label={`Joining ${joiningWorkspace}…`} />
    </div>
  );

  const handleDismissToast = (id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  };

  const handleStartDubbing = (sampleId?: string) => openStudio({ sampleId: sampleId || null });

  const handleRedubProject = (project: DubbingProject) => openStudio({ redubProject: project });

  const handleSaveProject = async (newProj: DubbingProject) => {
    setProjects((prev) => [newProj, ...prev.filter((p) => p.id !== newProj.id)]);
    try {
      setUsage(await apiGet<UserUsageStats>('/api/usage'));
    } catch {
      // usage widget stays at its previous value until the next successful load
    }
  };

  // Finished projects open in the project workspace; unfinished ones reopen in the studio at the step they reached.
  const handleOpenWorkspace = async (listed: DubbingProject) => {
    if (projectProgress(listed).complete) {
      setActiveWorkspaceProject(listed);
      setActiveTab('workspace');
      return;
    }
    if (studioStatus?.projectId === listed.id) {
      setActiveTab('dubbing');
      return;
    }
    // The list can be minutes old; the project may have moved on since.
    const project = await projectService.get(listed.id).catch(() => listed);
    const progress = projectProgress(project);
    if (progress.complete) {
      setActiveWorkspaceProject(project);
      setActiveTab('workspace');
    } else if (progress.stage === 'no_video') {
      showToast('Nothing Uploaded Yet', 'This project never received its video. Upload one to start the dub.', 'info');
      openStudio();
    } else {
      openStudio({ resumeProject: project });
    }
  };

  // For a project the server just returned: show it, nothing to save.
  const handleProjectRefreshed = (fresh: DubbingProject) => {
    setActiveWorkspaceProject(fresh);
    setProjects((prev) => prev.map((p) => (p.id === fresh.id ? fresh : p)));
  };

  const handleUpdateProject = async (updated: DubbingProject) => {
    setActiveWorkspaceProject(updated);
    setProjects((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
    try {
      const saved = await projectService.patch(updated.id, {
        title: updated.title,
        selectedVoiceId: updated.selectedVoiceId,
        transcriptSegments: updated.transcriptSegments,
        localizedSegments: updated.localizedSegments,
      });
      setActiveWorkspaceProject(saved);
      setProjects((prev) => prev.map((p) => (p.id === saved.id ? saved : p)));
    } catch (err) {
      showToast('Save Failed', (err as Error).message, 'error');
    }
  };

  const handleDeleteProject = async (projectId: string) => {
    setProjects((prev) => prev.filter((p) => p.id !== projectId));
    if (studioStatus?.projectId === projectId) handleCloseStudio();
    if (activeWorkspaceProject?.id === projectId) {
      setActiveWorkspaceProject(null);
      setActiveTab('dashboard');
    }
    try {
      await projectService.delete(projectId);
      showToast('Project Deleted', 'Project removed from your studio workspace.', 'info');
    } catch (err) {
      showToast('Delete Failed', (err as Error).message, 'error');
    }
  };

  const handleSendToDubbingWithAudio = (_script: string, _voiceId: string, sampleVideoId?: string) =>
    openStudio({ sampleId: sampleVideoId || null });

  const handleStopAudio = () => {
    textToSpeechService.stopPlayback();
    setIsPlayingAudio(false);
  };

  if (authLoading) {
    return <BrandSplash />;
  }

  if (!user) {
    return <Login />;
  }

  if (booting) {
    return <BrandSplash label={hasPendingInvite() ? 'Opening your invitation…' : 'Loading your workspace…'} />;
  }

  // Removed from their workspace: nothing else in the app would work, so say so plainly instead of failing every request.
  if (workspaceAccessError) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center px-4">
        <div className="w-full max-w-sm glass-panel rounded-2xl p-8 text-center space-y-4 shadow-lg">
          <h1 className="text-lg font-bold text-foreground">No workspace access</h1>
          <p className="text-sm text-muted-foreground">{workspaceAccessError}</p>
          <button
            type="button"
            onClick={() => void signOut()}
            className="w-full py-2.5 rounded-md bg-coral-500 hover:bg-coral-600 text-white text-sm font-semibold"
          >
            Sign out
          </button>
        </div>
        <ToastContainer toasts={toasts} onDismiss={handleDismissToast} />
        <InviteAcceptDialog
          onJoining={setJoiningWorkspace}
          onJoinFailed={() => setJoiningWorkspace(null)}
          onJoined={handleJoinedWorkspace}
          onShowToast={showToast}
        />
        {joiningScreen}
      </div>
    );
  }

  return (
    <div className="h-screen bg-background text-foreground flex flex-col antialiased selection:bg-coral-500 selection:text-white overflow-hidden">
      {/* Toast Notification Container */}
      <ToastContainer toasts={toasts} onDismiss={handleDismissToast} />
      {workspace && (
        <InviteAcceptDialog
          onJoining={setJoiningWorkspace}
          onJoinFailed={() => setJoiningWorkspace(null)}
          onJoined={handleJoinedWorkspace}
          onShowToast={showToast}
        />
      )}
      {joiningScreen}

      {/* Main Layout Body */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Sidebar Navigation */}
        <Sidebar
          activeTab={activeTab}
          onSelectTab={setActiveTab}
          usage={usage}
          onOpenNewProject={() => handleStartDubbing()}
          isMobileOpen={isMobileOpen}
          onCloseMobile={() => setIsMobileOpen(false)}
        />

        {/* Dynamic Center Stage Viewport */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Top Header */}
          <Header
            activeTab={activeTab}
            onOpenMobileMenu={() => setIsMobileOpen(true)}
            onOpenNewProject={() => handleStartDubbing()}
            onOpenSettings={() => setActiveTab('settings')}
            onSearch={handleHeaderSearch}
            isPlayingAudio={isPlayingAudio}
            onStopAudio={handleStopAudio}
          />

          <main className="flex-1 overflow-y-auto pb-24 md:pb-0">
            {studioSession && (
              <div ref={studioContainerRef} hidden={activeTab !== 'dubbing'}>
                <Suspense
                  fallback={
                    <div className="flex items-center justify-center py-24">
                      <BrandLoader label="Loading…" />
                    </div>
                  }
                >
                  <DubbingStudio
                    key={studioSession.key}
                    initialSampleId={studioSession.sampleId}
                    initialProject={studioSession.redubProject}
                    resumeProject={studioSession.resumeProject}
                    preferences={preferences}
                    onStatusChange={setStudioStatus}
                    onSaveProject={handleSaveProject}
                    onOpenWorkspace={handleOpenWorkspace}
                    onShowToast={showToast}
                  />
                </Suspense>
              </div>
            )}
            <Suspense
              fallback={
                <div className="flex items-center justify-center py-24">
                  <BrandLoader label="Loading…" />
                </div>
              }
            >
            {activeTab === 'dashboard' && (
              <Dashboard
                projects={projects}
                onNavigate={setActiveTab}
                onOpenProject={handleOpenWorkspace}
                onStartWithSample={(sampleId) => handleStartDubbing(sampleId)}
                onDeleteProject={isAdmin ? handleDeleteProject : undefined}
              />
            )}

            {activeTab === 'settings' && (
              <SettingsView
                preferences={preferences}
                onPreferencesSaved={setPreferences}
                workspace={workspace}
                usage={usage}
                usageLoaded={usageLoaded}
                onNavigate={setActiveTab}
                onShowToast={showToast}
              />
            )}

            {activeTab === 'text-to-voice' && (
              <TextToVoiceStudio
                onShowToast={showToast}
                onSendToDubbingWithAudio={handleSendToDubbingWithAudio}
              />
            )}

            {activeTab === 'my-voices' && (
              <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
                <VoiceCloneStudio onShowToast={showToast} />
              </div>
            )}

            {activeTab === 'history' && (
              <ProjectsHistory
                key={historySearch.nonce}
                projects={projects}
                onOpenProject={handleOpenWorkspace}
                onRedubProject={handleRedubProject}
                onDeleteProject={isAdmin ? handleDeleteProject : undefined}
                onNewDub={() => handleStartDubbing()}
                initialSearchTerm={historySearch.term}
              />
            )}

            {activeTab === 'team' && workspace && (
              <TeamView
                workspace={workspace}
                onChanged={setWorkspace}
                onShowToast={showToast}
                plan={usageLoaded ? { name: usage.activePlan, teamInvites: usage.teamInvites } : undefined}
              />
            )}

            {activeTab === 'glossary' && <GlossaryView onShowToast={showToast} />}

            {activeTab === 'usage' && (
              <UsageView
                usage={usage}
                onUpgrade={() => {
                  showToast(
                    'Plan Upgrades Coming Soon',
                    'Billing isn\'t wired up yet — this is a real usage panel, not a real checkout.',
                    'info'
                  );
                }}
              />
            )}

            {activeTab === 'workspace' && (
              activeWorkspaceProject ? (
                <ProjectWorkspace
                  project={activeWorkspaceProject}
                  onBack={() => setActiveTab('dashboard')}
                  onUpdateProject={handleUpdateProject}
                  onProjectRefreshed={handleProjectRefreshed}
                  onShowToast={showToast}
                  allowanceRate={extrasRate}
                />
              ) : (
                <div className="max-w-4xl mx-auto px-4 py-16 text-center space-y-4">
                  <h3 className="text-xl font-bold text-[#0F172A]">No active project opened</h3>
                  <p className="text-xs text-[#64748B]">
                    Select a project from your dashboard or upload a new video to open in timeline.
                  </p>
                  <button
                    type="button"
                    onClick={() => handleStartDubbing()}
                    className="px-5 py-2.5 rounded-xl bg-[#F05637] hover:bg-[#D94B2E] text-white text-xs font-semibold"
                  >
                    Create New Dub
                  </button>
                </div>
              )
            )}
            </Suspense>
          </main>

          <footer className="hidden md:flex items-center justify-center py-1.5 border-t border-[#E2E8F0] bg-[#FAFAF7] shrink-0">
            <p className="text-[10px] text-[#94A3B8]">
              &copy; {new Date().getFullYear()} ScatterPie Analytics Pvt. Ltd. All rights reserved.
            </p>
          </footer>
        </div>
      </div>

      {studioSession && studioStatus && activeTab !== 'dubbing' && (studioStatus.projectId || studioStatus.busy) && (
        <StudioMiniPlayer status={studioStatus} onExpand={() => setActiveTab('dubbing')} onClose={handleCloseStudio} />
      )}
    </div>
  );
}
