# FAQ — How the app's automated decisions work

A running log of questions from the team about *why* the app shows what
it shows — selection logic, scoring formulas, anything that isn't
obvious just from using the UI. Add new questions to the bottom as they
come up.

---

## Q: How are 周辺スポット (nearby spot) locations chosen? Is it distance, review score, or something else?

**A: Neither, directly.** Spot selection is Google's own **default
"Popularity" ranking** from the Places API — not distance, and not this
app's own sorting.

- `lib/googlePlaces.js`'s `searchNearby()` never sets `rankPreference` in
  its request, so Google falls back to its default behavior. A comment in
  `routes/poi.js` (near the hospital-search function) documents why this
  was a deliberate choice: distance-ranking was tested and let low-quality
  results (e.g. an online-doctor brand, a chiropractor) outrank real
  hospitals just because they were technically a few meters closer.
- `routes/poi.js`'s `/hotel-spots` endpoint takes Google's results
  **in the order Google returns them** and does not re-sort. The
  per-category display caps (コンビニ=3, スーパー=3, レストラン=5, 居酒屋=5,
  バー=5, 観光スポット=3, set in `routes/documentGen.js`'s
  `HOTEL_SPOT_CATEGORY_LIMITS`) just take the first N spots from that
  order, within each category's search radius (500m for コンビニ/スーパー,
  300m for dining, 400m for bars, 2000m for 観光スポット).
- The "distance" column shown in tables/maps is computed separately
  (straight-line, via `haversine()`) purely for **display** — it plays no
  role in which spots get chosen or what order they appear in.

**In short:** which spots show up = Google's internal popularity/
relevance signal within a radius. This app doesn't additionally sort by
distance or rating.

**Source:** `lib/googlePlaces.js` (`searchNearby`), `routes/poi.js`
(`/hotel-spots`, and the hospital-search comment explaining the
popularity-vs-distance choice), `routes/documentGen.js`
(`HOTEL_SPOT_CATEGORY_LIMITS`).

---

## Q: What's the scoring formula behind AI推奨ホテル TOP 3 in each category tab?

**A:** Despite the "AI" label in the UI, this is **not a machine-learning
model** — it's a deterministic, hand-weighted point formula
(`public/index.html`). Every hotel gets scored 0–100 for the active tab,
results are sorted descending, and the top 3 are shown.

There are 7 scoring functions, one per tab, each combining a few factors
with capped point contributions:

| Tab | Formula (capped points per factor) |
|---|---|
| **総合 (Overall)** | distance: `max(0, 20 − dist×2)` + rating: `(rating/5)×20` + reviews: `min(10, reviews/100×10)` + driveTime: `max(0, 15 − driveTime/4)` + price tier (4–10pt) + amenities: コンビニ `min(10, count×2)`, レストラン `min(5, count×0.5)`, スーパー `min(3, count×1.5)`, 駐車場 `min(7, count×3)` |
| **コンビニ** | コンビニ `min(40, count×8)` + レストラン `min(35, count×3.5)` + スーパー `min(25, count×8)` |
| **スーパー** | スーパー `min(80, count×20)` + コンビニ `min(20, count×4)` |
| **アクセス (Access)** | driveTime `max(0, 60 − driveTime×2)` + distance `max(0, 25 − dist×5)` + 駐車場 `min(15, count×7)` |
| **コスパ (Value)** | price tier (5–40pt, cheaper = more points) + rating `(rating/5)×30` + amenities `min(30, conv×3 + rest×2 + super×2)` |
| **評価 (Rating)** | rating `(rating/5)×50` + reviews `min(30, reviews/200×30)` + distance bonus `max(0, 20 − dist×4)` |
| **グルメ (Dining)** | レストラン `min(50, count×7)` + 居酒屋 `min(30, count×10)` + バー `min(20, count×6)` |
| **駐車場 (Parking)** | 駐車場 `min(60, count×20)` + driveTime `max(0, 40 − driveTime×2)` |

Where each input comes from:
- `distance` — straight-line haversine, 現場 → hotel (km)
- `driveTime` — real driving minutes, from Google Distance Matrix API
- `rating` / `reviews` — the legacy client-side `PlacesService.getDetails()`
  call (a different, older Places API than the one used for 周辺スポット)
- `amenities.*` — counts from `/api/poi/amenity-counts`, within a 400m
  radius of the hotel (shown on each recommendation card as "400m圏内")
- price scoring prefers `actualPrice` (a real LiteAPI quote) when
  available, otherwise falls back to Google's coarser `priceLevel` tier

**Source:** `public/index.html` — `calculateHotelScore()`,
`calculateConvenienceScore()`, `calculateSupermarketScore()`,
`calculateAccessScore()`, `calculateValueScore()`, `calculateRatingScore()`,
`calculateDiningScore()`, `calculateParkingScore()`, and
`getHotelsByCategory()`/`renderCategoryRecommendations()` for the
sort-and-take-top-3 logic.

---

## Q: What are the hotel filtering rules applied before results are shown?

**A:** The search panel used to display a note summarising these — removed from the UI because they're developer context, not user context. For reference:

- **Business hotel preference**: リゾート/高級ホテル, 旅館, ホステル, カプセルホテル, キャンプ場, コンドミニアム are excluded by default. Each can be individually re-included via checkboxes in the advanced search section.
- **Minimum quality gate**: Hotels with no reviews, or a rating below 2.0, are always excluded regardless of other settings.
- **Budget cap**: Hotels priced above the budget limit are excluded. If price is unknown they are kept (the app errs on the side of inclusion when data is missing).
- **"価格情報がないホテルを除外する" option**: When enabled, only hotels with a confirmed LiteAPI price quote proceed to the Place Details fetch — this makes search faster by skipping the per-hotel details call for price-unknown results.
- **Pricing note**: The reference price shown is an approximate one-night rate ~2 weeks out, from LiteAPI, and only appears when a LiteAPI key is configured.

**Source:** `isBusinessHotel()` in `public/index.html` (type/name filtering), `runSearch()` in the same file (rating/review/budget gates), `routes/liteapi.js` (price fetch gating).

---

<!-- Add new team Q&A below this line, same Q/A/Source format. -->
