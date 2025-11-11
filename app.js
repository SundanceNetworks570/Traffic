// GitHub Pages–ready build with proxy + geocoder fallback
(() => {
  const UI = {
    zip: document.getElementById('zipInput'),
    radius: document.getElementById('radius'),
    go: document.getElementById('goBtn'),
    results: document.getElementById('results'),
    summaryRow: document.getElementById('summaryRow'),
    summaryZip: document.getElementById('summaryZip'),
    summaryPlace: document.getElementById('summaryPlace'),
    summaryCounts: document.getElementById('summaryCounts'),
    summaryUpdated: document.getElementById('summaryUpdated'),
    errors: document.getElementById('errors'),
    debug: document.getElementById('debug'),
  };

  // --- Proxy config (enabled by default for GitHub Pages) ------------------
  const PROXY_MODE = 'prefix'; // 'prefix' | 'query' | 'none'
  const PROXY_URLS = {
    prefix: 'https://cors.isomorphic-git.org/',
    query:  'https://api.allorigins.win/raw?url=',
  };

  function withProxy(url){
    if(PROXY_MODE === 'prefix') return PROXY_URLS.prefix + url;
    if(PROXY_MODE === 'query')  return PROXY_URLS.query + encodeURIComponent(url);
    return url;
  }

  function log(msg){
    if(UI.debug) UI.debug.textContent += msg + '\\n';
    console.log(msg);
  }
  function error(msg){
    if(UI.errors) UI.errors.textContent = '✖ ' + msg;
    log('[ERR] ' + msg);
  }

  // --- Fetch helpers -------------------------------------------------------
  async function fetchJSON(url){
    const reqUrl = withProxy(url);
    try{
      const res = await fetch(reqUrl, { headers: { 'Accept': 'application/json' } });
      if(!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    }catch(e){
      error(`Fetch failed: ${url} → ${e.message}`);
      throw e;
    }
  }

  // --- Geocoding (with fallback) -------------------------------------------
  async function geocodeZip(zip){
    // 1) Try Zippopotam.us
    try{
      const data = await fetchJSON(`https://api.zippopotam.us/us/${encodeURIComponent(zip)}`);
      const p = data.places?.[0];
      if(p){
        log('Geocoder: Zippopotam.us');
        return {
          lat: parseFloat(p.latitude),
          lon: parseFloat(p.longitude),
          place: `${p["place name"]}, ${p["state abbreviation"]}`,
          state: p["state abbreviation"]
        };
      }
    }catch{ /* fall through */ }

    // 2) Fallback: Nominatim forward geocode (postalcode + country)
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&country=us&postalcode=${encodeURIComponent(zip)}&limit=1`;
    const data = await fetchJSON(url);
    if(Array.isArray(data) && data[0]){
      log('Geocoder: OSM Nominatim (fallback)');
      const p = data[0];
      const state = (p.address && (p.address.state_code || p.address.state)) || '';
      return {
        lat: parseFloat(p.lat),
        lon: parseFloat(p.lon),
        place: p.display_name || `ZIP ${zip}`,
        state: (state || '').toString().slice(0,2).toUpperCase() // best-effort
      };
    }
    throw new Error('ZIP not found via both geocoders.');
  }

  async function reverseGeocode(lat, lon){
    try{
      const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=18&addressdetails=1`;
      const json = await fetchJSON(url);
      return json.display_name || `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
    }catch{
      return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
    }
  }

  // --- Data providers ------------------------------------------------------
  const WZDX_FEEDS = [
    { name: 'Pennsylvania WZDx', url: 'https://www.511pa.com/wzdx/work-zones' },
  ];
  const PA_EVENTS = () => 'https://www.511pa.com/api/events/getevents';

  function pointFromGeometry(geom){
    if(!geom) return null;
    if(geom.type === 'Point') return { lat: geom.coordinates[1], lon: geom.coordinates[0] };
    const coords = geom.coordinates;
    if(geom.type === 'LineString' && coords?.length)  return { lat: coords[0][1], lon: coords[0][0] };
    if(geom.type === 'Polygon' && coords?.[0]?.length) return { lat: coords[0][0][1], lon: coords[0][0][0] };
    return null;
  }
  function googleMapsLink(lat, lon){ return `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`; }
  function badgeFor(item){
    const t = item.kind;
    if(t === 'work') return '<span class="badge work">Construction</span>';
    if(t === 'closure') return '<span class="badge closure">Closure</span>';
    return '<span class="badge incident">Traffic / Incident</span>';
  }
  function normalizeWZDxFeature(f){
    const p = f.properties || {};
    const anchor = pointFromGeometry(f.geometry);
    const eventType = (p.event_type || p.core_details?.event_type || '').toLowerCase();
    const status = p.core_details?.event_status || p.event_status || p.status || '';
    const kind = (p.is_full_closure || p.core_details?.is_full_closure) ? 'closure'
                : (eventType.includes('work') || eventType.includes('work-zone') || eventType.includes('construction')) ? 'work'
                : 'work';
    return {
      kind,
      title: p.core_details?.name || p.description || p.core_details?.description || 'Road Work',
      road: (p.core_details?.road_names || p.road_names || []).join(', '),
      status,
      start: p.core_details?.start_date || p.start_date || p.start_time || p.start || null,
      end: p.core_details?.end_date || p.end_date || p.end_time || p.end || null,
      anchor,
      raw: p,
      source: 'WZDx'
    };
  }
  function normalizePAEvent(e){
    const lat = e.latitude || e.location?.latitude || e.lat || e.lat1 || e.point?.lat;
    const lon = e.longitude || e.location?.longitude || e.lon || e.long || e.point?.lon;
    const category = (e.category || e.eventType || e.type || e.event_subtype || '').toLowerCase();
    let kind = 'incident';
    if(category.includes('closure')) kind = 'closure';
    if(category.includes('construction') || category.includes('work')) kind = 'work';
    return {
      kind,
      title: e.title || e.headline || e.description || 'Traffic Event',
      road: e.roadName || e.road || e.route || '',
      status: e.status || e.eventStatus || '',
      start: e.startTime || e.start_date || null,
      end: e.endTime || e.end_date || null,
      anchor: (lat && lon) ? { lat: Number(lat), lon: Number(lon) } : null,
      raw: e,
      source: '511PA'
    };
  }

  async function fetchAllFeeds(state){
    const out = [];
    for(const f of WZDX_FEEDS){
      try{
        const json = await fetchJSON(f.url);
        out.push(...(json.features || []).map(normalizeWZDxFeature));
      }catch(e){ error(`WZDx failed: ${f.url}`); }
    }
    if((state||'').toUpperCase() === 'PA'){
      try{
        const events = await fetchJSON(PA_EVENTS());
        const list = Array.isArray(events) ? events : (events?.events || events?.data || []);
        out.push(...(list||[]).map(normalizePAEvent));
      }catch(e){ error('511PA fetch failed.'); }
    }
    return out;
  }

  // --- UI orchestration ----------------------------------------------------
  function renderLoading(){
    UI.results.innerHTML = `<div style="padding:18px 16px;">
      <span class="spinner"></span> Fetching live data…
    </div>`;
    UI.errors.textContent = '';
    UI.debug.textContent = '';
  }

  async function runSearch(zip, radiusMiles){
    renderLoading();
    let center;
    try{
      center = await geocodeZip(zip);
    }catch(err){
      UI.results.innerHTML = `<div style="padding:18px 16px; color:#ffb2b2;">❌ ${err.message}</div>`;
      return;
    }

    const all = await fetchAllFeeds(center.state);
    const kmLimit = radiusMiles / 0.621371;
    const centerPt = { lat: center.lat, lon: center.lon };
    const filtered = all
      .filter(x => x.anchor)
      .map(x => ({ ...x, distanceKm: haversineKm(centerPt, x.anchor) }))
      .filter(x => x.distanceKm <= kmLimit)
      .sort((a,b) => a.distanceKm - b.distanceKm);

    // Reverse geocode addresses (limited concurrency)
    let i = 0; const concurrency = 3;
    async function worker(){ while(i < filtered.length){ const idx = i++; const it = filtered[idx]; it.address = await reverseGeocode(it.anchor.lat, it.anchor.lon); } }
    await Promise.all(Array.from({length: Math.min(concurrency, filtered.length)}, worker));

    // Summary
    UI.summaryZip.textContent = `ZIP: ${zip}`;
    UI.summaryPlace.textContent = `Near: ${center.place}`;
    const counts = { work:0, closure:0, incident:0 };
    filtered.forEach(f => counts[f.kind] = (counts[f.kind]||0)+1);
    UI.summaryCounts.textContent = `Found: ${filtered.length} (work ${counts.work||0} • closures ${counts.closure||0} • incidents ${counts.incident||0})`;
    UI.summaryUpdated.textContent = `Updated: ${new Date().toLocaleString()}`;
    UI.summaryRow.hidden = false;

    if(!filtered.length){
      UI.results.innerHTML = `<div style="padding:18px 16px;">No items within ${radiusMiles} miles. Try a larger radius.</div>`;
      return;
    }

    UI.results.innerHTML = filtered.map(it => {
      const lat = it.anchor.lat.toFixed(5), lon = it.anchor.lon.toFixed(5);
      const when = [it.start?`Start: ${new Date(it.start).toLocaleString()}`:'', it.end?`End: ${new Date(it.end).toLocaleString()}`:''].filter(Boolean).join(' · ');
      const subtitle = [it.road, it.status, when].filter(Boolean).join(' • ');
      const maps = googleMapsLink(it.anchor.lat, it.anchor.lon);
      return `<div class="item">
        <div>
          <div>${badgeFor(it)}</div>
          <h3 class="title">${(it.title||'Road Work').replace(/</g,'&lt;')}</h3>
          <div class="subtle">${(it.address||`${lat}, ${lon}`).replace(/</g,'&lt;')}</div>
          ${subtitle ? `<div class="subtle">${subtitle.replace(/</g,'&lt;')}</div>` : ''}
        </div>
        <div class="right">
          <div style="margin-bottom:8px;">~${fmt.miles(it.distanceKm)} mi</div>
          <a class="link" target="_blank" rel="noopener" href="${maps}">Open in Google Maps ↗</a>
        </div>
      </div>`;
    }).join('');
  }

  // Events
  UI.go.addEventListener('click', () => {
    const zip = (UI.zip.value || '').trim();
    const r = parseFloat(UI.radius.value || '25');
    if(!/^\d{5}(-\d{4})?$/.test(zip)){
      UI.results.innerHTML = '<div style="padding:18px 16px; color:#ffb2b2;">Please enter a valid US ZIP (5 digits).</div>';
      return;
    }
    runSearch(zip, r);
  });
  UI.zip.addEventListener('keydown', (e) => { if(e.key === 'Enter') UI.go.click(); });
})();
