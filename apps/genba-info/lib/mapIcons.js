const sharp = require('sharp');

// Diameters at Static Maps `scale=1` — multiplied by the caller's actual
// `scale` (this app always requests scale:2) so the drawn marker stays
// proportional to the map image's real pixel resolution. Bumped ~60% from
// the first pass (22/13/11) — at real document size the original markers
// were too small to read comfortably (round 2026-06-22 readability pass).
const ICON_SIZE_BASE = 36;
const GLYPH_SIZE_BASE = 22;
const LABEL_BADGE_BASE = 18;
// How much bigger the `big: true` marker (currently just 宿/hotel) renders
// than a normal spot marker — round 2026-06-23, standout-marker pass.
const ICON_SIZE_BIG_MULTIPLIER = 1.5;
// Fraction of the (possibly big) marker's diameter a text glyph (宿/現場)
// fills — bigger than GLYPH_SIZE_BASE's ratio since text replaces the
// marker's main content entirely here, not a small corner accent.
const TEXT_GLYPH_SIZE_RATIO = 0.66;

// Keyed by iconMaskBaseUri -> Promise<Buffer|null> (the recolored white
// glyph, or null if the fetch/recolor failed). A handful of category icons
// repeat across every spot in a document (e.g. every restaurant/izakaya
// shares the same restaurant_pinlet), so this avoids redundant fetches to
// maps.gstatic.com within one document generation — same reasoning as
// public/index.html's amenityCountsCache, just for a different repeated
// lookup. These are free static assets (not billed Places calls), so this
// is purely a latency/politeness optimization, not a cost one.
const glyphCache = new Map();

// Google's Places icon glyphs are solid black (RGB 0,0,0) with alpha
// elsewhere — confirmed live by inspecting a fetched .svg's path (no `fill`
// attribute, defaults to black) — so a plain RGB negate (alpha untouched)
// turns the glyph white without needing to reconstruct an alpha mask.
async function fetchGlyph(iconMaskBaseUri, glyphSize) {
  const cacheKey = `${iconMaskBaseUri}@${glyphSize}`;
  if (glyphCache.has(cacheKey)) return glyphCache.get(cacheKey);
  const promise = (async () => {
    try {
      const r = await fetch(`${iconMaskBaseUri}.png`);
      if (!r.ok) return null;
      const buf = Buffer.from(await r.arrayBuffer());
      return await sharp(buf)
        .resize(glyphSize, glyphSize, { fit: 'inside' })
        .negate({ alpha: false })
        .png()
        .toBuffer();
    } catch {
      return null;
    }
  })();
  glyphCache.set(cacheKey, promise);
  return promise;
}

function circleSvg(diameter, hex) {
  const r = diameter / 2;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${diameter}" height="${diameter}">` +
    `<circle cx="${r}" cy="${r}" r="${r - 1}" fill="#${hex}" stroke="white" stroke-width="2"/></svg>`
  );
}

// Hand-drawn glyph for 居酒屋 (izakaya) — Places API (New) has no distinct
// izakaya icon, so izakaya results share レストラン's plain restaurant_pinlet
// glyph (confirmed live), which read as confusingly similar on the map
// despite the different category color (round 2026-06-22, icon-distinction
// pass). Drawn directly in white — no fetch/recolor needed, unlike the
// Google-sourced glyphs — to avoid sourcing/licensing a third-party icon.
function beerMugGlyphSvg(diameter) {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${diameter}" height="${diameter}">` +
    `<rect x="26" y="38" width="42" height="50" rx="4" fill="white"/>` +
    `<ellipse cx="47" cy="36" rx="23" ry="10" fill="white"/>` +
    `<path d="M68 50 Q 92 50 92 65 Q 92 80 68 80" fill="none" stroke="white" stroke-width="10" stroke-linecap="round"/>` +
    `</svg>`
  );
}

// Keyed by the `customGlyph` value a marker can carry instead of
// `iconMaskBaseUri` — local, hand-drawn glyphs that bypass the Google fetch
// entirely. Currently just izakaya's beer mug; add more here if other
// categories ever need a custom glyph too.
const CUSTOM_GLYPHS = { beerMug: beerMugGlyphSvg };

function escapeXml(text) {
  return String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

// Bold white text centered in the given box — the marker's *main* content
// (round 2026-06-23, standout-marker pass: 宿/現場 instead of a generic
// colored circle + corner letter badge). Smaller per-character font-size
// for multi-character strings (現場) than single-character ones (宿) so
// both fit the same box width — CJK full-width characters render roughly
// square, so N characters need about 1/N the per-character font-size of
// one character to span the same width.
function textGlyphSvg(diameter, text) {
  const r = diameter / 2;
  const fontSize = text.length > 1 ? diameter * 0.42 : diameter * 0.62;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${diameter}" height="${diameter}">` +
    `<text x="${r}" y="${r + fontSize * 0.36}" font-size="${fontSize}" font-family="sans-serif" ` +
    `font-weight="bold" text-anchor="middle" fill="white">${escapeXml(text)}</text></svg>`
  );
}

function labelBadgeSvg(diameter, label) {
  const r = diameter / 2;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${diameter}" height="${diameter}">` +
    `<circle cx="${r}" cy="${r}" r="${r - 1}" fill="white" stroke="#333333" stroke-width="1"/>` +
    `<text x="${r}" y="${r + diameter * 0.18}" font-size="${diameter * 0.7}" font-family="sans-serif" ` +
    `font-weight="bold" text-anchor="middle" fill="#333333">${label}</text></svg>`
  );
}

// Builds one self-contained marker image ready to be composited onto a map
// buffer. Two content modes: a normal spot marker (colored circle +
// optional category glyph + optional numbered corner label badge), or a
// `textGlyph` marker (round 2026-06-23, standout-marker pass — 宿/現場) where
// bold white text fills most of the circle as the marker's main content
// instead, with no separate corner badge (the text itself is the label).
// `big: true` renders at ICON_SIZE_BIG_MULTIPLIER× the normal diameter,
// currently used for the hotel's 宿 marker. The circle/badge/text are drawn
// locally (no network dependency, so they never fail); the Places glyph is
// best-effort — if its fetch fails, the marker still renders as a colored,
// numbered circle, which is strictly better than nothing rather than
// dropping the marker entirely.
async function buildMarkerImage({ colorHex, iconMaskBaseUri, customGlyph, textGlyph, label, big }, scale) {
  const size = Math.round((big ? ICON_SIZE_BASE * ICON_SIZE_BIG_MULTIPLIER : ICON_SIZE_BASE) * scale);
  const glyphSize = Math.round(GLYPH_SIZE_BASE * scale);
  const badgeSize = Math.round(LABEL_BADGE_BASE * scale);

  const layers = [{ input: circleSvg(size, colorHex), top: 0, left: 0 }];

  if (textGlyph) {
    const textSize = Math.round(size * TEXT_GLYPH_SIZE_RATIO);
    const textOffset = Math.round((size - textSize) / 2);
    layers.push({ input: textGlyphSvg(textSize, textGlyph), top: textOffset, left: textOffset });
  } else {
    const glyphOffset = Math.round((size - glyphSize) / 2);
    if (customGlyph && CUSTOM_GLYPHS[customGlyph]) {
      layers.push({ input: CUSTOM_GLYPHS[customGlyph](glyphSize), top: glyphOffset, left: glyphOffset });
    } else if (iconMaskBaseUri) {
      const glyph = await fetchGlyph(iconMaskBaseUri, glyphSize);
      if (glyph) layers.push({ input: glyph, top: glyphOffset, left: glyphOffset });
    }

    if (label) {
      const offset = size - badgeSize;
      layers.push({ input: labelBadgeSvg(badgeSize, label), top: offset, left: offset });
    }
  }

  return {
    size,
    buffer: await sharp({ create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite(layers)
      .png()
      .toBuffer(),
  };
}

// Standard Web Mercator "world coordinate" projection (the same formula
// documented for converting between Google Maps lat/lng and tile/pixel
// space) — new code, distinct from the meters-per-pixel formula already
// used elsewhere in this app to pick a zoom level (that one sizes a radius
// in meters; this one places a specific point in pixel space).
function worldCoordinate(lat, lng) {
  const siny = Math.min(Math.max(Math.sin(lat * Math.PI / 180), -0.9999), 0.9999);
  return {
    x: 256 * (0.5 + lng / 360),
    y: 256 * (0.5 - Math.log((1 + siny) / (1 - siny)) / (4 * Math.PI)),
  };
}

// Nudges overlapping marker circles apart, symmetrically, along the line
// connecting their centers — a few passes of simple circle-packing
// relaxation (trivial at this scale, at most ~5-6 markers per cluster map).
// Positional precision is deliberately sacrificed for readability here, per
// the user's explicit answer (round 2026-06-22, overlap-fix pass): bigger
// markers + tighter zoom (the previous readability pass) made same-cluster
// spots collide more often than the original, smaller-marker version did.
function resolveOverlaps(positions, iterations = 20, padding = 3) {
  for (let iter = 0; iter < iterations; iter++) {
    let moved = false;
    for (let i = 0; i < positions.length; i++) {
      for (let j = i + 1; j < positions.length; j++) {
        const a = positions[i], b = positions[j];
        let dx = b.cx - a.cx;
        let dy = b.cy - a.cy;
        let dist = Math.sqrt(dx * dx + dy * dy);
        const minDist = (a.size + b.size) / 2 + padding;
        if (dist < minDist) {
          // Real-world spots can be near-coincident (e.g. a conbini and a
          // supermarket in the same building) — when dist is ~0 the push
          // direction is undefined, so `dx/dist` collapses to 0 and the
          // pair never actually separates. Fall back to a deterministic
          // angle derived from the pair's index so they still push apart.
          if (dist < 0.01) {
            const angle = ((i * 47 + j * 13) % 360) * Math.PI / 180;
            dx = Math.cos(angle); dy = Math.sin(angle); dist = 1;
          }
          const push = (minDist - dist) / 2;
          const ux = dx / dist, uy = dy / dist;
          a.cx -= ux * push; a.cy -= uy * push;
          b.cx += ux * push; b.cy += uy * push;
          moved = true;
        }
      }
    }
    if (!moved) break;
  }
}

// `mapBuffer`: the already-fetched Static Map PNG — bare, no markers=
// baked in by Static Maps for this map (round 2026-06-22, overlap-fix
// pass: the hotel's own marker is now just another entry in `iconMarkers`
// instead of a separate native Static Maps pin, so it participates in the
// same overlap-avoidance pass as every spot marker).
// `mapOpts`: { center: {lat,lng}, zoom, size: '600x400', scale } — the same
// params already passed to buildStaticMapUrl() for this map, needed to
// reproduce its exact pixel space.
// `iconMarkers`: [{ lat, lng, colorHex, iconMaskBaseUri, customGlyph, label }].
// Returns the composited buffer, or the original buffer unchanged if there
// are no markers to place.
async function compositeSpotIcons(mapBuffer, { center, zoom, size, scale = 1 }, iconMarkers) {
  if (!iconMarkers || !iconMarkers.length) return mapBuffer;

  const [boxWidth, boxHeight] = size.split('x').map(Number);
  const imgWidth = boxWidth * scale;
  const imgHeight = boxHeight * scale;
  const centerWorld = worldCoordinate(center.lat, center.lng);
  const pixelsPerWorldUnit = Math.pow(2, zoom) * scale;

  // Phase 1: ideal (pre-overlap-resolution) pixel position + rendered
  // image for every marker.
  const positions = [];
  for (const m of iconMarkers) {
    if (m.lat == null || m.lng == null) continue;
    const world = worldCoordinate(m.lat, m.lng);
    const cx = imgWidth / 2 + (world.x - centerWorld.x) * pixelsPerWorldUnit;
    const cy = imgHeight / 2 + (world.y - centerWorld.y) * pixelsPerWorldUnit;

    let marker;
    try {
      marker = await buildMarkerImage(m, scale);
    } catch (err) {
      console.error('mapIcons: failed to build marker image', err);
      continue;
    }
    positions.push({ cx, cy, size: marker.size, buffer: marker.buffer });
  }
  if (!positions.length) return mapBuffer;

  // Phase 2: nudge overlapping markers apart.
  resolveOverlaps(positions, 20, 3 * scale);

  // Phase 3: clamp into the frame instead of dropping off-frame markers —
  // no marker should silently disappear, even if nudged from its ideal spot.
  for (const p of positions) {
    p.cx = Math.min(Math.max(p.cx, p.size / 2), imgWidth - p.size / 2);
    p.cy = Math.min(Math.max(p.cy, p.size / 2), imgHeight - p.size / 2);
  }

  // Phase 4: composite.
  const composites = positions.map(p => ({
    input: p.buffer,
    left: Math.round(p.cx - p.size / 2),
    top: Math.round(p.cy - p.size / 2),
  }));
  return sharp(mapBuffer).composite(composites).png().toBuffer();
}

module.exports = { compositeSpotIcons, worldCoordinate };
