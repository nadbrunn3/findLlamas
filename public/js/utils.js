// --- Data paths (single source of truth) ---
export const DATA_ROOT = 'data';
export const dataUrl = (...parts) => [DATA_ROOT, ...parts].join('/');

// --- URL helpers ---
export const qs = (k, s = window.location.search) => new URLSearchParams(s).get(k);
export const urlParam = qs;
export const pushUrlParam = (k, v) => {
  const u = new URL(window.location); u.searchParams.set(k, v); history.pushState(null, "", u);
};
export const replaceUrlParam = (k, v) => {
  const u = new URL(window.location); u.searchParams.set(k, v); history.replaceState(null, "", u);
};

// --- Media helpers ---
// Return the best available thumbnail URL for a media item, falling back to
// known legacy property names before using the full-size URL.
export function thumbUrl(item = {}) {
  return (
    item.thumb ||
    item.thumbUrl ||
    item.thumbnailUrl ||
    item.url ||
    ''
  );
}

// --- API base (single source of truth) ---
export function getApiBase() {
  try {
    const raw = localStorage.getItem("tripAdminSettings");
    if (!raw) return "";
    const { apiBase } = JSON.parse(raw) || {};
    const base = apiBase || "";
    // Remove trailing slash to prevent double slashes in URLs
    return base.replace(/\/$/, "");
  } catch { return ""; }
}

// --- math ---
export function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
            Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) *
            Math.sin(dLon/2)**2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ---------------------------
// Stacking photos into groups
// ---------------------------

function isFiniteCoord(v) {
  return Number.isFinite(v);
}

function haversineMetersPt(a, b) {
  const R = 6371000; // meters
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const la1 = toRad(a.lat);
  const la2 = toRad(b.lat);
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLon / 2);
  const h = s1 * s1 + Math.cos(la1) * Math.cos(la2) * s2 * s2;
  return 2 * R * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function centroidOf(photos) {
  let sx = 0,
    sy = 0,
    n = 0;
  for (const p of photos) {
    if (isFiniteCoord(p.lat) && isFiniteCoord(p.lon)) {
      sx += p.lat;
      sy += p.lon;
      n++;
    }
  }
  return n ? { lat: sx / n, lon: sy / n } : null;
}

/**
 * Group photos into stacks by distance threshold (meters).
 *
 * - Sorts photos by taken_at time.
 * - Uses stack centroid instead of only the last photo.
 * - Attaches to the nearest existing stack if within radius.
 * - Handles missing GPS gracefully.
 *
 * @param {Array<{id?:string,url?:string,taken_at?:string,lat?:number,lon?:number}>} photos
 * @param {number} radiusMeters e.g. 500
 * @returns {Array<{id:string,title?:string,location:{lat:number|null,lng:number|null,label:string},photos:any[],takenAt?:string}>}
 */
export function groupIntoStacks(photos, radiusMeters = 500) {
  const sorted = [...(photos || [])].sort((a, b) => {
    const ta = new Date(a.taken_at || a.takenAt || a.ts || 0).getTime();
    const tb = new Date(b.taken_at || b.takenAt || b.ts || 0).getTime();
    if (ta !== tb) return ta - tb;
    const ka = a.id || a.url || "";
    const kb = b.id || b.url || "";
    return String(ka).localeCompare(String(kb));
  });

  /** @type {Array<{id:string,title?:string,location:{lat:number|null,lng:number|null,label:string},photos:any[],takenAt?:string, center?:{lat:number,lon:number}|null}>} */
  const stacks = [];
  let seq = 0;

  const newStack = (first) => {
    const hasGPS = isFiniteCoord(first.lat) && isFiniteCoord(first.lon);
    const loc = hasGPS
      ? {
          lat: first.lat,
          lng: first.lon,
          label: `${first.lat.toFixed(4)}, ${first.lon.toFixed(4)}`,
        }
      : { lat: null, lng: null, label: "Location unknown" };

    // Generate persistent ID based on first photo's unique properties
    const photoId = first.id || first.url || '';
    const timestamp = first.taken_at || first.takenAt || first.ts || 0;
    const location = hasGPS ? `${first.lat.toFixed(6)}_${first.lon.toFixed(6)}` : 'no_gps';
    const id = `stack_${simpleHash(photoId + timestamp + location)}`;
    
    const s = {
      id,
      title: first.caption || first.dayTitle,
      location: loc,
      photos: [],
      takenAt: first.taken_at || first.takenAt || first.ts || null,
      center: null,
    };
    stacks.push(s);
    return s;
  };

  const pushAndRecenter = (stack, photo) => {
    stack.photos.push(photo);
    const c = centroidOf(stack.photos);
    stack.center = c;
    if (!isFiniteCoord(stack.location.lat) && c) {
      stack.location = {
        lat: c.lat,
        lng: c.lon,
        label: `${c.lat.toFixed(4)}, ${c.lon.toFixed(4)}`,
      };
    }
  };

  if (!sorted.length) return stacks;

  let cur = newStack(sorted[0]);
  pushAndRecenter(cur, sorted[0]);

  for (let i = 1; i < sorted.length; i++) {
    const p = sorted[i];
    const hasGPS = isFiniteCoord(p.lat) && isFiniteCoord(p.lon);

    if (!hasGPS) {
      if (cur.center) pushAndRecenter(cur, p);
      else {
        cur = newStack(p);
        pushAndRecenter(cur, p);
      }
      continue;
    }

    let placed = false;
    if (cur.center) {
      const d = haversineMetersPt({ lat: p.lat, lon: p.lon }, cur.center);
      if (d <= radiusMeters) {
        pushAndRecenter(cur, p);
        placed = true;
      }
    }

    if (!placed) {
      let best = null,
        bestD = Infinity;
      for (const s of stacks) {
        if (!s.center) continue;
        const d = haversineMetersPt({ lat: p.lat, lon: p.lon }, s.center);
        if (d < bestD) {
          bestD = d;
          best = s;
        }
      }
      if (best && bestD <= radiusMeters) {
        pushAndRecenter(best, p);
        cur = best;
        placed = true;
      }
    }

    if (!placed) {
      cur = newStack(p);
      pushAndRecenter(cur, p);
    }
  }

  return stacks.map((s) => ({
    id: s.id,
    title: s.title,
    location: s.location,
    photos: s.photos,
    takenAt: s.takenAt,
  }));
}


// Simple hash function for generating consistent IDs
function simpleHash(str) {
  let hash = 0;
  if (str.length === 0) return hash.toString(36);
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(36);
}

// --- misc ---
export const debounce = (fn, ms=120) => { let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a), ms); }; };
export const fmtTime = (iso) => new Date(iso).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit', hour12:false});

// --- text formatting ---
export function escapeHtml(text) {
  if (!text) return '';
  return text.replace(/[&<>"']/g, (match) => {
    const entities = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    };
    return entities[match];
  });
}

export function formatTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
}

export function formatDateTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString();
}

export function formatDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString();
}
