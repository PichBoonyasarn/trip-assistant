// Reuses worksiteLat/worksiteLng/companyLat/companyLng/lastHospitals/
// lastStartToWorksiteLeg/lastGenbaSpots/ensureCompanyLocation/fetchRouteLeg/
// fetchGenbaSpots/setStatus — all globals defined in index.html's inline script.

function shapeHospitalsForDoc(hospitals) {
  return (hospitals || []).map(h => ({
    name: h.name, address: h.address, distance: h.distance, lat: h.lat, lng: h.lng,
  }));
}

function shapeGenbaSpotsForDoc(spots) {
  if (!spots || spots.error) return {};
  const shaped = {};
  for (const key of ['restaurants', 'convenienceStores', 'gasStations']) {
    shaped[key] = (spots[key] || []).map(s => ({ name: s.name, distance: s.distance, lat: s.lat, lng: s.lng }));
  }
  return shaped;
}

const MAX_DOC_PATH_POINTS = 100;

function thinPath(path, max) {
  if (!path || path.length <= max) return path || [];
  const step = (path.length - 1) / (max - 1);
  const thinned = [];
  for (let i = 0; i < max; i++) thinned.push(path[Math.round(i * step)]);
  return thinned;
}

function shapeLegForDoc(leg) {
  if (!leg || leg.error) return null;
  return {
    distanceMeters: leg.distanceMeters,
    durationSeconds: leg.durationSeconds,
    path: thinPath(leg.path, MAX_DOC_PATH_POINTS),
  };
}

async function downloadBlobResponse(res, fallbackName) {
  const disposition = res.headers.get('Content-Disposition') || '';
  const match = disposition.match(/filename\*=UTF-8''([^;]+)/);
  const filename = match ? decodeURIComponent(match[1]) : fallbackName;
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function generateDocument() {
  if (worksiteLat == null || worksiteLng == null) return;

  const btn = document.getElementById('generateDocBtn');
  if (btn) { btn.disabled = true; btn.textContent = '生成中…'; }
  setStatus('計画書を生成中…');

  try {
    const worksite = { lat: worksiteLat, lng: worksiteLng };
    const company = await ensureCompanyLocation();

    if (!shapeLegForDoc(lastStartToWorksiteLeg)) {
      lastStartToWorksiteLeg = await fetchRouteLeg(company, worksite, false);
    }
    if (!lastGenbaSpots || lastGenbaSpots.error) {
      lastGenbaSpots = await fetchGenbaSpots(worksite.lat, worksite.lng);
    }

    const worksiteAddressInput = document.getElementById('worksiteAddress').value.trim();

    const payload = {
      worksite: {
        lat: worksite.lat,
        lng: worksite.lng,
        address: worksiteAddressInput || `${worksite.lat}, ${worksite.lng}`,
        name: worksiteAddressInput,
      },
      company: { lat: company.lat, lng: company.lng },
      routeToWorksite: shapeLegForDoc(lastStartToWorksiteLeg),
      hospitals: shapeHospitalsForDoc(lastHospitals),
      genbaSpots: shapeGenbaSpotsForDoc(lastGenbaSpots),
    };

    const res = await fetch('/api/document/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `計画書生成エラー: ${res.status}`);
    }
    await downloadBlobResponse(res, `keikakusho_genba_${worksiteAddressInput || 'genba'}.docx`);
    setStatus('計画書をダウンロードしました。', true);
  } catch (err) {
    setStatus(err.message || '計画書の生成に失敗しました。');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '計画書を生成'; }
  }
}
