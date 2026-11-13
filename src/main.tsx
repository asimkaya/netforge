import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App.tsx';
import './ui/index.css';
import { restoreAutosave, startAutosave } from './ui/storage.ts';

const root = document.getElementById('root');
if (!root) throw new Error('Root element #root not found');

await restoreAutosave();
startAutosave();

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
