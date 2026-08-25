const CACHE = "vault-shell-v1";
const SHELL_FILES = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-180.png"
];

self.addEventListener("install", (e)=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL_FILES)));
  self.skipWaiting();
});

self.addEventListener("activate", (e)=>{
  e.waitUntil(
    caches.keys().then(keys=>Promise.all(
      keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))
    ))
  );
  self.clients.claim();
});

// Cache-first for our own shell files only. Everything else (e.g. CDN
// scripts loaded inside a viewed artifact) goes straight to the network.
self.addEventListener("fetch", (e)=>{
  const url = new URL(e.request.url);
  if(url.origin === self.location.origin){
    e.respondWith(
      caches.match(e.request).then(cached=> cached || fetch(e.request))
    );
  }
});
