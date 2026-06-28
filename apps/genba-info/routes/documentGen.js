const express = require('express');
const router = express.Router();
const { Document, Packer, Paragraph, TextRun, ImageRun, HeadingLevel } = require('docx');
const { fetchStaticMapImage } = require('../lib/staticMap');

const GOOGLE_MAPS_KEY = process.env.GOOGLE_MAPS_KEY || '';
const MAP_SIZE = '600x400';
const MAP_WIDTH_PX = 600;
const MAP_HEIGHT_PX = 400;

const GENBA_SPOT_LABELS = {
  restaurants:       'レストラン',
  convenienceStores: 'コンビニ',
  gasStations:       'ガソリンスタンド',
};
const GENBA_SPOT_COLORS = {
  restaurants:       'orange',
  convenienceStores: 'green',
  gasStations:       'yellow',
};
const GENBA_SPOT_MAP_LIMIT = 3;

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

function imageParagraph(buffer) {
  return new Paragraph({
    children: [new ImageRun({
      type: 'png',
      data: buffer,
      transformation: { width: MAP_WIDTH_PX / 2, height: MAP_HEIGHT_PX / 2 },
    })],
  });
}

async function fetchMap(opts) {
  return fetchStaticMapImage({ size: MAP_SIZE, scale: 2, ...opts }, GOOGLE_MAPS_KEY);
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

function buildGenbaSpotMarkers(worksite, genbaSpots) {
  const markers = [{ lat: worksite.lat, lng: worksite.lng, label: 'G', color: 'red' }];
  for (const [key, color] of Object.entries(GENBA_SPOT_COLORS)) {
    (genbaSpots[key] || []).slice(0, GENBA_SPOT_MAP_LIMIT).forEach(s => {
      if (s.lat != null && s.lng != null) markers.push({ lat: s.lat, lng: s.lng, color });
    });
  }
  return markers;
}

function genbaSpotLines(genbaSpots) {
  const paragraphs = [];
  for (const [key, label] of Object.entries(GENBA_SPOT_LABELS)) {
    const items = (genbaSpots[key] || []).slice(0, GENBA_SPOT_MAP_LIMIT);
    const text = items.length
      ? items.map(s => `${s.name}${s.distance != null ? `(${s.distance}km)` : ''}`).join('、')
      : '見つかりませんでした';
    paragraphs.push(line(`${label}: ${text}`));
  }
  return paragraphs;
}

function hospitalLines(hospitals) {
  if (!hospitals.length) return [line('見つかりませんでした')];
  return hospitals.slice(0, 3).map(h =>
    line(`${h.name} / ${h.address || '住所不明'} / ${h.distance != null ? h.distance + 'km' : '距離不明'}`));
}

router.post('/generate', async (req, res) => {
  if (!GOOGLE_MAPS_KEY) return res.status(500).json({ error: 'GOOGLE_MAPS_KEY is not configured' });

  const { worksite, company, routeToWorksite, hospitals, genbaSpots } = req.body || {};
  if (!worksite) return res.status(400).json({ error: 'worksite is required' });

  const safeHospitals = hospitals || [];
  const safeGenbaSpots = genbaSpots || {};

  try {
    const [worksiteMapBuf, toWorksiteMapBuf, genbaSpotMapBuf] = await Promise.all([
      fetchMap({ markers: buildWorksiteMarkers(worksite, safeHospitals) }),
      routeToWorksite && company
        ? fetchMap({
            markers: [
              { lat: company.lat, lng: company.lng, label: 'A', color: 'blue' },
              { lat: worksite.lat, lng: worksite.lng, label: 'B', color: 'red' },
            ],
            path: routeToWorksite.path || [],
          })
        : null,
      fetchMap({ markers: buildGenbaSpotMarkers(worksite, safeGenbaSpots) }),
    ]);

    const children = [
      heading('現場所在地'),
      line(worksite.address || `${worksite.lat}, ${worksite.lng}`),
      imageParagraph(worksiteMapBuf),
    ];

    if (toWorksiteMapBuf && routeToWorksite) {
      children.push(
        heading('出発地 → 現場 ルート'),
        line(`${formatDistance(routeToWorksite.distanceMeters)} ・ 約${formatDuration(routeToWorksite.durationSeconds)}`),
        imageParagraph(toWorksiteMapBuf),
      );
    }

    children.push(
      heading('現場周辺施設'),
      ...genbaSpotLines(safeGenbaSpots),
      imageParagraph(genbaSpotMapBuf),

      heading('最寄病院'),
      ...hospitalLines(safeHospitals),
    );

    const doc = new Document({ sections: [{ children }] });
    const buffer = await Packer.toBuffer(doc);

    const worksiteName = worksite.name || worksite.address || 'genba';
    const filename = `keikakusho_genba_${worksiteName.replace(/[^\w　-鿿]/g, '_')}.docx`;
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.send(buffer);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
