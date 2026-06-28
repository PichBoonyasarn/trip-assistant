const fs = require('fs');
const path = require('path');
const express = require('express');
const router = express.Router();
const { XMLBuilder } = require('fast-xml-parser');
const JSZip = require('jszip');
const { HOTEL_SPOT_LABELS, HOTEL_MARKER_COLOR_HEX, WORKSITE_MARKER_COLOR_HEX } = require('../lib/mapColors');
const { rgbHexToKmlColor } = require('../lib/kmlColor');

// Rounds 1-3 (see docs/feature-roadmap.md's Phase 9 entry) tried Google's
// generic mapfiles/kml/shapes/*.png icons + KML <IconStyle><color> tinting —
// colors snapped unpredictably on import and icons collided across
// categories. Round 4: the user styled real points in My Maps' own editor
// (their own icon + color choices) and exported the result as a .kmz. That
// .kmz embeds the actual chosen icons as local PNGs with NO <color> tag at
// all — the color is baked into each image. These 10 files (extracted
// verbatim from that real, user-verified export) are bundled here as repo
// assets and re-zipped into every KMZ this route generates — pixel-exact to
// what the user picked, and a one-time embed, not a live fetch: this is NOT
// the self-hosting the user declined twice (no server dependency once the
// file is downloaded; fully portable, works offline, forever).
const ICON_DIR = path.join(__dirname, '..', 'assets', 'kml-icons');
const ICON_FILES = {
  hotel: 'hotel.png',
  worksite: 'worksite.png',
  hospital: 'hospital.png',
  parking: 'parking.png',
  convenienceStores: 'convenienceStores.png',
  supermarkets: 'supermarkets.png',
  restaurants: 'restaurants.png',
  izakaya: 'izakaya.png',
  bars: 'bars.png',
  travelSpots: 'travelSpots.png',
};
const ICON_PATH = key => `images/${ICON_FILES[key]}`; // relative path used inside doc.kml, matching the user's own KMZ convention

const builder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  format: true,
  suppressEmptyNode: true,
});

// KML coordinates are `lon,lat[,alt]` — the reverse of this app's {lat,lng}
// convention used everywhere else. Centralized here since it's the easiest
// bug to introduce in this file.
function toKmlCoord({ lat, lng }) {
  return `${lng},${lat},0`;
}

function pointStyle(id, iconKey) {
  return {
    '@_id': id,
    IconStyle: { Icon: { href: ICON_PATH(iconKey) } },
  };
}

function lineStyle(id, colorHex, width) {
  return {
    '@_id': id,
    LineStyle: { color: rgbHexToKmlColor(colorHex), width },
  };
}

function placemark(name, { lat, lng }, styleId, description) {
  if (lat == null || lng == null) return null;
  return {
    name,
    ...(description ? { description } : {}),
    styleUrl: `#${styleId}`,
    Point: { coordinates: toKmlCoord({ lat, lng }) },
  };
}

function spotDescription(spot) {
  const parts = [];
  if (spot.address) parts.push(spot.address);
  if (spot.phone) parts.push(spot.phone);
  if (spot.rating != null) parts.push(`評価: ${spot.rating}`);
  return parts.join(' / ') || undefined;
}

function spotFolder(label, spots, styleId) {
  return {
    name: label,
    Placemark: (spots || [])
      .map(s => placemark(s.name, s, styleId, spotDescription(s)))
      .filter(Boolean),
  };
}

function hospitalDescription(h) {
  const parts = [];
  if (h.address) parts.push(h.address);
  if (h.phone) parts.push(h.phone);
  if (h.distance != null) parts.push(`${h.distance}km`);
  return parts.join(' / ') || undefined;
}

function routeLinePlacemark(name, leg, styleId) {
  if (!leg || !leg.path || leg.path.length < 2) return null;
  return {
    name,
    styleUrl: `#${styleId}`,
    LineString: { coordinates: leg.path.map(toKmlCoord).join(' ') },
  };
}

// POST /api/map-export/kml — builds a KMZ file (importable into Google My
// Maps, where each top-level <Folder> becomes a separate toggleable layer —
// capped at 10 layers/map; this file emits 9, or 10 when parkingSpots is
// present) from data the frontend already fetched this session. Same
// request body shape as /api/document/generate
// (worksite/company/hotel/routeToWorksite/routeToHotel/hospitals/hotelSpots)
// plus one KML-only addition, `parkingSpots` — 駐車場 is deliberately scoped
// to this export only (not the live 周辺スポット panel, not the .docx), so it
// isn't part of lib/mapColors.js's shared category list; see
// public/js/mapExport.js's fetchParkingSpots() for where it's fetched.
// No fetch() calls anywhere in THIS file — pure synchronous string-building
// + local file reads, so this route itself costs zero additional Google API
// calls (the parking search happens earlier, client-side, see
// routes/poi.js's /parking endpoint for that cost).
router.post('/kml', async (req, res) => {
  const { worksite, hotel, routeToWorksite, routeToHotel, hospitals, hotelSpots, parkingSpots } = req.body || {};
  if (!worksite || !hotel) return res.status(400).json({ error: 'worksite and hotel are required' });

  const safeHotelSpots = hotelSpots || {};
  const categoryKeys = Object.keys(HOTEL_SPOT_LABELS);

  const styles = [
    pointStyle('hotelStyle', 'hotel'),
    pointStyle('worksiteStyle', 'worksite'),
    pointStyle('hospitalStyle', 'hospital'),
    pointStyle('parkingStyle', 'parking'),
    ...categoryKeys.map(key => pointStyle(`${key}Style`, key)),
    lineStyle('routeToWorksiteStyle', WORKSITE_MARKER_COLOR_HEX, 4),
    lineStyle('routeToHotelStyle', HOTEL_MARKER_COLOR_HEX, 4),
  ];

  const stayFolder = {
    name: '宿泊・現場・ルート',
    Placemark: [
      placemark(hotel.name || '宿', hotel, 'hotelStyle', hotel.address),
      placemark('現場', worksite, 'worksiteStyle', worksite.address),
      routeLinePlacemark('現場までのルート', routeToWorksite, 'routeToWorksiteStyle'),
      routeLinePlacemark('宿までのルート', routeToHotel, 'routeToHotelStyle'),
    ].filter(Boolean),
  };

  const hospitalFolder = {
    name: '病院',
    Placemark: (hospitals || [])
      .map(h => placemark(h.name, h, 'hospitalStyle', hospitalDescription(h)))
      .filter(Boolean),
  };

  const spotFolders = categoryKeys.map(key =>
    spotFolder(HOTEL_SPOT_LABELS[key], safeHotelSpots[key], `${key}Style`));

  const folders = [stayFolder, hospitalFolder, ...spotFolders];
  if (parkingSpots && parkingSpots.length) {
    folders.push(spotFolder('駐車場', parkingSpots, 'parkingStyle'));
  }

  const kmlObj = {
    kml: {
      '@_xmlns': 'http://www.opengis.net/kml/2.2',
      Document: {
        name: hotel.name || 'hotel-finder export',
        Style: styles,
        Folder: folders,
      },
    },
  };

  try {
    const xml = '<?xml version="1.0" encoding="UTF-8"?>\n' + builder.build(kmlObj);

    const zip = new JSZip();
    zip.file('doc.kml', xml);
    const imagesFolder = zip.folder('images');
    for (const file of new Set(Object.values(ICON_FILES))) {
      imagesFolder.file(file, fs.readFileSync(path.join(ICON_DIR, file)));
    }
    const kmzBuffer = await zip.generateAsync({ type: 'nodebuffer' });

    const filename = `mymaps_${(hotel.name || 'hotel').replace(/[^\w　-鿿]/g, '_')}.kmz`;
    res.set('Content-Type', 'application/vnd.google-earth.kmz');
    res.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.send(kmzBuffer);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
