const express = require('express');
const router = express.Router();
const { searchNearby, shapePlace } = require('../lib/googlePlaces');
const { decodePolyline } = require('../lib/polyline');
const { withRetry } = require('../lib/retry');
const { haversine } = require('../lib/haversine');

const GOOGLE_MAPS_KEY = process.env.GOOGLE_MAPS_KEY || '';
const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const ROUTES_FIELD_MASK = [
  'routes.distanceMeters', 'routes.duration', 'routes.polyline.encodedPolyline',
].join(',');

// Single point-to-point route (no intermediates) — this is the "Essentials"
// SKU tier on Routes API (10,000 free calls/month), unlike the Places calls
// below (Pro tier, 5,000 free/month). Kept as its own cheap call so a leg's
// distance/duration/map line can be shown without paying for a Places search.
async function computeLeg(origin, destination) {
  return withRetry(async () => {
    const body = {
      origin: { location: { latLng: { latitude: origin.lat, longitude: origin.lng } } },
      destination: { location: { latLng: { latitude: destination.lat, longitude: destination.lng } } },
      travelMode: 'DRIVE',
      languageCode: 'ja',
      units: 'METRIC',
    };
    const r = await fetch(ROUTES_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': GOOGLE_MAPS_KEY,
        'X-Goog-FieldMask': ROUTES_FIELD_MASK,
      },
      body: JSON.stringify(body),
    });
    const json = await r.json();
    if (json.error) throw new Error(`Routes API: ${json.error.status} ${json.error.message}`);
    if (!json.routes || !json.routes.length) throw new Error('Routes API: no route found');
    return json.routes[0];
  }, { attempts: 3, delayMs: 800 });
}

// Picks points roughly every `intervalMeters` along the decoded polyline,
// capped at `maxSamples` so a long leg can't trigger unbounded Places calls.
function samplePoints(points, intervalMeters, maxSamples) {
  if (!points.length) return [];
  const samples = [points[0]];
  let accumulated = 0;
  for (let i = 1; i < points.length && samples.length < maxSamples; i++) {
    accumulated += haversine(points[i - 1].lat, points[i - 1].lng, points[i].lat, points[i].lng) * 1000;
    if (accumulated >= intervalMeters) {
      samples.push(points[i]);
      accumulated = 0;
    }
  }
  return samples;
}

// Categorizes a list of Places (New) results into the {gasStations,
// convenienceStores} shape the frontend renders, given each result's raw
// `types` (must be checked before shapePlace(), which doesn't keep types).
function bucketStops(placesWithOrigin) {
  const byId = new Map();
  for (const { place, origin } of placesWithOrigin) {
    if (byId.has(place.id)) continue;
    const category = (place.types || []).includes('gas_station') ? 'gasStation' : 'convenienceStore';
    byId.set(place.id, { ...shapePlace(place, origin.lat, origin.lng), category });
  }
  const all = [...byId.values()].sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));
  return {
    gasStations: all.filter(p => p.category === 'gasStation').map(({ category, ...rest }) => rest),
    convenienceStores: all.filter(p => p.category === 'convenienceStore').map(({ category, ...rest }) => rest),
  };
}

// Searches near sampled points along a leg's whole polyline — used when
// "anywhere along the way" matters (default mode). `includedTypes` in one
// call per sample point (Places API (New) matches *any* of them), halving
// the call count vs. one request per type per sample. Up to 8 calls/leg —
// the expensive part of a leg lookup, only run when the caller opts in.
async function findStopsAlongLegPoints(points, includedTypes) {
  const samples = samplePoints(points, 5000, 8);
  const perSample = await Promise.all(samples.map(pt =>
    searchNearby(pt.lat, pt.lng, 500, { includedTypes, maxResultCount: 5 }, GOOGLE_MAPS_KEY)
      .then(places => places.map(place => ({ place, origin: pt })))
      .catch(() => [])
  ));
  return bucketStops(perSample.flat());
}

// Searches once near a single point (e.g. a leg's destination) instead of
// sampling the whole route — used when "closest to 現場" matters more than
// "anywhere along the way" (window 1's stop search). One call instead of up
// to 8. `limit` trims each category down after sorting by distance.
async function findStopsNearPoint(point, includedTypes, limit) {
  const results = await searchNearby(point.lat, point.lng, 1500, { includedTypes, maxResultCount: 10 }, GOOGLE_MAPS_KEY);
  const bucketed = bucketStops(results.map(place => ({ place, origin: point })));
  return limit
    ? { gasStations: bucketed.gasStations.slice(0, limit), convenienceStores: bucketed.convenienceStores.slice(0, limit) }
    : bucketed;
}

function parseCoord(req, res, prefix) {
  const lat = parseFloat(req.query[`${prefix}Lat`]);
  const lng = parseFloat(req.query[`${prefix}Lng`]);
  if (isNaN(lat) || isNaN(lng)) {
    res.status(400).json({ error: `${prefix}Lat and ${prefix}Lng are required` });
    return null;
  }
  return { lat, lng };
}

const VALID_STOP_TYPES = ['gas_station', 'convenience_store'];

// One point-to-point leg, reused for both company->worksite and
// worksite->hotel (the frontend calls this twice instead of once with a
// Routes API intermediate, since the two legs are now shown in separate,
// independently-triggered UI windows). `includeStops=true` additionally
// searches for stops — omitted by default so showing distance/duration/the
// route line doesn't spend any Places quota. Stop search itself is tunable
// per call (callers decide how much to spend, not this route):
//   stopTypes=gas_station,convenience_store (default both; restrict to just
//     one, e.g. window 1 wants convenience stores only)
//   stopMode=route (default — sample the whole polyline, up to 8 calls) or
//     destination (one call near the `to` point only — window 1 only cares
//     about what's near 現場, not anywhere along the way)
//   stopLimit=N (trim each category to the N closest after sorting)
router.get('/leg', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!GOOGLE_MAPS_KEY) return res.status(500).json({ error: 'GOOGLE_MAPS_KEY is not configured' });

  const from = parseCoord(req, res, 'from'); if (!from) return;
  const to   = parseCoord(req, res, 'to');   if (!to) return;
  const includeStops = req.query.includeStops === 'true';
  const stopTypes = (req.query.stopTypes ? req.query.stopTypes.split(',') : VALID_STOP_TYPES)
    .filter(t => VALID_STOP_TYPES.includes(t));
  const stopMode = req.query.stopMode === 'destination' ? 'destination' : 'route';
  const stopLimit = req.query.stopLimit ? Math.max(parseInt(req.query.stopLimit, 10), 1) : null;

  try {
    const route = await computeLeg(from, to);
    const path = decodePolyline(route.polyline?.encodedPolyline);
    const stops = includeStops
      ? (stopMode === 'destination'
          ? await findStopsNearPoint(to, stopTypes, stopLimit)
          : await findStopsAlongLegPoints(path, stopTypes))
      : undefined;

    res.json({
      distanceMeters: route.distanceMeters ?? null,
      durationSeconds: route.duration ? parseInt(route.duration, 10) : null,
      path,
      ...(stops ? { stops } : {}),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
