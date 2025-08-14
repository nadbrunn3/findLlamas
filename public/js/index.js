// public/js/index.js
async function loadDays() {
  try {
    const res = await fetch('days/index.json');
    const days = await res.json();
    renderCards(days);
    if (window.L) {
      await renderTripMap(days);
    }
  } catch (err) {
    console.error('Failed to load index.json', err);
  }
}

function renderCards(days) {
  const list = document.getElementById('days-list');
  days.forEach(day => {
    const a = document.createElement('a');
    a.href = `day.html?date=${day.slug}`;
    a.className = 'card';
    a.innerHTML = `
      <img src="${day.cover}" alt="${day.title}" />
      <h3>${day.title}</h3>
      <p>${day.date}</p>
    `;
    list.appendChild(a);
  });
}

async function renderTripMap(days) {
  const mapEl = document.getElementById('trip-map');
  const map = L.map(mapEl);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap',
    maxZoom: 19,
  }).addTo(map);

  const bounds = L.latLngBounds();
  const colors = ['steelblue', 'tomato', 'goldenrod', 'mediumseagreen', 'orchid'];

  const allPhotos = [];

  await Promise.all(days.map(async (day, idx) => {
    try {
      const res = await fetch(`days/${day.slug}.json`);
      const data = await res.json();
      const latlngs = (data.polyline?.coordinates || []).map(([lon, lat]) => [lat, lon]);
      if (latlngs.length) {
        const color = colors[idx % colors.length];
        const poly = L.polyline(latlngs, { color, weight: 4, opacity: 0.7 }).addTo(map);
        bounds.extend(poly.getBounds());
        poly.on('click', () => {
          window.location.href = `day.html?date=${day.slug}`;
        });

        // collect photos for sample
        (data.photos || []).forEach(p => {
          allPhotos.push({ ...p, slug: day.slug });
        });
      }
    } catch (e) {
      console.error('Failed to load day file', day.slug, e);
    }
  }));

  if (bounds.isValid()) {
    map.fitBounds(bounds, { padding: [20, 20] });
  }

  renderPhotoSample(allPhotos);
  loadBlogPreview();
}

async function loadBlogPreview() {
  try {
    const res = await fetch('blog/index.json');
    const posts = await res.json();
    const container = document.getElementById('home-blog-list');
    if (!container) return;
    posts.slice(0,3).forEach(post => {
      const a = document.createElement('a');
      a.href = `blog/${post.slug}.html`;
      a.className = 'card';
      a.innerHTML = `
        <h3>${post.title}</h3>
        <p style="opacity:0.8; font-size:0.9rem;">${post.date}</p>
        <p>${post.excerpt}</p>
      `;
      container.appendChild(a);
    });
  } catch(err) {
    console.error('Failed to load blog preview', err);
  }
}

function renderPhotoSample(photos) {
  if (!photos.length) return;
  const container = document.getElementById('sample-photos');
  if (!container) return;
  // shuffle
  photos.sort(() => 0.5 - Math.random());
  const sample = photos.slice(0, 6);
  sample.forEach(p => {
    const a = document.createElement('a');
    a.href = `day.html?date=${p.slug}`;
    a.className = 'card';
    a.innerHTML = `<img loading="lazy" src="${p.thumb}" alt="${p.caption || ''}" />`;
    container.appendChild(a);
  });
}

loadDays();
