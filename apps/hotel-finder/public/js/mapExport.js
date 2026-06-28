// Depends on buildDocPayload()/downloadBlobResponse()/setStatus(), defined
// in documentGen.js (loaded before this file) — same plain-global
// communication pattern this app uses everywhere, no module system.

// 駐車場 (round 2026-06-23) — deliberately scoped to this KML export only,
// not the live 周辺スポット panel or the .docx, so this fetch lives here
// rather than inside buildDocPayload()/fetchHotelSpots() (which both feed
// the .docx too). Same fetch-and-shape pattern as public/js/poi.js's
// fetchHotelSpots(), just for the one new /api/poi/parking endpoint.
async function fetchParkingSpots(lat, lng) {
  try {
    const res = await fetch(`/api/poi/parking?lat=${lat}&lng=${lng}`, { cache: 'no-store' });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `駐車場検索エラー: ${res.status}`);
    return data.parking || [];
  } catch (err) { console.log('fetchParkingSpots failed:', err.message); return []; }
}

// Generates and downloads a Google My Maps-importable .kmz for hotel `idx`.
// Reuses the same data buildDocPayload() already gathers for the .docx, plus
// one KML-only addition (駐車場) merged in afterward — no new Google API
// calls beyond that one parking search.
async function exportToMyMaps(idx) {
  const btn = document.getElementById(`kmlExportBtn-${idx}`);
  if (btn) { btn.disabled = true; btn.textContent = '出力中…'; }
  setStatus('My Maps用ファイルを生成中…');

  try {
    const payload = await buildDocPayload(idx, { fullPath: true });
    if (!payload) return;
    payload.parkingSpots = await fetchParkingSpots(payload.hotel.lat, payload.hotel.lng);

    const res = await fetch('/api/map-export/kml', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `My Maps出力エラー: ${res.status}`);
    }
    await downloadBlobResponse(res, `mymaps_${payload.hotel.name || 'hotel'}.kmz`);
    setStatus('My Maps用ファイルをダウンロードしました。', true);
  } catch (err) {
    setStatus(err.message || 'My Maps用ファイルの生成に失敗しました。');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'My Mapsへ出力'; }
  }
}
