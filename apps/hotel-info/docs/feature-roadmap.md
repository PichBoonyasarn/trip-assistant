# Feature Roadmap

## Scope

This app provides logistics info and 計画書 generation for one
manually-entered hotel per session — no hotel search, no price comparison,
no amenity scoring. See CLAUDE.md for the architecture this inherits from
its sibling app `hotel-finder` (hospital-naming-law filter, Places API (New)
usage, Routes API leg pattern).

## Built

- Worksite (現場) + hotel manual entry, both geocoded client-side via a
  shared `geocodeAddress()` helper.
- Company/start-point with custom-start-point override (`routes/config.js`
  + `ensureCompanyLocation()`), same as `hotel-finder`.
- Route legs (出発地→現場, 現場→ホテル) with opt-in gas-station/
  convenience-store stop search (`routes/routePlanning.js`,
  `public/js/routePlanning.js`) — ported unchanged.
- Hospitals near 現場 (`routes/poi.js` `/hospitals`) — ported unchanged.
- 周辺スポット near the hotel (`routes/poi.js` `/hotel-spots`) — ported
  unchanged.
- 計画書 (.docx) generation (`routes/documentGen.js`) — ported unchanged;
  frontend payload built from a single hotel state object instead of a
  search-result array.
- Hotel address/phone auto-lookup by name (`routes/poi.js` `/hotel-lookup`,
  `lib/googlePlaces.js` `searchText`) when `#hotelAddress` is left blank,
  biased to 現場.

## Explicitly out of scope (carried over by reference from hotel-finder, not reused)

- Hotel search / nearby-hotel discovery.
- LiteAPI price lookup.
- Amenity-comparison scoring (8-category AI-recommendation tabs).

## Backlog

(empty — add items here as they come up)
