import { lazy } from 'react';

/*
 * Views that are not on screen when the app opens load in their own chunks, so the first
 * paint only waits for the canvas, the palette and the side panel.
 */
const tabs = () => import('./window/tabs.tsx');
const terminal = () => import('./apps/Terminal.tsx');
const simPanel = () => import('./SimPanel.tsx');
const taskEditor = () => import('./TaskEditor.tsx');

export const PhysicalTab = lazy(() => tabs().then((m) => ({ default: m.PhysicalTab })));
export const ConfigTab = lazy(() => tabs().then((m) => ({ default: m.ConfigTab })));
export const DesktopTab = lazy(() => tabs().then((m) => ({ default: m.DesktopTab })));
export const Terminal = lazy(() => terminal().then((m) => ({ default: m.Terminal })));
export const SimPanel = lazy(() => simPanel().then((m) => ({ default: m.SimPanel })));
export const TaskEditor = lazy(() => taskEditor().then((m) => ({ default: m.TaskEditor })));

/**
 * Fetches the lazy views once the browser is idle, so the first device window opens without
 * a wait (and the views are cached for offline use even if they were never opened).
 */
export function preloadViews(): void {
  const load = () => void Promise.all([tabs(), terminal(), simPanel(), taskEditor()]);
  if ('requestIdleCallback' in window) window.requestIdleCallback(load, { timeout: 3000 });
  else setTimeout(load, 1000);
}
