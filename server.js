// server.js (Fastify v4, no Git, file-based storage)

import fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import cors from '@fastify/cors';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import crypto from 'crypto';

dotenv.config();

// ---- Config / Paths ---------------------------------------------------------
const PORT = Number(process.env.PORT) || 4000;
const REPO_DIR = process.env.REPO_DIR || process.cwd();

// data lives under public/data
const DATA_DIR = path.join(REPO_DIR, 'public', 'data');
const DAYS_DIR = path.join(DATA_DIR, 'days');
const INTERACTIONS_DIR = path.join(DATA_DIR, 'interactions');

// Immich
const IMMICH_URL = (process.env.IMMICH_URL || '').replace(/\/$/, '');
const IMMICH_API_KEYS = (process.env.IMMICH_API_KEYS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
// Optional album ID to scope imports; matches README's IMMICH_ALBUM_ID
// fallback to legacy DEFAULT_ALBUM_ID for backwards compat
const IMMICH_ALBUM_ID = process.env.IMMICH_ALBUM_ID || process.env.DEFAULT_ALBUM_ID || '';

// optional admin token for protected endpoints (publish, edit/delete comments)
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const AUTOLOAD_INTERVAL = 60 * 60 * 1000; // 1 hour

// helpers
const app = fastify({ logger: true });
app.register(cors, { origin: true });

// serve /public so /day.html, /js/day.js, /css etc. work
app.register(fastifyStatic, {
  root: path.join(process.cwd(), 'public'),
  prefix: '/', // so /day.html, /admin/index.html, /js/*
});

// optional: root to index.html
app.get('/', (req, reply) => reply.sendFile('index.html'));

async function ensureDir(d) { await fs.mkdir(d, { recursive: true }); }
async function readJson(file, def=null) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch { return def; }
}
async function writeJson(file, obj) {
  await ensureDir(path.dirname(file));
  await fs.writeFile(file, JSON.stringify(obj, null, 2));
}

// Simple auth guard (for admin-only ops)
function requireAdmin(req, reply) {
  if (!ADMIN_TOKEN) return true; // disabled
  const h = req.headers['x-admin-token'] || req.headers['authorization'] || '';
  const ok =
    (typeof h === 'string' && h.replace(/^Bearer\s+/i, '') === ADMIN_TOKEN) ||
    false;
  if (!ok) {
    reply.code(401).send({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

// ---- Immich helpers ---------------------------------------------------------
function pickImmichKey() {
  return IMMICH_API_KEYS[0] || process.env.IMMICH_API_KEY || '';
}

async function immichFetchJSON(route, init = {}) {
  if (!IMMICH_URL) throw new Error('IMMICH_URL not set');
  const key = pickImmichKey();
  const url = `${IMMICH_URL}${route}`;
  const headers = {
    ...(init.headers || {}),
    ...(key ? { 'x-api-key': key } : {}),
    'content-type': 'application/json'
  };
  const res = await fetch(url, { ...init, headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Immich ${res.status} ${res.statusText}: ${text}`);
  }
  return res.json();
}

// Try album-specific search first. When an album ID is provided we do not
// fall back to the random asset approach because it could leak assets from
// other albums.
async function getAssetsForDay({ date, albumId }) {
  const start = new Date(date + 'T00:00:00.000Z');
  const end = new Date(start.getTime() + 24 * 3600 * 1000);

  const effectiveAlbumId = albumId || IMMICH_ALBUM_ID;

  if (effectiveAlbumId) {
    try {
      app.log.info(`Fetching all assets from album ${effectiveAlbumId}, then filtering by date ${date}`);
      
      // First, get all assets from the specific album
      let albumAssets = [];
      
      // Try to get album with embedded assets first
      try {
        const album = await immichFetchJSON(`/api/albums/${effectiveAlbumId}`);
        if (Array.isArray(album?.assets)) {
          albumAssets = album.assets;
          app.log.info(`Got ${albumAssets.length} assets from album.assets`);
        }
      } catch (e) {
        app.log.warn(`Failed to get album with assets: ${e.message}`);
      }
      
      // If no assets found, try the assets endpoint
      if (albumAssets.length === 0) {
        try {
          const assetsRes = await immichFetchJSON(`/api/albums/${effectiveAlbumId}/assets`);
          albumAssets = Array.isArray(assetsRes) ? assetsRes : assetsRes?.items || assetsRes?.assets || [];
          app.log.info(`Got ${albumAssets.length} assets from /assets endpoint`);
        } catch (e) {
          app.log.warn(`Failed to get album assets: ${e.message}`);
        }
      }
      
      if (albumAssets.length === 0) {
        app.log.info(`No assets found in album ${effectiveAlbumId}`);
        return [];
      }
      
      // Filter assets by the specific date range
      const dayAssets = albumAssets.filter(a => {
        const asset = a?.asset || a; // Handle wrapped assets
        const t = asset?.exifInfo?.dateTimeOriginal || asset?.localDateTime || asset?.fileCreatedAt || asset?.createdAt;
        if (!t) return false;
        
        const ts = new Date(t).getTime();
        const inRange = !Number.isNaN(ts) && ts >= +start && ts < +end;
        
        if (inRange) {
          app.log.info(`Asset ${asset?.id} matches date ${date}: ${t}`);
        }
        
        return inRange;
      });

      if (dayAssets.length > 0) {
        const photos = dayAssets.map(a => mapAssetToPhoto(a?.asset || a));
        app.log.info(`Album ${effectiveAlbumId}: found ${photos.length} assets for ${date}`);
        return photos;
      }

      app.log.info(`No assets found for album ${effectiveAlbumId} on ${date}`);
      return [];
    } catch (e) {
      app.log.warn(`Album fetch failed for ${effectiveAlbumId}: ${e.message}`);
      return [];
    }
  }

  // 1) Try getting random assets and filter by date (works for your Immich version)
  try {
    // First, let's get available buckets to see if this date has photos
    const buckets = await immichFetchJSON('/api/timeline/buckets?size=DAY');
    const targetBucket = date; // YYYY-MM-DD format
    const hasBucket = Array.isArray(buckets) && buckets.some(b =>
      b.timeBucket && b.timeBucket.startsWith(targetBucket)
    );

    if (!hasBucket) {
      app.log.info(`No photos found for date ${date} in timeline buckets`);
      return [];
    }

    // Get a larger sample of random assets and filter
    // This is not ideal but works for your Immich version
    const BATCH_SIZE = 100;
    const MAX_ATTEMPTS = 5;
    const found = [];

    for (let attempt = 0; attempt < MAX_ATTEMPTS && found.length < 50; attempt++) {
      try {
        const randomAssets = await immichFetchJSON('/api/assets/random?count=' + BATCH_SIZE);
        const assetsArray = Array.isArray(randomAssets) ? randomAssets : [];

        const dayAssets = assetsArray.filter(a => {
          const t = a?.exifInfo?.dateTimeOriginal || a?.localDateTime || a?.fileCreatedAt || a?.createdAt;
          if (!t) return false;

          const ts = new Date(t).getTime();
          const inRange = !Number.isNaN(ts) && ts >= +start && ts < +end;

          return inRange;
        });

        // Add unique assets (avoid duplicates)
        dayAssets.forEach(asset => {
          if (!found.some(f => f.id === asset.id)) {
            found.push(asset);
          }
        });

        app.log.info(`Attempt ${attempt + 1}: Found ${dayAssets.length} assets for ${date}, total: ${found.length}`);
      } catch (e) {
        app.log.warn(`Random assets attempt ${attempt + 1} failed:`, e.message);
      }
    }

    if (found.length > 0) {
      app.log.info(`Successfully found ${found.length} assets for ${date}`);
      return found.map(mapAssetToPhoto);
    }
  } catch (e) {
    app.log.warn({ msg: 'Timeline buckets check failed', err: String(e) });
  }

  // 2) Fallback: Try timeline bucket API (may work better in future)
  try {
    const bucketData = await immichFetchJSON(`/api/timeline/bucket?size=DAY&timeBucket=${date}`);
    if (bucketData && bucketData.id && Array.isArray(bucketData.id) && bucketData.id.length > 0) {
      // Get individual assets by ID
      const assets = [];
      for (const assetId of bucketData.id.slice(0, 100)) { // Limit to first 100
        try {
          const asset = await immichFetchJSON(`/api/assets/${assetId}`);
          if (asset) assets.push(asset);
        } catch (e) {
          app.log.warn(`Failed to fetch asset ${assetId}:`, e.message);
        }
      }
      if (assets.length > 0) {
        app.log.info(`Timeline bucket approach found ${assets.length} assets for ${date}`);
        return assets.map(mapAssetToPhoto);
      }
    }
  } catch (e) {
    app.log.warn({ msg: 'Timeline bucket approach failed', err: String(e) });
  }

  app.log.warn(`No assets found for date ${date}`);
  return [];
}

function mapAssetToPhoto(a) {
  const id = a.id || a.assetId || a._id;
  const takenAt = a?.exifInfo?.dateTimeOriginal || a?.localDateTime || a?.fileCreatedAt || a?.createdAt;
  const lat = a?.exifInfo?.latitude ?? a?.exif?.latitude ?? null;
  const lon = a?.exifInfo?.longitude ?? a?.exif?.longitude ?? null;
  return {
    id,
    url: `/api/immich/assets/${id}/original`,
    thumb: `/api/immich/assets/${id}/thumb`,
    taken_at: takenAt,
    lat, lon,
    caption: a?.exifInfo?.description || a?.originalFileName || ''
  };
}

async function autoLoadAlbum() {
  if (!IMMICH_ALBUM_ID) {
    app.log.warn('IMMICH_ALBUM_ID not set; autoLoadAlbum disabled');
    return;
  }
  try {
    app.log.info(`autoLoadAlbum: fetching album ${IMMICH_ALBUM_ID}`);
    let album;
    try {
      album = await immichFetchJSON(`/api/albums/${IMMICH_ALBUM_ID}`);
    } catch (err) {
      app.log.error({ msg: 'autoLoadAlbum fetch album failed', err: String(err) });
      return;
    }

    let assets = [];
    if (Array.isArray(album?.assets)) {
      assets = album.assets;
    } else {
      try {
        const res = await immichFetchJSON(`/api/albums/${IMMICH_ALBUM_ID}/assets`);
        assets = Array.isArray(res) ? res : res?.items || [];
      } catch (err) {
        app.log.error({ msg: 'autoLoadAlbum fetch assets failed', err: String(err) });
        return;
      }
    }

    if (!assets.length) {
      app.log.warn(`autoLoadAlbum: no assets in album ${IMMICH_ALBUM_ID}`);
      return;
    }

    const photos = assets.map(mapAssetToPhoto).filter(p => p.taken_at);
    const groups = {};
    for (const p of photos) {
      const date = p.taken_at.slice(0, 10);
      (groups[date] ||= []).push(p);
    }

    for (const [date, dayPhotos] of Object.entries(groups)) {
      try {
        const file = dayFile(date);
        const existing = (await readJson(file)) || {
          date,
          segment: 'day',
          slug: date,
          title: `Day — ${date}`,
          stats: {},
          polyline: { type: 'LineString', coordinates: [] },
          points: [],
          photos: []
        };
        const seen = new Set(existing.photos.map(p => p.id || p.url));
        for (const p of dayPhotos) {
          const key = p.id || p.url;
          if (key && !seen.has(key)) {
            existing.photos.push(p);
            seen.add(key);
          }
        }
        await writeJson(file, existing);
        app.log.info(`autoLoadAlbum: merged ${dayPhotos.length} photos into ${date}`);
      } catch (err) {
        app.log.error({ msg: `autoLoadAlbum: failed to write day ${date}`, err: String(err) });
      }
    }

    app.log.info(`autoLoadAlbum: processed ${photos.length} photos`);
  } catch (err) {
    app.log.error({ msg: 'autoLoadAlbum failed', err: String(err) });
  }
}

// ---- Routes: Health ---------------------------------------------------------
app.get('/api/health', async () => ({ ok: true, dataRoot: DATA_DIR }));

// ---- Routes: Local Testing --------------------------------------------------

// Local testing route: simulate Immich assets
app.get('/api/local/day', async (req, reply) => {
  const { date } = req.query;
  if (!date) return reply.code(400).send({ error: 'date required' });

  const dir = path.join(process.cwd(), 'public', 'test-photos');
  const manifestPath = path.join(process.cwd(), 'public', 'data', 'imported.json');
  const imported = await readJson(manifestPath, []);
  const importedSet = new Set(imported);

  const files = fsSync.readdirSync(dir).filter(f => /\.(jpg|jpeg|png)$/i.test(f));

  const newHashes = [];
  const photos = [];

  for (const f of files) {
    const filePath = path.join(dir, f);
    const hash = crypto
      .createHash('sha1')
      .update(fsSync.readFileSync(filePath))
      .digest('hex');
    if (importedSet.has(hash)) continue;
    importedSet.add(hash);
    newHashes.push(hash);
    photos.push({
      id: hash,
      url: `/test-photos/${f}`,
      thumb: `/test-photos/${f}`,
      taken_at: date + 'T12:00:00.000Z',
      lat: null,
      lon: null,
      caption: f,
    });
  }

  if (newHashes.length) {
    await writeJson(manifestPath, [...imported, ...newHashes]);
  }

  reply.send({ date, count: photos.length, photos });
});

// ---- Routes: Immich ---------------------------------------------------------

// Fetch day's photos from Immich (server-side), optional albumId to scope
app.get('/api/immich/day', async (req, reply) => {
  try {
    const { date, albumId } = req.query;
    if (!date) return reply.code(400).send({ error: 'date required (YYYY-MM-DD)' });

    const photos = await getAssetsForDay({ date, albumId });
    const sorted = photos.sort((a, b) => new Date(a.taken_at) - new Date(b.taken_at));

    reply.send({ date, albumId: albumId || null, count: sorted.length, photos: sorted });
  } catch (err) {
    req.log.error(err);
    reply.code(500).send({ error: `Failed to fetch photos from Immich: ${String(err.message || err)}` });
  }
});

// Proxy original (keeps API key server-side; avoids CORS)
app.get('/api/immich/assets/:id/original', async (req, reply) => {
  try {
    const key = pickImmichKey();
    const url = `${IMMICH_URL}/api/assets/${req.params.id}/original`;
    const res = await fetch(url, { headers: key ? { 'x-api-key': key } : {} });
    if (!res.ok) return reply.code(res.status).send(await res.text());

    // Pass through headers we care about
    reply.header('content-type', res.headers.get('content-type') || 'application/octet-stream');
    reply.header('cache-control', res.headers.get('cache-control') || 'public, max-age=604800');
    return reply.send(res.body);
  } catch (e) {
    reply.code(500).send('immich proxy failed');
  }
});

// Proxy thumbnail (Immich supports /thumbnail and size param on newer builds)
app.get('/api/immich/assets/:id/thumb', async (req, reply) => {
  try {
    const key = pickImmichKey();
    // try size=thumbnail; some builds accept ?size=tiny/thumbnail/preview
    const url = `${IMMICH_URL}/api/assets/${req.params.id}/thumbnail?size=thumbnail`;
    const res = await fetch(url, { headers: key ? { 'x-api-key': key } : {} });
    if (!res.ok) return reply.code(res.status).send(await res.text());
    reply.header('content-type', res.headers.get('content-type') || 'image/jpeg');
    reply.header('cache-control', res.headers.get('cache-control') || 'public, max-age=604800');
    return reply.send(res.body);
  } catch (e) {
    reply.code(500).send('immich thumb proxy failed');
  }
});

// ---- Routes: Day JSON --------------------------------------------------------

function dayFile(slug) {
  return path.join(DAYS_DIR, `${slug}.json`);
}

// read a day
app.get('/api/day/:slug', async (req, reply) => {
  try {
    const file = dayFile(req.params.slug);
    const json = await readJson(file);
    if (!json) return reply.code(404).send({ error: 'Not found' });
    reply.type('application/json').send(json);
  } catch (e) {
    reply.code(500).send({ error: 'read failed' });
  }
});

// full overwrite (editor)
app.put('/api/day/:slug', async (req, reply) => {
  try {
    if (!requireAdmin(req, reply)) return;
    const body = req.body;
    if (!body || typeof body !== 'object') return reply.code(400).send({ error: 'Invalid JSON' });
    await writeJson(dayFile(req.params.slug), body);
    reply.send({ ok: true });
  } catch (e) {
    reply.code(500).send({ error: 'save failed' });
  }
});

// update a single photo's caption
app.patch('/api/day/:slug/photo/:id', async (req, reply) => {
  try {
    if (!requireAdmin(req, reply)) return;
    const { caption, description } = req.body || {};
    const file = dayFile(req.params.slug);
    const day = await readJson(file);
    if (!day || !Array.isArray(day.photos)) {
      return reply.code(404).send({ error: 'day not found' });
    }
    const pid = decodeURIComponent(req.params.id);
    const p = day.photos.find(ph => (ph.id || ph.url) === pid);
    if (!p) return reply.code(404).send({ error: 'photo not found' });
    p.caption = String(caption ?? description ?? '').trim();
    await writeJson(file, day);
    reply.send({ ok: true });
  } catch (e) {
    reply.code(500).send({ error: 'update failed' });
  }
});

// update stack metadata: title and/or caption (with migration)
app.patch('/api/day/:slug/stack/:stackId', async (req, reply) => {
  try {
    if (!requireAdmin(req, reply)) return;
    const { caption, title } = req.body || {};
    const file = dayFile(req.params.slug);
    const day = await readJson(file);
    if (!day) return reply.code(404).send({ error: 'day not found' });

    const key = String(req.params.stackId);

    // ---- migrate old format if present ----
    if (day.stackCaptions && !day.stackMeta) {
      day.stackMeta = {};
      for (const [k, v] of Object.entries(day.stackCaptions)) {
        day.stackMeta[k] = { title: '', caption: String(v || '') };
      }
      delete day.stackCaptions;
    }

    day.stackMeta = day.stackMeta || {};
    const meta = day.stackMeta[key] || { title: '', caption: '' };
    if (typeof title === 'string') meta.title = title.trim();
    if (typeof caption === 'string') meta.caption = caption.trim();

    // remove empty meta, otherwise persist
    if (!meta.title && !meta.caption) delete day.stackMeta[key];
    else day.stackMeta[key] = meta;

    await writeJson(file, day);
    reply.send({ ok: true });
  } catch (e) {
    reply.code(500).send({ error: 'update failed' });
  }
});

// append-only publish (safer for two people)
app.post('/api/publish', async (req, reply) => {
  try {
    if (!requireAdmin(req, reply)) return;
    const { date, title, photos = [] } = req.body || {};
    if (!date || !Array.isArray(photos)) {
      return reply.code(400).send({ error: 'date and photos[] required' });
    }
    const file = dayFile(date);
    const existing = (await readJson(file)) || {
      date,
      segment: 'day',
      slug: date,
      title: title || `Day — ${date}`,
      stats: {},
      polyline: { type: 'LineString', coordinates: [] },
      points: [],
      photos: []
    };

    // de-dup by id (prefer id, fall back to url)
    const seen = new Set(existing.photos.map(p => p.id || p.url));
    for (const p of photos) {
      const key = p.id || p.url;
      if (!key || seen.has(key)) continue;
      existing.photos.push(p);
      seen.add(key);
    }

    // optional title override
    if (title && !existing.title) existing.title = title;

    await writeJson(file, existing);
    reply.send({ ok: true, added: photos.length, total: existing.photos.length });
  } catch (e) {
    req.log.error(e);
    reply.code(500).send({ error: 'publish failed' });
  }
});

// ---- Routes: Interactions (likes/comments) ----------------------------------

// helpers
function interactionsPathForPhoto(photoId) {
  return path.join(INTERACTIONS_DIR, `${photoId}.json`);
}
function interactionsPathForStack(stackId) {
  return path.join(INTERACTIONS_DIR, `stack_${stackId}.json`);
}

// Photo interactions
app.get('/api/photo/:photoId/interactions', async (req, reply) => {
  const def = { reactions: {}, comments: [] };
  const data = await readJson(interactionsPathForPhoto(req.params.photoId), def);
  reply.send(data || def);
});

app.post('/api/photo/:photoId/react', async (req, reply) => {
  try {
    const { emoji, action } = req.body || {};
    if (!emoji) return reply.code(400).send({ error: 'emoji required' });
    const file = interactionsPathForPhoto(req.params.photoId);
    const data = (await readJson(file)) || { reactions: {}, comments: [] };

    if (action === 'remove') {
      if (data.reactions[emoji]) data.reactions[emoji] = Math.max(0, data.reactions[emoji] - 1);
      if (data.reactions[emoji] === 0) delete data.reactions[emoji];
      } else {
      data.reactions[emoji] = (data.reactions[emoji] || 0) + 1;
    }

    await writeJson(file, data);
    reply.send({ ok: true, count: data.reactions[emoji] || 0, removed: action === 'remove' });
  } catch { reply.code(500).send({ error: 'react failed' }); }
});

app.post('/api/photo/:photoId/comment', async (req, reply) => {
  try {
    const { text, author } = req.body || {};
    if (!text) return reply.code(400).send({ error: 'text required' });
    const file = interactionsPathForPhoto(req.params.photoId);
    const data = (await readJson(file)) || { reactions: {}, comments: [] };
    const comment = {
      id: Date.now().toString(),
      text: String(text).trim(),
      author: author || 'Anonymous',
      timestamp: new Date().toISOString()
    };
    data.comments.push(comment);
    await writeJson(file, data);
    reply.send({ ok: true, comment });
  } catch { reply.code(500).send({ error: 'comment failed' }); }
});

app.put('/api/photo/:photoId/comment/:commentId', async (req, reply) => {
  try {
    if (!requireAdmin(req, reply)) return;
    const { text } = req.body || {};
    if (!text) return reply.code(400).send({ error: 'text required' });
    const file = interactionsPathForPhoto(req.params.photoId);
    const data = (await readJson(file)) || { reactions: {}, comments: [] };
    const c = data.comments.find(x => x.id === req.params.commentId);
    if (!c) return reply.code(404).send({ error: 'comment not found' });
    c.text = String(text).trim();
    c.edited = new Date().toISOString();
    await writeJson(file, data);
    reply.send({ ok: true, comment: c });
  } catch { reply.code(500).send({ error: 'edit failed' }); }
});

app.delete('/api/photo/:photoId/comment/:commentId', async (req, reply) => {
  try {
    if (!requireAdmin(req, reply)) return;
    const file = interactionsPathForPhoto(req.params.photoId);
    const data = (await readJson(file)) || { reactions: {}, comments: [] };
    const idx = data.comments.findIndex(x => x.id === req.params.commentId);
    if (idx === -1) return reply.code(404).send({ error: 'comment not found' });
    data.comments.splice(idx, 1);
    await writeJson(file, data);
    reply.send({ ok: true });
  } catch { reply.code(500).send({ error: 'delete failed' }); }
});

// Stack interactions (same shape)
app.get('/api/stack/:stackId/interactions', async (req, reply) => {
  const def = { reactions: {}, comments: [] };
  const data = await readJson(interactionsPathForStack(req.params.stackId), def);
  reply.send(data || def);
});

app.post('/api/stack/:stackId/react', async (req, reply) => {
  try {
    const { emoji, action } = req.body || {};
    if (!emoji) return reply.code(400).send({ error: 'emoji required' });
    const file = interactionsPathForStack(req.params.stackId);
    const data = (await readJson(file)) || { reactions: {}, comments: [] };

    if (action === 'remove') {
      if (data.reactions[emoji]) data.reactions[emoji] = Math.max(0, data.reactions[emoji] - 1);
      if (data.reactions[emoji] === 0) delete data.reactions[emoji];
      } else {
      data.reactions[emoji] = (data.reactions[emoji] || 0) + 1;
    }

    await writeJson(file, data);
    reply.send({ ok: true, count: data.reactions[emoji] || 0, removed: action === 'remove' });
  } catch { reply.code(500).send({ error: 'react failed' }); }
});

app.post('/api/stack/:stackId/comment', async (req, reply) => {
  try {
    const { text, author } = req.body || {};
    if (!text) return reply.code(400).send({ error: 'text required' });
    const file = interactionsPathForStack(req.params.stackId);
    const data = (await readJson(file)) || { reactions: {}, comments: [] };
    const comment = {
      id: Date.now().toString(),
      text: String(text).trim(),
      author: author || 'Anonymous',
      timestamp: new Date().toISOString()
    };
    data.comments.push(comment);
    await writeJson(file, data);
    reply.send({ ok: true, comment });
  } catch { reply.code(500).send({ error: 'comment failed' }); }
});

app.put('/api/stack/:stackId/comment/:commentId', async (req, reply) => {
  try {
    if (!requireAdmin(req, reply)) return;
    const { text } = req.body || {};
    if (!text) return reply.code(400).send({ error: 'text required' });
    const file = interactionsPathForStack(req.params.stackId);
    const data = (await readJson(file)) || { reactions: {}, comments: [] };
    const c = data.comments.find(x => x.id === req.params.commentId);
    if (!c) return reply.code(404).send({ error: 'comment not found' });
    c.text = String(text).trim();
    c.edited = new Date().toISOString();
    await writeJson(file, data);
    reply.send({ ok: true, comment: c });
  } catch { reply.code(500).send({ error: 'edit failed' }); }
});

app.delete('/api/stack/:stackId/comment/:commentId', async (req, reply) => {
  try {
    if (!requireAdmin(req, reply)) return;
    const file = interactionsPathForStack(req.params.stackId);
    const data = (await readJson(file)) || { reactions: {}, comments: [] };
    const idx = data.comments.findIndex(x => x.id === req.params.commentId);
    if (idx === -1) return reply.code(404).send({ error: 'comment not found' });
    data.comments.splice(idx, 1);
    await writeJson(file, data);
    reply.send({ ok: true });
  } catch { reply.code(500).send({ error: 'delete failed' }); }
});

if (IMMICH_ALBUM_ID) {
  autoLoadAlbum().catch(err =>
    app.log.error({ msg: 'autoLoadAlbum initial run failed', err: String(err) })
  );
  setInterval(() => {
    autoLoadAlbum().catch(err =>
      app.log.error({ msg: 'autoLoadAlbum interval failed', err: String(err) })
    );
  }, AUTOLOAD_INTERVAL);
}

// ---- Boot -------------------------------------------------------------------
app.listen({ port: PORT, host: '0.0.0.0' }, (err, address) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
  app.log.info(`Backend running at ${address}`);
  });