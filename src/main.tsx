import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/barlow/latin-400.css';
import '@fontsource/barlow/latin-500.css';
import '@fontsource/barlow/latin-600.css';
import '@fontsource/barlow-semi-condensed/latin-500.css';
import '@fontsource/barlow-semi-condensed/latin-600.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-500.css';
import { App } from './ui/App.tsx';
import { AppCrash, ErrorBoundary } from './ui/ErrorBoundary.tsx';
import './ui/index.css';
import { startHistory } from './ui/history.ts';
import { registerServiceWorker } from './ui/offline.ts';
import { openSharedLink, restoreAutosave, startAutosave } from './ui/storage.ts';

const root = document.getElementById('root');
if (!root) throw new Error('Root element #root not found');

await restoreAutosave();
await openSharedLink();
startAutosave();
startHistory();
registerServiceWorker();

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary fallback={(error) => <AppCrash error={error} />}>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
