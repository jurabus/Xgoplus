// Minimal service worker: makes the site installable ("Add to Home screen").
// It deliberately caches nothing, so every visit gets the latest version.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => { /* network only */ });
