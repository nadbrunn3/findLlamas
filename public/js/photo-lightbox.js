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
          
          const res = await fetch(`${api}/api/photo/${photoId}/comment/${commentId}`, {
            method: 'DELETE'
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

// --- Optimized lightweight lightbox with per-photo interactions ---
window.openPhotoLightbox = (photos, startIndex=0) => {
  let i = startIndex;

  // Store reference for close function
  if (window.lbRoot) {
    window.lbRoot = null;
  }

  // Use cached element or create once
  let el = cachedLightboxEl;
  if (!el) {
    el = document.createElement("div");
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
    
    // Cache the element
    cachedLightboxEl = el;
    
    // Only append to body once
    if (!document.querySelector('.lb-portal')) {
      document.body.appendChild(el);
    }
    
    // Store reference for close function
    window.lbRoot = el;

    // lock page scroll while lightbox is open
    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';

    // close handlers
    el.querySelector('[data-lb-close]').addEventListener('click', window.closeLightbox || (() => el.classList.remove("on")));
    el.querySelector('[data-lb-backdrop]').addEventListener('click', (e)=>{
      // click on the dark backdrop (not inside the shell) closes
      if (e.target === e.currentTarget) {
        if (window.closeLightbox) window.closeLightbox();
        else el.classList.remove("on");
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
      if (window.closeLightbox) window.closeLightbox();
      else el.classList.remove("on");

      const latlng = [p.lat, p.lon];

      // Prefer the rich overlay map when available
      if (window.openMapOverlayAt) {
        window.openMapOverlayAt(p.lat, p.lon, '');

        // When overlay closes, pan page map (if present)
        const onClose = ()=>{
          if (window.topMap?.panTo) window.topMap.panTo(latlng);
          document.removeEventListener('map:closed', onClose);
        };
        document.addEventListener('map:closed', onClose);
        return;
      }

      // Fallback: pan existing page map or open Google Maps
      if (window.topMap?.panTo) {
        window.topMap.panTo(latlng);
      } else {
        const url = `https://maps.google.com/?q=${p.lat},${p.lon}`;
        window.open(url, '_blank');
      }
    });
    
    // Keyboard handler with escape
    window.lbEscHandler = (e)=>{
      if (!el.classList.contains("on")) return;
      if (e.key==="Escape") {
        if (window.closeLightbox) window.closeLightbox();
        else el.classList.remove("on");
      }
      if (e.key==="ArrowLeft") show(i-1);
      if (e.key==="ArrowRight") show(i+1);
    };
    document.addEventListener("keydown", window.lbEscHandler);
  }

  const img = el.querySelector(".lb-img");
  const vid = el.querySelector(".lb-video");

  function show(next) {
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
  el.classList.add("on");
  
  // Store reference for close function when opened
  window.lbRoot = el;
  
  // lock page scroll while lightbox is open
  document.documentElement.style.overflow = 'hidden';
  document.body.style.overflow = 'hidden';
};