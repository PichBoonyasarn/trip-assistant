# Real-Time Hotel Price API — Investigation Log

**Date:** 2026-06-17
**Goal:** Show actual nightly hotel prices (¥/泊) in the hotel finder app, instead of Google's generic 0–4 price tier.

## Background

Google Maps Places API only returns a `price_level` field (0–4), not an actual nightly rate. To show real prices, a separate hotel pricing data source is required. We evaluated three free/self-service options over several days. All three hit blockers that make them unsuitable for a tool meant to be shared across the team without ongoing maintenance risk.

## Attempt 1: Rakuten Travel API

- **What it is:** Rakuten's `SimpleHotelSearch` endpoint, part of Rakuten Web Service. Strong coverage of Japanese hotels, including budget business hotel chains.
- **Registration:** Required filling out an application form on the new Rakuten developer portal (`webservice.rakuten.co.jp/app/create`), including "Application Type" (Web/API), "Allowed Websites" (with strict domain validation — `localhost`, IPs, and even wildcards were rejected; only a placeholder like `example.com` was accepted), and "Expected QPS."
- **Result:** Registration eventually succeeded, but the application ID issued was in UUID format (`xxxxxxxx-xxxx-...`). When called against the API, it returned:
  ```
  {"error_description":"specify valid applicationId","error":"wrong_parameter"}
  ```
  The legacy `SimpleHotelSearch/20170426` endpoint expects the old numeric application ID format. Newly registered accounts on the redesigned portal appear to receive UUID-format credentials that are **not accepted by this endpoint**, and no equivalent UUID-compatible endpoint was identified.
- **Time spent:** ~2 days, including debugging unrelated issues along the way (CORS from `file://` pages, a hanging `DistanceMatrixService` call that masked the real failure point).
- **Outcome:** Abandoned. No working credential found for this API tier.

## Attempt 2: Jalan (じゃらん) Hotel Search API

- **What it is:** Recruit's Jalan Web Service, `HotelSearch/V1` (Advance). Also strong Japanese hotel coverage, returns `SampleRateFrom` (lowest per-room rate) — exactly the field we needed.
- **Registration:** Confirmed via documentation that an API key is "assigned during account registration," but no self-service registration or key-issuance page could be located:
  - The general Recruit Web Service account (used for Hot Pepper Gourmet/Beauty) does not grant Jalan API access.
  - The Jalan Web Service portal (`jalan.net/jw/...`) has no visible "new developer" signup link.
  - The one promising "会員" (Member) link led to a membership **cancellation** form, not registration.
  - The API's host domain (`jws.jalan.net`) does not serve a browsable developer portal at all (connection refused).
- **Outcome:** Abandoned. Could not identify a self-service path to obtain a working key; would likely require contacting Jalan support directly and going through a manual/business approval process.

## Attempt 3: Amadeus Hotel API

- **What it is:** Amadeus for Developers, self-service tier. Modern OAuth2 REST API (`Hotel List by geocode` + `Hotel Search/Offers`), well documented internationally.
- **Registration:** Confirmed as the easiest of the three — instant signup with just an email, no domain/IP allowlisting.
- **Result:** Upon visiting the self-service portal, found an active announcement:
  > "Amadeus for Developers self-service portal will be decommissioned on **July 17th, 2026**. Enterprise APIs remain available via the Enterprise portal."

  Since today is 2026-06-17, this gives only ~1 month of usable access before the tier disappears. The replacement ("Enterprise portal") is expected to require a business contract, not a self-service signup.
- **Outcome:** Abandoned before implementation. Not worth building against a tier that is being sunset within a month.

## Conclusion

All three free/self-service hotel pricing data sources we could find for the Japanese market are currently dead ends:

| Provider | Blocker |
|---|---|
| Rakuten Travel | New accounts get incompatible (UUID) credentials for the legacy search endpoint |
| Jalan (Recruit) | No discoverable self-service developer registration path |
| Amadeus | Self-service tier sunsetting 2026-07-17; replacement requires a business contract |

Live, real-money hotel pricing for this app would require either:
1. A formal business/partner agreement with one of the above providers (Enterprise tiers), or
2. A different paid aggregator API (e.g. a RapidAPI hotel pricing product), which hasn't been evaluated yet.

## Decision

For now, the app uses a **fallback estimation approach** instead of live pricing:
1. Use Google's `price_level` (0–4) where available, mapped to an estimated JPY range.
2. Where Google has no price data, infer a range from known Japanese business hotel chain names (東横イン, アパホテル, ドーミーイン, etc.), shown with a `(推定)` ["estimated"] label so users know it isn't a live quote.
3. Hotels matching neither show `—`.

This requires no external API, no credentials to maintain, and no risk of sudden shutdown. It is implemented in `public/index.html` (`CHAIN_PRICE_RANGES`, `GOOGLE_PRICE_RANGES`, `inferPriceRange()`).

Live pricing remains a possible future enhancement if a business partnership with one of the above providers (or a viable paid aggregator) is pursued later.

## Update: LiteAPI adopted for live pricing

After this log was written, a **LiteAPI** sandbox key (`sand_...`) was obtained
and integrated successfully — it returns real, plausible JPY nightly rates for
Japanese hotels via a 2-step flow (`POST /v3.0/hotels/rates`: first a
coordinate-based discovery call, then a rates call for specific hotel IDs).
The app now shows a real price (no `(推定)` label) wherever a LiteAPI match is
found, falling back to the estimation approach above otherwise. Implemented in
`server.js` (`/api/liteapi-hotels` proxy) and `public/index.html`
(`getLiteApiHotels`, `matchLiteApiPrice`).

### Known sandbox limitation: hard radius cap (~2.6km)

The sandbox key has an **undocumented hard cap on the discovery call's
`radius` parameter**. Confirmed empirically (same coordinates, same dates,
varying only `radius`): requests with `radius <= 2600` (meters) succeed
reliably; `radius >= 2700` deterministically returns
`{"error":{"code":2001,"message":"no availability found"}}` on every retry,
with the `x-ratelimit-remaining` header staying flat throughout (i.e. not a
rate-limit or random-flakiness issue — a hard, repeatable cutoff). This cost
significant debugging time before being isolated, since earlier this looked
like intermittent sandbox flakiness or rate-limit exhaustion.

**Fix:** `server.js` now clamps the radius sent to LiteAPI's discovery call to
2500m regardless of the radius requested by the UI/Google search
(`liteApiRadius = Math.min(radius, 2500)`). This doesn't reduce match quality
for the app's purposes, since `matchLiteApiPrice` already does its own
coordinate-distance matching against actual hotel coordinates — it just limits
how far out LiteAPI looks for *candidate* hotels to begin with.

If this key is later upgraded to a production tier, this cap should be
re-tested — it may be sandbox-specific and not present on a paid plan.

## Update: discovery moved to `/data/hotels`, radius cap raised to 20km

The 2.5km cap above caused a real problem: rural worksites frequently have no
hotel within 2.5km, so LiteAPI's discovery call never saw any candidate and
rural searches got little/no live pricing, regardless of the overall search
radius.

Investigated the user's suggestion of looking up each Google-found hotel by
name individually. Found LiteAPI does have a `hotelName` param (on a
*different* endpoint, `GET /v3.0/data/hotels`), but tested live and it does
not match Japanese hotel names at all — searching `hotelName=ザ・ペニンシュラ東京`
or `帝国ホテル東京` returned zero results, while the English names ("Peninsula
Tokyo") matched correctly. Since Google Places returns hotel names in
Japanese throughout this app, per-hotel name search isn't viable.

However, `/v3.0/data/hotels` also supports **coordinate-only** search
(`latitude`/`longitude`/`radius`, no name needed) and is a separate endpoint
from `/hotels/rates` — **not subject to the same ~2.6km cap**. Tested live:
radius=20000 succeeds cleanly even in a touristy resort area (598 total
candidates); radius=50000 from dense central Tokyo hits a `504 Gateway
Timeout` (a soft, volume-related limit on that endpoint, not a hard
validation wall like the old one). 20000 was confirmed safe even in the
densest area tested (Tokyo Station, ~4.6s response).

`routes/liteapi.js`'s discovery step (Step 1) now calls `GET /data/hotels`
(coordinate-only, no `hotelName`) instead of `POST /hotels/rates`'
coordinate search, with the radius cap raised from 2500m to 20000m. Step 2
(rates lookup by hotel ID) is unchanged — it never had a radius parameter at
all, so it was never the bottleneck. Confirmed end-to-end: a rural test point
that previously would have returned ~0 prices now returns 14 real hotels
with real JPY rates within a 15km radius.

## Update: toggle-ON was dropping estimate-only hotels

Found via user testing right after the fix above: with `価格情報がないホテルを
除外する` (exclude hotels without price info) checked, a hotel
(アパホテル〈小松グランド〉) that had a real price shown in the normal (toggle-OFF)
results — but only Google's *estimated* price, not a real LiteAPI match —
was silently excluded when the toggle was on.

Cause: the toggle-ON early-filter in `public/index.html` (`runSearch()`,
the `excludeNoPrice` block) only checked `matchLiteApiPrice()` (a real
LiteAPI rate), while the toggle-OFF table displays a price whenever *either*
a real LiteAPI match *or* an estimated price (`inferPriceRange()`, based on
Google's `price_level` or a known chain name) is available. So "has price
info," as the checkbox's own label promises, didn't actually match what the
filter checked.

Fix: the filter now also accepts `inferPriceRange(h.name, h.price_level).text
!= null` as a pass — same estimation logic already used for display, just
evaluated earlier (it only needs `name`/`price_level`, both already present
on the raw Google Places result before the Details fetch, so no extra API
calls). Also removed an early-bailout that hard-failed the whole search if
the LiteAPI discovery call returned zero candidates — it now just falls
through to estimates for every hotel in that case, consistent with how
toggle-OFF already degrades gracefully when LiteAPI is unavailable.

Confirmed end-to-end: a rural search found 29 hotels, 14 of which had any
price (13 real LiteAPI matches + 1 estimated). Toggle-ON now shows exactly
those same 14 — previously it would have shown only the 13 real matches,
silently dropping the estimated one.
