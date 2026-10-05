import React, { Component, ErrorInfo, ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
    };
  }

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Uncaught React Error:', error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-slate-900 text-slate-100 flex items-center justify-center p-6">
          <div className="max-w-md w-full bg-slate-800 rounded-2xl border border-slate-700 p-6 shadow-2xl text-center">
            <div className="w-14 h-14 mx-auto mb-4 bg-rose-500/10 text-rose-400 rounded-full flex items-center justify-center border border-rose-500/20">
              <AlertTriangle className="w-7 h-7" />
            </div>
            <h2 className="text-xl font-bold text-white mb-2">Ops! Ocorreu um erro inesperado</h2>
            <p className="text-sm text-slate-400 mb-4">
              A interface encontrou uma falha temporária. Seus dados e o servidor continuam operacionais.
            </p>
            {this.state.error?.message && (
              <pre className="text-xs bg-slate-950 text-rose-300 p-3 rounded-lg overflow-x-auto text-left mb-6 font-mono border border-slate-800">
                {this.state.error.message}
              </pre>
            )}
            <button
              onClick={() => window.location.reload()}
              className="w-full flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white font-medium py-3 px-4 rounded-xl transition-all shadow-lg shadow-indigo-600/20"
            >
              <RefreshCw className="w-4 h-4" />
              Recarregar Página
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
