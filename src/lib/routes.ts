import type { NavigationTab } from '../types';

// Every screen has its own address, so a refresh stays put, Back works and a link can be shared. The server answers any of them with the app.
const TAB_PATHS: Partial<Record<NavigationTab, string>> = {
  dashboard: '/',
  dubbing: '/dubbing',
  'text-to-voice': '/text-to-voice',
  history: '/history',
  team: '/team',
  glossary: '/glossary',
  usage: '/usage',
  settings: '/settings',
};

export interface Route {
  tab: NavigationTab;
  /** Set on a project's own address, /projects/<id>. */
  projectId: string | null;
}

export function routeFor(pathname: string): Route {
  const path = pathname.replace(/\/+$/, '') || '/';
  const project = /^\/projects\/([A-Za-z0-9_-]+)$/.exec(path);
  if (project) return { tab: 'workspace', projectId: project[1] };
  const tab = (Object.keys(TAB_PATHS) as NavigationTab[]).find((name) => TAB_PATHS[name] === path);
  return { tab: tab ?? 'not-found', projectId: null };
}

/** The address of a screen, or null where the current one should stay (a page that was not found, a project still loading). */
export function pathFor(tab: NavigationTab, projectId?: string | null): string | null {
  if (tab === 'workspace') return projectId ? `/projects/${projectId}` : null;
  return TAB_PATHS[tab] ?? null;
}

export function tabDetails(tab: NavigationTab): { title: string; subtitle: string } {
  switch (tab) {
    case 'dashboard':
      return { title: 'Studio Overview', subtitle: 'Global AI Dubbing & Voice Workspace' };
    case 'dubbing':
      return { title: 'Video Dubbing Studio', subtitle: 'Translate speech into 40+ languages and dialects' };
    case 'text-to-voice':
      return { title: 'Text-to-Voice Studio', subtitle: 'Generate humanlike voiceovers from raw scripts' };
    case 'workspace':
      return { title: 'Project Workspace', subtitle: 'Multi-stage timeline and transcript editor' };
    case 'history':
      return { title: 'Project History', subtitle: 'All past localized media and exports' };
    case 'usage':
      return { title: 'Usage & Limits', subtitle: 'Monitor your minutes and storage' };
    case 'settings':
      return { title: 'Settings', subtitle: 'Your account, dubbing defaults and notifications' };
    case 'team':
      return { title: 'Team', subtitle: 'Members, roles and invitations' };
    case 'glossary':
      return { title: 'Glossary', subtitle: 'Terms every translation and voice must get right' };
    case 'not-found':
      return { title: 'Page Not Found', subtitle: 'This address is not part of Dubly' };
    default:
      // Without this, adding a tab to NavigationTab and forgetting to name it here returns undefined and the header crashes on `details.title`.
      return { title: 'Dubly', subtitle: 'AI dubbing and voice workspace' };
  }
}
