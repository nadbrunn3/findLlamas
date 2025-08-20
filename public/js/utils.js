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
    return apiBase || "";
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
  const stacks = [];
  const used = new Set();
  const radiusKm = radiusMeters / 1000; // convert meters to kilometers
  let idx = 0;

  for (let i = 0; i < photos.length; i++) {
    if (used.has(i)) continue;
    const a = photos[i];
    const group = [a];
    used.add(i);

    for (let j = i + 1; j < photos.length; j++) {
      if (used.has(j)) continue;
      const b = photos[j];
      if (haversineKm(a.lat, a.lon, b.lat, b.lon) <= radiusKm) {
        group.push(b);
        used.add(j);
      }
    }

    stacks.push({
      id: `stack-${idx++}`,
      title: a.caption || a.dayTitle,
      location: { lat: a.lat, lng: a.lon, label: `${a.lat.toFixed(4)}, ${a.lon.toFixed(4)}` },
      photos: group,
      takenAt: a.taken_at
    });
  }

  return stacks;
}

// --- misc ---
export const debounce = (fn, ms=120) => { let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a), ms); }; };
export const fmtTime = (iso) => new Date(iso).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit', hour12:false});
