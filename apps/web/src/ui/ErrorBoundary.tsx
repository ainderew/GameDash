import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/** Catches WebGL/asset failures and renders a friendly fallback instead of a blank screen. */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[friendslop] render error:', error, info);
  }

  override render() {
    if (this.state.error) {
      return (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-8 text-center">
          <h1 className="text-xl font-bold text-red-300">Something broke</h1>
          <p className="max-w-md text-sm text-white/60">
            The 3D scene failed to render. If this persists, try enabling hardware acceleration in
            your browser settings, then reload.
          </p>
          <button
            className="rounded-md bg-white/10 px-4 py-2 text-sm ring-1 ring-white/20 hover:bg-white/20"
            onClick={() => window.location.reload()}
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
