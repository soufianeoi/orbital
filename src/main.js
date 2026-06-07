import Globe from 'globe.gl';
import * as satellite from 'satellite.js';

/* ===== Config ===== */
const CELESTRAK_BASE = 'https://celestrak.org/NORAD/elements/gp.php';
const RETRIES = 3;
const RETRY_DELAY = 1500;
const UPDATE_INTERVAL = 1000; // ms
const TRAIL_LENGTH = 90; // minutes of orbit trail
const TRAIL_POINTS = 45; // points in trail

const CATEGORIES = {
  iss: { name: 'ISS', color: '#ffd700', noradId: 25544 },
  starlink: { name: 'Starlink', color: '#a855f7', group: 'starlink' },
  active: { name: 'Active', color: '#00d4ff', group: 'active' },
  debris: { name: 'Debris', color: '#ef4444', group: 'debris' },
};

/* ===== State ===== */
const state = {
  satellites: [], // { name, noradId, tle1, tle2, category, satrec, color }
  filteredSats: [],
  activeCategory: 'all',
  selectedSat: null,
  userLocation: null, // { lat, lng, name }
  showTrails: true,
  showLabels: true,
  globe: null,
  trailCache: new Map(), // noradId -> path data
  pointCache: new Map(), // noradId -> point data
  lastUpdate: 0,
  animationId: null,
};

/* ===== Utilities ===== */
function $(sel) { return document.querySelector(sel); }
function $$(sel) { return document.querySelectorAll(sel); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatUTC(date) {
  return date.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

function formatDuration(minutes) {
  const m = Math.floor(minutes);
  const s = Math.floor((minutes - m) * 60);
  return `${m}m ${s}s`;
}

function degToRad(d) { return d * Math.PI / 180; }
function radToDeg(r) { return r * 180 / Math.PI; }

/* ===== TLE Fetching ===== */
async function fetchWithRetry(url, retries = RETRIES) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { mode: 'cors' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      console.warn(`Fetch attempt ${i + 1} failed:`, err.message);
      if (i === retries - 1) throw err;
      await sleep(RETRY_DELAY * (i + 1));
    }
  }
}

function parseTLE(text, category) {
  const lines = text.trim().split('\n').map(l => l.trim()).filter(l => l);
  const sats = [];

  for (let i = 0; i < lines.length; i += 3) {
    if (i + 2 >= lines.length) break;
    const name = lines[i];
    const tle1 = lines[i + 1];
    const tle2 = lines[i + 2];

    if (!tle1.startsWith('1 ') || !tle2.startsWith('2 ')) continue;

    const noradId = parseInt(tle1.substring(2, 7).trim());
    const satrec = satellite.twoline2satrec(tle1, tle2);

    if (!satrec) continue;

    sats.push({
      name: name.trim(),
      noradId,
      tle1,
      tle2,
      category,
      satrec,
      color: CATEGORIES[category].color,
    });
  }

  return sats;
}

async function loadSatellites() {
  const allSats = [];

  // Load ISS
  try {
    const issText = await fetchWithRetry(`${CELESTRAK_BASE}?CATNR=25544&FORMAT=tle`);
    const issSats = parseTLE(issText, 'iss');
    allSats.push(...issSats);
    console.log(`Loaded ${issSats.length} ISS objects`);
  } catch (e) {
    console.warn('Failed to load ISS:', e.message);
  }

  // Load Starlink (limited to first 200 for performance)
  try {
    const starText = await fetchWithRetry(`${CELESTRAK_BASE}?GROUP=starlink&FORMAT=tle`);
    const starSats = parseTLE(starText, 'starlink').slice(0, 200);
    allSats.push(...starSats);
    console.log(`Loaded ${starSats.length} Starlink objects`);
  } catch (e) {
    console.warn('Failed to load Starlink:', e.message);
  }

  // Load active satellites (limited to first 300)
  try {
    const activeText = await fetchWithRetry(`${CELESTRAK_BASE}?GROUP=active&FORMAT=tle`);
    const activeSats = parseTLE(activeText, 'active').slice(0, 300);
    // Filter out ISS and Starlink duplicates
    const existingIds = new Set(allSats.map(s => s.noradId));
    const filteredActive = activeSats.filter(s => !existingIds.has(s.noradId));
    allSats.push(...filteredActive);
    console.log(`Loaded ${filteredActive.length} active satellites`);
  } catch (e) {
    console.warn('Failed to load active:', e.message);
  }

  // Load debris (limited to first 200)
  try {
    const debrisText = await fetchWithRetry(`${CELESTRAK_BASE}?GROUP=debris&FORMAT=tle`);
    const debrisSats = parseTLE(debrisText, 'debris').slice(0, 200);
    const existingIds = new Set(allSats.map(s => s.noradId));
    const filteredDebris = debrisSats.filter(s => !existingIds.has(s.noradId));
    allSats.push(...filteredDebris);
    console.log(`Loaded ${filteredDebris.length} debris objects`);
  } catch (e) {
    console.warn('Failed to load debris:', e.message);
  }

  state.satellites = allSats;
  state.filteredSats = allSats;
  console.log(`Total: ${allSats.length} satellites loaded`);
}

/* ===== Orbit Propagation ===== */
function propagateSatellite(sat, date = new Date()) {
  const positionAndVelocity = satellite.propagate(sat.satrec, date);
  if (!positionAndVelocity.position) return null;

  const gmst = satellite.gstime(date);
  const position = satellite.eciToGeodetic(positionAndVelocity.position, gmst);

  return {
    lat: radToDeg(position.latitude),
    lng: radToDeg(position.longitude),
    alt: position.height,
    velocity: Math.sqrt(
      positionAndVelocity.velocity.x ** 2 +
      positionAndVelocity.velocity.y ** 2 +
      positionAndVelocity.velocity.z ** 2
    ),
  };
}

function generateTrail(sat, now = new Date()) {
  const trail = [];
  const interval = (TRAIL_LENGTH * 60) / TRAIL_POINTS; // seconds between points

  for (let i = 0; i <= TRAIL_POINTS; i++) {
    const time = new Date(now.getTime() - i * interval * 1000);
    const pos = propagateSatellite(sat, time);
    if (pos) {
      trail.push({
        lat: pos.lat,
        lng: pos.lng,
        alt: pos.alt * 0.0001, // scale down for visualization
      });
    }
  }

  return trail.reverse();
}

/* ===== Globe ===== */
function initGlobe() {
  const container = $('#globe-container');
  const w = container.clientWidth;
  const h = container.clientHeight;

  state.globe = Globe()(container)
    .width(w)
    .height(h)
    .globeImageUrl('https://unpkg.com/three-globe/example/img/earth-dark.jpg')
    .backgroundColor('rgba(10,10,15,0)')
    .atmosphereColor('#1a3a5c')
    .atmosphereAltitude(0.25)
    .showGraticules(true)
    .graticuleColor('#1a1a2e')
    .graticuleOpacity(0.3)
    .pointsData([])
    .pointLat('lat')
    .pointLng('lng')
    .pointAltitude('alt')
    .pointColor('color')
    .pointRadius('radius')
    .pointLabel('label')
    .pathsData([])
    .pathPoints('points')
    .pathColor('color')
    .pathDashLength(0.01)
    .pathDashGap(0.004)
    .pathDashAnimateTime(10000)
    .pathStroke(1)
    .onPointClick(handleSatClick)
    .onPointHover(handleSatHover);

  state.globe.controls().autoRotate = true;
  state.globe.controls().autoRotateSpeed = 0.4;

  window.addEventListener('resize', () => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    state.globe.width(w).height(h);
  });
}

function getPointData(sat, pos) {
  if (!state.pointCache.has(sat.noradId)) {
    state.pointCache.set(sat.noradId, {
      noradId: sat.noradId,
      color: sat.color,
      radius: 0.4,
      label: `<div class="tooltip-name">${escapeHtml(sat.name)}</div>
              <div class="tooltip-meta">NORAD ${sat.noradId} · ${CATEGORIES[sat.category].name}</div>
              <div class="tooltip-alt">${pos.alt.toFixed(0)} km altitude</div>`,
      sat: sat,
    });
  }

  const obj = state.pointCache.get(sat.noradId);
  obj.lat = pos.lat;
  obj.lng = pos.lng;
  obj.alt = pos.alt * 0.0001;

  // Highlight selected
  if (state.selectedSat?.noradId === sat.noradId) {
    obj.radius = 0.8;
    obj.color = '#ffffff';
  } else {
    obj.radius = 0.4;
    obj.color = sat.color;
  }

  return obj;
}

function getTrailData(sat, trail) {
  if (!state.trailCache.has(sat.noradId)) {
    state.trailCache.set(sat.noradId, {
      noradId: sat.noradId,
      color: sat.color,
      points: [],
    });
  }

  const obj = state.trailCache.get(sat.noradId);
  obj.points = trail;
  obj.color = state.selectedSat?.noradId === sat.noradId ? '#ffffff' : sat.color;

  return obj;
}

function updateGlobe() {
  if (!state.globe) return;

  const now = new Date();
  const points = [];
  const trails = [];

  for (const sat of state.filteredSats) {
    const pos = propagateSatellite(sat, now);
    if (!pos) continue;

    points.push(getPointData(sat, pos));

    if (state.showTrails) {
      const trail = generateTrail(sat, now);
      trails.push(getTrailData(sat, trail));
    }
  }

  state.globe.pointsData(points);
  state.globe.pathsData(trails);
}

function handleSatClick(point) {
  if (!point || !point.sat) return;
  selectSatellite(point.sat);
}

function handleSatHover(point) {
  if (point && point.sat) {
    highlightCard(point.sat.noradId);
  } else {
    unhighlightCard();
  }
}

/* ===== Satellite Selection ===== */
function selectSatellite(sat) {
  state.selectedSat = sat;

  // Update globe highlight
  updateGlobe();

  // Fly to satellite
  const pos = propagateSatellite(sat);
  if (pos && state.globe) {
    state.globe.controls().autoRotate = false;
    state.globe.pointOfView({ lat: pos.lat, lng: pos.lng, altitude: 2.0 }, 1500);
    setTimeout(() => { state.globe.controls().autoRotate = true; }, 2000);
  }

  // Update UI
  highlightCard(sat.noradId);
  updateBottomBar(sat);
  showInfoPanel(sat);

  // Scroll card into view
  const card = $(`.sat-card[data-norad="${sat.noradId}"]`);
  if (card) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function updateBottomBar(sat) {
  const dot = $('.tracking-dot');
  const name = $('.tracking-name');

  if (sat) {
    dot.classList.add('active');
    name.textContent = sat.name;
  } else {
    dot.classList.remove('active');
    name.textContent = 'Select a satellite';
  }
}

/* ===== Info Panel ===== */
function showInfoPanel(sat) {
  const panel = $('#info-panel');
  const content = $('#info-content');

  const pos = propagateSatellite(sat);
  if (!pos) return;

  // Calculate passes if user location set
  let passesHtml = '';
  if (state.userLocation) {
    const passes = calculatePasses(sat, state.userLocation);
    passesHtml = `
      <div class="info-section">
        <h4>Upcoming Passes</h4>
        <div class="pass-list">
          ${passes.length > 0 ? passes.map(p => `
            <div class="pass-item">
              <span class="pass-time">${p.time}</span>
              <span class="pass-duration">${p.duration}</span>
            </div>
          `).join('') : '<div class="pass-item"><span class="pass-time">No passes in next 24h</span></div>'}
        </div>
      </div>
    `;
  }

  content.innerHTML = `
    <h2>${escapeHtml(sat.name)}</h2>
    <div class="info-id">NORAD ID ${sat.noradId} · ${CATEGORIES[sat.category].name}</div>

    <div class="info-section">
      <h4>Current Position</h4>
      <div class="info-row">
        <span class="label">Latitude</span>
        <span class="value">${pos.lat.toFixed(4)}°</span>
      </div>
      <div class="info-row">
        <span class="label">Longitude</span>
        <span class="value">${pos.lng.toFixed(4)}°</span>
      </div>
      <div class="info-row">
        <span class="label">Altitude</span>
        <span class="value highlight">${pos.alt.toFixed(1)} km</span>
      </div>
      <div class="info-row">
        <span class="label">Velocity</span>
        <span class="value">${(pos.velocity * 3.6).toFixed(1)} km/h</span>
      </div>
    </div>

    <div class="info-section">
      <h4>Orbital Elements</h4>
      <div class="info-row">
        <span class="label">Inclination</span>
        <span class="value">${(sat.satrec.inclo * 180 / Math.PI).toFixed(2)}°</span>
      </div>
      <div class="info-row">
        <span class="label">Period</span>
        <span class="value">${(2 * Math.PI / sat.satrec.no * 60).toFixed(1)} min</span>
      </div>
      <div class="info-row">
        <span class="label">Eccentricity</span>
        <span class="value">${sat.satrec.ecco.toFixed(4)}</span>
      </div>
    </div>

    ${passesHtml}
  `;

  panel.classList.add('open');
}

function hideInfoPanel() {
  $('#info-panel').classList.remove('open');
  state.selectedSat = null;
  updateBottomBar(null);
  updateGlobe();
  $$('.sat-card').forEach(c => c.classList.remove('active'));
}

/* ===== Pass Prediction ===== */
function calculatePasses(sat, location, hours = 24) {
  const passes = [];
  const now = new Date();
  const observerGd = {
    latitude: degToRad(location.lat),
    longitude: degToRad(location.lng),
    height: 0.1,
  };

  // Check every 5 minutes for the next 24 hours
  for (let i = 0; i < (hours * 60) / 5; i++) {
    const time = new Date(now.getTime() + i * 5 * 60 * 1000);
    const positionAndVelocity = satellite.propagate(sat.satrec, time);

    if (!positionAndVelocity.position) continue;

    const gmst = satellite.gstime(time);
    const positionEci = positionAndVelocity.position;
    const observerEcf = satellite.geodeticToEcf(observerGd);
    const lookAngles = satellite.ecfToLookAngles(observerGd, positionEci);

    const elevation = radToDeg(lookAngles.elevation);

    // Satellite is visible when elevation > 10°
    if (elevation > 10) {
      // Find max elevation in this pass
      let maxEl = elevation;
      let duration = 5;

      for (let j = 1; j < 12; j++) {
        const t2 = new Date(time.getTime() + j * 5 * 60 * 1000);
        const pv2 = satellite.propagate(sat.satrec, t2);
        if (!pv2.position) break;
        const gmst2 = satellite.gstime(t2);
        const la2 = satellite.ecfToLookAngles(observerGd, pv2.position);
        const el2 = radToDeg(la2.elevation);
        if (el2 > 10) {
          maxEl = Math.max(maxEl, el2);
          duration += 5;
        } else {
          break;
        }
      }

      passes.push({
        time: time.toLocaleString('en-US', { 
          month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' 
        }),
        duration: formatDuration(duration),
        maxElevation: maxEl.toFixed(1),
      });

      // Skip ahead to avoid duplicate passes
      i += Math.floor(duration / 5);
    }
  }

  return passes.slice(0, 5);
}

/* ===== Satellite List ===== */
function renderSatList() {
  const list = $('#satellite-list');
  list.innerHTML = '';

  state.filteredSats.forEach(sat => {
    const card = document.createElement('div');
    card.className = 'sat-card';
    card.dataset.norad = sat.noradId;
    if (state.selectedSat?.noradId === sat.noradId) {
      card.classList.add('active');
    }

    const pos = propagateSatellite(sat);
    const alt = pos ? `${pos.alt.toFixed(0)} km` : 'unknown';

    card.innerHTML = `
      <div class="card-top">
        <div class="card-dot ${sat.category}"></div>
        <div class="card-name">${escapeHtml(sat.name)}</div>
        <div class="card-id">${sat.noradId}</div>
      </div>
      <div class="card-meta">
        <span class="card-tag">${CATEGORIES[sat.category].name}</span>
        <span class="card-tag">${sat.satrec.inclo ? (sat.satrec.inclo * 180 / Math.PI).toFixed(1) + '°' : 'N/A'}</span>
      </div>
      <div class="card-altitude">Altitude: <span>${alt}</span></div>
    `;

    card.addEventListener('click', () => selectSatellite(sat));
    card.addEventListener('mouseenter', () => highlightMarker(sat.noradId));
    card.addEventListener('mouseleave', () => unhighlightMarker(sat.noradId));

    list.appendChild(card);
  });
}

function highlightCard(noradId) {
  $$('.sat-card').forEach(c => c.classList.remove('highlighted'));
  const card = $(`.sat-card[data-norad="${noradId}"]`);
  if (card) card.classList.add('highlighted');
}

function unhighlightCard() {
  $$('.sat-card').forEach(c => c.classList.remove('highlighted'));
}

function highlightMarker(noradId) {
  const marker = state.pointCache.get(noradId);
  if (marker && state.selectedSat?.noradId !== noradId) {
    marker.radius = 0.7;
    updateGlobe();
  }
}

function unhighlightMarker(noradId) {
  const marker = state.pointCache.get(noradId);
  if (marker && state.selectedSat?.noradId !== noradId) {
    marker.radius = 0.4;
    updateGlobe();
  }
}

/* ===== Filtering ===== */
function applyFilter() {
  const category = state.activeCategory;

  if (category === 'all') {
    state.filteredSats = state.satellites;
  } else {
    state.filteredSats = state.satellites.filter(s => s.category === category);
  }

  renderSatList();
  updateGlobe();
  $('#object-count').textContent = `${state.filteredSats.length} objects`;
}

function initFilters() {
  $('#category-filter').addEventListener('change', (e) => {
    state.activeCategory = e.target.value;
    applyFilter();
  });

  $('#toggle-trails').addEventListener('click', () => {
    state.showTrails = !state.showTrails;
    $('#toggle-trails').classList.toggle('active', state.showTrails);
    updateGlobe();
  });

  $('#toggle-labels').addEventListener('click', () => {
    state.showLabels = !state.showLabels;
    $('#toggle-labels').classList.toggle('active', state.showLabels);
    if (state.globe) {
      state.globe.pointLabel(state.showLabels ? 'label' : () => '');
    }
  });
}

/* ===== Location Modal ===== */
function initLocationModal() {
  $('#set-location').addEventListener('click', () => {
    $('#location-modal').classList.add('open');
  });

  $('.modal-backdrop').addEventListener('click', () => {
    $('#location-modal').classList.remove('open');
  });

  $('#location-submit').addEventListener('click', setLocationFromInput);

  $$('.location-presets button').forEach(btn => {
    btn.addEventListener('click', () => {
      const lat = parseFloat(btn.dataset.lat);
      const lng = parseFloat(btn.dataset.lng);
      const name = btn.textContent;
      setLocation({ lat, lng, name });
      $('#location-modal').classList.remove('open');
    });
  });

  $('#location-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') setLocationFromInput();
  });
}

function setLocationFromInput() {
  const input = $('#location-input').value.trim();
  if (!input) return;

  // Try parsing as "lat, lng"
  const coords = input.split(',').map(s => parseFloat(s.trim())).filter(n => !isNaN(n));
  if (coords.length === 2) {
    setLocation({ lat: coords[0], lng: coords[1], name: `${coords[0].toFixed(2)}, ${coords[1].toFixed(2)}` });
    $('#location-modal').classList.remove('open');
    return;
  }

  // Otherwise try geocoding (would need a geocoding API in production)
  alert('Please enter coordinates as "lat, lng" (e.g. 48.8566, 2.3522)');
}

function setLocation(loc) {
  state.userLocation = loc;
  $('#my-location').textContent = `📍 ${loc.name}`;

  // If a satellite is selected, recalculate passes
  if (state.selectedSat) {
    showInfoPanel(state.selectedSat);
  }

  // Add user location marker to globe
  if (state.globe) {
    // We could add a custom layer for user location
    console.log('Location set:', loc);
  }
}

/* ===== Clock ===== */
function updateClock() {
  const now = new Date();
  $('#utc-time').textContent = formatUTC(now);
}

/* ===== Animation Loop ===== */
function startAnimation() {
  function tick() {
    updateGlobe();
    updateClock();
    state.animationId = requestAnimationFrame(tick);
  }
  tick();
}

/* ===== Initialization ===== */
async function init() {
  initGlobe();
  initFilters();
  initLocationModal();

  $('#close-info').addEventListener('click', hideInfoPanel);

  try {
    await loadSatellites();
    applyFilter();
    startAnimation();

    $('#loading').classList.add('hidden');
    $('#main-layout').style.display = 'flex';
  } catch (err) {
    console.error('Failed to load satellites:', err);
    $('.loading-text').textContent = 'Failed to load satellite data';
    $('.loading-sub').textContent = err.message;
  }
}

init();
