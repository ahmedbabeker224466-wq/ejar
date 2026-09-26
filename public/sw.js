// Minimal service worker: enables home-screen installation.
// No offline caching; all requests go straight to the network.

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});
