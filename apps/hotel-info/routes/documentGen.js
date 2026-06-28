const express = require('express');
const router = express.Router();
const {
  Document, Packer, Paragraph, TextRun, ImageRun, HeadingLevel,
  Table, TableRow, TableCell, WidthType, ShadingType, BorderStyle, TableLayoutType,
} = require('docx');
const sharp = require('sharp');
const { fetchStaticMapImage, fetchStreetViewImage } = require('../lib/staticMap');
const { compositeSpotIcons, worldCoordinate } = require('../lib/mapIcons');
const { haversine } = require('../lib/haversine');
const {
  HOTEL_SPOT_LABELS, HOTEL_SPOT_COLOR_HEX,
  HOTEL_MARKER_COLOR_HEX, HOTEL_MARKER_TEXT,
  WORKSITE_MARKER_COLOR_HEX, WORKSITE_MARKER_TEXT,
} = require('../lib/mapColors');

const GOOGLE_MAPS_KEY = process.env.GOOGLE_MAPS_KEY || '';
const MAP_SIZE = '600x400';
const MAP_SCALE = 2; // Static Maps scale=2 (high-DPI) — every map fetch in this file uses this.
const [MAP_BOX_WIDTH, MAP_BOX_HEIGHT] = MAP_SIZE.split('x').map(Number);
const MAP_ASPECT = 400 / 600; // Static Maps/Street View always requested at this box ratio

// Enlarged display size for 現場所在地/ルート/周辺スポット/最寄病院 maps and the
// Street View image — bigger than round 1/2's 300x200 half-scale, per the
// user's example (round 3, 2026-06-21).
const MAP_DISPLAY_WIDTH = 350;
const MAP_DISPLAY_HEIGHT = Math.round(MAP_DISPLAY_WIDTH * MAP_ASPECT);

// Wider display size for the 周辺スポット "all locations" overview map only
// (round 2026-06-23, document-output pass) — sized to fill the document's
// usable page width (docx defaults to US Letter + 1in margins ⇒ ~624px
// usable at 96dpi), well within the underlying fetch's 1200px real
// resolution (MAP_BOX_WIDTH * MAP_SCALE) so it stays crisp at this size.
const SPOT_OVERVIEW_MAP_WIDTH = 600;

// Two-per-line display width for each category's own cluster map(s) (round
// 2026-06-23, layout-density pass) — sized so two fit side-by-side within
// the ~600-624px usable page width, unlike the single-map MAP_DISPLAY_WIDTH
// (350px, too wide for two).
const SPOT_MAP_PAIR_WIDTH = 290;

// Real-photo display widths (height computed per-photo from its actual
// aspect ratio via readImageInfo — these vary, unlike the fixed-box maps
// above). Sized per the user's example: hotel/hospital photos bigger than
// 周辺スポット spot photos.
const HOTEL_PHOTO_WIDTH = 300;
const HOSPITAL_PHOTO_WIDTH = 200;
const SPOT_PHOTO_WIDTH = 160; // bumped from round 1/2's 90px per the example (~1.67in)

// One marker color per category so the combined map stays legible — picked
// to be visually distinct from the route/worksite colors used elsewhere
// (blue/red) and from each other.
const HOTEL_SPOT_COLORS = {
  convenienceStores: 'green',
  supermarkets: 'purple',
  restaurants: 'orange',
  izakaya: 'yellow',
  bars: 'gray',
  travelSpots: 'brown',
};
// Per-category caps — different categories warrant different depth (round
// 2026-06-23, document-output pass: was one global HOTEL_SPOT_MAP_LIMIT = 3
// for every category). コンビニ/スーパー stay shallow (3, uniform/replaceable
// options); レストラン/居酒屋/バー get more (5, categories users actually
// compare across). No extra Places cost: searchNearby() already requests up
// to 20 results/category (lib/googlePlaces.js) and the frontend forwards the
// full unsliced list — only this render-time slicing changes.
const HOTEL_SPOT_CATEGORY_LIMITS = {
  convenienceStores: 3,
  supermarkets: 3,
  restaurants: 5,
  izakaya: 5,
  bars: 5,
  travelSpots: 3,
};

// Hex equivalents of HOTEL_SPOT_COLORS, for docx table-cell shading (Static
// Maps takes named colors; docx shading needs hex) and for the icon-marker
// circle fill in lib/mapIcons.js. 4 of 6 are exact values recovered from
// the user's example document's raw XML (round 3, 2026-06-21): コンビニ/
// スーパー/レストラン/観光スポット. 居酒屋/バー weren't highlighted in that
// example (incomplete mockup, not an intentional exclusion).
// バー changed from gray (808080) to neon pink (round 2026-06-22,
// readability pass) — gray blended into the base map and was hard to spot;
// exact shade easy to adjust further after seeing it rendered.
// (HOTEL_SPOT_COLOR_HEX itself now lives in lib/mapColors.js, shared with
// routes/mapExport.js's KML styling.)

// Single uppercase letter/digit per Google's Static Maps marker `label`
// constraint. Starts at digits 1-9 (0 skipped — looks like O) then letters
// A-Z skipping H (reserved for the hotel's own marker) — 34 distinct labels,
// comfortably more than the 24-spot max (sum of HOTEL_SPOT_CATEGORY_LIMITS).
const SPOT_LABEL_CHARS = '123456789ABCDEFGIJKLMNOPQRSTUVWXYZ'.split('');

// Walks categories/items in one consistent order (category order, distance-
// sorted within each, capped per HOTEL_SPOT_CATEGORY_LIMITS) — every other
// spot-ordering concern (labels, map pins, map clustering) is built from
// this single source of truth so they never drift out of sync with each
// other. Only includes spots with lat/lng (the rest can't go on a map).
function orderedMappableSpots(hotelSpots) {
  const ordered = [];
  for (const [key, color] of Object.entries(HOTEL_SPOT_COLORS)) {
    for (const s of (hotelSpots[key] || []).slice(0, HOTEL_SPOT_CATEGORY_LIMITS[key])) {
      if (s.lat != null && s.lng != null) ordered.push({ spot: s, color, key });
    }
  }
  return ordered;
}

// Assigns each mappable spot a label, in orderedMappableSpots()'s order, so
// a pin's number on the map always matches the same spot's number in the
// table.
function assignSpotLabels(hotelSpots) {
  const labels = new Map();
  orderedMappableSpots(hotelSpots).slice(0, SPOT_LABEL_CHARS.length).forEach(({ spot }, i) => {
    labels.set(spot, SPOT_LABEL_CHARS[i]);
  });
  return labels;
}

// 周辺スポット photos: every listed spot in the 5 non-コンビニ categories gets
// one (round 3, 2026-06-21 — confirmed via the user's example, where none of
// the コンビニ items had a photo). Each is a real, separate billable Places
// Photo charge — same per-photo cost the live site already pays when a user
// clicks a 周辺スポット tab (public/js/poi.js's lazy thumbnail loading); a
// static .docx just can't defer that behind a click, so every wanted photo
// is fetched at generation time instead of on-demand.
const PHOTO_EXCLUDED_CATEGORY = 'convenienceStores';
// コンビニ also gets no dedicated close-up category map (round 2026-06-23,
// layout-density pass — the user doesn't need one; kept as its own
// constant even though it's the same category as PHOTO_EXCLUDED_CATEGORY
// today, since the two are independent decisions that could diverge).
// コンビニ spots still appear as pins on the 全体図 overview map — only the
// per-category map is skipped, see categoryClusters below.
const MAP_EXCLUDED_CATEGORY = 'convenienceStores';
function pickPhotoSpots(hotelSpots) {
  const picked = [];
  for (const key of Object.keys(HOTEL_SPOT_COLORS)) {
    if (key === PHOTO_EXCLUDED_CATEGORY) continue;
    for (const s of (hotelSpots[key] || []).slice(0, HOTEL_SPOT_CATEGORY_LIMITS[key])) {
      if (s.photoRef) picked.push(s);
    }
  }
  return picked;
}

// ~280m-radius framing, derived from Static Maps' meters/pixel formula
// (156543.03392 * cos(lat) / 2^zoom) for a 600px-wide image at Tokyo's
// latitude — not just eyeballed. Tightened from the first pass's 16/500m
// (round 2026-06-22, readability pass): the original markers/zoom were too
// small/zoomed-out to read comfortably at real document size, so this
// zooms in further to match the bigger markers in lib/mapIcons.js. Cluster
// limit dropped 5→4 for the same reason — fewer, bigger markers per map
// reduces crowding; producing more map images per hotel when needed is an
// accepted trade-off (clusterEntries() already scales to as many maps as
// the data needs, no structural change required).
const ZOOMED_MAP_ZOOM = 17;
const SPOT_MAP_RADIUS_M = 280;
const SPOT_MAP_CLUSTER_LIMIT = 4;

// Mutes the base map so composited icon markers (lib/mapIcons.js) stand
// out more (round 2026-06-22, readability pass) — desaturate+lighten the
// whole map into a calmer pastel backdrop, and hide Google's own default
// POI icons/labels, which otherwise visually compete with our markers (the
// first test render had a Google delivery-locker icon sitting right next
// to one of our composited pins). Scoped to spot-cluster maps only — every
// other map (現場/route/hospital) is unaffected, matching Stage 1's
// existing scope boundary.
const SPOT_MAP_STYLES = [
  'saturation:-65|lightness:15',
  'feature:poi|element:labels.icon|visibility:off',
];

// Greedily groups orderedMappableSpots()-shaped entries ({spot,color,key})
// into clusters of at most SPOT_MAP_CLUSTER_LIMIT, each within
// SPOT_MAP_RADIUS_M of the cluster's first (anchor) point — adaptive map
// count per the user's explicit answer ("one map if it fits, several if it
// doesn't"), not a fixed split. Takes a pre-filtered entry list rather than
// hotelSpots directly (round 2026-06-23, document-output pass) so each
// category can be clustered on its own — a map should never mix categories
// together, since each category now gets its own table + map(s).
function clusterEntries(entries) {
  const clusters = [];
  let current = null;
  for (const entry of entries) {
    const { spot } = entry;
    const fits = current
      && current.items.length < SPOT_MAP_CLUSTER_LIMIT
      && haversine(current.anchor.lat, current.anchor.lng, spot.lat, spot.lng) * 1000 <= SPOT_MAP_RADIUS_M;
    if (fits) {
      current.items.push(entry);
    } else {
      current = { anchor: spot, items: [entry] };
      clusters.push(current);
    }
  }
  return clusters;
}

function clusterCenter(cluster) {
  const lat = cluster.items.reduce((sum, { spot }) => sum + spot.lat, 0) / cluster.items.length;
  const lng = cluster.items.reduce((sum, { spot }) => sum + spot.lng, 0) / cluster.items.length;
  return { lat, lng };
}

// Solid red, distinct from all 6 category colors — the hotel's own marker
// on the spot-cluster map. Rendered bigger + with the 宿 kanji as its main
// content instead of a small "H" corner badge (round 2026-06-23,
// standout-marker pass — confirmed kanji renders correctly via a real
// rendered-PNG smoke test before wiring this in).
// (HOTEL_MARKER_COLOR_HEX/TEXT and WORKSITE_MARKER_COLOR_HEX/TEXT now live in
// lib/mapColors.js, shared with routes/mapExport.js's KML styling.) Blue is
// only shown when 現場 actually falls within a given map's rendered frame —
// see isPointInFrame() — never forced in by zooming a map out.

// Places API (New) has no distinct izakaya icon — izakaya results share
// レストラン's plain restaurant_pinlet glyph (confirmed live), which read as
// confusingly similar on the map despite the different category color
// (round 2026-06-22, icon-distinction pass). lib/mapIcons.js's
// CUSTOM_GLYPHS has a hand-drawn beer mug glyph for this key.
const IZAKAYA_CUSTOM_GLYPH = 'beerMug';

// One spot's marker, shaped for lib/mapIcons.js's compositeSpotIcons()
// instead of Static Maps' markers= param. Shared by clusterIconMarkers()
// (per-category close-up maps) and overviewIconMarkers() (the all-locations
// map) so both stay in sync (round 2026-06-23, document-output pass).
function spotIconMarker(spot, key, labels) {
  return {
    lat: spot.lat,
    lng: spot.lng,
    colorHex: HOTEL_SPOT_COLOR_HEX[key],
    iconMaskBaseUri: spot.iconMaskBaseUri,
    customGlyph: key === 'izakaya' ? IZAKAYA_CUSTOM_GLYPH : undefined,
    label: labels.get(spot),
  };
}

// Spot + hotel (+ optionally 現場) markers for this cluster. The hotel's
// own marker is included here — rather than as a separate native Static
// Maps pin like the original Stage 1 pass had it — so it gets deconflicted
// by the same overlap-avoidance pass as every spot marker (round
// 2026-06-22, overlap-fix pass); included only when it's actually within
// this cluster's radius, same reasoning the removed clusterHotelMarker()
// had — otherwise it would sit off-frame or force the map to zoom back
// out, defeating the close-up the cluster map is for. 現場 gets the same
// within-radius treatment (round 2026-06-23, standout-marker pass) — it's
// rare for a worksite to be this close to a hotel/spot cluster, but when it
// is, show it rather than silently omitting it.
function clusterIconMarkers(hotel, worksite, cluster, labels) {
  const markers = cluster.items.map(({ spot, key }) => spotIconMarker(spot, key, labels));
  if (haversine(cluster.anchor.lat, cluster.anchor.lng, hotel.lat, hotel.lng) * 1000 <= SPOT_MAP_RADIUS_M) {
    markers.push({ lat: hotel.lat, lng: hotel.lng, colorHex: HOTEL_MARKER_COLOR_HEX, textGlyph: HOTEL_MARKER_TEXT, big: true });
  }
  if (worksite && haversine(cluster.anchor.lat, cluster.anchor.lng, worksite.lat, worksite.lng) * 1000 <= SPOT_MAP_RADIUS_M) {
    markers.push({ lat: worksite.lat, lng: worksite.lng, colorHex: WORKSITE_MARKER_COLOR_HEX, textGlyph: WORKSITE_MARKER_TEXT });
  }
  return markers;
}

// Every mappable spot (across all categories) + the hotel, unconditionally
// — unlike clusterIconMarkers(), there's no within-radius check here since
// this map is the wide "all locations" overview by design (round
// 2026-06-23, document-output pass). `worksite` is optional — the caller
// (router handler) only passes it when isPointInFrame() confirms 現場
// actually falls within this map's rendered bounds, since unlike the
// hotel/spots it doesn't factor into computeOverviewView()'s bounding box.
function overviewIconMarkers(hotel, entries, labels, worksite) {
  const markers = entries.map(({ spot, key }) => spotIconMarker(spot, key, labels));
  markers.push({ lat: hotel.lat, lng: hotel.lng, colorHex: HOTEL_MARKER_COLOR_HEX, textGlyph: HOTEL_MARKER_TEXT, big: true });
  if (worksite) {
    markers.push({ lat: worksite.lat, lng: worksite.lng, colorHex: WORKSITE_MARKER_COLOR_HEX, textGlyph: WORKSITE_MARKER_TEXT });
  }
  return markers;
}

// Whether `point`'s pixel position (under the same Web Mercator projection
// + 2^zoom*scale formula compositeSpotIcons()/computeOverviewView() use)
// falls inside a widthPx*heightPx frame centered on `center` at `zoom` —
// used to decide whether 現場 is actually visible on the overview map
// rather than force-including it (round 2026-06-23, standout-marker pass).
function isPointInFrame(point, center, zoom, scale, widthPx, heightPx) {
  const centerWorld = worldCoordinate(center.lat, center.lng);
  const pointWorld = worldCoordinate(point.lat, point.lng);
  const pixelsPerWorldUnit = Math.pow(2, zoom) * scale;
  const dx = (pointWorld.x - centerWorld.x) * pixelsPerWorldUnit;
  const dy = (pointWorld.y - centerWorld.y) * pixelsPerWorldUnit;
  return Math.abs(dx) <= widthPx / 2 && Math.abs(dy) <= heightPx / 2;
}

// Min/max zoom clamp for the all-locations overview map — 19 matches the
// usual Static Maps max useful zoom; 10 is a generous floor so one outlier
// spot far from the rest doesn't force a near-world-view zoom.
const OVERVIEW_MIN_ZOOM = 10;
const OVERVIEW_MAX_ZOOM = 19;
// Shrinks the fitted box slightly so marker icons (not just their center
// point) stay inside the frame — same reasoning as compositeSpotIcons()'s
// own clamp-into-frame step, just applied before the zoom pick instead of
// after, so spots near the edge don't need to be visually clamped at all.
const OVERVIEW_FIT_PADDING = 0.85;
const OVERVIEW_FETCH_WIDTH_PX = MAP_BOX_WIDTH * MAP_SCALE;
const OVERVIEW_FETCH_HEIGHT_PX = MAP_BOX_HEIGHT * MAP_SCALE;

// Picks a center/zoom that fits every given {lat,lng} point inside a
// widthPx*heightPx box at the given scale, reusing the exact same Web
// Mercator projection (worldCoordinate(), from lib/mapIcons.js) and
// pixels-per-world-unit formula (2^zoom * scale) compositeSpotIcons() uses
// to place markers — so the zoom/center picked here and the pixel
// positions compositeSpotIcons() computes later are guaranteed to agree,
// by construction, rather than risking the two drifting out of sync.
// Falls back to ZOOMED_MAP_ZOOM (the same close-up level category maps
// use) centered on the single point when there's only one point — a
// bounding box of zero size has no defined "zoom to fit" (would need
// log2(Infinity)).
function computeOverviewView(points, widthPx, heightPx, scale) {
  if (!points.length) return null;
  if (points.length === 1) return { center: points[0], zoom: ZOOMED_MAP_ZOOM };

  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const p of points) {
    minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat);
    minLng = Math.min(minLng, p.lng); maxLng = Math.max(maxLng, p.lng);
  }
  const center = { lat: (minLat + maxLat) / 2, lng: (minLng + maxLng) / 2 };

  const nw = worldCoordinate(maxLat, minLng);
  const se = worldCoordinate(minLat, maxLng);
  const worldDeltaX = Math.abs(se.x - nw.x);
  const worldDeltaY = Math.abs(se.y - nw.y);
  if (worldDeltaX < 1e-9 && worldDeltaY < 1e-9) return { center, zoom: ZOOMED_MAP_ZOOM };

  const usableWidth = widthPx * OVERVIEW_FIT_PADDING;
  const usableHeight = heightPx * OVERVIEW_FIT_PADDING;
  const zoomX = worldDeltaX > 0 ? Math.log2(usableWidth / (worldDeltaX * scale)) : OVERVIEW_MAX_ZOOM;
  const zoomY = worldDeltaY > 0 ? Math.log2(usableHeight / (worldDeltaY * scale)) : OVERVIEW_MAX_ZOOM;
  const zoom = Math.min(
    OVERVIEW_MAX_ZOOM,
    Math.max(OVERVIEW_MIN_ZOOM, Math.floor(Math.min(zoomX, zoomY))),
  );
  return { center, zoom };
}

const PLACES_PHOTO_BASE = 'https://places.googleapis.com/v1';
const PHOTO_FETCH_WIDTH_PX = 200; // requested from Places Photo

// Real, separate billable Places Photo charge per call — see
// routes/poi.js's /photo proxy for the same cost note. Reused for 周辺スポット
// and 最寄病院 photos (both have a photoRef from shapePlace()).
async function fetchPlacePhoto(photoRef) {
  if (!photoRef) return null;
  try {
    const r = await fetch(`${PLACES_PHOTO_BASE}/${photoRef}/media?maxWidthPx=${PHOTO_FETCH_WIDTH_PX}&key=${GOOGLE_MAPS_KEY}`);
    if (!r.ok) return null;
    return Buffer.from(await r.arrayBuffer());
  } catch { return null; }
}

// The hotel's photo is already resolved client-side (public/index.html's
// getDetails() call computes a complete, key-included photoUrl via the
// legacy Photos API's .getUrl()) — no new Places call needed, just download
// the bytes from the URL the client already has.
async function fetchImageFromUrl(url) {
  if (!url) return null;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return Buffer.from(await r.arrayBuffer());
  } catch { return null; }
}

// Minimal JPEG/PNG dimension + type sniff. ImageRun needs an explicit
// width/height to avoid stretching a non-square photo, and Places Photo
// doesn't report dimensions anywhere docx can read — no image-size
// dependency is used elsewhere in this project, so this stays a small
// inline reader rather than adding one just for this.
function readImageInfo(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { type: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buf.length) {
      if (buf[offset] !== 0xff) { offset++; continue; }
      const marker = buf[offset + 1];
      if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
      const segLength = buf.readUInt16BE(offset + 2);
      const isSOF = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSOF) return { type: 'jpg', height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
      offset += 2 + segLength;
    }
  }
  return null;
}

// Crops a spot photo to a consistent 4:3 ratio via sharp's `fit: 'cover'`
// (fills the exact box, cropping any excess — round 2026-06-23,
// two-column-layout pass). Places Photo results arrive in wildly
// inconsistent native ratios (observed 0.56-2.00 across one real
// document), which looked messy once two spots sit side-by-side in the
// new alternating table columns. Cropped once per photo right after
// fetch, not on every render — photoParagraph()'s existing "derive height
// from the buffer's own aspect ratio" logic then naturally produces a
// consistent height for every spot photo with no special-casing there.
// Falls back to the original buffer if the format can't be determined or
// the crop itself fails — a slightly-off-ratio photo beats no photo.
const SPOT_PHOTO_CROP_HEIGHT = Math.round(SPOT_PHOTO_WIDTH * 3 / 4);
async function cropSpotPhotoTo4x3(buffer) {
  const info = readImageInfo(buffer);
  if (!info) return buffer;
  try {
    const resized = sharp(buffer).resize(SPOT_PHOTO_WIDTH, SPOT_PHOTO_CROP_HEIGHT, { fit: 'cover' });
    return await (info.type === 'png' ? resized.png() : resized.jpeg()).toBuffer();
  } catch {
    return buffer;
  }
}

// Real photos (hotel/hospital/spot) — dynamic aspect ratio from the actual
// image, at a configurable display width.
function photoParagraph(buffer, width) {
  const info = readImageInfo(buffer);
  const height = info ? Math.round(width * info.height / info.width) : width;
  return new Paragraph({
    children: [new ImageRun({
      type: info?.type === 'png' ? 'png' : 'jpg',
      data: buffer,
      transformation: { width, height },
    })],
  });
}

// Static Maps/Street View images are always requested at the same 600x400
// box (MAP_ASPECT), so a fixed-ratio display size is safe without sniffing
// actual dimensions — but the *format* still needs detecting: Static Maps
// returns PNG, while Street View Static API always returns JPEG (no format
// param exists for it) — found via a real generated doc where a Street View
// image was mislabeled `type: 'png'` despite being JPEG bytes underneath.
function mapImageParagraph(buffer, width = MAP_DISPLAY_WIDTH) {
  const info = readImageInfo(buffer);
  return new Paragraph({
    children: [new ImageRun({
      type: info?.type === 'jpg' ? 'jpg' : 'png',
      data: buffer,
      transformation: { width, height: Math.round(width * MAP_ASPECT) },
    })],
  });
}

function formatDuration(seconds) {
  if (seconds == null) return '—';
  const totalMinutes = Math.round(seconds / 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return h > 0 ? `${h}時間${m}分` : `${m}分`;
}

function formatDistance(meters) {
  if (meters == null) return '—';
  return `${(meters / 1000).toFixed(1)}km`;
}

function heading(text) {
  return new Paragraph({ text, heading: HeadingLevel.HEADING_2 });
}

function line(text) {
  return new Paragraph({ children: [new TextRun(text)] });
}

// `1泊◯◯◯円` per the user's gathered spec (round 4, 2026-06-22) — replaces
// the live results table's `¥…~/泊` style, which stays as-is in the browser;
// this formatting is specific to the printed document. Prefers the
// LiteAPI-confirmed `actualPrice` (a single real number); falls back to the
// Google-estimated range (`priceMin`/`priceMax`) when no LiteAPI match exists.
// hotel-info sends `hotel.price` (free-text from the form) instead of the
// structured pricing fields hotel-finder uses — handled by the first branch.
function formatHotelPriceForDoc(hotel) {
  if (!hotel.actualPrice && !hotel.priceMin && hotel.price) return `1泊${hotel.price}`;
  if (hotel.actualPrice != null) return `1泊${Number(hotel.actualPrice).toLocaleString()}円`;
  if (hotel.priceMin != null) {
    const min = Number(hotel.priceMin).toLocaleString();
    const range = hotel.priceMax != null && hotel.priceMax !== hotel.priceMin
      ? `${min}〜${Number(hotel.priceMax).toLocaleString()}`
      : min;
    return `1泊${range}円${hotel.priceEstimated ? '（推定）' : ''}`;
  }
  return '料金不明';
}

// Static red ※ placeholder at the end of the 宿 section — the user fills in
// the actual remark (e.g. who's staying where) by hand in Word after
// generating the document, rather than typing it into the web form (round
// 5, 2026-06-22: the earlier #docRemark textarea was removed at the user's
// request — they edit this line themselves in the output .docx instead).
function remarkPlaceholder() {
  return new Paragraph({ children: [new TextRun({ text: '※備考（あれば記入してください）', color: 'FF0000' })] });
}

async function fetchMap(opts) {
  return fetchStaticMapImage({ size: MAP_SIZE, scale: MAP_SCALE, ...opts }, GOOGLE_MAPS_KEY);
}

async function fetchStreetView(lat, lng) {
  return fetchStreetViewImage(lat, lng, GOOGLE_MAPS_KEY, { size: MAP_SIZE });
}

// 現場's own photo — prefers a real Places photo (worksite.photoUrl, set
// client-side only when 現場 was resolved from a typed name/address, see
// public/js/documentGen.js's fetchWorksitePhotoUrl()) over Street View.
// Falls back to Street View when no name was resolved (raw lat/lng input)
// or the resolved place had no photo (round 2026-06-22 — Street View was
// previously always used regardless of input type, which showed whatever
// panorama happened to be nearest the coordinate, not necessarily anything
// resembling the actual named place, e.g. 東京タワー).
async function fetchWorksitePhoto(worksite) {
  if (worksite.photoUrl) {
    const buf = await fetchImageFromUrl(worksite.photoUrl);
    if (buf) return { buf, isRealPhoto: true };
  }
  const buf = await fetchStreetView(worksite.lat, worksite.lng);
  return { buf, isRealPhoto: false };
}

function buildWorksiteMarkers(worksite, hospitals) {
  const markers = [{ lat: worksite.lat, lng: worksite.lng, label: 'S', color: 'red' }];
  hospitals.slice(0, 3).forEach((h, i) => {
    if (h.lat != null && h.lng != null) {
      markers.push({ lat: h.lat, lng: h.lng, label: String(i + 1), color: 'blue' });
    }
  });
  return markers;
}

const NO_BORDER = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
const NO_BORDERS_TABLE = {
  top: NO_BORDER, bottom: NO_BORDER, left: NO_BORDER, right: NO_BORDER,
  insideHorizontal: NO_BORDER, insideVertical: NO_BORDER,
};
const NO_BORDERS_CELL = { top: NO_BORDER, bottom: NO_BORDER, left: NO_BORDER, right: NO_BORDER };
// Explicit 50% width for every cell in a borderless 2-cell side-by-side
// row (round 2026-06-23, two-column-layout pass) — without this, Word's
// default "autofit" table layout sizes each column from its own cell's
// *content*, not the outer table's percentage width, so two side-by-side
// cells end up visibly uneven whenever their contents differ. Paired with
// `layout: TableLayoutType.FIXED` on the outer Table (Word can still
// override percentages under the default "autofit" layout even when cells
// specify one).
const HALF_WIDTH_CELL = { size: 50, type: WidthType.PERCENTAGE };

// Side-by-side layout (photo left, zoomed map right) via a borderless
// 1-row table — the realistic, docx-buildable equivalent to the user's
// reference image, which turned out to be a screenshot of Google Maps' own
// website UI (place-info card + map composited by Google's product), not
// something any Maps Platform API can produce. Confirmed acceptable with
// the user (round 3, 2026-06-21).
function sideBySideBlock(photoBuf, photoWidth, mapBuf, mapWidth) {
  const cells = [];
  if (photoBuf) cells.push(new TableCell({ borders: NO_BORDERS_CELL, width: HALF_WIDTH_CELL, children: [photoParagraph(photoBuf, photoWidth)] }));
  if (mapBuf) cells.push(new TableCell({ borders: NO_BORDERS_CELL, width: HALF_WIDTH_CELL, children: [mapImageParagraph(mapBuf, mapWidth)] }));
  if (!cells.length) return null;
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    layout: TableLayoutType.FIXED,
    borders: NO_BORDERS_TABLE,
    rows: [new TableRow({ cantSplit: true, children: cells })],
  });
}

// --- 周辺スポット table ---

function categoryHeaderRow(key) {
  return new TableRow({
    cantSplit: true,
    children: [new TableCell({
      columnSpan: 4,
      shading: { fill: HOTEL_SPOT_COLOR_HEX[key], type: ShadingType.CLEAR, color: 'auto' },
      children: [new Paragraph({ children: [new TextRun({ text: HOTEL_SPOT_LABELS[key], bold: true })] })],
    })],
  });
}

function emptyCategoryRow() {
  return new TableRow({ cantSplit: true, children: [new TableCell({ columnSpan: 4, children: [line('見つかりませんでした')] })] });
}

// spotRow()'s 4 columns aren't equal needs — label only ever holds a
// short bracketed number/letter (~3 chars, e.g. "[12]"), distance only
// ever holds "XX.XXkm" (~7 chars) — both get just enough room, freeing
// space for name/reviews (round 2026-06-23, column-width pass). Starting
// values — tune by eye once rendered, same as every other sizing constant
// in this file.
const SPOT_COL_LABEL_PCT = 10;
const SPOT_COL_NAME_PCT = 45;
const SPOT_COL_DISTANCE_PCT = 15;
const SPOT_COL_RATING_PCT = 30;

function spotRow(s, num) {
  const dist = s.distance != null ? `${s.distance}km` : '';
  const rating = s.rating != null ? `★${s.rating}${s.userRatingCount != null ? `(${s.userRatingCount}件)` : ''}` : '';
  return new TableRow({
    cantSplit: true,
    children: [
      new TableCell({ width: { size: SPOT_COL_LABEL_PCT, type: WidthType.PERCENTAGE }, children: [line(num ? `[${num}]` : '')] }),
      new TableCell({ width: { size: SPOT_COL_NAME_PCT, type: WidthType.PERCENTAGE }, children: [line(s.name)] }),
      new TableCell({ width: { size: SPOT_COL_DISTANCE_PCT, type: WidthType.PERCENTAGE }, children: [line(dist)] }),
      new TableCell({ width: { size: SPOT_COL_RATING_PCT, type: WidthType.PERCENTAGE }, children: [line(rating)] }),
    ],
  });
}

// Description + photo (when present) on a merged full-width row below the
// spot's main row — neither fits well squeezed into a narrow column.
function spotDetailRow(s, photoBuffers) {
  const paragraphs = [];
  if (s.editorialSummary) paragraphs.push(line(s.editorialSummary));
  const photo = photoBuffers.get(s);
  if (photo) paragraphs.push(photoParagraph(photo, SPOT_PHOTO_WIDTH));
  if (!paragraphs.length) return null;
  return new TableRow({ cantSplit: true, children: [new TableCell({ columnSpan: 4, children: paragraphs })] });
}

// Standalone full-width bar for a category's colored header — split out
// (round 2026-06-23, layout-density pass) so it can span the full page
// width above the two side-by-side spot tables below it, instead of being
// duplicated per column.
function categoryHeaderBar(key) {
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [categoryHeaderRow(key)] });
}

// One column's worth of spot rows (main row + optional detail row each),
// as its own self-contained Table — factored out of categoryTable() (round
// 2026-06-23, layout-density pass) so it can be called once per column.
// Independent left/right tables size their own rows, so an uneven mix of
// detail rows between columns never misaligns anything.
function spotsSubTable(items, labels, photoBuffers) {
  const rows = [];
  for (const s of items) {
    rows.push(spotRow(s, labels.get(s)));
    const detail = spotDetailRow(s, photoBuffers);
    if (detail) rows.push(detail);
  }
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, layout: TableLayoutType.FIXED, rows });
}

// A category's header bar + its spots laid out as two side-by-side tables
// (round 2026-06-23, layout-density pass — was one full-width table with a
// lot of wasted space on the right) via the same borderless-2-cell-row
// pattern sideBySideBlock() already uses. Spots alternate left/right (1,3,5
// .. left / 2,4 .. right, per the user's explicit choice) rather than
// first-half/second-half. Returns an array of blocks — the caller spreads
// it into `children` (`children.push(...categoryTable(...))`). `labels`:
// Map from assignSpotLabels(). `photoBuffers`: Map from pickPhotoSpots()'s
// fetch results (every non-コンビニ spot with a photo).
function categoryTable(key, hotelSpots, labels, photoBuffers) {
  const items = (hotelSpots[key] || []).slice(0, HOTEL_SPOT_CATEGORY_LIMITS[key]);
  const headerBar = categoryHeaderBar(key);

  if (!items.length) {
    return [headerBar, new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [emptyCategoryRow()] })];
  }

  const left = items.filter((_, i) => i % 2 === 0);
  const right = items.filter((_, i) => i % 2 === 1);
  const cells = [new TableCell({ borders: NO_BORDERS_CELL, width: HALF_WIDTH_CELL, children: [spotsSubTable(left, labels, photoBuffers)] })];
  if (right.length) {
    cells.push(new TableCell({ borders: NO_BORDERS_CELL, width: HALF_WIDTH_CELL, children: [spotsSubTable(right, labels, photoBuffers)] }));
  }
  const columnsRow = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    layout: TableLayoutType.FIXED,
    borders: NO_BORDERS_TABLE,
    rows: [new TableRow({ cantSplit: true, children: cells })],
  });
  return [headerBar, columnsRow];
}

// Pairs map buffers two-per-line within one category (round 2026-06-23,
// layout-density pass — was one map per line), via the same borderless-
// 2-cell-row pattern as sideBySideBlock()/categoryTable(). An odd trailing
// buffer gets its own single-cell row rather than pairing with another
// category's map (per the user's explicit "stays within its own category"
// choice). Returns an array of blocks for the caller to spread.
function pairedMapParagraphs(bufs, width) {
  const blocks = [];
  for (let i = 0; i < bufs.length; i += 2) {
    const cells = [new TableCell({ borders: NO_BORDERS_CELL, width: HALF_WIDTH_CELL, children: [mapImageParagraph(bufs[i], width)] })];
    if (bufs[i + 1]) {
      cells.push(new TableCell({ borders: NO_BORDERS_CELL, width: HALF_WIDTH_CELL, children: [mapImageParagraph(bufs[i + 1], width)] }));
    }
    blocks.push(new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      layout: TableLayoutType.FIXED,
      borders: NO_BORDERS_TABLE,
      rows: [new TableRow({ cantSplit: true, children: cells })],
    }));
  }
  return blocks;
}

// --- 最寄病院 ---

function hospitalBlocks(hospitals, mapBuffers, photoBuffers) {
  if (!hospitals.length) return [line('見つかりませんでした')];
  const blocks = [];
  for (const h of hospitals.slice(0, 3)) {
    blocks.push(line(`${h.name} / ${h.distance != null ? h.distance + 'km' : '距離不明'}`));
    blocks.push(line(h.phone || '電話番号不明'));
    blocks.push(line(h.address || '住所不明'));
    const sideBySide = sideBySideBlock(photoBuffers.get(h), HOSPITAL_PHOTO_WIDTH, mapBuffers.get(h), MAP_DISPLAY_WIDTH);
    if (sideBySide) blocks.push(sideBySide);
  }
  return blocks;
}

// POST /api/document/generate — builds a .docx content block (worksite
// location, both route legs, hotel contact info, nearby hospitals, then
// 周辺スポット — hotel surroundings — on its own page at the very end, round
// 2026-06-23, document-output pass) from data the frontend already fetched
// this session. Does NOT
// re-call Places/Routes APIs for that data — see docs/feature-roadmap.md for
// why (avoids re-paying for calls the user already triggered via the
// ルート確認/周辺スポット buttons). The new costs here (round 3, 2026-06-21):
// Street View (1 call), the hotel photo (a plain fetch of an already-
// resolved URL, no new Places call), and per-spot/per-hospital Places
// Photo calls — all real but small, see pickPhotoSpots()'s comment.
router.post('/generate', async (req, res) => {
  if (!GOOGLE_MAPS_KEY) return res.status(500).json({ error: 'GOOGLE_MAPS_KEY is not configured' });

  const { worksite, company, hotel, routeToWorksite, routeToHotel, hospitals, hotelSpots } = req.body || {};
  if (!worksite || !hotel) return res.status(400).json({ error: 'worksite and hotel are required' });

  const safeHospitals = (hospitals || []).slice(0, 3);
  const safeHotelSpots = hotelSpots || {};
  const spotLabels = assignSpotLabels(safeHotelSpots);
  const photoSpots = pickPhotoSpots(safeHotelSpots);
  const mappableSpots = orderedMappableSpots(safeHotelSpots);
  const categoryKeys = Object.keys(HOTEL_SPOT_LABELS);
  const categoryClusters = new Map(
    categoryKeys.map(key => [
      key,
      key === MAP_EXCLUDED_CATEGORY ? [] : clusterEntries(mappableSpots.filter(e => e.key === key)),
    ]),
  );
  const overviewView = computeOverviewView(
    [...mappableSpots.map(e => e.spot), hotel],
    OVERVIEW_FETCH_WIDTH_PX, OVERVIEW_FETCH_HEIGHT_PX, MAP_SCALE,
  );
  // 現場 doesn't factor into computeOverviewView()'s bounding box (only
  // spots+hotel do) — it's shown on the overview only when it happens to
  // already fall within the resulting frame, never by forcing the map to
  // zoom out further (round 2026-06-23, standout-marker pass).
  const worksiteVisibleInOverview = overviewView && isPointInFrame(
    worksite, overviewView.center, overviewView.zoom, MAP_SCALE,
    OVERVIEW_FETCH_WIDTH_PX, OVERVIEW_FETCH_HEIGHT_PX,
  );

  try {
    const [
      worksiteMapBuf, worksitePhotoResult, toWorksiteMapBuf, toHotelMapBuf,
      hotelPhotoBuf, categoryMapResults, overviewMapBuf, spotPhotoResults,
      hospitalMapBufs, hospitalPhotoBufs,
    ] = await Promise.all([
      fetchMap({ markers: buildWorksiteMarkers(worksite, safeHospitals) }),
      fetchWorksitePhoto(worksite),
      routeToWorksite && company
        ? fetchMap({
            markers: [
              { lat: company.lat, lng: company.lng, label: 'A', color: 'blue' },
              { lat: worksite.lat, lng: worksite.lng, label: 'B', color: 'red' },
            ],
            path: routeToWorksite.path || [],
          })
        : null,
      routeToHotel
        ? fetchMap({
            markers: [
              { lat: worksite.lat, lng: worksite.lng, label: 'A', color: 'blue' },
              { lat: hotel.lat, lng: hotel.lng, label: 'B', color: 'red' },
            ],
            path: routeToHotel.path || [],
          })
        : null,
      fetchImageFromUrl(hotel.photoUrl),
      Promise.all(categoryKeys.map(async key => {
        const clusters = categoryClusters.get(key);
        const bufs = await Promise.all(clusters.map(async c => {
          const center = clusterCenter(c);
          const buf = await fetchMap({ zoom: ZOOMED_MAP_ZOOM, center, styles: SPOT_MAP_STYLES });
          return compositeSpotIcons(buf, { center, zoom: ZOOMED_MAP_ZOOM, size: MAP_SIZE, scale: MAP_SCALE }, clusterIconMarkers(hotel, worksite, c, spotLabels));
        }));
        return { key, mapBufs: bufs.filter(Boolean) };
      })),
      overviewView
        ? (async () => {
            const buf = await fetchMap({ zoom: overviewView.zoom, center: overviewView.center, styles: SPOT_MAP_STYLES });
            return compositeSpotIcons(
              buf,
              { center: overviewView.center, zoom: overviewView.zoom, size: MAP_SIZE, scale: MAP_SCALE },
              overviewIconMarkers(hotel, mappableSpots, spotLabels, worksiteVisibleInOverview ? worksite : undefined),
            );
          })()
        : Promise.resolve(null),
      Promise.all(photoSpots.map(async s => {
        const buf = await fetchPlacePhoto(s.photoRef);
        return { spot: s, buf: buf ? await cropSpotPhotoTo4x3(buf) : null };
      })),
      Promise.all(safeHospitals.map(async h => ({
        hospital: h,
        buf: (h.lat != null && h.lng != null)
          ? await fetchMap({ markers: [{ lat: h.lat, lng: h.lng, label: 'H', color: 'red' }], zoom: ZOOMED_MAP_ZOOM, center: { lat: h.lat, lng: h.lng } })
          : null,
      }))),
      Promise.all(safeHospitals.map(async h => ({ hospital: h, buf: await fetchPlacePhoto(h.photoRef) }))),
    ]);

    const photoBuffers = new Map();
    for (const { spot, buf } of spotPhotoResults) { if (buf) photoBuffers.set(spot, buf); }
    const hospitalMapBuffers = new Map();
    for (const { hospital, buf } of hospitalMapBufs) { if (buf) hospitalMapBuffers.set(hospital, buf); }
    const hospitalPhotoBuffers = new Map();
    for (const { hospital, buf } of hospitalPhotoBufs) { if (buf) hospitalPhotoBuffers.set(hospital, buf); }
    const categoryMapBuffers = new Map(categoryMapResults.map(r => [r.key, r.mapBufs]));

    const children = [
      heading('現場所在地'),
      line(worksite.address || `${worksite.lat}, ${worksite.lng}`),
      mapImageParagraph(worksiteMapBuf),
    ];
    if (worksitePhotoResult.buf) {
      // A real Places photo can be any aspect ratio (unlike Street View,
      // always requested at the fixed MAP_ASPECT box) — photoParagraph()
      // computes height from the actual image instead of forcing one.
      children.push(
        worksitePhotoResult.isRealPhoto
          ? photoParagraph(worksitePhotoResult.buf, MAP_DISPLAY_WIDTH)
          : mapImageParagraph(worksitePhotoResult.buf)
      );
    }

    if (toWorksiteMapBuf && routeToWorksite) {
      children.push(
        heading('会社 → 現場 ルート'),
        line(`${formatDistance(routeToWorksite.distanceMeters)} ・ 約${formatDuration(routeToWorksite.durationSeconds)}`),
        mapImageParagraph(toWorksiteMapBuf),
      );
    }

    if (toHotelMapBuf && routeToHotel) {
      children.push(
        heading('現場 → ホテル ルート'),
        line(`${formatDistance(routeToHotel.distanceMeters)} ・ 約${formatDuration(routeToHotel.durationSeconds)}`),
        mapImageParagraph(toHotelMapBuf),
      );
    }

    const addressPhoneLine = [hotel.address, hotel.phone || '電話番号不明'].filter(Boolean).join('　');
    children.push(
      heading('宿'),
      line(hotel.name || ''),
      line(addressPhoneLine),
      line(formatHotelPriceForDoc(hotel)),
      remarkPlaceholder(),
    );
    if (hotelPhotoBuf) children.push(photoParagraph(hotelPhotoBuf, HOTEL_PHOTO_WIDTH));

    children.push(
      heading('最寄病院'),
      ...hospitalBlocks(safeHospitals, hospitalMapBuffers, hospitalPhotoBuffers),
    );

    // 周辺スポット starts its own page at the very end of the document (moved
    // here from between 宿/最寄病院, round 2026-06-23, document-output pass)
    // — one table + its own map(s) per category, finishing with a single
    // wide "all locations" overview map.
    children.push(new Paragraph({ text: '周辺スポット', heading: HeadingLevel.HEADING_2, pageBreakBefore: true }));
    if (overviewMapBuf) {
      children.push(
        line('周辺スポット 全体図'),
        mapImageParagraph(overviewMapBuf, SPOT_OVERVIEW_MAP_WIDTH),
      );
    }
    for (const key of categoryKeys) {
      children.push(...categoryTable(key, safeHotelSpots, spotLabels, photoBuffers));
      children.push(...pairedMapParagraphs(categoryMapBuffers.get(key) || [], SPOT_MAP_PAIR_WIDTH));
    }

    const doc = new Document({ sections: [{ children }] });
    const buffer = await Packer.toBuffer(doc);

    const filename = `keikakusho_${(hotel.name || 'hotel').replace(/[^\w　-鿿]/g, '_')}.docx`;
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.send(buffer);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
