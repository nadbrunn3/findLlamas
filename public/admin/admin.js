/* global L */
// admin/admin.js

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

  const controls = document.createElement('div');
  controls.innerHTML = `
    <label>Date: <input type="date" id="trip-date" /></label>
    <button id="load-day">Load</button>
    <button id="import-day">Import</button>
    <button id="save-day" disabled>Save</button>
    <button id="preview-day" disabled>Preview</button>
  `;
  panel.appendChild(controls);

  const mapEl = document.createElement('div');
  mapEl.id = 'trip-map-admin';
  mapEl.style.height = '40vh';
  mapEl.style.marginTop = '1rem';
  panel.appendChild(mapEl);

  const galleryEl = document.createElement('div');
  galleryEl.id = 'admin-gallery';
  galleryEl.className = 'gallery';
  galleryEl.style.marginTop = '1rem';
  panel.appendChild(galleryEl);

  const iframe = document.createElement('iframe');
  iframe.id = 'preview-frame';
  iframe.style.width = '100%';
  iframe.style.height = '60vh';
  iframe.style.marginTop = '1rem';
  iframe.style.display = 'none';
  iframe.setAttribute('title', 'Day Preview');
  panel.appendChild(iframe);

  let dayData = null;
  let map = null;

  const settings = loadSettings();
  const apiBase = settings.apiBase || '';

  async function loadDay() {
    const dateVal = /** @type {HTMLInputElement} */(document.getElementById('trip-date')).value;
    if (!dateVal) return alert('Choose date');

    const slug = dateVal;
    try {
      const res = await fetch(`${apiBase}/api/day/${slug}`);
      if (!res.ok) throw new Error('not found');
      dayData = await res.json();
    } catch {
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

    renderDay();
    controls.querySelector('#save-day').disabled = false;
    controls.querySelector('#preview-day').disabled = false;
  }

  async function importDay() {
    const dateVal = /** @type {HTMLInputElement} */(document.getElementById('trip-date')).value;
    if (!dateVal) return alert('Choose date first');

    const s = loadSettings();
    if (!s.dawarichUrl || !s.immichUrl) {
      return alert('Configure Dawarich/Immich endpoints in Settings first');
    }

    try {
      dayData = dayData || {
        date: dateVal,
        slug: dateVal,
        segment: 'day',
        title: `Day — ${dateVal}`,
        stats: {},
        polyline: { type: 'LineString', coordinates: [] },
        points: [],
        photos: [],
      };

      // Track (placeholder)
      const trackUrl = `${s.dawarichUrl}/api/track?date=${dateVal}`;
      const tRes = await fetch(trackUrl, { headers: { Authorization: `Bearer ${s.dawarichToken || ''}` } });
      if (tRes.ok) {
        const track = await tRes.json();
        dayData.polyline = track.polyline || dayData.polyline;
        dayData.points = track.points || dayData.points;
      } else {
        console.warn('Track fetch failed, using dummy');
        dayData.polyline = { type: 'LineString', coordinates: [[14.42, 50.09], [14.43, 50.10], [14.44, 50.11]] };
        dayData.points = [
          { t: `${dateVal}T08:00:00Z`, lat: 50.09, lon: 14.42 },
          { t: `${dateVal}T08:30:00Z`, lat: 50.10, lon: 14.43 },
          { t: `${dateVal}T09:00:00Z`, lat: 50.11, lon: 14.44 },
        ];
      }

      // Photos (placeholder)
      dayData.photos = [];
      if (Array.isArray(s.immichTokens) && s.immichTokens.length) {
        for (const tok of s.immichTokens) {
          const photosUrl = `${s.immichUrl}/api/album/Public-Trip/photos?date=${dateVal}`;
          const pRes = await fetch(photosUrl, { headers: { 'x-api-key': tok } });
          if (pRes.ok) {
            const arr = await pRes.json();
            if (Array.isArray(arr)) dayData.photos.push(...arr);
          } else {
            console.warn('Photo fetch failed for token', tok);
          }
        }
      }

      if (!dayData.photos.length) {
        console.warn('No photos imported, using placeholder');
        dayData.photos = [{
          id: 'demo1',
          url: 'https://picsum.photos/seed/demo1/1600/900',
          thumb: 'https://picsum.photos/seed/demo1/400/225',
          taken_at: `${dateVal}T08:30:00Z`,
          lat: 50.10, lon: 14.43,
          caption: 'Placeholder',
        }];
      }

      dayData.date = dateVal;
      dayData.slug = dateVal;
      dayData.segment = 'day';
      dayData.title = dayData.title || `Day — ${dateVal}`;

      renderDay();
      controls.querySelector('#save-day').disabled = false;
      controls.querySelector('#preview-day').disabled = false;
    } catch (err) {
      console.error(err);
      alert('Import failed – see console.');
    }
  }

  function renderDay() {
    // Map
    try {
      if (map) map.remove();
      map = L.map(mapEl);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OSM', maxZoom: 19,
      }).addTo(map);

      const coords = (dayData?.polyline?.coordinates || []);
      const latlngs = coords.map(([lon, lat]) => [lat, lon]);
      if (latlngs.length) {
        const poly = L.polyline(latlngs, { color: 'steelblue', weight: 4 }).addTo(map);
        map.fitBounds(poly.getBounds(), { padding: [20, 20] });
      }
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
      img.alt = p.caption || '';
      wrap.appendChild(img);

      // include checkbox
      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.checked = true;
      Object.assign(chk.style, { position: 'absolute', top: '8px', left: '8px' });
      chk.addEventListener('change', () => { p._include = chk.checked; });
      wrap.appendChild(chk);

      // cover chip
      if (dayData.cover === p.id) {
        const chip = document.createElement('div');
        chip.className = 'chip';
        chip.textContent = 'Cover';
        wrap.appendChild(chip);
      }

      // double-click editor
      wrap.addEventListener('dblclick', () => openPhotoEditor(p, wrap));
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
          // reset idx
          galleryEl.querySelectorAll('[draggable]').forEach((c, i) => { c.dataset.idx = String(i); });
        }
      });
    });
  }

  // Small inline editor for captions & cover
  function openPhotoEditor(photo, wrapperEl) {
    const current = photo.caption || '';
    const edited = prompt('Edit caption (leave blank to clear):', current);
    if (edited !== null) {
      photo.caption = edited.trim();
    }
    const makeCover = confirm('Set this photo as the cover for the day?');
    if (makeCover) {
      dayData.cover = photo.id || photo.url; // prefer stable id
    }
    renderDay(); // refresh chips/captions
  }

  async function saveDay() {
    // filter photos by _include
    if (Array.isArray(dayData.photos)) {
      dayData.photos = dayData.photos.filter((p) => p._include !== false);
      dayData.photos.forEach((p) => delete p._include);
    }

    try {
      const res = await fetch(`${apiBase}/api/day/${dayData.slug}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dayData),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        return alert('Save failed: ' + (err.error || res.status));
      }
      alert('Saved & committed');
    } catch (err) {
      console.error(err);
      alert('Network error');
    }
  }

  function previewDay() {
    iframe.src = `../day.html?date=${encodeURIComponent(dayData.slug)}`;
    iframe.style.display = 'block';
    iframe.focus();
  }

  // hook up buttons
  controls.querySelector('#load-day').addEventListener('click', loadDay);
  controls.querySelector('#import-day').addEventListener('click', importDay);
  controls.querySelector('#save-day').addEventListener('click', saveDay);
  controls.querySelector('#preview-day').addEventListener('click', previewDay);
}

// -------------------- Settings Tab --------------------
function renderSettingsTab(panel) {
  const s = loadSettings();
  panel.innerHTML = `
    <h3>API Endpoints</h3>
    <label style="display:block; margin-top:0.5rem;">Backend API Base URL
      <input type="text" id="set-api-base" value="${s.apiBase || ''}" style="width:100%;" />
    </label>
    <label style="display:block; margin-top:0.5rem;">Dawarich URL
      <input type="text" id="set-dawarich-url" value="${s.dawarichUrl || ''}" style="width:100%;" />
    </label>
    <label style="display:block; margin-top:0.5rem;">Dawarich Token
      <input type="text" id="set-dawarich-token" value="${s.dawarichToken || ''}" style="width:100%;" />
    </label>
    <label style="display:block; margin-top:0.5rem;">Immich URL
      <input type="text" id="set-immich-url" value="${s.immichUrl || ''}" style="width:100%;" />
    </label>
    <label style="display:block; margin-top:0.5rem;">Immich Tokens (one per line)
      <textarea id="set-immich-tokens" style="width:100%; height:80px;">${(s.immichTokens || []).join('\n')}</textarea>
    </label>
    <button id="save-settings" style="margin-top:1rem;">Save Settings</button>
  `;
  panel.querySelector('#save-settings').addEventListener('click', () => {
    const newSet = {
      apiBase: panel.querySelector('#set-api-base').value.trim(),
      dawarichUrl: panel.querySelector('#set-dawarich-url').value.trim(),
      dawarichToken: panel.querySelector('#set-dawarich-token').value.trim(),
      immichUrl: panel.querySelector('#set-immich-url').value.trim(),
      immichTokens: panel.querySelector('#set-immich-tokens').value
        .split('\n').map((t) => t.trim()).filter(Boolean),
    };
    saveSettings(newSet);
    alert('Saved');
  });
}

// boot
requirePassword();
