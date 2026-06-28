# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Node/Express + vanilla-JS internal tool for finding business hotels near a job site (現場) in
Japan, plus supporting info for the trip: nearby hospitals (workplace-accident emergency routing)
and dining near the hotel. Search starts from a configurable point (defaults to the company
address) with a user-chosen radius.

## Commands

- `npm start` (or `node --env-file=.env server.js`) — runs the server on `PORT` (default 3000).
  Requires Node 20.6+ (uses `--env-file`) and native `fetch` (Node 18+, used for all external API
  calls — no axios/node-fetch dependency).
- Requires a `.env` file (see `.env.example`): `GOOGLE_MAPS_KEY`, `LITEAPI_KEY`, `PORT`,
  `COMPANY_ADDRESS`.
- No test suite or lint config exists. Verification is done by hitting backend routes directly
  (`Invoke-RestMethod`/`curl`, e.g. `Invoke-RestMethod "http://localhost:3000/api/poi/hospitals?lat=...&lng=..."`)
  and manually exercising the UI in a browser — this is a deliberate architecture choice (every
  route is independently curl-able without the browser), not a gap to fill in.

## Architecture

**Backend routes, not direct browser→Google/LiteAPI calls, for anything added after the original
price-search feature.** `server.js` is a thin mount point (`routes/config.js`, `routes/poi.js`,
`routes/liteapi.js`); each route is self-contained and testable without the browser. `lib/` holds
the shared helpers every route reuses: `haversine.js` (distance), `retry.js` (generic
retry-with-backoff wrapper used by every external API call), `googlePlaces.js` (Places API (New)
`searchNearby` wrapper + place shaping).

**Two Google Places API generations are both in active use — know which is which.** The original
hotel search and its amenity scoring (in `public/index.html`'s inline `<script>`) call the
**legacy** client-side `google.maps.places.PlacesService` directly from the browser, predating the
backend-only rule above, left as-is. Everything added since (`routes/poi.js`, `lib/googlePlaces.js`)
uses the **New** Places API (`places.googleapis.com/v1/places:searchNearby`) server-side instead —
different type vocabulary (e.g. `general_hospital`, `japanese_izakaya_restaurant` only exist in the
New API, not legacy), different field masks, separate Cloud Console enablement from the legacy API.
If a Places call mysteriously 403s, check whether it's the New API and whether that's specifically
enabled/unblocked for `GOOGLE_MAPS_KEY` — legacy being enabled doesn't imply New is.

**The hospital search (`routes/poi.js`) trusts Japanese hospital-naming law over Google's type
tags.** Google's `hospital` Places type gets applied to all sorts of unrelated small businesses in
Japan (clinics, vet clinics, even a pet salon, observed empirically). The filter instead treats
"病院" in a name as authoritative — legally restricted under Japan's Medical Care Act to facilities
with 20+ beds — and only falls back to type-tag checks for names that don't say 病院. It also
searches a tiered radius (30km, then 50km only if nothing qualifies within 30km, returning fewer
results in that fallback tier) rather than one fixed radius, since real worksites can be far from
any hospital.

**LiteAPI (`routes/liteapi.js`) is a sandbox key with non-obvious per-endpoint limits.** Hotel
discovery uses `GET /v3.0/data/hotels` (coordinate-only metadata search, tested reliable to ~20km)
rather than `POST /v3.0/hotels/rates`'s own coordinate search (hard-capped at ~2.6km on this key) —
they're separate endpoints with separate limits; rates are still fetched via `POST /hotels/rates`
with explicit hotel IDs once discovery resolves them. `docs/price-api-investigation.md` has the
full history of pricing APIs evaluated (several dead ends) and the reasoning behind each LiteAPI
workaround — read it before touching pricing logic, since the non-obvious constraints here (sandbox
data drift, the endpoint/radius split, Japanese-name search not matching) were each found the hard
way via live testing, not from documentation.

**`docs/feature-roadmap.md` is the source of truth for what's built vs. planned**, including the
phase-by-phase plan — each phase is one isolated `routes/*.js` + matching `public/js/*.js` module
by design, so a bug in one feature can't break another — and a running backlog. Check it before
starting new feature work. It also documents why the company starting address is env-configured
but stays user-editable per search (`routes/config.js` exposes it as a pre-filled default, not a
hard-coded value) — covers trips that start from an airport/station instead of the office.

## Frontend structure

`public/index.html` is a single large file: all styling, markup, and the original search/scoring
logic live in one inline `<script>`, no build step. Newer features get their own `public/js/*.js`
module (e.g. `poi.js`) loaded via a separate `<script src>` tag placed *before* the inline script,
communicating with it only through plain global functions — there's no module system or bundler.
