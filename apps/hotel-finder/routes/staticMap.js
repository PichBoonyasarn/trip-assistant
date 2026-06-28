const express = require('express');
const router = express.Router();
const { fetchStaticMapImage, MAX_MARKERS, MAX_PATH_POINTS } = require('../lib/staticMap');

const GOOGLE_MAPS_KEY = process.env.GOOGLE_MAPS_KEY || '';

const SIZE_PATTERN = /^\d{1,4}x\d{1,4}$/;

function parsePoints(raw, max, label, res) {
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    res.status(400).json({ error: `${label} must be valid JSON` });
    return null;
  }
  if (!Array.isArray(parsed)) {
    res.status(400).json({ error: `${label} must be a JSON array` });
    return null;
  }
  for (const p of parsed.slice(0, max)) {
    if (typeof p.lat !== 'number' || typeof p.lng !== 'number') {
      res.status(400).json({ error: `${label} entries need numeric lat/lng` });
      return null;
    }
  }
  return parsed.slice(0, max);
}

// GET /api/static-map?markers=<JSON array>&path=<JSON array>&size=600x400
// markers: [{ lat, lng, label, color }]   path: [{ lat, lng }, ...]
// Proxies Google's Static Maps API server-side so GOOGLE_MAPS_KEY never
// reaches the browser — same reasoning as routes/poi.js's /photo proxy.
// Kept as its own curl-testable route per this project's "every route
// independently testable" rule, even though routes/documentGen.js calls
// lib/staticMap.js directly rather than over HTTP.
router.get('/', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!GOOGLE_MAPS_KEY) return res.status(500).json({ error: 'GOOGLE_MAPS_KEY is not configured' });

  const markers = parsePoints(req.query.markers, MAX_MARKERS, 'markers', res);
  if (markers === null) return;
  const path = parsePoints(req.query.path, MAX_PATH_POINTS, 'path', res);
  if (path === null) return;
  if (!markers.length && !path.length) {
    return res.status(400).json({ error: 'at least one marker or path point is required' });
  }

  const size = req.query.size && SIZE_PATTERN.test(req.query.size) ? req.query.size : '600x400';
  const scale = req.query.scale === '1' ? 1 : 2;

  try {
    const buf = await fetchStaticMapImage({ markers, path, size, scale }, GOOGLE_MAPS_KEY);
    res.set('Content-Type', 'image/png');
    res.send(buf);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
