// admin/admin.js

import { groupIntoStacks } from "/js/utils.js";

const MAPBOX_STYLE = 'mapbox://styles/mapbox/satellite-v9';
// Use provided Mapbox token by default; replace with your own for production.
mapboxgl.accessToken =
  mapboxgl.accessToken ||
  'pk.eyJ1IjoianVkZ2UtbW9ja3VwLXdoYW0iLCJhIjoiY21lb3M4dHJiMGUxcjJqcXZ4YzZwZjhubSJ9.EptPsUdI5bt2hOIZfZL3Yg';

const PASS_KEY = 'tripAdminPass';
const SETTINGS_KEY = 'tripAdminSettings';
const app = document.getElementById('app');

function requirePassword() {
  const stored = localStorage.getItem(PASS_KEY);
  if (stored) {
    initApp();
    return;
  }
  const form = document.createElement('form');
  form.innerHTML = `
    <p>Enter admin password:</p>
    <input type="password" id="pwd" style="padding:0.4rem;" />
    <button type="submit">Login</button>
  `;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const val = /** @type {HTMLInputElement} */ (document.getElementById('pwd')).value;
    if (val.trim().length < 3) return alert('Password too short');
    localStorage.setItem(PASS_KEY, val);
    initApp();
  });
  app.appendChild(form);
}

function loadSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); }
  catch { return {}; }
}

function saveSettings(obj) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(obj));
}

  // ----- Admin Helper Functions -----
  async function getAdminToken() {
    const settings = loadSettings();
    // If local token is set, use it (for overrides)
    if (settings.apiToken) {
      return settings.apiToken;
    }
    
    // Otherwise, check if server has admin token configured
    try {
      const res = await fetch(`${apiBase()}/api/admin/config`);
      if (res.ok) {
        const config = await res.json();
        if (config.hasAdminToken) {
          // Server has admin token configured, we don't need to send one
          // The server will use its own ADMIN_TOKEN from .env
          return 'server-configured';
        }
      }
    } catch (error) {
      console.warn('Failed to check server admin token:', error);
    }
    
    return '';
  }
  function apiBase() { return window.location.origin; }

  async function patchPhotoMeta(slug, photoId, meta) {
    const adminToken = await getAdminToken();
    const headers = { 'Content-Type': 'application/json' };
    if (adminToken !== 'server-configured') {
      headers['x-admin-token'] = adminToken;
    }
    const res = await fetch(`${apiBase()}/api/day/${encodeURIComponent(slug)}/photo/${encodeURIComponent(photoId)}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(meta) // { title, caption }
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }

  async function patchStackMeta(slug, stackId, meta) {
    const adminToken = await getAdminToken();
    const headers = {
      'Content-Type': 'application/json'
    };
    
    // Only add admin token header if we have a real token (not 'server-configured')
    if (adminToken !== 'server-configured') {
      headers['x-admin-token'] = adminToken;
    }

    const res = await fetch(`${apiBase()}/api/day/${encodeURIComponent(slug)}/stack/${encodeURIComponent(stackId)}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(meta) // { title, caption }
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }

  function htmlesc(s='') {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
  }

  function formatDateTime(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleString();
  }

  // ----- Admin map state -----
  let adminMap, adminMarkers = [];

// Call this once when your admin panel mounts (or right before Preview shows)
function ensureAdminMap() {
  const mapEl = document.getElementById('trip-map-admin');
  if (!mapEl) return;

  mapEl.classList.add('top-map');

  if (!adminMap) {
    adminMap = new mapboxgl.Map({
      container: mapEl,
      style: MAPBOX_STYLE,
      center: [0, 0],
      zoom: 2,
      pitch: 45,
      bearing: 0,
      antialias: true
    });
    adminMap.addControl(new mapboxgl.NavigationControl());
    adminMap.addControl(new mapboxgl.FullscreenControl());
    adminMap.on('load', () => applyBloom(adminMap));
    queueMicrotask(() => adminMap.resize());
    window.addEventListener('resize', () => adminMap.resize());
  }
}

// Render GPS markers (call every time after you load/import/preview)
function renderAdminMapMarkers(photos) {
  const mapEl = document.getElementById('trip-map-admin');
  if (!mapEl || !adminMap) return;

  // Clear old markers
  adminMarkers.forEach(m => m.remove());
  adminMarkers = [];

  const withGPS = (photos || []).filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon));

  if (!withGPS.length) {
    // Replace with a friendly banner if nothing has GPS
    mapEl.innerHTML = `
      <div style="
        display:flex;align-items:center;justify-content:center;height:100%;
        background: rgba(255,255,255,0.05);
        border: 1px solid rgba(255,255,255,0.1);
        border-radius: 12px; color: #9aa3af; font-weight:600;">
        📍 No location data available for these photos
      </div>`;
    return;
  }

  // Ensure map is initialized before adding markers
  ensureAdminMap();

  const bounds = new mapboxgl.LngLatBounds();
  withGPS.forEach((p, i) => {
    const el = document.createElement('div');
    el.className = 'photo-marker';
    el.innerHTML = `<div class="pm__wrap"><img src="${p.thumb || p.url}" alt=""></div>`;
    const m = new mapboxgl.Marker(el).setLngLat([p.lon, p.lat]).addTo(adminMap);
    el.addEventListener('click', () => {
      if (typeof openLightbox === 'function') openLightbox(i);
    });
    adminMarkers.push(m);
    bounds.extend([p.lon, p.lat]);
  });

  if (!bounds.isEmpty()) {
    adminMap.fitBounds(bounds, { padding: 20 });
  }
  setTimeout(() => adminMap.resize(), 0);
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

// --- helpers for stack grouping ---

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
            Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) *
            Math.sin(dLon/2)**2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}



let rootHandle; // FileSystemDirectoryHandle (optional; not required for basic use)

async function pickProjectFolder() {
  try {
    rootHandle = await window.showDirectoryPicker({ id: 'trip-root' });
    renderTabs();
  } catch (err) {
    console.error(err);
    app.innerHTML = '<p>Folder access is required.</p>';
  }
}

function initApp() {
  app.innerHTML = '';
  renderTabs();
}

function renderTabs() {
  app.innerHTML = '';
  const tabBar = document.createElement('div');
  tabBar.id = 'tabs';

  const tabs = ['Trips', 'Settings'];
  tabs.forEach((name) => {
    const b = document.createElement('button');
    b.textContent = name;
    b.addEventListener('click', () => selectTab(name, b));
    tabBar.appendChild(b);
  });

  app.appendChild(tabBar);

  const panel = document.createElement('div');
  panel.id = 'panel';
  panel.style.marginTop = '1rem';
  app.appendChild(panel);

  // default tab
  selectTab('Trips', tabBar.firstChild);
}

function selectTab(name, btn) {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');

  const panel = document.getElementById('panel');
  panel.innerHTML = '';

  if (name === 'Trips') renderTripsTab(panel);
  else renderSettingsTab(panel);
}

// -------------------- Trips Tab --------------------
function renderTripsTab(panel) {
  panel.innerHTML = '';

  // Add Immich status indicator
  const statusEl = document.createElement('div');
  statusEl.id = 'immich-status';
  statusEl.style.marginBottom = '1rem';
  statusEl.style.padding = '0.5rem';
  statusEl.style.borderRadius = '4px';
  statusEl.style.fontSize = '0.9rem';
  panel.appendChild(statusEl);

  // Load and display Immich status
  async function updateImmichStatus() {
    try {
      const res = await fetch(`${apiBase()}/api/admin/config`);
      if (res.ok) {
        const config = await res.json();
        if (config.immichConfigured) {
          const urls = Array.isArray(config.immichUrls) ? config.immichUrls.join(', ') : config.immichUrl;
          statusEl.innerHTML = `
            <span style="color: green;">✅ Immich configured</span>
            <br><small>URL${Array.isArray(config.immichUrls) && config.immichUrls.length > 1 ? 's' : ''}: ${urls}</small>
            ${config.immichAlbumId ? `<br><small>Album: ${config.immichAlbumId}</small>` : ''}
          `;
          statusEl.style.backgroundColor = '#e8f5e8';
          statusEl.style.border = '1px solid #4caf50';
        } else {
          statusEl.innerHTML = `
            <span style="color: red;">❌ Immich not configured</span>
            <br><small>Missing: ${config.missingConfig.join(', ')}</small>
            <br><small>Create a .env file with IMMICH_URLS and IMMICH_API_KEYS</small>
            <br><button onclick="downloadEnvTemplate()" style="margin-top: 0.5rem; padding: 0.25rem 0.5rem; font-size: 0.8rem;">📄 Get .env Template</button>
          `;
          statusEl.style.backgroundColor = '#ffe8e8';
          statusEl.style.border = '1px solid #f44336';
        }
      }
    } catch (error) {
      statusEl.innerHTML = '<span style="color: orange;">⚠️ Cannot check Immich status</span>';
      statusEl.style.backgroundColor = '#fff3cd';
      statusEl.style.border = '1px solid #ffc107';
    }
  }

  updateImmichStatus();

  const controls = document.createElement('div');
  controls.innerHTML = `
    <label>Date: <input type="date" id="trip-date" /></label>
    <button id="load-day">Load</button>
    <button id="import-day" disabled>Import</button>
    <button id="publish-day" disabled>Publish selected</button>
    <button id="save-day" disabled>Save</button>
  `;
  panel.appendChild(controls);

  // Update import button state based on Immich configuration
  async function updateImportButtonState() {
    try {
      const res = await fetch(`${apiBase()}/api/admin/config`);
      if (res.ok) {
        const config = await res.json();
        const importBtn = controls.querySelector('#import-day');
        if (importBtn) {
          importBtn.disabled = !config.immichConfigured;
          if (!config.immichConfigured) {
            importBtn.title = 'Immich not configured. Create a .env file first.';
          } else {
            importBtn.title = 'Import photos from Immich';
          }
        }
      }
    } catch (error) {
      console.warn('Failed to update import button state:', error);
    }
  }

  updateImportButtonState();

  // Add global function for downloading .env template
  window.downloadEnvTemplate = async function() {
    try {
      const res = await fetch(`${apiBase()}/api/admin/env-template`);
      if (res.ok) {
        const template = await res.text();
        const blob = new Blob([template], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = '.env';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        alert('Downloaded .env template. Please edit it with your Immich settings and restart the server.');
      }
    } catch (error) {
      console.error('Failed to download .env template:', error);
      alert('Failed to download template. Please create a .env file manually.');
    }
  };

  const mapEl = document.createElement('div');
  mapEl.id = 'trip-map-admin';
  mapEl.style.height = '40vh';
  mapEl.style.marginTop = '1rem';
  panel.appendChild(mapEl);
  // Initialize map so users see a base layer immediately
  ensureAdminMap();

  const galleryEl = document.createElement('div');
  galleryEl.id = 'admin-gallery';
  galleryEl.className = 'gallery';
  galleryEl.style.marginTop = '1rem';
  panel.appendChild(galleryEl);

  // Stack Editor (inline title/description + per-photo captions)
  const stackEditorEl = document.createElement('div');
  stackEditorEl.id = 'stack-editor';
  stackEditorEl.className = 'stack-feed-container';
  stackEditorEl.style.marginTop = '1rem';
  panel.appendChild(stackEditorEl);

  let dayData = null;
  let dayStacks = [];

  const settings = loadSettings();

  async function loadDay() {
    console.log('🚀 LoadDay function called');
    const dateVal = /** @type {HTMLInputElement} */(document.getElementById('trip-date')).value;
    console.log('📅 Selected date:', dateVal);
    if (!dateVal) return alert('Choose date');

    const slug = dateVal;
    console.log('🔗 API URL:', `${apiBase()}/api/day/${slug}`);
    try {
      const res = await fetch(`${apiBase()}/api/day/${slug}`);
      console.log('📡 API response status:', res.status);
      if (!res.ok) throw new Error('not found');
      dayData = await res.json();
      console.log('📦 Loaded day data:', dayData);
      console.log('📸 Photos in day:', dayData.photos?.length || 0);
    } catch (error) {
      console.warn('⚠️ Load failed:', error);
      // create a blank shell if missing
      dayData = {
        date: slug,
        segment: 'day',
        slug,
        title: `Day — ${slug}`,
        stats: {},
        polyline: { type: 'LineString', coordinates: [] },
        points: [],
        photos: [],
      };
    }

    // Ensure backward compatibility for stack metadata
    if (dayData.stackCaptions && !dayData.stackMeta) {
      dayData.stackMeta = {};
      for (const [k, v] of Object.entries(dayData.stackCaptions)) {
        dayData.stackMeta[k] = { title: '', caption: String(v || '') };
      }
      delete dayData.stackCaptions;
    }
    dayData.stackMeta = dayData.stackMeta || {};

    renderDay();
    
    // Update map after loading photos
    ensureAdminMap();
    renderAdminMapMarkers(dayData.photos || []);

    controls.querySelector('#save-day').disabled = false;
    controls.querySelector('#publish-day').disabled = !(dayData.photos && dayData.photos.length);
  }

  async function importDay() {
    console.log('📥 ImportDay function called');
    const dateVal = /** @type {HTMLInputElement} */(document.getElementById('trip-date')).value;
    console.log('📅 Selected date:', dateVal);
    if (!dateVal) return alert('Choose date first');

    // Load server config first (prioritize .env)
    let serverConfig = {};
    try {
      const res = await fetch(`${apiBase()}/api/admin/config`);
      if (res.ok) {
        serverConfig = await res.json();
      }
    } catch (error) {
      console.warn('Failed to load server config:', error);
    }
    
    // Check if Immich is properly configured
    if (!serverConfig.immichConfigured) {
      const missing = serverConfig.missingConfig || [];
      const errorMsg = `Immich not configured. Missing: ${missing.join(', ')}.\n\nPlease create a .env file with:\nIMMICH_URLS=https://immich-one.example.com,https://immich-two.example.com\nIMMICH_API_KEYS=your_api_key_1,your_api_key_2\nIMMICH_ALBUM_ID=your_album_id (optional)`;
      alert(errorMsg);
      return;
    }
    
    // Always use server config (from .env) as primary source
    const effectiveAlbumId = serverConfig.immichAlbumId || '';
    console.log('⚙️ Using album ID from .env:', effectiveAlbumId);

    // Reset dayData if switching to a different date so only photos for
    // the imported day are shown
    if (!dayData || dayData.slug !== dateVal) {
      dayData = {
        date: dateVal,
        slug: dateVal,
        segment: 'day',
        title: `Day — ${dateVal}`,
        stats: {},
        polyline: { type: 'LineString', coordinates: [] },
        points: [],
        photos: []
      };
    }

    dayData.photos = dayData.photos || [];

    // Ask backend to import any new photos for that calendar day from Immich
    const url = `${apiBase()}/api/immich/day?date=${dateVal}${effectiveAlbumId ? `&albumId=${encodeURIComponent(effectiveAlbumId)}` : ''}`;
    console.log('🔗 Immich URL:', url);

    // Include admin token header if needed
    const adminToken = await getAdminToken();
    const headers = {};
    if (adminToken !== 'server-configured') {
      headers['x-admin-token'] = adminToken;
    }

    const resp = await fetch(url, { headers });
    if (!resp.ok) {
      const err = await resp.json().catch(()=> ({}));
      console.warn('Immich import failed', err);
      
      let errorMessage = 'Immich import failed. ';
      if (err.error) {
        errorMessage += err.error;
      } else if (resp.status === 500) {
        errorMessage += 'Server error. Check if Immich URL and API keys are correct.';
      } else if (resp.status === 404) {
        errorMessage += 'Immich endpoint not found. Check your Immich URL.';
      } else {
        errorMessage += `HTTP ${resp.status}. Check the server logs.`;
      }
      
      return alert(errorMessage);
    }
    const data = await resp.json();
    console.log('📦 API Response:', data);
    console.log('📸 Photos in response:', data.photos?.length || 0);
    const existing = new Set(dayData.photos.map((p) => p.id || p.url));
    let newCount = 0;
    (data.photos || []).forEach((p) => {
      const key = p.id || p.url;
      if (!existing.has(key)) {
        existing.add(key);
        dayData.photos.push(p);
        newCount++;
      }
    });
    console.log('✨ Added', newCount, 'new photos. Total:', dayData.photos.length);
    // Ensure backward compatibility for stack metadata
    if (dayData.stackCaptions && !dayData.stackMeta) {
      dayData.stackMeta = {};
      for (const [k, v] of Object.entries(dayData.stackCaptions)) {
        dayData.stackMeta[k] = { title: '', caption: String(v || '') };
      }
      delete dayData.stackCaptions;
    }
    dayData.stackMeta = dayData.stackMeta || {};

      renderDay();
    
    // Update map after importing photos
    ensureAdminMap();
    renderAdminMapMarkers(dayData.photos || []);
    
      controls.querySelector('#save-day').disabled = false;
    controls.querySelector('#publish-day').disabled = false;
    alert(`Imported ${newCount} new photos from Immich for ${dateVal}`);
  }

  function renderDay() {
    // Map - Use the improved admin map functions
    try {
      ensureAdminMap();
      renderAdminMapMarkers(dayData?.photos || []);
    } catch (e) {
      console.error('Map render error', e);
    }

    // Gallery
    galleryEl.innerHTML = '';
    (dayData.photos || []).forEach((p, idx) => {
      const wrap = document.createElement('div');
      wrap.style.position = 'relative';
      wrap.setAttribute('draggable', 'true');
      wrap.dataset.idx = String(idx);

      const img = document.createElement('img');
      img.src = p.thumb || p.url;
      img.alt = p.title || p.caption || '';
      wrap.appendChild(img);

      // include checkbox
      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.checked = true;
      Object.assign(chk.style, { position: 'absolute', top: '8px', left: '8px' });
      chk.addEventListener('change', () => { p._include = chk.checked; });
      wrap.appendChild(chk);

      // delete icon (only makes sense for already-published photos)
      const del = document.createElement('button');
      del.textContent = '🗑';
      Object.assign(del.style, {
        position: 'absolute', right: '8px', top: '8px',
        background: '#000a', color: '#fff', border: '0',
        borderRadius: '6px', padding: '2px 6px', cursor: 'pointer'
      });
      del.title = 'Delete photo';
      del.onclick = async (e) => {
        e.stopPropagation();
        if (!confirm('Delete this photo from the day?')) return;
        try {
          const id = p.id || p.url; // backend uses id OR url
          const adminToken = await getAdminToken();
          const headers = {};
          
          // Only add admin token header if we have a real token (not 'server-configured')
          if (adminToken !== 'server-configured') {
            headers['x-admin-token'] = adminToken;
          }
          
          const res = await fetch(`${apiBase()}/api/day/${dayData.slug}/photo/${encodeURIComponent(id)}`, {
            method: 'DELETE',
            headers
          });
          if (!res.ok) throw new Error('delete failed');
          wrap.remove();
          
          // Remove from dayData.photos array and update map
          const photoIndex = dayData.photos.findIndex(photo => (photo.id || photo.url) === id);
          if (photoIndex !== -1) {
            dayData.photos.splice(photoIndex, 1);
            ensureAdminMap();
            renderAdminMapMarkers(dayData.photos || []);
          }
        } catch (err) {
          console.error(err);
          alert('Delete failed');
        }
      };
      wrap.appendChild(del);

      // cover chip
      if (dayData.cover === p.id) {
        const chip = document.createElement('div');
        chip.className = 'chip';
        chip.textContent = 'Cover';
        wrap.appendChild(chip);
      }

      // double-click editor
      wrap.addEventListener('dblclick', () => openPhotoEditor(p));
      galleryEl.appendChild(wrap);
    });

    // Drag & drop reordering
    let dragSrcEl = null;
    galleryEl.querySelectorAll('[draggable]').forEach((el) => {
      el.addEventListener('dragstart', (e) => {
        dragSrcEl = el;
        e.dataTransfer.effectAllowed = 'move';
        // some browsers require data
        e.dataTransfer.setData('text/plain', el.dataset.idx || '');
        el.style.opacity = '0.4';
      });
      el.addEventListener('dragend', () => { el.style.opacity = '1'; });
      el.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; });
      el.addEventListener('drop', (e) => {
        e.preventDefault();
        if (dragSrcEl && dragSrcEl !== el) {
          if (dragSrcEl.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) {
            galleryEl.insertBefore(dragSrcEl, el.nextSibling);
          } else {
            galleryEl.insertBefore(dragSrcEl, el);
          }
          // rebuild photo order
          const newOrder = Array.from(galleryEl.children).map((child) => {
            const i = Number(child.dataset.idx);
            return dayData.photos[i];
          });
          dayData.photos = newOrder;
          
          // Update map after reordering photos
          ensureAdminMap();
          renderAdminMapMarkers(dayData.photos || []);
          
          // reset idx
          galleryEl.querySelectorAll('[draggable]').forEach((c, i) => { c.dataset.idx = String(i); });
        }
      });
    });

   // Group photos into stacks first (distance-based, 500 m)
  dayStacks = groupIntoStacks(dayData.photos || [], 500);

    // Render all stacks with inline editors
  renderStacks();
  }

  function renderStacks() {
    // Clear the editor container before rendering
    stackEditorEl.innerHTML = '';

    // Use the already-computed stacks
    const stacks = dayStacks;

    stacks.forEach((st) => {
      const div = document.createElement('div');
      div.className = 'stack-item';
      div.setAttribute('data-stack-id', st.id);

      // First photo of the stack is used as the thumbnail
      const first = st.photos[0];

      // Get saved metadata (title + description) if available
      const meta = dayData.stackMeta?.[st.id] || { title: '', caption: '' };
      const title = meta.title || '';
      const desc  = meta.caption || '';

      // Build HTML for the stack thumbnail + inline editors
      div.innerHTML = `
        <div style="display:flex; gap:12px; align-items:flex-start;">
          <img src="${first.thumb || first.url}" alt="" style="width:120px;height:90px;object-fit:cover;border-radius:10px;display:block;">
          <div style="flex:1; display:grid; gap:6px;">
            <input
              data-role="stack-title"
              class="card-title"
              value="${htmlesc(title)}"
              placeholder="Stack title"
              style="background:#f8f9fa;border:1px solid var(--border);border-radius:10px;padding:8px 10px;font-weight:800;width:100%;color:#333;">
            <textarea
              data-role="stack-caption"
              rows="2"
              placeholder="Stack description"
              style="width:100%;background:#f8f9fa;border:1px solid var(--border);border-radius:12px;padding:.6rem .75rem;color:#333;">${htmlesc(desc)}</textarea>
            <div style="display:flex; gap:8px; align-items:center;">
              <button class="stack-action-btn" data-role="save-stack">Save</button>
              <button class="stack-action-btn" data-role="open-editor">Open editor</button>
              <span data-role="status" style="font-size:.85rem; color: var(--muted)"></span>
            </div>
          </div>
        </div>
      `;

      stackEditorEl.appendChild(div);
    });

    // Delegate events (bind once)
    if (!stackEditorEl.dataset.bound) {
      stackEditorEl.dataset.bound = '1';

      // Click handlers (Save / Open editor)
      stackEditorEl.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-role="save-stack"], [data-role="open-editor"]');
        if (!btn) return;

        const card = btn.closest('.stack-item');
        if (!card) return;

        const stackId = card.getAttribute('data-stack-id');

        if (btn.getAttribute('data-role') === 'open-editor') {
          const st = (dayStacks || []).find(s => s.id === stackId);
          if (st && typeof openStackEditor === 'function') openStackEditor(st);
          return;
        }

        // Save
        const titleEl   = card.querySelector('[data-role="stack-title"]');
        const captionEl = card.querySelector('[data-role="stack-caption"]');
        const statusEl  = card.querySelector('[data-role="status"]');
        const title   = titleEl ? titleEl.value : '';
        const caption = captionEl ? captionEl.value : '';

        try {
          await patchStackMeta(dayData.slug, stackId, { title, caption });
          dayData.stackMeta = dayData.stackMeta || {};
          dayData.stackMeta[stackId] = { title: title.trim(), caption: caption.trim() };
          if (statusEl) { statusEl.textContent = 'Saved'; setTimeout(()=> statusEl.textContent = '', 1200); }
        } catch (err) {
          if (statusEl) statusEl.textContent = 'Save failed';
          console.error(err);
        }
      });

      // Autosave on blur (title/description)
      stackEditorEl.addEventListener('blur', async (e) => {
        const el = e.target;
        if (!el.matches('[data-role="stack-title"], [data-role="stack-caption"]')) return;

        const card = el.closest('.stack-item');
        if (!card) return;

        const stackId = card.getAttribute('data-stack-id');
        const title   = card.querySelector('[data-role="stack-title"]')?.value || '';
        const caption = card.querySelector('[data-role="stack-caption"]')?.value || '';

        try {
          await patchStackMeta(dayData.slug, stackId, { title, caption });
          dayData.stackMeta = dayData.stackMeta || {};
          dayData.stackMeta[stackId] = { title: title.trim(), caption: caption.trim() };
        } catch {}
      }, true);
    }
  }

  function openStackEditor(stack) {
    const meta = dayData.stackMeta?.[stack.id] || { title: '', caption: '' };
    const currentTitle = meta.title || '';
    const currentCaption = meta.caption || '';
    const newTitle = prompt('Edit stack title (leave blank to clear):', currentTitle);
    if (newTitle === null) return;
    
    const newCaption = prompt('Edit stack description (leave blank to clear):', currentCaption);
    if (newCaption === null) return;

    (async () => {
      try {
        await patchStackMeta(dayData.slug, stack.id, {
          title: newTitle.trim(),
          caption: newCaption.trim()
        });
        
        // Update local data
        dayData.stackMeta = dayData.stackMeta || {};
        const trimmedTitle = newTitle.trim();
        const trimmedCaption = newCaption.trim();
        
        if (!trimmedTitle && !trimmedCaption) {
          delete dayData.stackMeta[stack.id];
        } else {
          dayData.stackMeta[stack.id] = { 
            title: trimmedTitle, 
            caption: trimmedCaption 
          };
        }
        
        // Re-render everything to show updates
        renderStacks();
        ensureAdminMap();
        renderAdminMapMarkers(dayData.photos || []);
      } catch (e) {
        console.error(e);
        alert('Stack metadata update failed');
      }
    })();
  }

  // Small inline editor for photo title/description & cover
  function openPhotoEditor(photo) {
    const currentTitle = photo.title || '';
    const currentCaption = photo.caption || '';
    const newTitle = prompt('Edit photo title (leave blank to clear):', currentTitle);
    if (newTitle === null) return;
    const newCaption = prompt('Edit photo description (leave blank to clear):', currentCaption);
    if (newCaption === null) return;

    (async () => {
      try {
        const id = photo.id || photo.url;
        // optimistic UI
        photo.title = newTitle.trim();
        photo.caption = newCaption.trim();
        await patchPhotoMeta(dayData.slug, id, { title: photo.title, caption: photo.caption });
      } catch (e) {
        console.error(e);
        alert('Photo metadata update failed');
      } finally {
    const makeCover = confirm('Set this photo as the cover for the day?');
    if (makeCover) {
          dayData.cover = photo.id || photo.url;
          // save day cover via full PUT so the index picks it up immediately
          await saveDay();
        } else {
          renderDay();
        }
      }
    })();
  }

  async function saveDay() {
    // filter photos by _include
    if (Array.isArray(dayData.photos)) {
      dayData.photos = dayData.photos.filter((p) => p._include !== false);
      dayData.photos.forEach((p) => delete p._include);
      
      // Update map after filtering photos
      ensureAdminMap();
      renderAdminMapMarkers(dayData.photos || []);
    }

    try {
      const adminToken = await getAdminToken();
      const headers = {
        'Content-Type': 'application/json'
      };
      
      // Only add admin token header if we have a real token (not 'server-configured')
      if (adminToken !== 'server-configured') {
        headers['x-admin-token'] = adminToken;
      }

      const res = await fetch(`${apiBase()}/api/day/${dayData.slug}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify(dayData),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        return alert('Save failed: ' + (err.error || res.status));
      }
      alert('Saved');
    } catch (err) {
      console.error(err);
      alert('Network error');
    }
  }

  async function publishSelected() {
    const adminToken = await getAdminToken();
    if (!adminToken) {
      return alert('Admin token not configured. Please set ADMIN_TOKEN in your .env file or add a local API token in Settings.');
    }

    const sel = (dayData.photos || []).filter(p => p._include !== false);
    if (!sel.length) return alert('Nothing selected');

    const body = {
      date: dayData.slug,
      title: dayData.title || `Day — ${dayData.slug}`,
      photos: sel.map(p => ({
        id: p.id,
        url: p.url,
        thumb: p.thumb,
        taken_at: p.taken_at,
        lat: p.lat,
        lon: p.lon,
        title: p.title || '',
        caption: p.caption || ''
      }))
    };

    const headers = {
      'Content-Type': 'application/json'
    };
    
    // Only add admin token header if we have a real token (not 'server-configured')
    if (adminToken !== 'server-configured') {
      headers['x-admin-token'] = adminToken;
    }

    const res = await fetch(`${apiBase()}/api/publish`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });
    const j = await res.json().catch(()=> ({}));
    if (res.ok) {
      alert(`Published. Total photos for ${dayData.slug}: ${j.total}`);
    } else {
      alert('Publish failed: ' + (j.error || res.status));
    }
  }

  // hook up buttons
  console.log('🔗 Attaching event listeners...');
  controls.querySelector('#load-day').addEventListener('click', loadDay);
  controls.querySelector('#import-day').addEventListener('click', importDay);
  controls.querySelector('#publish-day').addEventListener('click', publishSelected);
  controls.querySelector('#save-day').addEventListener('click', saveDay);
  console.log('✅ Event listeners attached successfully');
}

// -------------------- Settings Tab --------------------
async function renderSettingsTab(panel) {
  const s = loadSettings();
  
  // Show loading message
  panel.innerHTML = '<p>Loading server configuration...</p>';
  
  // Fetch server configuration
  let serverConfig = {};
  try {
    const res = await fetch(`${apiBase()}/api/admin/config`);
    if (res.ok) {
      serverConfig = await res.json();
    }
  } catch (error) {
    console.warn('Failed to load server config:', error);
  }
  
  // Auto-populate from server config, but allow local overrides
  const immichUrls = s.immichUrls || serverConfig.immichUrls || [];
  const immichUrlString = Array.isArray(immichUrls) ? immichUrls.join(',') : immichUrls;
  const immichAlbumId = s.immichAlbumId || serverConfig.immichAlbumId || '';
  const hasServerImmichKeys = serverConfig.hasImmichKeys || false;
  const hasServerAdminToken = serverConfig.hasAdminToken || false;
  
  panel.innerHTML = `
    <h3>Settings</h3>
    
    <div style="background: #f0f9ff; border: 1px solid #0ea5e9; border-radius: 8px; padding: 12px; margin-bottom: 16px;">
      <h4 style="margin: 0 0 8px 0; color: #0369a1;">📋 Server Configuration Status</h4>
      <div style="font-size: 14px; color: #0c4a6e;">
        <div>✅ Immich URLs: <strong>${(serverConfig.immichUrls && serverConfig.immichUrls.length) ? 'Configured' : 'Not set'}</strong></div>
        <div>✅ Immich Album ID: <strong>${serverConfig.immichAlbumId ? 'Configured' : 'Not set'}</strong></div>
        <div>🔑 Immich API Keys: <strong>${hasServerImmichKeys ? 'Configured' : 'Not set'}</strong></div>
        <div>🔑 Admin Token: <strong>${hasServerAdminToken ? 'Configured' : 'Not set'}</strong></div>
      </div>
      <div style="font-size: 12px; color: #475569; margin-top: 8px; font-style: italic;">
        💡 Values below are auto-populated from server .env file. You can override them locally if needed.
      </div>
    </div>
    
    <h4>API Endpoints</h4>
    <label style="display:block; margin-top:0.5rem;">Backend API Base URL
      <input type="text" id="set-api-base" value="${s.apiBase || ''}" placeholder="${window.location.origin} (auto-detected)" style="width:100%;" />
    </label>
    
    <label style="display:block; margin-top:0.5rem;">Immich URLs ${serverConfig.immichUrls && serverConfig.immichUrls.length ? '(from server .env)' : ''}
      <input type="text" id="set-immich-url" value="${immichUrlString}" placeholder="${(serverConfig.immichUrls && serverConfig.immichUrls.length ? serverConfig.immichUrls.join(',') : 'http://immich-one,http://immich-two')}" style="width:100%;" />
    </label>
    
    <label style="display:block; margin-top:0.5rem;">Immich Album ID ${serverConfig.immichAlbumId ? '(from server .env)' : ''}
      <input type="text" id="set-immich-album" value="${immichAlbumId}" placeholder="${serverConfig.immichAlbumId || 'album-uuid-here'}" style="width:100%;" />
    </label>
    
    <h4>Optional Local Overrides</h4>
    <p style="font-size: 14px; color: #6b7280; margin: 8px 0;">These are only needed if you want to override server settings locally:</p>
    
    <label style="display:block; margin-top:0.5rem;">Admin API Token ${hasServerAdminToken ? '✅ Server has token' : '❌ Server missing token'}
      <input type="text" id="set-api-token" value="${s.apiToken || ''}" placeholder="${hasServerAdminToken ? 'Token configured on server (leave blank to use server token)' : 'Add your admin token here'}" style="width:100%;" />
      <div style="font-size: 12px; color: #6b7280; margin-top: 4px;">
        ${hasServerAdminToken ? '✅ Server has ADMIN_TOKEN configured in .env file' : '❌ Set ADMIN_TOKEN=your_token in .env file or add token below'}
      </div>
    </label>
    
    <h4>Legacy Settings</h4>
    <details style="margin-top: 12px;">
      <summary style="cursor: pointer; color: #6b7280;">Show legacy/unused settings</summary>
      <div style="margin-top: 8px; padding: 8px; background: #f9fafb; border-radius: 6px;">
    <label style="display:block; margin-top:0.5rem;">Dawarich URL
      <input type="text" id="set-dawarich-url" value="${s.dawarichUrl || ''}" style="width:100%;" />
    </label>
    <label style="display:block; margin-top:0.5rem;">Dawarich Token
      <input type="text" id="set-dawarich-token" value="${s.dawarichToken || ''}" style="width:100%;" />
    </label>
      </div>
    </details>
    
    <button id="save-settings" style="margin-top:1rem; background: #3b82f6; color: white; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer;">💾 Save Local Settings</button>
    <button id="clear-settings" style="margin-top:1rem; margin-left: 8px; background: #ef4444; color: white; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer;">🗑️ Clear All Local Settings</button>
  `;
  
  panel.querySelector('#save-settings').addEventListener('click', () => {
    const newSet = {
      apiBase: panel.querySelector('#set-api-base').value.trim(),
      apiToken: panel.querySelector('#set-api-token').value.trim(),
      dawarichUrl: panel.querySelector('#set-dawarich-url').value.trim(),
      dawarichToken: panel.querySelector('#set-dawarich-token').value.trim(),
      immichUrls: panel.querySelector('#set-immich-url').value
        .split(',').map(u => u.trim()).filter(Boolean),
      immichAlbumId: panel.querySelector('#set-immich-album').value.trim()
    };
    saveSettings(newSet);
    alert('✅ Local settings saved! These will override server defaults.');
  });
  
  panel.querySelector('#clear-settings').addEventListener('click', () => {
    if (confirm('🗑️ Clear all local settings? This will reset to server defaults.')) {
      localStorage.removeItem(SETTINGS_KEY);
      alert('✅ Local settings cleared! Refreshing...');
      renderSettingsTab(panel); // Refresh the tab
    }
  });
}

// boot
requirePassword();
