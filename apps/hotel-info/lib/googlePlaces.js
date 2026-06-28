const { withRetry } = require('./retry');
const { haversine } = require('./haversine');

const PLACES_BASE = 'https://places.googleapis.com/v1/places:searchNearby';
// Deliberately NOT requesting places.rating: it's "Enterprise" SKU tier
// (1,000 free calls/month), while everything below — accessibilityOptions,
// photos, primaryTypeDisplayName — is "Pro" tier or cheaper (5,000 free
// calls/month). Adding rating back would drop every call made through this
// shared helper (hospitals, dining, route stops, hotel-spots) to the
// stingier free tier just to show a star rating in a few list rows — not
// worth it. See docs/feature-roadmap.md for the cost breakdown. Backup of
// the pre-change version: backups/2026-06-19-pre-cost-optimization/.
const FIELD_MASK = 'places.id,places.displayName,places.formattedAddress,places.location,places.googleMapsUri,places.types,places.accessibilityOptions,places.photos,places.primaryTypeDisplayName';

// Opt-in fields — not in FIELD_MASK because they're at a costlier SKU tier
// or should only be fetched by the specific routes that need them. Each
// route that needs these passes them as `extraFields` to searchNearby(),
// which appends them to the base FIELD_MASK for that call only.
// Enterprise tier — only requested by /hotel-spots (for table/docx display):
const RATING_SUMMARY_FIELDS = 'places.rating,places.userRatingCount,places.editorialSummary';
// Contact Data SKU — only requested by /hospitals (phone shown in UI + docx):
const PHONE_FIELD = 'places.nationalPhoneNumber';
// Pro tier (same as FIELD_MASK), kept separate so it's only requested by
// /hotel-spots (the only route that does icon compositing):
const ICON_FIELD = 'places.iconMaskBaseUri';

// Places API (New) Nearby Search. `includedTypes`/`excludedTypes` use the
// New API's type table (e.g. 'hospital', 'restaurant', 'bar',
// 'japanese_izakaya_restaurant') — see place-types docs, not the legacy
// `type=` vocabulary. `extraFields`: optional comma-separated field mask
// additions (e.g. RATING_SUMMARY_FIELDS, PHONE_FIELD) — appended to
// FIELD_MASK for this call only so that non-opt-in routes stay on the
// cheaper free tier.
async function searchNearby(lat, lng, radius, { includedTypes, excludedTypes, maxResultCount = 20, extraFields } = {}, apiKey) {
  return withRetry(async () => {
    const body = {
      includedTypes,
      ...(excludedTypes ? { excludedTypes } : {}),
      maxResultCount,
      languageCode: 'ja',
      locationRestriction: { circle: { center: { latitude: lat, longitude: lng }, radius } },
    };
    const r = await fetch(PLACES_BASE, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': extraFields ? `${FIELD_MASK},${extraFields}` : FIELD_MASK,
      },
      body: JSON.stringify(body),
    });
    const json = await r.json();
    if (json.error) throw new Error(`Places API: ${json.error.status} ${json.error.message}`);
    return json.places || [];
  }, { attempts: 3, delayMs: 800 });
}

function shapePlace(place, originLat, originLng) {
  const lat = place.location?.latitude;
  const lng = place.location?.longitude;
  return {
    name: place.displayName?.text || '',
    address: place.formattedAddress || '',
    lat, lng,
    distance: (lat != null && lng != null) ? Math.round(haversine(originLat, originLng, lat, lng) * 100) / 100 : null,
    mapLink: place.googleMapsUri || '',
    // Wheelchair-accessible parking implies a parking lot exists, so true is
    // a reliable positive signal. false/missing just means Google hasn't
    // recorded this attribute for the place — not confirmation there's no
    // parking — so callers should only assert the positive case in the UI.
    hasParkingLot: place.accessibilityOptions?.wheelchairAccessibleParking ?? null,
    // A category label (e.g. "コンビニエンスストア"), not a written
    // description — see docs/feature-roadmap.md for why (the real editorial
    // description field is a much pricier SKU tier).
    description: place.primaryTypeDisplayName?.text || null,
    // Resource name for /api/poi/photo, e.g. "places/ABC123/photos/XYZ789".
    // null when the place has no photo. This is just a free reference —
    // fetching the actual image is a separate, real per-photo cost, so
    // callers should only request it lazily, not for every place shown.
    photoRef: place.photos?.[0]?.name || null,
    // Only present when RATING_SUMMARY_FIELDS passed as extraFields:
    rating: place.rating ?? null,
    userRatingCount: place.userRatingCount ?? null,
    editorialSummary: place.editorialSummary?.text ?? null,
    // Only present when PHONE_FIELD passed as extraFields:
    phone: place.nationalPhoneNumber ?? null,
    // Only present when ICON_FIELD passed as extraFields:
    iconMaskBaseUri: place.iconMaskBaseUri ?? null,
  };
}

const PLACES_TEXT_SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';

// Field mask for searchText is INTENTIONALLY different (and pricier) than
// FIELD_MASK above. places.id/displayName/formattedAddress/location/types are
// Pro tier (5,000 free calls/month, same tier as searchNearby elsewhere in
// this file). places.nationalPhoneNumber is Contact Data SKU — billed
// ADDITIONALLY on top of the base Text Search Pro call, not a substitute for
// it (Google's billing docs: Data SKUs always stack on top of the base SKU
// for the triggering request). So every /hotel-lookup call is effectively
// two billable line items. Accepted here because this is a low-frequency,
// user-initiated lookup (once per hotel-info session, only when the user
// omits the address), not a per-result-row call like searchNearby's callers.
const TEXT_SEARCH_FIELD_MASK = 'places.id,places.displayName,places.formattedAddress,places.location,places.nationalPhoneNumber,places.types';

// Places API (New) Text Search — finds a place by free-text name, optionally
// biased toward a location. Used for "I only know the hotel's name" lookup;
// searchNearby (above) can't do this since it requires a type filter, not a
// free-text query. locationBias (not locationRestriction) is deliberate: a
// same-name hotel-chain branch a few hundred meters outside an arbitrary
// radius should still be allowed to surface as a strong text match — bias
// only nudges ranking, restriction would hard-exclude it.
async function searchText(textQuery, { lat, lng, radius } = {}, apiKey) {
  return withRetry(async () => {
    const body = {
      textQuery,
      languageCode: 'ja',
      ...(lat != null && lng != null
        ? { locationBias: { circle: { center: { latitude: lat, longitude: lng }, radius: radius || 50000 } } }
        : {}),
    };
    const r = await fetch(PLACES_TEXT_SEARCH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': TEXT_SEARCH_FIELD_MASK,
      },
      body: JSON.stringify(body),
    });
    const json = await r.json();
    if (json.error) throw new Error(`Places API: ${json.error.status} ${json.error.message}`);
    // Text Search already ranks by relevance — taking only the top result is
    // a deliberate v1 scope cut, not an oversight. A picker UI for
    // disambiguating multiple same-name branches is a plausible future
    // enhancement (see docs/feature-roadmap.md) but out of scope here.
    return json.places?.[0] || null;
  }, { attempts: 3, delayMs: 800 });
}

module.exports = { FIELD_MASK, RATING_SUMMARY_FIELDS, PHONE_FIELD, ICON_FIELD, searchNearby, shapePlace, searchText };
