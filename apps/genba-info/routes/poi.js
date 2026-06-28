const express = require('express');
const router = express.Router();
const { searchNearby, shapePlace } = require('../lib/googlePlaces');

const GOOGLE_MAPS_KEY = process.env.GOOGLE_MAPS_KEY || '';

// Same hospital-filtering logic as Hotel-info/hotel-finder — see Hotel-info
// routes/poi.js for the full reasoning behind each list.
const NAME_EXCLUDE_KEYWORDS = [
  '動物', '獣医', '整骨', '整体', '整體', '鍼灸', '針灸', '診療所',
  '専門病院', 'がん', '癌', '精神',
];
const NAME_REQUIRE_KEYWORDS = ['病院', '医院', '医療センター'];
const DENTAL_TYPES = ['dentist', 'dental_clinic'];
const CLINIC_TYPES = ['doctor', 'medical_clinic', 'medical_center'];
const EMERGENCY_KEYWORDS = ['救急', '急患'];

function isLikelyEmergencyHospital(place) {
  const types = place.types || [];
  const name = place.displayName?.text || '';

  if (NAME_EXCLUDE_KEYWORDS.some(k => name.includes(k))) return false;
  if (EMERGENCY_KEYWORDS.some(k => name.includes(k))) return true;
  if (DENTAL_TYPES.some(t => types.includes(t))) return false;

  if (name.includes('病院') || types.includes('general_hospital')) return true;

  if (!NAME_REQUIRE_KEYWORDS.some(k => name.includes(k))) return false;
  return !CLINIC_TYPES.some(t => types.includes(t));
}

function parseLatLng(req, res) {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  if (isNaN(lat) || isNaN(lng)) { res.status(400).json({ error: 'lat and lng are required' }); return null; }
  return { lat, lng };
}

async function fetchQualifyingHospitals(lat, lng, radius) {
  const [generalResults, hospitalResults] = await Promise.all([
    searchNearby(lat, lng, radius, { includedTypes: ['general_hospital'] }, GOOGLE_MAPS_KEY),
    searchNearby(lat, lng, radius, { includedTypes: ['hospital'] }, GOOGLE_MAPS_KEY),
  ]);
  const byId = new Map();
  for (const p of [...generalResults, ...hospitalResults]) {
    if (!byId.has(p.id)) byId.set(p.id, p);
  }
  return [...byId.values()]
    .filter(isLikelyEmergencyHospital)
    .map(p => shapePlace(p, lat, lng))
    .sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));
}

router.get('/hospitals', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!GOOGLE_MAPS_KEY) return res.json({ hospitals: [] });
  const coords = parseLatLng(req, res); if (!coords) return;
  const { lat, lng } = coords;
  const limit         = Math.min(parseInt(req.query.limit, 10) || 5, 20);
  const fallbackLimit = Math.min(parseInt(req.query.fallbackLimit, 10) || 2, 20);
  try {
    const nearby = await fetchQualifyingHospitals(lat, lng, 30000);
    if (nearby.length) return res.json({ hospitals: nearby.slice(0, limit) });

    const wide = await fetchQualifyingHospitals(lat, lng, 50000);
    res.json({ hospitals: wide.slice(0, fallbackLimit) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Returns restaurants (300m), convenience stores (500m), gas stations (1000m)
// around the worksite. Gas stations are at a wider radius because they're
// sparser than restaurants/convenience stores in most areas.
router.get('/genba-spots', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!GOOGLE_MAPS_KEY) {
    return res.json({ restaurants: [], convenienceStores: [], gasStations: [] });
  }
  const coords = parseLatLng(req, res); if (!coords) return;
  const { lat, lng } = coords;
  const restaurantRadius = Math.min(parseFloat(req.query.restaurantRadius) || 300, 2000);
  const convRadius       = Math.min(parseFloat(req.query.convRadius) || 500, 2000);
  const gasRadius        = Math.min(parseFloat(req.query.gasRadius) || 1000, 5000);
  try {
    const [restaurantResults, convResults, gasResults] = await Promise.all([
      searchNearby(lat, lng, restaurantRadius, { includedTypes: ['restaurant'] }, GOOGLE_MAPS_KEY),
      searchNearby(lat, lng, convRadius, { includedTypes: ['convenience_store'] }, GOOGLE_MAPS_KEY),
      searchNearby(lat, lng, gasRadius, { includedTypes: ['gas_station'] }, GOOGLE_MAPS_KEY),
    ]);
    res.json({
      restaurants:      restaurantResults.map(p => shapePlace(p, lat, lng)),
      convenienceStores: convResults.map(p => shapePlace(p, lat, lng)),
      gasStations:       gasResults.map(p => shapePlace(p, lat, lng)),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const PHOTO_NAME_PATTERN = /^places\/[^/]+\/photos\/[^/]+$/;

router.get('/photo', async (req, res) => {
  const name = req.query.name;
  if (!name || !PHOTO_NAME_PATTERN.test(name)) {
    return res.status(400).json({ error: 'invalid or missing photo name' });
  }
  if (!GOOGLE_MAPS_KEY) return res.status(500).json({ error: 'GOOGLE_MAPS_KEY is not configured' });
  const maxWidthPx = Math.min(Math.max(parseInt(req.query.maxWidthPx, 10) || 160, 50), 800);

  try {
    const url = `https://places.googleapis.com/v1/${name}/media?maxWidthPx=${maxWidthPx}&key=${GOOGLE_MAPS_KEY}`;
    const r = await fetch(url);
    if (!r.ok) return res.status(502).json({ error: `Places Photo API: ${r.status}` });
    const buf = Buffer.from(await r.arrayBuffer());
    res.set('Content-Type', r.headers.get('content-type') || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(buf);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
