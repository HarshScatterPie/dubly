/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { DubbingProject, NavigationTab, ToastMessage, UserUsageStats } from './types';
import { Sidebar } from './components/Sidebar';
import { Header } from './components/Header';
import { WaveLoader } from './components/WaveLoader';
import { Dashboard } from './components/Dashboard';
import { DubbingStudio } from './components/DubbingStudio/DubbingStudio';
import { TextToVoiceStudio } from './components/TextToVoiceStudio';
import { VoiceCloneStudio } from './components/VoiceCloneStudio';
import { ProjectsHistory } from './components/ProjectsHistory';
import { UsageView } from './components/UsageView';
import { ProjectWorkspace } from './components/ProjectWorkspace';
import { SettingsModal } from './components/SettingsModal';
import { ToastContainer } from './components/Toast';
import { Login } from './components/Login';
import { useAuth } from './context/AuthContext';
import { textToSpeechService } from './services/textToSpeechService';
import { projectService } from './services/projectService';
import { apiGet } from './lib/apiClient';

const EMPTY_USAGE: UserUsageStats = {
  minutesDubbed: 0,
  minutesLimit: 120,
  totalProjects: 0,
  storageUsedMb: 0,
  storageLimitMb: 2048,
  languagesUsed: 0,
  wordsTranslated: 0,
  activePlan: 'Starter',
};

export default function App() {
  const { user, loading: authLoading } = useAuth();

  const [activeTab, setActiveTab] = useState<NavigationTab>('dashboard');
  const [projects, setProjects] = useState<DubbingProject[]>([]);
  const [activeWorkspaceProject, setActiveWorkspaceProject] = useState<DubbingProject | null>(null);
  const [initialDubSampleId, setInitialDubSampleId] = useState<string | null>(null);
  const [usage, setUsage] = useState<UserUsageStats>(EMPTY_USAGE);
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false);
  const [isMobileOpen, setIsMobileOpen] = useState<boolean>(false);
  const [isPlayingAudio, setIsPlayingAudio] = useState<boolean>(false);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

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
    } catch (err) {
      showToast('Failed to Load Studio Data', (err as Error).message, 'error');
    }
  };

  // Projects created/completed/failed elsewhere (e.g. a dub finishing, or one that got
  // interrupted) only land in Firestore, not this cached list — re-pull the real state
  // whenever the user looks at a view that's supposed to reflect it (including on first
  // load, since activeTab already defaults to 'dashboard').
  useEffect(() => {
    if (!user) return;
    if (activeTab === 'dashboard' || activeTab === 'history') {
      void refreshProjectsAndUsage();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, user]);

  const handleDismissToast = (id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  };

  const handleStartDubbing = (sampleId?: string) => {
    setInitialDubSampleId(sampleId || null);
    setActiveTab('dubbing');
  };

  const handleSaveProject = async (newProj: DubbingProject) => {
    setProjects((prev) => [newProj, ...prev.filter((p) => p.id !== newProj.id)]);
    try {
      setUsage(await apiGet<UserUsageStats>('/api/usage'));
    } catch {
      // usage widget stays at its previous value until the next successful load
    }
  };

  const handleOpenWorkspace = (project: DubbingProject) => {
    setActiveWorkspaceProject(project);
    setActiveTab('workspace');
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

  const handleSendToDubbingWithAudio = (_script: string, _voiceId: string, sampleVideoId?: string) => {
    setInitialDubSampleId(sampleVideoId || null);
    setActiveTab('dubbing');
  };

  const handleStopAudio = () => {
    textToSpeechService.stopPlayback();
    setIsPlayingAudio(false);
  };

  if (authLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <WaveLoader label="loading studio…" />
      </div>
    );
  }

  if (!user) {
    return <Login />;
  }

  return (
    <div className="h-screen bg-background text-foreground flex flex-col antialiased selection:bg-coral-500 selection:text-white overflow-hidden">
      {/* Toast Notification Container */}
      <ToastContainer toasts={toasts} onDismiss={handleDismissToast} />

      {/* Main Layout Body */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Sidebar Navigation */}
        <Sidebar
          activeTab={activeTab}
          onSelectTab={(tab) => {
            if (tab === 'settings') {
              setIsSettingsOpen(true);
            } else {
              setActiveTab(tab);
            }
          }}
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
            onOpenSettings={() => setIsSettingsOpen(true)}
            isPlayingAudio={isPlayingAudio}
            onStopAudio={handleStopAudio}
          />

          <main className="flex-1 overflow-y-auto pb-24 md:pb-0">
            {activeTab === 'dashboard' && (
              <Dashboard
                projects={projects}
                onNavigate={(tab) => {
                  if (tab === 'settings') setIsSettingsOpen(true);
                  else setActiveTab(tab);
                }}
                onOpenProject={handleOpenWorkspace}
                onStartWithSample={(sampleId) => handleStartDubbing(sampleId)}
                onDeleteProject={handleDeleteProject}
              />
            )}

            {activeTab === 'dubbing' && (
              <DubbingStudio
                key={initialDubSampleId || 'new'}
                initialSampleId={initialDubSampleId}
                onSaveProject={handleSaveProject}
                onOpenWorkspace={handleOpenWorkspace}
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
                projects={projects}
                onOpenProject={handleOpenWorkspace}
                onDeleteProject={handleDeleteProject}
                onNewDub={() => handleStartDubbing()}
              />
            )}

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
                  onShowToast={showToast}
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
          </main>

          <footer className="hidden md:flex items-center justify-center py-1.5 border-t border-[#E2E8F0] bg-[#FAFAF7] shrink-0">
            <p className="text-[10px] text-[#94A3B8]">
              &copy; {new Date().getFullYear()} ScatterPie Analytics Pvt. Ltd. All rights reserved.
            </p>
          </footer>
        </div>
      </div>

      {/* Studio Settings Dialog */}
      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        onShowToast={showToast}
      />
    </div>
  );
}
