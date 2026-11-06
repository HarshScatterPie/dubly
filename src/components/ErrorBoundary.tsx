import React from 'react';
import { clearBootCaches } from '../lib/bootCache';

interface State {
  failed: boolean;
}

/**
 * The last line of defence: a screen that crashes shows this instead of a blank page. What this browser saved goes too, because a bad
 * saved copy would crash the app again on every reload; the next load fetches everything fresh. It also catches a page that
 * could not load its code after an update, which a reload fixes.
 */
export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  declare props: { children: React.ReactNode };
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    clearBootCaches();
    console.error('Dubly crashed', error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="min-h-screen bg-background flex items-center justify-center px-4 py-8" role="alert">
        <div className="w-full max-w-sm glass-panel rounded-2xl p-8 space-y-5 shadow-lg text-center">
          <div className="space-y-2">
            <h1 className="text-lg font-bold text-foreground">Something went wrong</h1>
            <p className="text-sm text-muted-foreground">
              Dubly could not show this page. Your projects are safe. Reload to carry on, and if it happens again, tell your workspace admin.
            </p>
          </div>
          <button type="button" onClick={() => window.location.assign('/')} className="w-full py-2.5 rounded-md bg-coral-500 hover:bg-coral-600 text-white text-sm font-semibold">
            Reload Dubly
          </button>
        </div>
      </div>
    );
  }
}
