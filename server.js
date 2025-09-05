// server.js (Fastify v4, no Git, file-based storage)

import fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import cors from '@fastify/cors';
import fastifyCookie from '@fastify/cookie';
import { anonPlugin } from './anon.js';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import crypto from 'crypto';
import exifr from 'exifr';

dotenv.config();

let sharp;

// ---- Config / Paths ---------------------------------------------------------
const PORT = Number(process.env.PORT) || 4000;
const REPO_DIR = path.resolve(process.env.REPO_DIR || process.cwd());

// data lives under public/data
const DATA_DIR = path.join(REPO_DIR, 'public', 'data');
const DAYS_DIR = path.join(DATA_DIR, 'days');
const INTERACTIONS_DIR = path.join(DATA_DIR, 'interactions');
const DAY_INDEX_FILE = path.join(DAYS_DIR, 'index.json');

// Immich can be configured with multiple base URLs and API keys
// URLs and keys may be provided as comma-separated lists. If only one URL
// is given but multiple API keys, the same URL will be used for each key.
// Inline comments after a `#` are ignored so `.env` entries can be annotated.
function parseEnvList(val = '') {
  return val
    .split(',')
    .map(s => s.split('#')[0].trim())
    .filter(Boolean);
}

const rawUrls = parseEnvList(process.env.IMMICH_URLS || process.env.IMMICH_URL)
  .map(s => s.replace(/\/$/, ''));
const rawKeys = parseEnvList(process.env.IMMICH_API_KEYS || process.env.IMMICH_API_KEY);
const IMMICH_URLS = rawUrls;
const IMMICH_API_KEYS = rawKeys;
let IMMICH_SERVERS = [];
if (rawUrls.length && rawKeys.length) {
  if (rawUrls.length === rawKeys.length) {
    IMMICH_SERVERS = rawUrls.map((url, i) => ({ url, key: rawKeys[i] }));
  } else if (rawUrls.length === 1) {
    IMMICH_SERVERS = rawKeys.map(key => ({ url: rawUrls[0], key }));
  } else {
    // Multiple URLs but only one key or mismatched counts
    IMMICH_SERVERS = rawUrls.map(url => ({ url, key: rawKeys[0] || '' }));
  }
} else if (rawUrls.length) {
  const fallbackKey = rawKeys[0] || '';
  IMMICH_SERVERS = rawUrls.map(url => ({ url, key: fallbackKey }));
}

// Optional album ID to scope imports; matches README's IMMICH_ALBUM_ID
// fallback to legacy DEFAULT_ALBUM_ID for backwards compat
const IMMICH_ALBUM_ID = process.env.IMMICH_ALBUM_ID || process.env.DEFAULT_ALBUM_ID || '';

// optional admin token for protected endpoints (publish, edit/delete comments)
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const AUTOLOAD_INTERVAL = 60 * 60 * 1000; // 1 hour

// optional local media folder (thumbnails + originals)
const LOCAL_MEDIA_DIR = process.env.LOCAL_MEDIA_DIR || '';
const CDN_URL = (process.env.CDN_URL || '').replace(/\/$/, '');
const PUBLIC_DIR = path.join(REPO_DIR, 'public');
const assetHashes = {};
function collectAssetHashes(dir) {
  for (const entry of fsSync.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectAssetHashes(full);
    else if (/\.(js|css)$/.test(entry.name)) {
      const rel = path.relative(PUBLIC_DIR, full).replace(/\\/g, '/');
      const buf = fsSync.readFileSync(full);
      assetHashes[rel] = crypto
        .createHash('sha1')
        .update(buf)
        .digest('hex')
        .slice(0, 10);
    }
  }
}
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
collectAssetHashes(PUBLIC_DIR);

// helpers
const app = fastify({ logger: true });
app.register(cors, { origin: true });
app.register(fastifyCookie, { secret: process.env.ANON_COOKIE_SECRET });
app.register(anonPlugin);

// ---- User Identity ----------------------------------------------------------
app.get('/api/user/me', async (req, reply) => {
  console.log('🔍 User ID request:', {
    anonId: req.anonId,
    cookies: req.cookies,
    headers: req.headers.cookie
  });
  reply.send({ anonId: req.anonId });
});

// serve /public so /day.html, /js/day.js, /css etc. work
// Use REPO_DIR to ensure correct static root even when the working directory differs
app.register(fastifyStatic, {
  root: path.join(REPO_DIR, 'public'),
  prefix: '/', // so /day.html, /admin/index.html, /js/*
  cacheControl: true,
  maxAge: '1y',
});

// expose locally synced media if configured
if (LOCAL_MEDIA_DIR) {
  app.register(fastifyStatic, {
    root: LOCAL_MEDIA_DIR,
    prefix: '/media/',
    decorateReply: false,
    cacheControl: true,
    maxAge: '1y',
  });
}

// rewrite static asset paths with hashes/CDN
app.addHook('onSend', (req, reply, payload, done) => {
  const type = reply.getHeader('content-type') || '';
  if (typeof payload === 'string' || Buffer.isBuffer(payload)) {
    let body = payload.toString();
    if (type.includes('text/html')) {
      for (const [rel, hash] of Object.entries(assetHashes)) {
        const regex = new RegExp(`(?:/)?${escapeRegex(rel)}(?!\\?v=)`, 'g');
        const prefix = CDN_URL ? CDN_URL : '';
        body = body.replace(regex, `${prefix}/${rel}?v=${hash}`);
      }
      done(null, body);
      return;
    }
    if (type.includes('javascript')) {
      const utilsHash = assetHashes['js/utils.js'];
      if (utilsHash) {
        const prefix = CDN_URL ? CDN_URL : '';
        body = body
          .replace(/\.\/utils\.js(?!\\?v=)/g, `./utils.js?v=${utilsHash}`)
          .replace(/\/js\/utils\.js(?!\\?v=)/g, `${prefix}/js/utils.js?v=${utilsHash}`);
      }
      done(null, body);
      return;
    }
  }
  done(null, payload);
});

// Serve welcome.html as the main page
app.get('/', async (req, reply) => {
  return reply.sendFile('welcome.html');
});

async function ensureDir(d) { await fs.mkdir(d, { recursive: true }); }
async function readJson(file, def=null) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch { return def; }
}
async function writeJson(file, obj) {
  await ensureDir(path.dirname(file));
  await fs.writeFile(file, JSON.stringify(obj, null, 2));
}

async function upsertDayIndex(day) {
  if (!day || !day.slug) return;
  const list = await readJson(DAY_INDEX_FILE, []);
  const entry = {
    slug: day.slug,
    date: day.date || day.slug,
    title: day.title || `Day — ${day.slug}`,
    cover:
      day.cover ||
      (Array.isArray(day.photos) && day.photos[0] && (day.photos[0].thumb || day.photos[0].url)) ||
      ''
  };
  const idx = list.findIndex(d => d.slug === entry.slug);
  if (idx >= 0) list[idx] = { ...list[idx], ...entry };
  else list.push(entry);
  list.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  await writeJson(DAY_INDEX_FILE, list);
}

// Simple auth guard (for admin-only ops)
function requireAdmin(req) {
  if (!ADMIN_TOKEN) return true; // disabled when no token configured
  const h = req.headers['x-admin-token'] || req.headers['authorization'] || '';
  const token = typeof h === 'string' ? h.replace(/^Bearer\s+/i, '') : '';
  return token === ADMIN_TOKEN;
}

// ---- Immich helpers ---------------------------------------------------------
async function immichFetchJSON(server, route, init = {}) {
  if (!server?.url) throw new Error('Immich URL not set');
  const headers = {
    ...(init.headers || {}),
    ...(server.key ? { 'x-api-key': server.key } : {}),
    'content-type': 'application/json'
  };
  const res = await fetch(`${server.url}${route}`, { ...init, headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Immich ${res.status} ${res.statusText}: ${text}`);
  }
  return res.json();
}

// Try album-specific search first. When an album ID is provided we do not
// fall back to the random asset approach because it could leak assets from
// other albums. This function operates on a single Immich server instance.
async function getAssetsForDayForServer(server, serverIndex, { date, albumId }) {
  const start = new Date(date + 'T00:00:00.000Z');
  const end = new Date(start.getTime() + 24 * 3600 * 1000);

  const effectiveAlbumId = albumId || IMMICH_ALBUM_ID;

  if (effectiveAlbumId) {
    try {
      app.log.info(`🔍 Server ${serverIndex}: Fetching assets for ${date} from ${server.url} with key ${server.key ? server.key.substring(0, 8) + '...' : 'NO_KEY'}`);
      app.log.info(`📁 Server ${serverIndex}: Fetching all assets from album ${effectiveAlbumId}, then filtering by date ${date}`);
      
      // First, get all assets from the specific album with comprehensive approach
      let albumAssets = [];
      
      // Method 1: Try to get album with embedded assets first
      try {
        app.log.info(`🔗 Server ${serverIndex}: Trying GET /api/albums/${effectiveAlbumId}`);
        const album = await immichFetchJSON(server, `/api/albums/${effectiveAlbumId}`);
        app.log.info(`📊 Server ${serverIndex}: Album response:`, typeof album, Object.keys(album || {}));
        
        if (Array.isArray(album?.assets)) {
          albumAssets = album.assets;
          app.log.info(`✅ Server ${serverIndex}: Got ${albumAssets.length} assets from album.assets`);
        }
      } catch (e) {
        app.log.warn(`❌ Server ${serverIndex}: Failed to get album with assets: ${e.message}`);
      }
      
      // Method 2: If no assets found, try the assets endpoint with pagination
      if (albumAssets.length === 0) {
        try {
          app.log.info(`🔗 Server ${serverIndex}: Trying GET /api/albums/${effectiveAlbumId}/assets`);
          const assetsRes = await immichFetchJSON(server, `/api/albums/${effectiveAlbumId}/assets`);
          albumAssets = Array.isArray(assetsRes) ? assetsRes : assetsRes?.items || assetsRes?.assets || [];
          app.log.info(`✅ Server ${serverIndex}: Got ${albumAssets.length} assets from /assets endpoint`);
        } catch (e) {
          app.log.warn(`❌ Server ${serverIndex}: Failed to get album assets: ${e.message}`);
        }
      }
      
      // Method 3: If still no assets, try paginated approach for large albums
      if (albumAssets.length === 0) {
        try {
          app.log.info(`🔗 Server ${serverIndex}: Trying paginated album assets approach`);
          let page = 0;
          const pageSize = 1000;
          let hasMore = true;
          
          while (hasMore && page < 20) { // Safety limit
            const paginatedUrl = `/api/albums/${effectiveAlbumId}/assets?page=${page}&size=${pageSize}`;
            const pageRes = await immichFetchJSON(server, paginatedUrl);
            const pageAssets = Array.isArray(pageRes) ? pageRes : pageRes?.items || pageRes?.assets || [];
            
            if (pageAssets.length === 0) {
              hasMore = false;
            } else {
              albumAssets.push(...pageAssets);
              app.log.info(`📄 Server ${serverIndex}: Page ${page}: Got ${pageAssets.length} assets (total: ${albumAssets.length})`);
              
              if (pageAssets.length < pageSize) {
                hasMore = false; // Last page
              } else {
                page++;
              }
            }
          }
          
          app.log.info(`✅ Server ${serverIndex}: Paginated approach got ${albumAssets.length} total assets`);
        } catch (e) {
          app.log.warn(`❌ Server ${serverIndex}: Paginated album approach failed: ${e.message}`);
        }
      }
      
      if (albumAssets.length === 0) {
        app.log.info(`❌ Server ${serverIndex}: No assets found in album ${effectiveAlbumId} using any method`);
        return [];
      }
      
      app.log.info(`📊 Server ${serverIndex}: Processing ${albumAssets.length} total album assets for date filtering`);
      
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
        const photos = await Promise.all(dayAssets.map(a => mapAssetToPhoto(a?.asset || a, serverIndex)));
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

  // 1) Try timeline bucket API first (fastest approach)
  try {
    app.log.info(`Fetching assets for date ${date} using timeline bucket API`);
    
    // Try daily bucket first
    const dailyBucket = await immichFetchJSON(server, `/api/timeline/bucket?size=DAY&timeBucket=${date}`);
    if (dailyBucket && dailyBucket.id && Array.isArray(dailyBucket.id) && dailyBucket.id.length > 0) {
      app.log.info(`Found ${dailyBucket.id.length} assets in daily bucket for ${date}`);
      
      // Get all assets by ID in parallel
      const assetPromises = dailyBucket.id.map(async (assetId) => {
        try {
          return await immichFetchJSON(server, `/api/assets/${assetId}`);
        } catch (e) {
          app.log.warn(`Failed to fetch asset ${assetId}:`, e.message);
          return null;
        }
      });
      
      const allAssets = (await Promise.all(assetPromises)).filter(Boolean);
      
      // Filter by the specific date with strict date matching
      const dayAssets = allAssets.filter(a => {
        const t = a?.exifInfo?.dateTimeOriginal || a?.localDateTime || a?.fileCreatedAt || a?.createdAt;
        if (!t) return false;
        
        const ts = new Date(t).getTime();
        const inRange = !Number.isNaN(ts) && ts >= +start && ts < +end;
        
        // Debug logging for the target date
        if (t.includes(date)) {
          app.log.info(`Daily bucket - Found asset for ${date}: ${t}, inRange: ${inRange}, type: ${a?.type || 'unknown'}, id: ${a?.id}`);
        }
        
        return inRange;
      });
      
      if (dayAssets.length > 0) {
        app.log.info(`Successfully found ${dayAssets.length} assets for ${date} from daily bucket (filtered from ${allAssets.length} total)`);
        return await Promise.all(dayAssets.map(a => mapAssetToPhoto(a, serverIndex)));
      }
    }
  } catch (e) {
    app.log.warn({ msg: 'Daily timeline bucket approach failed', err: String(e) });
  }

  // 2) Fallback: Try monthly bucket and filter by date
  try {
    const targetMonth = date.substring(0, 7); // YYYY-MM format
    app.log.info(`Trying monthly bucket for ${targetMonth}`);
    
    const monthlyBucket = await immichFetchJSON(server, `/api/timeline/bucket?size=MONTH&timeBucket=${targetMonth}`);
    if (monthlyBucket && monthlyBucket.id && Array.isArray(monthlyBucket.id) && monthlyBucket.id.length > 0) {
      app.log.info(`Found ${monthlyBucket.id.length} assets in monthly bucket for ${targetMonth}`);
      
      // Get all assets by ID in parallel
      const assetPromises = monthlyBucket.id.map(async (assetId) => {
        try {
          return await immichFetchJSON(server, `/api/assets/${assetId}`);
        } catch (e) {
          app.log.warn(`Failed to fetch asset ${assetId}:`, e.message);
          return null;
        }
      });
      
      const allAssets = (await Promise.all(assetPromises)).filter(Boolean);
      
      // Filter by the specific date with strict date matching
      const dayAssets = allAssets.filter(a => {
        const t = a?.exifInfo?.dateTimeOriginal || a?.localDateTime || a?.fileCreatedAt || a?.createdAt;
        if (!t) return false;
        
        const ts = new Date(t).getTime();
        const inRange = !Number.isNaN(ts) && ts >= +start && ts < +end;
        
        // Debug logging for the target date
        if (t.includes(date)) {
          app.log.info(`Monthly bucket - Found asset for ${date}: ${t}, inRange: ${inRange}, type: ${a?.type || 'unknown'}, id: ${a?.id}`);
        }
        
        return inRange;
      });
      
      if (dayAssets.length > 0) {
        app.log.info(`Successfully found ${dayAssets.length} assets for ${date} from monthly bucket`);
        return await Promise.all(dayAssets.map(a => mapAssetToPhoto(a, serverIndex)));
      }
    }
  } catch (e) {
    app.log.warn({ msg: 'Monthly timeline bucket approach failed', err: String(e) });
  }

  // 3) Comprehensive approach: Get ALL assets systematically to ensure we don't miss any
  try {
    app.log.info(`Getting ALL assets for ${date} using systematic pagination approach`);
    
    const allAssets = [];
    const PAGE_SIZE = 1000; // Use reasonable page size
    let page = 1;
    let hasMore = true;
    
    // Get all assets using pagination
    while (hasMore) {
      try {
        // Try different API endpoints for getting all assets
        let assetsResponse;
        let assetsArray = [];
        
        // Method 1: Try search API with date range
        try {
          const searchParams = new URLSearchParams({
            'takenAfter': start.toISOString(),
            'takenBefore': end.toISOString(),
            'size': PAGE_SIZE.toString(),
            'page': (page - 1).toString()
          });
          assetsResponse = await immichFetchJSON(server, `/api/search/metadata?${searchParams}`);
          assetsArray = Array.isArray(assetsResponse?.assets?.items) ? assetsResponse.assets.items : 
                       Array.isArray(assetsResponse?.items) ? assetsResponse.items :
                       Array.isArray(assetsResponse) ? assetsResponse : [];
          app.log.info(`Search API page ${page}: Found ${assetsArray.length} assets`);
        } catch (searchErr) {
          app.log.warn(`Search API failed on page ${page}: ${searchErr.message}`);
          
          // Method 2: Try assets API with pagination
          try {
            const assetsParams = new URLSearchParams({
              'size': PAGE_SIZE.toString(),
              'page': (page - 1).toString()
            });
            assetsResponse = await immichFetchJSON(server, `/api/assets?${assetsParams}`);
            assetsArray = Array.isArray(assetsResponse) ? assetsResponse : [];
            app.log.info(`Assets API page ${page}: Found ${assetsArray.length} assets`);
          } catch (assetsErr) {
            app.log.warn(`Assets API failed on page ${page}: ${assetsErr.message}`);
            
            // Method 3: Try timeline buckets for the specific month
            const monthStart = new Date(start.getFullYear(), start.getMonth(), 1);
            const monthEnd = new Date(start.getFullYear(), start.getMonth() + 1, 0);
            const monthBucket = `${monthStart.getFullYear()}-${String(monthStart.getMonth() + 1).padStart(2, '0')}`;
            
            try {
              const monthlyBucket = await immichFetchJSON(server, `/api/timeline/bucket?size=MONTH&timeBucket=${monthBucket}`);
              if (monthlyBucket && Array.isArray(monthlyBucket.id)) {
                app.log.info(`Monthly bucket for ${monthBucket}: Found ${monthlyBucket.id.length} asset IDs`);
                
                // Get assets in batches to avoid overwhelming the API
                const batchSize = 100;
                for (let i = 0; i < monthlyBucket.id.length; i += batchSize) {
                  const batch = monthlyBucket.id.slice(i, i + batchSize);
                  const batchPromises = batch.map(async (assetId) => {
                    try {
                      return await immichFetchJSON(server, `/api/assets/${assetId}`);
                    } catch (e) {
                      return null;
                    }
                  });
                  const batchAssets = (await Promise.all(batchPromises)).filter(Boolean);
                  assetsArray.push(...batchAssets);
                }
                app.log.info(`Monthly bucket approach: Retrieved ${assetsArray.length} assets for ${monthBucket}`);
              }
            } catch (monthErr) {
              app.log.warn(`Monthly bucket approach failed: ${monthErr.message}`);
              break; // Exit the while loop if all methods fail
            }
          }
        }
        
        if (assetsArray.length === 0) {
          app.log.info(`No more assets found on page ${page}, stopping pagination`);
          hasMore = false;
          break;
        }
        
        // Filter assets by the target date and add to results
        const dayAssets = assetsArray.filter(a => {
          const t = a?.exifInfo?.dateTimeOriginal || a?.localDateTime || a?.fileCreatedAt || a?.createdAt;
          if (!t) return false;
          
          const ts = new Date(t).getTime();
          const inRange = !Number.isNaN(ts) && ts >= +start && ts < +end;
          
          if (inRange) {
            app.log.info(`Page ${page} - Found asset for ${date}: ${t}, type: ${a?.type || 'unknown'}, id: ${a?.id}`);
          }
          
          return inRange;
        });
        
        allAssets.push(...dayAssets);
        app.log.info(`Page ${page}: Found ${dayAssets.length} matching assets for ${date} (from ${assetsArray.length} total)`);
        
        // Check if we should continue pagination
        if (assetsArray.length < PAGE_SIZE) {
          hasMore = false; // Last page
        } else {
          page++;
        }
        
        // Safety limit to prevent infinite loops
        if (page > 50) {
          app.log.warn(`Reached maximum page limit (50), stopping pagination`);
          hasMore = false;
        }
        
      } catch (pageErr) {
        app.log.error(`Error on page ${page}: ${pageErr.message}`);
        hasMore = false;
      }
    }
    
    app.log.info(`Systematic approach: Found ${allAssets.length} total assets for ${date} across ${page} pages`);

    if (allAssets.length > 0) {
      return await Promise.all(allAssets.map(a => mapAssetToPhoto(a, serverIndex)));
    }
    
    app.log.info(`No assets found for ${date} using systematic approach`);
  } catch (e) {
    app.log.warn({ msg: 'Systematic approach failed', err: String(e) });
  }

  app.log.warn(`No assets found for date ${date}`);
  return [];
}

// Combine results from all configured Immich servers
async function getAssetsForDay({ date, albumId }) {
  app.log.info(`🚀 Starting import for ${date} with ${IMMICH_SERVERS.length} servers`);
  IMMICH_SERVERS.forEach((server, i) => {
    app.log.info(`📡 Server ${i}: ${server.url} (key: ${server.key ? server.key.substring(0, 8) + '...' : 'NO_KEY'})`);
  });

  const allPhotos = [];
  const seenAssets = new Set(); // Track unique assets by their original ID
  
  for (let i = 0; i < IMMICH_SERVERS.length; i++) {
    const server = IMMICH_SERVERS[i];
    try {
      app.log.info(`🔄 Processing server ${i}/${IMMICH_SERVERS.length}`);
      const photos = await getAssetsForDayForServer(server, i, { date, albumId });
      app.log.info(`📸 Server ${i}: Found ${photos.length} photos`);
      
      // Deduplicate by original asset ID (remove server prefix)
      const uniquePhotos = photos.filter(photo => {
        const originalId = photo.id.split('_').slice(1).join('_'); // Remove server index prefix
        if (seenAssets.has(originalId)) {
          return false; // Skip duplicate
        }
        seenAssets.add(originalId);
        return true;
      });
      
      if (photos.length !== uniquePhotos.length) {
        app.log.info(`Server ${i}: Added ${uniquePhotos.length} unique photos (${photos.length - uniquePhotos.length} duplicates skipped)`);
      }
      allPhotos.push(...uniquePhotos);
    } catch (e) {
      app.log.error(`❌ Server ${i} failed: ${e.message}`);
    }
  }
  
  app.log.info(`📊 Total unique photos found: ${allPhotos.length}`);
  
  // Sort combined photos by timestamp so they appear as a single source
  allPhotos.sort((a, b) => (a.taken_at || '').localeCompare(b.taken_at || ''));
  return allPhotos;
}

async function ensureLocalThumb(original, thumb) {
  try {
    await fs.access(thumb);
  } catch {
    try {
      if (!sharp) {
        sharp = (await import('sharp')).default;
      }
      await fs.mkdir(path.dirname(thumb), { recursive: true });
      await sharp(original)
        .rotate()
        .resize(400, 400, { fit: 'inside', withoutEnlargement: true })
        .toFile(thumb);
    } catch (err) {
      app.log.error({ msg: 'thumb generation failed', err: String(err) });
    }
  }
}

async function mapAssetToPhoto(a, serverIndex) {
  const asset = a?.asset || a; // handle wrapped items
  const rawId = asset.id || asset.assetId || asset._id;
  const id = `${serverIndex}_${rawId}`;
  const takenAt =
    asset?.exifInfo?.dateTimeOriginal ||
    asset?.localDateTime ||
    asset?.fileCreatedAt ||
    asset?.createdAt;

  // Immich typically has asset.type = 'IMAGE' | 'VIDEO'
  const t = (asset?.type || asset?.assetType || '').toString().toUpperCase();
  const mime = asset?.mimeType || '';
  const isVideo = t === 'VIDEO' || mime.startsWith('video/');

  const lat = asset?.exifInfo?.latitude ?? asset?.exif?.latitude ?? null;
  const lon = asset?.exifInfo?.longitude ?? asset?.exif?.longitude ?? null;

  // Optional duration if Immich provides it (seconds)
  const duration =
    typeof asset?.duration === 'number'
      ? asset.duration
      : (asset?.exifInfo?.duration || null);

  const filename = asset.originalFileName || `${rawId}`;
  const localOriginal = LOCAL_MEDIA_DIR
    ? path.join(LOCAL_MEDIA_DIR, filename)
    : null;
  const localThumb = LOCAL_MEDIA_DIR
    ? path.join(LOCAL_MEDIA_DIR, 'thumbs', filename)
    : null;

  const hasLocal = localOriginal && fsSync.existsSync(localOriginal);
  let hasThumb = localThumb && fsSync.existsSync(localThumb);
  if (hasLocal && !hasThumb && localThumb) {
    await ensureLocalThumb(localOriginal, localThumb);
    hasThumb = fsSync.existsSync(localThumb);
  }


  return {
    id,
    kind: isVideo ? 'video' : 'photo',
    mimeType: mime || (isVideo ? 'video/*' : 'image/*'),
    duration,
    url: hasLocal
      ? `/media/${filename}`
      : `/api/immich/assets/${id}/original`,
    thumb: hasThumb
      ? `/media/thumbs/${filename}`
      : hasLocal
        ? `/media/${filename}`
        : `/api/immich/assets/${id}/thumb`,
    taken_at: takenAt,
    lat,
    lon,
    caption: asset?.exifInfo?.description || asset?.originalFileName || ''
  };
}

// Read photos from LOCAL_MEDIA_DIR for a given date
async function getLocalPhotosForDay({ date }) {
  if (!LOCAL_MEDIA_DIR) return [];
  const start = new Date(date + 'T00:00:00.000Z');
  const end = new Date(start.getTime() + 24 * 3600 * 1000);
  const results = [];

  const allowed = new Set([
    '.jpg', '.jpeg', '.png', '.webp', '.gif',
    '.mp4', '.mov', '.webm'
  ]);
  const video = new Set(['.mp4', '.mov', '.webm']);
  const mime = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.webm': 'video/webm'
  };
  function toDecimal(dms, ref) {
    if (!Array.isArray(dms)) return null;
    let dec = dms[0];
    if (dms[1]) dec += dms[1] / 60;
    if (dms[2]) dec += dms[2] / 3600;
    if (ref && /^[SW]/i.test(ref)) dec = -dec;
    return dec;
  }


  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === 'thumbs') continue;
        await walk(full);
      } else {
        const ext = path.extname(ent.name).toLowerCase();
        if (!allowed.has(ext)) continue;
        const stat = await fs.stat(full);
        let t = stat.mtime;
        let lat = null;
        let lon = null;
        let duration = null;
        try {
          const meta = await exifr.parse(full);
          if (meta?.DateTimeOriginal) {
            t = new Date(meta.DateTimeOriginal);
          } else if (meta?.CreateDate) {
            t = new Date(meta.CreateDate);
          } else if (meta?.MediaCreateDate) {
            t = new Date(meta.MediaCreateDate);
          }
          if (meta?.GPSLatitude && meta?.GPSLongitude) {
            lat = toDecimal(meta.GPSLatitude, meta.GPSLatitudeRef);
            lon = toDecimal(meta.GPSLongitude, meta.GPSLongitudeRef);
          } else if (typeof meta?.latitude === 'number' && typeof meta?.longitude === 'number') {
            lat = meta.latitude;
            lon = meta.longitude;
          }
          if (typeof meta?.duration === 'number') {
            duration = meta.duration;
          } else if (typeof meta?.Duration === 'number') {
            duration = meta.Duration;
          }
        } catch (err) {
          // ignore EXIF parse errors
        }
        if (t >= start && t < end) {
          const isVideo = video.has(ext);
          const rel = path.relative(LOCAL_MEDIA_DIR, full);
          const fileId = rel.replace(/[\\/]/g, '_');
          const localThumb = path.join(LOCAL_MEDIA_DIR, 'thumbs', rel);
          let thumbUrl = `/media/thumbs/${rel}`;
          try {
            await fs.access(localThumb);
          } catch {
            await ensureLocalThumb(full, localThumb);
            try {
              await fs.access(localThumb);
            } catch {
              thumbUrl = `/media/${rel}`;
            }
          }
          results.push({
            id: `local_${fileId}`,
            kind: isVideo ? 'video' : 'photo',
            mimeType: mime[ext] || (isVideo ? 'video/*' : 'image/*'),
            duration,
            url: `/media/${rel}`,
            thumb: thumbUrl,
            taken_at: t.toISOString(),
            lat,
            lon,
            caption: path.basename(rel)
          });
        }
      }
    }
  }

  await walk(LOCAL_MEDIA_DIR);
  results.sort((a, b) => new Date(a.taken_at) - new Date(b.taken_at));
  return results;
}

async function autoLoadAlbum() {
  if (!IMMICH_ALBUM_ID) {
    app.log.warn('IMMICH_ALBUM_ID not set; autoLoadAlbum disabled');
    return;
  }
  for (let i = 0; i < IMMICH_SERVERS.length; i++) {
    const server = IMMICH_SERVERS[i];
    try {
      app.log.info(`autoLoadAlbum: fetching album ${IMMICH_ALBUM_ID} from ${server.url}`);
      let album;
      try {
        album = await immichFetchJSON(server, `/api/albums/${IMMICH_ALBUM_ID}`);
      } catch (err) {
        app.log.error({ msg: 'autoLoadAlbum fetch album failed', err: String(err) });
        continue;
      }

      let assets = [];
      if (Array.isArray(album?.assets)) {
        assets = album.assets;
      } else {
        try {
          const res = await immichFetchJSON(server, `/api/albums/${IMMICH_ALBUM_ID}/assets`);
          assets = Array.isArray(res) ? res : res?.items || [];
        } catch (err) {
          app.log.error({ msg: 'autoLoadAlbum fetch assets failed', err: String(err) });
          continue;
        }
      }

      if (!assets.length) {
        app.log.warn(`autoLoadAlbum: no assets in album ${IMMICH_ALBUM_ID}`);
        continue;
      }

      const photos = (await Promise.all(assets.map(a => mapAssetToPhoto(a, i)))).filter(p => p.taken_at);
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
          await upsertDayIndex(existing);
          app.log.info(`autoLoadAlbum: merged ${dayPhotos.length} photos into ${date}`);
        } catch (err) {
          app.log.error({ msg: `autoLoadAlbum: failed to write day ${date}`, err: String(err) });
        }
      }

      app.log.info(`autoLoadAlbum: processed ${photos.length} photos from ${server.url}`);
    } catch (err) {
      app.log.error({ msg: 'autoLoadAlbum failed', err: String(err) });
    }
  }
}

// ---- Routes: Health ---------------------------------------------------------
app.get('/api/health', async () => ({ ok: true, dataRoot: DATA_DIR }));

// ---- Routes: Local Media ----------------------------------------------------

// Fetch day's photos from a locally synced media directory
app.get('/api/local/day', async (req, reply) => {
  try {
    if (!requireAdmin(req)) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
    if (!LOCAL_MEDIA_DIR) {
      return reply.code(500).send({ error: 'LOCAL_MEDIA_DIR not configured' });
    }

    const { date } = req.query;
    if (!date) return reply.code(400).send({ error: 'date required (YYYY-MM-DD)' });

    const photos = await getLocalPhotosForDay({ date });
    reply.send({ date, count: photos.length, photos });
  } catch (err) {
    req.log.error(err);
    reply.code(500).send({ error: `Failed to fetch photos from local media: ${String(err.message || err)}` });
  }
});

// ---- Routes: Immich ---------------------------------------------------------

// Fetch day's photos from Immich (server-side), optional albumId to scope
app.get('/api/immich/day', async (req, reply) => {
  try {
    if (!requireAdmin(req)) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

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
    const [idx, assetId] = req.params.id.split('_');
    const server = IMMICH_SERVERS[Number(idx)];
    if (!server) return reply.code(404).send('immich server not found');
    const url = `${server.url}/api/assets/${assetId}/original`;
    const res = await fetch(url, { headers: server.key ? { 'x-api-key': server.key } : {} });
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
    const [idx, assetId] = req.params.id.split('_');
    const server = IMMICH_SERVERS[Number(idx)];
    if (!server) return reply.code(404).send('immich server not found');
    // try size=thumbnail; some builds accept ?size=tiny/thumbnail/preview
    const url = `${server.url}/api/assets/${assetId}/thumbnail?size=thumbnail`;
    const res = await fetch(url, { headers: server.key ? { 'x-api-key': server.key } : {} });
    if (!res.ok) return reply.code(res.status).send(await res.text());
    reply.header('content-type', res.headers.get('content-type') || 'image/jpeg');
    reply.header('cache-control', res.headers.get('cache-control') || 'public, max-age=604800');
    return reply.send(res.body);
  } catch (e) {
    reply.code(500).send('immich thumb proxy failed');
  }
});

// ---- Routes: Admin Config ---------------------------------------------------

// Get server configuration for admin panel (without exposing sensitive data)
app.get('/api/admin/config', async (req, reply) => {
  // Return configuration from environment variables
  // Note: We don't expose actual tokens/keys for security
  const config = {
    immichUrl: IMMICH_URLS[0] || '',
    immichUrls: IMMICH_URLS,
    immichAlbumId: IMMICH_ALBUM_ID || '',
    hasImmichKeys: IMMICH_SERVERS.some(s => s.key),
    hasAdminToken: !!ADMIN_TOKEN,
    serverPort: PORT,
    // Add more detailed status information
    immichConfigured: IMMICH_SERVERS.length > 0 && IMMICH_SERVERS.some(s => s.key),
    localMediaConfigured: !!LOCAL_MEDIA_DIR,
    configSource: 'environment', // Always prioritize .env
    missingConfig: []
  };

  // Check what's missing
  if (IMMICH_SERVERS.length === 0) config.missingConfig.push('IMMICH_URLS');
  if (IMMICH_API_KEYS.length === 0) config.missingConfig.push('IMMICH_API_KEYS');

  reply.send(config);
});

// Helper endpoint to get .env template
app.get('/api/admin/env-template', async (req, reply) => {
  const template = `# Immich Configuration
# Single server with two API keys
IMMICH_URLS=https://photos.example.com
IMMICH_API_KEYS=user_one_key,user_two_key
# Or multiple servers
# IMMICH_URLS=https://immich-one.example.com,https://immich-two.example.com
# IMMICH_API_KEYS=key_for_one,key_for_two
IMMICH_ALBUM_ID=your_album_id

# Admin Token (optional)
ADMIN_TOKEN=your_admin_token

# Cookie Secret for anonymous users
ANON_COOKIE_SECRET=your_long_random_string_here

# Server Configuration
PORT=4000
REPO_DIR=.
`;

  reply.type('text/plain').send(template);
});

// ---- Routes: Day JSON --------------------------------------------------------

function dayFile(slug) {
  return path.join(DAYS_DIR, `${slug}.json`);
}

const dayCache = new Map();

async function ensureThumbsForDay(day) {
  if (!LOCAL_MEDIA_DIR || !Array.isArray(day?.photos)) return;
  for (const p of day.photos) {
    if (p.url?.startsWith('/media/') && p.thumb?.startsWith('/media/')) {
      const orig = path.join(LOCAL_MEDIA_DIR, p.url.replace('/media/', ''));
      const th = path.join(LOCAL_MEDIA_DIR, p.thumb.replace('/media/', ''));
      await ensureLocalThumb(orig, th);
    }
  }
}

async function loadDay(slug) {
  if (dayCache.has(slug)) return dayCache.get(slug);
  const file = dayFile(slug);
  const json = await readJson(file);
  if (json) {
    await ensureThumbsForDay(json);
    dayCache.set(slug, json);
  }
  return json;
}

async function preloadDays() {
  const index = await readJson(DAY_INDEX_FILE, []);
  for (const d of index) {
    await loadDay(d.slug);
  }
  app.log.info(`Preloaded ${dayCache.size} days`);
}

// read a day
app.get('/api/day/:slug', async (req, reply) => {
  try {
    const json = await loadDay(req.params.slug);
    if (!json) return reply.code(404).send({ error: 'Not found' });
    reply.type('application/json').send(json);
  } catch (e) {
    reply.code(500).send({ error: 'read failed' });
  }
});

// full overwrite (editor)
app.put('/api/day/:slug', async (req, reply) => {
  try {
    if (!requireAdmin(req)) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }
    const body = req.body;
    if (!body || typeof body !== 'object') return reply.code(400).send({ error: 'Invalid JSON' });
    await writeJson(dayFile(req.params.slug), body);
    await upsertDayIndex({ ...body, slug: req.params.slug });
    await ensureThumbsForDay(body);
    dayCache.set(req.params.slug, body);
    reply.send({ ok: true });
  } catch (e) {
    reply.code(500).send({ error: 'save failed' });
  }
});

// update a single photo's title and/or caption
app.patch('/api/day/:slug/photo/:id', async (req, reply) => {
  try {
    if (!requireAdmin(req)) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }
    const { caption, description, title } = req.body || {};
    const file = dayFile(req.params.slug);
    const day = await readJson(file);
    if (!day || !Array.isArray(day.photos)) {
      return reply.code(404).send({ error: 'day not found' });
    }
    const pid = decodeURIComponent(req.params.id);
    const p = day.photos.find(ph => (ph.id || ph.url) === pid);
    if (!p) return reply.code(404).send({ error: 'photo not found' });
    const cap = caption ?? description;
    if (cap !== undefined) p.caption = String(cap).trim();
    if (title !== undefined) {
      p.title = String(title).trim();
      if (!p.title) delete p.title;
    }
    await writeJson(file, day);
    await ensureThumbsForDay(day);
    dayCache.set(req.params.slug, day);
    reply.send({ ok: true });
  } catch (e) {
    reply.code(500).send({ error: 'update failed' });
  }
});

// update stack metadata: title and/or caption (with migration)
app.patch('/api/day/:slug/stack/:stackId', async (req, reply) => {
  try {
    if (!requireAdmin(req)) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }
    const { caption, description, title } = req.body || {};
    const file = dayFile(req.params.slug);
    let day = await readJson(file);
    
    // Create day file if it doesn't exist
    if (!day) {
      const slug = req.params.slug;
      day = {
        date: slug,
        segment: 'day',
        slug: slug,
        title: `Day — ${slug}`,
        stats: {},
        polyline: { type: 'LineString', coordinates: [] },
        points: [],
        photos: []
      };
      app.log.info(`Creating new day file for ${slug}`);
    }

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
    const cap = caption ?? description;
    if (cap !== undefined) meta.caption = String(cap).trim();

    // remove empty meta, otherwise persist
    if (!meta.title && !meta.caption) delete day.stackMeta[key];
    else day.stackMeta[key] = meta;

    await writeJson(file, day);
    await ensureThumbsForDay(day);
    dayCache.set(req.params.slug, day);
    reply.send({ ok: true });
  } catch (e) {
    reply.code(500).send({ error: 'update failed' });
  }
});

// delete photo from day
app.delete('/api/day/:slug/photo/:photoId', async (req, reply) => {
  try {
    if (!requireAdmin(req)) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }
    
    const file = dayFile(req.params.slug);
    const day = await readJson(file);
    if (!day) return reply.code(404).send({ error: 'day not found' });
    
    if (!Array.isArray(day.photos)) {
      return reply.code(404).send({ error: 'no photos in day' });
    }
    
    const photoIndex = day.photos.findIndex(p => p.id === req.params.photoId);
    if (photoIndex === -1) {
      return reply.code(404).send({ error: 'photo not found' });
    }
    
    // Remove the photo from the array
    day.photos.splice(photoIndex, 1);
    
    await writeJson(file, day);
    await ensureThumbsForDay(day);
    dayCache.set(req.params.slug, day);
    reply.send({ ok: true, message: 'Photo deleted successfully' });
  } catch (e) {
    app.log.error('Delete photo error:', e);
    reply.code(500).send({ error: 'delete failed' });
  }
});

// append-only publish (safer for two people)
app.post('/api/publish', async (req, reply) => {
  try {
    if (!requireAdmin(req)) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }
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
    await upsertDayIndex(existing);
    await ensureThumbsForDay(existing);
    dayCache.set(date, existing);
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

const photoMetaCache = new Map();
const stackMetaCache = new Map();

async function loadPhotoMeta(id) {
  if (photoMetaCache.has(id)) return photoMetaCache.get(id);
  const data = await readJson(interactionsPathForPhoto(id), { reactions: {}, comments: [] });
  photoMetaCache.set(id, data);
  return data;
}

async function loadStackMeta(id) {
  if (stackMetaCache.has(id)) return stackMetaCache.get(id);
  const data = await readJson(interactionsPathForStack(id), { reactions: {}, comments: [] });
  stackMetaCache.set(id, data);
  return data;
}

async function preloadInteractions() {
  try {
    const files = await fs.readdir(INTERACTIONS_DIR);
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const full = path.join(INTERACTIONS_DIR, f);
      const data = await readJson(full, { reactions: {}, comments: [] });
      if (f.startsWith('stack_')) {
        stackMetaCache.set(f.slice(6, -5), data);
      } else {
        photoMetaCache.set(f.slice(0, -5), data);
      }
    }
    app.log.info(`Preloaded ${photoMetaCache.size} photo interactions and ${stackMetaCache.size} stack interactions`);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      app.log.error({ msg: 'interaction preload failed', err: String(err) });
    }
  }
}

// Photo interactions
app.get('/api/photo/:photoId/interactions', async (req, reply) => {
  reply.send(await loadPhotoMeta(req.params.photoId));
});

app.post('/api/photo/:photoId/react', async (req, reply) => {
  try {
    const { emoji, action } = req.body || {};
    if (!emoji) return reply.code(400).send({ error: 'emoji required' });
    const data = await loadPhotoMeta(req.params.photoId);

    if (action === 'remove') {
      if (data.reactions[emoji]) data.reactions[emoji] = Math.max(0, data.reactions[emoji] - 1);
      if (data.reactions[emoji] === 0) delete data.reactions[emoji];
    } else {
      data.reactions[emoji] = (data.reactions[emoji] || 0) + 1;
    }

    await writeJson(interactionsPathForPhoto(req.params.photoId), data);
    photoMetaCache.set(req.params.photoId, data);
    reply.send({ ok: true, count: data.reactions[emoji] || 0, removed: action === 'remove' });
  } catch {
    reply.code(500).send({ error: 'react failed' });
  }
});

app.post('/api/photo/:photoId/comment', async (req, reply) => {
  try {
    const { text, author, parentId } = req.body || {};
    if (!text) return reply.code(400).send({ error: 'text required' });
    const data = await loadPhotoMeta(req.params.photoId);
    const comment = {
      id: Date.now().toString(),
      text: String(text).trim(),
      author: author || 'Anonymous',
      authorId: req.anonId,
      timestamp: new Date().toISOString()
    };

    if (parentId) comment.parentId = parentId;

    data.comments.push(comment);
    await writeJson(interactionsPathForPhoto(req.params.photoId), data);
    photoMetaCache.set(req.params.photoId, data);
    reply.send({ ok: true, comment });
  } catch {
    reply.code(500).send({ error: 'comment failed' });
  }
});

app.put('/api/photo/:photoId/comment/:commentId', async (req, reply) => {
  try {
    const adminOk = requireAdmin(req);
    const { text } = req.body || {};
    if (!text) return reply.code(400).send({ error: 'text required' });

    const data = await loadPhotoMeta(req.params.photoId);
    const c = data.comments.find(x => x.id === req.params.commentId);
    if (!c) return reply.code(404).send({ error: 'comment not found' });

    const isOwner = c.authorId && req.anonId === c.authorId;
    if (!(adminOk || isOwner)) return reply.code(403).send({ error: 'forbidden' });

    c.text = String(text).trim();
    c.edited = new Date().toISOString();
    await writeJson(interactionsPathForPhoto(req.params.photoId), data);
    photoMetaCache.set(req.params.photoId, data);
    reply.send({ ok: true, comment: c });
  } catch {
    reply.code(500).send({ error: 'edit failed' });
  }
});

app.delete('/api/photo/:photoId/comment/:commentId', async (req, reply) => {
  try {
    const adminToken =
      ADMIN_TOKEN &&
      ((req.headers['x-admin-token'] || '').replace(/^Bearer\s+/i, '') === ADMIN_TOKEN);

    const data = await loadPhotoMeta(req.params.photoId);
    const idx = data.comments.findIndex(x => x.id === req.params.commentId);
    if (idx === -1) return reply.code(404).send({ error: 'comment not found' });

    const c = data.comments[idx];
    const isOwner = c.authorId && req.anonId === c.authorId;
    const isClientOwned = c.author === 'You' || c.author === 'Anonymous';

    if (!(adminToken || isOwner || isClientOwned)) return reply.code(403).send({ error: 'forbidden' });

    data.comments.splice(idx, 1);
    await writeJson(interactionsPathForPhoto(req.params.photoId), data);
    photoMetaCache.set(req.params.photoId, data);
    reply.send({ ok: true });
  } catch {
    reply.code(500).send({ error: 'delete failed' });
  }
});

// Stack interactions (same shape)
app.get('/api/stack/:stackId/interactions', async (req, reply) => {
  reply.send(await loadStackMeta(req.params.stackId));
});

app.post('/api/stack/:stackId/react', async (req, reply) => {
  try {
    const { emoji, action } = req.body || {};
    if (!emoji) return reply.code(400).send({ error: 'emoji required' });
    const data = await loadStackMeta(req.params.stackId);

    if (action === 'remove') {
      if (data.reactions[emoji]) data.reactions[emoji] = Math.max(0, data.reactions[emoji] - 1);
      if (data.reactions[emoji] === 0) delete data.reactions[emoji];
    } else {
      data.reactions[emoji] = (data.reactions[emoji] || 0) + 1;
    }

    await writeJson(interactionsPathForStack(req.params.stackId), data);
    stackMetaCache.set(req.params.stackId, data);
    reply.send({ ok: true, count: data.reactions[emoji] || 0, removed: action === 'remove' });
  } catch {
    reply.code(500).send({ error: 'react failed' });
  }
});

app.post('/api/stack/:stackId/comment', async (req, reply) => {
  try {
    const { text, author, parentId } = req.body || {};
    if (!text) return reply.code(400).send({ error: 'text required' });
    const data = await loadStackMeta(req.params.stackId);
    const comment = {
      id: Date.now().toString(),
      text: String(text).trim(),
      author: author || 'Anonymous',
      authorId: req.anonId,
      timestamp: new Date().toISOString()
    };

    if (parentId) comment.parentId = parentId;

    data.comments.push(comment);
    await writeJson(interactionsPathForStack(req.params.stackId), data);
    stackMetaCache.set(req.params.stackId, data);
    reply.send({ ok: true, comment });
  } catch {
    reply.code(500).send({ error: 'comment failed' });
  }
});

app.put('/api/stack/:stackId/comment/:commentId', async (req, reply) => {
  try {
    const adminOk = requireAdmin(req);
    const { text } = req.body || {};
    if (!text) return reply.code(400).send({ error: 'text required' });
    const data = await loadStackMeta(req.params.stackId);
    const c = data.comments.find(x => x.id === req.params.commentId);
    if (!c) return reply.code(404).send({ error: 'comment not found' });

    const isOwner = c.authorId && req.anonId === c.authorId;
    if (!(adminOk || isOwner)) return reply.code(403).send({ error: 'forbidden' });

    c.text = String(text).trim();
    c.edited = new Date().toISOString();
    await writeJson(interactionsPathForStack(req.params.stackId), data);
    stackMetaCache.set(req.params.stackId, data);
    reply.send({ ok: true, comment: c });
  } catch {
    reply.code(500).send({ error: 'edit failed' });
  }
});

app.delete('/api/stack/:stackId/comment/:commentId', async (req, reply) => {
  try {
    const adminToken =
      ADMIN_TOKEN &&
      ((req.headers['x-admin-token'] || '').replace(/^Bearer\s+/i, '') === ADMIN_TOKEN);

    const data = await loadStackMeta(req.params.stackId);
    const idx = data.comments.findIndex(x => x.id === req.params.commentId);
    if (idx === -1) return reply.code(404).send({ error: 'comment not found' });

    const c = data.comments[idx];
    const isOwner = c.authorId && req.anonId === c.authorId;
    const isClientOwned = c.author === 'You' || c.author === 'Anonymous';

    console.log('🗑️ Stack comment delete request:', {
      commentId: req.params.commentId,
      author: c.author,
      authorId: c.authorId,
      reqAnonId: req.anonId,
      isOwner,
      isClientOwned,
      adminToken: !!adminToken,
      allowed: !!(adminToken || isOwner || isClientOwned)
    });

    if (!(adminToken || isOwner || isClientOwned)) return reply.code(403).send({ error: 'forbidden' });

    data.comments.splice(idx, 1);
    await writeJson(interactionsPathForStack(req.params.stackId), data);
    stackMetaCache.set(req.params.stackId, data);
    reply.send({ ok: true });
  } catch (e) {
    console.error('❌ Delete failed:', e);
    reply.code(500).send({ error: 'delete failed' });
  }
});

// Disable auto-loader to prevent conflicts with manual import
// if (IMMICH_ALBUM_ID) {
//   autoLoadAlbum().catch(err =>
//     app.log.error({ msg: 'autoLoadAlbum initial run failed', err: String(err) })
//   );
//   setInterval(() => {
//     autoLoadAlbum().catch(err =>
//       app.log.error({ msg: 'autoLoadAlbum interval failed', err: String(err) })
//     );
//   }, AUTOLOAD_INTERVAL);
// }

// ---- Boot -------------------------------------------------------------------
await preloadDays().catch(err =>
  app.log.error({ msg: 'preload failed', err: String(err) })
);
await preloadInteractions().catch(err =>
  app.log.error({ msg: 'interaction preload failed', err: String(err) })
);

app.listen({ port: PORT, host: '0.0.0.0' }, (err, address) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
  app.log.info(`Backend running at ${address}`);
});
