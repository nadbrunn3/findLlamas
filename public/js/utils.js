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

// --- stacking ---
export function groupIntoStacks(photos, radiusMeters) {
  const radiusKm = radiusMeters / 1000; // convert meters to kilometers
  const sorted = [...photos].sort((a, b) => {
    const ta = new Date(a.taken_at || a.takenAt || a.ts || 0).getTime();
    const tb = new Date(b.taken_at || b.takenAt || b.ts || 0).getTime();
    return ta - tb;
  });

  const stacks = [];
  let idx = 0;
  let current = null;

  for (const photo of sorted) {
    const last = current?.photos[current.photos.length - 1];
    const hasGPS = typeof photo.lat === 'number' && typeof photo.lon === 'number';
    const lastHasGPS = last && typeof last.lat === 'number' && typeof last.lon === 'number';
    const dist = (hasGPS && lastHasGPS)
      ? haversineKm(photo.lat, photo.lon, last.lat, last.lon)
      : Infinity;

    if (!current || dist > radiusKm) {
      const location = hasGPS
        ? { lat: photo.lat, lng: photo.lon, label: `${photo.lat.toFixed(4)}, ${photo.lon.toFixed(4)}` }
        : { lat: null, lng: null, label: 'Location unknown' };

      current = {
        id: `stack-${idx++}`,
        title: photo.caption || photo.dayTitle,
        location,
        photos: [],
        takenAt: photo.taken_at
      };
      stacks.push(current);
    }

    current.photos.push(photo);
  }

  return stacks;
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
