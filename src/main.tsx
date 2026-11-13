import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App.tsx';
import './ui/index.css';
import { startHistory } from './ui/history.ts';
import { openSharedLink, restoreAutosave, startAutosave } from './ui/storage.ts';

const root = document.getElementById('root');
if (!root) throw new Error('Root element #root not found');

await restoreAutosave();
await openSharedLink();
startAutosave();
startHistory();

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
