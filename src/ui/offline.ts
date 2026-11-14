/**
 * Offline use: registers the service worker (public/sw.js) in the production build and
 * remembers a newer worker that is waiting, so the app can offer a reload.
 */

let waiting: ServiceWorker | null = null;
let applying = false;
const listeners = new Set<() => void>();

function setWaiting(worker: ServiceWorker | null): void {
  waiting = worker;
  for (const listener of listeners) listener();
}

export function subscribeUpdate(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether a new version has been downloaded and waits for the user's go-ahead. */
export const updateReady = (): boolean => waiting !== null;

/** Lets the waiting worker take over; the page reloads once it has. */
export function applyUpdate(): void {
  applying = true;
  waiting?.postMessage('skipWaiting');
}

export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  const { serviceWorker } = navigator;
  // The first worker also takes control of the page (controllerchange); only a reload the
  // user asked for is wanted.
  serviceWorker.addEventListener('controllerchange', () => {
    if (applying) window.location.reload();
  });
  // Wait for the page to finish loading so the worker's downloads do not compete with it.
  const register = () => {
    serviceWorker
      .register('/sw.js')
      .then((registration) => {
        // With no controller this is the first visit: there is nothing to update.
        const check = () => {
          if (registration.waiting && serviceWorker.controller) setWaiting(registration.waiting);
        };
        check();
        registration.addEventListener('updatefound', () => {
          const worker = registration.installing;
          worker?.addEventListener('statechange', () => {
            if (worker.state === 'installed') check();
          });
        });
      })
      .catch(() => undefined);
  };
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register);
}
