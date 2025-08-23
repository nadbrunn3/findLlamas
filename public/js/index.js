import { dataUrl, getApiBase, groupIntoStacks, debounce, urlParam, pushUrlParam, replaceUrlParam, fmtTime, escapeHtml, formatDate } from "./utils.js";

const isMobile = matchMedia('(max-width:768px)').matches;
let topMap;
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

// --- Reverse geocode caching ---
const GEO_CACHE_KEY = 'geocodeCache';
const geocodeCache = JSON.parse(localStorage.getItem(GEO_CACHE_KEY) || '{}');

async function reverseGeocode(lat, lon) {
  const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
  if (geocodeCache[key]) return geocodeCache[key];
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}`;
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      const addr = data.address || {};
      const city = addr.city || addr.town || addr.village || addr.hamlet;
      const region = addr.state || addr.region || addr.province || addr.state_district;
      const country = addr.country;
      const nameParts = [region, city, country].filter(Boolean);
      const name = nameParts.length ? nameParts.join(', ') : `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
      geocodeCache[key] = name;
      localStorage.setItem(GEO_CACHE_KEY, JSON.stringify(geocodeCache));
      return name;
    }
  } catch (e) {
    console.warn('reverse geocode failed', e);
  }
  return `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
}

async function resolveStackLocations() {
  const jobs = photoStacks.map(async (s) => {
    const { lat, lng } = s.location;
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      s.location.label = await reverseGeocode(lat, lng);
    }
  });
  await Promise.all(jobs);
}

// Expose getApiBase to global window for lightbox script
window.getApiBase = getApiBase;

// Expose interaction functions for lightbox script
window.fetchPhotoInteractions = fetchPhotoInteractions;
window.reactPhoto = reactPhoto;
window.commentPhoto = commentPhoto;

// Expose lightbox functions
window.closeLightbox = closeLightbox;

// ---- Video/Media helpers ----
function isVideo(item) {
  const mt = (item?.mimeType || '').toLowerCase();
  const url = (item?.url || '').toLowerCase();
  const k = (item?.kind || '').toLowerCase();
  return (
    k === 'video' ||
    mt.startsWith('video/') ||
    /\.(mp4|webm|mov|m4v)$/i.test(url)
  );
}

function renderMediaEl(item, { withControls = false, className = '', useThumb = false } = {}) {
  if (isVideo(item)) {
    // If we have a thumb, show it as poster; otherwise the video will still render
    const v = document.createElement('video');
    v.src = item.url;
    if (item.thumb) v.poster = item.thumb;
    v.muted = true;
    v.playsInline = true;
    v.loop = true;
    v.controls = !!withControls;
    v.setAttribute('preload', 'metadata');
    if (className) v.className = className;
    return v;
  }
  // Photo - use full resolution by default, thumbnail only when explicitly requested
  const img = document.createElement('img');
  img.src = useThumb ? (item.thumb || item.url) : (item.url || item.thumb);
  img.alt = item.title || item.caption || '';
  img.loading = 'lazy';
  img.decoding = 'async';
  if (className) img.className = className;
  return img;
}

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
  await resolveStackLocations();
  initMaps();
  renderFeed();

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
    try {
      const res = await fetch(dataUrl("days", "index.json"));
      const days = res.ok ? await res.json() : [];
      if (Array.isArray(days) && days.length > 0) {
  await Promise.all(days.map(async d=>{
          try {
            const dj = await (await fetch(dataUrl("days", `${d.slug}.json`))).json();
            stackMetaByDay[d.slug] = dj.stackMeta || {};
            (dj.photos||[]).forEach(p=> allPhotos.push({ ...p, dayTitle:dj.title, daySlug:d.slug, ts:+new Date(p.taken_at) }));
          } catch (e) {
            console.warn(`Failed to load day ${d.slug}:`, e);
          }
        }));
      } else {
        console.log("No days found in index.json");
      }
    } catch (e) {
      console.warn("Failed to load days index:", e);
    }
  }

  allPhotos.sort((a,b)=>a.ts-b.ts);

  // group photos into stacks by proximity (500m radius)
  photoStacks = groupIntoStacks(allPhotos, 500);

  // apply saved metadata and tag photos with stack id
  // stack IDs from groupIntoStacks() are global, but stackMeta is stored
  // per-day with local "stack-0", "stack-1" IDs. Track how many stacks
  // we've seen for each day so we can look up the correct metadata key.
  const dayStackCounters = {};
  photoStacks.forEach(s => {
    const slug = s.photos[0]?.daySlug;
    const idx = dayStackCounters[slug] || 0;
    dayStackCounters[slug] = idx + 1;
    const metaKey = `stack-${idx}`;
    const meta = stackMetaByDay[slug]?.[metaKey];
    const title = meta?.title?.trim();
    s.title = title || formatDate(s.takenAt);
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
  topMap.fitBounds(b, { padding:[20,20], maxZoom:3 });

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

function getMarkerSize(zoom) {
  // Responsive sizing for top map: smaller base, scales with zoom
  const baseSize = 28; // Reduced from 48
  const zoomFactor = Math.max(0.6, Math.min(1.4, (zoom - 8) * 0.15 + 1));
  return Math.round(baseSize * zoomFactor);
}

function updateMarkerSizes(map) {
  const currentZoom = map.getZoom();
  map.eachLayer(layer => {
    if (layer.stackId && layer.isTopMap) {
      const newSize = getMarkerSize(currentZoom);
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
  const seenCounts = JSON.parse(localStorage.getItem("stackPhotoCounts") || "{}");
  const newCounts = {};
  photoStacks.forEach((stack,i)=>{
    newCounts[stack.id] = stack.photos.length;
    const hasNew = stack.photos.length > (seenCounts[stack.id] || 0);
    const card = document.createElement("div");
    card.className = `stack-card${stack.id===activeStackId?' active':''}`;
    card.id = stack.id; card.dataset.stackId = stack.id; card.tabIndex = 0;

    const t = fmtTime(stack.takenAt);
    card.innerHTML = `
      <div class="stack-photo-area" data-stack-id="${stack.id}">
        <div class="stack-media-container">
          <div class="photo-main" data-main-container="${stack.id}"></div>
          ${stack.photos.length>1 ? `
              <button class="stack-photo-nav prev" data-dir="-1" aria-label="Prev">‹</button>
              <button class="stack-photo-nav next" data-dir="1" aria-label="Next">›</button>` : ``}
        </div>
        ${stack.photos.length>1 ? `
          <div class="stack-thumbnail-drawer" data-stack-id="${stack.id}">
            <button class="thumb-scroll left" aria-label="Scroll thumbnails left">‹</button>
            <div class="drawer-thumbnails"></div>
            <button class="thumb-scroll right" aria-label="Scroll thumbnails right">›</button>
          </div>` : ``}
        
        <!-- Media Actions Bar -->
        <div class="stack-media-actions">
          <button class="reaction-pill like-pill" type="button" aria-pressed="false">
            <span>♥</span><span class="count">0</span>
          </button>
        </div>
      </div>

      <div class="stack-card-header">
        ${stack.title ? `<h2 class="stack-card-title">${escapeHtml(stack.title)}</h2>` : ''}
        <div class="stack-location-time">${stack.location.label} • ${t}</div>
        ${hasNew ? '<span class="new-photo-bell" aria-label="New photos">🔔</span>' : ''}
      </div>
      ${stack.caption ? `<p class="caption">${escapeHtml(stack.caption)}</p>` : ''}

      <!-- PERMANENT inline interactions -->
      <section class="stack-interactions" data-stack-id="${stack.id}">
        <!-- Discussion Thread -->
        <div class="discussion-thread">
          <div class="thread-header">
            <button class="thread-toggle" type="button" aria-expanded="false">
              <span class="thread-count">View 0 comments</span>
          </button>
      </div>

          <div class="thread-container" style="display: none;">
            <div class="thread-empty" style="display: none;">
              <p>Be the first to comment</p>
            </div>
            
            <ul class="comment-list" role="list" aria-label="Comments"></ul>
            
            <div class="load-more-comments" style="display: none;">
              <button class="load-more-btn">Show earlier comments</button>
            </div>
          </div>

          <form class="comment-composer" autocomplete="off">
            <textarea name="text" placeholder="Leave a comment…" rows="1" aria-label="Write a comment"></textarea>
            <div class="composer-actions">
              <button type="submit" class="post-btn">Post</button>
            </div>
        </form>
        </div>

        <div aria-live="polite" class="sr-only comment-status"></div>
      </section>
    `;

    // events
    const mainContainer = card.querySelector(".photo-main");
    const drawer = card.querySelector(".stack-thumbnail-drawer");
    
    // Keep current index for navigation
    let current = 0;

    function updateMain() {
      if (!mainContainer) return;
      
      const mainPhoto = stack.photos[current];
      
      // Clear previous content
      mainContainer.innerHTML = '';
      
      // Create main media element (no controls in stacks)
      const mainEl = renderMediaEl(mainPhoto, {
        withControls: false,
        className: 'stack-main-photo'
      });
      mainContainer.appendChild(mainEl);

      // All media (photos and videos) open in lightbox when clicked
      // Videos do not play inline in stacks
      mainEl.style.cursor = 'zoom-in';
      mainEl.addEventListener('click', () => openLightboxForStack(stack, current));
      
      // Add caption if available
      if (mainPhoto.caption) {
        const c = document.createElement('p');
        c.className = 'photo-caption';
        c.textContent = mainPhoto.caption;
        mainContainer.appendChild(c);
      }
      
      // Update thumbnail active states
      if (drawer) {
        drawer.querySelectorAll(".drawer-thumbnail").forEach((t, i) => {
          t.classList.toggle("active", i === current);
        });
      }
    }

    // Populate thumbnails with proper media elements
    function populateThumbnails() {
      if (!drawer) return;
      const thumbsContainer = drawer.querySelector('.drawer-thumbnails');
      if (!thumbsContainer) return;
      
      // Clear existing thumbnails
      thumbsContainer.innerHTML = '';
      
      // Create thumbnail elements using renderMediaEl
      stack.photos.forEach((p, idx) => {
        // IMPORTANT: thumbnails must never try to load p.url for videos as <img>
        const el = isVideo(p)
          ? renderMediaEl(p, { withControls: false, className: `drawer-thumbnail ${idx===current?'active':''}` }) // <video poster=thumb>
          : renderMediaEl(p, { withControls: false, className: `drawer-thumbnail ${idx===current?'active':''}`, useThumb: true }); // <img src=thumb>
        
        el.setAttribute('data-index', idx);
        el.setAttribute('draggable', 'false');
        
        el.addEventListener('click', () => {
          current = idx;
          updateMain();
        });
        
        thumbsContainer.appendChild(el);
      });
    }

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

    // Initialize the main media display
    updateMain();
    
    // Initialize thumbnails with proper media elements
    populateThumbnails();

    // Bind interactions functionality using new threaded discussion system
    const interactionsBlock = card.querySelector('.stack-interactions');
    const mediaActionsBlock = card.querySelector('.stack-media-actions');
    if (!interactionsBlock) {
      console.error('❌ Stack interactions block not found for:', stack.id);
      return;
    }
    
    // Bind like button in media actions area
    if (mediaActionsBlock) {
      bindLikeInteractions(stack.id, mediaActionsBlock);
    }
    
    bindDiscussionThread(stack.id, interactionsBlock);
    loadThreadedDiscussion(stack.id, interactionsBlock, mediaActionsBlock);
  });
  localStorage.setItem("stackPhotoCounts", JSON.stringify(newCounts));
}

// ----- Threaded Discussion System -----

// Global state for discussions
const discussionState = new Map();

// Initialize discussion state for a stack
function initDiscussionState(stackId) {
  if (!discussionState.has(stackId)) {
    discussionState.set(stackId, {
      comments: [],
      expanded: false,
      manuallyCollapsed: false,
      activeReplyComposer: null
    });
  }
  return discussionState.get(stackId);
}

// Load and render threaded discussion
async function loadThreadedDiscussion(stackId, block, mediaActionsBlock = null) {
  const state = initDiscussionState(stackId);
  
  try {
    const res = await fetch(`${getApiBase()}/api/stack/${stackId}/interactions`);
    const data = await res.json();
    
    // Update like count in media actions area
    if (mediaActionsBlock) {
      const likeCountEl = mediaActionsBlock.querySelector('.like-pill .count');
    const likeCount = Object.values(data.reactions || {}).reduce((a,b)=>a+b,0);
      if (likeCountEl) {
    likeCountEl.textContent = likeCount;
      }
    }
    
    // Process comments into threaded structure
    state.comments = processCommentsIntoThreads(data.comments || []);
    
    // Update thread count
    updateThreadCount(stackId, block);
    
    // Auto-expand if there are comments and not manually collapsed, OR if we were already expanded
    const shouldExpand = (state.comments.length > 0 && !state.manuallyCollapsed) || state.expanded;
    if (shouldExpand) {
      state.expanded = true;
      const threadContainer = block.querySelector('.thread-container');
      const threadToggle = block.querySelector('.thread-toggle');
      if (threadContainer && threadToggle) {
        threadContainer.style.display = 'block';
        threadToggle.setAttribute('aria-expanded', 'true');
      }
    }
    
    // Render if expanded
    if (state.expanded) {
      renderThreadedComments(stackId, block);
    }
  } catch(e) {
    console.warn('Failed to load discussion:', e);
    if (mediaActionsBlock) {
      const likeCountEl = mediaActionsBlock.querySelector('.like-pill .count');
      if (likeCountEl) {
        likeCountEl.textContent = '0';
      }
    }
    updateThreadCount(stackId, block);
  }
}

// Process flat comments into nested threaded structure (unlimited depth)
function processCommentsIntoThreads(comments) {
  const threaded = [];
  const commentMap = new Map();
  
  // First pass: create map of all comments with empty replies array
  comments.forEach(c => {
    commentMap.set(c.id, { ...c, replies: [] });
  });
  
  // Second pass: build the tree structure
  comments.forEach(c => {
    const comment = commentMap.get(c.id);
    if (c.parentId && commentMap.has(c.parentId)) {
      // It's a reply - add to parent's replies array
      const parent = commentMap.get(c.parentId);
      parent.replies.push(comment);
    } else {
      // It's a top-level comment - add to root
      threaded.push(comment);
    }
  });
  
  return threaded;
}

// Update thread count display
function updateThreadCount(stackId, block) {
  const state = discussionState.get(stackId);
  const threadCount = block.querySelector('.thread-count');
  const threadToggle = block.querySelector('.thread-toggle');
  const totalComments = state ? countTotalComments(state.comments) : 0;
  
  if (totalComments === 0) {
    threadCount.textContent = 'Add a comment';
  } else {
    // Check if expanded or collapsed
    const isExpanded = state.expanded;
    
    if (isExpanded) {
      // When expanded: static label, no caret
      if (totalComments === 1) {
        threadCount.textContent = '1 comment';
      } else {
        threadCount.textContent = `${totalComments} comments`;
      }
      threadToggle.classList.add('expanded');
    } else {
      // When collapsed: "View N comments ▾"
      if (totalComments === 1) {
        threadCount.textContent = 'View 1 comment ▾';
      } else {
        threadCount.textContent = `View ${totalComments} comments ▾`;
      }
      threadToggle.classList.remove('expanded');
    }
  }
}

// Count total comments including replies (recursive for unlimited depth)
function countTotalComments(comments) {
  return comments.reduce((total, comment) => {
    // Count this comment + all its nested replies
    const repliesCount = comment.replies ? countTotalComments(comment.replies) : 0;
    return total + 1 + repliesCount;
  }, 0);
}

// Helper function to analyze comment depth distribution
function analyzeCommentDepths(comments, depth = 0) {
  const depths = {};
  comments.forEach(comment => {
    depths[depth] = (depths[depth] || 0) + 1;
    if (comment.replies && comment.replies.length > 0) {
      const childDepths = analyzeCommentDepths(comment.replies, depth + 1);
      Object.keys(childDepths).forEach(d => {
        depths[d] = (depths[d] || 0) + childDepths[d];
      });
    }
  });
  return depths;
}

// Bind like interactions (simplified from old system)
function bindLikeInteractions(stackId, block) {
  initLikeChip(block, 'stack', stackId);
}

// Bind discussion thread interactions
function bindDiscussionThread(stackId, block) {
  const state = initDiscussionState(stackId);
  
  // Thread toggle
  const threadToggle = block.querySelector('.thread-toggle');
  const threadContainer = block.querySelector('.thread-container');
  
  if (!threadToggle || !threadContainer) {
    console.error('❌ Missing required thread elements for stack:', stackId);
    return;
  }
  
  threadToggle.addEventListener('click', () => {
    state.expanded = !state.expanded;
    // Track manual collapse/expand
    state.manuallyCollapsed = !state.expanded;
    threadToggle.setAttribute('aria-expanded', state.expanded);
    
    if (state.expanded) {
      threadContainer.style.display = 'block';
      renderThreadedComments(stackId, block);
    } else {
      threadContainer.style.display = 'none';
      // Close any open reply composers
      closeAllReplyComposers(stackId, block);
    }
    
    // Update the thread count text based on new state
    updateThreadCount(stackId, block);
  });
  
  // Main comment composer
  bindCommentComposer(stackId, block);
  
  // Comments start collapsed by default
}

// Bind main comment composer
function bindCommentComposer(stackId, block) {
  const composer = block.querySelector('.comment-composer');
  const textarea = composer.querySelector('textarea');
  const postBtn = composer.querySelector('.post-btn');
  const statusRegion = block.querySelector('.comment-status');
  
  // Auto-resize textarea
  textarea.addEventListener('input', () => {
    textarea.style.height = 'auto';
    textarea.style.height = textarea.scrollHeight + 'px';
    
    // Update post button state
    postBtn.disabled = !textarea.value.trim();
  });
  
  // Keyboard shortcuts
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.shiftKey) {
      // Shift+Enter: new line (default behavior)
      return;
    } else if (e.key === 'Enter' && !e.shiftKey) {
      // Enter: submit comment
      e.preventDefault();
      if (textarea.value.trim() && !postBtn.disabled) {
        composer.dispatchEvent(new Event('submit'));
      }
    }
  });
  
  // Form submission
  composer.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = textarea.value.trim();
    if (!text || postBtn.disabled) return;
    
    // Disable form during submission
    postBtn.disabled = true;
    textarea.disabled = true;
    
    try {
      // Optimistic update
      const tempComment = {
        id: 'temp-' + Date.now(),
        author: 'You',
        text,
        timestamp: new Date().toISOString(),
        replies: []
      };
      
      const state = discussionState.get(stackId);
      state.comments.unshift(tempComment);
      renderThreadedComments(stackId, block);
      updateThreadCount(stackId, block);
      
      // Clear form
      textarea.value = '';
      textarea.style.height = 'auto';
      
      // Submit to server
      const res = await fetch(`${getApiBase()}/api/stack/${stackId}/comment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
      });
      
      if (res.ok) {
        const result = await res.json();
        // Replace temp comment with real one
        const index = state.comments.findIndex(c => c.id === tempComment.id);
        if (index !== -1) {
          state.comments[index] = { ...result.comment, replies: [] };
          renderThreadedComments(stackId, block);
        }
        
        // Show success feedback with toast
        showSuccessToast('Comment posted');
        
        // Also update ARIA status
        statusRegion.textContent = 'Comment posted';
        setTimeout(() => statusRegion.textContent = '', 2000);
      } else {
        throw new Error('Failed to post comment');
      }
    } catch (error) {
      console.error('Failed to post comment:', error);
      
      // Remove optimistic comment
      const state = discussionState.get(stackId);
      state.comments = state.comments.filter(c => !c.id.startsWith('temp-'));
      renderThreadedComments(stackId, block);
      updateThreadCount(stackId, block);
      
      // Restore form
      textarea.value = text;
      statusRegion.textContent = 'Failed to post comment. Please try again.';
      setTimeout(() => statusRegion.textContent = '', 3000);
    } finally {
      postBtn.disabled = false;
      textarea.disabled = false;
      textarea.focus();
    }
  });
}

// Render threaded comments
function renderThreadedComments(stackId, block) {
  const state = discussionState.get(stackId);
  const commentList = block.querySelector('.comment-list');
  const emptyState = block.querySelector('.thread-empty');
  
  // Clear existing content
  commentList.innerHTML = '';
  
  if (state.comments.length === 0) {
    emptyState.style.display = 'block';
    return;
  }
  
  emptyState.style.display = 'none';
  
  // Display comments in chronological order (newest first)
  const sortedComments = [...state.comments].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  
  // Render each comment thread with staggered animation
  sortedComments.forEach((comment, index) => {
    renderCommentThread(comment, commentList, stackId, 0);
    
    // Add staggered delay for smooth sequential appearance
    const commentElement = commentList.children[commentList.children.length - 1];
    if (commentElement) {
      commentElement.style.animationDelay = `${index * 0.05}s`;
    }
  });
}

// Comments are sorted inline where needed

// Render a single comment thread (parent + replies)
function renderCommentThread(comment, container, stackId, depth = 0) {
  const isReply = depth > 0;
  
  // Create comment element with clean structure
  const li = document.createElement('li');
  li.className = `comment${isReply ? ' reply' : ''}`;
  li.dataset.commentId = comment.id;
  li.dataset.depth = depth; // Track nesting depth for styling
  
  // Add CSS custom property for dynamic indentation
  if (isReply) {
    li.style.setProperty('--reply-depth', depth);
  }
  
  // Get user initials for avatar
  const initials = (comment.author || 'A').trim().split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
  
  // Format timestamps
  const timeAgo = formatTimeAgo(new Date(comment.timestamp));
  const fullTimestamp = formatFullTimestamp(new Date(comment.timestamp));
  
  li.innerHTML = `
    <div class="avatar" aria-hidden="true">${initials}</div>
    <div class="content">
      <div class="meta">
        <span class="author">${escapeHtml(comment.author || 'Anonymous')}</span>
        <time class="time" datetime="${comment.timestamp}" title="${fullTimestamp}">${timeAgo}</time>
      </div>
      <div class="body">${escapeHtml(comment.text || '').replace(/\n/g, '<br>')}</div>
      <div class="actions">
        <button class="reply" type="button">Reply</button>
      </div>
      <form class="reply-composer" hidden>
        <div class="reply-chip">
          <span>Replying to <strong class="reply-target">${escapeHtml(comment.author || 'Anonymous')}</strong></span>
          <button class="close" type="button" aria-label="Cancel reply">×</button>
        </div>
        <textarea name="reply" placeholder="Write your reply..." rows="1"></textarea>
        <div class="reply-actions">
          <button class="btn-link cancel" type="button">Cancel</button>
          <button class="btn-primary post" type="submit" disabled>Post</button>
        </div>
      </form>
    </div>
  `;
  
  container.appendChild(li);
  
  // Add has-replies class if this comment has replies
  if (comment.replies && comment.replies.length > 0) {
    li.classList.add('has-replies');
  }
  
  // Bind reply action for all comments (parent and replies)
  const replyBtn = li.querySelector('.reply');
  if (replyBtn) {
    replyBtn.addEventListener('click', () => {
      showInlineReplyComposer(stackId, comment.id, li);
    });
  }
  
  // Render replies for all comments (unlimited nesting)
  if (comment.replies && comment.replies.length > 0) {
    // Sort replies chronologically (oldest first for natural conversation flow)
    const sortedReplies = [...comment.replies].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    
    // Collapse if more than 3 replies (only for top-level comments)
    const shouldCollapse = depth === 0 && sortedReplies.length > 3;
    const visibleReplies = shouldCollapse ? sortedReplies.slice(0, 3) : sortedReplies;
    const hiddenReplies = shouldCollapse ? sortedReplies.slice(3) : [];
    
    // Create a container for replies to help with thread line positioning
    const repliesContainer = document.createElement('div');
    repliesContainer.className = 'replies-container';
    repliesContainer.style.position = 'relative';
    
    // Render visible replies
    visibleReplies.forEach((reply, index) => {
      renderCommentThread(reply, repliesContainer, stackId, depth + 1);
      
      // Add slight staggered delay for replies
      const replyElements = repliesContainer.querySelectorAll('.comment.reply');
      const lastReply = replyElements[replyElements.length - 1];
      if (lastReply) {
        lastReply.style.animationDelay = `${0.1 + (index * 0.03)}s`;
      }
    });
    
    // Add vertical thread line if we have replies
    if (visibleReplies.length > 0) {
      const threadLine = document.createElement('div');
      threadLine.className = 'thread-line';
      // Calculate height to span all visible replies
      const firstReply = repliesContainer.querySelector('.comment.reply');
      const lastVisibleReply = repliesContainer.querySelectorAll('.comment.reply');
      if (firstReply && lastVisibleReply.length > 0) {
        // Set height to cover from start to end of replies
        threadLine.style.height = '100%';
      }
      repliesContainer.style.position = 'relative';
      repliesContainer.prepend(threadLine);
    }
    
    container.appendChild(repliesContainer);
    
    // Add "View more replies" button if collapsed
    if (shouldCollapse) {
      const expandBtn = document.createElement('button');
      expandBtn.className = 'expand-replies';
      expandBtn.type = 'button';
      expandBtn.innerHTML = `View ${hiddenReplies.length} more ${hiddenReplies.length === 1 ? 'reply' : 'replies'}`;
      expandBtn.dataset.commentId = comment.id;
      
      const expandContainer = document.createElement('div');
      expandContainer.className = 'expand-replies-container';
      // Calculate indentation based on current depth
      const baseIndent = depth > 0 ? 2.5 : 3.5;
      const depthIndent = depth > 1 ? (depth - 1) * 1.5 : 0;
      expandContainer.style.marginLeft = `${baseIndent + depthIndent}rem`;
      expandContainer.appendChild(expandBtn);
      container.appendChild(expandContainer);
      
      // Bind expand functionality
      expandBtn.addEventListener('click', () => {
        // Remove the expand button
        expandContainer.remove();
        
        // Render hidden replies in the existing replies container
        const existingRepliesContainer = container.querySelector('.replies-container');
        hiddenReplies.forEach((reply, index) => {
          renderCommentThread(reply, existingRepliesContainer, stackId, depth + 1);
          
          // Add slight staggered delay for newly visible replies
          const replyElements = existingRepliesContainer.querySelectorAll('.comment.reply');
          const lastReply = replyElements[replyElements.length - 1];
          if (lastReply) {
            lastReply.style.animationDelay = `${0.1 + ((visibleReplies.length + index) * 0.03)}s`;
          }
        });
        
        // Update the thread line height to cover all replies now
        const threadLine = existingRepliesContainer.querySelector('.thread-line');
        if (threadLine) {
          threadLine.style.height = '100%';
        }
        
        // Add collapse button
        const collapseBtn = document.createElement('button');
        collapseBtn.className = 'collapse-replies';
        collapseBtn.type = 'button';
        collapseBtn.innerHTML = 'Show fewer replies';
        collapseBtn.dataset.commentId = comment.id;
        
        const collapseContainer = document.createElement('div');
        collapseContainer.className = 'collapse-replies-container';
        // Use same indentation calculation as expand button
        collapseContainer.style.marginLeft = `${baseIndent + depthIndent}rem`;
        collapseContainer.appendChild(collapseBtn);
        container.appendChild(collapseContainer);
        
        // Bind collapse functionality
        collapseBtn.addEventListener('click', () => {
          // Remove hidden replies and collapse button
          const existingRepliesContainer = container.querySelector('.replies-container');
          hiddenReplies.forEach(reply => {
            const replyElement = existingRepliesContainer.querySelector(`[data-comment-id="${reply.id}"]`);
            if (replyElement) replyElement.remove();
          });
          collapseContainer.remove();
          
          // Update thread line height
          const threadLine = existingRepliesContainer.querySelector('.thread-line');
          if (threadLine) {
            threadLine.style.height = '100%';
          }
          
          // Re-add expand button
          container.appendChild(expandContainer);
        });
      });
    }
  }
}

// Show inline reply composer (using built-in form)
function showInlineReplyComposer(stackId, parentCommentId, parentElement) {
  const state = discussionState.get(stackId);
  
  // Close any existing reply composers
  closeAllReplyComposers(stackId, parentElement.closest('.stack-interactions'));
  
  // Show the reply form in this comment
  const replyForm = parentElement.querySelector('.reply-composer');
  if (replyForm) {
    replyForm.hidden = false;
    
    // Store reference
    state.activeReplyComposer = replyForm;
    
    // Bind events
    bindReplyComposer(stackId, replyForm, parentCommentId);
    
    // Focus textarea
    const textarea = replyForm.querySelector('textarea');
    textarea.focus();
    autoResizeTextarea(textarea);
  }
}

// Auto-resize textarea utility
function autoResizeTextarea(textarea) {
  textarea.style.height = 'auto';
  const newHeight = Math.min(textarea.scrollHeight, 120); // Max 5 lines (120px)
  textarea.style.height = newHeight + 'px';
}

// Bind reply composer events
function bindReplyComposer(stackId, composer, parentCommentId) {
  const textarea = composer.querySelector('textarea');
  const closeBtn = composer.querySelector('.close');
  const cancelBtn = composer.querySelector('.cancel');
  const submitBtn = composer.querySelector('.post');
  const statusRegion = composer.closest('.stack-interactions').querySelector('.comment-status');
  
  // Auto-resize and enable/disable submit
  textarea.addEventListener('input', () => {
    autoResizeTextarea(textarea);
    submitBtn.disabled = !textarea.value.trim();
  });
  
  // Keyboard shortcuts
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeReplyComposer(composer);
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (textarea.value.trim() && !submitBtn.disabled && !submitBtn.classList.contains('loading')) {
        composer.dispatchEvent(new Event('submit'));
      }
    }
    // Shift+Enter for new line is default behavior
  });
  
  // Close button (X in chip)
  closeBtn.addEventListener('click', () => {
    closeReplyComposer(composer);
  });
  
  // Cancel button
  cancelBtn.addEventListener('click', () => {
    closeReplyComposer(composer);
  });
  
  // Form submission
  composer.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = textarea.value.trim();
    if (!text || submitBtn.disabled || submitBtn.classList.contains('loading')) return;
    
    // Show loading state
    submitBtn.disabled = true;
    submitBtn.classList.add('loading');
    submitBtn.textContent = 'Posting...';
    textarea.disabled = true;
    
    try {
      // Submit to server directly (no optimistic updates to avoid race conditions)
      const res = await fetch(`${getApiBase()}/api/stack/${stackId}/comment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, parentId: parentCommentId })
      });
      
      if (res.ok) {
        const result = await res.json();
        
        // Close composer first
        closeReplyComposer(composer);
        
        // Reload discussion from server to get all replies
        await loadThreadedDiscussion(stackId, composer.closest('.stack-interactions'));
        
        // Show success feedback
        showSuccessToast('Reply posted');
        
        // Update ARIA status
        const statusRegion = document.querySelector('[aria-live="polite"]');
        if (statusRegion) {
          statusRegion.textContent = 'Reply posted successfully';
          setTimeout(() => statusRegion.textContent = '', 3000);
        }
      } else {
        throw new Error('Failed to post reply');
      }
    } catch (error) {
      console.error('Failed to post reply:', error);
      
      // Reset button state and keep composer open with text
      submitBtn.disabled = false;
      submitBtn.classList.remove('loading');
      submitBtn.textContent = 'Post';
      textarea.disabled = false;
      
      // Show error message
      const statusRegion = document.querySelector('[aria-live="polite"]');
      if (statusRegion) {
        statusRegion.textContent = 'Failed to post reply. Please try again.';
        setTimeout(() => statusRegion.textContent = '', 3000);
      }
    }
  });
}

// Close reply composer
function closeReplyComposer(composer) {
  const stackId = composer.closest('.stack-interactions').dataset.stackId;
  const state = discussionState.get(stackId);
  
  if (state.activeReplyComposer === composer) {
    state.activeReplyComposer = null;
  }
  
  // Hide the form and reset it
  composer.hidden = true;
  const textarea = composer.querySelector('textarea');
  if (textarea) {
    textarea.value = '';
    textarea.style.height = 'auto';
  }
  
  const submitBtn = composer.querySelector('.post');
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.classList.remove('loading');
    submitBtn.textContent = 'Post';
  }
}

// Close all reply composers for a stack
function closeAllReplyComposers(stackId, block) {
  const state = discussionState.get(stackId);
  state.activeReplyComposer = null;
  
  block.querySelectorAll('.reply-composer').forEach(composer => {
    composer.hidden = true;
    const textarea = composer.querySelector('textarea');
    if (textarea) {
      textarea.value = '';
      textarea.style.height = 'auto';
    }
    
    const submitBtn = composer.querySelector('.post');
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.classList.remove('loading');
      submitBtn.textContent = 'Post';
    }
  });
}

// Toggle replies visibility
function toggleReplies(commentId, parentElement, toggleBtn) {
  const isExpanded = toggleBtn.dataset.expanded === 'true';
  const nextSibling = parentElement.nextElementSibling;
  
  // Find all reply elements
  const replies = [];
  let current = nextSibling;
  while (current && current.classList.contains('reply')) {
    replies.push(current);
    current = current.nextElementSibling;
  }
  
  if (isExpanded) {
    // Hide replies
    replies.forEach(reply => reply.style.display = 'none');
    toggleBtn.dataset.expanded = 'false';
    toggleBtn.textContent = `View ${replies.length} ${replies.length === 1 ? 'reply' : 'replies'}`;
  } else {
    // Show replies
    replies.forEach(reply => reply.style.display = 'flex');
    toggleBtn.dataset.expanded = 'true';
    toggleBtn.textContent = `Hide ${replies.length} ${replies.length === 1 ? 'reply' : 'replies'}`;
  }
}

// Find comment by ID in nested structure
function findCommentById(comments, id) {
  for (const comment of comments) {
    if (comment.id === id) {
      return comment;
    }
    if (comment.replies) {
      const found = findCommentById(comment.replies, id);
      if (found) return found;
    }
  }
  return null;
}

// Format relative time with specific requirements
function formatTimeAgo(date) {
  const now = new Date();
  const diffMs = now - date;
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);
  
  if (diffSecs < 60) return 'just now';
  if (diffMins < 60) return `${diffMins}m`;
  if (diffHours < 24) return `${diffHours}h`;
  if (diffDays < 30) return `${diffDays}d`;
  
  // For older comments, show short date
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// Format full timestamp for hover/title
function formatFullTimestamp(date) {
  return date.toLocaleString([], {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

// ----- Micro-interactions -----

// Show success toast notification
function showSuccessToast(message) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  document.body.appendChild(toast);
  
  // Remove toast after animation completes
  setTimeout(() => {
    if (toast.parentNode) {
      toast.parentNode.removeChild(toast);
    }
  }, 2500);
}

// Animate like count with bump effect
function animateLikeCount(countElement, newCount) {
  const countSpan = countElement;
  
  // Add bump animation
  countSpan.classList.add('bump');
  
  // Update count
  countSpan.textContent = newCount;
  
  // Remove animation class after animation completes
  setTimeout(() => {
    countSpan.classList.remove('bump');
  }, 300);
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
  li.dataset.commentId = c.id || '';
  const initials = (c.author || 'A').trim()[0]?.toUpperCase() || 'A';
  
  li.innerHTML = `
    <div class="comment-avatar">${initials}</div>
    <div class="comment-bubble">
      <div class="comment-head">
        <div class="comment-meta">
          <span class="comment-author">${escapeHtml(c.author || 'Anonymous')}</span>
          <span class="comment-time">${new Date(c.timestamp || c.edited || Date.now()).toLocaleString([], {hour:'2-digit', minute:'2-digit', day:'2-digit', month:'short'})}</span>
        </div>
        ${c.id && !c.id.startsWith('temp-') ? `<button class="comment-delete" data-comment-id="${c.id}" title="Delete comment">🗑️</button>` : ''}
      </div>
      <div class="comment-text">${escapeHtml(c.text || '')}</div>
    </div>`;
  return li;
}



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
      if (typeof out.count === 'number') {
        // Animate the like count with bump effect
        animateLikeCount(countEl, out.count);
      }
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

  // comment delete buttons (event delegation)
  block.addEventListener('click', async (e) => {
    if (e.target.classList.contains('comment-delete')) {
      const commentId = e.target.dataset.commentId;
      if (!commentId || !confirm('Delete this comment?')) return;

      const commentItem = e.target.closest('.comment-item');
      if (!commentItem) return;

      // Optimistic UI - remove comment immediately
      const originalParent = commentItem.parentNode;
      const originalNextSibling = commentItem.nextSibling;
      commentItem.remove();

      try {
        // Get admin token the same way as the admin panel
        const getAdminToken = () => {
          try {
            const settings = JSON.parse(localStorage.getItem('tripAdminSettings') || '{}');
            return settings.apiToken || localStorage.getItem('tripAdminPass') || '';
          } catch {
            return localStorage.getItem('tripAdminPass') || '';
          }
        };
        
        const adminToken = getAdminToken();
        console.log('🔑 Using admin token for stack comment delete:', adminToken ? '***set***' : 'NOT SET');
        
        const res = await fetch(`${getApiBase()}/api/stack/${stackId}/comment/${commentId}`, {
          method: 'DELETE',
          headers: {
            'x-admin-token': adminToken
          }
        });

        if (!res.ok) {
          const errorText = await res.text().catch(() => 'Unknown error');
          throw new Error(`Delete failed: ${res.status} - ${errorText}`);
        }

        // Update comment count
        const cnt = block.querySelector('.comment-count');
        cnt.textContent = Math.max(0, (+cnt.textContent || 0) - 1);
        
        console.log('✅ Comment deleted successfully');
      } catch (error) {
        console.error('❌ Failed to delete comment:', error);
        
        // Restore comment on error
        if (originalNextSibling) {
          originalParent.insertBefore(commentItem, originalNextSibling);
        } else {
          originalParent.appendChild(commentItem);
        }
        
        if (error.message.includes('401')) {
          alert('Failed to delete comment: Unauthorized. Please go to the admin panel (/admin/) and set your admin token in Settings.');
        } else {
          alert(`Failed to delete comment: ${error.message}`);
        }
      }
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
    lon: photo.lon,
    mimeType: photo.mimeType,
    kind: photo.kind
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
  if (s.location.lat === null || s.location.lng === null) return; // Skip if no GPS
  
  // Calculate appropriate zoom level based on stack size and location
  const stackPhotoCount = s.photos.length;
  let targetZoom = 10; // Default zoom for single locations
  
  // Adjust zoom based on number of photos in stack
  if (stackPhotoCount > 10) {
    targetZoom = 8; // Keep wider view for larger stacks
  } else if (stackPhotoCount > 5) {
    targetZoom = 9; // Medium zoom for medium stacks
  } else {
    targetZoom = 11; // Closer view for smaller, specific locations
  }
  
  // Don't zoom in too much if we're already zoomed out (keeps context)
  const currentZoom = topMap.getZoom();
  if (currentZoom < 6) {
    targetZoom = Math.min(targetZoom, 8); // Limit zoom when starting from far out
  }
  
  topMap.setView([s.location.lat, s.location.lng], targetZoom, { 
    animate: true, 
    duration: 0.5,
    easeLinearity: 0.1
  });
}, 80);

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
      if (id && id!==activeStackId){ 
        activeStackId=id; 
        replaceUrlParam("stack", id); 
        setActive(id);
        
        // Add visual feedback for the active stack
        document.querySelectorAll(".stack-card").forEach(c=> {
          c.classList.toggle("map-active", c.id === id);
        });
      }
    }
  }, { 
    root: null, 
    rootMargin: "-15% 0px -35% 0px", // More responsive trigger area
    threshold: [0.1, 0.25, 0.5, 0.75, 0.9] // More precise detection
  });

  photoStacks.forEach(s=>{ const el=document.getElementById(s.id); if (el) io.observe(el); });
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

// Document-level event handlers for clean comment system
document.addEventListener('input', (e) => {
  if (e.target.tagName === 'TEXTAREA') {
    autoResizeTextarea(e.target);
    const form = e.target.closest('form, .reply-composer');
    if (form) {
      const submitBtn = form.querySelector('.post, .btn-primary, .post-btn');
      if (submitBtn) {
        submitBtn.disabled = !e.target.value.trim();
      }
    }
  }
});


