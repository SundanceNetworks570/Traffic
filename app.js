// app.js (v3) — multi-proxy support + better diagnostics
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
    coverageBanner: document.getElementById('coverageBanner'),
    errors: document.getElementById('errors'),
    debug: document.getElementById('debug'),
  };

  // --- Configuration -------------------------------------------------------
  // Choose one of the following proxy modes:
  // 'none'   -> direct fetch (works only if endpoint sends CORS headers for browsers)
  // 'prefix' -> prepend PROXY_URL + realUrl (e.g., https://cors.isomorphic-git.org/https://target)
  // 'query'  -> use PROXY_URL + encodeURIComponent(realUrl) (e.g., https://api.allorigins.win/raw?url=...)
  const PROXY_MODE = 'query';
  const PROXY_URLS = {
    prefix: 'https://cors.isomorphic-git.org/',
    query:  'https://api.allorigins.win/raw?url=',
  };

  // Provider: 511PA (public endpoint used here)
  const PROVIDERS = {
    PA: {
      enabled: true,
      key: '',
      eventsUrl: () => 'https://www.511pa.com/api/events/getevents'
    }
  };

  // WZDx feeds (PA)
  const WZDX_FEEDS = [
    { name: 'Pennsylvania WZDx', url: 'https://www.511pa.com/wzdx/work-zones' },
  ];

  // --- Helpers -------------------------------------------------------------
  const fmt = {
    date(dt) { try { return new Date(dt).toLocaleString(); } catch { return String(dt); } },
    miles(km) { return (km * 0.621371).toFixed(1); },
  };
  const sleep = (ms) => new Promise(res => setTimeout(res, ms));

  function haversineKm(a, b){
    const R = 6371;
    const dLat = (b.lat - a.lat) * Math.PI/180;
    const dLon = (b.lon - a.lon) * Math.PI/180;
    const lat1 = a.lat * Math.PI/180;
    const lat2 = b.lat * Math.PI/180;
    const s = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }

  function withProxy(url){
    if(PROXY_MODE === 'prefix') return PROXY_URLS.prefix + url;
    if(PROXY_MODE === 'query')  return PROXY_URLS.query + encodeURIComponent(url);
    return url;
  }

  async function fetchJSON(url){
    const reqUrl = withProxy(url);
    try{
      const res = await fetch(reqUrl, { headers: { 'Accept': 'application/json' } });
      if(!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    }catch(err){
      logError(`Fetch failed: ${url} -> ${err.message}`);
      throw err;
    }
  }

  function logError(msg){
    if(UI.errors) UI.errors.textContent = '✖ ' + msg;
    if(UI.debug) UI.debug.textContent += msg + '\n';
    console.error(msg);
  }

  async function geocodeZip(zip){
    const data = await fetchJSON(`https://api.zippopotam.us/us/${encodeURIComponent(zip)}`);
    const p = data.places?.[0];
    if(!p) throw new Error('ZIP not found');
    return {
      lat: parseFloat(p.latitude),
      lon: parseFloat(p.longitude),
      place: `${p["place name"]}, ${p["state abbreviation"]}`,
      state: p["state abbreviation"]
    };
  }

  async function reverseGeocode(lat, lon){
    await sleep(110);
    try{
      const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=18&addressdetails=1`;
      const json = await fetchJSON(url);
      return json.display_name || `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
    }catch{
      return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
    }
  }

  function pointFromGeometry(geom){
    if(!geom) return null;
    if(geom.type === 'Point') return { lat: geom.coordinates[1], lon: geom.coordinates[0] };
    const coords = geom.coordinates;
    if(geom.type === 'LineString' && coords?.length){
      return { lat: coords[0][1], lon: coords[0][0] };
    }
    if(geom.type === 'Polygon' && coords?.[0]?.length){
      return { lat: coords[0][0][1], lon: coords[0][0][0] };
    }
    return null;
  }

  function googleMapsLink(lat, lon){
    return `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`;
  }

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

  async function fetchAllFeeds(centerState){
    const out = [];

    // WZDx
    for(const feed of WZDX_FEEDS){
      try{
        const json = await fetchJSON(feed.url);
        const feats = json.features || [];
        out.push(...feats.map(normalizeWZDxFeature));
      }catch(err){
        logError(`WZDx failed: ${feed.url}`);
      }
    }

    // 511PA (if PA)
    if((centerState || '').toUpperCase() === 'PA' && PROVIDERS.PA.enabled){
      try{
        const events = await fetchJSON(PROVIDERS.PA.eventsUrl(PROVIDERS.PA.key));
        const list = Array.isArray(events) ? events : (events?.events || events?.data || []);
        out.push(...(list || []).map(normalizePAEvent));
      }catch(err){
        logError('511PA request failed. Try switching PROXY_MODE to "prefix" in app.js.');
      }
    }
    return out;
  }

  function renderLoading(){
    UI.results.innerHTML = `<div style="padding:18px 16px;">
      <span class="spinner"></span> Fetching live data…
    </div>`;
    UI.errors.textContent = '';
    UI.debug.textContent = '';
  }

  async function runSearch(zip, radiusMiles){
    localStorage.setItem('lastZip', zip);
    localStorage.setItem('lastRadius', String(radiusMiles));

    renderLoading();
    let center;
    try{
      center = await geocodeZip(zip);
    }catch(err){
      UI.results.innerHTML = `<div style="padding:18px 16px; color:#ff6b6b;">❌ ${err.message || 'ZIP lookup failed.'}</div>`;
      return;
    }

    const all = await fetchAllFeeds(center.state);
    const centerPt = { lat: center.lat, lon: center.lon };
    const kmLimit = radiusMiles / 0.621371;

    const filtered = all
      .filter(x => x.anchor)
      .map(x => ({ ...x, distanceKm: haversineKm(centerPt, x.anchor) }))
      .filter(x => x.distanceKm <= kmLimit)
      .sort((a,b) => a.distanceKm - b.distanceKm);

    // Reverse geocode addresses
    const concurrency = 3; let i = 0;
    async function worker(){
      while(i < filtered.length){
        const idx = i++;
        const item = filtered[idx];
        const addr = await reverseGeocode(item.anchor.lat, item.anchor.lon);
        item.address = addr;
      }
    }
    await Promise.all(Array.from({length: Math.min(concurrency, filtered.length)}, worker));

    // Summary
    UI.summaryZip.textContent = `ZIP: ${zip}`;
    UI.summaryPlace.textContent = `Near: ${center.place}`;
    const counts = {
      work: filtered.filter(f=>f.kind==='work').length,
      closure: filtered.filter(f=>f.kind==='closure').length,
      incident: filtered.filter(f=>f.kind==='incident').length,
      total: filtered.length
    };
    UI.summaryCounts.textContent = `Found: ${counts.total} (work ${counts.work} • closures ${counts.closure} • incidents ${counts.incident})`;
    UI.summaryUpdated.textContent = `Updated: ${new Date().toLocaleString()}`;
    UI.summaryRow.hidden = false;

    if(!filtered.length){
      UI.results.innerHTML = `<div style="padding:18px 16px;">No items within ${radiusMiles} miles. Try a larger radius or switch proxy mode in <code>app.js</code>.</div>`;
      return;
    }

    UI.results.innerHTML = filtered.map(it => {
      const lat = it.anchor.lat.toFixed(5), lon = it.anchor.lon.toFixed(5);
      const maps = googleMapsLink(it.anchor.lat, it.anchor.lon);
      const when = [it.start?`Start: ${fmt.date(it.start)}`:'', it.end?`End: ${fmt.date(it.end)}`:''].filter(Boolean).join(' · ');
      const subtitle = [it.road, it.status, when].filter(Boolean).join(' • ');
      return `<div class="item">
        <div>
          <div>${badgeFor(it)}</div>
          <h3 class="title">${it.title ? it.title.replace(/</g,'&lt;') : 'Road Work'}</h3>
          <div class="subtle">${it.address ? it.address.replace(/</g,'&lt;') : `${lat}, ${lon}`}</div>
          ${subtitle ? `<div class="subtle">${subtitle.replace(/</g,'&lt;')}</div>`:''}
        </div>
        <div class="right">
          <div style="margin-bottom:8px;">~${fmt.miles(it.distanceKm)} mi</div>
          <a class="link" target="_blank" rel="noopener" href="${maps}">Open in Google Maps ↗</a>
        </div>
      </div>`;
    }).join('');
  }

  // Wire up UI
  UI.go.addEventListener('click', () => {
    const zip = (UI.zip.value || '').trim();
    const r = parseFloat(UI.radius.value || '50');
    if(!/^\d{5}(-\d{4})?$/.test(zip)){
      UI.results.innerHTML = '<div style="padding:18px 16px; color:#ff6b6b;">Please enter a valid US ZIP (5 digits).</div>';
      return;
    }
    runSearch(zip, r);
  });
  UI.zip.addEventListener('keydown', (e) => { if(e.key === 'Enter') UI.go.click(); });

  window.addEventListener('DOMContentLoaded', () => {
    const lastZip = localStorage.getItem('lastZip');
    const lastRadius = localStorage.getItem('lastRadius') || '50';
    if(lastZip){ UI.zip.value = lastZip; }
    UI.radius.value = lastRadius;
    if(lastZip){ runSearch(lastZip, parseFloat(lastRadius)); }
  });
})();
