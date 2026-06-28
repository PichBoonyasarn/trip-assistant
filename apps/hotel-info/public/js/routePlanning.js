// stopOpts: { stopTypes: ['gas_station','convenience_store'], stopMode: 'route'|'destination', stopLimit: N }
// — all optional, matching /api/routes/leg's defaults (both types, sampled
// along the whole route, no limit) when omitted.
async function fetchRouteLeg(from, to, includeStops, stopOpts) {
  stopOpts = stopOpts || {};
  try {
    const params = `fromLat=${from.lat}&fromLng=${from.lng}&toLat=${to.lat}&toLng=${to.lng}` +
      (includeStops ? '&includeStops=true' : '') +
      (stopOpts.stopTypes ? `&stopTypes=${stopOpts.stopTypes.join(',')}` : '') +
      (stopOpts.stopMode ? `&stopMode=${stopOpts.stopMode}` : '') +
      (stopOpts.stopLimit ? `&stopLimit=${stopOpts.stopLimit}` : '');
    const res = await fetch(`/api/routes/leg?${params}`, { cache: 'no-store' });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `ルート検索エラー: ${res.status}`);
    return data;
  } catch (err) { console.log('fetchRouteLeg failed:', err.message); return { error: err.message }; }
}

function renderStopList(stops, emptyLabel) {
  if (!stops || !stops.length) return `<li class="ai-empty">${emptyLabel}</li>`;
  return stops.slice(0, 5).map(s => `
    <li>
      <strong>${s.name}</strong>
      ${s.hasParkingLot ? '<span class="parking-badge">🅿️ 駐車場あり</span>' : ''}
      <span>${s.distance != null ? s.distance + ' km' : ''}</span>
      <a href="${s.mapLink}" target="_blank">地図 ↗</a>
    </li>`).join('');
}

const DEFAULT_STOP_CATEGORIES = [
  { key: 'gasStations', icon: '⛽', label: 'ガソリンスタンド', emptyLabel: '沿道に見つかりませんでした' },
  { key: 'convenienceStores', icon: '🏪', label: 'コンビニ', emptyLabel: '沿道に見つかりませんでした' },
];

// Renders one leg's distance/duration. If `leg.stops` hasn't been fetched
// yet (the cheap, no-stops call), shows a button that triggers the Places
// lookup only when the user actually wants it — see docs/feature-roadmap.md
// for why this is opt-in rather than automatic. `opts.stopCategories` lets a
// caller render a restricted set of stop types (e.g. window 1 only ever
// requests convenience stores, not gas stations — see opts.stopCategories
// passed from public/index.html); defaults to both, matching /leg's default.
function renderLegPanel(leg, containerId, fromLabel, toLabel, onSearchStops, opts) {
  opts = opts || {};
  const stopCategories = opts.stopCategories || DEFAULT_STOP_CATEGORIES;
  const stopButtonLabel = opts.stopButtonLabel || '沿道のガソリンスタンド・コンビニを検索';

  const container = document.getElementById(containerId);
  if (!container) return;
  if (!leg || leg.error) {
    container.innerHTML = `<div class="ai-empty">${leg && leg.error ? leg.error : 'ルート情報を取得できませんでした'}</div>`;
    return;
  }

  const km  = leg.distanceMeters  != null ? (leg.distanceMeters / 1000).toFixed(1) : '—';
  const min = leg.durationSeconds != null ? Math.round(leg.durationSeconds / 60)    : '—';

  let stopsHtml;
  if (leg.stops) {
    stopsHtml = `
      <div class="route-stops">
        ${stopCategories.map(cat => {
          const items = leg.stops[cat.key] || [];
          return `
            <div class="route-stop-group">
              <strong>${cat.icon} ${cat.label} (${items.length})</strong>
              <ul class="hospital-list">${renderStopList(items, cat.emptyLabel)}</ul>
            </div>`;
        }).join('')}
      </div>`;
  } else {
    stopsHtml = `<button class="btn-ghost btn-route" id="${containerId}-stopsBtn">${stopButtonLabel}</button>`;
  }

  container.innerHTML = `
    <div class="route-leg">
      <div class="route-leg-title">${fromLabel} → ${toLabel}</div>
      <div class="route-leg-meta">${km} km ・ 約${min}分</div>
      ${stopsHtml}
    </div>`;

  if (!leg.stops && onSearchStops) {
    const btn = document.getElementById(`${containerId}-stopsBtn`);
    if (btn) btn.addEventListener('click', onSearchStops);
  }
}

// One map instance + overlay list per element id, so window 1 (出発地→現場)
// and window 2 (現場→ホテル) each keep their own independent map instead of
// sharing/overwriting one global.
const legMapRegistry = new Map();

function clearLegMapOverlays(entry) {
  entry.overlays.forEach(o => o.setMap(null));
  entry.overlays = [];
}

function renderLegMap(leg, fromPos, toPos, fromLabel, toLabel, mapElId) {
  const mapEl = document.getElementById(mapElId);
  if (!mapEl) return;
  if (!leg || leg.error || !leg.path || !leg.path.length) { mapEl.style.display = 'none'; return; }
  mapEl.style.display = 'block';

  let entry = legMapRegistry.get(mapElId);
  if (!entry) {
    entry = {
      map: new google.maps.Map(mapEl, { mapTypeControl: false, streetViewControl: false, fullscreenControl: true }),
      overlays: [],
    };
    legMapRegistry.set(mapElId, entry);
  }
  clearLegMapOverlays(entry);

  const bounds = new google.maps.LatLngBounds();
  const addMarker = (position, title, color) => {
    const marker = new google.maps.Marker({
      position, map: entry.map, title,
      icon: { url: `http://maps.google.com/mapfiles/ms/icons/${color}-dot.png` },
    });
    entry.overlays.push(marker);
    bounds.extend(position);
  };

  addMarker(fromPos, fromLabel, 'blue');
  addMarker(toPos, toLabel, 'red');

  const polyline = new google.maps.Polyline({
    path: leg.path, map: entry.map, strokeColor: '#4a6354', strokeWeight: 4, strokeOpacity: 0.8,
  });
  entry.overlays.push(polyline);
  leg.path.forEach(p => bounds.extend(p));

  if (leg.stops) {
    (leg.stops.gasStations || []).forEach(s => {
      if (s.lat != null && s.lng != null) addMarker({ lat: s.lat, lng: s.lng }, `⛽ ${s.name}`, 'orange');
    });
    (leg.stops.convenienceStores || []).forEach(s => {
      if (s.lat == null || s.lng == null) return;
      addMarker({ lat: s.lat, lng: s.lng }, `🏪 ${s.name}${s.hasParkingLot ? ' (駐車場あり)' : ''}`, s.hasParkingLot ? 'purple' : 'yellow');
    });
  }

  entry.map.fitBounds(bounds);
}
