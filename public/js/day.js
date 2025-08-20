import { dataUrl, getApiBase, haversineKm, escapeHtml, formatTime, formatDateTime } from "./utils.js";

// Get date from URL parameter
const urlParams = new URLSearchParams(window.location.search);
const daySlug = urlParams.get('date');

if (!daySlug) {
  document.getElementById('day-title').textContent = 'No date specified';
  throw new Error('No date parameter provided');
}

let dayData = null;
let map = null;

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
        📍 No location data available for these photos
      </div>
    `;
    return;
  }

  console.log(`📍 Found ${photosWithGPS.length} photos with GPS coordinates`);

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

  // Add markers for photos with GPS coordinates
  const bounds = L.latLngBounds();

  photosWithGPS.forEach((photo, index) => {
    const marker = L.marker([photo.lat, photo.lon]).addTo(map);
    marker.bindPopup(`
      <img src="${photo.thumb || photo.url}" style="width:100px;height:75px;object-fit:cover;border-radius:4px;" alt="">
      <br><strong>${escapeHtml(photo.caption || 'Photo')}</strong>
      <br><small>${formatTime(photo.taken_at)}</small>
    `);
    
    // Find the original index in the full photos array
    const originalIndex = dayData.photos.findIndex(p => p.id === photo.id);
    marker.on('click', () => openLightbox(originalIndex));
    bounds.extend([photo.lat, photo.lon]);
  });

  map.fitBounds(bounds, { padding: [20, 20] });
}

// Render the photo post section
function renderPhotoPost() {
  const container = document.getElementById('photo-post');
  console.log('📸 Rendering photo post, photos count:', dayData?.photos?.length);
  
  if (!dayData?.photos?.length) {
    container.innerHTML = '<p>No photos for this day.</p>';
    return;
  }

  const photos = dayData.photos;
  const mainPhoto = photos[0];

  container.innerHTML = `
    <div class="photo-post-card">
      <div class="photo-header">
        <h2>${escapeHtml(dayData.title || `Day — ${daySlug}`)}</h2>
        <p class="photo-meta">${formatDateTime(mainPhoto.taken_at)} • ${photos.length} photo${photos.length > 1 ? 's' : ''}</p>
      </div>
      
      <div class="photo-main">
        <img src="${mainPhoto.url}" alt="${escapeHtml(mainPhoto.caption || '')}" onclick="openLightbox(0)">
        ${mainPhoto.caption ? `<p class="photo-caption">${escapeHtml(mainPhoto.caption)}</p>` : ''}
      </div>
      
      ${photos.length > 1 ? `
        <div class="photo-thumbnails">
          ${photos.slice(1, 5).map((photo, index) => `
            <img src="${photo.thumb || photo.url}" 
                 alt="${escapeHtml(photo.caption || '')}" 
                 onclick="openLightbox(${index + 1})"
                 class="thumbnail">
          `).join('')}
          ${photos.length > 5 ? `<div class="more-photos" onclick="openLightbox(5)">+${photos.length - 5}</div>` : ''}
        </div>
      ` : ''}
      
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
}

// Lightbox functionality
let currentPhotoIndex = 0;

function openLightbox(index = 0) {
  if (!dayData?.photos?.length) return;
  
  currentPhotoIndex = Math.max(0, Math.min(index, dayData.photos.length - 1));
  const lightbox = document.getElementById('lightbox');
  const photo = dayData.photos[currentPhotoIndex];
  
  document.getElementById('lightbox-image').src = photo.url;
  document.getElementById('lightbox-caption').textContent = photo.caption || '';
  document.getElementById('lightbox-counter').textContent = `${currentPhotoIndex + 1} / ${dayData.photos.length}`;
  
  lightbox.classList.add('open');
  document.body.classList.add('lightbox-open');
  
  // Update navigation buttons
  document.getElementById('lightbox-prev').disabled = currentPhotoIndex === 0;
  document.getElementById('lightbox-next').disabled = currentPhotoIndex === dayData.photos.length - 1;
}

function closeLightbox() {
  document.getElementById('lightbox').classList.remove('open');
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

// Event listeners for lightbox
document.getElementById('lightbox-close').addEventListener('click', closeLightbox);
document.getElementById('lightbox-prev').addEventListener('click', previousPhoto);
document.getElementById('lightbox-next').addEventListener('click', nextPhoto);

// Keyboard navigation
document.addEventListener('keydown', (e) => {
  if (!document.getElementById('lightbox').classList.contains('open')) return;
  
  if (e.key === 'Escape') closeLightbox();
  if (e.key === 'ArrowLeft') previousPhoto();
  if (e.key === 'ArrowRight') nextPhoto();
});

// Click outside to close
document.getElementById('lightbox').addEventListener('click', (e) => {
  if (e.target.id === 'lightbox') closeLightbox();
});

// Interactions (simplified for day view)
function toggleLike() {
  // TODO: Implement like functionality for the day/stack
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
  
  // TODO: Implement comment submission
  console.log('Comment added:', text);
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
