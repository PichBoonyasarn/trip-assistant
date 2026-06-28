# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Node/Express + vanilla-JS internal tool for Japanese construction-site
（現場）logistics. Unlike its sibling apps `hotel-finder` (hotel search) and
`Hotel-info` (single-hotel logistics), this app has no hotel functionality at
all. It focuses solely on:

- **出発地 → 現場 route** with gas station and convenience store stops
- **現場周辺スポット**: レストラン (300m), コンビニ (500m), ガソリンスタンド (1000m)
- **最寄病院** (same 30km/50km tiered search as sibling apps)
- **計画書 (.docx)**: 現場所在地 + ルート + 周辺施設 + 最寄病院. No hotel section.

## Commands

- `npm start` (or `node --env-file=.env server.js`) — runs the server on
  `PORT` (default 3000). Requires Node 20.6+ and native `fetch` (Node 18+).
- Requires a `.env` file (see `.env.example`): `GOOGLE_MAPS_KEY`, `PORT`,
  `COMPANY_ADDRESS`. No `LITEAPI_KEY`.
- No test suite or lint config. Verify by hitting `/api/poi/genba-spots?lat=35&lng=135`
  and exercising the UI in a browser.

## Architecture

Same backend-route-per-feature pattern as sibling apps. `server.js` mounts:
- `routes/config.js` — exposes `googleMapsKey` + `companyAddress` to frontend
- `routes/poi.js` — `/hospitals` (tiered 30/50km), `/genba-spots` (restaurants/conv/gas), `/photo` proxy
- `routes/routePlanning.js` — `/leg` route calculation with optional stop search
- `routes/staticMap.js` — Static Maps proxy for document images
- `routes/documentGen.js` — POST `/generate` → .docx with 現場 sections only

`lib/` is copied unchanged from Hotel-info:
`haversine.js`, `polyline.js`, `retry.js`, `staticMap.js`, `googlePlaces.js`.

## Key differences from Hotel-info

- **No hotel inputs, no hotel route leg, no hotel spots**
- `routes/poi.js` exposes `/genba-spots` instead of `/hotel-spots`/`/hotel-lookup`
- Spot categories: restaurants (300m) / convenienceStores (500m) / gasStations (1000m)
- `routes/documentGen.js` body: `{ worksite, company, routeToWorksite, hospitals, genbaSpots }`
- `public/js/poi.js`: `GENBA_SPOT_CATEGORIES`, `fetchGenbaSpots()`, `renderGenbaSpots()`
- `public/js/documentGen.js`: shapes genba data, no hotel/hotelSpots fields

## Frontend globals (index.html inline script)

`worksiteLat`, `worksiteLng`, `companyLat`, `companyLng`,
`lastHospitals`, `lastStartToWorksiteLeg`, `lastGenbaSpots`,
`ensureCompanyLocation`, `fetchRouteLeg`, `setStatus`

`public/js/routePlanning.js` is copied unchanged from Hotel-info — it is
fully coordinate-driven and has no search/index dependencies.
