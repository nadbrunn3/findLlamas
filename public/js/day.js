// public/js/day.js
function qs(name) {
  return new URLSearchParams(window.location.search).get(name);
}
const date = qs('date');
// Global vars for slider ↔ map sync
let pointsGlobal = [];
let setPosition = () => {};
let photoMap = {};
if (!date) {
  document.getElementById('day-title').textContent = 'Date not specified';
  throw new Error('Missing date parameter');
}
async function loadDay() {
  try {
    const res = await fetch(`days/${date}.json`);
    const data = await res.json();
    document.getElementById('day-title').textContent = data.title || data.date;
    if (data.stats) {
      document.getElementById('day-stats').textContent = `${data.stats.distance_km} km · ${data.stats.moving_h} h`;
    }
    // initialise map & slider first (needed for gallery sync)
    initMapAndSlider(data);

    // render gallery after map init so clicks can sync
    const gallery = document.getElementById('gallery');
    const photos = data.photos || [];
    photos.forEach((p, idx) => {
      const a = document.createElement('a');
      a.href = '#';
      a.className = 'card';
      a.innerHTML = `
        <img loading="lazy" src="${p.thumb}" alt="${p.caption || ''}" />
        <div class="photo-interactions" id="interactions-${p.id}">
          <div class="photo-reactions"></div>
          <div class="photo-comment-count">💬 0</div>
        </div>
      `;
      a.addEventListener('click', (e) => {
        e.preventDefault();
        openLightbox(idx);
      });
      gallery.appendChild(a);
      
      // Load interactions for this photo
      loadGalleryInteractions(p.id);
    });

    // build map from slider index to photo(s)
    photoMap = {};
    photos.forEach(p => {
      const idx = findClosestIndex(p.taken_at);
      if (!photoMap[idx]) photoMap[idx] = [];
      photoMap[idx].push(p);
    });
    // Store data globally for lightbox
    window.currentDayData = data;
    console.log('Loaded day', data);
  } catch (err) {
    console.error('Failed to load day JSON', err);
    document.getElementById('day-title').textContent = 'Error loading data';
  }

  // load diary
  const diaryEl = document.getElementById('day-diary');
  if (diaryEl) {
    fetch(`blog/${date}.html`).then(r => {
      if (r.ok) return r.text();
      throw new Error('no diary');
    }).then(html => {
      diaryEl.innerHTML = html;
    }).catch(()=>{
      diaryEl.innerHTML = '';
    });
  }
}

function initMapAndSlider(data) {
  if (!window.L) {
    console.error('Leaflet not loaded');
    return;
  }
  const latlngs = (data.polyline?.coordinates || []).map(([lon, lat]) => [lat, lon]);
  const map = L.map('map');
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap',
    maxZoom: 19,
  }).addTo(map);
  const poly = L.polyline(latlngs, { color: 'steelblue', weight: 4 }).addTo(map);
  map.fitBounds(poly.getBounds(), { padding: [20, 20] });

  const points = data.points?.map(p => [p.lat, p.lon, p.t]) || [];
  if (!points.length) return;

  pointsGlobal = points;

  const marker = L.marker([points[0][0], points[0][1]]).addTo(map);

  const slider = document.getElementById('time-slider');
  const label = document.getElementById('time-label');
  const playBtn = document.getElementById('play-btn');

  let playing = false;
  let intervalId = null;

  function pause() {
    playing = false;
    clearInterval(intervalId);
    intervalId = null;
    playBtn.textContent = '▶︎';
    playBtn.setAttribute('aria-label', 'Play');
  }

  function play() {
    if (playing) return;
    // If at end, restart from beginning
    if (parseInt(slider.value, 10) >= points.length - 1) {
      setPosition(0);
    }
    playing = true;
    playBtn.textContent = '⏸';
    playBtn.setAttribute('aria-label', 'Pause');
    intervalId = setInterval(() => {
      let idx = parseInt(slider.value, 10) + 1;
      if (idx >= points.length) {
        pause();
        return;
      }
      setPosition(idx);
    }, 500); // 0.5s per point; adjust as needed
  }

  playBtn.addEventListener('click', () => {
    if (playing) pause(); else play();
  });

  slider.max = points.length - 1;

  const overlay = document.getElementById('photo-overlay');
  const backdrop = document.getElementById('overlay-backdrop');
  const overlayImg = document.getElementById('overlay-img');
  const overlayCaption = document.getElementById('overlay-caption');
  const overlayLocation = document.getElementById('overlay-location');
  overlay.querySelector('button.close').addEventListener('click', () => hideOverlay());

  let wasPlaying = false;

  function hideOverlay() {
    overlay.classList.remove('show');
    backdrop.classList.remove('show');
    setTimeout(() => {
      overlay.classList.add('hidden');
      backdrop.classList.add('hidden');
    }, 600); // match transition duration

    // resume if it was playing before
    if (wasPlaying) {
      play();
    }
  }

  function showOverlay(photo) {
    overlayImg.src = photo.url;
    overlayCaption.textContent = photo.caption || '';
    overlayLocation.textContent = `Lat ${photo.lat.toFixed(4)}, Lon ${photo.lon.toFixed(4)}`;
    overlay.classList.remove('hidden');
    backdrop.classList.remove('hidden');
    // trigger reflow then add show for transition
    void overlay.offsetWidth;
    overlay.classList.add('show');
    backdrop.classList.add('show');

    renderInteractions(photo);

    // pause timeline if playing
    if (playing) {
      wasPlaying = true;
      pause();
    } else {
      wasPlaying = false;
    }
  }

  function updateUI(idx) {
    const [lat, lon, t] = points[idx];
    marker.setLatLng([lat, lon]);
    label.textContent = new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    if (photoMap[idx]) {
      // show first photo for simplicity
      showOverlay(photoMap[idx][0]);
    }
  }

  setPosition = (idx) => {
    slider.value = idx;
    updateUI(idx);
  };

  slider.addEventListener('input', () => {
    const idx = parseInt(slider.value, 10);
    updateUI(idx);
    if (playing && idx >= points.length - 1) {
      pause();
    }
  });

  // initial position
  setPosition(0);

  // ---- Photo markers on map ----
  if (Array.isArray(data.photos)) {
    data.photos.forEach(photo => {
      const idx = findClosestIndex(photo.taken_at);
      const icon = L.divIcon({
        className: 'photo-marker',
        html: `<img src="${photo.thumb}" alt="" />`,
        iconSize: [32,32],
        iconAnchor: [16,16]
      });
      L.marker([photo.lat, photo.lon], { icon }).addTo(map).on('click', () => {
        setPosition(idx);
        showOverlay(photo);
      });
    });
  }
}

function findClosestIndex(iso) {
  if (!pointsGlobal.length) return -1;
  const target = new Date(iso).getTime();
  let bestIdx = 0;
  let bestDiff = Infinity;
  pointsGlobal.forEach((pt, i) => {
    const diff = Math.abs(new Date(pt[2]).getTime() - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIdx = i;
    }
  });
  return bestIdx;
}
// Lightbox functionality
let currentLightboxIndex = 0;
let lightboxPhotos = [];

function openLightbox(index) {
  // Get photos from the most recent loadDay call
  lightboxPhotos = window.currentDayData?.photos || [];
  if (!lightboxPhotos.length) return;
  
  currentLightboxIndex = index;
  updateLightboxContent();
  
  const lightbox = document.getElementById('lightbox');
  lightbox.classList.add('show');
  
  // Pause timeline if playing
  if (typeof pause === 'function') pause();
}

async function updateLightboxContent() {
  const photo = lightboxPhotos[currentLightboxIndex];
  if (!photo) return;
  
  const img = document.getElementById('lightbox-image');
  const caption = document.getElementById('lightbox-caption');
  const counter = document.getElementById('lightbox-counter');
  
  img.src = photo.url;
  img.alt = photo.caption || '';
  caption.textContent = photo.caption || '';
  counter.textContent = `${currentLightboxIndex + 1} / ${lightboxPhotos.length}`;
  
  // Update nav button visibility
  document.getElementById('lightbox-prev').style.opacity = currentLightboxIndex > 0 ? '1' : '0.3';
  document.getElementById('lightbox-next').style.opacity = currentLightboxIndex < lightboxPhotos.length - 1 ? '1' : '0.3';
  
  // Load interactions for this photo
  await loadPhotoInteractions(photo.id);
}

function closeLightbox() {
  document.getElementById('lightbox').classList.remove('show');
}

function nextPhoto() {
  if (currentLightboxIndex < lightboxPhotos.length - 1) {
    currentLightboxIndex++;
    updateLightboxContent();
  }
}

function prevPhoto() {
  if (currentLightboxIndex > 0) {
    currentLightboxIndex--;
    updateLightboxContent();
  }
}

// Event listeners
document.getElementById('lightbox-close').addEventListener('click', closeLightbox);
document.getElementById('lightbox-next').addEventListener('click', nextPhoto);
document.getElementById('lightbox-prev').addEventListener('click', prevPhoto);

// Click image to zoom
document.getElementById('lightbox-image').addEventListener('click', (e) => {
  e.target.classList.toggle('zoomed');
});

// Keyboard navigation
document.addEventListener('keydown', (e) => {
  const lightbox = document.getElementById('lightbox');
  if (!lightbox.classList.contains('show')) return;
  
  if (e.key === 'Escape') closeLightbox();
  else if (e.key === 'ArrowLeft') prevPhoto();
  else if (e.key === 'ArrowRight') nextPhoto();
});

// Touch/swipe support
let touchStartX = 0;
let touchEndX = 0;

document.getElementById('lightbox').addEventListener('touchstart', (e) => {
  touchStartX = e.changedTouches[0].screenX;
});

document.getElementById('lightbox').addEventListener('touchend', (e) => {
  touchEndX = e.changedTouches[0].screenX;
  const diff = touchStartX - touchEndX;
  
  if (Math.abs(diff) > 50) { // Minimum swipe distance
    if (diff > 0) nextPhoto(); // Swipe left = next
    else prevPhoto(); // Swipe right = previous
  }
});

// Click backdrop to close
document.getElementById('lightbox').addEventListener('click', (e) => {
  if (e.target.id === 'lightbox') closeLightbox();
});

// Gallery interaction display
async function loadGalleryInteractions(photoId) {
  const apiBase = localStorage.getItem('tripAdminSettings') ? 
    JSON.parse(localStorage.getItem('tripAdminSettings')).apiBase || '' : '';
  
  console.log('Loading interactions for:', photoId, 'API base:', apiBase);
  
  try {
    const res = await fetch(`${apiBase}/api/photo/${photoId}/interactions`);
    const data = await res.json();
    console.log('Got interactions:', data);
    
    const interactionsEl = document.getElementById(`interactions-${photoId}`);
    if (!interactionsEl) return;
    
    // Update reactions display
    const reactionsEl = interactionsEl.querySelector('.photo-reactions');
    reactionsEl.innerHTML = '';
    
    Object.entries(data.reactions || {}).forEach(([emoji, count]) => {
      if (count > 0) {
        const span = document.createElement('span');
        span.className = 'photo-reaction';
        span.textContent = `${emoji} ${count}`;
        reactionsEl.appendChild(span);
      }
    });
    
    // Update comment count
    const commentCountEl = interactionsEl.querySelector('.photo-comment-count');
    const commentCount = (data.comments || []).length;
    commentCountEl.textContent = `💬 ${commentCount}`;
    commentCountEl.style.display = commentCount > 0 ? 'block' : 'none';
    
  } catch(err) {
    console.warn('Failed to load gallery interactions:', err);
  }
}

// Photo interactions functionality
async function loadPhotoInteractions(photoId) {
  const apiBase = localStorage.getItem('tripAdminSettings') ? 
    JSON.parse(localStorage.getItem('tripAdminSettings')).apiBase || '' : '';
  
  try {
    const res = await fetch(`${apiBase}/api/photo/${photoId}/interactions`);
    const data = await res.json();
    
    // Update reaction counts
    document.querySelectorAll('#lightbox-reactions .lightbox-react-btn').forEach(btn => {
      const emoji = btn.dataset.emoji;
      const count = data.reactions[emoji] || 0;
      btn.querySelector('span').textContent = count;
    });
    
    // Update comments
    const commentsEl = document.getElementById('lightbox-comments');
    commentsEl.innerHTML = '';
    (data.comments || []).forEach(comment => {
      const div = document.createElement('div');
      div.className = 'lightbox-comment';
      div.innerHTML = `
        <div class="lightbox-comment-author">${comment.author}</div>
        <div class="lightbox-comment-text">${comment.text}</div>
      `;
      commentsEl.appendChild(div);
    });
  } catch(err) {
    console.warn('Failed to load interactions:', err);
  }
}

async function addReaction(photoId, emoji) {
  const apiBase = localStorage.getItem('tripAdminSettings') ? 
    JSON.parse(localStorage.getItem('tripAdminSettings')).apiBase || '' : '';
  
  try {
    const res = await fetch(`${apiBase}/api/photo/${photoId}/react`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emoji })
    });
    
    if (res.ok) {
      const data = await res.json();
      // Update button count
      const btn = document.querySelector(`#lightbox-reactions [data-emoji="${emoji}"]`);
      if (btn) btn.querySelector('span').textContent = data.count;
      
      // Update gallery display
      loadGalleryInteractions(photoId);
    }
  } catch(err) {
    console.error('Failed to add reaction:', err);
  }
}

async function addComment(photoId, text, author = 'Anonymous') {
  const apiBase = localStorage.getItem('tripAdminSettings') ? 
    JSON.parse(localStorage.getItem('tripAdminSettings')).apiBase || '' : '';
  
  try {
    const res = await fetch(`${apiBase}/api/photo/${photoId}/comment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, author })
    });
    
    if (res.ok) {
      const data = await res.json();
      // Add comment to UI
      const commentsEl = document.getElementById('lightbox-comments');
      const div = document.createElement('div');
      div.className = 'lightbox-comment';
      div.innerHTML = `
        <div class="lightbox-comment-author">${data.comment.author}</div>
        <div class="lightbox-comment-text">${data.comment.text}</div>
      `;
      commentsEl.appendChild(div);
      commentsEl.scrollTop = commentsEl.scrollHeight;
      
      // Update gallery display
      loadGalleryInteractions(photoId);
    }
  } catch(err) {
    console.error('Failed to add comment:', err);
  }
}

// Event listeners for interactions
document.getElementById('lightbox-reactions').addEventListener('click', (e) => {
  const btn = e.target.closest('.lightbox-react-btn');
  if (btn && lightboxPhotos[currentLightboxIndex]) {
    const emoji = btn.dataset.emoji;
    const photoId = lightboxPhotos[currentLightboxIndex].id;
    addReaction(photoId, emoji);
  }
});

document.getElementById('lightbox-comment-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = document.getElementById('lightbox-comment-input');
  const text = input.value.trim();
  
  if (text && lightboxPhotos[currentLightboxIndex]) {
    const photoId = lightboxPhotos[currentLightboxIndex].id;
    addComment(photoId, text);
    input.value = '';
  }
});

loadDay();
