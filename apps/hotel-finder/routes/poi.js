const express = require('express');
const router = express.Router();
const { searchNearby, shapePlace, RATING_SUMMARY_FIELDS, PHONE_FIELD, ICON_FIELD } = require('../lib/googlePlaces');

const GOOGLE_MAPS_KEY = process.env.GOOGLE_MAPS_KEY || '';

// Google's Places types don't have a "has ER" flag, and Google's bare
// 'hospital' type tag in Japan is sprayed onto all sorts of unrelated rural
// businesses found during testing — a pet salon (ペットサロン チャーミング), a
// doctors' association office (新宮市医師会), acupuncture/orthopedic shops,
// even an online-telehealth brand — so the type tag alone is not trustworthy.
//
// The reliable signal is the name itself: "病院" (hospital) is legally
// restricted under Japan's Medical Care Act (医療法) to licensed facilities
// with 20+ inpatient beds — clinics must call themselves 診療所/医院/クリニック
// instead. A name containing 病院 is treated as authoritative and overrides
// Google's noisy type tags. Exceptions: animal hospitals (動物病院) legally
// also use 病院 but aren't relevant to a human workplace injury, so name
// exclusions are checked first; an explicit 救急/急患 (emergency) keyword is
// still treated as a override for facilities that don't say 病院 at all.
//
// Specialty/single-department hospitals (専門病院) are excluded by request —
// for a workplace-accident use case, a cancer center or psychiatric hospital
// generally isn't where you'd send an injured worker, even though it's a
// legally real 病院. No structured Places signal distinguishes "specialty"
// from "general", so this is name-keyword-based like the rest of the list —
// known to be an incomplete heuristic; report any specialty hospital that
// still slips through and it can be added.
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

  // Legally-protected term — trust the name over Google's type tags.
  if (name.includes('病院') || types.includes('general_hospital')) return true;

  // Weaker name signals (医院/医療センター aren't legally restricted) still
  // need the type-tag check, since these terms get used by small clinics too.
  if (!NAME_REQUIRE_KEYWORDS.some(k => name.includes(k))) return false;
  return !CLINIC_TYPES.some(t => types.includes(t));
}

function parseLatLng(req, res) {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  if (isNaN(lat) || isNaN(lng)) { res.status(400).json({ error: 'lat and lng are required' }); return null; }
  return { lat, lng };
}

// Query both types — 'general_hospital' alone misses real hospitals Google
// didn't tag that way (e.g. 順天堂大学医学部附属順天堂医院), while plain
// 'hospital' alone can be noisy. Deliberately uses Google's DEFAULT
// (popularity) ranking, not rankPreference: DISTANCE — tested both: at a
// large radius, DISTANCE ranking lets the 20-result cap fill up with
// whatever's literally closest regardless of legitimacy (an online-doctor
// brand and a chiropractic clinic outranked every real hospital within
// meters of Tokyo Station), while default ranking reliably surfaces actual
// major hospitals. Final ordering is still by true distance — see the sort
// below — popularity ranking only affects which 20 candidates per type
// survive Google's result cap before that sort happens.
async function fetchQualifyingHospitals(lat, lng, radius) {
  const [generalResults, hospitalResults] = await Promise.all([
    searchNearby(lat, lng, radius, { includedTypes: ['general_hospital'], extraFields: PHONE_FIELD }, GOOGLE_MAPS_KEY),
    searchNearby(lat, lng, radius, { includedTypes: ['hospital'], extraFields: PHONE_FIELD }, GOOGLE_MAPS_KEY),
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

// Called ONCE per search — 現場 is a single fixed point (origin lat/lng).
// Tier 1: search 30km, return up to `limit` (default 5) closest. Tier 2
// (sparse-area guardrail): only if NOTHING qualifies within 30km, widen to
// Google's max radius (50km — the platform's hard cap, there's no true
// "unlimited") but only ask for the nearest `fallbackLimit` (default 2) —
// padding a list out to 5 with hospitals 40-50km away isn't more useful
// than just showing the realistic nearest couple.
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

// Called automatically for every search's top hotels (AI-recommendation
// scoring needs this for all of them, not just one the user picks), so it's
// deliberately a cheap shape: 3 combined searchNearby calls per hotel
// (Places API (New) matches *any* of multiple includedTypes in one request,
// same trick used elsewhere in this app) instead of one call per type, and
// counts only — no name/address/photo/etc., since callers only ever use
// these as numbers for scoring.
//
// 3 calls, not fewer: live testing in a dense area (Shinjuku) found that
// grouping too much behind one 20-result cap silently zeroes out sparser
// types. All 6 types in 1 call: restaurants/izakaya/bars alone filled all
// 20 slots, returning *zero* convenience stores/supermarkets/parking even
// though 20+ convenience stores existed within radius. Convenience stores
// + supermarket + parking in 1 call: convenience stores (also extremely
// dense — conbini density in Japan is famously high) alone filled the cap,
// zeroing out supermarkets (confirmed 3 actually existed, 0 came back).
// Convenience stores need their own dedicated call. supermarket+parking
// still share one cap — in the same Shinjuku test, parking alone (19) very
// nearly filled it, undercounting supermarkets (1 found vs. 3 actual) —
// smaller residual imprecision than the zero-out cases above, judged
// acceptable since it only softens one score factor rather than erasing
// it; splitting parking out too would mean a 4th call (20/search). Still
// 15/search instead of 25 (or 30, before the New API migration). See
// docs/feature-roadmap.md.
router.get('/amenity-counts', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const empty = { convenienceStores: 0, restaurants: 0, izakaya: 0, bars: 0, supermarkets: 0, parking: 0 };
  if (!GOOGLE_MAPS_KEY) return res.json(empty);
  const coords = parseLatLng(req, res); if (!coords) return;
  const { lat, lng } = coords;
  const radius = Math.min(parseFloat(req.query.radius) || 400, 2000);
  try {
    const [convResults, infraResults, diningResults] = await Promise.all([
      searchNearby(lat, lng, radius, { includedTypes: ['convenience_store'], maxResultCount: 20 }, GOOGLE_MAPS_KEY),
      searchNearby(lat, lng, radius, { includedTypes: ['grocery_store', 'parking'], maxResultCount: 20 }, GOOGLE_MAPS_KEY),
      searchNearby(lat, lng, radius, { includedTypes: ['restaurant', 'japanese_izakaya_restaurant', 'bar'], maxResultCount: 20 }, GOOGLE_MAPS_KEY),
    ]);
    const counts = { ...empty };
    for (const place of [...convResults, ...infraResults, ...diningResults]) {
      const types = place.types || [];
      if (types.includes('japanese_izakaya_restaurant')) counts.izakaya++;
      else if (types.includes('restaurant')) counts.restaurants++;
      if (types.includes('convenience_store')) counts.convenienceStores++;
      if (types.includes('bar')) counts.bars++;
      if (types.includes('grocery_store')) counts.supermarkets++;
      if (types.includes('parking')) counts.parking++;
    }
    res.json(counts);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Called on-demand when the user picks a hotel to inspect (not run
// automatically for every search result, same reasoning as /amenity-counts
// above but with full place details instead of just counts, since this one
// is actually shown to the user — this is 6 Places calls per hotel, and
// search results can have up to 10). travelSpots uses a larger radius since
// landmarks/museums are sparser than convenience stores/restaurants.
//
// Also requests RATING_SUMMARY_FIELDS (rating, userRatingCount,
// editorialSummary) on all 6 calls, 2026-06-21 — these are Enterprise/
// Enterprise+Atmosphere-tier, pricier than the default field mask, but this
// route was already opt-in and once-per-hotel, so the added cost is scoped
// here rather than spreading to the automatic hospital/dining/route-stop
// calls (see RATING_SUMMARY_FIELDS's comment in lib/googlePlaces.js).
router.get('/hotel-spots', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!GOOGLE_MAPS_KEY) {
    return res.json({ convenienceStores: [], supermarkets: [], restaurants: [], izakaya: [], bars: [], travelSpots: [] });
  }
  const coords = parseLatLng(req, res); if (!coords) return;
  const { lat, lng } = coords;
  const radius       = Math.min(parseFloat(req.query.radius) || 500, 2000);
  const diningRadius = Math.min(parseFloat(req.query.diningRadius) || 300, 2000);
  const barRadius    = Math.min(parseFloat(req.query.barRadius) || 400, 2000);
  const travelRadius = Math.min(parseFloat(req.query.travelRadius) || 2000, 5000);
  // Icon glyph data (round 2026-06-22, Phase 5 Stage 1) shares this route's
  // existing extraFields mechanism — see ICON_FIELD's comment in
  // lib/googlePlaces.js for why it's combined with RATING_SUMMARY_FIELDS
  // here rather than added to the default FIELD_MASK.
  const spotExtraFields = `${RATING_SUMMARY_FIELDS},${ICON_FIELD}`;
  try {
    const [convResults, superResults, restaurantResults, izakayaResults, barResults, travelResults] = await Promise.all([
      searchNearby(lat, lng, radius, { includedTypes: ['convenience_store'], extraFields: spotExtraFields }, GOOGLE_MAPS_KEY),
      searchNearby(lat, lng, radius, { includedTypes: ['grocery_store'], extraFields: spotExtraFields }, GOOGLE_MAPS_KEY),
      searchNearby(lat, lng, diningRadius, { includedTypes: ['restaurant'], excludedTypes: ['japanese_izakaya_restaurant'], extraFields: spotExtraFields }, GOOGLE_MAPS_KEY),
      searchNearby(lat, lng, diningRadius, { includedTypes: ['japanese_izakaya_restaurant'], extraFields: spotExtraFields }, GOOGLE_MAPS_KEY),
      searchNearby(lat, lng, barRadius, { includedTypes: ['bar'], extraFields: spotExtraFields }, GOOGLE_MAPS_KEY),
      searchNearby(lat, lng, travelRadius, { includedTypes: ['tourist_attraction', 'museum', 'art_gallery'], extraFields: spotExtraFields }, GOOGLE_MAPS_KEY),
    ]);
    res.json({
      convenienceStores: convResults.map(p => shapePlace(p, lat, lng)),
      supermarkets:       superResults.map(p => shapePlace(p, lat, lng)),
      restaurants:        restaurantResults.map(p => shapePlace(p, lat, lng)),
      izakaya:            izakayaResults.map(p => shapePlace(p, lat, lng)),
      bars:               barResults.map(p => shapePlace(p, lat, lng)),
      travelSpots:        travelResults.map(p => shapePlace(p, lat, lng)),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/poi/parking — 駐車場 pins for the KML map export only (routes/
// mapExport.js, public/js/mapExport.js's fetchParkingSpots()), deliberately
// kept separate from /hotel-spots above: the live 周辺スポット panel and the
// .docx 計画書 both consume /hotel-spots' fixed 6-category response, and
// 駐車場 was explicitly scoped to the KML export only (2026-06-23) — folding
// it into /hotel-spots would have leaked it into both of those for free,
// which isn't what was asked for. No extraFields requested — a KML pin only
// needs name/address/lat/lng, none of which need RATING_SUMMARY_FIELDS or
// ICON_FIELD, so this stays on the cheapest default tier rather than
// matching /hotel-spots' pricier Enterprise-tier calls.
router.get('/parking', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!GOOGLE_MAPS_KEY) return res.json({ parking: [] });
  const coords = parseLatLng(req, res); if (!coords) return;
  const { lat, lng } = coords;
  const radius = Math.min(parseFloat(req.query.radius) || 500, 2000);
  try {
    const results = await searchNearby(lat, lng, radius, { includedTypes: ['parking'] }, GOOGLE_MAPS_KEY);
    res.json({ parking: results.map(p => shapePlace(p, lat, lng)) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const PHOTO_NAME_PATTERN = /^places\/[^/]+\/photos\/[^/]+$/;

// Proxies a Places Photo (New) image so the API key never reaches the
// browser (an <img src> with the key embedded would leak it). `name` must be
// a photoRef from shapePlace() — validated strictly since this endpoint
// forwards to an external URL, unlike the coordinate-only routes above.
// Each request is a real, separate billable "Place Photo" call (unlike the
// free photos[] reference fetched alongside a search), so callers should
// only hit this lazily for photos actually shown to the user.
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
