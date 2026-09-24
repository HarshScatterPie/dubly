/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import {
  Languages,
  LayoutDashboard,
  Video,
  Mic,
  UserRound,
  FolderKanban,
  History,
  BarChart3,
  Users,
  Settings,
  ChevronLeft,
  ChevronRight,
  LogOut,
  Zap,
} from 'lucide-react';
import { NavigationTab, UserUsageStats } from '../types';
import { useAuth } from '../context/AuthContext';

interface SidebarProps {
  activeTab: NavigationTab;
  onSelectTab: (tab: NavigationTab) => void;
  usage: UserUsageStats;
  onOpenNewProject: () => void;
  isMobileOpen?: boolean;
  onCloseMobile?: () => void;
}

const NAV = [
  { id: 'dashboard' as NavigationTab, label: 'Dashboard', Icon: LayoutDashboard },
  { id: 'dubbing' as NavigationTab, label: 'Video Dubbing', Icon: Video },
  { id: 'text-to-voice' as NavigationTab, label: 'Text to Voice', Icon: Mic },
  // A voice is recorded once and reused across every project, so it belongs at the top
  // level rather than buried in the studio that happened to create it.
  { id: 'my-voices' as NavigationTab, label: 'My Voices', Icon: UserRound },
  { id: 'workspace' as NavigationTab, label: 'Active Studio', Icon: FolderKanban },
  { id: 'history' as NavigationTab, label: 'History', Icon: History },
];

const NAV_BOTTOM = [
  { id: 'team' as NavigationTab, label: 'Team', Icon: Users },
  { id: 'usage' as NavigationTab, label: 'Usage & Limits', Icon: BarChart3 },
  { id: 'settings' as NavigationTab, label: 'Settings', Icon: Settings },
];

// 5 most-used destinations for the mobile bottom tab bar
const MOBILE_TABS = [
  { id: 'dashboard' as NavigationTab, label: 'Home', Icon: LayoutDashboard },
  { id: 'dubbing' as NavigationTab, label: 'Dub', Icon: Video },
  { id: 'text-to-voice' as NavigationTab, label: 'Voice', Icon: Mic },
  { id: 'history' as NavigationTab, label: 'History', Icon: History },
  { id: 'settings' as NavigationTab, label: 'Settings', Icon: Settings },
];

export const Sidebar: React.FC<SidebarProps> = ({
  activeTab,
  onSelectTab,
  usage,
  onOpenNewProject,
  isMobileOpen = false,
  onCloseMobile,
}) => {
  const { user, profile, signOut } = useAuth();
  const [collapsed, setCollapsed] = useState(false);

  // ScatterStudio's own shared profile first — Firebase Auth's displayName is usually
  // empty (only Google sign-in ever fills it), so falling back to it first showed
  // "Studio User" for most accounts even when their real name was one API call away.
  const displayName = profile?.name || user?.displayName || user?.email || 'Studio User';
  const initials = displayName
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();

  const handleNav = (tab: NavigationTab) => {
    onSelectTab(tab);
    onCloseMobile?.();
  };

  const minutesPercent = Math.round((usage.minutesDubbed / usage.minutesLimit) * 100);

  const NavItem: React.FC<{ id: NavigationTab; label: string; Icon: typeof LayoutDashboard; collapsedView: boolean }> = ({
    id,
    label,
    Icon,
    collapsedView,
  }) => {
    const isActive = activeTab === id;
    return (
      <div
        onClick={() => handleNav(id)}
        data-testid={`nav-${id}`}
        className={`group flex items-center gap-3 px-3 py-2.5 rounded-md text-sm cursor-pointer transition-colors ${
          isActive ? 'bg-white/8 text-white' : 'text-slate-400 hover:text-white hover:bg-white/5'
        }`}
      >
        <span
          className={`relative inline-flex items-center justify-center w-7 h-7 rounded-md shrink-0 ${
            isActive ? 'bg-coral-500/15 text-coral-600' : 'text-slate-400 group-hover:text-white'
          }`}
        >
          <Icon className="w-4 h-4" />
        </span>
        {!collapsedView && <span className="font-medium truncate">{label}</span>}
        {!collapsedView && isActive && <span className="ml-auto w-1.5 h-1.5 rounded-full bg-coral-500 shrink-0" />}
      </div>
    );
  };

  return (
    <>
      {/* Desktop sidebar */}
      <aside
        className={`hidden md:flex shrink-0 flex-col bg-ink-900 text-slate-100 transition-[width] duration-300 sticky top-0 h-screen ${
          collapsed ? 'w-[76px]' : 'w-[248px]'
        }`}
        data-testid="app-sidebar"
      >
        <div className="px-4 py-5 flex items-center justify-between">
          <div
            onClick={() => handleNav('dashboard')}
            className="flex items-center gap-2.5 cursor-pointer group min-w-0"
          >
            <div className="w-8 h-8 bg-coral-500 rounded-lg flex items-center justify-center shadow-[0_0_15px_rgba(240,86,55,0.4)] shrink-0 group-hover:scale-105 transition-transform">
              <Languages className="w-4 h-4 text-white" />
            </div>
            {!collapsed && <span className="text-lg font-bold tracking-tight truncate font-display">Dubly</span>}
          </div>
          {!collapsed && (
            <button
              className="text-slate-400 hover:text-white p-1 rounded-md"
              onClick={() => setCollapsed(true)}
              data-testid="sidebar-toggle"
              aria-label="Collapse sidebar"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
          )}
        </div>
        {collapsed && (
          <button
            className="mx-auto mb-1 text-slate-400 hover:text-white p-1 rounded-md"
            onClick={() => setCollapsed(false)}
            aria-label="Expand sidebar"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        )}

        <div className="px-2.5 pb-3">
          <button
            type="button"
            onClick={onOpenNewProject}
            className={`w-full flex items-center justify-center gap-2 py-2.5 rounded-md bg-coral-500 hover:bg-coral-600 text-white font-semibold text-xs tracking-wide shadow-[0_0_20px_rgba(240,86,55,0.3)] transition-all duration-200 ${
              collapsed ? 'px-0' : 'px-4'
            }`}
          >
            <Zap className="w-4 h-4 fill-current" />
            {!collapsed && <span>+ Create New Project</span>}
          </button>
        </div>

        <nav className="flex-1 px-2.5 space-y-0.5 overflow-y-auto custom-scrollbar">
          {NAV.map((item) => (
            <NavItem key={item.id} {...item} collapsedView={collapsed} />
          ))}
          <div className="my-3 mx-2 border-t border-white/5" />
          {NAV_BOTTOM.map((item) => (
            <NavItem key={item.id} {...item} collapsedView={collapsed} />
          ))}
        </nav>

        {!collapsed && (
          <div className="p-3 mx-2.5 mb-2 bg-white/5 rounded-lg">
            <div className="flex items-center justify-between text-xs mb-1.5">
              <span className="text-slate-400 text-[11px] font-medium">Monthly Dubbing</span>
              <span className="text-coral-600 font-mono text-[11px] font-semibold">
                {usage.minutesDubbed} / {usage.minutesLimit}m
              </span>
            </div>
            <div className="w-full h-1.5 bg-white/10 rounded-full overflow-hidden">
              <div
                className="h-full bg-coral-500 rounded-full transition-all duration-500"
                style={{ width: `${Math.min(100, minutesPercent)}%` }}
              />
            </div>
            {usage.resetsAt && (
              <p className="mt-1.5 text-[10px] text-slate-500">
                {usage.minutesDubbed >= usage.minutesLimit ? 'Limit reached · refreshes ' : 'Refreshes '}
                {new Date(usage.resetsAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
              </p>
            )}
          </div>
        )}

        <div className="p-3 border-t border-white/5">
          <div className={`flex items-center gap-3 ${collapsed ? 'justify-center' : ''}`}>
            {user?.photoURL ? (
              <img src={user.photoURL} alt={displayName} className="w-9 h-9 rounded-full object-cover shrink-0" />
            ) : (
              <div className="w-9 h-9 rounded-full bg-coral-500 flex items-center justify-center text-white text-xs font-bold shrink-0">
                {initials || 'U'}
              </div>
            )}
            {!collapsed && (
              <>
                <div className="flex-1 min-w-0 cursor-pointer" onClick={() => handleNav('settings')}>
                  <p className="text-sm font-medium truncate" data-testid="sidebar-user-name">
                    {displayName}
                  </p>
                  <p className="text-xs text-slate-400 truncate">{usage.activePlan} Plan</p>
                </div>
                <button
                  className="text-slate-400 hover:text-coral-600 p-1.5 rounded-md shrink-0"
                  onClick={() => void signOut()}
                  data-testid="sidebar-logout-button"
                  aria-label="Sign out"
                >
                  <LogOut className="w-4 h-4" />
                </button>
              </>
            )}
          </div>
        </div>
      </aside>

      {/* Mobile overlay + drawer */}
      {isMobileOpen && (
        <div className="fixed inset-0 z-40 md:hidden" onClick={onCloseMobile}>
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
        </div>
      )}
      <aside
        className={`fixed inset-y-0 left-0 z-50 w-72 bg-ink-900 text-slate-100 flex flex-col transition-transform duration-300 md:hidden ${
          isMobileOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
        aria-label="Mobile navigation"
      >
        <div className="px-4 py-5 flex items-center gap-2.5 border-b border-white/5">
          <div className="w-8 h-8 bg-coral-500 rounded-lg flex items-center justify-center shrink-0">
            <Languages className="w-4 h-4 text-white" />
          </div>
          <span className="text-lg font-bold tracking-tight font-display">Dubly</span>
        </div>
        <nav className="flex-1 px-2.5 mt-2 space-y-0.5 overflow-y-auto custom-scrollbar">
          {NAV.map((item) => (
            <NavItem key={item.id} {...item} collapsedView={false} />
          ))}
          <div className="my-3 mx-2 border-t border-white/5" />
          {NAV_BOTTOM.map((item) => (
            <NavItem key={item.id} {...item} collapsedView={false} />
          ))}
        </nav>
        <div className="p-3 border-t border-white/5">
          <div className="flex items-center gap-3">
            {user?.photoURL ? (
              <img src={user.photoURL} alt={displayName} className="w-9 h-9 rounded-full object-cover shrink-0" />
            ) : (
              <div className="w-9 h-9 rounded-full bg-coral-500 flex items-center justify-center text-white text-xs font-bold shrink-0">
                {initials || 'U'}
              </div>
            )}
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{displayName}</p>
              <p className="text-xs text-slate-400 truncate">{usage.activePlan} Plan</p>
            </div>
            <button
              className="text-slate-400 hover:text-coral-600 p-1.5 rounded-md shrink-0"
              onClick={() => void signOut()}
              aria-label="Sign out"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </aside>

      {/* Mobile bottom tab bar */}
      <nav className="fixed bottom-0 left-0 right-0 z-30 md:hidden bg-surface border-t border-border flex safe-pb">
        {MOBILE_TABS.map(({ id, label, Icon }) => {
          const isActive = activeTab === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => handleNav(id)}
              className={`flex-1 flex flex-col items-center justify-center py-2 gap-0.5 text-[10px] font-medium transition-colors ${
                isActive ? 'text-coral-600' : 'text-slate-600'
              }`}
            >
              <Icon className={`w-5 h-5 ${isActive ? 'text-coral-500' : 'text-slate-400'}`} />
              {label}
            </button>
          );
        })}
      </nav>
    </>
  );
};
