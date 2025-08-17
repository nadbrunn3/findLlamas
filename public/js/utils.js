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

// --- misc ---
export const debounce = (fn, ms=120) => { let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a), ms); }; };
export const fmtTime = (iso) => new Date(iso).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit', hour12:false});