import { dataUrl, getApiBase, haversineKm, escapeHtml, formatTime, formatDateTime, groupIntoStacks, formatDate } from "./utils.js";

const MAPBOX_STYLE = 'mapbox://styles/mapbox/legacy-satellite-v1';
// Use provided Mapbox token by default; replace with your own for production.
mapboxgl.accessToken =
  mapboxgl.accessToken ||
  'pk.eyJ1IjoianVkZ2UtbW9ja3VwLXdoYW0iLCJhIjoiY21lb3M4dHJiMGUxcjJqcXZ4YzZwZjhubSJ9.EptPsUdI5bt2hOIZfZL3Yg';

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
  const mt = (item?.mimeType || '').toLowerCase();
  const url = (item?.url || '').toLowerCase();
  const caption = (item?.caption || '').toLowerCase();
  const title = (item?.title || '').toLowerCase();
  const k = (item?.kind || '').toLowerCase();
  return (
    k === 'video' ||
    mt.startsWith('video/') ||
    /\.(mp4|webm|mov|m4v)$/i.test(url) ||
    /\.(mp4|webm|mov|m4v)$/i.test(caption) ||
    /\.(mp4|webm|mov|m4v)$/i.test(title)
  );
}

function renderMediaEl(item, { withControls = false, className = 'media-tile', useThumb = false } = {}) {
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
    
    // Add simple play button overlay for stack cover videos
    if (className.includes('stack-cover-media')) {
      // Add play button overlay
      const playOverlay = document.createElement('div');
      playOverlay.className = 'video-play-overlay';
      playOverlay.innerHTML = '▶';
      playOverlay.style.cssText = `
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        background: rgba(255,255,255,0.8);
        color: #000;
        border-radius: 50%;
        width: 45px;
        height: 45px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 16px;
        cursor: pointer;
        transition: all 0.3s;
        z-index: 10;
        border: 2px solid rgba(255,255,255,0.9);
      `;
      
      // Create wrapper for video + overlay
      const wrapper = document.createElement('div');
      wrapper.style.position = 'relative';
      wrapper.style.display = 'inline-block';
      wrapper.style.width = '100%';
      wrapper.appendChild(v);
      wrapper.appendChild(playOverlay);
      
      return wrapper;
    }
    
    return v;
  } else {
    const img = document.createElement('img');
    img.src = useThumb ? (item.thumb || item.url) : (item.url || item.thumb);
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

  // Stack metadata loaded successfully

  const stacks = groupIntoStacks(items, 500);

  const globalIndex = new Map(items.map((p, i) => [p.id || p.url, i]));

  for (const st of stacks) {
    const meta = (dayData.stackMeta && dayData.stackMeta[st.id]) || { title: '', caption: '' };
    const title = meta.title?.trim() || formatDate(st.photos[0]?.taken_at);
    const caption = meta.caption?.trim() || '';

    // Stack metadata processed

    // Card shell
    const card = document.createElement('article');
    card.className = 'stack-card social';

    // Cover media
    const coverWrap = document.createElement('div');
    coverWrap.className = 'stack-cover';
    const cover = renderMediaEl(st.photos[0], { withControls: false, className: 'stack-cover-media', useThumb: false });
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

    // Description with collapsible functionality
    const descContainer = document.createElement('div');
    descContainer.className = 'stack-desc-container';
    
    const desc = document.createElement('p');
    desc.className = 'stack-desc';
    desc.textContent = caption;
    
    // Check if description is long enough to need collapsing
    const needsCollapse = caption && caption.length > 50; // Adjust threshold as needed
    
    if (needsCollapse) {
      const toggle = document.createElement('span');
      toggle.className = 'stack-desc-toggle';
      toggle.textContent = 'Read more';
      
      toggle.addEventListener('click', () => {
        const isExpanded = desc.classList.contains('expanded');
        if (isExpanded) {
          desc.classList.remove('expanded');
          toggle.textContent = 'Read more';
        } else {
          desc.classList.add('expanded');
          toggle.textContent = 'Read less';
        }
      });
      descContainer.appendChild(desc);
      descContainer.appendChild(toggle);
      
      // Check if content actually needs collapsing after DOM insertion
      setTimeout(() => {
        const MAX_HEIGHT = 72; // ~3 lines at 15px font size
        if (desc.scrollHeight <= MAX_HEIGHT) {
          toggle.style.display = 'none';
        }
      }, 0);
    } else {
      descContainer.appendChild(desc);
    }

    // Media grid (rest)
    const grid = document.createElement('div');
    grid.className = 'stack-grid';
    st.photos.forEach((p, idx) => {
      const el = renderMediaEl(p, { 
        withControls: false, 
        className: idx === 0 ? 'stack-cover-media' : 'stack-thumb',
        useThumb: idx > 0  // Use thumbnails for grid items, full res for cover
      });
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
    if (caption) card.appendChild(descContainer);
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

  const isMobile = matchMedia('(max-width:768px)').matches;
  
  map = new mapboxgl.Map({
    container: 'map',
    style: MAPBOX_STYLE,
    center: [photosWithGPS[0]?.lon || 0, photosWithGPS[0]?.lat || 0],
    zoom: 12,
    pitch: 45,
    bearing: 0,
    antialias: true
  });
  map.addControl(new mapboxgl.NavigationControl());
  map.addControl(new mapboxgl.FullscreenControl());
  addFullscreenToggle(map, 'map');

  map.on('load', () => {
    applyBloom(map);
    const bounds = new mapboxgl.LngLatBounds();
    photosWithGPS.forEach(photo => {
      const popup = new mapboxgl.Popup({ offset: 25 }).setHTML(`
        <img src="${photo.thumb || photo.url}" style="width:100px;height:75px;object-fit:cover;border-radius:4px;" alt="">
        <br><strong>${escapeHtml(photo.title || (isVideo(photo) ? 'Video' : 'Photo'))}</strong>
        <br><small>${formatTime(photo.taken_at)}</small>
      `);
      const marker = new mapboxgl.Marker().setLngLat([photo.lon, photo.lat]).setPopup(popup).addTo(map);
      marker.getElement().addEventListener('click', () => {
        const originalIndex = dayData.photos.findIndex(p => p.id === photo.id);
        openLightbox(originalIndex);
      });
      bounds.extend([photo.lon, photo.lat]);
    });
    map.fitBounds(bounds, { padding: 20 });
  });
}

// ---------- fullscreen toggle for maps ----------
function addFullscreenToggle(map, containerId) {
  class FullscreenToggle {
    onAdd(mapInstance) {
      const btn = document.createElement('button');
      btn.className = 'mapboxgl-ctrl-fullscreen';
      btn.innerHTML = `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>
        </svg>
      `;
      btn.type = 'button';
      btn.title = 'Toggle fullscreen';
      btn.setAttribute('aria-label', 'Toggle fullscreen map');
      btn.addEventListener('click', e => {
        e.stopPropagation();
        openFullscreenMapFromRegularMap(mapInstance, containerId);
      });
      const container = document.createElement('div');
      container.className = 'mapboxgl-ctrl mapboxgl-ctrl-group';
      container.appendChild(btn);
      this._container = container;
      return container;
    }
    onRemove() {
      this._container.parentNode.removeChild(this._container);
    }
  }
  map.addControl(new FullscreenToggle(), 'top-right');
}

function applyBloom(map) {
  map.setPaintProperty('water', 'fill-color', '#5fa4ff');
  map.setPaintProperty('water', 'fill-opacity', 0.85);
  map.setPaintProperty('water', 'fill-outline-color', '#a6d2ff');

  map.setPaintProperty('road-primary', 'line-color', '#ffffff');
  map.setPaintProperty('road-primary', 'line-width', [
    'interpolate', ['linear'], ['zoom'], 5, 0.5, 15, 3
  ]);
  map.setPaintProperty('road-primary', 'line-blur', [
    'interpolate', ['linear'], ['zoom'], 5, 1, 15, 6
  ]);

  map.setPaintProperty('poi-label', 'text-color', '#ffd166');
  map.setPaintProperty('poi-label', 'text-halo-color', '#ffa600');
  map.setPaintProperty('poi-label', 'text-halo-width', 2);
}

function openFullscreenMapFromRegularMap(sourceMap, containerId) {
  console.log('🗺️ Opening fullscreen map from day view');
  
  // Get photos from current day
  let photosForMap = [];
  
  if (window.dayData && window.dayData.photos) {
    photosForMap = window.dayData.photos.filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon))
      .map(p => ({
        id: p.id,
        url: p.url,
        thumb: p.thumb || p.url,
        caption: p.caption || p.title || '',
        title: p.title || '',
        lat: p.lat,
        lon: p.lon,
        taken_at: p.taken_at,
        mimeType: p.mimeType,
        kind: p.kind
      }));
  }
  
  if (photosForMap.length === 0) {
    console.log('⚠️ No photos with coordinates found for fullscreen map');
    return;
  }
  
  // Use the same fullscreen map function from photo-lightbox.js
  if (window.openFullscreenMapWithPhotos) {
    window.openFullscreenMapWithPhotos(photosForMap, 0);
  } else {
    console.error('❌ openFullscreenMapWithPhotos function not available');
  }
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

  // Caption removed - never display picture names
  const captionWrap = document.getElementById('photo-caption-container');
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
  const item = dayData.photos[currentPhotoIndex];

  console.log('🔍 Opening lightbox for photo:', item);

  // First, ensure any existing lightbox is properly closed
  closeLightbox();

  // Small delay to ensure cleanup is complete
  setTimeout(() => {
    // Use the newer photo lightbox system for consistency
    if (window.openPhotoLightbox) {
      const photos = dayData.photos.map(photo => ({
        id: photo.id,
        url: photo.url,
        thumb: photo.thumb,
        caption: photo.caption || photo.description || '',
        title: photo.title || '',
        type: isVideo(photo) ? 'video' : 'image'
      }));
      
      console.log('✅ Using modern lightbox with photos:', photos);
      window.openPhotoLightbox(photos, currentPhotoIndex);
      return;
    }
  }, 100);

  // Fallback to basic lightbox if modern one isn't available
  const lb = document.getElementById('lightbox');
  if (!lb) {
    console.error('❌ No lightbox element found');
    return;
  }

  const img = document.getElementById('lightbox-image');
  const vid = document.getElementById('lightbox-video');

  if (!img || !vid) {
    console.error('❌ Missing lightbox media elements');
    return;
  }

  if (item.type === 'video' || isVideo(item)) {
    vid.src = item.url;
    vid.style.display = 'block';
    img.style.display = 'none';
    console.log('📹 Showing video:', item.url);
  } else {
    img.src = item.url;
    img.style.display = 'block';
    vid.style.display = 'none';
    console.log('🖼️ Showing image:', item.url);
  }

  const titleEl = document.getElementById('lightbox-title');
  const captionEl = document.getElementById('lightbox-caption');
  const counterEl = document.getElementById('lightbox-counter');
  
  if (titleEl) {
    titleEl.textContent = item.title || '';
    titleEl.style.display = item.title ? '' : 'none';
  }
  if (captionEl) {
    captionEl.textContent = '';
    captionEl.style.display = 'none';
  }
  if (counterEl) {
    counterEl.textContent = `${currentPhotoIndex + 1} / ${dayData.photos.length}`;
  }

  lb.classList.add('open');
  document.body.classList.add('lightbox-open');
  
  // Lock scroll
  document.documentElement.style.overflow = 'hidden';
  document.body.style.overflow = 'hidden';

  const prevBtn = document.getElementById('lightbox-prev');
  const nextBtn = document.getElementById('lightbox-next');
  
  if (prevBtn) prevBtn.disabled = currentPhotoIndex === 0;
  if (nextBtn) nextBtn.disabled = currentPhotoIndex === dayData.photos.length - 1;
  
  console.log('✅ Lightbox opened successfully');
}

function closeLightbox() {
  console.log('🔒 Closing lightbox - unified system from day.js');
  
  // Use the unified close function from index.js if available
  if (window.closeLightbox && window.closeLightbox !== closeLightbox) {
    window.closeLightbox();
    return;
  }
  
  // Force close all lightbox types immediately
  const allLightboxes = document.querySelectorAll('.lb-portal, .lightbox, [class*="lightbox"], [id*="lightbox"]');
  allLightboxes.forEach(lb => {
    lb.classList.remove('on', 'open');
    lb.style.display = 'none';
  });
  
  // Handle specific video cleanup
  const vid = document.getElementById('lightbox-video');
  if (vid) {
    vid.pause?.();
    vid.src = ''; // Clear video source
  }
  
  // Clear all lightbox references
  if (window.lbRoot) {
    window.lbRoot.classList.remove('on');
    window.lbRoot.style.display = 'none';
  }
  
  // Clean up ALL event handlers
  if (window.lbEscHandler) {
    document.removeEventListener('keydown', window.lbEscHandler);
    window.lbEscHandler = null;
  }
  
  // Remove lightbox-open class from body
  document.body.classList.remove('lightbox-open');
  
  // Force unlock page scroll immediately
  document.documentElement.style.overflow = '';
  document.body.style.overflow = '';
  document.documentElement.style.position = '';
  document.body.style.position = '';
  
  console.log('✅ All lightboxes closed and scroll unlocked from day.js');
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

