import { Component, type ErrorInfo, type ReactNode } from 'react';
import { PRIMARY, SECONDARY } from './styles.ts';
import { downloadLab } from './storage.ts';

interface Props {
  /** What to show instead of the children after they threw. */
  fallback: (error: Error, retry: () => void) => ReactNode;
  children: ReactNode;
}

/** Catches errors thrown while rendering its children, so one broken part cannot blank the app. */
export class ErrorBoundary extends Component<Props, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('NetForge: a part of the page failed to render.', error, info.componentStack);
  }

  override render() {
    const { error } = this.state;
    return error
      ? this.props.fallback(error, () => this.setState({ error: null }))
      : this.props.children;
  }
}

function Details({ error }: { error: Error }) {
  return (
    <details className="text-xs text-(--nf-muted)">
      <summary className="cursor-pointer">Technical details</summary>
      <pre className="mt-1 font-mono whitespace-pre-wrap">{error.message}</pre>
    </details>
  );
}

/**
 * Shown when the whole app failed to render. The lab is already autosaved, so a reload
 * usually brings it back; the download is for when the saved lab itself is the problem.
 */
export function AppCrash({ error }: { error: Error }) {
  const save = () => {
    try {
      downloadLab();
    } catch (failure) {
      console.error('NetForge: the lab could not be exported.', failure);
    }
  };
  return (
    <main className="flex h-full items-center justify-center bg-(--nf-bg) p-6">
      <section role="alert" className="max-w-md space-y-3 text-sm">
        <h1 className="font-(family-name:--font-label) text-xl font-semibold">
          NetForge stopped working
        </h1>
        <p>
          Something went wrong while drawing the page. Your lab is saved in this browser after every
          change, so reloading usually brings it back.
        </p>
        <p className="text-(--nf-muted)">
          If the error comes back after a reload, download your lab first and send the file with the
          details below when you report the problem.
        </p>
        <div className="flex gap-2">
          <button type="button" className={PRIMARY} onClick={() => window.location.reload()}>
            Reload
          </button>
          <button type="button" className={SECONDARY} onClick={save}>
            Download my lab
          </button>
        </div>
        <Details error={error} />
      </section>
    </main>
  );
}

/** Shown inside a device window whose tab failed; the rest of the app keeps working. */
export function WindowCrash({ error, retry }: { error: Error; retry: () => void }) {
  return (
    <div role="alert" className="space-y-2 p-4 text-sm">
      <p className="font-medium">This view stopped working.</p>
      <p className="text-(--nf-muted)">
        The network and the rest of NetForge are not affected. Try again, or close the window and
        open it again.
      </p>
      <button type="button" className={SECONDARY} onClick={retry}>
        Try again
      </button>
      <Details error={error} />
    </div>
  );
}
