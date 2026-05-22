import React from 'react';

interface AppErrorBoundaryProps {
  children: React.ReactNode;
  hasSavedAssessment: boolean;
  resetKey?: number;
  onRestoreSaved: () => void;
  onDownloadSaved: () => void;
  onClearSaved: () => void;
  onError?: (error: Error, info: React.ErrorInfo) => void;
}

interface AppErrorBoundaryState {
  hasError: boolean;
}

export class AppErrorBoundary extends React.Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): AppErrorBoundaryState {
    return { hasError: true };
  }

  componentDidUpdate(prevProps: AppErrorBoundaryProps) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.hasError) {
      this.setState({ hasError: false });
    }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[FinOps] UI render failed', error, info);
    this.props.onError?.(error, info);
  }

  private restore = () => {
    this.props.onRestoreSaved();
  };

  private clear = () => {
    this.props.onClearSaved();
    this.setState({ hasError: false });
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div className="min-h-screen bg-slate-950 text-white flex items-center justify-center px-6">
        <div className="max-w-xl w-full rounded-3xl border border-white/10 bg-slate-900 p-8 shadow-2xl">
          <p className="text-xs font-bold uppercase tracking-[0.25em] text-rose-300 mb-3">View Recovery</p>
          <h1 className="text-3xl font-display font-black mb-3">The report view stopped rendering.</h1>
          <p className="text-slate-300 leading-relaxed">
            Your assessment may still be recoverable from this browser session. Open the recovery view to download the saved JSON or regenerate HTML reports without rendering the crashed view.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={this.restore}
              disabled={!this.props.hasSavedAssessment}
              className={`px-5 py-3 rounded-xl font-bold ${this.props.hasSavedAssessment ? 'bg-emerald-400 text-slate-950 hover:bg-emerald-300' : 'bg-slate-800 text-slate-500 cursor-not-allowed'}`}
            >
              Open recovery view
            </button>
            <button
              type="button"
              onClick={this.props.onDownloadSaved}
              disabled={!this.props.hasSavedAssessment}
              className={`px-5 py-3 rounded-xl font-bold ${this.props.hasSavedAssessment ? 'bg-slate-800 text-slate-200 hover:bg-slate-700' : 'bg-slate-800 text-slate-500 cursor-not-allowed'}`}
            >
              Download recovered JSON
            </button>
            <button
              type="button"
              onClick={this.clear}
              className="px-5 py-3 rounded-xl font-bold bg-slate-800 text-slate-200 hover:bg-slate-700"
            >
              Clear and restart
            </button>
          </div>
        </div>
      </div>
    );
  }
}
