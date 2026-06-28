const { withRetry } = require('./retry');

const STATIC_MAP_URL = 'https://maps.googleapis.com/maps/api/staticmap';
const STREET_VIEW_URL = 'https://maps.googleapis.com/maps/api/streetview';

// Markers and path points both blow up a Static Maps URL fast (each marker/
// point is its own query-string entry) — Google's hard limit is ~8192 chars
// for the whole URL. Raised from 15 to 20, 2026-06-21, to fit
// documentGen.js's 周辺スポット map (1 hotel + up to 18 numbered spot pins) —
// live-tested a worst-case 19-marker request: ~1.2KB URL, well under the
// limit, and Google returned a valid image.
const MAX_MARKERS = 20;
const MAX_PATH_POINTS = 100;

// Reduces a path to at most `max` points by taking every Nth point, always
// keeping the first and last (start/end matter most for a route line) —
// same "thin out, don't just truncate" approach as routePlanning.js's
// samplePoints(), just simpler since this only needs visual fidelity, not
// even spacing for a search radius.
function thinPath(path, max) {
  if (!path || path.length <= max) return path || [];
  const step = (path.length - 1) / (max - 1);
  const thinned = [];
  for (let i = 0; i < max; i++) thinned.push(path[Math.round(i * step)]);
  return thinned;
}

// `markers`: [{ lat, lng, label, color }] — color is any Static Maps color
// name/hex (e.g. 'red', 'blue', '0x4a6354'); label must be a single
// uppercase letter/digit per Google's API, omitted if not provided.
// `path`: [{ lat, lng }, ...] — drawn as one polyline. `zoom`/`center`: set
// both to force an explicit close-up view instead of Google's default
// marker-bounding-box auto-fit (auto-fit is why combined-marker maps look
// zoomed out) — live-tested `zoom=18` as a good "see street names" level
// for a ~500m-radius view. `styles`: string[] — each entry is one Static
// Maps `style=` rule (e.g. 'saturation:-65|lightness:15' or
// 'feature:poi|element:labels.icon|visibility:off'), appended as separate
// query params per Google's multi-style syntax. Defaults to none, so
// existing callers (現場/route/hospital maps) are unaffected — added for
// routes/documentGen.js's spot-cluster maps (round 2026-06-22, readability
// pass) to mute the base map so composited icon markers stand out more.
function buildStaticMapUrl({ markers = [], path = [], size = '600x400', scale = 2, zoom, center, styles = [] }, apiKey) {
  const params = new URLSearchParams();
  params.set('size', size);
  params.set('scale', String(scale));
  params.set('language', 'ja');
  params.set('key', apiKey);
  if (zoom != null) params.set('zoom', String(zoom));
  if (center) params.set('center', `${center.lat},${center.lng}`);
  for (const s of styles) params.append('style', s);

  for (const m of markers.slice(0, MAX_MARKERS)) {
    if (m.lat == null || m.lng == null) continue;
    const style = [
      m.color ? `color:${m.color}` : null,
      m.label ? `label:${m.label}` : null,
      `${m.lat},${m.lng}`,
    ].filter(Boolean).join('|');
    params.append('markers', style);
  }

  const thinned = thinPath(path, MAX_PATH_POINTS);
  if (thinned.length) {
    const pathStr = ['color:0x4a6354', 'weight:4']
      .concat(thinned.map(p => `${p.lat},${p.lng}`))
      .join('|');
    params.set('path', pathStr);
  }

  return `${STATIC_MAP_URL}?${params.toString()}`;
}

// Fetches the actual image bytes server-side, so GOOGLE_MAPS_KEY never
// reaches the browser — same reasoning as routes/poi.js's /photo proxy.
async function fetchStaticMapImage(opts, apiKey) {
  const url = buildStaticMapUrl(opts, apiKey);
  return withRetry(async () => {
    const r = await fetch(url);
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      throw new Error(`Static Maps API: ${r.status} ${body.slice(0, 200)}`);
    }
    return Buffer.from(await r.arrayBuffer());
  }, { attempts: 3, delayMs: 800 });
}

// Street View Static API — a different endpoint/param shape from Static
// Maps (location/size/fov, no markers/path/zoom). Requires the Street View
// Static API to be separately enabled in Cloud Console (confirmed enabled
// 2026-06-21 — previously 403'd). `fov` (field of view, degrees) defaults to
// a moderate zoom-in rather than Google's default 90, since 現場所在地 wants
// a recognizable building shot, not a wide street panorama slice.
async function fetchStreetViewImage(lat, lng, apiKey, { size = '600x400', fov = 80 } = {}) {
  const params = new URLSearchParams({
    size, fov: String(fov), location: `${lat},${lng}`, language: 'ja', key: apiKey,
  });
  const url = `${STREET_VIEW_URL}?${params.toString()}`;
  return withRetry(async () => {
    const r = await fetch(url);
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      throw new Error(`Street View API: ${r.status} ${body.slice(0, 200)}`);
    }
    return Buffer.from(await r.arrayBuffer());
  }, { attempts: 3, delayMs: 800 });
}

module.exports = { buildStaticMapUrl, fetchStaticMapImage, fetchStreetViewImage, MAX_MARKERS, MAX_PATH_POINTS };
