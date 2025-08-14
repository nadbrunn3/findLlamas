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
  form.addEventListener('submit', e => {
    e.preventDefault();
    const val = document.getElementById('pwd').value;
    if (val.trim().length < 3) return alert('Password too short');
    localStorage.setItem(PASS_KEY, val);
    initApp();
  });
  app.appendChild(form);
}

function loadSettings() {
  return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
}

function saveSettings(obj) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(obj));
}

let rootHandle; // FileSystemDirectoryHandle

async function pickProjectFolder() {
  try {
    rootHandle = await window.showDirectoryPicker({id:'trip-root'});
    renderTabs();
  } catch(err) {
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
  const tabs = ['Trips','Blog','Settings'];
  tabs.forEach(name => {
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
  selectTab('Trips', tabBar.firstChild);
}

function selectTab(name, btn) {
  document.querySelectorAll('#tabs button').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  const panel = document.getElementById('panel');
  panel.innerHTML = '';
  if (name==='Trips') renderTripsTab(panel);
  else if (name==='Blog') renderBlogTab(panel);
  else renderSettingsTab(panel);
}

// ---- stubbed tab renderers ----
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
  panel.appendChild(iframe);

  let dayData = null;
  let map = null;

  const settings = loadSettings();
  const apiBase = settings.apiBase || '';

  async function loadDay() {
    const dateVal = document.getElementById('trip-date').value;
    if (!dateVal) return alert('Choose date');
    const slug = dateVal;
    try {
      const res = await fetch(`${apiBase}/api/day/${slug}`);
      if (res.ok) {
        dayData = await res.json();
      } else {
        throw new Error('not found');
      }
    } catch(err) {
      dayData = {
        date: slug,
        segment: 'day',
        slug,
        title: `Day — ${slug}`,
        stats: {},
        polyline: { type:'LineString', coordinates: [] },
        points: [],
        photos: []
      };
    }
    renderDay();
    document.getElementById('save-day').disabled = false;
    document.getElementById('preview-day').disabled = false;
  }

  async function importDay() {
    const dateVal = document.getElementById('trip-date').value;
    if (!dateVal) return alert('Choose date first');
    const settings = loadSettings();
    if (!settings.dawarichUrl || !settings.immichUrl) return alert('Configure Dawarich/Immich endpoints in Settings first');
    try {
      // --- Fetch track --- (placeholder example)
      const trackUrl = `${settings.dawarichUrl}/api/track?date=${dateVal}`;
      const tRes = await fetch(trackUrl, { headers: { 'Authorization': `Bearer ${settings.dawarichToken||''}` }});
      if (tRes.ok) {
        const track = await tRes.json();
        dayData = dayData || {};
        dayData.polyline = track.polyline;
        dayData.points   = track.points;
      } else {
        console.warn('Track fetch failed, using dummy');
        // dummy fallback
        dayData.polyline = { type:'LineString', coordinates: [[14.42,50.09],[14.43,50.10],[14.44,50.11]] };
        dayData.points = [
          { t: `${dateVal}T08:00:00Z`, lat:50.09, lon:14.42},
          { t: `${dateVal}T08:30:00Z`, lat:50.10, lon:14.43},
          { t: `${dateVal}T09:00:00Z`, lat:50.11, lon:14.44}
        ];
      }

      // --- Fetch photos --- (placeholder)
      dayData.photos = [];
      if (settings.immichTokens && settings.immichTokens.length) {
        for (const tok of settings.immichTokens) {
          const photosUrl = `${settings.immichUrl}/api/album/Public-Trip/photos?date=${dateVal}`;
          const pRes = await fetch(photosUrl, { headers: { 'x-api-key': tok }});
          if (pRes.ok) {
            const arr = await pRes.json();
            dayData.photos.push(...arr);
          } else {
            console.warn('Photo fetch failed for token', tok);
          }
        }
      }

      if (!dayData.photos.length) {
        console.warn('No photos imported, using placeholder');
        dayData.photos = [
          {
            id:'demo1',
            url:'https://picsum.photos/seed/demo1/1600/900',
            thumb:'https://picsum.photos/seed/demo1/400/225',
            taken_at:`${dateVal}T08:30:00Z`,
            lat:50.10, lon:14.43,
            caption:'Placeholder'
          }
        ];
      }

      // set other fields
      dayData.date = dateVal;
      dayData.slug = dateVal;
      dayData.segment = 'day';
      dayData.title = dayData.title || `Day — ${dateVal}`;

      renderDay();
      document.getElementById('save-day').disabled = false;
      document.getElementById('preview-day').disabled = false;
    } catch(err) {
      console.error(err);
      alert('Import failed – see console.');
    }
  }

  function renderDay() {
    // Map
    if (map) { map.remove(); }
    map = L.map(mapEl);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution:'&copy; OSM', maxZoom:19
    }).addTo(map);
    const latlngs = dayData.polyline.coordinates.map(([lon,lat])=>[lat,lon]);
    if (latlngs.length) {
      const poly = L.polyline(latlngs,{color:'steelblue',weight:4}).addTo(map);
      map.fitBounds(poly.getBounds(), {padding:[20,20]});
    }

    // gallery
    galleryEl.innerHTML = '';
    dayData.photos.forEach((p,idx)=>{
      const wrap = document.createElement('div');
      wrap.style.position='relative';
      wrap.setAttribute('draggable','true');
      wrap.dataset.idx = idx;
      wrap.innerHTML = `<img src="${p.thumb||p.url}" style="width:100%;" />`;
      const chk = document.createElement('input');
      chk.type='checkbox';
      chk.checked=true;
      chk.style.position='absolute'; chk.style.top='8px'; chk.style.left='8px';
      chk.addEventListener('change',()=>{
        p._include = chk.checked;
      });

      // click to edit caption / set cover
      wrap.addEventListener('dblclick',()=>openPhotoEditor(p, wrap));
      wrap.appendChild(chk);
      galleryEl.appendChild(wrap);
    });

    // drag-and-drop handlers
    let dragSrcEl = null;
    galleryEl.querySelectorAll('[draggable]')
      .forEach(el=>{
        el.addEventListener('dragstart', e=>{
          dragSrcEl = el;
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain','');
          el.style.opacity = '0.4';
        });
        el.addEventListener('dragend', ()=>{
          el.style.opacity='1';
        });
        el.addEventListener('dragover', e=>{
          e.preventDefault();
          e.dataTransfer.dropEffect='move';
        });
        el.addEventListener('drop', e=>{
          e.preventDefault();
          if(dragSrcEl && dragSrcEl!==el){
            if(dragSrcEl.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING){
              galleryEl.insertBefore(dragSrcEl, el.nextSibling);
            } else {
              galleryEl.insertBefore(dragSrcEl, el);
            }
            // rebuild photo order
            const newOrder = Array.from(galleryEl.children).map(child=>dayData.photos[child.dataset.idx]);
            dayData.photos = newOrder;
            // update data-idx values
            galleryEl.querySelectorAll('[draggable]').forEach((c,i)=>{c.dataset.idx=i;});
          }
        });
      });
  }

  async function saveDay() {
    // filter photos by _include flag
    if (dayData.photos) {
      dayData.photos = dayData.photos.filter(p=>p._include!==false);
      dayData.photos.forEach(p=>delete p._include);
    }
    try {
      const res = await fetch(`${apiBase}/api/day/${dayData.slug}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dayData)
      });
      if (res.ok) {
        alert('Saved & committed');
      } else {
        const err = await res.json();
        alert('Save failed: ' + (err.error||res.status));
      }
    } catch(err) {
      console.error(err);
      alert('Network error');
    }
  }

  function previewDay() {
    iframe.src = `../day.html?date=${dayData.slug}`;
    iframe.style.display='block';
  }

  controls.querySelector('#load-day').addEventListener('click', loadDay);
  controls.querySelector('#import-day').addEventListener('click', importDay);
  controls.querySelector('#save-day').addEventListener('click', saveDay);
  controls.querySelector('#preview-day').addEventListener('click', previewDay);
}

function renderBlogTab(panel) {
  const settings = loadSettings();
  const apiBase = settings.apiBase || '';
  panel.innerHTML = `<button id="new-post">New Post</button><div id="posts-list" style="margin-top:1rem;"></div><div id="editor" style="margin-top:1rem;"></div>`;

  const listEl = panel.querySelector('#posts-list');
  const editorEl = panel.querySelector('#editor');

  async function loadList(){
    listEl.innerHTML='Loading…';
    try{
      const res=await fetch(`${apiBase}/api/blog`);
      const posts=await res.json();
      listEl.innerHTML='';
      posts.forEach(p=>{
        const btn=document.createElement('button');
        btn.textContent=`${p.date} — ${p.title}`;
        btn.style.display='block';
        btn.style.margin='0.3rem 0';
        btn.addEventListener('click',()=>openEditor(p.slug));
        listEl.appendChild(btn);
      });
    }catch(err){listEl.textContent='Failed to load list';}
  }

  function openEditor(slug){
    editorEl.innerHTML='Loading…';
    fetch(`${apiBase}/api/blog/${slug}`).then(r=>r.json()).then(data=>{
      buildEditor(slug,data.title,data.date,data.markdown);
    }).catch(()=>{
      buildEditor(slug,'','', '');
    });
  }

  function buildEditor(slug,title,date,md){
    editorEl.innerHTML=`
      <label>Title <input type="text" id="post-title" style="width:100%;" value="${title}" /></label>
      <label>Date <input type="date" id="post-date" value="${date}" /></label>
      <div style="display:flex; gap:1rem; margin-top:0.5rem;">
        <textarea id="post-md" style="width:50%; height:300px;">${md}</textarea>
        <div id="post-preview" style="width:50%; height:300px; overflow:auto; border:1px solid #ccc; padding:0.5rem;"></div>
      </div>
      <button id="save-post" style="margin-top:0.5rem;">Save</button>
    `;
    const mdEl=editorEl.querySelector('#post-md');
    const prev=editorEl.querySelector('#post-preview');
    const updatePrev=()=>{prev.innerHTML=window.marked.parse(mdEl.value);};
    mdEl.addEventListener('input',updatePrev);updatePrev();

    editorEl.querySelector('#save-post').addEventListener('click',async()=>{
      const body={
        title: editorEl.querySelector('#post-title').value.trim(),
        date: editorEl.querySelector('#post-date').value.trim(),
        markdown: mdEl.value
      };
      if(!body.title||!body.date) return alert('Title and date required');
      const res=await fetch(`${apiBase}/api/blog/${slug}`,{
        method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)
      });
      if(res.ok){alert('Saved');loadList();}
      else alert('Save failed');
    });
  }

  panel.querySelector('#new-post').addEventListener('click',()=>{
    const slug=new Date().toISOString().split('T')[0]+ '-' + Math.random().toString(36).slice(2,6);
    buildEditor(slug,'','', '');
  });

  loadList();
}

function renderSettingsTab(panel) {
  const s = loadSettings();
  panel.innerHTML = `
    <h3>API Endpoints</h3>
    <label style="display:block; margin-top:0.5rem;">Backend API Base URL <input type="text" id="set-api-base" value="${s.apiBase||''}" style="width:100%;" /></label>
    <label style="display:block; margin-top:0.5rem;">Dawarich URL <input type="text" id="set-dawarich-url" value="${s.dawarichUrl||''}" style="width:100%;" /></label>
    <label style="display:block; margin-top:0.5rem;">Dawarich Token <input type="text" id="set-dawarich-token" value="${s.dawarichToken||''}" style="width:100%;" /></label>
    <label style="display:block; margin-top:0.5rem;">Immich URL <input type="text" id="set-immich-url" value="${s.immichUrl||''}" style="width:100%;" /></label>
    <label style="display:block; margin-top:0.5rem;">Immich Tokens (one per line) <textarea id="set-immich-tokens" style="width:100%; height:80px;">${(s.immichTokens||[]).join('\n')}</textarea></label>
    <button id="save-settings" style="margin-top:1rem;">Save Settings</button>
  `;
  panel.querySelector('#save-settings').addEventListener('click', ()=>{
    const newSet = {
      apiBase: panel.querySelector('#set-api-base').value.trim(),
      dawarichUrl: panel.querySelector('#set-dawarich-url').value.trim(),
      dawarichToken: panel.querySelector('#set-dawarich-token').value.trim(),
      immichUrl: panel.querySelector('#set-immich-url').value.trim(),
      immichTokens: panel.querySelector('#set-immich-tokens').value.split('\n').map(t=>t.trim()).filter(Boolean)
    };
    saveSettings(newSet);
    alert('Saved');
  });
}

requirePassword();