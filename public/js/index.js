import { getApiBase, haversineKm, debounce, urlParam, pushUrlParam, replaceUrlParam, fmtTime } from "./utils.js";

const isMobile = matchMedia('(max-width:768px)').matches;
let topMap; // no mini-map when sticky hero map is always visible
let photoStacks = [];
let activeStackId = null;
let scrollLocked = false;

const currentLocation = { lat: 35.6762, lng: 139.6503, name: "Tokyo, Japan" };

// Expose getApiBase to global window for lightbox script
window.getApiBase = getApiBase;

// Expose interaction functions for lightbox script
window.fetchPhotoInteractions = fetchPhotoInteractions;
window.reactPhoto = reactPhoto;
window.commentPhoto = commentPhoto;

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
  setupScrollSync();

  const initial = urlParam("stack") || (photoStacks[0]?.id);
  if (initial){ setActive(initial); requestAnimationFrame(()=>scrollToStack(initial, {instant:true})); }
}

// ---------- data ----------
function groupIntoStacks(photos, radiusMeters) {
  const stacks = [];
  const used = new Set();
  const radiusKm = radiusMeters / 1000; // convert meters to kilometers
  let idx = 0;

  for (let i = 0; i < photos.length; i++) {
    if (used.has(i)) continue;
    const a = photos[i];
    const group = [a];
    used.add(i);

    for (let j = i + 1; j < photos.length; j++) {
      if (used.has(j)) continue;
      const b = photos[j];
      if (haversineKm(a.lat, a.lon, b.lat, b.lon) <= radiusKm) {
        group.push(b);
        used.add(j);
      }
    }

    stacks.push({
      id: `stack-${idx++}`,
      title: a.caption || a.dayTitle,
      location: { lat: a.lat, lng: a.lon, label: `${a.lat.toFixed(4)}, ${a.lon.toFixed(4)}` },
      photos: group,
      takenAt: a.taken_at
    });
  }

  return stacks;
}

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
  const days = await (await fetch("days/index.json")).json();
  const all = [];
  await Promise.all(days.map(async d=>{
    const dj = await (await fetch(`days/${d.slug}.json`)).json();
    (dj.photos||[]).forEach(p=> all.push({ ...p, dayTitle:dj.title, ts:+new Date(p.taken_at) }));
  }));
  all.sort((a,b)=>a.ts-b.ts);

  // group photos into stacks by proximity
  photoStacks = groupIntoStacks(all, 50);
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
  photoStacks.forEach(s=>b.extend([s.location.lat,s.location.lng]));
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

  // path (chronological)
  if (photoStacks.length>1){
    const coords = photoStacks.map(s=>[s.location.lat, s.location.lng]);
    L.polyline(coords, { color:"#3b82f6", weight:3, opacity:.7 }).addTo(map);
  }

  // photo markers with zoom-responsive sizing
  photoStacks.forEach(stack=>{
    const rep = stack.photos[0];
    const thumb = rep.thumb || rep.url;
    const markerSize = getMarkerSize(map.getZoom(), isTopMap);
    
    const m = L.marker([stack.location.lat, stack.location.lng], {
      icon: L.divIcon({
        className: `photo-marker${stack.id===activeStackId?' active':''}`,
        html: `<div class="pm__wrap"><img src="${thumb}" alt=""></div>`,
        iconSize:[markerSize, markerSize], 
        iconAnchor:[markerSize/2, markerSize/2]
      })
    }).addTo(map);
    m.on("click", ()=>onMarkerClick(stack.id));
    // store id and map reference for updates
    m.stackId = stack.id;
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
        <div class="stack-location-time">${stack.location.label} • ${t}</div>
      </div>

      <div class="stack-photo-area" data-stack-id="${stack.id}">
        <div class="stack-media-container">
          <img class="stack-main-photo" src="${stack.photos[0].url}" alt="" draggable="false">
          ${
            stack.photos.length>1 ? `
              <button class="stack-photo-nav prev" data-dir="-1" aria-label="Prev">‹</button>
              <button class="stack-photo-nav next" data-dir="1" aria-label="Next">›</button>
              <div class="thumb-rail" data-stack-id="${stack.id}">
                <button class="rail-nav rail-left" aria-label="Scroll thumbnails left">‹</button>
                <div class="rail-track" role="listbox" aria-label="Stack thumbnails">
                  ${stack.photos.map((p, idx) => `
                    <div class="rail-thumb ${idx===0?'active':''}" data-index="${idx}" role="option" aria-selected="${idx===0}">
                      <img src="${p.thumb || p.url}" alt="">
                    </div>
                  `).join('')}
                </div>
                <button class="rail-nav rail-right" aria-label="Scroll thumbnails right">›</button>
                <button class="rail-expand" aria-expanded="false" title="Expand thumbnails">⋯</button>
              </div>` : ""
          }
        </div>
      </div>

      <div class="stack-actions">
        <button class="stack-action-btn like-btn" data-action="like" aria-pressed="false">
          <span class="heart-icon">♥</span> <span class="like-count">0</span>
        </button>
        <button class="stack-action-btn comment-btn" data-action="comment">
          💬 <span class="comment-count">0</span>
        </button>
      </div>

      <div class="stack-comments" hidden>
        <div class="comments-list" data-role="list"></div>
        <div class="comment-composer">
          <textarea class="comment-input" rows="1" placeholder="Leave a comment…"></textarea>
          <button class="comment-submit">Post</button>
        </div>
      </div>
    `;

    // events
    const main = card.querySelector(".stack-main-photo");
    const rail = card.querySelector(".thumb-rail");
    const expandBtn = card.querySelector(".rail-expand");
    
    // Keep current index for navigation
    let current = 0;

    function updateMain() {
      main.src = stack.photos[current].url;
      if (rail) {
        rail.querySelectorAll(".rail-thumb").forEach((t, i) => {
          t.classList.toggle("active", i === current);
          t.setAttribute("aria-selected", i === current);
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

    if (rail) {
      const track = rail.querySelector(".rail-track");
      const left  = rail.querySelector(".rail-left");
      const right = rail.querySelector(".rail-right");
      const expandBtn = rail.querySelector(".rail-expand");

      // click a thumbnail -> swap main photo
      track.querySelectorAll(".rail-thumb").forEach(el => {
        el.addEventListener("click", () => {
          const idx = +el.dataset.index;
          main.src = stack.photos[idx].url;
          current = idx; // Update current index
          track.querySelectorAll(".rail-thumb").forEach(t => {
            t.classList.toggle("active", t === el);
            t.setAttribute("aria-selected", t === el ? "true" : "false");
          });
        });
      });

      // rail scrolling
      const scrollBy = () => Math.min(track.clientWidth * 0.9, 320);
      left.onclick  = () => track.scrollBy({ left: -scrollBy(), behavior: 'smooth' });
      right.onclick = () => track.scrollBy({ left:  scrollBy(), behavior: 'smooth' });

      // expand / collapse
      expandBtn.onclick = () => {
        const expanded = rail.classList.toggle("expanded");
        expandBtn.setAttribute("aria-expanded", expanded);
      };

      // swipe/drag-to-scroll
      makeDragScrollable(track);

      // Optional keyboard navigation when rail has focus
      track.addEventListener('keydown', (e) => {
        const thumbs = [...track.querySelectorAll('.rail-thumb')];
        const activeIdx = thumbs.findIndex(t => t.classList.contains('active'));
        if (e.key === 'ArrowRight' && activeIdx < thumbs.length - 1) thumbs[activeIdx + 1].click();
        if (e.key === 'ArrowLeft'  && activeIdx > 0)                   thumbs[activeIdx - 1].click();
      });
    }

    // card bg click -> center map
    card.addEventListener("click", (e)=>{
      if (e.target.closest(".stack-media-container") || e.target.closest(".stack-actions") || e.target.closest(".thumb-rail")) return;
      setActive(stack.id); replaceUrlParam("stack", stack.id); panMiniMapTo(stack.id);
    });

    host.appendChild(card);

    // ----- hydrate interactions (likes + comments)
    (async () => {
      const data = await fetchStackInteractions(stack);
      const likeBtn = card.querySelector(".like-btn");
      const likeCountEl = card.querySelector(".like-count");
      const commentBtn = card.querySelector(".comment-btn");
      const commentCountEl = card.querySelector(".comment-count");
      const commentsWrap = card.querySelector(".stack-comments");
      const list = commentsWrap.querySelector('[data-role="list"]');
      const input = commentsWrap.querySelector(".comment-input");
      const postBtn = commentsWrap.querySelector(".comment-submit");

      // counts
      const totalReactions = Object.values(data.rollup?.reactions || {}).reduce((a,b)=>a+b,0);
      likeCountEl.textContent = totalReactions;
      commentCountEl.textContent = data.rollup?.totalCommentCount || (data.rollup?.comments?.length || 0);

      // render comments (stack roll-up list)
      list.innerHTML = (data.rollup?.comments || [])
        .slice(-15) // show recent 15
        .map(c => `
          <div class="comment-item">
            <div class="comment-author">${c.author || "Anon"}</div>
            <div class="comment-text">${(c.text || "").replace(/</g,"&lt;")}</div>
            <div class="comment-time">${new Date(c.timestamp || Date.now()).toLocaleString()}</div>
          </div>
        `).join("");

      // reveal comments when clicking 💬 or when there are any
      const openComments = () => {
        commentsWrap.hidden = false;
        input.focus();
      };
      if ((data.rollup?.comments || []).length) commentsWrap.hidden = false;
      commentBtn.addEventListener("click", openComments);

      // like toggle (remember local state)
      const key = `liked:stack:${stack.id}`;
      let liked = localStorage.getItem(key) === "1";
      const paintLiked = () => likeBtn.classList.toggle("liked", liked);
      paintLiked();

      likeBtn.addEventListener("click", async () => {
        const r = await reactStack(stack.id, liked);
        if (r?.ok) {
          liked = !liked; localStorage.setItem(key, liked ? "1" : "");
          likeCountEl.textContent = r.count ?? likeCountEl.textContent;
          paintLiked();
        }
      });

      // post comment
      postBtn.addEventListener("click", async () => {
        const text = input.value.trim();
        if (!text) return;
        const c = await commentStack(stack.id, text);
        if (c) {
          list.insertAdjacentHTML("beforeend", `
            <div class="comment-item">
              <div class="comment-author">${c.author}</div>
              <div class="comment-text">${c.text.replace(/</g,"&lt;")}</div>
              <div class="comment-time">${new Date(c.timestamp).toLocaleString()}</div>
            </div>
          `);
          input.value = "";
          commentCountEl.textContent = (+commentCountEl.textContent || 0) + 1;
        }
      });
    })();
  });
}

// ---------- lightbox (new photo-focused viewer) ----------
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
