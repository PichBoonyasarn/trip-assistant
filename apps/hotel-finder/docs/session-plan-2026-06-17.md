# Plan: LiteAPI sandbox availability investigation (paused — pending user research)

## Context

Earlier this session, a radius cap was found and fixed (LiteAPI sandbox
discovery calls clamped to 2500m in `server.js`, since >2600m deterministically
failed). That fix is shipped and documented in
`docs/price-api-investigation.md`.

Since then, **new contradicting evidence** surfaced: the *exact same* request
(`radius:2500`, same lat/lng for 東京駅, same checkin/checkout dates) that
succeeded earlier in this session failed 16/16 times just now, while a
different location (神戸市) succeeded immediately right after. This rules out
"radius cap" as the sole explanation — something **time-varying** in LiteAPI's
sandbox is also at play, independent of our request parameters.

Discussed with the user how LiteAPI's `/v3.0/hotels/rates` endpoint actually
works: it's a real availability+rate query for the specific `checkin`/
`checkout` dates we send (computed in `server.js`'s `getDefaultDates()` as
"14 days from today, 1 night"), not just a hotel-existence lookup. So
`"no availability found"` could mean either:
1. A **production-realistic** "this date is genuinely sold out" (expected,
   not a bug, for a live key during high season) — considered unlikely to
   be the cause here, since this is a sandbox key, not live commercial
   inventory.
2. A **sandbox-specific quirk**: e.g. a shared/finite demo inventory pool
   across all LiteAPI sandbox users that can deplete and replenish on some
   schedule, or intentional rotation of which demo hotels appear "available"
   so developers can test both success and sold-out handling.

The user is going to check LiteAPI's own documentation/dashboard for any
sandbox-specific notes on this behavior before deciding on a code change —
this plan is **paused pending that research**, since the right fix depends
heavily on which explanation turns out to be correct.

## Decision tree for next session (once research is back)

- **If docs confirm sandbox has rotating/limited demo data** (or similar
  time-based quirk): the most useful code change is a **"retry pricing only"
  control** — when the early (`excludeNoPrice` toggle) or late LiteAPI fetch
  fails in `public/index.html`'s `runSearch()`, let the user re-trigger just
  the `getLiteApiHotels`/`matchLiteApiPrice` step (already-fetched
  `rows`/`limitedHotels` and their coordinates are reusable) instead of
  re-running the entire Google Places search + Details + drive-time pipeline.
  This makes retrying minutes later cheap regardless of root cause.
- **If docs say nothing unusual / sandbox should behave reliably**: this
  may warrant contacting LiteAPI support directly with the reproduction
  details (exact payload, two timestamps, contradicting results) since it
  would indicate an actual platform-side issue worth reporting, separate
  from any change in our code.
- **In either case**, consider softening the current failure message in
  `public/index.html` (`'価格情報の取得に失敗しました（料金APIが一時的に
  不安定です）...'`, currently around the `excludeNoPrice` early-filter
  block) to clarify this can be a normal "no current sandbox data for this
  search," not necessarily something the user did wrong.

## Files likely involved once a direction is chosen
- `C:\Users\Staff\Pich\20260616\hotel-finder\public\index.html` (retry-pricing
  control and/or message wording)
- `C:\Users\Staff\Pich\20260616\hotel-finder\docs\price-api-investigation.md`
  (record whatever the LiteAPI docs/dashboard research turns up)

## Out of scope for this plan (already done, no further action needed)
- Plan A (exclude no-price hotels toggle) — implemented.
- Plan B (distance-sorted candidates, maxHotels passthrough, 450m match
  radius) — implemented.
- Browser caching fix (`Cache-Control: no-store` + `fetch cache: 'no-store'`)
  — implemented and confirmed working.
- LiteAPI discovery radius clamped to 2500m in `server.js` — implemented,
  confirmed working at the time, though now known to be an incomplete fix
  given the new time-varying evidence above.
- Radius field tooltip + larger number-input step sizes (`#radius`,
  `#maxHotels`, `#maxBudget` in `public/index.html`) — implemented.
