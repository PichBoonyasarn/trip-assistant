// Shared category/marker color + label constants — used by routes/documentGen.js
// (the .docx's Static Map icon markers + table shading) and routes/mapExport.js
// (the KML export's placemark styles), so both outputs stay visually consistent.

const HOTEL_SPOT_LABELS = {
  convenienceStores: 'コンビニ',
  supermarkets: 'スーパー',
  restaurants: 'レストラン',
  izakaya: '居酒屋',
  bars: 'バー',
  travelSpots: '観光スポット',
};

// Hex equivalents of the named Static Maps marker colors, for docx table-cell
// shading (Static Maps takes named colors; docx shading needs hex), the
// icon-marker circle fill in lib/mapIcons.js, and KML placemark styling. 4 of
// 6 are exact values recovered from the user's example document's raw XML
// (round 3, 2026-06-21): コンビニ/スーパー/レストラン/観光スポット. 居酒屋/バー
// weren't highlighted in that example (incomplete mockup, not an intentional
// exclusion).
// バー changed from gray (808080) to neon pink (round 2026-06-22, readability
// pass) — gray blended into the base map and was hard to spot; exact shade
// easy to adjust further after seeing it rendered.
const HOTEL_SPOT_COLOR_HEX = {
  convenienceStores: '00A933',
  supermarkets: '800080',
  restaurants: 'FF8000',
  izakaya: 'FFCC00',
  bars: 'FF1493',
  travelSpots: '813709',
};

// Solid red, distinct from all 6 category colors — the hotel's own marker.
const HOTEL_MARKER_COLOR_HEX = 'FF0000';
const HOTEL_MARKER_TEXT = '宿';

// Blue — distinct from the hotel's red and all 6 spot-category colors;
// matches this app's existing convention of blue for 現場/start points.
const WORKSITE_MARKER_COLOR_HEX = '0000FF';
const WORKSITE_MARKER_TEXT = '現場';

module.exports = {
  HOTEL_SPOT_LABELS,
  HOTEL_SPOT_COLOR_HEX,
  HOTEL_MARKER_COLOR_HEX,
  HOTEL_MARKER_TEXT,
  WORKSITE_MARKER_COLOR_HEX,
  WORKSITE_MARKER_TEXT,
};
