// Reuses worksiteLat/worksiteLng/worksitePlaceId/hotelLat/hotelLng/lastHospitals/
// lastStartToWorksiteLeg/cachedRouteToHotel/cachedHotelSpots/companyLat/
// companyLng/ensureCompanyLocation/fetchRouteLeg/fetchHotelSpots/setStatus
// — all globals defined in the inline <script> in index.html, same pattern
// as poi.js/routePlanning.js.

function shapeHospitalsForDoc(hospitals) {
  return (hospitals || []).map(h => ({
    name: h.name, address: h.address, distance: h.distance,
    lat: h.lat, lng: h.lng, phone: h.phone ?? null,
  }));
}

function shapeHotelSpotsForDoc(spots) {
  if (!spots || spots.error) return {};
  const shaped = {};
  for (const key of ['convenienceStores', 'supermarkets', 'restaurants', 'izakaya', 'bars', 'travelSpots']) {
    shaped[key] = (spots[key] || []).map(s => ({
      name: s.name, distance: s.distance, lat: s.lat, lng: s.lng,
      rating: s.rating ?? null, userRatingCount: s.userRatingCount ?? null,
      editorialSummary: s.editorialSummary ?? null,
      photoRef: s.photoRef ?? null,
      iconMaskBaseUri: s.iconMaskBaseUri ?? null,
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

function shapeLegForDoc(leg) {
  if (!leg || leg.error) return null;
  return {
    distanceMeters: leg.distanceMeters,
    durationSeconds: leg.durationSeconds,
    path: thinPath(leg.path, MAX_DOC_PATH_POINTS),
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

// Fetches a real Places photo of 現場 when it was resolved from a typed
// name/address (worksitePlaceId set by index.html's geocoder). Returns null
// when worksitePlaceId is absent (raw lat/lng input) — the backend's
// fetchWorksitePhoto() will fall back to Street View in that case.
async function fetchWorksitePhotoUrl() {
  if (!worksitePlaceId) return null;
  return new Promise(resolve => {
    const svc = new google.maps.places.PlacesService(document.createElement('div'));
    svc.getDetails({ placeId: worksitePlaceId, fields: ['photos'] }, (place, status) => {
      if (status !== 'OK' || !place.photos?.length) return resolve(null);
      resolve(place.photos[0].getUrl({ maxWidth: 1200 }));
    });
  });
}

// Generates and downloads a .docx for the single manually-entered hotel.
// Reuses already-fetched route-leg/hotel-spots data (cachedRouteToHotel/
// cachedHotelSpots, populated by 情報を取得's loadRouteToHotel/
// loadHotelSpots), fetching anything missing on demand — same fallback
// reasoning as hotel-finder's generateDocument(idx), just without a
// per-index cache since there's only ever one hotel per session.
async function generateDocument() {
  if (worksiteLat == null || worksiteLng == null) return;
  if (hotelLat == null || hotelLng == null) return;

  const btn = document.getElementById('generateDocBtn');
  if (btn) { btn.disabled = true; btn.textContent = '生成中…'; }
  setStatus('計画書を生成中…');

  try {
    const worksite = { lat: worksiteLat, lng: worksiteLng };
    const hotelLoc = { lat: hotelLat, lng: hotelLng };
    const company = await ensureCompanyLocation();

    if (!shapeLegForDoc(lastStartToWorksiteLeg)) {
      lastStartToWorksiteLeg = await fetchRouteLeg(company, worksite, false);
    }
    if (!shapeLegForDoc(cachedRouteToHotel)) {
      cachedRouteToHotel = await fetchRouteLeg(worksite, hotelLoc, false);
    }
    if (!cachedHotelSpots) {
      cachedHotelSpots = await fetchHotelSpots(hotelLoc.lat, hotelLoc.lng);
    }

    const hotelName = document.getElementById('hotelName').value.trim();
    const hotelAddress = document.getElementById('hotelAddress').value.trim();
    const hotelPhone = document.getElementById('hotelPhone').value.trim();
    const hotelPrice = document.getElementById('hotelPrice').value.trim();
    const worksiteAddressInput = document.getElementById('worksiteAddress').value.trim();

    const worksitePhotoUrl = await fetchWorksitePhotoUrl();

    const payload = {
      worksite: { lat: worksite.lat, lng: worksite.lng, address: worksiteAddressInput || `${worksite.lat}, ${worksite.lng}`, photoUrl: worksitePhotoUrl },
      company: { lat: company.lat, lng: company.lng },
      hotel: {
        name: hotelName, address: hotelAddress, phone: hotelPhone,
        price: hotelPrice, lat: hotelLoc.lat, lng: hotelLoc.lng,
      },
      routeToWorksite: shapeLegForDoc(lastStartToWorksiteLeg),
      routeToHotel: shapeLegForDoc(cachedRouteToHotel),
      hospitals: shapeHospitalsForDoc(lastHospitals),
      hotelSpots: shapeHotelSpotsForDoc(cachedHotelSpots),
    };

    const res = await fetch('/api/document/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `計画書生成エラー: ${res.status}`);
    }
    await downloadBlobResponse(res, `keikakusho_${hotelName || 'hotel'}.docx`);
    setStatus('計画書をダウンロードしました。', true);
  } catch (err) {
    setStatus(err.message || '計画書の生成に失敗しました。');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '計画書を生成'; }
  }
}
