/* =========================================================
   Vault — local Claude-artifact launcher
   Everything below runs 100% on-device. Nothing is uploaded
   anywhere. Data lives in this browser's IndexedDB only.
   ========================================================= */

const DB_NAME = "vaultDB";
const DB_VERSION = 1;
let db;

const ICON_COLORS = [
  ["#6F5AF6","#4B3FA8"], ["#2FB6A6","#1C7C71"], ["#E5584F","#A83D37"],
  ["#E8A93D","#A67526"], ["#4E9EE8","#2E6BA8"], ["#C459C7","#7E3980"]
];

/* ---------------- IndexedDB helpers ---------------- */
function openDB(){
  return new Promise((resolve, reject)=>{
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e)=>{
      const _db = e.target.result;
      if(!_db.objectStoreNames.contains("apps")){
        const store = _db.createObjectStore("apps", {keyPath:"id"});
        store.createIndex("category", "category", {unique:false});
      }
      if(!_db.objectStoreNames.contains("categories")){
        _db.createObjectStore("categories", {keyPath:"id"});
      }
    };
    req.onsuccess = ()=>resolve(req.result);
    req.onerror = ()=>reject(req.error);
  });
}

function tx(storeName, mode){
  return db.transaction(storeName, mode).objectStore(storeName);
}

function idbGetAll(storeName){
  return new Promise((resolve,reject)=>{
    const req = tx(storeName,"readonly").getAll();
    req.onsuccess = ()=>resolve(req.result);
    req.onerror = ()=>reject(req.error);
  });
}
function idbPut(storeName, value){
  return new Promise((resolve,reject)=>{
    const req = tx(storeName,"readwrite").put(value);
    req.onsuccess = ()=>resolve();
    req.onerror = ()=>reject(req.error);
  });
}
function idbDelete(storeName, id){
  return new Promise((resolve,reject)=>{
    const req = tx(storeName,"readwrite").delete(id);
    req.onsuccess = ()=>resolve();
    req.onerror = ()=>reject(req.error);
  });
}

/* ---------------- State ---------------- */
let apps = [];
let categories = [];
let activeCategory = "__all__";
let searchTerm = "";
let editingAppId = null;
let gridEditMode = false;

/* ---------------- Init ---------------- */
(async function init(){
  db = await openDB();
  apps = await idbGetAll("apps");
  categories = await idbGetAll("categories");
  renderCategoryRail();
  renderGrid();
  bindEvents();
  registerServiceWorker();
})();

function registerServiceWorker(){
  if("serviceWorker" in navigator){
    navigator.serviceWorker.register("service-worker.js").catch(()=>{});
  }
}

/* ---------------- Rendering ---------------- */
function iconFor(app){
  const [c1,c2] = ICON_COLORS[Math.abs(hashStr(app.name)) % ICON_COLORS.length];
  const initials = app.name.trim().slice(0,2).toUpperCase() || "AP";
  return {c1,c2,initials};
}
function hashStr(s){
  let h=0; for(let i=0;i<s.length;i++){h=(h<<5)-h+s.charCodeAt(i); h|=0;} return h;
}

function visibleApps(){
  return apps.filter(a=>{
    const catOk = activeCategory==="__all__"
      || (activeCategory==="__uncat__" && !a.category)
      || a.category===activeCategory;
    const searchOk = !searchTerm || a.name.toLowerCase().includes(searchTerm.toLowerCase());
    return catOk && searchOk;
  }).sort((a,b)=> b.createdAt - a.createdAt);
}

function renderGrid(){
  const grid = document.getElementById("grid");
  const empty = document.getElementById("empty-state");
  const list = visibleApps();
  grid.innerHTML = "";
  empty.classList.toggle("hidden", apps.length>0);

  list.forEach(app=>{
    const {c1,c2,initials} = iconFor(app);
    const tile = document.createElement("div");
    tile.className = "app-tile" + (gridEditMode ? " editing":"");
    tile.innerHTML = `
      <div class="app-icon" style="background:linear-gradient(160deg,${c1},${c2})">
        <button class="edit-dot" data-id="${app.id}">−</button>
        ${initials}
        <span class="badge">${typeGlyph(app.type)}</span>
      </div>
      <div class="app-name">${escapeHtml(app.name)}</div>
    `;
    tile.addEventListener("click", (e)=>{
      if(gridEditMode){
        if(e.target.classList.contains("edit-dot")){ openEditSheet(app.id); }
        return;
      }
      openViewer(app);
    });
    tile.addEventListener("contextmenu",(e)=>{e.preventDefault(); openEditSheet(app.id);});
    let pressTimer;
    tile.addEventListener("touchstart", ()=>{ pressTimer = setTimeout(()=>openEditSheet(app.id), 500); });
    tile.addEventListener("touchend", ()=>clearTimeout(pressTimer));
    grid.appendChild(tile);
  });
}

function typeGlyph(type){
  return {html:"◆", react:"⚛", json:"{}", svg:"▲", other:"·"}[type] || "·";
}

function renderCategoryRail(){
  const rail = document.getElementById("category-rail");
  rail.querySelectorAll(".chip:not(.chip-ghost)").forEach(c=>{
    if(c.dataset.cat !== "__all__" && c.dataset.cat !== "__uncat__") c.remove();
  });
  const newCatBtn = document.getElementById("btn-new-cat");
  categories.forEach(cat=>{
    const chip = document.createElement("button");
    chip.className = "chip" + (activeCategory===cat.id ? " active":"");
    chip.dataset.cat = cat.id;
    chip.textContent = cat.name;
    chip.addEventListener("click", ()=>selectCategory(cat.id));
    rail.insertBefore(chip, newCatBtn);
  });
  rail.querySelectorAll(".chip[data-cat]").forEach(c=>{
    c.classList.toggle("active", c.dataset.cat===activeCategory);
  });
}

function selectCategory(catId){
  activeCategory = catId;
  renderCategoryRail();
  renderGrid();
}

/* ---------------- File ingestion ---------------- */
function detectType(filename, text){
  const ext = filename.split(".").pop().toLowerCase();
  if(ext==="html" || ext==="htm") return "html";
  if(ext==="svg") return "svg";
  if(ext==="jsx" || ext==="js" || ext==="tsx" || ext==="ts") return "react";
  if(ext==="json") return "json";
  // fallback: sniff content
  const trimmed = text.trim();
  if(trimmed.startsWith("<svg")) return "svg";
  if(trimmed.startsWith("<!DOCTYPE") || trimmed.startsWith("<html")) return "html";
  if(trimmed.startsWith("{") || trimmed.startsWith("[")) return "json";
  return "other";
}

// Injected into every artifact so fixed-width/desktop-sized content
// scales up to fill the phone screen instead of rendering small and
// letterboxed. Only scales width (height scrolls naturally), so long
// scrollable pages aren't squashed.
const AUTOFIT_SCRIPT = `
<script>
(function(){
  function fit(){
    try{
      var body = document.body;
      if(!body || body.dataset.__vaultFitted) return;
      var wrapper = document.createElement('div');
      while(body.firstChild){ wrapper.appendChild(body.firstChild); }
      body.appendChild(wrapper);
      body.style.margin = '0';
      document.documentElement.style.margin = '0';
      var contentW = wrapper.scrollWidth;
      var vw = window.innerWidth;
      if(contentW > 10 && Math.abs(vw/contentW - 1) > 0.03){
        var scale = vw / contentW;
        wrapper.style.transformOrigin = 'top left';
        wrapper.style.transform = 'scale(' + scale + ')';
        wrapper.style.width = contentW + 'px';
        requestAnimationFrame(function(){
          body.style.minHeight = (wrapper.scrollHeight * scale) + 'px';
        });
      }
      body.dataset.__vaultFitted = '1';
    }catch(e){ /* fail silently, never block the artifact */ }
  }
  window.addEventListener('load', function(){ setTimeout(fit, 60); });
})();
<\/script>`;

function injectAutoFit(html){
  if(/<\/body>/i.test(html)) return html.replace(/<\/body>/i, AUTOFIT_SCRIPT + "</body>");
  if(/<\/html>/i.test(html)) return html.replace(/<\/html>/i, AUTOFIT_SCRIPT + "</html>");
  return html + AUTOFIT_SCRIPT;
}

function buildRunnable(type, rawText, filename){
  if(type==="html") return injectAutoFit(rawText);

  if(type==="svg") return `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
    <style>html,body{margin:0;height:100%;display:flex;align-items:center;justify-content:center;background:#fff;}
    svg{max-width:100%;max-height:100%;}</style></head><body>${rawText}${AUTOFIT_SCRIPT}</body></html>`;

  if(type==="react"){
    // Source is embedded as a JSON string and transformed at runtime.
    // We add the commonjs-modules plugin so `export default X` and
    // `import X from 'y'` work no matter what the component is named —
    // not just files that happen to define a global called "App".
    const srcJson = JSON.stringify(rawText);
    return `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
    <script src="https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.production.min.js"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/babel-standalone/7.23.5/babel.min.js"></script>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>html,body,#root{margin:0;height:100%;min-height:100dvh;}</style>
    </head><body><div id="root"></div>
    <div id="__vault_err" style="display:none;font-family:-apple-system;color:#a00;padding:16px;white-space:pre-wrap;"></div>
    <script>
      function __vaultShowError(msg){
        document.getElementById('__vault_err').style.display='block';
        document.getElementById('__vault_err').textContent = msg;
      }
      try{
        var __src = ${srcJson};
        var __out = Babel.transform(__src, {
          filename: 'artifact.tsx',
          presets: [
            'react',
            ['typescript', { isTSX: true, allExtensions: true }]
          ],
          plugins: ['transform-modules-commonjs']
        }).code;

        // Minimal CommonJS shim so import/export work in a plain <script>.
        var module = { exports: {} };
        var exports = module.exports;
        function require(name){
          if(name === 'react') return React;
          if(name === 'react-dom' || name === 'react-dom/client') return ReactDOM;
          throw new Error("This artifact imports '" + name + "', which Vault doesn't have loaded yet. Tell Claude which library this is and it can be added.");
        }

        (new Function('module','exports','require','React','ReactDOM', __out))
          (module, exports, require, React, ReactDOM);

        var __Comp = module.exports && (module.exports.default || module.exports);
        if(!__Comp && typeof App!=='undefined') __Comp = App;
        if(!__Comp && typeof Component!=='undefined') __Comp = Component;

        if(typeof __Comp === 'function' || (typeof __Comp === 'object' && __Comp && __Comp.$$typeof)){
          ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(__Comp));
        } else {
          __vaultShowError("Vault couldn't find a component to render. Make sure the file has a default export (export default YourComponent).");
        }
      }catch(e){
        __vaultShowError('Render error: ' + e.message);
      }
    </script>
    </body></html>`;
  }

  if(type==="json"){
    try{
      const parsed = JSON.parse(rawText);
      // If the JSON has an embedded code/html field, treat it as that content.
      const embedded = parsed.html || parsed.code || parsed.content;
      if(typeof embedded === "string" && embedded.trim().startsWith("<")){
        return embedded;
      }
      const pretty = JSON.stringify(parsed, null, 2);
      return `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
      <style>body{font:13px/1.5 -apple-system,sans-serif;background:#fff;color:#111;padding:16px;margin:0;white-space:pre-wrap;word-break:break-word;}</style>
      </head><body>${escapeHtml(pretty)}</body></html>`;
    }catch(e){
      return `<!DOCTYPE html><html><body style="font-family:-apple-system;padding:20px;color:#a00;">Could not parse this JSON file.</body></html>`;
    }
  }

  return `<!DOCTYPE html><html><body style="font-family:-apple-system;padding:20px;">${escapeHtml(rawText)}</body></html>`;
}

async function handleFiles(fileList){
  const progressEl = document.getElementById("add-progress");
  progressEl.classList.remove("hidden");
  let count=0;
  for(const file of fileList){
    progressEl.textContent = `Adding ${file.name}…`;
    try{
      const text = await file.text();
      const type = detectType(file.name, text);
      const runnable = buildRunnable(type, text, file.name);
      const app = {
        id: crypto.randomUUID(),
        name: file.name.replace(/\.[^/.]+$/, ""),
        category: null,
        type,
        code: runnable,
        createdAt: Date.now()
      };
      await idbPut("apps", app);
      apps.push(app);
      count++;
    }catch(err){
      console.error(err);
      showToast(`Couldn't read ${file.name}`);
    }
  }
  progressEl.classList.add("hidden");
  closeSheet("sheet-add");
  renderGrid();
  if(count) showToast(count===1 ? "App added" : `${count} apps added`);
}

/* ---------------- Viewer ---------------- */
let currentViewerAppId = null;

function openViewer(app){
  const frame = document.getElementById("viewer-frame");
  const loading = document.getElementById("viewer-loading");

  // Reopening the same app you just backed out of: keep it running as-is
  // (preserves scroll position, checked boxes, typed text, etc.) instead
  // of reloading it from scratch.
  if(currentViewerAppId === app.id && frame.srcdoc){
    showScreen("screen-viewer");
    return;
  }

  currentViewerAppId = app.id;
  loading.classList.remove("hidden");
  frame.onload = ()=> loading.classList.add("hidden");
  frame.srcdoc = app.code;
  showScreen("screen-viewer");
}

/* ---------------- Edit sheet ---------------- */
function openEditSheet(id){
  const app = apps.find(a=>a.id===id);
  if(!app) return;
  editingAppId = id;
  document.getElementById("edit-name").value = app.name;
  const sel = document.getElementById("edit-category");
  sel.innerHTML = `<option value="">Uncategorized</option>` +
    categories.map(c=>`<option value="${c.id}" ${c.id===app.category?"selected":""}>${escapeHtml(c.name)}</option>`).join("");
  openSheet("sheet-edit");
}

async function saveEdit(){
  const app = apps.find(a=>a.id===editingAppId);
  if(!app) return;
  app.name = document.getElementById("edit-name").value.trim() || app.name;
  app.category = document.getElementById("edit-category").value || null;
  await idbPut("apps", app);
  closeSheet("sheet-edit");
  renderGrid();
  showToast("Saved");
}

async function deleteApp(){
  if(!editingAppId) return;
  await idbDelete("apps", editingAppId);
  apps = apps.filter(a=>a.id!==editingAppId);
  closeSheet("sheet-edit");
  renderGrid();
  showToast("Deleted");
}

/* ---------------- Category creation ---------------- */
async function createCategory(){
  const input = document.getElementById("newcat-input");
  const name = input.value.trim();
  if(!name) return;
  const cat = {id: crypto.randomUUID(), name};
  await idbPut("categories", cat);
  categories.push(cat);
  input.value = "";
  closeSheet("sheet-newcat");
  renderCategoryRail();
  showToast("Category created");
}

/* ---------------- UI helpers ---------------- */
function showScreen(id){
  document.querySelectorAll(".screen").forEach(s=>s.classList.remove("active"));
  document.getElementById(id).classList.add("active");
}
function openSheet(id){ document.getElementById(id).classList.remove("hidden"); }
function closeSheet(id){ document.getElementById(id).classList.add("hidden"); }
function showToast(msg){
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(()=>t.classList.add("hidden"), 1800);
}
function escapeHtml(s){
  return s.replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

/* ---------------- Events ---------------- */
function bindEvents(){
  document.getElementById("btn-add").addEventListener("click", ()=>openSheet("sheet-add"));
  document.getElementById("btn-cancel-add").addEventListener("click", ()=>closeSheet("sheet-add"));
  document.getElementById("btn-choose-file").addEventListener("click", ()=>document.getElementById("file-input").click());
  document.getElementById("file-input").addEventListener("change", (e)=>{
    if(e.target.files.length) handleFiles(e.target.files);
    e.target.value = "";
  });

  document.getElementById("btn-back").addEventListener("click", ()=>{
    showScreen("screen-library");
  });

  document.getElementById("search-input").addEventListener("input", (e)=>{
    searchTerm = e.target.value;
    renderGrid();
  });

  document.getElementById("btn-new-cat").addEventListener("click", ()=>openSheet("sheet-newcat"));
  document.getElementById("btn-cancel-newcat").addEventListener("click", ()=>closeSheet("sheet-newcat"));
  document.getElementById("btn-save-newcat").addEventListener("click", createCategory);

  document.getElementById("btn-cancel-edit").addEventListener("click", ()=>{ closeSheet("sheet-edit"); gridEditMode=false; renderGrid(); });
  document.getElementById("btn-save-edit").addEventListener("click", saveEdit);
  document.getElementById("btn-delete").addEventListener("click", deleteApp);

  document.getElementById("category-rail").querySelectorAll(".chip[data-cat]").forEach(c=>{
    c.addEventListener("click", ()=>selectCategory(c.dataset.cat));
  });
}
