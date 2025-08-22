import { dataUrl, getApiBase, haversineKm, escapeHtml, formatTime, formatDateTime, groupIntoStacks } from "./utils.js";

// Get date from URL parameter
const urlParams = new URLSearchParams(window.location.search);
const daySlug = urlParams.get('date');

if (!daySlug) {
  document.getElementById('day-title').textContent = 'No date specified';
  throw new Error('No date parameter provided');
}

let dayData = null;
let map = null;

// ---------- media helpers ----------
function isVideo(item) {
  return item?.kind === 'video' || (item?.mimeType || '').startsWith('video/');
}

function renderMediaEl(item, { withControls = false, className = 'media-tile' } = {}) {
  if (isVideo(item)) {
    const v = document.createElement('video');
    v.src = item.url;
    if (item.thumb) v.poster = item.thumb;
    v.muted = true;
    v.playsInline = true;
    v.loop = true;
    v.controls = !!withControls;
    v.setAttribute('preload', 'metadata');
    v.className = className;
    return v;
  } else {
    const img = document.createElement('img');
    img.src = item.thumb || item.url;
    img.alt = item.title || item.caption || '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.className = className;
    return img;
  }
}

async function fetchStackInteractions(stackId) {
  try {
    const r = await fetch(`/api/stack/${encodeURIComponent(stackId)}/interactions`);
    if (!r.ok) throw new Error('interactions');
    return await r.json(); // { reactions: { "❤️": n, ... }, comments: [] }
  } catch { return { reactions: {}, comments: [] }; }
}

function reactionCountSum(reactions = {}) {
  return Object.values(reactions).reduce((a, b) => a + (b || 0), 0);
}

async function renderStacksSection() {
  const host = document.getElementById('stacks');
  if (!host) return;
  host.innerHTML = '';

  const items = dayData?.photos || [];
  if (!items.length) { host.innerHTML = '<p>No media.</p>'; return; }

  const stacks = groupIntoStacks(items, 500);

  const globalIndex = new Map(items.map((p, i) => [p.id || p.url, i]));

  for (const st of stacks) {
    const meta = (dayData.stackMeta && dayData.stackMeta[st.id]) || { title: '', caption: '' };
    const title = meta.title?.trim() || 'Untitled stop';
    const caption = meta.caption?.trim() || '';

    // Card shell
    const card = document.createElement('article');
    card.className = 'stack-card social';

    // Cover media
    const coverWrap = document.createElement('div');
    coverWrap.className = 'stack-cover';
    const cover = renderMediaEl(st.photos[0], { withControls: false, className: 'stack-cover-media' });
    coverWrap.appendChild(cover);

    // Header (title + subline)
    const header = document.createElement('header');
    header.className = 'stack-header';
    const when = formatTime(st.photos[0]?.taken_at || '');
    header.innerHTML = `
      <h3 class="stack-title">${escapeHtml(title)}</h3>
      <div class="stack-subline">
        <span>${escapeHtml(dayData.title || `Day — ${dayData.slug || ''}`)}</span>
        ${when ? ` · <span>${when}</span>` : ''}
      </div>
    `;

    // Description
    const desc = document.createElement('p');
    desc.className = 'stack-desc';
    desc.textContent = caption;

    // Media grid (rest)
    const grid = document.createElement('div');
    grid.className = 'stack-grid';
    st.photos.forEach((p, idx) => {
      const el = renderMediaEl(p, { withControls: false, className: idx === 0 ? 'stack-cover-media' : 'stack-thumb' });
      if (idx > 0) {
        el.addEventListener('click', () => {
          const gi = globalIndex.get(p.id || p.url) ?? 0;
          openLightbox(gi);
        });
        grid.appendChild(el);
      } else {
        // cover click opens lightbox
        coverWrap.addEventListener('click', () => {
          const gi = globalIndex.get(p.id || p.url) ?? 0;
          openLightbox(gi);
        });
      }
    });

    // Footer with likes count
    const footer = document.createElement('footer');
    footer.className = 'stack-footer';
    footer.innerHTML = `
      <button class="stack-like-btn" data-stack="${st.id}" aria-label="Like">♥</button>
      <a class="stack-like-count" href="javascript:void(0)" data-stack="${st.id}">0 likes</a>
    `;

    // Assemble
    card.appendChild(coverWrap);
    card.appendChild(header);
    if (caption) card.appendChild(desc);
    if (st.photos.length > 1) card.appendChild(grid);
    card.appendChild(footer);
    host.appendChild(card);

    // Load interactions & update counts
    (async () => {
      const inter = await fetchStackInteractions(st.id);
      const count = reactionCountSum(inter.reactions);
      const cntEl = card.querySelector('.stack-like-count');
      if (cntEl) cntEl.textContent = `${count} ${count === 1 ? 'like' : 'likes'}`;
    })();

    // Like handler (anonymous)
    card.querySelector('.stack-like-btn').addEventListener('click', async () => {
      try {
        await fetch(`/api/stack/${encodeURIComponent(st.id)}/react`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ emoji: '♥' })
        });
        const inter = await fetchStackInteractions(st.id);
        const count = reactionCountSum(inter.reactions);
        const cntEl = card.querySelector('.stack-like-count');
        if (cntEl) cntEl.textContent = `${count} ${count === 1 ? 'like' : 'likes'}`;
      } catch (e) { console.warn('like failed', e); }
    });
  }
}

// Initialize the page
async function init() {
  console.log('🚀 Initializing day view for:', daySlug);
  try {
    await loadDayData();
    console.log('✅ Day data loaded:', dayData);
    initMap();
    console.log('✅ Map initialized');
    renderPhotoPost();
    console.log('✅ Photo post rendered');
    renderStacksSection();
    console.log('✅ Stacks section rendered');
  } catch (error) {
    console.error('❌ Failed to initialize day view:', error);
    document.getElementById('day-title').textContent = 'Failed to load day data';
  }
}

// Load day data from API
async function loadDayData() {
  try {
    const response = await fetch(dataUrl("days", `${daySlug}.json`));
    if (!response.ok) {
      throw new Error(`Failed to load day data: ${response.status}`);
    }
    dayData = await response.json();
    document.getElementById('day-title').textContent = dayData.title || `Day — ${daySlug}`;
  } catch (error) {
    console.error('Error loading day data:', error);
    throw error;
  }
}

// Initialize the map
function initMap() {
  const mapContainer = document.getElementById('map');
  
  if (!window.L || !dayData?.photos?.length) {
    console.log('⚠️ No Leaflet or no photos, hiding map');
    mapContainer.style.display = 'none';
    return;
  }

  // Check if any photos have GPS coordinates
  const photosWithGPS = dayData.photos.filter(p => 
    typeof p.lat === 'number' && typeof p.lon === 'number'
  );

  if (photosWithGPS.length === 0) {
    console.log('⚠️ No photos with GPS coordinates, showing message');
    mapContainer.style.height = '200px'; // Ensure container has height
    mapContainer.innerHTML = `
      <div style="
        display: flex;
        align-items: center;
        justify-content: center;
        height: 100%;
        background: rgba(255,255,255,0.05);
        border: 1px solid rgba(255,255,255,0.1);
        border-radius: 12px;
        color: #9aa3af;
        font-size: 1rem;
        font-weight: 500;
      ">
        📍 No location data available for these media
      </div>
    `;
    return;
  }

  console.log(`📍 Found ${photosWithGPS.length} media with GPS coordinates`);

  map = L.map('map', {
    zoomControl: true,
    dragging: true,
    scrollWheelZoom: true,
    touchZoom: true
  });

  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
    attribution: "&copy; Esri",
    maxZoom: 18
  }).addTo(map);

  // Add markers for media with GPS coordinates
  const bounds = L.latLngBounds();

  photosWithGPS.forEach((photo) => {
    const marker = L.marker([photo.lat, photo.lon]).addTo(map);
    marker.bindPopup(`
      <img src="${photo.thumb || photo.url}" style="width:100px;height:75px;object-fit:cover;border-radius:4px;" alt="">
      <br><strong>${escapeHtml(photo.title || photo.caption || (isVideo(photo) ? 'Video' : 'Photo'))}</strong>
      <br><small>${formatTime(photo.taken_at)}</small>
    `);
    
    const originalIndex = dayData.photos.findIndex(p => p.id === photo.id);
    marker.on('click', () => openLightbox(originalIndex));
    bounds.extend([photo.lat, photo.lon]);
  });

  map.fitBounds(bounds, { padding: [20, 20] });
}

// Render the photo post section (now "media post")
function renderPhotoPost() {
  const container = document.getElementById('photo-post');
  console.log('📸 Rendering media post, count:', dayData?.photos?.length);
  
  if (!dayData?.photos?.length) {
    container.innerHTML = '<p>No media for this day.</p>';
    return;
  }

  const items = dayData.photos;
  const main = items[0];

  // Header
  const headerHtml = `
    <div class="photo-post-card">
      <div class="photo-header">
        <h2>${escapeHtml(dayData.title || `Day — ${daySlug}`)}</h2>
        <p class="photo-meta">${formatDateTime(main.taken_at)} • ${items.length} item${items.length > 1 ? 's' : ''}</p>
      </div>
      <div id="photo-main" class="photo-main"></div>
      <div id="photo-caption-container"></div>
      <div class="photo-actions">
        <button class="action-btn like-btn" onclick="toggleLike()">
          <span class="icon">♥</span>
          <span class="count">0</span>
        </button>
        <button class="action-btn comment-btn" onclick="toggleComments()">
          <span class="icon">💬</span>
          <span class="count">0</span>
        </button>
      </div>
      <div id="comments-section" class="comments-section" style="display: none;">
        <div id="comments-list" class="comments-list"></div>
        <form class="comment-form" onsubmit="addComment(event)">
          <input type="text" id="comment-input" placeholder="Add a comment..." required>
          <button type="submit">Post</button>
        </form>
      </div>
    </div>
  `;
  container.innerHTML = headerHtml;

  // Main media
  const mainWrap = document.getElementById('photo-main');
  const mainEl = renderMediaEl(main, { withControls: isVideo(main), className: 'photo-main-media' });
  mainWrap.appendChild(mainEl);

  // Thumbnails overlay
  if (items.length > 1) {
    const thumbs = document.createElement('div');
    thumbs.id = 'photo-thumbs';
    thumbs.className = 'photo-thumbnails';
    mainWrap.appendChild(thumbs);
    const thumbItems = items.slice(1, 5);
    thumbItems.forEach((it, idx) => {
      const el = renderMediaEl(it, { withControls: false, className: 'thumbnail' });
      el.addEventListener('click', () => openLightbox(idx + 1));
      thumbs.appendChild(el);
    });
    if (items.length > 5) {
      const more = document.createElement('div');
      more.className = 'more-photos';
      more.textContent = `+${items.length - 5}`;
      more.addEventListener('click', () => openLightbox(5));
      thumbs.appendChild(more);
    }
  }

  // Click to open lightbox for images; videos keep controls/play
  if (!isVideo(main)) {
    mainEl.style.cursor = 'zoom-in';
    mainEl.addEventListener('click', () => openLightbox(0));
  }

  // Captions
  const captionWrap = document.getElementById('photo-caption-container');
  if (main.title) {
    const t = document.createElement('p');
    t.className = 'photo-caption';
    t.textContent = main.title;
    captionWrap.appendChild(t);
  }
  if (main.caption) {
    const c = document.createElement('p');
    c.className = 'photo-caption';
    c.textContent = main.caption;
    captionWrap.appendChild(c);
  }
}

// Lightbox functionality (image + video)
let currentPhotoIndex = 0;

function ensureLightboxVideoEl() {
  let v = document.getElementById('lightbox-video');
  if (!v) {
    const container = document.getElementById('lightbox-media') || document.getElementById('lightbox');
    v = document.createElement('video');
    v.id = 'lightbox-video';
    v.controls = true;
    v.playsInline = true;
    v.style.maxWidth = '90vw';
    v.style.maxHeight = '85vh';
    v.style.display = 'none';
    container.insertBefore(v, document.getElementById('lightbox-caption'));
  }
  return v;
}

function openLightbox(index = 0) {
  if (!dayData?.photos?.length) return;

  currentPhotoIndex = Math.max(0, Math.min(index, dayData.photos.length - 1));
  const lb = document.getElementById('lightbox');
  const item = dayData.photos[currentPhotoIndex];

  const img = document.getElementById('lightbox-image');
  const vid = document.getElementById('lightbox-video');

  if (item.type === 'video') {
    vid.src = item.url;
    vid.style.display = 'block';
    img.style.display = 'none';
  } else {
    img.src = item.url;
    img.style.display = 'block';
    vid.style.display = 'none';
  }

  document.getElementById('lightbox-caption').textContent = item.caption || item.title || '';
  document.getElementById('lightbox-counter').textContent = `${currentPhotoIndex + 1} / ${dayData.photos.length}`;

  lb.classList.add('open');
  document.body.classList.add('lightbox-open');

  document.getElementById('lightbox-prev').disabled = currentPhotoIndex === 0;
  document.getElementById('lightbox-next').disabled = currentPhotoIndex === dayData.photos.length - 1;
}

function closeLightbox() {
  const lb = document.getElementById('lightbox');
  const vid = document.getElementById('lightbox-video');
  if (vid) vid.pause?.();
  lb.classList.remove('open');
  document.body.classList.remove('lightbox-open');
}

function previousPhoto() {
  if (currentPhotoIndex > 0) {
    openLightbox(currentPhotoIndex - 1);
  }
}

function nextPhoto() {
  if (currentPhotoIndex < dayData.photos.length - 1) {
    openLightbox(currentPhotoIndex + 1);
  }
}

// Make sure the button actually closes (id must match the CSS above)
const closeBtn = document.getElementById('lightbox-close');
if (closeBtn) closeBtn.addEventListener('click', closeLightbox);

const prevBtn = document.getElementById('lightbox-prev');
if (prevBtn) prevBtn.addEventListener('click', previousPhoto);

const nextBtn = document.getElementById('lightbox-next');
if (nextBtn) nextBtn.addEventListener('click', nextPhoto);

// Keyboard navigation
document.addEventListener('keydown', (e) => {
  const lbOpen = document.getElementById('lightbox').classList.contains('open');
  if (!lbOpen) return;
  if (e.key === 'Escape') closeLightbox();
  if (e.key === 'ArrowLeft') previousPhoto();
  if (e.key === 'ArrowRight') nextPhoto();
});

// Optional: click on backdrop to close.
// If you want only backdrop (not the panel) to close:
document.getElementById('lightbox').addEventListener('click', (e) => {
  // Close when clicking the dim area only (not media or panel)
  const panel = document.getElementById('lightbox-panel');
  const img = document.getElementById('lightbox-image');
  const vid = document.getElementById('lightbox-video');
  const clickedInside =
    (panel && panel.contains(e.target)) ||
    (img && img.contains(e.target)) ||
    (vid && vid.contains(e.target)) ||
    (e.target.id === 'lightbox-close');
  if (!clickedInside) closeLightbox();
});

// Interactions (simplified for day view)
function toggleLike() {
  console.log('Like toggled');
}

function toggleComments() {
  const commentsSection = document.getElementById('comments-section');
  commentsSection.style.display = commentsSection.style.display === 'none' ? 'block' : 'none';
}

function addComment(event) {
  event.preventDefault();
  const input = event.target.querySelector('input');
  const text = input.value.trim();
  if (!text) return;

  // Render the new comment
  const list = document.getElementById('comments-list');
  const item = document.createElement('div');
  item.className = 'comment-item';
  item.innerHTML = `
    <div class="comment-author">You</div>
    <div class="comment-text">${escapeHtml(text)}</div>
    <div class="comment-time">${new Date().toLocaleString([], { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' })}</div>
  `;
  list.appendChild(item);

  // Update comment count on the button
  const countEl = document.querySelector('.comment-btn .count');
  if (countEl) {
    countEl.textContent = String((parseInt(countEl.textContent, 10) || 0) + 1);
  }

  input.value = '';
}

// Make functions globally available
window.openLightbox = openLightbox;
window.closeLightbox = closeLightbox;
window.toggleLike = toggleLike;
window.toggleComments = toggleComments;
window.addComment = addComment;

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

