# Feature Roadmap

Planned expansion of the hotel-finder app beyond the current price-search
feature. Each phase below should land as its own isolated backend module
(`routes/*.js`) plus a matching frontend module (`public/js/*.js`), so a bug
in one feature can't break another, and each backend route can be tested
directly (e.g. via `Invoke-RestMethod`/`curl`) without the browser.

## Architecture

- New features call **backend Express route modules** (not Google APIs
  directly from the browser) — mirrors the existing `/api/liteapi-hotels`
  proxy pattern. The Maps JS client-side key stays only for rendering the
  map/markers/polylines in the browser.
- Shared helpers live in `lib/` (e.g. `haversine.js`, `retry.js`,
  `googlePlaces.js`) so new modules don't duplicate logic.
- The company's starting address is **fixed by default** (stored as an env
  var, exposed via `/api/config` to pre-fill a field) but stays **editable**
  per search — covers the rare case where the team travels by airplane,
  ship, or shinkansen and the real starting point is an airport/port/station
  instead of the office.

## Phases

0. **Foundational refactor** — split `server.js` into `routes/` + `lib/`
   modules before adding anything new. No behavior change; existing search
   flow must work identically afterward.
1. **Hospitals near 現場 + dining (restaurant/izakaya/bar) near hotel** —
   `routes/poi.js`, reuses the existing Places Nearby Search pattern
   (`getNearbyAmenities()` in `public/index.html`). Extended later (see
   Phase 2 below) with `GET /api/poi/hotel-spots` — convenience
   stores/supermarkets/restaurants/izakaya/bars/tourist spots around a
   *selected* hotel, shown in a tabbed "周辺スポット" panel, on-demand per
   hotel. **Thumbnails + category labels added 2026-06-19.**
   `lib/googlePlaces.js`'s `shapePlace()` now also returns `description`
   (Google's `primaryTypeDisplayName`, e.g. "コンビニエンスストア" — a category
   label, not a written description; the real `editorialSummary` field was
   rejected since it's billed at the priciest "Enterprise + Atmosphere" SKU
   tier, vs. free here) and `photoRef` (a `places/.../photos/...` resource
   name, free to fetch as a reference, but `null` when a place has no
   photo). Actually fetching a photo's image bytes is a separate, real
   per-photo charge, so `routes/poi.js`'s new `GET /api/poi/photo?name=&
   maxWidthPx=` proxy (validates `name` against `^places/[^/]+/photos/[^/]+$`
   before forwarding — this route forwards to an external URL, unlike the
   coordinate-only routes here) is only ever called lazily: `public/js/
   poi.js`'s `renderHotelSpotsPanel()` renders all 6 tabs as text-only
   first, and injects `<img>` thumbnails for a category only the first time
   its tab is actually clicked (tracked via a `loadedThumbCategories` `Set`
   scoped to that panel's render) — avoids paying for up to ~60 thumbnails
   per "周辺スポット" click when the user only ever looks at 1-2 tabs.

   **Cost-optimization pass, 2026-06-19.** A search's *automatic* Places
   (New) usage (hospitals + the per-hotel dining lookup below) was found to
   spend 32 calls/search at the "Enterprise" SKU tier — only 1,000 free
   calls/month — meaning the free tier ran out after ~31 searches *before*
   touching any opt-in feature. Three changes, in order of impact:
   - `lib/googlePlaces.js`'s shared field mask no longer requests
     `places.rating` (Enterprise tier). Everything else it requests
     (`accessibilityOptions`, `photos`, `primaryTypeDisplayName`) is "Pro"
     tier or cheaper (5,000 free calls/month) — dropping `rating` moves
     every Places (New) call in this app to that bigger free tier. Cost:
     no more ⭐ rating shown in hospital/dining-stop/route-stop/hotel-spot
     lists (the hotel's own rating in the main results table is a separate,
     legacy-API field, unaffected).
   - The per-hotel dining lookup (restaurants/izakaya/bars, used for
     AI-recommendation scoring) moved from the backend's Places (New)
     `/api/poi/dining` (removed) to the same *legacy* client-side
     `nearbySearch` already used right next to it for convenience
     stores/supermarkets/parking — this was 30 of the 32 automatic
     Enterprise-tier calls per search. Legacy Places has no dedicated
     "izakaya" type, so `getNearbyAmenities()` now detects it via a
     name-keyword check (居酒屋/酒場/izakaya) on `restaurant`-type results,
     the same kind of heuristic already used for hospital-name matching
     above — less precise than the New API's exact type filter, but free.
   - The per-search amenity-scoring loop in `runSearch()` was halved from
     top-10 hotels to top-5 (`AMENITY_HOTEL_COUNT`), halving whatever
     automatic cost remains. Hotels ranked 6+ still appear in results, just
     without an amenity-based score bonus or amenity counts.

   Pre-change versions of all 4 touched files are saved in
   `backups/2026-06-19-pre-cost-optimization/` (not part of the running
   app) in case any of this needs revisiting.

   **Amenity loop restructured again, 2026-06-19 (same day).** The legacy
   migration above turned the dining lookup into separate per-type legacy
   calls (5 types × top-5 hotels = 25 calls/search), which became the
   dominant remaining automatic cost (~85% of it) once `rating` was dropped.
   Fix: `routes/poi.js`'s new `GET /api/poi/amenity-counts?lat&lng&radius`
   combines all 6 types (`convenience_store`, `restaurant`,
   `japanese_izakaya_restaurant`, `bar`, `supermarket`, `parking`) into 3
   Places (New) calls per hotel instead of 6 separate ones (the
   "multiple types, one call" trick used for route stops), and returns
   **counts only** (no name/address/photo/etc.), since every caller here
   (`calculateHotelScore` and friends in `public/index.html`) only ever uses
   these as numbers. 15 calls/search instead of 25. This also restores exact
   izakaya detection (the precise `japanese_izakaya_restaurant` type, since
   it's back on Places (New)) instead of the name-keyword heuristic from the
   legacy-migration pass.

   **3 calls, not 1 — found by live testing, not guessed.** An all-6-types-
   in-1-call version was tried first (5 calls/search), sharing one 20-result
   cap across every type. Live-tested against a real dense area (Shinjuku),
   it returned **zero** for convenience stores, supermarkets, *and* parking
   — restaurants/izakaya/bars alone filled all 20 slots, even though 20+
   convenience stores genuinely existed in range. Grouping convenience
   stores with supermarket+parking (2 calls/search worth) still zeroed out
   supermarkets — conbini density in Japan is high enough to fill a 20-cap
   on its own. The shipped version gives convenience stores their own call;
   supermarket+parking still share one (parking alone nearly filled it in
   the same test, undercounting supermarkets — 1 found vs. 3 actual — but
   not zeroing them, judged acceptable; a 4th call would fix this fully at
   20/search). All 6 types also now share one radius (default 400m, was
   200–500m tuned per type) instead of each having its own. `public/
   index.html`'s `getNearbyAmenities()` wraps this endpoint (plus a cache,
   see below); `amenities.dining.{restaurants,
   izakaya,bars}.length` access patterns (`calculateDiningScore`, the
   AI-recommendation card template) were flattened to plain
   `amenities.{restaurants,izakaya,bars}` numbers throughout, since the
   nested array wrapper no longer exists. Backups in
   `backups/2026-06-19-amenity-loop-optimization/`.

   **`maxHotels` capped at 5 + amenity-hotel-count made user-adjustable,
   2026-06-19 (same day).** `#maxHotels`'s cap dropped from 10 → 5 (input
   `max` + the matching JS clamp in `runSearch()`) — shrinks legacy Place
   Details calls (≤10 → ≤5) and Distance Matrix elements (~10 → ~5), a
   smaller saving than the amenity-loop work above. This one was **not**
   free of a trade-off, though it looked like it at first — see the bug
   fix immediately below.

   **Bug found via real usage, same day: budget filtering was starving the
   results at low `maxHotels`.** `runSearch()` always sliced
   `businessHotels` down to `maxHotels` *before* any price was known
   (`let limitedHotels = businessHotels.slice(0, maxHotels)`), then applied
   `isWithinBudget()` only at the very end, after the expensive per-hotel
   work. This pre-existing design was relatively harmless when `maxHotels`
   defaulted to 30 (plenty of candidates survived budget filtering either
   way) but became a real problem once it dropped to 5: reported live
   symptom — searching 東京駅, 10km radius, ¥50,000 budget returned only 2
   results. Root cause confirmed via `/api/liteapi-hotels`: of the first 5
   "business hotels" Google returns near Tokyo Station (ranked by
   prominence, not price), 4 are ¥55,000–120,000 upscale chains — only 1
   was actually under budget. A wider check (top 20 candidates) found 11
   hotels under ¥50,000 that the old code never even considered, because
   they were sliced away before any price check happened.

   Fix (first pass): when `maxBudget > 0` (or `excludeNoPrice` is on),
   `runSearch()` pulled a wider early candidate pool (`Math.max(maxHotels *
   4, 20)`) and ran the existing cheap LiteAPI price pre-check against
   *that* pool, filtering by budget there before narrowing to `maxHotels`.

   **Widened further, same day, to the full candidate pool — no radius
   expansion.** The user asked the system to keep checking candidates
   *within the radius they chose* until either `maxHotels` qualify or it's
   certain nothing more is available, explicitly *not* by auto-expanding
   the radius (that stays a deliberate, manual choice for the next search).
   This didn't need actual looping/retries: `businessHotels` already comes
   from one `nearbySearch` call that already paginates up to Google's own
   hard cap of 60 results for that radius (a real platform limit, not a
   choice this app makes — there's nothing more available from Google
   without a fundamentally different multi-tile search strategy, out of
   scope here), and LiteAPI's rates endpoint already accepts a *batch* of
   hotel IDs in one request. So the 20-candidate cap was simply removed —
   the price pre-check now runs against *all* of `businessHotels` in one
   LiteAPI batch call, meaning "qualifying count < maxHotels" now genuinely
   means "this is everything available in this radius," not "we stopped
   checking early." The final status message says so explicitly
   (`qualifyingCount` tracked through `runSearch()`) instead of silently
   showing fewer rows than `maxHotels` implies. Still costs nothing extra
   in Google API terms — same one LiteAPI call, just larger; the per-hotel
   Place Details/Distance Matrix/amenity-counts calls still only run for
   the `maxHotels` that end up qualifying. Backups in
   `backups/2026-06-19-amenity-count-reduction/` (first pass) and
   `backups/2026-06-19-full-candidate-pool/` (this pass).

   The amenity-evaluation count (how many of the top hotels get
   `/api/poi/amenity-counts` called for them) was a hardcoded
   `AMENITY_HOTEL_COUNT = 5` — now a form field, `#amenityHotelCount`,
   defaulting to **3** instead (further cost cut: 3-hotel default means
   amenity-counts costs 9 calls/search instead of 15 at the old default of
   5), but user-raisable per search. This number is a real trade-off, not
   just a cost dial: 4 of the AI-recommendation panel's 8 category tabs
   (コンビニ/スーパー/グルメ/駐車場) score *purely* from amenity data — a
   hotel with none scores exactly 0 on those factors
   (`calculateConvenienceScore`/`calculateParkingScore`, both gated behind
   `if (hotel.amenities)` with no fallback) — so at the default of 3, those
   4 tabs' "top 3" *is* the full evaluated pool (no real selection
   happening, just reordering); raising the field trades cost for genuine
   recommendation diversity in those tabs. Documented in the field's
   tooltip and in `runSearch()`'s comment, not just here.

   Also added: a session-level cache in `getNearbyAmenities()`
   (`amenityCountsCache`, a `Map` keyed by coordinates rounded to 5
   decimals, reset on page reload) so re-running a search that covers the
   same hotels — common while iterating on unrelated UI during testing —
   doesn't re-pay for amenity data already fetched this session. Doesn't
   reduce the cost of any hotel's *first* lookup. Backups in
   `backups/2026-06-19-amenity-count-reduction/`.

   (The `/api/poi/photo` proxy mentioned above also can't be skipped in
   favor of a direct `<img src>` to Google's Photo Media endpoint, since
   that URL requires the API key as a query param and would leak it to the
   browser.)
2. **Routes + stops** (company→現場, 現場→hotel) — **DONE 2026-06-18, revised
   same day for API cost efficiency + two more features.** First use of
   Google's **Routes API** in this app (`routes.googleapis.com/directions/v2:
   computeRoutes`, POST-based, field masks — the legacy Directions API was
   moved to Legacy status in March 2025 and can't be newly enabled, so
   Routes API is the only viable option, not a preference).

   **API cost shape (why the design below looks the way it does):** this
   app's Places calls (`lib/googlePlaces.js`) request `rating`, which bills
   at Google's "Enterprise" SKU tier — only **1,000 free calls/month**, vs.
   10,000/month for the cheaper "Essentials" tier that plain `computeRoutes`
   falls under. The app is in a heavy-testing phase, so anything that
   auto-fires Places calls on every search is expensive in practice. Design
   response: every route leg lookup is split into a cheap part (distance/
   duration/map line — 1 Routes API call, Essentials tier) and an opt-in
   expensive part (gas station/convenience store search along the leg —
   up to 8 Places calls, Enterprise tier), gated behind its own button.

   **Backend:** `routes/routePlanning.js` exposes one generic endpoint,
   `GET /api/routes/leg?fromLat&fromLng&toLat&toLng&includeStops=true|false`,
   computing a single point-to-point route (no `intermediates` — replaced
   the earlier 3-point-with-intermediate design now that the two legs are
   shown independently, see below). `includeStops` (default false) gates
   `findStopsAlongLegPoints` — `lib/polyline.js` decodes the polyline,
   `samplePoints()` picks a point every ~5km (capped at 8/leg), and each
   sample does one combined `searchNearby` call for `gas_station` +
   `convenience_store` (Places API (New) matches *any* of multiple
   `includedTypes`, halving the call count vs. one type per call).

   **Frontend — two independent windows, not one combined view:**
   `public/js/routePlanning.js`'s `fetchRouteLeg()`/`renderLegPanel()`/
   `renderLegMap()` are leg-agnostic (one `Map` registry keyed by element id
   so each window keeps its own map instance) and used by both:
   - **Window 1** (`#startToWorksitePanelWrap`, "出発地 → 現場"): loaded
     automatically by `loadStartToWorksiteRoute()` right after `runSearch()`
     resolves 現場's coordinates — independent of any hotel selection, since
     this leg doesn't involve a hotel at all. Cheap call only; a "沿道の
     ガソリンスタンド・コンビニを検索" button triggers the opt-in stop search.
   - **Window 2** (`#routePanelWrap`, "現場 → ホテル"): loaded by
     `planRouteForHotel(idx)` on the existing "ルート確認" button per hotel
     row, same cheap-then-opt-in-stops pattern. No longer needs the company
     address at all (it's not part of this leg).

   The company address (`COMPANY_ADDRESS` in `.env`, pre-filled via
   `/api/config`) is window 1's default start point, shown only as a remark
   by default — `#useCustomStartPoint` toggles a hidden `#companyAddress`
   field for the airport/port/station case. Whichever address is in play
   gets geocoded client-side via `ensureCompanyLocation()` and cached until
   it changes.

   **Parking signal for route convenience stores:** `lib/googlePlaces.js`'s
   shared field mask includes `places.accessibilityOptions`, and
   `shapePlace()` surfaces `hasParkingLot` from
   `accessibilityOptions.wheelchairAccessibleParking`. This costs nothing
   extra to add — `accessibilityOptions` is "Pro" tier (and, since
   2026-06-19, so is everything else this app's shared field mask requests —
   `rating` was dropped, see below).
   The official dedicated field for this (`parkingOptions`) was rejected:
   it's "Enterprise + Atmosphere" tier, a real cost increase, for a field
   that (per live Google Maps UI testing) is often unpopulated for small
   stores anyway. `wheelchairAccessibleParking` is a *positive-only* signal
   — true reliably means a lot exists; false/missing means unknown, not
   "no parking" — so the UI (🅿️ badge in the stop list, distinct marker
   color on the leg map) only ever asserts the positive case.

   Verified live against real Tokyo-area coordinates: correct leg
   distances/durations, real gas station/convenience store results, and
   `hasParkingLot` populated without the Places call erroring.

   **Further restrictions, 2026-06-19** (backups in
   `backups/2026-06-19-route-stop-restrictions/`): `GET /api/routes/leg` got
   3 new optional query params — `stopTypes` (restrict which place types are
   searched), `stopMode` (`route` = sample the whole polyline, the original
   behavior, up to 8 calls; `destination` = one call near just the `to`
   point), and `stopLimit` (trim each category to the N closest). Window 1
   (出発地→現場) now calls with `stopTypes=convenience_store,
   stopMode=destination, stopLimit=2` — only the 2 closest convenience
   stores *to 現場 itself*, no gas stations — since for this leg "what's
   near the worksite" matters more than "anywhere along a potentially long
   drive from the office", and it's 1 Places call instead of up to 8. Window
   2 (現場→hotel) is unchanged (both types, sampled along the whole route)
   since it wasn't asked to be restricted the same way. `maxHotels` in
   `public/index.html` is also now hard-capped at 10 (was up to 60) — this
   directly bounds the legacy Place Details calls made per search (one per
   hotel kept), one of the two largest remaining automatic Places costs
   alongside the amenity-scoring loop (see Phase 1's cost-optimization
   note above).
3. **Map image capture** — `routes/staticMap.js`, builds a Google Static
   Maps image (markers + polyline) server-side.
4. **計画書 (planning document) automation** — **DONE 2026-06-18, fixed
   2026-06-21.** `routes/documentGen.js` builds a `.docx` (worksite location,
   both route legs with maps, hotel contact info, 周辺スポット, nearby
   hospitals) from data the frontend already fetched this session — verified
   working end-to-end multiple times since.

   **Known gap: the layout was never validated against real sample 計画書
   documents.** The original plan was to get 3-5 trimmed real examples from
   the user first to determine the template/output format — that never
   happened; the feature shipped with a reasonable inferred layout instead
   (headings per section, one map image per route leg, plain text lists for
   hospitals/spots). If the actual format/readability doesn't match what's
   actually used in practice, this is the open thread to revisit, not a new
   feature — see 2026-06-21 session notes.

   **`PayloadTooLargeError` bug, fixed 2026-06-21:** `public/js/
   documentGen.js` was sending each route leg's *full* decoded polyline
   (hundreds-to-thousands of `{lat,lng}` points) in the POST body, even
   though `lib/staticMap.js`'s `fetchStaticMapImage()` only ever uses ≤100 of
   them (`MAX_PATH_POINTS`) to draw the route line on the static map image —
   long/winding routes pushed the JSON body past Express's 100kb default
   limit. Fixed two ways: `shapeLegForDoc()` now thins each leg's path to
   ≤100 points client-side before sending (`thinPath`/`MAX_DOC_PATH_POINTS`,
   matching the server's own cap), and `server.js`'s `express.json()` limit
   was raised to `1mb` as defense-in-depth. Verified with a synthetic
   227KB pre-fix-sized payload — no error, valid `.docx` returned with all
   embedded map images intact.

   **Section-by-section format pass started 2026-06-21** (the user is
   walking through `routes/documentGen.js`'s layout with real-world feedback
   instead of guessing — see "Known gap" above):
   - **宿 section** — spec gathered, not yet implemented: hotel name on its
     own line; address+phone joined on one line by a full-width space
     (currently separate lines); price as `1泊◯◯◯円` (currently the raw
     number); a red, possibly multi-line `※` remark block (e.g. who's
     staying where) — none of this exists in the code yet.
   - **周辺スポット section — implemented and live-tested 2026-06-21.**
     Addressed unreadability complaints (map pin colors had no legend, no
     way to tell which pin was which list item, no photos/ratings/
     descriptions):
     - **Color legend** — `documentGen.js`'s `spotLegendParagraphs()`, maps
       `HOTEL_SPOT_COLORS` to Japanese color names (`COLOR_LABELS_JA`), free.
     - **Numbered pins matching the list** — `assignSpotLabels()` assigns
       each mappable spot a single Static-Maps-legal label (digits 1-9 then
       A-Z, skipping `0`/`H` — `H` is reserved for the hotel's own pin),
       walking categories in the same order/slice `buildHotelSpotMarkers()`
       and `hotelSpotLines()` use so map and list numbers always match.
       Required raising `lib/staticMap.js`'s `MAX_MARKERS` from 15 to 20 (1
       hotel + up to 18 spots) — live-tested first: a worst-case 19-marker
       URL is ~1.2KB, nowhere near Google's ~8192-char limit, and a real
       fetch returned a valid image. Free, same one map call as before.
     - **Ratings** — `lib/googlePlaces.js`'s `searchNearby()` gained an
       `extraFields` option and a `RATING_SUMMARY_FIELDS` constant
       (`rating`, `userRatingCount`, `editorialSummary` — Enterprise/
       Enterprise+Atmosphere tier), passed only by `routes/poi.js`'s
       `/hotel-spots` route so the automatic hospital/dining/route-stop
       calls stay on the cheap tier. Since `/hotel-spots` was already
       opt-in/once-per-hotel, the added cost is scoped to that one route.
       Live-tested against real Tokyo restaurants: rating populated for
       every place tested (e.g. 4.4★/5,231 reviews).
     - **Written descriptions** — same `editorialSummary` field as above,
       real prose (e.g. "調理台に面したカウンター席を備えるコンパクトな店内で
       海鮮丼やウニが味わえる。"), not the `description` category-label field
       that already existed. Populated for roughly 1/3 to 1/2 of spots in
       live testing, blank for the rest (not a bug — Google doesn't
       generate one for every place). **Caveat found during testing: some
       editorialSummary text comes back in English even with
       `languageCode: 'ja'` requested** (a Google data quirk, e.g. "Pit stop
       for snacks, drinks & daily essentials") — not fixed, just noted; revisit
       if it turns out to be common enough to need filtering/translation.
     - **Photos** — capped to 1 per category (6 max, not all ~18 listed
       spots) via `pickLeadPhotoSpots()` (picks the closest spot per
       category that has a `photoRef`), fetched server-side in
       `documentGen.js`'s `fetchSpotPhoto()` (separate, real per-photo
       Places charge, same as `routes/poi.js`'s `/photo` proxy). Embedded at
       their real aspect ratio via a small inline JPEG/PNG dimension reader
       (`readImageInfo()` — no `image-size` dependency added, matching this
       project's preference for native code over deps where practical),
       confirmed in testing across photos with aspect ratios from 0.75 to
       1.8 — none stretched.
     - **Investigated and explicitly dropped: "summary of reviews."**
       Google's `generativeSummary` field is valid (doesn't error) but came
       back empty for every test place, including ones with 5,000+ reviews —
       not reliable enough to build a feature around. The fallback (raw
       `reviews` text) also works but has real Places API usage
       restrictions on repurposing review content beyond as-is display with
       attribution, so it wasn't used either.
     - **Not available via Places API at all: menu highlights.** No
       structured menu field exists for typical small businesses; would need
       manual entry or a third-party source, out of scope here.
     - End-to-end verified: real `/api/poi/hotel-spots` data (Tokyo Station
       area) through `/api/document/generate` produced a valid `.docx` with
       the legend, correctly-skipped label sequence (`...9, A, B, ... G, I,
       J...`, no `H`), ratings/descriptions/photos all rendering, and 8
       embedded images (2 maps + 6 category photos) at correct, undistorted
       aspect ratios.
     - **Still needs porting to hotel-info**, per this repo's shared-file
       convention — `routes/documentGen.js` and `lib/staticMap.js` are
       byte-identical shared files (direct copy); `lib/googlePlaces.js` and
       `routes/poi.js` are intentionally-diverged files needing a manual
       merge of just the `RATING_SUMMARY_FIELDS`/`extraFields`/`shapePlace()`
       changes; `public/js/documentGen.js`'s `shapeHotelSpotsForDoc()` is one
       of the "identical shaping helpers" and should be ported as-is.
   - **Round 3 — implemented 2026-06-21, driven by a real example `.docx`**
     the user produced (3 sections: current app output, an adjusted mockup,
     and the mockup annotated with reasoning per change). Extracted via
     unzip (read-only) and cross-referenced raw XML (`w:shd`, `wp:extent`)
     for exact colors/sizes rather than guessing from a screenshot.
     - **Map language fixed app-wide**: `lib/staticMap.js`'s
       `buildStaticMapUrl()` never set a `language` param — every map this
       app has ever generated defaulted to English labels. Now always
       `language=ja`. Live-tested before/after near Ginza: English →
       fully Japanese street/business/station names.
     - **Enlarged maps**: `MAP_DISPLAY_WIDTH` (350px, up from round 1/2's
       300px half-scale) for 現場所在地/ルート/最寄病院 maps.
     - **現場所在地 photo**: `lib/staticMap.js`'s new
       `fetchStreetViewImage()` (separate endpoint/params from Static Maps —
       `location`/`size`/`fov`, no markers/zoom). Requires Street View
       Static API enabled in Cloud Console (the user did this mid-session;
       was previously blocked with `403 REQUEST_DENIED`). **Caveat found in
       testing**: Street View shows whatever panorama is nearest the given
       coordinates — for one test point this was an indoor "Business View"
       photo of a salon interior, not a street-level building exterior.
       Not a code bug, just inherent to Street View coverage; the app has
       no control over which panorama Google has nearest a given point.

       **Fixed 2026-06-22: Street View no longer used when 現場 was
       searched by name.** Real-world impact of the caveat above turned
       out worse than "occasionally an odd angle" — searching `東京タワー`
       produced a Street View photo unrelated to the tower at all (an
       indoor shot from a nearby building), confirmed live. Root cause:
       Street View was unconditionally used for every search, even though
       a named/address search already resolves to a real Google Place
       with its own real photos — Street View was only ever the right
       *fallback* for the raw-lat/lng-input case, where no place exists to
       photograph. Fix:
       - `public/index.html`'s `runSearch()` now captures `place_id` from
         the geocoder result (`originPlaceId`, new global) when 現場 was
         entered as a name/address — left `null` when entered as raw
         lat/lng, since the legacy `Geocoder` only returns a `place_id`
         when it actually resolved something nameable.
       - `public/js/documentGen.js`'s new `fetchWorksitePhotoUrl()` reuses
         the exact pattern already proven for `hotel.photoUrl`
         (`getDetails()` + `photos[0].getUrl()`) to fetch a real photo
         when `originPlaceId` is set, cached per-session like the other
         `hotelDocCache` fields. Sent as `worksite.photoUrl` in the
         `/api/document/generate` payload.
       - `routes/documentGen.js`'s new `fetchWorksitePhoto()` prefers
         `worksite.photoUrl` (downloaded via the existing
         `fetchImageFromUrl()`) and only falls back to
         `fetchStreetView()` when no `photoUrl` was sent — i.e. exactly
         the raw-lat/lng-input case, or the rare case where a resolved
         place has no photos at all. A real Places photo can be any
         aspect ratio (unlike Street View, always fetched at a fixed
         box), so it's embedded via the existing aspect-ratio-aware
         `photoParagraph()` instead of `mapImageParagraph()`'s fixed-box
         version.
       - Verified live both ways with real data: a `東京タワー` name search
         now embeds an actual photo of the tower (confirmed visually);
         feeding the same coordinates in as raw lat/lng still correctly
         falls back to Street View, unchanged from before (and still
         subject to the original caveat — that's expected, not a
         regression, since there's no place to fetch a photo for from
         bare coordinates).
     - **Hotel photo**: no new Places call — `public/index.html`'s existing
       `getDetails()` (already made per hotel) already computes a complete,
       key-included `photoUrl` via the legacy Photos API's `.getUrl()`,
       just wasn't being forwarded. Now sent through
       `/api/document/generate`'s payload and downloaded server-side via a
       plain `fetchImageFromUrl()`.
     - **周辺スポット rewritten as a `docx` `Table`**: category header rows
       (`columnSpan: 4`) shaded in that category's color — exact hex for 4
       of 6 categories recovered from the user's example
       (コンビニ `#00A933`, スーパー `#800080`, レストラン `#FF8000`,
       観光スポット `#813709`); 居酒屋 `#FFCC00`/バー `#808080` picked to match
       since the example only highlighted 4 of 6 (incomplete mockup, not an
       intentional exclusion). Replaces round 1's legend entirely (deleted,
       not just unused).
     - **周辺スポット photos: every listed spot in the 5 non-コンビニ
       categories** (up to 15/doc, confirmed via the example — none of its
       コンビニ items had a photo), not round 1's 1-per-category cap. Real
       added cost (~$0.007/photo, same Places Photo charge the live site
       already pays on tab-click — `public/js/poi.js`'s lazy thumbnail
       loading — just not deferrable in a static document), confirmed
       acceptable against the $200/month Maps Platform credit.
     - **周辺スポット maps: adaptive zoomed clustering**, replacing the single
       auto-fit overview map. `clusterSpotsForMaps()` greedily groups
       `orderedMappableSpots()` (the new single source of truth for spot
       ordering, also used by `assignSpotLabels()`) into groups of ≤5 within
       500m of a running centroid — one map if everything fits, several if
       not, per the user's explicit answer ("one map if it fits, several if
       it doesn't"). Zoom level (16) derived from Static Maps' meters/pixel
       formula for a 500m-radius framing, not eyeballed; live-tested 16-18
       near Ginza — street/business names legible at this range.
     - **最寄病院 rewritten**: now shows phone (`lib/googlePlaces.js`'s new
       `PHONE_FIELD`/`places.nationalPhoneNumber`, scoped via `extraFields`
       like `RATING_SUMMARY_FIELDS` rather than assumed free-tier — live-
       tested, e.g. `03-3588-1111` for 虎の門病院 exactly matched the user's
       own sample data) and a photo+zoomed-map side-by-side block (a
       borderless 2-column `Table`). The user's reference image for "map on
       the right hand side" turned out to be a screenshot of Google Maps'
       own website UI (place-info card composited by Google's product, not
       an API response) — confirmed not reproducible via any Maps Platform
       API; the side-by-side docx layout was agreed as the realistic
       equivalent (same information: photo, map, phone — different,
       achievable rendering).
     - **Real bug caught during testing**: `mapImageParagraph()` initially
       hardcoded `type: 'png'` for all Static-Maps-box images, but Street
       View Static API always returns JPEG (no format param exists for it).
       A real generated `.docx` had a mislabeled image until
       `readImageInfo()`'s type sniff was reused there too.
     - Verified end-to-end against real Ginza-area data (hotel-spots +
       hospitals): 33 embedded images, all 6 category colors correct, zero
       photos under コンビニ, hospital phone/photo/map all present and
       correctly paired, no stretched images.
     - **Not yet ported to hotel-info** — same shared-file split as round 2:
       `routes/documentGen.js`/`lib/staticMap.js` direct copy;
       `lib/googlePlaces.js`/`routes/poi.js` manual merge;
       `public/js/documentGen.js`'s shaping helpers ported as-is.
   - Other sections (現場所在地's address line, ルート legs beyond size,
     最寄病院 beyond round 3's changes) not separately revisited — round 3
     covered what the example showed.
   - **Round 4 — 宿 section implemented 2026-06-22.** Address+phone now join
     on one line via a full-width space (`routes/documentGen.js`'s
     `addressPhoneLine`, omits the join when address is blank rather than
     showing an empty line). Price now renders as `1泊◯◯◯円`
     (`formatHotelPriceForDoc()`): the LiteAPI-confirmed `actualPrice` when
     present, else the Google-estimated `priceMin`/`priceMax` range with a
     `（推定）` suffix — replaces the old `${hotel.price}` passthrough, which
     depended on a client-side `formatHotelPrice()` helper (removed from
     `public/js/documentGen.js`) that pre-formatted the live table's
     `¥…~/泊` style into the payload; the server now receives raw
     `actualPrice`/`priceMin`/`priceMax`/`priceEstimated` and formats them
     itself, since the printed-document format is intentionally different
     from the live table's. Added a new optional `#docRemark` textarea above
     the results table (applies to whichever hotel's 計画書 is generated
     next, not stored per-row) — its value is sent as `hotel.remark` and
     rendered via `remarkParagraphs()` as one red, ※-prefixed paragraph per
     non-empty line (docx per-run `color`, not CSS).

   **Round 5 — remark UI reverted 2026-06-22, same day.** The `#docRemark`
   textarea (and the payload's `hotel.remark` field) was removed at the
   user's request — they'd rather type the actual remark by hand directly
   into the generated `.docx` than fill in a web form field for it.
   `remarkParagraphs()` was replaced with `remarkPlaceholder()`: a single
   static red `※` paragraph always appended at the end of the 宿 section
   (no longer conditional on any input), giving the user a pre-styled line
   to click into and edit in Word.

## n8n

Evaluated, not adopted yet. If used later, the recommended role is
**post-processing automation** after a 計画書 is generated (e.g. notify a
Slack channel, save to shared storage) — not replacing the core interactive
Express modules, since those need fast synchronous request/response.

## UI changes (not tied to a specific phase)

- **Search form collapsed behind a 詳細検索 toggle, 2026-06-22.** Everything
  below the 住所/場所名 field except the 検索する button — custom start
  point, lat/lng, radius, 最大件数, 予算上限, 周辺施設を評価する件数,
  accommodation-type checkboxes, 価格情報がないホテルを除外する — is now
  wrapped in `#advancedSearchWrap` (`display:none` by default), revealed by
  a new `#toggleAdvancedSearch` checkbox ("詳細検索を表示"), same
  show/hide-on-checkbox pattern as `#useCustomStartPoint`. Pure UI: the
  wrapped inputs keep their existing default values and ids, so `runSearch()`
  reads them identically whether the section is shown or hidden.
- **`.xlsx` export removed, 2026-06-22.** The user no longer needed it —
  removed the `downloadBtn` button, `downloadXlsx()`, its `click` listener,
  and the `xlsx.full.min.js` `<script>` tag (the only thing that depended on
  it) from `public/index.html`. The `.docx` 計画書 generation
  (`routes/documentGen.js`) is unaffected — separate feature, separate
  format.

## Phase 5 (started)

- **Stage 1 — real category icons on the 周辺スポット map, implemented and
  live-tested 2026-06-22.** Per the Phase 5-8 planning notes
  (`C:\Users\Staff\.claude\plans\lets-clear-up-the-structured-fox.md`),
  replaced this map's plain colored Static Maps pins with real per-category
  icons via server-side compositing (not an LLM/generative-image approach —
  that risks geographic inaccuracy).

  **Icon sourcing, verified live before building anything**: Places API
  (New) does expose `iconMaskBaseUri` per place (live-tested across all 6
  周辺スポット categories near Tokyo Station/Shinjuku — every category
  returned a distinct icon, e.g. `restaurant_pinlet`, `convenience_pinlet`,
  `shoppingcart_pinlet`, `bar_pinlet`; izakaya shares the restaurant icon,
  Google has no distinct izakaya glyph). **Correction to the original plan's
  assumption**: the fetched asset (`{iconMaskBaseUri}.svg`/`.png`, both
  confirmed live) is not a full colored pin — it's a small solid-black
  glyph silhouette on a transparent background (no fill color or background
  shape baked in), meant to be recolored/composited by the caller. So no
  custom icon set needed to be sourced, but the original "just stamp
  Google's asset onto the map" idea became "draw our own colored circle,
  recolor Google's glyph to white, composite both."
  - `lib/googlePlaces.js`'s new `ICON_FIELD` (`places.iconMaskBaseUri`
    only, not `iconBackgroundColor`) is requested via the existing
    `extraFields` mechanism, scoped to `routes/poi.js`'s `/hotel-spots`
    route only (combined with `RATING_SUMMARY_FIELDS`) rather than added to
    the shared default `FIELD_MASK` — confirmed in this codebase to be the
    same "Place Basic Data"/Pro-tier bracket as `primaryTypeDisplayName`/
    `photos` per Google's documented SKU groupings, but not confirmed via
    Cloud Console billing, so kept contained to this already opt-in,
    once-per-hotel route rather than assumed free everywhere (same caution
    pattern as `PHONE_FIELD`). `shapePlace()` now also returns
    `iconMaskBaseUri`. `public/js/documentGen.js`'s `shapeHotelSpotsForDoc()`
    was updated to not strip the new field before it reaches
    `/api/document/generate`.
  - New `lib/mapIcons.js` (`compositeSpotIcons()`): converts each spot's
    lat/lng to a pixel position via the standard Web Mercator projection
    (new code — distinct from the meters-per-pixel formula already used
    elsewhere in this app to pick a zoom level), then composites a small
    assembled marker image — a colored circle in the app's own existing
    `HOTEL_SPOT_COLOR_HEX` (not Google's `iconBackgroundColor`, so every
    spot in a category stays visually consistent with that category's docx
    table shading), the white-recolored icon glyph (`sharp`'s
    `negate({alpha:false})`, exact fit since the source glyph is solid
    black on transparent), and the existing numbered label badge from
    `assignSpotLabels()` (redrawn ourselves since replacing the pin removes
    Static Maps' built-in label rendering) — onto the downloaded map image.
    Glyph fetches are cached in-memory per `iconMaskBaseUri` (a handful of
    icons repeat across ~18 spots/doc) and best-effort: a failed glyph
    fetch still leaves a colored, numbered circle rather than dropping the
    marker. Markers that would land outside the image bounds are skipped
    rather than erroring.
  - `routes/documentGen.js`: `clusterMapMarkers()` split into
    `clusterHotelMarker()` (the hotel's own red "H" pin, unchanged, stays a
    plain Static Maps marker — out of scope here) and `clusterIconMarkers()`
    (feeds `compositeSpotIcons()`). `orderedMappableSpots()` now also
    carries each spot's category `key` through to clusters, needed to look
    up its color.
  - New dependency: `sharp` (justified per the original research doc's own
    reasoning — pixel-level compositing isn't reasonably done by hand,
    weighed against this project's "native code over deps where practical"
    preference and accepted there).
  - **No added Google API cost** — same one Static Maps call per cluster
    map as before; the new Places field is free per the SKU-tier reasoning
    above, and the icon glyph assets are unbilled static files from
    `maps.gstatic.com`.
  - Verified end-to-end against real Tokyo Station-area data: generated a
    real `.docx`, unzipped it, and visually confirmed multiple spot maps
    show correctly-positioned colored circle pins (matching the existing
    category colors) with legible white category-icon glyphs (e.g. a
    shopping-cart icon precisely over a real supermarket's map location)
    and numbered badges, no overlap/clipping observed in the samples
    checked.

  **Readability refinement pass, same day (2026-06-22), based on real
  document feedback.** The first pass's markers were too small to read
  comfortably at actual document size. Four changes:
  - `lib/mapIcons.js`'s marker size constants
    (`ICON_SIZE_BASE`/`GLYPH_SIZE_BASE`/`LABEL_BADGE_BASE`) bumped ~60%
    (22/13/11 → 36/22/18).
  - `routes/documentGen.js`'s `ZOOMED_MAP_ZOOM` (16→17) and
    `SPOT_MAP_RADIUS_M` (500m→280m) tightened together so the closer-in
    view still fits the frame at the bigger marker size;
    `SPOT_MAP_CLUSTER_LIMIT` dropped 5→4 to reduce crowding — more map
    images per hotel when needed is an accepted trade-off, no structural
    change to `clusterSpotsForMaps()` was needed.
  - `HOTEL_SPOT_COLOR_HEX.bars`: gray (`808080`) → neon pink (`FF1493`) —
    gray blended into the base map and was hard to spot.
  - New `styles` option on `lib/staticMap.js`'s `buildStaticMapUrl()`
    (array of Static Maps `style=` rules, each appended as its own query
    param) — applied only to spot-cluster maps via a new
    `SPOT_MAP_STYLES` constant: desaturates+lightens the whole base map
    (`saturation:-65|lightness:15`) into a calmer pastel backdrop, and
    hides Google's own default POI icons (`feature:poi|
    element:labels.icon|visibility:off`) which otherwise visually compete
    with the composited markers (the first test render had a Google
    delivery-locker icon sitting right next to one of our pins). Scoped to
    spot-cluster maps only — every other map (現場/route/hospital)
    unaffected, same scope boundary as Stage 1 itself.
  - Verified by regenerating a real `.docx` against the same live data and
    inspecting cropped close-ups: markers visibly larger, base map clearly
    more muted with the colored pins standing out, and the bar category's
    vivid pink confirmed directly (pixel-color scan across all generated
    map images located it).

  **Icon distinction + marker overlap fix, same day (2026-06-22), based on
  real document feedback.** Two more issues from reviewing a real generated
  map:
  - **居酒屋 (izakaya) read as confusingly similar to other spots.** Root
    cause: Places API (New) has no distinct izakaya icon — izakaya results
    share レストラン's plain `restaurant_pinlet` glyph (confirmed live).
    Fix: `lib/mapIcons.js` gained a hand-drawn beer mug glyph
    (`beerMugGlyphSvg()`, inline SVG, white fill, no fetch/recolor needed)
    behind a new `customGlyph` marker field — chosen over sourcing a
    third-party icon image to avoid any licensing/attribution complexity,
    consistent with this app's "native code over deps where practical"
    preference. `routes/documentGen.js`'s `clusterIconMarkers()` passes
    `customGlyph: 'beerMug'` for izakaya spots specifically; every other
    category is unaffected, still using Google's `iconMaskBaseUri`.
  - **Some markers overlapped.** The previous readability pass's bigger
    markers + tighter zoom increased collision risk for spots clustered
    close together. `lib/mapIcons.js`'s `compositeSpotIcons()` was
    restructured into position → resolve → clamp → composite phases, with
    a new `resolveOverlaps()` helper: iterative pairwise circle-packing
    relaxation that nudges overlapping markers apart, and clamps (instead
    of dropping) any marker that would land outside the frame — positional
    precision is deliberately sacrificed for readability, per the user's
    explicit go-ahead. The hotel's own "H" marker was folded into the same
    system (previously a separate native Static Maps pin that couldn't
    participate in the overlap math) — it's now styled as a red circle
    matching every other marker, a deliberate side effect of unifying the
    collision system rather than a separate decision.
  - **A real bug found and fixed during this pass**: the first version of
    `resolveOverlaps()` collapsed to a no-op for near-coincident markers
    (e.g. a convenience store and supermarket in the same building) — when
    two centers are ~0px apart, `dx/dist` normalizes to 0, so the "push
    apart" vector was zero and they never separated. Fixed by falling back
    to a deterministic angle (derived from the pair's index) whenever
    `dist < 0.01`. Caught via a real live-data debug trace showing two
    markers stuck at the exact same `(591, 551)` pixel position even after
    the fix's first version — not visible from casual screenshot
    inspection alone, since one circle was simply hidden entirely behind
    its identical twin.
  - **Verification note**: live Places API results aren't perfectly
    stable call-to-call (ranking ties can reorder slightly), so the exact
    same cluster doesn't reliably reproduce between two live test runs —
    confirmed by comparing generated `.docx` files' embedded-image hashes
    directly. Final verification used a deterministic synthetic test (5
    markers including 3 forced near-coincident, fed directly into
    `compositeSpotIcons()` with a blank canvas) to confirm convergence:
    all pairs ended up within ~1px of the target spacing. Also caught one
    false positive worth noting for future debugging — a patch of muted
    green that looked like an overlapping marker in a screenshot turned
    out to be Google's own desaturated park/green-space base map tile
    (consistent with the readability pass's `saturation:-65|lightness:15`
    style), not a marker at all; confirmed by sampling its exact pixel
    color (`84,139,95`, nowhere near `00A933`, the real convenience-store
    hex).

  **Deferred to later stages, not built here**: cuisine-specific restaurant
  icons (ramen vs. Italian, etc. — separate open thread per the planning
  notes), 現場 map icons, hospital marker icons, and route-leg stop markers/
  icons (Stage 2/3), and porting this to `hotel-info` (Phase 8, after this
  stage stabilizes).

## Phase 6 (started)

- **Hospital phone number shown in the live UI, 2026-06-22.** The data was
  already fetched (`routes/poi.js`'s `/hospitals` already requests
  `PHONE_FIELD`) and already present in the shaped response
  (`shapePlace()` always returns `phone`) — just never rendered.
  `public/js/poi.js`'s `renderHospitalPanel()` now shows it inline (when
  present) alongside distance, before the 地図 link. Zero added Google API
  cost — pure UI fix.
- **Deferred, pending user feedback or a budget review:** 周辺スポット and
  route-stop phone numbers. Neither is fetched yet; adding `PHONE_FIELD` to
  those routes' Places calls would (for 周辺スポット) likely stay on the
  Enterprise tier already paid there, but (for route stops) would newly
  bump those currently-cheap-tier calls up a tier. See
  `C:\Users\Staff\.claude\plans\lets-clear-up-the-structured-fox.md` for
  the full Phase 5-8 direction-setting notes from this session.

## Phase 9 — Export to Google My Maps (KML), 2026-06-23

Second export format alongside the `.docx` 計画書, so the same searched
hotel's data can be opened as an interactive map. Numbered Phase 9 rather
than 7/8 since those are already reserved (UI/readability adjustments and
porting to `hotel-info`, respectively) in
`C:\Users\Staff\.claude\plans\lets-clear-up-the-structured-fox.md`, even
though neither has started yet.

- **New "My Mapsへ出力" button** next to the existing 計画書 button on each
  hotel row, downloads a `.kml` file. Google My Maps imports KML directly;
  each top-level `<Folder>` becomes a separate toggleable layer (capped at
  10 layers/map by My Maps itself) — this app emits 8: 宿泊・ルート (hotel +
  worksite + both route legs), 病院, and one per 周辺スポット category
  (コンビニ/スーパー/レストラン/居酒屋/バー/観光スポット). Empty categories
  still emit an empty folder, so the layer list stays consistent across
  exports.
- **Zero added Google API cost.** `routes/mapExport.js`'s `POST
  /api/map-export/kml` makes no `fetch()` calls at all — it's pure
  synchronous KML string-building (via `fast-xml-parser`'s `XMLBuilder`,
  already a dependency, previously unused anywhere) from the same payload
  shape `/api/document/generate` already accepts. The frontend's data-
  gathering (`public/js/documentGen.js`'s `buildDocPayload(idx)`, extracted
  from what used to be inline in `generateDocument()`) is shared between
  both export buttons, so it only ever fetches missing route-leg/spot data
  once per hotel per session, same as before this feature existed.
- **Styling**: color-tinted circle markers
  (`http://maps.google.com/mapfiles/kml/shapes/placemark_circle.png` +
  KML's `aabbggrr`-order `<IconStyle><color>`) reusing the exact category
  hex values already used on the `.docx`'s Static Map icon markers — moved
  into a new shared `lib/mapColors.js` (previously module-local constants
  inside `routes/documentGen.js`) so both outputs can't drift apart. Hospital
  placemarks get one new dedicated color (`008080` teal) since the existing
  scheme had none for hospitals. Matching the actual category icon glyphs
  (not just colors) was deliberately out of scope for v1 — KML's icon
  `href` needs a real fetchable URL, and this app has no public image host
  for the generated icon PNGs `lib/mapIcons.js` composites for the `.docx`;
  same staging choice this app already made for Phase 5 (colors/positions
  before glyphs).
- **Verified**: `Invoke-RestMethod` against the new endpoint with a
  hand-built sample body (no live Google calls needed) — confirmed exactly
  8 `<Folder>` elements, `lng,lat,0` coordinate order (KML's convention,
  opposite of this app's `{lat,lng}` used everywhere else — handled by one
  `toKmlCoord()` helper in `routes/mapExport.js`), correct `aabbggrr` color
  conversion (`lib/kmlColor.js`'s `rgbHexToKmlColor()`), and that
  `XMLBuilder` auto-escapes XML special characters (`&`/`<`/`>`) in
  name/address text. The `lib/mapColors.js` extraction was verified as a
  pure refactor by diffing the old inline hex values against the new
  module's values (byte-identical) rather than re-running a live `.docx`
  generation, to avoid an unnecessary Static Maps/Street View call.
- **Icon upgrade, same session.** Plain color-tinted circles replaced with
  real category icon shapes (e.g. `dining.png` for レストラン, `lodging.png`
  for the hotel) from Google's permanently-hosted KML shapes library
  (`https://maps.google.com/mapfiles/kml/shapes/*.png` — same URL family as
  the circle icon, verified live before use). Considered self-hosting the
  exact `lib/mapIcons.js`-composited icons instead (closer visual match,
  including izakaya's custom beer-mug glyph), but the user explicitly
  rejected it: those icon links would only work while this app's own server
  is running, which isn't acceptable for a file meant to be reopened later.
  Google's hosted icons keep the export fully portable at the cost of not
  matching izakaya's custom glyph (reuses レストラン's dining.png instead,
  mirroring this app's own existing Places-icon precedent) and not having an
  exact "bar" icon (`snack_bar.png` used instead, closest available). Zero
  new Google API calls or field-mask changes — pure URL swap in
  `routes/mapExport.js`.
- **Fix pass after a real live import test, same session.** The user's
  first live test surfaced real problems: the 宿泊・ルート folder also holds
  現場 but didn't say so in its name (renamed to 宿泊・現場・ルート); 現場's
  intended blue rendered as white and was hard to see (changed to a
  KML-only Crimson, `DC143C` — `lib/mapColors.js`'s blue stays unchanged for
  the `.docx`); and every category's color came out wrong, though distinct
  per category. That last symptom ("distinct but wrong") points at Google My
  Maps silently snapping arbitrary KML `<color>` values to its own
  undocumented internal preset palette on import — confirmed via research
  (a community reverse-engineering project, `TheStalwart/google-mymaps-
  icons`, documents that My Maps' editor uses fixed internal palettes, e.g.
  ~30 colors for "Shapes"-style icons, not arbitrary RGB) but the actual
  palette values aren't publicly available (only extractable by a user
  running DevTools against a live My Maps session — not done). As a
  best-effort fix, swapped the hand-picked hex values for well-known CSS
  named-color equivalents in `routes/mapExport.js` only (`lib/mapColors.js`
  unchanged), on the theory they're more likely to land near whatever
  internal palette My Maps actually uses. Not guaranteed exact — flagged to
  the user as something to converge on empirically via further live tests,
  or solve exactly later via DevTools palette extraction if worth the
  effort. Also fixed: 居酒屋 and レストラン looked identical (both shared
  `dining.png`) — no beer/wine/alcohol icon exists anywhere in Google's
  shapes library (checked `beer.png`/`wine.png`/`bar_alt.png`/
  `nightlife.png`, all 404, ruled out without self-hosting), so 居酒屋 was
  re-paired with バー's `snack_bar.png` instead (both are drinking
  establishments — arguably the more sensible pairing anyway), staying
  distinguishable from バー by color alone. Self-hosting was raised again as
  the one approach that would fix all of this exactly (reusing
  `lib/mapIcons.js`'s real composited icons, including a real beer-mug
  glyph) but the user re-confirmed they want to stay fully portable, so
  this fix works within Google's hosted icon set only.
- **Round 3, same session**: the live test after round 2 surfaced two more
  problems. First, 居酒屋/バー now collided on `snack_bar.png` (round 2 fixed
  the レストラン collision but created this one) — fixed by giving 居酒屋
  `coffee.png` instead, the last available "beverage-ish" icon once
  `dining.png`/`snack_bar.png` were claimed; all 9 markers now confirmed
  programmatically distinct (not just eyeballed, which is how the round-2
  collision slipped through). Second, round 2's "best-effort CSS named
  colors" guess didn't work either — the user's report showed only pure
  `FF0000` rendered correctly, every named color (Crimson/Teal/ForestGreen/
  DarkOrange/Gold/DeepPink/SaddleBrown) came out wrong, several wildly
  off-hue (Teal→dark red, Brown→purple). Two guesses in a row failing means
  guessing a third time isn't a sound strategy — the user chose instead to
  extract My Maps' actual internal color palette via browser DevTools (the
  only way to get ground truth, since the real palette isn't publicly
  documented). Color values are **not yet fixed** — pending that palette
  extraction, a follow-up pass will set exact hex values once it's done.
- **Round 4-5, same session — architecture change: KML → KMZ with bundled
  user-picked icons.** The user styled 10 real points in My Maps' own editor
  (their own icon + color choices) and exported the result, giving real
  ground truth instead of another guess. The plain `.kml` export flattened
  every custom icon to one generic recolored pin (explaining rounds 1-3's
  failures) and incidentally revealed the colors are real **Google Material
  Design** hex values, not arbitrary CSS names. The **`.kmz`** export,
  however, embeds the actual chosen icons as local PNG files with no
  `<color>` tag at all — color baked directly into each image. Extracted
  those 10 PNGs verbatim into the repo as `assets/kml-icons/*.png` and
  rewrote `routes/mapExport.js` to generate a **`.kmz`** (zip, via the new
  `jszip` dependency) bundling `doc.kml` + all 10 icons together — fully
  self-contained, no runtime/server dependency at all once downloaded
  (different from the self-hosting the user declined twice: that was about
  fetching icons live while *viewing* the map; this bundles static files
  *inside* the exported archive itself). All KML-only color constants
  (`KML_SPOT_COLOR_HEX`, `HOTEL_KML_COLOR_HEX`, etc.) and the old
  `mapfiles/kml/shapes/` icon URLs are gone — `lib/kmlColor.js`'s
  `rgbHexToKmlColor()` is only still used for the two route `LineStyle`s,
  which were never reported broken.
- **駐車場 (parking) added, KML export only.** New `GET /api/poi/parking`
  (`routes/poi.js`) reuses the existing `searchNearby()`/`shapePlace()`
  pattern (same 500m default radius as the other categories, no
  `extraFields` — cheaper tier than the 6 existing categories since a KML
  pin doesn't need rating/icon data). Deliberately kept **out of**
  `/hotel-spots` and `lib/mapColors.js`'s shared category list — fetched
  separately by `public/js/mapExport.js`'s new `fetchParkingSpots()`, called
  only from `exportToMyMaps()`, merged into the KML payload as a
  `parkingSpots` field. The live 周辺スポット panel and the `.docx` are both
  untouched — confirmed by inspecting the generated `.kmz`: 10 folders when
  parking data is present (still under My Maps' 10-layer cap), 9 without.
- **Confirmed working** by the user after a real My Maps import — icons,
  colors, and 駐車場 all render correctly.
- **Round 6, same session: route lines looked like a coarse vector, not a
  real road-following route.** Root cause found by reading the code, not
  guessed: `routes/routePlanning.js`'s `/leg` endpoint already returns the
  **full, untouched** decoded Routes API polyline — real, accurate,
  road-snapped data. But `public/js/documentGen.js`'s `shapeLegForDoc()`
  (used by `buildDocPayload()`, shared by both the 計画書 and My Maps
  buttons) thinned it to `MAX_DOC_PATH_POINTS = 100` before either endpoint
  ever saw it — a limit that only exists to match the `.docx`'s *static*
  Maps image's own internal point cap (`lib/staticMap.js`), irrelevant to
  the KMZ's interactive vector line. Fixed by giving `shapeLegForDoc()` an
  optional `maxPoints` param (`null` = use the full path) and
  `buildDocPayload()` a `{ fullPath }` option; `exportToMyMaps()` now passes
  `{ fullPath: true }` while `generateDocument()`'s `.docx` call is
  unchanged (still thinned, matching its real Static Maps constraint). No
  new fetch, no new Google API cost — this was purely about not discarding
  data already fetched this session. Verified with a synthetic 150-point
  test path: the resulting `doc.kml`'s `<LineString>` now contains all 150
  points instead of being capped at 100.

## Backlog (low priority — revisit later)

- **Turn-by-turn route directions in 計画書 — investigated 2026-06-21, deferred.**
  Some users' coworkers include turn-by-turn directions in their own 計画書
  documents, so this is worth adding eventually. Confirmed technically
  feasible via a live test call: adding `routes.legs.steps.navigationInstruction`
  (+ `.distanceMeters`/`.staticDuration`) to `routePlanning.js`'s
  `ROUTES_FIELD_MASK` returns real Japanese per-turn instructions (e.g. "左折
  して丸の内室町線/都道407号に入る") with no extra API call — still 1
  `computeRoutes` call per leg, same as today. The call succeeded outright
  with the expanded field mask (no rejection the way Places' tier-gated
  fields, e.g. `rating`, get rejected), suggesting this stays on the cheap
  Essentials SKU rather than bumping to Pro/Advanced — not confirmed via
  Cloud Console billing, only inferred from the call succeeding.
  Two distinct versions if/when this is built, very different cost:
  **text-only turn list** (just the instructions above, no extra cost) vs.
  **a map snippet per turn** (a separate Static Maps call per step — the
  test route alone had 15 steps × 2 legs = 30 extra calls, on top of the 1
  overview map per leg already generated). Default to text-only unless
  there's a specific reason to want per-turn images. Belongs in
  `routes/documentGen.js`'s 宿/route sections once the rest of the 計画書
  format work (see Phase 4 above) resumes — not a standalone feature.
- **Rural hotel price coverage — RESOLVED 2026-06-18.** Was caused by the
  LiteAPI sandbox key's ~2.6km hard cap on the discovery call's search
  radius. Fixed by moving discovery to a different LiteAPI endpoint
  (`GET /data/hotels`, coordinate-only, not subject to that cap) and raising
  the radius to 20km — see `docs/price-api-investigation.md`'s "Update:
  discovery moved to `/data/hotels`" section for full details. A rural test
  point that previously returned ~0 prices now returns 14 real hotels with
  real rates. No production-key upgrade or multi-source aggregation needed
  after all — the cheap fix turned out to be a different endpoint, not a
  different tier. If rural coverage is still occasionally thin after this,
  the next lever is raising the 20km cap further (50km was found to time out
  in dense Tokyo, but may be fine in genuinely sparse areas — untested).
- **AI-generated map/picture (journey + area illustration) — explored and
  reverted 2026-06-22, deferred by team decision, not a dead end.** Two
  attempts in one session, both ultimately reverted in full (verified:
  server boots clean, no half-built code left behind):
  1. **Text-to-image generation** — a prompt built from real session data
     (route legs, 周辺スポット) fed to an image-gen model. Implemented a
     provider abstraction (Pollinations free/live-verified;
     OpenAI/Replicate/Google Imagen/Stability stubbed but never
     live-tested). Output wasn't what the user/team wanted — an
     atmospheric illustration, not the structured result they envisioned.
  2. **Real-data "cover graphic"** — after the user shared a mockup
     (title + abstract journey diagram + 現場/hotel "area guide" cards
     with real labeled places), rebuilt the area cards via server-side
     compositing instead (extending the same icon-compositing system from
     Phase 5 Stage 1: real Static Map + real category icons + real text
     labels). Technically worked and matched the mockup's layout, but
     still wasn't what the team ultimately wanted after review.
  **Worth preserving for next time**: text-to-image models render
  small/accurate text labels unreliably (garbled or hallucinated) — this
  is *why* attempt 2 moved to compositing instead of generation, and
  whatever direction a future attempt takes should account for this
  rather than rediscover it from scratch. **Status**: explicitly deferred
  by team discussion, not because either approach was technically
  infeasible — revisit once the rest of the app is otherwise complete.
