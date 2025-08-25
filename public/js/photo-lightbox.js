const MAPBOX_STYLE = 'mapbox://styles/mapbox/satellite-v9';
// Use provided Mapbox token by default; replace with your own for production.
mapboxgl.accessToken =
  mapboxgl.accessToken ||
  'pk.eyJ1IjoianVkZ2UtbW9ja3VwLXdoYW0iLCJhIjoiY21lb3M4dHJiMGUxcjJqcXZ4YzZwZjhubSJ9.EptPsUdI5bt2hOIZfZL3Yg';

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

// --- Lightbox helpers ---
function escapeHtml(s){ return s.replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

function likeKey(kind, id){ return `liked:${kind}:${id}`; }

function isVideo(item){
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

function renderLbComment(c){
  const li = document.createElement('div');
  li.className = 'lb-citem';
  li.dataset.commentId = c.id || '';
  const initials = (c.author || 'A').trim()[0]?.toUpperCase() || 'A';
  li.innerHTML = `
    <div class="lb-ava">${initials}</div>
    <div class="lb-bubble">
      <div class="lb-head">
        <div class="comment-meta">
          <span class="lb-author">${escapeHtml(c.author || 'Anonymous')}</span>
          <span class="lb-time">${new Date(c.timestamp || c.edited || Date.now()).toLocaleString([], {hour:'2-digit', minute:'2-digit', day:'2-digit', month:'short'})}</span>
        </div>
        <button class="lb-comment-delete" data-comment-id="${c.id}" title="Delete comment" style="display: none;">🗑️</button>
      </div>
      <div class="lb-text">${escapeHtml(c.text || '')}</div>
    </div>`;
  
  // Check ownership and show delete button if owned by current user
  if (isMyComment(c.id)) {
    const deleteBtn = li.querySelector('.lb-comment-delete');
    if (deleteBtn) {
      deleteBtn.style.display = 'inline-block';
      console.log('✅ Lightbox delete button shown for my comment:', c.id);
    }
  }
  
  return li;
}

async function loadPhotoInteractions(photoId, panel){
  try {
    const api = (window.getApiBase ? window.getApiBase() : "") || "";
    const res = await fetch(`${api}/api/photo/${photoId}/interactions`);
    const data = res.ok ? await res.json() : {reactions:{}, comments:[]};

    // counts
    const likeCnt = Object.values(data.reactions || {}).reduce((a,b)=>a+b,0);
    panel.querySelector('.lb-like .count').textContent = likeCnt;
    panel.querySelector('.lb-comments-btn .count').textContent = (data.comments?.length || 0);

    // comments
    const list = panel.querySelector('#lbComments');
    list.innerHTML = '';
    (data.comments || []).forEach(c => list.appendChild(renderLbComment(c)));

    // liked state from localStorage
    const liked = localStorage.getItem(likeKey('photo', photoId)) === '1';
    const likeBtn = panel.querySelector('.lb-like');
    likeBtn.setAttribute('aria-pressed', liked);
  } catch(e) {
    // fallback on error
    panel.querySelector('.lb-like .count').textContent = '0';
    panel.querySelector('.lb-comments-btn .count').textContent = '0';
  }
}

function bindLbPanel(photoId){
  const api = (window.getApiBase ? window.getApiBase() : "") || "";
  const panel = document.getElementById('lbPanel');
  const likeBtn = panel.querySelector('.lb-like');
  const commentsBtn = panel.querySelector('.lb-comments-btn');
  const input = panel.querySelector('.lb-input');
  const form  = panel.querySelector('#lbComposer');

  // Store current photo ID on panel to avoid duplicate bindings
  if (panel._currentPhotoId === photoId) return;
  panel._currentPhotoId = photoId;

  // like toggle - replace existing handler
  likeBtn.onclick = async ()=>{
    if (likeBtn._busy) return;
    likeBtn._busy = true;

    let liked = likeBtn.getAttribute('aria-pressed') === 'true';
    liked = !liked;
    likeBtn.setAttribute('aria-pressed', liked);
    localStorage.setItem(likeKey('photo', photoId), liked ? '1' : '0');

    try{
      const res = await fetch(`${api}/api/photo/${photoId}/react`, {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ emoji:'♥', action: liked ? 'add' : 'remove' })
      });
      const out = await res.json();
      const cntEl = likeBtn.querySelector('.count');
      if (typeof out.count === 'number') cntEl.textContent = out.count;
    }finally{
      likeBtn._busy = false;
    }
  };

  // post comment - replace existing handler
  form.onsubmit = async (e)=>{
    e.preventDefault();
    const text = input.value.trim(); if(!text) return;
    const list = document.getElementById('lbComments');
    const temp = { author:'You', text, timestamp:new Date().toISOString() };
    list.appendChild(renderLbComment(temp));
    input.value = '';

    try{
      const res = await fetch(`${api}/api/photo/${photoId}/comment`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ text, author: 'You' })
      });
      const out = await res.json();
      
      // Track this as my comment
      if (out.comment && out.comment.id) {
        addMyComment(out.comment.id);
        // Re-render the comment list to show delete buttons
        loadPhotoInteractions(photoId, panel);
      }
      
      // bump count
      const cBtn = panel.querySelector('.lb-comments-btn .count');
      cBtn.textContent = (+cBtn.textContent || 0) + 1;
    }catch{}
  };

  // comments toggle - only bind once
  if (!commentsBtn._bound) {
    commentsBtn._bound = true;
    commentsBtn.onclick = () => {
      const list = document.getElementById('lbComments');
      const isHidden = list.style.display === 'none';
      list.style.display = isHidden ? 'block' : 'none';
      form.style.display = isHidden ? 'block' : 'none';
      if (isHidden && window.matchMedia('(max-width: 768px)').matches) {
        panel.scrollIntoView({ behavior: 'smooth' });
      }
    };
  }

  // comment delete buttons (event delegation) - only bind once per panel
  if (!panel._deleteHandlerBound) {
    panel._deleteHandlerBound = true;
    panel.addEventListener('click', async (e) => {
      if (e.target.classList.contains('lb-comment-delete')) {
        const commentId = e.target.dataset.commentId;
        if (!commentId || !confirm('Delete this comment?')) return;

        const commentItem = e.target.closest('.lb-citem');
        if (!commentItem) return;

        // Optimistic UI - remove comment immediately
        const originalParent = commentItem.parentNode;
        const originalNextSibling = commentItem.nextSibling;
        commentItem.remove();

        try {
          console.log('🗑️ Attempting to delete lightbox comment:', {
            commentId,
            photoId,
            url: `${api}/api/photo/${photoId}/comment/${commentId}`
          });
          
          // Get admin token the same way as the stack comments
          const getAdminToken = () => {
            try {
              const settings = JSON.parse(localStorage.getItem('tripAdminSettings') || '{}');
              return settings.apiToken || localStorage.getItem('tripAdminPass') || '';
            } catch {
              return localStorage.getItem('tripAdminPass') || '';
            }
          };
          
          const adminToken = getAdminToken();
          console.log('🔑 Using admin token for photo comment delete:', adminToken ? '***set***' : 'NOT SET');
          
          const res = await fetch(`${api}/api/photo/${photoId}/comment/${commentId}`, {
            method: 'DELETE',
            headers: {
              'x-admin-token': adminToken
            }
          });

          if (!res.ok) {
            throw new Error(`HTTP ${res.status}: ${res.statusText}`);
          }

          // Update comment count
          const cBtn = panel.querySelector('.lb-comments-btn .count');
          cBtn.textContent = Math.max(0, (+cBtn.textContent || 0) - 1);
          
          console.log('✅ Lightbox comment deleted successfully');
        } catch (error) {
          console.error('❌ Failed to delete lightbox comment:', error);
          console.error('❌ Error details:', {
            message: error.message,
            stack: error.stack
          });
          
          // Restore comment on error
          if (originalNextSibling) {
            originalParent.insertBefore(commentItem, originalNextSibling);
          } else {
            originalParent.appendChild(commentItem);
          }
          
          if (error.message.includes('403')) {
            alert('Failed to delete comment: You can only delete your own comments.');
          } else if (error.message.includes('404')) {
            alert('Failed to delete comment: Comment not found.');
          } else {
            alert(`Failed to delete comment: ${error.message || 'Unknown error'}`);
          }
        }
      }
    });
  }

  loadPhotoInteractions(photoId, panel);
}

// Cache lightbox DOM for better performance
let cachedLightboxEl = null;

// Enable pinch zoom and panning on touch devices for a given element
function enablePinchZoom(el){
  if (!el) return { reset: () => {} };

  let scale = 1;
  let startScale = 1;
  let startDist = 0;
  let panX = 0, panY = 0;
  let startX = 0, startY = 0;
  let lastTap = 0;

  const apply = () => {
    el.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
  };

  const reset = () => {
    scale = 1;
    panX = 0;
    panY = 0;
    el.style.transform = '';
    el.style.touchAction = '';
  };

  el.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      e.preventDefault();
      startDist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      startScale = scale;
      el.style.touchAction = 'none';
    } else if (e.touches.length === 1 && scale > 1) {
      e.preventDefault();
      startX = e.touches[0].clientX - panX;
      startY = e.touches[0].clientY - panY;
    }
  }, { passive: false });

  el.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2) {
      e.preventDefault();
      const dist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      scale = Math.min(5, Math.max(1, startScale * dist / startDist));
      apply();
    } else if (e.touches.length === 1 && scale > 1) {
      e.preventDefault();
      panX = e.touches[0].clientX - startX;
      panY = e.touches[0].clientY - startY;
      apply();
    }
  }, { passive: false });

  el.addEventListener('touchend', () => {
    el.style.touchAction = '';
    if (scale <= 1) {
      reset();
    }
  });

  el.addEventListener('click', () => {
    const now = Date.now();
    if (now - lastTap < 300) {
      reset();
    }
    lastTap = now;
  });

  return { reset };
}

// --- ORIGINAL STYLE LIGHTBOX WITH FIXES ---
window.openPhotoLightbox = (photos, startIndex=0) => {
  let i = startIndex;

  // Remove any existing lightbox properly
  const existing = document.querySelector('.lb-portal');
  if (existing) existing.remove();

  // Create lightbox with original structure
  const el = document.createElement("div");
  el.className = "lb-portal lightbox-root";
  el.innerHTML = `
    <div class="lb-backdrop lightbox-backdrop" data-lb-backdrop></div>
    <div class="lb-frame lightbox-shell" role="dialog" aria-modal="true">
      <button class="lb-close" data-lb-close aria-label="Close (Esc)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M6 6l12 12M18 6l-12 12"/>
        </svg>
      </button>
      <img class="lb-img" alt="">
      <video class="lb-video" controls style="display:none"></video>
      <button class="lb-nav lb-prev lightbox-prev" aria-label="Prev">‹</button>
      <button class="lb-nav lb-next lightbox-next" aria-label="Next">›</button>

      <div class="lb-panel lightbox-side" id="lbPanel">
        <div class="lb-toolbar">
          <button class="lb-chip lb-like" aria-pressed="false">
            <span class="icon">♥</span>
            <span class="count">0</span>
          </button>
          <button class="lb-chip lb-comments-btn">
            <span class="icon">💬</span>
            <span class="count">0</span>
          </button>
          <button class="lb-chip lb-show-map" type="button">
            <span class="icon">🗺️</span>
            <span class="text">Map</span>
          </button>
        </div>

        <!-- Comments section with padding from toolbar -->
        <div class="lb-comments-section">
          <div class="lb-comments" id="lbComments"></div>

          <form class="lb-composer" id="lbComposer" autocomplete="off">
            <input class="lb-input" name="text" placeholder="Add a comment…" maxlength="500" />
            <button class="lb-send" type="submit">Post</button>
          </form>
        </div>
      </div>
    </div>
  `;
  
  // Add to DOM immediately
  document.body.appendChild(el);
  
  // Store reference for close function
  window.lbRoot = el;

  // Make visible with original CSS classes
  el.classList.add('on');

  // lock page scroll while lightbox is open
  document.documentElement.style.overflow = 'hidden';
  document.body.style.overflow = 'hidden';

  // close handlers
  el.querySelector('[data-lb-close]').addEventListener('click', () => {
    if (window.closeLightbox) {
      window.closeLightbox();
    } else {
      el.classList.remove("on");
      setTimeout(() => {
        document.documentElement.style.overflow = '';
        document.body.style.overflow = '';
      }, 50);
    }
  });
  
  el.querySelector('[data-lb-backdrop]').addEventListener('click', (e)=>{
    // click on the dark backdrop (not inside the shell) closes
    if (e.target === e.currentTarget) {
      if (window.closeLightbox) {
        window.closeLightbox();
      } else {
        el.classList.remove("on");
        setTimeout(() => {
          document.documentElement.style.overflow = '';
          document.body.style.overflow = '';
        }, 50);
      }
    }
  });
  
  // Navigation handlers
  el.querySelector(".lb-prev").onclick = () => show(i-1);
  el.querySelector(".lb-next").onclick = () => show(i+1);
  
  // Map action button
  const showOnMapBtn = el.querySelector('.lb-show-map');
  
  function syncActionsForCurrentPhoto(){
    const p = photos[i] || {};
    const hasCoords = Number.isFinite(p.lat) && Number.isFinite(p.lon);
    showOnMapBtn.disabled = !hasCoords;
    showOnMapBtn.title = hasCoords ? 'Open map at this photo' : 'No GPS for this photo';
  }
  
  showOnMapBtn.addEventListener('click', ()=>{
    const p = photos[i];
    if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return;

    // Close the lightbox first (clean UI)
    if (window.closeLightbox) {
      window.closeLightbox();
    } else {
      el.classList.remove("on");
      setTimeout(() => {
        document.documentElement.style.overflow = '';
        document.body.style.overflow = '';
      }, 50);
    }

    // Open fullscreen map with all photos and focus on current photo
    openFullscreenMapWithPhotos(photos, i);
  });
  
  // Keyboard handler with escape
  window.lbEscHandler = (e)=>{
    if (!el.classList.contains("on")) return;
    if (e.key==="Escape") {
      if (window.closeLightbox) {
        window.closeLightbox();
      } else {
        el.classList.remove("on");
        setTimeout(() => {
          document.documentElement.style.overflow = '';
          document.body.style.overflow = '';
        }, 50);
      }
    }
    if (e.key==="ArrowLeft") show(i-1);
    if (e.key==="ArrowRight") show(i+1);
  };
  document.addEventListener("keydown", window.lbEscHandler);

  const img = el.querySelector(".lb-img");
  const vid = el.querySelector(".lb-video");
  const zoomer = enablePinchZoom(img);

  function show(next) {
    zoomer.reset();
    i = (next + photos.length) % photos.length;
    const p = photos[i];
    if (isVideo(p)) {
      img.style.display = 'none';
      vid.style.display = 'block';
      vid.src = p.url;
      vid.poster = p.thumb || '';
      vid.currentTime = 0;
      const pp = vid.play();
      if (pp && pp.catch) pp.catch(()=>{});
    } else {
      vid.pause?.();
      vid.removeAttribute('src');
      vid.style.display = 'none';
      img.style.display = 'block';
      img.src = p.url;
    }
    el.querySelector(".lb-prev").disabled = photos.length < 2;
    el.querySelector(".lb-next").disabled = photos.length < 2;
    
    // Bind panel for current photo
    bindLbPanel(p.id);
    
    // Sync map button for current photo
    syncActionsForCurrentPhoto();
    
    // Call slide change callback if available
    if (window.onLightboxSlideChange) {
      window.onLightboxSlideChange(i);
    }
  }

  show(i);
};

// --- FULLSCREEN MAP WITH PHOTO BUBBLES ---
function openFullscreenMapWithPhotos(photos, focusIndex = 0) {
  console.log('🗺️ Opening fullscreen map with', photos.length, 'photos');
  
  // Remove any existing fullscreen map
  const existing = document.querySelector('.fullscreen-map-overlay');
  if (existing) existing.remove();
  
  // Create fullscreen map overlay
  const overlay = document.createElement('div');
  overlay.className = 'fullscreen-map-overlay';
  overlay.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0,0,0,0.9);
    z-index: 10001;
    display: flex;
    flex-direction: column;
  `;
  
  // Create header bar
  const headerBar = document.createElement('div');
  headerBar.style.cssText = `
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 20px;
    background: rgba(17, 24, 39, 0.95);
    border-bottom: 1px solid rgba(75, 85, 99, 0.5);
  `;
  
  const title = document.createElement('h3');
  title.textContent = 'Photo Locations';
  title.style.cssText = `
    color: white;
    margin: 0;
    font-size: 18px;
    font-weight: 600;
  `;
  
  const closeBtn = document.createElement('button');
  closeBtn.innerHTML = '×';
  closeBtn.style.cssText = `
    background: rgba(255,255,255,0.2);
    border: none;
    color: white;
    font-size: 24px;
    width: 40px;
    height: 40px;
    border-radius: 50%;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
  `;
  
  headerBar.appendChild(title);
  headerBar.appendChild(closeBtn);
  
  // Create map container
  const mapContainer = document.createElement('div');
  mapContainer.id = 'fullscreen-photo-map';
  mapContainer.style.cssText = `
    flex: 1;
    width: 100%;
    height: 100%;
  `;
  
  // Assemble overlay
  overlay.appendChild(headerBar);
  overlay.appendChild(mapContainer);
  document.body.appendChild(overlay);
  
  // Lock scroll
  document.documentElement.style.overflow = 'hidden';
  document.body.style.overflow = 'hidden';
  
  // Close functionality
  const closeFullscreenMap = () => {
    console.log('🔒 Closing fullscreen map');
    if (fullscreenMap) {
      fullscreenMap.remove();
      fullscreenMap = null;
    }
    overlay.remove();
    document.documentElement.style.overflow = '';
    document.body.style.overflow = '';
  };
  
  closeBtn.onclick = closeFullscreenMap;
  
  // ESC key to close
  const escHandler = (e) => {
    if (e.key === 'Escape') {
      closeFullscreenMap();
      document.removeEventListener('keydown', escHandler);
    }
  };
  document.addEventListener('keydown', escHandler);
  
  const photosWithCoords = photos.filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon));

  let fullscreenMap = new mapboxgl.Map({
    container: 'fullscreen-photo-map',
    style: MAPBOX_STYLE,
    center: [photosWithCoords[0]?.lon || 0, photosWithCoords[0]?.lat || 0],
    zoom: 3,
    pitch: 45,
    bearing: 0,
    antialias: true
  });
  fullscreenMap.addControl(new mapboxgl.NavigationControl());
  fullscreenMap.addControl(new mapboxgl.FullscreenControl());

  fullscreenMap.on('load', () => {
    applyBloom(fullscreenMap);
    const bounds = new mapboxgl.LngLatBounds();
    photosWithCoords.forEach((photo, index) => {
      bounds.extend([photo.lon, photo.lat]);
      const el = document.createElement('div');
      el.className = 'photo-bubble-marker';
      el.innerHTML = `
        <div class="photo-bubble" style="
          width: 40px;
          height: 40px;
          border-radius: 50%;
          border: 3px solid white;
          box-shadow: 0 2px 8px rgba(0,0,0,0.3);
          overflow: hidden;
          cursor: pointer;
          background: white;
        ">
          <img src="${photo.thumb || photo.url}" style="width:100%;height:100%;object-fit:cover;" alt="Photo">
        </div>`;
      const marker = new mapboxgl.Marker(el).setLngLat([photo.lon, photo.lat]).addTo(fullscreenMap);
      el.addEventListener('click', () => {
        closeFullscreenMap();
        setTimeout(() => {
          const originalIndex = photos.findIndex(p => p.id === photo.id || p.url === photo.url);
          if (typeof window.openPhotoLightbox === 'function') {
            window.openPhotoLightbox(photos, originalIndex >= 0 ? originalIndex : index);
          } else {
            console.error('openPhotoLightbox function not available');
          }
        }, 100);
      });
    });

    if (!bounds.isEmpty()) {
      fullscreenMap.fitBounds(bounds, { padding: 50 });
      if (focusIndex >= 0 && focusIndex < photosWithCoords.length) {
        const focusPhoto = photosWithCoords[focusIndex] || photos[focusIndex];
        if (focusPhoto && Number.isFinite(focusPhoto.lat) && Number.isFinite(focusPhoto.lon)) {
          setTimeout(() => {
            fullscreenMap.flyTo({ center: [focusPhoto.lon, focusPhoto.lat], zoom: Math.max(fullscreenMap.getZoom(), 12) });
          }, 1000);
        }
      }
    }

    setTimeout(() => fullscreenMap.resize(), 100);
    console.log('✅ Fullscreen map created with', photosWithCoords.length, 'photo markers');
  });
}

// Make the function globally available
window.openFullscreenMapWithPhotos = openFullscreenMapWithPhotos;
