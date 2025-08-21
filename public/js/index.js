import { dataUrl, getApiBase, groupIntoStacks, debounce, urlParam, pushUrlParam, replaceUrlParam, fmtTime, escapeHtml } from "./utils.js";

const isMobile = matchMedia('(max-width:768px)').matches;
let topMap; // no mini-map when sticky hero map is always visible
let photoStacks = [];
let allPhotos = [];
let stackMetaByDay = {};
let activeStackId = null;
let scrollLocked = false;

// Full-screen map overlay variables
let mapOverlay, overlayMap, overlayMarker;

// Lightbox variables
let lbRoot = null;
let lbEscHandler = null;

const currentLocation = { lat: 35.6762, lng: 139.6503, name: "Tokyo, Japan" };

// Expose getApiBase to global window for lightbox script
window.getApiBase = getApiBase;

// Expose interaction functions for lightbox script
window.fetchPhotoInteractions = fetchPhotoInteractions;
window.reactPhoto = reactPhoto;
window.commentPhoto = commentPhoto;

// Expose lightbox functions
window.closeLightbox = closeLightbox;

// ---- interactions helpers ----
const API = () => (getApiBase() || ""); // allow same-origin

// stack
async function fetchStackInteractions(stack) {
  const ids = stack.photos.map(p => p.id);
  const q = new URLSearchParams({
    includeRollup: "true",
    photos: JSON.stringify(ids)
  });
  const res = await fetch(`${API()}/api/stack/${stack.id}/interactions?${q}`);
  return res.ok ? res.json() : { stack:{reactions:{},comments:[]}, rollup:{reactions:{},comments:[], totalCommentCount:0} };
}
async function reactStack(stackId, liked) {
  const body = { emoji: "❤️", action: liked ? "remove" : "add" };
  const res = await fetch(`${API()}/api/stack/${stackId}/react`, {
    method: "POST", headers: { "Content-Type":"application/json" }, body: JSON.stringify(body)
  });
  return res.ok ? res.json() : { ok:false };
}
async function commentStack(stackId, text, author="You") {
  const res = await fetch(`${API()}/api/stack/${stackId}/comment`, {
    method:"POST", headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ text, author })
  });
  return res.ok ? (await res.json()).comment : null;
}

// photo
async function fetchPhotoInteractions(photoId) {
  const res = await fetch(`${API()}/api/photo/${photoId}/interactions`);
  return res.ok ? res.json() : { reactions:{}, comments:[] };
}
async function reactPhoto(photoId, liked) {
  const body = { emoji:"❤️", action: liked ? "remove" : "add" };
  const res = await fetch(`${API()}/api/photo/${photoId}/react`, {
    method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body)
  });
  return res.ok ? res.json() : { ok:false };
}
async function commentPhoto(photoId, text, author="You") {
  const res = await fetch(`${API()}/api/photo/${photoId}/comment`, {
    method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ text, author })
  });
  return res.ok ? (await res.json()).comment : null;
}

init();

async function init(){
  await loadStacks();
  initMaps();
  renderFeed();
  setupStickyMiniMap();
  setupScrollSync();

  const initial = urlParam("stack") || (photoStacks[0]?.id);
  if (initial){ setActive(initial); requestAnimationFrame(()=>scrollToStack(initial, {instant:true})); }
}

// ---------- data ----------
// Drag-to-scroll helper function
function makeDragScrollable(el) {
  let isDown = false, startX = 0, startScroll = 0;
  const onDown = (e) => {
    isDown = true;
    startX = (e.touches ? e.touches[0].pageX : e.pageX);
    startScroll = el.scrollLeft;
    el.classList.add('dragging');
  };
  const onMove = (e) => {
    if (!isDown) return;
    const x = (e.touches ? e.touches[0].pageX : e.pageX);
    el.scrollLeft = startScroll - (x - startX);
  };
  const onUp = () => { isDown = false; el.classList.remove('dragging'); };

  el.addEventListener('mousedown', onDown);
  el.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);

  el.addEventListener('touchstart', onDown, { passive: true });
  el.addEventListener('touchmove', onMove,  { passive: true });
  el.addEventListener('touchend', onUp);
}

async function loadStacks(){
  const previewSlug = urlParam("preview");
  allPhotos = [];
  stackMetaByDay = {};

  if (previewSlug){
    const dj = await (await fetch(dataUrl("days", `${previewSlug}.json`))).json();
    stackMetaByDay[previewSlug] = dj.stackMeta || {};
    (dj.photos||[]).forEach(p=> allPhotos.push({ ...p, dayTitle:dj.title, daySlug:previewSlug, ts:+new Date(p.taken_at) }));
  } else {
    const days = await (await fetch(dataUrl("days", "index.json"))).json();
    await Promise.all(days.map(async d=>{
      const dj = await (await fetch(dataUrl("days", `${d.slug}.json`))).json();
      stackMetaByDay[d.slug] = dj.stackMeta || {};
      (dj.photos||[]).forEach(p=> allPhotos.push({ ...p, dayTitle:dj.title, daySlug:d.slug, ts:+new Date(p.taken_at) }));
    }));
  }

  allPhotos.sort((a,b)=>a.ts-b.ts);

  // group photos into stacks by proximity (500m radius)
  photoStacks = groupIntoStacks(allPhotos, 500);

  // apply saved metadata and tag photos with stack id
  photoStacks.forEach(s => {
    const slug = s.photos[0]?.daySlug;
    const meta = stackMetaByDay[slug]?.[s.id];
    if (meta?.title) s.title = meta.title;
    s.caption = meta?.caption || '';
    s.photos.forEach(p => p.stackId = s.id);
  });
}

// ---------- maps ----------
function initMaps(){
  if (!window.L) return;

  topMap = L.map('top-map', {
    zoomControl: !isMobile,     // cleaner on phones
    dragging: !isMobile,        // optional: display-only on phones; tap "expand" for full map view
    scrollWheelZoom: !isMobile,
    touchZoom: !isMobile
  });

  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    { attribution:"&copy; Esri", maxZoom:18 }).addTo(topMap);

  addMarkersAndPath(topMap);

  // Fit once everything is known
  const b = L.latLngBounds([[currentLocation.lat,currentLocation.lng]]);
  allPhotos.forEach(p=> {
    if (typeof p.lat === 'number' && typeof p.lon === 'number') {
      b.extend([p.lat, p.lon]);
    }
  });
  topMap.fitBounds(b, { padding:[20,20] });

  // Important when sticky containers change size / orientation
  setTimeout(()=>topMap.invalidateSize(), 250);
  addEventListener('resize', ()=>topMap && topMap.invalidateSize());
}

function addMarkersAndPath(map){
  const isTopMap = map === topMap;
  
  // current location
  L.marker([currentLocation.lat, currentLocation.lng], {
    icon: L.divIcon({ className:"current-location-marker", html:
      `<div class="pulse-marker"><div class="pulse-dot"></div><div class="pulse-ring"></div></div>`,
      iconSize:[40,40], iconAnchor:[20,20]
    })
  }).addTo(map);

  const gpsPhotos = allPhotos.filter(p=> typeof p.lat === 'number' && typeof p.lon === 'number');

  // path (chronological)
  if (gpsPhotos.length>1){
    const coords = gpsPhotos.map(p=>[p.lat, p.lon]);
    L.polyline(coords, { color:"#3b82f6", weight:3, opacity:.7 }).addTo(map);
  }

  // photo markers with zoom-responsive sizing
  gpsPhotos.forEach(photo=>{
    const thumb = photo.thumb || photo.url;
    const markerSize = getMarkerSize(map.getZoom(), isTopMap);

    const m = L.marker([photo.lat, photo.lon], {
      icon: L.divIcon({
        className: `photo-marker${photo.stackId===activeStackId?' active':''}`,
        html: `<div class="pm__wrap"><img src="${thumb}" alt=""></div>`,
        iconSize:[markerSize, markerSize],
        iconAnchor:[markerSize/2, markerSize/2]
      })
    }).addTo(map);
    m.on("click", ()=>onMarkerClick(photo.stackId));
    // store id and map reference for updates
    m.stackId = photo.stackId;
    m.isTopMap = isTopMap;
  });

  // Add zoom event listener for responsive sizing
  if (isTopMap) {
    map.on('zoomend', () => updateMarkerSizes(map));
  }
}

function getMarkerSize(zoom, isTopMap = true) {
  if (!isTopMap) return 24; // Keep mini-map markers small and fixed
  
  // Responsive sizing for top map: smaller base, scales with zoom
  const baseSize = 28; // Reduced from 48
  const zoomFactor = Math.max(0.6, Math.min(1.4, (zoom - 8) * 0.15 + 1));
  return Math.round(baseSize * zoomFactor);
}

function updateMarkerSizes(map) {
  const currentZoom = map.getZoom();
  map.eachLayer(layer => {
    if (layer.stackId && layer.isTopMap) {
      const newSize = getMarkerSize(currentZoom, true);
      const prev = layer.getIcon(); // DivIcon
      layer.setIcon(L.divIcon({
        className: prev.options.className,
        html: prev.options.html,
        iconSize: [newSize, newSize],
        iconAnchor: [newSize / 2, newSize / 2]
      }));
    }
  });
}



function onMarkerClick(id){
  setActive(id);
  pushUrlParam("stack", id);
  scrollToStack(id);
}

// ---------- feed ----------
function renderFeed(){
  const host = document.getElementById("stack-feed");
  host.innerHTML = "";
  photoStacks.forEach((stack,i)=>{
    const card = document.createElement("div");
    card.className = `stack-card${stack.id===activeStackId?' active':''}`;
    card.id = stack.id; card.dataset.stackId = stack.id; card.tabIndex = 0;

    const t = fmtTime(stack.takenAt);
    card.innerHTML = `
      <div class="stack-card-header">
        ${stack.title ? `<h2 class="stack-card-title">${escapeHtml(stack.title)}</h2>` : ''}
        <div class="stack-location-time">${stack.location.label} • ${t}</div>
      </div>
      ${stack.caption ? `<p class="caption">${escapeHtml(stack.caption)}</p>` : ''}

      <div class="stack-photo-area" data-stack-id="${stack.id}">
        <div class="stack-media-container">
          <img class="stack-main-photo" src="${stack.photos[0].url}" alt="" draggable="false">
          ${stack.photos.length>1 ? `
              <button class="stack-photo-nav prev" data-dir="-1" aria-label="Prev">‹</button>
              <button class="stack-photo-nav next" data-dir="1" aria-label="Next">›</button>` : ``}
        </div>
        ${stack.photos.length>1 ? `
          <div class="stack-thumbnail-drawer" data-stack-id="${stack.id}">
            <button class="thumb-scroll left" aria-label="Scroll thumbnails left">‹</button>
            <div class="drawer-thumbnails">
              ${stack.photos.map((p,idx)=>`
                <img class="drawer-thumbnail ${idx===0?'active':''}"
                     src="${p.thumb || p.url}" data-index="${idx}" draggable="false" alt="">
              `).join('')}
            </div>
            <button class="thumb-scroll right" aria-label="Scroll thumbnails right">›</button>
          </div>` : ``}
      </div>

      <!-- PERMANENT inline interactions -->
      <section class="stack-interactions" data-stack-id="${stack.id}">
        <div class="stack-reaction-pills">
          <button class="reaction-pill like-pill" type="button" aria-pressed="false">
            <span>♥</span><span class="count">0</span>
          </button>
          <button class="reaction-pill comment-pill" type="button">
            <span>💬</span><span class="count">0</span>
          </button>
      </div>

        <ul class="comment-list"></ul>

        <form class="comment-form" autocomplete="off">
          <input name="text" placeholder="Leave a comment…" />
          <button type="submit">Post</button>
        </form>
      </section>
    `;

    // events
    const main = card.querySelector(".stack-main-photo");
    const drawer = card.querySelector(".stack-thumbnail-drawer");
    
    // Keep current index for navigation
    let current = 0;

    function updateMain() {
      main.src = stack.photos[current].url;
      if (drawer) {
        drawer.querySelectorAll(".drawer-thumbnail").forEach((t, i) => {
          t.classList.toggle("active", i === current);
        });
      }
    }

    // Main photo click opens lightbox at current index
    main.addEventListener("click", ()=>openLightboxForStack(stack, current));

    // Wire prev/next navigation buttons
    const navBtns = card.querySelectorAll(".stack-photo-nav");
    navBtns.forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const dir = Number(btn.dataset.dir);
        const len = stack.photos.length;
        current = (current + dir + len) % len;
        updateMain();
      });
    });

    if (drawer) {
      const thumbWrap = drawer.querySelector('.drawer-thumbnails');
      const leftBtn = drawer.querySelector('.thumb-scroll.left');
      const rightBtn = drawer.querySelector('.thumb-scroll.right');

      // click a thumb -> change main photo
      drawer.querySelectorAll('.drawer-thumbnail').forEach(img=>{
        img.onclick = ()=>{
          const idx = +img.dataset.index;
          main.src = stack.photos[idx].url;
          current = idx; // Update current index
          drawer.querySelectorAll('.drawer-thumbnail').forEach(t=>t.classList.toggle('active', t===img));
        };
      });

      // arrow buttons scroll the row
      leftBtn.onclick  = ()=> thumbWrap.scrollBy({ left: -thumbWrap.clientWidth * 0.9, behavior: 'smooth' });
      rightBtn.onclick = ()=> thumbWrap.scrollBy({ left:  thumbWrap.clientWidth * 0.9, behavior: 'smooth' });

      // wheel to scroll horizontally (nice on trackpads)
      thumbWrap.addEventListener('wheel', (e)=>{
        if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
          e.preventDefault();
          thumbWrap.scrollBy({ left: e.deltaY, behavior: 'auto' });
        }
      }, { passive:false });

      // show arrows only if overflow
      function updateOverflow(){
        const has = thumbWrap.scrollWidth > thumbWrap.clientWidth + 1;
        drawer.classList.toggle('has-overflow', has);
      }
      new ResizeObserver(updateOverflow).observe(thumbWrap);
      setTimeout(updateOverflow, 0);
    }

    // card bg click -> center map
    card.addEventListener("click", (e)=>{
      if (e.target.closest(".stack-media-container") || e.target.closest(".stack-interactions") || e.target.closest(".stack-thumbnail-drawer")) return;
      setActive(stack.id); replaceUrlParam("stack", stack.id); panMiniMapTo(stack.id);
    });

    host.appendChild(card);

    // Bind interactions functionality using new helpers
    const interactionsBlock = card.querySelector('.stack-interactions');
    bindStackInteractions(stack.id, interactionsBlock);
    loadStackInteractions(stack.id, interactionsBlock);
  });
}

// ----- Stack Interactions Helpers -----

// Load and render stack interactions in new format
async function loadStackInteractions(stackId, block){
  try {
    // GET interactions
    const res = await fetch(`${getApiBase()}/api/stack/${stackId}/interactions`);
    const data = await res.json();
    const ul = block.querySelector('.comment-list');
    const likeCountEl = block.querySelector('.like-pill .count');
    const commentCountEl = block.querySelector('.comment-pill .count');
    
    // Update counts
    const likeCount = Object.values(data.reactions || {}).reduce((a,b)=>a+b,0);
    likeCountEl.textContent = likeCount;
    commentCountEl.textContent = (data.comments?.length || 0);

    // Render comments
    ul.innerHTML = '';
    (data.comments || []).forEach(c=>{
      ul.appendChild(renderStackComment(c));
    });
  } catch(e) {
    // fallback on error
    block.querySelector('.like-pill .count').textContent = '0';
    block.querySelector('.comment-pill .count').textContent = '0';
  }
}

function renderStackComment(c){
  const li = document.createElement('li');
  li.className = 'comment';
  li.innerHTML = `
    <div class="meta">${escapeHtml(c.author || 'Anonymous')} • ${new Date(c.timestamp || c.edited || Date.now()).toLocaleString([], {hour:'2-digit', minute:'2-digit', day:'2-digit', month:'short'})}</div>
    <div class="text">${escapeHtml(c.text || '')}</div>
  `;
  return li;
}

// Bind events for stack interactions block
function bindStackInteractions(stackId, block){
  const likePill = block.querySelector('.like-pill');
  const commentPill = block.querySelector('.comment-pill');
  const form = block.querySelector('.comment-form');
  const input = form.querySelector('input[name="text"]');

  // Use existing like chip logic
  initLikeChip(block, 'stack', stackId);

  // Comment form submission
  form.addEventListener('submit', async (e)=>{
    e.preventDefault();
    const text = input.value.trim(); 
    if (!text) return;
    
    const ul = block.querySelector('.comment-list');
    const temp = { author:'You', text, timestamp:new Date().toISOString() };
    ul.appendChild(renderStackComment(temp));
    input.value = '';

    try{
      const res = await fetch(`${getApiBase()}/api/stack/${stackId}/comment`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ text })
      });
      const out = await res.json();
      // bump count
      const cnt = block.querySelector('.comment-pill .count');
      cnt.textContent = (+cnt.textContent || 0) + 1;
    }catch{
      // rollback UI on error
      ul.lastElementChild.remove();
    }
  });
}

// ----- Comments Block Helpers (Legacy) -----

// Render comments into a block
async function loadAndRenderComments(stackId, block){
  try {
    // GET interactions (your backend already returns {reactions, comments})
    const res = await fetch(`${getApiBase()}/api/stack/${stackId}/interactions`);
    const data = res.ok ? await res.json() : {reactions:{}, comments:[]};
    const ul = block.querySelector('.comment-list');
    const countEl = block.querySelector('.comment-count');
    countEl.textContent = (data.comments?.length || 0);

    ul.innerHTML = '';
    (data.comments || []).forEach(c=>{
      ul.appendChild(renderCommentItem(c));
    });
    if ((data.comments?.length || 0) > 0) ul.hidden = false;

    // like count (sum stack reactions)
    const likeCount = Object.values(data.reactions || {}).reduce((a,b)=>a+b,0);
    block.querySelector('.like-count').textContent = likeCount;
  } catch(e) {
    // fallback on error
    block.querySelector('.like-count').textContent = '0';
    block.querySelector('.comment-count').textContent = '0';
  }
}

function renderCommentItem(c){
  const li = document.createElement('li');
  li.className = 'comment-item';
  const initials = (c.author || 'A').trim()[0]?.toUpperCase() || 'A';
  li.innerHTML = `
    <div class="comment-avatar">${initials}</div>
    <div class="comment-bubble">
      <div class="comment-head">
        <span class="comment-author">${escapeHtml(c.author || 'Anonymous')}</span>
        <span class="comment-time">${new Date(c.timestamp || c.edited || Date.now()).toLocaleString([], {hour:'2-digit', minute:'2-digit', day:'2-digit', month:'short'})}</span>
      </div>
      <div class="comment-text">${escapeHtml(c.text || '')}</div>
    </div>`;
  return li;
}

function escapeHtml(s){ return s.replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

function likeKey(kind, id){ return `liked:${kind}:${id}`; }

function initLikeChip(block, kind, id){
  const api = getApiBase();
  const btn = block.querySelector('.chip-like') || block.querySelector('.like-pill');
  const countEl = block.querySelector('.like-count') || block.querySelector('.like-pill .count');
  if(!btn) return;

  // restore local state
  let liked = localStorage.getItem(likeKey(kind, id)) === '1';
  const likedClass = btn.classList.contains('like-pill') ? 'liked' : 'active';
  btn.classList.toggle(likedClass, liked);
  btn.setAttribute('aria-pressed', liked);

  btn.addEventListener('click', async ()=>{
    if (btn._busy) return;
    btn._busy = true;

    liked = !liked;
    btn.classList.toggle(likedClass, liked);
    btn.setAttribute('aria-pressed', liked);
    localStorage.setItem(likeKey(kind, id), liked ? '1' : '0');

    try{
      const res = await fetch(`${api}/api/${kind}/${id}/react`, {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ emoji:'♥', action: liked ? 'add' : 'remove' })
      });
      const out = await res.json();
      if (typeof out.count === 'number') countEl.textContent = out.count;
    }catch(e){
      // rollback UI if request fails
      liked = !liked;
      btn.classList.toggle('active', liked);
      btn.setAttribute('aria-pressed', liked);
      localStorage.setItem(likeKey(kind, id), liked ? '1' : '0');
    }finally{
      btn._busy = false;
    }
  });
}

// Bind events for one block
function bindCommentsBlock(stackId, block){
  // chip toggles visibility
  block.querySelector('.chip-cmt')?.addEventListener('click', ()=>{
    const ul = block.querySelector('.comment-list');
    ul.hidden = !ul.hidden;
  });

  // composer
  const form = block.querySelector('.comment-composer');
  form.addEventListener('submit', async (e)=>{
    e.preventDefault();
    const input = form.querySelector('.comment-input');
    const text = input.value.trim(); if (!text) return;
    // optimistic add
    const temp = { id: 'temp-'+Date.now(), author: 'You', text, timestamp: new Date().toISOString() };
    const ul = block.querySelector('.comment-list'); ul.hidden = false;
    ul.appendChild(renderCommentItem(temp));
    input.value = '';

    try{
      const res = await fetch(`${getApiBase()}/api/stack/${stackId}/comment`, {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ text })
      });
      const out = await res.json();
      // replace the temp node with server one (optional: re-render)
      ul.lastElementChild.replaceWith(renderCommentItem(out.comment || temp));
      // bump counter
      const cnt = block.querySelector('.comment-count');
      cnt.textContent = (+cnt.textContent || 0) + 1;
    }catch{
      // rollback UI on error
      ul.lastElementChild.remove();
    }
  });
}


// ---------- lightbox (new photo-focused viewer) ----------
function closeLightbox(){
  // Handle global lbRoot reference
  if (window.lbRoot) {
    window.lbRoot.remove();
    window.lbRoot = null;
  }
  
  // Handle local lbRoot reference
  if (lbRoot) {
    lbRoot.remove();
    lbRoot = null;
  }
  
  // Clean up event handlers
  if (window.lbEscHandler) {
    document.removeEventListener('keydown', window.lbEscHandler);
    window.lbEscHandler = null;
  }
  if (lbEscHandler) {
    document.removeEventListener('keydown', lbEscHandler);
    lbEscHandler = null;
  }
  
  // unlock page scroll
  document.documentElement.style.overflow = '';
  document.body.style.overflow = '';
}

function openLightboxForStack(stack, startIndex=0){
  // Convert stack photos to the format expected by the new lightbox
  const photos = stack.photos.map(photo => ({
    id: photo.id,
    url: photo.url,
    thumb: photo.thumb || photo.url,
    caption: photo.caption || '',
    taken_at: photo.taken_at,
    lat: photo.lat,
    lon: photo.lon
  }));
  
  // Use the new lightbox API
  if (window.openPhotoLightbox) {
    window.openPhotoLightbox(photos, startIndex);
  }
}

// ---------- sync ----------
function setActive(id){
  activeStackId = id;
  updateMarkerClasses();
  document.querySelectorAll(".stack-card").forEach(c=> c.classList.toggle("active", c.id===id));
  panTopMapTo(id);
}

function updateMarkerClasses(){
  if (!topMap) return;
  // Update marker visual states based on activeStackId
  topMap.eachLayer(layer => {
    if (layer.stackId) {
      const marker = layer.getElement ? layer.getElement() : layer._icon;
      if (marker) {
        marker.classList.toggle('active', layer.stackId === activeStackId);
      }
    }
  });
}

function scrollToStack(id, { instant=false } = {}){
  const el = document.getElementById(id); if (!el) return;
  scrollLocked = true;
  const top = window.scrollY + el.getBoundingClientRect().top - 16;
  window.scrollTo({ top, behavior: instant ? "auto" : "smooth" });
  setTimeout(()=>{ scrollLocked=false; }, 600);
}

const panTopMapTo = debounce((id)=>{
  const s = photoStacks.find(x=>x.id===id); if (!s || !topMap) return;
  topMap.panTo([s.location.lat, s.location.lng], { animate:true, duration:.3 });
}, 120);

// Backwards-compatible alias
const panMiniMapTo = panTopMapTo;

function setupScrollSync(){
  const io = new IntersectionObserver((entries)=>{
    if (scrollLocked) return;
    let best=null, mid=window.innerHeight/2, score=Infinity;
    entries.forEach(e=>{
      if (!e.isIntersecting) return;
      const r=e.target.getBoundingClientRect();
      const d=Math.abs((r.top+r.bottom)/2 - mid);
      if (d<score){ score=d; best=e; }
    });
    if (best){
      const id = best.target.id;
      if (id && id!==activeStackId){ activeStackId=id; replaceUrlParam("stack", id); setActive(id); }
    }
  }, { root:null, rootMargin:"-20% 0px -40% 0px", threshold:[0.25,0.5,0.75] });

  photoStacks.forEach(s=>{ const el=document.getElementById(s.id); if (el) io.observe(el); });
}

function setupStickyMiniMap(){
  const cont = document.getElementById("mini-map-container");
  const topSection = document.querySelector(".top-map-wrap");
  const toggle = document.getElementById("mini-map-toggle");
  const icon = toggle.querySelector(".toggle-icon");

  // show when top map scrolls out
  const obs = new IntersectionObserver(([e])=>{
    cont.classList.toggle("hidden", e.isIntersecting);
  }, { threshold: 0 });
  obs.observe(topSection);

  toggle.onclick = ()=>{
    cont.classList.toggle("hidden");
    icon.textContent = cont.classList.contains("hidden") ? "+" : "−";
    setTimeout(()=>miniMap.invalidateSize(), 250);
  };
}

// ---------- full-screen map overlay ----------
let _mapOverlayEl = null;
let _mapOverlayMap = null;

function closeMapOverlay(){
  if (_mapOverlayMap) { _mapOverlayMap.remove(); _mapOverlayMap = null; }
  if (_mapOverlayEl)   { _mapOverlayEl.remove(); _mapOverlayEl = null; }
  // unlock scroll if you lock it elsewhere
  document.documentElement.style.overflow = '';
  document.body.style.overflow = '';
}

function openMapOverlayAt(lat, lon, title=''){
  // build overlay DOM
  _mapOverlayEl = document.createElement('div');
  _mapOverlayEl.className = 'map-overlay';
  _mapOverlayEl.innerHTML = `
    <div class="map-overlay__bar">
      <div class="map-overlay__title">${title ? title : 'Photo location'}</div>
      <button class="map-overlay__close" aria-label="Close">
        <svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" fill="none" stroke-width="2"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
    </div>
    <div id="overlay-map" role="region" aria-label="Map"></div>
  `;
  document.body.appendChild(_mapOverlayEl);

  // close interactions
  _mapOverlayEl.querySelector('.map-overlay__close').onclick = closeMapOverlay;
  document.addEventListener('keydown', function esc(e){ if(e.key==='Escape'){ closeMapOverlay(); document.removeEventListener('keydown', esc);} });

  // (optional) lock page scroll
  document.documentElement.style.overflow = 'hidden';
  document.body.style.overflow = 'hidden';

  // create Leaflet map
  const center = [lat, lon];
  _mapOverlayMap = L.map('overlay-map', { zoomControl: true });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution:'&copy; OSM contributors', maxZoom: 19
  }).addTo(_mapOverlayMap);

  L.marker(center).addTo(_mapOverlayMap).bindPopup(title || `${lat.toFixed(4)}, ${lon.toFixed(4)}`).openPopup();
  _mapOverlayMap.setView(center, 14);
}

// expose if you call from other modules
window.openMapOverlayAt = openMapOverlayAt;
window.closeMapOverlay   = closeMapOverlay;

// Patch close function to dispatch event for page map panning
(function patchClose(){
  const old = closeMapOverlay;
  window.closeMapOverlay = function(){
    old();
    const evt = new Event('map:closed');
    document.dispatchEvent(evt);
  };
})();


