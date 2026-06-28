const express = require('express');
const router = express.Router();
const { haversine } = require('../lib/haversine');
const { withRetry } = require('../lib/retry');

const LITEAPI_KEY  = process.env.LITEAPI_KEY || '';
const LITEAPI_BASE = 'https://api.liteapi.travel/v3.0';

// Default reference dates: 14 days out, 1 night — this app shows a
// representative price, not a specific trip booking.
function getDefaultDates() {
  const checkin = new Date();
  checkin.setDate(checkin.getDate() + 14);
  const checkout = new Date(checkin);
  checkout.setDate(checkout.getDate() + 1);
  const fmt = d => d.toISOString().slice(0, 10);
  return { checkin: fmt(checkin), checkout: fmt(checkout) };
}

// Proxy LiteAPI — 2 step: find hotels near the point, then fetch rates
// for those specific hotel IDs (coordinate search alone returns no rates).
router.get('/', async (req, res) => {
  // Prevent the browser from caching/replaying a stale (e.g. empty-on-failure)
  // response for an identical lat/lng/radius/maxHotels query string.
  res.set('Cache-Control', 'no-store');

  if (!LITEAPI_KEY) {
    return res.json({ hotels: [] }); // LiteAPI not configured — silently skip
  }

  const lat    = parseFloat(req.query.lat);
  const lng    = parseFloat(req.query.lng);
  const radius = parseFloat(req.query.radius) || 2000;
  // Discovery goes through GET /data/hotels (a hotel-metadata search), not
  // POST /hotels/rates' coordinate search — that endpoint has a confirmed
  // hard ~2.6km radius cap on this sandbox key (2600m succeeds, 2700m
  // deterministically fails with "no availability found", code 2001).
  // /data/hotels tested fine up to 20km (a 50km request from dense central
  // Tokyo timed out — that's a looser, volume-related limit there, not a
  // hard validation wall — so stay well under it). This matters most in
  // rural areas, where the nearest hotel can easily sit outside the old
  // 2.5km cap and would otherwise never get a price match at all.
  const liteApiRadius = Math.min(radius, 20000);
  const maxHotels = Math.min(parseInt(req.query.maxHotels, 10) || 30, 60);

  if (isNaN(lat) || isNaN(lng)) {
    return res.status(400).json({ error: 'lat and lng are required' });
  }

  const { checkin, checkout } = getDefaultDates();
  const headers = { 'X-API-Key': LITEAPI_KEY, 'accept': 'application/json' };
  const postHeaders = { ...headers, 'content-type': 'application/json' };
  const commonParams = {
    checkin, checkout,
    currency: 'JPY',
    guestNationality: 'JP',
    occupancies: [{ adults: 1 }],
  };

  try {
    // Sandbox key intermittently returns "no availability found" — observed
    // to be a deterministic response for a given payload at a given moment
    // (not random per-call, not rate-limit exhaustion), but the underlying
    // demo dataset appears to change over longer time windows. Retrying
    // within one request can't fix a state that won't change for minutes —
    // see docs/session-plan-2026-06-17.md for the full investigation.
    async function callWithRetry(attemptFn, label, attempts = 8) {
      try {
        return await withRetry(attemptFn, {
          attempts,
          delayMs: 1200,
          onFailure: (err, i, n) => console.log(`[LiteAPI] ${label} attempt ${i + 1}/${n} failed — ${err.message}`),
        });
      } catch (err) {
        console.log(`[LiteAPI] ${label}: all ${attempts} attempts failed — ${err.message}`);
        return { hotels: [], data: [] };
      }
    }

    // Step 1: hotels near this point (id, name, lat, lng — no rates yet).
    // Coordinate-only — no hotelName param, since LiteAPI's name search
    // doesn't match Japanese hotel names at all (tested live: real hotel
    // names like ザ・ペニンシュラ東京 returned zero results via hotelName,
    // while the English name "Peninsula Tokyo" matched correctly).
    const listData = await callWithRetry(async () => {
      const url = `${LITEAPI_BASE}/data/hotels?latitude=${lat}&longitude=${lng}&radius=${Math.round(liteApiRadius)}&limit=200`;
      const r = await fetch(url, { headers });
      const json = await r.json();
      if (json.error) {
        const remaining = r.headers.get('x-ratelimit-remaining');
        const limit = r.headers.get('x-ratelimit-limit');
        throw new Error(`http ${r.status}, code ${json.error.code}, message: "${json.error.message}", rate-limit: ${remaining}/${limit}`);
      }
      return json;
    }, 'discovery');

    const sorted = (listData.data || [])
      .filter(h => h.latitude != null && h.longitude != null)
      .sort((a, b) => haversine(lat, lng, a.latitude, a.longitude) - haversine(lat, lng, b.latitude, b.longitude));
    const nearby = sorted.slice(0, maxHotels);
    if (!nearby.length) return res.json({ hotels: [] });

    // Step 2: rates for those specific hotel IDs — unchanged.
    const rateData = await callWithRetry(async () => {
      const r = await fetch(`${LITEAPI_BASE}/hotels/rates`, {
        method: 'POST', headers: postHeaders,
        body: JSON.stringify({ hotelIds: nearby.map(h => h.id), ...commonParams }),
      });
      const json = await r.json();
      if (json.error) {
        const remaining = r.headers.get('x-ratelimit-remaining');
        const limit = r.headers.get('x-ratelimit-limit');
        throw new Error(`http ${r.status}, code ${json.error.code}, message: "${json.error.message}", rate-limit: ${remaining}/${limit}`);
      }
      return json;
    }, 'rates');

    const minRateByHotelId = {};
    for (const h of (rateData.data || [])) {
      let min = null;
      for (const rt of (h.roomTypes || [])) {
        const amount = rt.offerRetailRate && rt.offerRetailRate.amount;
        if (amount != null && (min == null || amount < min)) min = amount;
      }
      if (min != null) minRateByHotelId[h.hotelId] = Math.round(min);
    }

    const hotels = nearby
      .map(h => ({ name: h.name, lat: h.latitude, lng: h.longitude, minRate: minRateByHotelId[h.id] ?? null }))
      .filter(h => h.minRate != null);

    res.json({ hotels });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
