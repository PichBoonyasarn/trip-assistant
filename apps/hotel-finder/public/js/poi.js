async function fetchWorksiteHospitals(lat, lng, radius) {
  try {
    const url = `/api/poi/hospitals?lat=${lat}&lng=${lng}` + (radius ? `&radius=${radius}` : '');
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`病院検索エラー: ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(`病院検索: ${data.error}`);
    return data.hospitals || [];
  } catch (err) { console.log('fetchWorksiteHospitals failed:', err.message); return []; }
}

async function fetchAmenityCounts(lat, lng, radius) {
  const empty = { convenienceStores: 0, restaurants: 0, izakaya: 0, bars: 0, supermarkets: 0, parking: 0 };
  try {
    const url = `/api/poi/amenity-counts?lat=${lat}&lng=${lng}` + (radius ? `&radius=${radius}` : '');
    const res = await fetch(url, { cache: 'no-store' });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `周辺施設カウントエラー: ${res.status}`);
    return data;
  } catch (err) { console.log('fetchAmenityCounts failed:', err.message); return empty; }
}

async function fetchHotelSpots(lat, lng, opts) {
  opts = opts || {};
  try {
    const params = `lat=${lat}&lng=${lng}` +
      (opts.radius ? `&radius=${opts.radius}` : '') +
      (opts.diningRadius ? `&diningRadius=${opts.diningRadius}` : '') +
      (opts.barRadius ? `&barRadius=${opts.barRadius}` : '') +
      (opts.travelRadius ? `&travelRadius=${opts.travelRadius}` : '');
    const res = await fetch(`/api/poi/hotel-spots?${params}`, { cache: 'no-store' });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `周辺スポット検索エラー: ${res.status}`);
    return data;
  } catch (err) { console.log('fetchHotelSpots failed:', err.message); return { error: err.message }; }
}

const HOTEL_SPOT_CATEGORIES = [
  { key: 'convenienceStores', label: 'コンビニ' },
  { key: 'supermarkets', label: 'スーパー' },
  { key: 'restaurants', label: 'レストラン' },
  { key: 'izakaya', label: '居酒屋' },
  { key: 'bars', label: 'バー' },
  { key: 'travelSpots', label: '観光スポット' },
];

// A photo proxy hit is a real, separate billed request (unlike the free
// photoRef returned alongside the search) — only rendered when `withThumbs`
// is true, i.e. once the category's tab has actually been viewed. See
// renderHotelSpotsPanel's lazy-loading below.
function renderSpotThumb(s) {
  if (!s.photoRef) return '<div class="no-photo spot-thumb">写真なし</div>';
  const src = `/api/poi/photo?name=${encodeURIComponent(s.photoRef)}&maxWidthPx=160`;
  return `<img src="${src}" class="hotel-photo spot-thumb" alt="${s.name}" loading="lazy" onerror="this.outerHTML='<div class=&quot;no-photo spot-thumb&quot;>写真なし</div>'">`;
}

function renderSpotList(spots, emptyLabel, withThumbs) {
  if (!spots || !spots.length) return `<li class="ai-empty">${emptyLabel}</li>`;
  return spots.slice(0, 10).map(s => `
    <li>
      ${withThumbs ? renderSpotThumb(s) : ''}
      <div class="spot-info">
        <strong>${s.name}</strong>
        ${s.description ? `<span class="spot-desc">${s.description}</span>` : ''}
        <span>${s.distance != null ? s.distance + ' km' : ''}</span>
        <a href="${s.mapLink}" target="_blank">地図</a>
      </div>
    </li>`).join('');
}

// Tab toggle is wired with addEventListener scoped to this panel's own
// container (not a document-wide querySelectorAll like the AI-recommendation
// tabs use) so it can't collide with that unrelated tab group's click
// handler — see docs/feature-roadmap.md.
function switchSpotTab(container, category) {
  container.querySelectorAll('.spot-tab').forEach(t => t.classList.remove('active'));
  container.querySelector(`[data-spot-category="${category}"]`).classList.add('active');
  container.querySelectorAll('.spot-content').forEach(c => c.classList.remove('active'));
  container.querySelector(`#spot-content-${category}`).classList.add('active');
}

function renderHotelSpotsPanel(spots, containerId) {
  const container = document.getElementById(containerId || 'hotelSpotsPanel');
  if (!container) return;
  if (!spots || spots.error) {
    container.innerHTML = `<div class="ai-empty">${spots && spots.error ? spots.error : '周辺スポットを取得できませんでした'}</div>`;
    return;
  }

  const tabsHtml = HOTEL_SPOT_CATEGORIES.map((c, i) => `
    <button class="spot-tab${i === 0 ? ' active' : ''}" data-spot-category="${c.key}">${c.label} (${(spots[c.key] || []).length})</button>`).join('');
  // No thumbnails yet — every photo is a separate billed request, so the
  // initial render stays text-only and renderThumbsForCategory() below
  // fills in <img> tags only for tabs actually viewed.
  const contentsHtml = HOTEL_SPOT_CATEGORIES.map((c, i) => `
    <div class="spot-content${i === 0 ? ' active' : ''}" id="spot-content-${c.key}">
      <ul class="hospital-list" data-spot-list="${c.key}">${renderSpotList(spots[c.key], '見つかりませんでした', false)}</ul>
    </div>`).join('');

  container.innerHTML = `<div class="spot-tabs">${tabsHtml}</div>${contentsHtml}`;

  const loadedThumbCategories = new Set();
  const renderThumbsForCategory = (category) => {
    if (loadedThumbCategories.has(category)) return;
    loadedThumbCategories.add(category);
    const list = container.querySelector(`[data-spot-list="${category}"]`);
    if (list) list.innerHTML = renderSpotList(spots[category], '見つかりませんでした', true);
  };

  container.querySelectorAll('.spot-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const category = tab.getAttribute('data-spot-category');
      switchSpotTab(container, category);
      renderThumbsForCategory(category);
    });
  });

  renderThumbsForCategory(HOTEL_SPOT_CATEGORIES[0].key);
}

function renderHospitalPanel(hospitals, containerId) {
  const container = document.getElementById(containerId || 'hospitalPanel');
  if (!container) return;
  if (!hospitals || hospitals.length === 0) {
    container.innerHTML = '<div class="ai-empty">現場周辺50km以内に病院が見つかりませんでした</div>';
    return;
  }
  const top = hospitals.slice(0, 5);
  container.innerHTML = `
    <div class="hospital-count">最も近い病院 ${hospitals.length} 件</div>
    <ul class="hospital-list">
      ${top.map((h, i) => `
        <li>
          <span class="hospital-num">${i + 1}</span>
          <strong>${h.name}</strong>
          <span>${h.distance != null ? h.distance + ' km' : ''}</span>
          ${h.phone ? `<span>${h.phone}</span>` : ''}
          <a href="${h.mapLink}" target="_blank">地図</a>
        </li>`).join('')}
    </ul>`;
}
