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

// Enterprise/Enterprise+Atmosphere-tier fields, deliberately kept out of the
// default FIELD_MASK above (would bump every Places call in this app —
// hospitals, dining, route stops — to a pricier tier just to show a rating
// in a few 周辺スポット rows). Passed via searchNearby()'s `extraFields` option
// only by routes/poi.js's /hotel-spots lookup, which is already an opt-in,
// once-per-hotel call, so the cost exposure is scoped to that one route.
// Live-tested 2026-06-21 against real Tokyo restaurants: rating/
// userRatingCount populated for every place; editorialSummary populated for
// ~2/3 of restaurant-type places, blank for non-dining types (e.g. a
// department store) — expected, not a bug.
const RATING_SUMMARY_FIELDS = 'places.rating,places.userRatingCount,places.editorialSummary';

// Same extraFields mechanism, separate constant since phone number's
// billing tier wasn't directly confirmed (only that the live call succeeds
// and returns correct data) — kept isolated from RATING_SUMMARY_FIELDS and
// out of the default FIELD_MASK rather than assumed free. Passed only by
// routes/poi.js's /hospitals lookup (round 3, 2026-06-21) — live-tested
// against real Tokyo hospitals, e.g. 03-3588-1111 for 虎の門病院, confirmed
// correct against independently-sourced data.
const PHONE_FIELD = 'places.nationalPhoneNumber';

// Same extraFields mechanism. Live-tested 2026-06-22 against real Tokyo
// places: populated for every category (コンビニ/スーパー/レストラン/居酒屋/バー/
// 観光スポット all returned a distinct icon URI, e.g.
// ".../icons/v2/restaurant_pinlet" — izakaya shares the restaurant icon,
// Google has no distinct izakaya glyph). Per Google's documented SKU field
// groupings this is "Place Basic Data", same Pro-tier bracket as
// primaryTypeDisplayName/photos already in the default FIELD_MASK above —
// not confirmed via Cloud Console billing, so kept scoped via extraFields
// rather than folded into the always-on default mask. Only `iconMaskBaseUri`
// is requested, not `iconBackgroundColor` — the app draws its own
// per-category circle color (HOTEL_SPOT_COLOR_HEX in routes/documentGen.js)
// so every spot in a category stays visually consistent with that category's
// docx table shading; Google's per-place background color is unused.
const ICON_FIELD = 'places.iconMaskBaseUri';

// Places API (New) Nearby Search. `includedTypes`/`excludedTypes` use the
// New API's type table (e.g. 'hospital', 'restaurant', 'bar',
// 'japanese_izakaya_restaurant') — see place-types docs, not the legacy
// `type=` vocabulary. `extraFields` appends to the field mask for this call
// only (e.g. RATING_SUMMARY_FIELDS) — see that constant's comment for why
// this isn't just always-on.
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
    // Only populated when the caller passed RATING_SUMMARY_FIELDS as
    // extraFields above — null otherwise, not a sign of a missing rating.
    rating: place.rating ?? null,
    userRatingCount: place.userRatingCount ?? null,
    // A real written description (e.g. "調理台に面したカウンター席を備える…"),
    // unlike `description` above which is just a category label. Often null
    // even when requested — Google doesn't generate one for every place.
    editorialSummary: place.editorialSummary?.text || null,
    // Only populated when the caller passed PHONE_FIELD as extraFields.
    phone: place.nationalPhoneNumber || null,
    // Base URI for a per-place-type icon glyph (append .svg or .png to
    // fetch the actual asset — a small black silhouette on a transparent
    // background, no color/background baked in). Only populated when the
    // caller passed ICON_FIELD as extraFields.
    iconMaskBaseUri: place.iconMaskBaseUri || null,
  };
}

module.exports = { searchNearby, shapePlace, RATING_SUMMARY_FIELDS, PHONE_FIELD, ICON_FIELD };
