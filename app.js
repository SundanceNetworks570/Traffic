// Self-hosted proxy build with MOCK mode.
// Steps:
// 1) Deploy the Cloudflare Worker in README_CLOUDFLARE_WORKER.txt
// 2) Paste your worker URL below as PROXY_BASE
// 3) Toggle off "Mock data" to use LIVE feeds

(() => {
  const UI = {
    zip: document.getElementById('zipInput'),
    radius: document.getElementById('radius'),
    go: document.getElementById('goBtn'),
    mockToggle: document.getElementById('mockToggle'),
    results: document.getElementById('results'),
    summaryRow: document.getElementById('summaryRow'),
    summaryZip: document.getElementById('summaryZip'),
    summaryPlace: document.getElementById('summaryPlace'),
    summaryCounts: document.getElementById('summaryCounts'),
    summaryUpdated: document.getElementById('summaryUpdated'),
    errors: document.getElementById('errors'),
    debug: document.getElementById('debug'),
    coverageBanner: document.getElementById('coverageBanner'),
  };

  // >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
  // REQUIRED FOR LIVE MODE: set this to your Worker URL,
  // e.g., "https://myproxy.john.workers.dev/?url="
  const PROXY_BASE = ""; // leave empty for mock testing
  // <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<

  // Toggle default from last use
  UI.mockToggle.checked = localStorage.getItem('mock') === '1';
  UI.mockToggle.addEventListener('change', () => {
    localStorage.setItem('mock', UI.mockToggle.checked ? '1' : '0');
  });

  function log(msg){ if(UI.debug) UI.debug.textContent += msg + "\\n"; }
  function error(msg){ if(UI.errors) UI.errors.textContent = '✖ ' + msg; log('[ERR] ' + msg); }
  function withProxy(url){ if(!PROXY_BASE) return url; return PROXY_BASE + encodeURIComponent(url); }

  async function fetchJSON(url){
    const req = withProxy(url);
    const res = await fetch(req, { headers: { 'Accept': 'application/json' } });
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  // Geocoding (OSM only to keep it simple)
  async function geocodeZip(zip){
    if(UI.mockToggle.checked){
      return { lat: 40.983, lon: -75.196, place: "Stroudsburg, PA", state: "PA" };
    }
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&country=us&postalcode=${encodeURIComponent(zip)}&limit=1`;
    const data = await fetchJSON(url);
    if(Array.isArray(data) && data[0]){
      const p = data[0];
      const state = (p.address && (p.address.state_code || p.address.state)) || 'PA';
      return { lat: parseFloat(p.lat), lon: parseFloat(p.lon), place: p.display_name, state: (state || '').slice(0,2).toUpperCase() };
    }
    throw new Error('ZIP not found');
  }

  async function reverseGeocode(lat, lon){
    if(UI.mockToggle.checked) return "I-80 E near Stroudsburg, PA";
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=18&addressdetails=1`;
    try{ const j = await fetchJSON(url); return j.display_name || `${lat.toFixed(5)}, ${lon.toFixed(5)}`; }
    catch{ return `${lat.toFixed(5)}, ${lon.toFixed(5)}`; }
  }

  // Providers
  const WZDX_PA = 'https://www.511pa.com/wzdx/work-zones';
  const PA_EVENTS = 'https://www.511pa.com/api/events/getevents';

  function googleMapsLink(lat, lon){ return `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`; }
  function pointFromGeometry(geom){
    if(!geom) return null;
    if(geom.type === 'Point') return { lat: geom.coordinates[1], lon: geom.coordinates[0] };
    const c = geom.coordinates;
    if(geom.type === 'LineString' && c?.length)  return { lat: c[0][1], lon: c[0][0] };
    if(geom.type === 'Polygon' && c?.[0]?.length) return { lat: c[0][0][1], lon: c[0][0][0] };
    return null;
  }
  function badgeFor(item){ return item.kind==='closure' ? '<span class="badge closure">Closure</span>' : item.kind==='work' ? '<span class="badge work">Construction</span>' : '<span class="badge incident">Traffic / Incident</span>'; }

  function normalizeWZDx(f){
    const p = f.properties || {}, anchor = pointFromGeometry(f.geometry);
    const eventType = (p.event_type || p.core_details?.event_type || '').toLowerCase();
    const kind = (p.is_full_closure || p.core_details?.is_full_closure) ? 'closure' : (eventType.includes('work') || eventType.includes('construction')) ? 'work' : 'work';
    return { kind, title: p.core_details?.name || p.description || 'Road Work', road: (p.core_details?.road_names || p.road_names || []).join(', '), status: p.core_details?.event_status || p.status || '', start: p.core_details?.start_date || p.start_date || null, end: p.core_details?.end_date || p.end_date || null, anchor, source: 'WZDx' };
  }
  function normalizePAEvent(e){
    const lat = e.latitude || e.location?.latitude || e.lat || e.lat1 || e.point?.lat;
    const lon = e.longitude || e.location?.longitude || e.lon || e.long || e.point?.lon;
    const cat = (e.category || e.eventType || e.type || e.event_subtype || '').toLowerCase();
    const kind = cat.includes('closure') ? 'closure' : cat.includes('construction') || cat.includes('work') ? 'work' : 'incident';
    return { kind, title: e.title || e.headline || e.description || 'Traffic Event', road: e.roadName || e.road || e.route || '', status: e.status || e.eventStatus || '', start: e.startTime || e.start_date || null, end: e.endTime || e.end_date || null, anchor: (lat && lon) ? { lat:+lat, lon:+lon } : null, source: '511PA' };
  }

  function haversineKm(a, b){
    const R = 6371, dLat = (b.lat-a.lat)*Math.PI/180, dLon = (b.lon-a.lon)*Math.PI/180;
    const lat1 = a.lat*Math.PI/180, lat2 = b.lat*Math.PI/180;
    const s = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
    return 2*R*Math.asin(Math.sqrt(s));
  }

  function renderLoading(){ UI.results.innerHTML = '<div style="padding:18px 16px;"><span class="spinner"></span> Fetching…</div>'; UI.errors.textContent=''; UI.debug.textContent=''; }

  async function fetchFeeds(state){
    if(UI.mockToggle.checked){
      // Minimal mock items near Stroudsburg
      const mock = [
        { kind:'closure', title:'I-80 EB Lane Closure', road:'I-80', status:'Active', start:Date.now()-3600e3, end:null, anchor:{lat:40.988, lon:-75.194}, source:'MOCK' },
        { kind:'work', title:'SR-611 Construction', road:'611', status:'Planned', start:Date.now()+86400e3, end:null, anchor:{lat:40.992, lon:-75.183}, source:'MOCK' }
      ];
      return mock;
    }
    if(!PROXY_BASE){
      UI.coverageBanner.style.display='block';
      UI.coverageBanner.innerHTML = 'LIVE mode requires a proxy. Deploy the Cloudflare Worker in README and paste its URL into <code>PROXY_BASE</code> in app.js, then turn off Mock data.';
      return [];
    }
    const out = [];
    try{
      const wz = await fetchJSON(WZDX_PA);
      (wz.features || []).forEach(f => out.push(normalizeWZDx(f)));
    }catch(e){ error('WZDx fetch failed'); }
    try{
      const ev = await fetchJSON(PA_EVENTS);
      const list = Array.isArray(ev) ? ev : (ev && (ev.events || ev.data) || []);
      (list||[]).forEach(e => out.push(normalizePAEvent(e)));
    }catch(e){ error('511PA fetch failed'); }
    return out;
  }

  async function runSearch(zip, radiusMiles){
    renderLoading();
    let center;
    try{ center = await geocodeZip(zip); }
    catch(err){ UI.results.innerHTML = `<div style="padding:18px 16px; color:#ffb2b2;">❌ ${err.message}</div>`; return; }

    const all = await fetchFeeds(center.state);
    const kmLimit = radiusMiles / 0.621371;
    const centerPt = { lat:center.lat, lon:center.lon };
    const filtered = all.filter(x=>x.anchor).map(x=>({ ...x, distanceKm: haversineKm(centerPt, x.anchor) })).filter(x=>x.distanceKm<=kmLimit).sort((a,b)=>a.distanceKm-b.distanceKm);

    // addresses
    let i=0; const concurrency=3;
    async function worker(){ while(i<filtered.length){ const idx=i++; const it=filtered[idx]; it.address = await reverseGeocode(it.anchor.lat, it.anchor.lon); } }
    await Promise.all(Array.from({length: Math.min(concurrency, filtered.length)}, worker));

    UI.summaryZip.textContent = `ZIP: ${zip}`;
    UI.summaryPlace.textContent = `Near: ${center.place}`;
    const counts = { work:0, closure:0, incident:0 };
    filtered.forEach(f=>counts[f.kind]=(counts[f.kind]||0)+1);
    UI.summaryCounts.textContent = `Found: ${filtered.length} (work ${counts.work||0} • closures ${counts.closure||0} • incidents ${counts.incident||0})`;
    UI.summaryUpdated.textContent = `Updated: ${new Date().toLocaleString()}`;
    UI.summaryRow.hidden = false;

    if(!filtered.length){ UI.results.innerHTML = `<div style="padding:18px 16px;">No items within ${radiusMiles} miles.</div>`; return; }

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
          <div style="margin-bottom:8px;">~${(it.distanceKm*0.621371).toFixed(1)} mi</div>
          <a class="link" target="_blank" rel="noopener" href="${maps}">Open in Google Maps ↗</a>
        </div>
      </div>`;
    }).join('');
  }

  function googleMapsLink(lat, lon){ return `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`; }

  UI.go.addEventListener('click', () => {
    const zip = (UI.zip.value || '').trim();
    const r = parseFloat(UI.radius.value || '25');
    if(!/^\d{5}(-\d{4})?$/.test(zip)){ UI.results.innerHTML = '<div style="padding:18px 16px; color:#ffb2b2;">Please enter a valid US ZIP (5 digits).</div>'; return; }
    runSearch(zip, r);
  });
  UI.zip.addEventListener('keydown', (e) => { if(e.key === 'Enter') UI.go.click(); });
})();
