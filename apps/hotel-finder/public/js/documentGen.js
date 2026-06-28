// Reuses lastResults/originLat/originLng/originPlaceId/lastHospitals/
// hotelDocCache/lastStartToWorksiteLeg/companyLat/companyLng/
// ensureCompanyLocation/fetchRouteLeg/fetchHotelSpots/getDetails/setStatus
// — all globals/functions defined in the inline <script> in index.html,
// same pattern as poi.js/routePlanning.js.

// A real photo of 現場 when it was resolved from a typed name/address
// (originPlaceId set) — same legacy getDetails()/.getUrl() pattern
// already used for hotel.photoUrl. Returns null (no photo) when 現場 was
// entered as raw lat/lng (no place to fetch a photo for) or the resolved
// place has no photos; routes/documentGen.js falls back to Street View in
// both cases (round 2026-06-22 — Street View was previously always used,
// which showed an unrelated nearby panorama instead of an actual photo of
// a named landmark like 東京タワー).
async function fetchWorksitePhotoUrl() {
  if (!originPlaceId) return null;
  const service = new google.maps.places.PlacesService(document.createElement('div'));
  const details = await getDetails(service, originPlaceId);
  if (details.photos && details.photos.length > 0) {
    return details.photos[0].getUrl({ maxWidth: 600, maxHeight: 450 });
  }
  return null;
}

function shapeHospitalsForDoc(hospitals) {
  return (hospitals || []).map(h => ({
    name: h.name, address: h.address, distance: h.distance, lat: h.lat, lng: h.lng,
    phone: h.phone, photoRef: h.photoRef,
  }));
}

function shapeHotelSpotsForDoc(spots) {
  if (!spots || spots.error) return {};
  const shaped = {};
  for (const key of ['convenienceStores', 'supermarkets', 'restaurants', 'izakaya', 'bars', 'travelSpots']) {
    shaped[key] = (spots[key] || []).map(s => ({
      name: s.name, distance: s.distance, lat: s.lat, lng: s.lng,
      rating: s.rating, userRatingCount: s.userRatingCount,
      editorialSummary: s.editorialSummary, photoRef: s.photoRef,
      iconMaskBaseUri: s.iconMaskBaseUri,
    }));
  }
  return shaped;
}

// Must stay in sync with lib/staticMap.js's MAX_PATH_POINTS — the server
// thins any path to this many points before drawing it on a Static Map
// anyway, so sending more than this from the client is pure wasted bytes
// (and, for long/winding routes, what blows past express.json()'s body
// limit). Can't require() the server lib here — no module system, see
// header comment above.
const MAX_DOC_PATH_POINTS = 100;

// Reduces a path to at most `max` points by taking every Nth point, always
// keeping the first and last — same approach as lib/staticMap.js's
// thinPath() and routePlanning.js's samplePoints().
function thinPath(path, max) {
  if (!path || path.length <= max) return path || [];
  const step = (path.length - 1) / (max - 1);
  const thinned = [];
  for (let i = 0; i < max; i++) thinned.push(path[Math.round(i * step)]);
  return thinned;
}

// `maxPoints` defaults to the .docx's Static Maps point cap above — pass
// `null` to use the full, untouched route path instead (e.g. for the KML
// export, which renders an interactive vector line with no comparable
// point-count limit; thinning it the same way the .docx needs to made the
// route look like a coarse polygon instead of following roads, round
// 2026-06-23).
function shapeLegForDoc(leg, maxPoints = MAX_DOC_PATH_POINTS) {
  if (!leg || leg.error) return null;
  return {
    distanceMeters: leg.distanceMeters,
    durationSeconds: leg.durationSeconds,
    path: maxPoints ? thinPath(leg.path, maxPoints) : (leg.path || []),
  };
}

async function downloadBlobResponse(res, fallbackName) {
  const disposition = res.headers.get('Content-Disposition') || '';
  const match = disposition.match(/filename\*=UTF-8''([^;]+)/);
  const filename = match ? decodeURIComponent(match[1]) : fallbackName;
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Gathers + shapes the worksite/hotel/route/hospitals/hotelSpots payload for
// hotel `idx`, shared by generateDocument() (POSTs to /api/document/generate)
// and exportToMyMaps() (POSTs to /api/map-export/kml) — both need the exact
// same data, just send it to a different endpoint. Reuses already-fetched
// route-leg/hotel-spots data when available (cached by planRouteForHotel/
// showHotelSpots/loadStartToWorksiteRoute); fetches anything missing on
// demand via the same functions those buttons call, so this can trigger the
// same Places cost those buttons would, but only once and only when actually
// missing — never silently beyond what the user's click already implies.
// Returns null if the hotel/worksite aren't available yet. `fullPath: true`
// (used by exportToMyMaps()) sends the route legs' full, untouched path
// instead of the .docx's thinned-to-100-points version — see
// shapeLegForDoc()'s comment.
async function buildDocPayload(idx, { fullPath = false } = {}) {
  const hotel = lastResults[idx];
  if (!hotel) return null;
  if (originLat == null || originLng == null) return null;

  const worksite = { lat: originLat, lng: originLng };
  const hotelLoc = { lat: hotel.location.lat(), lng: hotel.location.lng() };
  const company = await ensureCompanyLocation();

  const cached = hotelDocCache.get(idx) || {};

  if (!shapeLegForDoc(lastStartToWorksiteLeg)) {
    lastStartToWorksiteLeg = await fetchRouteLeg(company, worksite, false);
  }
  if (!shapeLegForDoc(cached.routeToHotel)) {
    cached.routeToHotel = await fetchRouteLeg(worksite, hotelLoc, false);
  }
  if (!cached.hotelSpots) {
    cached.hotelSpots = await fetchHotelSpots(hotelLoc.lat, hotelLoc.lng);
  }
  // Cached per-idx like the fields above even though it doesn't depend on
  // the hotel — buildDocPayload() can be called for several hotels in
  // one session, and 現場 doesn't change between them, so this avoids
  // re-fetching the same place details/photo URL each time.
  if (cached.worksitePhotoUrl === undefined) {
    cached.worksitePhotoUrl = await fetchWorksitePhotoUrl();
  }
  hotelDocCache.set(idx, cached);

  const locationInput = document.getElementById('location').value.trim();

  return {
    worksite: {
      lat: worksite.lat, lng: worksite.lng,
      address: locationInput || `${worksite.lat}, ${worksite.lng}`,
      photoUrl: cached.worksitePhotoUrl || null,
    },
    company: { lat: company.lat, lng: company.lng },
    hotel: {
      name: hotel.name, address: hotel.address, phone: hotel.phone,
      actualPrice: hotel.actualPrice ?? null,
      priceMin: hotel.priceMin ?? null,
      priceMax: hotel.priceMax ?? null,
      priceEstimated: hotel.priceEstimated ?? null,
      lat: hotelLoc.lat, lng: hotelLoc.lng,
      photoUrl: hotel.photoUrl || null,
    },
    routeToWorksite: shapeLegForDoc(lastStartToWorksiteLeg, fullPath ? null : MAX_DOC_PATH_POINTS),
    routeToHotel: shapeLegForDoc(cached.routeToHotel, fullPath ? null : MAX_DOC_PATH_POINTS),
    hospitals: shapeHospitalsForDoc(lastHospitals),
    hotelSpots: shapeHotelSpotsForDoc(cached.hotelSpots),
  };
}

// Generates and downloads a .docx for hotel `idx`. See buildDocPayload() for
// the data-gathering/shaping logic, shared with exportToMyMaps().
async function generateDocument(idx) {
  const btn = document.getElementById(`docGenBtn-${idx}`);
  if (btn) { btn.disabled = true; btn.textContent = '生成中…'; }
  setStatus('計画書を生成中…');

  try {
    const payload = await buildDocPayload(idx);
    if (!payload) return;

    const res = await fetch('/api/document/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `計画書生成エラー: ${res.status}`);
    }
    await downloadBlobResponse(res, `keikakusho_${payload.hotel.name || 'hotel'}.docx`);
    setStatus('計画書をダウンロードしました。', true);
  } catch (err) {
    setStatus(err.message || '計画書の生成に失敗しました。');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '計画書を生成'; }
  }
}
