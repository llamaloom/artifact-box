const CACHE = "vault-shell-v2";
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

// Network-first for our own shell files: always try to get the latest
// version first, and only fall back to the saved copy if there's no
// internet connection. This means future updates show up immediately.
self.addEventListener("fetch", (e)=>{
  const url = new URL(e.request.url);
  if(url.origin === self.location.origin){
    e.respondWith(
      fetch(e.request)
        .then(res=>{
          const copy = res.clone();
          caches.open(CACHE).then(c=>c.put(e.request, copy));
          return res;
        })
        .catch(()=> caches.match(e.request))
    );
  }
});
