/* global L */
// admin/admin.js

import { groupIntoStacks } from "../js/utils.js";

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
    <button id="publish-day" disabled>Publish selected</button>
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

  const previewEl = document.createElement('div');
  previewEl.id = 'stack-preview';
  previewEl.className = 'gallery';
  previewEl.style.marginTop = '1rem';
  previewEl.style.display = 'none';
  panel.appendChild(previewEl);

  let dayData = null;
  let map = null;
  let dayStacks = [];

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
    if (!s.apiBase) return alert('Set Backend API Base URL in Settings first');
    // optionally read s.immichAlbumId if you added that field to settings

    dayData = dayData || {
      date: dateVal, slug: dateVal, segment: 'day',
      title: `Day — ${dateVal}`, stats:{}, polyline:{type:'LineString', coordinates:[]}, points:[], photos:[]
    };

    // Ask our backend to fetch photos for that calendar day (TEMPORARY: using local test route)
    const url = `${s.apiBase}/api/local/day?date=${dateVal}`;
    const resp = await fetch(url);
    if (!resp.ok) {
      const err = await resp.json().catch(()=> ({}));
      console.warn('Local import failed', err);
      return alert('Local import failed. Check the server logs.');
    }
    const data = await resp.json();
    dayData.photos = data.photos || [];

    renderDay();
    controls.querySelector('#save-day').disabled = false;
    controls.querySelector('#preview-day').disabled = false;
    controls.querySelector('#publish-day').disabled = false;
    alert(`Imported ${dayData.photos.length} photos from Immich for ${dateVal}`);
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
          const s = loadSettings();
          const token = s.apiToken || '';
          const id = p.id || p.url; // backend uses id OR url
          const res = await fetch(`${(s.apiBase||'')}/api/day/${dayData.slug}/photo/${encodeURIComponent(id)}`, {
            method: 'DELETE',
            headers: token ? { 'x-admin-token': token } : {}
          });
          if (!res.ok) throw new Error('delete failed');
          wrap.remove();
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

    dayStacks = groupIntoStacks(dayData.photos || [], 50);
    renderPreview();
  }

  function renderPreview() {
    previewEl.innerHTML = '';
    dayStacks.forEach((s) => {
      const wrap = document.createElement('div');
      wrap.style.position = 'relative';
      const img = document.createElement('img');
      const first = s.photos[0] || {};
      img.src = first.thumb || first.url;
      img.alt = s.title || '';
      wrap.appendChild(img);
      if (s.photos.length > 1) {
        const chip = document.createElement('div');
        chip.className = 'chip';
        chip.textContent = String(s.photos.length);
        wrap.appendChild(chip);
      }
      previewEl.appendChild(wrap);
    });
  }

  // Small inline editor for captions & cover
  function openPhotoEditor(photo, wrapperEl) {
    const current = photo.caption || '';
    const edited = prompt('Edit caption (leave blank to clear):', current);
    if (edited === null) return;
    const newCaption = edited.trim();

    (async () => {
      try {
        const s = loadSettings();
        const token = s.apiToken || '';
        const id = photo.id || photo.url;
        // optimistic UI
        photo.caption = newCaption;
        await fetch(`${(s.apiBase||'')}/api/day/${dayData.slug}/photo/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { 'x-admin-token': token } : {})
          },
          body: JSON.stringify({ caption: newCaption })
        });
      } catch (e) {
        console.error(e);
        alert('Caption update failed');
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
    }

    try {
      const adminToken = (loadSettings().apiToken || '').trim();
      const res = await fetch(`${apiBase}/api/day/${dayData.slug}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...(adminToken ? { 'x-admin-token': adminToken } : {})
        },
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

  function previewDay() {
    previewEl.style.display = previewEl.style.display === 'none' ? 'grid' : 'none';
  }

  async function publishSelected() {
    const s = loadSettings();
    const adminToken = (s.apiToken || '').trim();
    if (!adminToken) return alert('Set Admin API Token in Settings first');

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
        caption: p.caption || ''
      }))
    };

    const res = await fetch(`${s.apiBase}/api/publish`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-token': adminToken
      },
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
  controls.querySelector('#load-day').addEventListener('click', loadDay);
  controls.querySelector('#import-day').addEventListener('click', importDay);
  controls.querySelector('#publish-day').addEventListener('click', publishSelected);
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
    <label style="display:block; margin-top:0.5rem;">Immich Album ID
      <input type="text" id="set-immich-album" value="${s.immichAlbumId || ''}" style="width:100%;" />
    </label>
    <label style="display:block; margin-top:0.5rem;">Admin API Token
      <input type="text" id="set-api-token" value="${s.apiToken || ''}" style="width:100%;" />
    </label>
    <button id="save-settings" style="margin-top:1rem;">Save Settings</button>
  `;
  panel.querySelector('#save-settings').addEventListener('click', () => {
    const newSet = {
      apiBase: panel.querySelector('#set-api-base').value.trim(),
      apiToken: panel.querySelector('#set-api-token').value.trim(),
      dawarichUrl: panel.querySelector('#set-dawarich-url').value.trim(),
      dawarichToken: panel.querySelector('#set-dawarich-token').value.trim(),
      immichUrl: panel.querySelector('#set-immich-url').value.trim(),
      immichTokens: panel.querySelector('#set-immich-tokens').value
        .split('\n').map(t => t.trim()).filter(Boolean),
      immichAlbumId: panel.querySelector('#set-immich-album').value.trim()
    };
    saveSettings(newSet);
    alert('Saved');
  });
}

// boot
requirePassword();
