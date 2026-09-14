/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import {
  Menu,
  Plus,
  VolumeX,
  Search,
  Settings,
} from 'lucide-react';
import { NavigationTab } from '../types';

interface HeaderProps {
  activeTab: NavigationTab;
  onOpenMobileMenu: () => void;
  onOpenNewProject: () => void;
  onOpenSettings: () => void;
  onSearch: (query: string) => void;
  isPlayingAudio: boolean;
  onStopAudio: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  activeTab,
  onOpenMobileMenu,
  onOpenNewProject,
  onOpenSettings,
  onSearch,
  isPlayingAudio,
  onStopAudio,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const getTabDetails = (tab: NavigationTab) => {
    switch (tab) {
      case 'dashboard':
        return { title: 'Studio Overview', subtitle: 'Global AI Dubbing & Voice Workspace' };
      case 'dubbing':
        return { title: 'Video Dubbing Studio', subtitle: 'Translate existing speech into 20+ languages' };
      case 'text-to-voice':
        return { title: 'Text-to-Voice Studio', subtitle: 'Generate humanlike voiceovers from raw scripts' };
      case 'my-voices':
        return { title: 'My Voices', subtitle: 'Record once, then dub in your own voice in any language' };
      case 'workspace':
        return { title: 'Project Workspace', subtitle: 'Multi-stage timeline and transcript editor' };
      case 'history':
        return { title: 'Project History', subtitle: 'All past localized media and exports' };
      case 'usage':
        return { title: 'Usage & Quotas', subtitle: 'Monitor minutes, storage, and engine allocation' };
      case 'settings':
        return { title: 'Settings', subtitle: 'Dubbing preferences and workspace profile' };
      default:
        // Without this, adding a tab to NavigationTab and forgetting to name it here
        // returns undefined and the header crashes the whole page on `details.title`.
        // A plain fallback keeps a new section usable until it gets its own copy.
        return { title: 'Dubly', subtitle: 'AI dubbing and voice workspace' };
    }
  };

  const details = getTabDetails(activeTab);

  return (
    <header className="sticky top-0 z-30 bg-background/90 backdrop-blur-md border-b border-border">
      <div className="flex items-center gap-3 px-4 sm:px-8 h-[60px]">
        {/* Hamburger — mobile only */}
        <button
          type="button"
          onClick={onOpenMobileMenu}
          className="md:hidden p-2 -ml-2 text-slate-600 hover:bg-slate-100 rounded-md"
          aria-label="Open menu"
        >
          <Menu className="w-5 h-5" />
        </button>

        <div className="hidden sm:block min-w-0">
          <h1 className="text-base sm:text-lg font-semibold text-foreground tracking-tight truncate font-display">
            {details.title}
          </h1>
          <p className="text-xs text-muted-foreground hidden md:block mt-0.5 truncate">{details.subtitle}</p>
        </div>

        {/* Desktop search — submits to Project History, which is where results land */}
        <div className="hidden md:flex items-center gap-2 flex-1 max-w-md ml-4">
          <form
            className="relative w-full"
            onSubmit={(e) => {
              e.preventDefault();
              onSearch(searchQuery);
            }}
          >
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search projects…"
              className="w-full pl-9 pr-3 py-2 rounded-md bg-white border border-border text-sm placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-coral-500/30 focus:border-coral-400"
            />
          </form>
        </div>

        <div className="ml-auto flex items-center gap-3">
          {isPlayingAudio && (
            <button
              type="button"
              onClick={onStopAudio}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-amber-500/10 text-amber-600 border border-amber-500/30 text-xs font-semibold hover:bg-amber-500/20 transition-all animate-pulse"
            >
              <VolumeX className="w-3.5 h-3.5" />
              <span>Stop Audio</span>
            </button>
          )}

          <button
            type="button"
            onClick={onOpenSettings}
            aria-label="Open settings"
            className="hidden sm:flex p-2 rounded-md text-slate-500 hover:text-foreground hover:bg-slate-100 transition-colors"
          >
            <Settings className="w-4 h-4" />
          </button>

          <button
            type="button"
            onClick={onOpenNewProject}
            className="flex items-center gap-1.5 px-4 py-2 rounded-md bg-coral-500 hover:bg-coral-600 text-white text-xs font-semibold shadow-[0_0_20px_rgba(240,86,55,0.3)] transition-all duration-150"
          >
            <Plus className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">New Dub</span>
          </button>
        </div>
      </div>
    </header>
  );
};
