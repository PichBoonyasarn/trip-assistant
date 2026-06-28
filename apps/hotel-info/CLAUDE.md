# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Node/Express + vanilla-JS internal tool for Japanese business-trip hotel
logistics. Unlike its sibling app `hotel-finder` (which searches for and
price-compares candidate hotels), this app assumes the hotel has already
been chosen/booked outside the app — the user manually enters one hotel's
name/address/phone/price per session. The app then provides supporting
logistics info (nearby hospitals, route legs, nearby dining/convenience
spots) and generates a 計画書 (.docx planning document) from it.

## Commands

- `npm start` (or `node --env-file=.env server.js`) — runs the server on
  `PORT` (default 3000). Requires Node 20.6+ (uses `--env-file`) and native
  `fetch` (Node 18+).
- Requires a `.env` file (see `.env.example`): `GOOGLE_MAPS_KEY`, `PORT`,
  `COMPANY_ADDRESS`. No `LITEAPI_KEY` — this app never calls LiteAPI.
- No test suite or lint config. Verify by hitting backend routes directly
  (`Invoke-RestMethod`/`curl`) and exercising the UI in a browser — every
  route is independently curl-able without the browser.

## Architecture

Same backend-route-per-feature pattern as `hotel-finder`: `server.js` mounts
`routes/config.js`, `routes/poi.js`, `routes/routePlanning.js`,
`routes/staticMap.js`, `routes/documentGen.js`. `lib/` holds shared helpers
(`haversine.js`, `retry.js`, `googlePlaces.js` — Places API (New)
`searchNearby` wrapper, `polyline.js`, `staticMap.js`).

**No hotel search, no amenity-comparison scoring.** `hotel-finder`'s
8-category AI-recommendation scoring system (`calculateConvenienceScore`
etc.) and its `/api/poi/amenity-counts` endpoint do not exist here — there's
nothing to compare/rank since exactly one hotel exists per session. If you
need that scoring logic for reference, it's in `hotel-finder`'s
`public/index.html` and `routes/poi.js` (not this repo).

**The hospital search (`routes/poi.js`) trusts Japanese hospital-naming law
over Google's type tags** — same heuristic as `hotel-finder`: "病院" in a
name is legally restricted (Medical Care Act, 20+ beds) and treated as
authoritative; searches a tiered radius (30km, then 50km fallback). See the
`NAME_EXCLUDE_KEYWORDS`/`NAME_REQUIRE_KEYWORDS` comments in `routes/poi.js`
for the full reasoning (ported verbatim from `hotel-finder`).

**Two Google Places API generations**: the client-side `google.maps.Geocoder`
(legacy, used for resolving the worksite/hotel/company addresses typed into
the form) vs. the server-side Places API (New) (`routes/poi.js`,
`lib/googlePlaces.js`, for hospitals/dining/route-stop search) — same split
as `hotel-finder`, see that app's `CLAUDE.md` for the full type-vocabulary
caveat if a Places call 403s.

**`docs/feature-roadmap.md`** documents this app's (much smaller) scope and
what's built.

## Frontend structure

`public/index.html`: worksite input → company/start-point section → hotel
manual-entry form → "情報を取得" (loads hospitals, both route legs, hotel
spots) → "計画書を生成". `public/js/poi.js` and `public/js/routePlanning.js`
are carried over from `hotel-finder` unchanged (both are fully
coordinate-driven, no search/index dependency). `public/js/documentGen.js`
is adapted: `generateDocument()` takes no index argument and reads a single
hotel state object (`hotelLat`/`hotelLng` + the hotel form fields) instead
of `lastResults[idx]`. No build step, no module system — same as
`hotel-finder`.
