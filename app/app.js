// Field Assets - main app logic
// Plain JavaScript, no build step. Open index.html?demo to try it without a backend.

const C = window.APP_CONFIG;
const DEMO = new URLSearchParams(location.search).has('demo');
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const store = {
  get(k, d = null) { try { const v = localStorage.getItem('fa_' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('fa_' + k, JSON.stringify(v)); } catch { /* storage full or blocked */ } },
  del(k) { try { localStorage.removeItem('fa_' + k); } catch { /* ignore */ } },
};

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return n;
}

let toastTimer;
function toast(msg, ms = 3000) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371008.8, r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function bearing(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const y = Math.sin((lon2 - lon1) * r) * Math.cos(lat2 * r);
  const x = Math.cos(lat1 * r) * Math.sin(lat2 * r) - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lon2 - lon1) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
}

const compass = (deg) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8];
const fmtDist = (m) => (m < 1000 ? `${Math.round(m)} m` : `${parseFloat((m / 1000).toFixed(m < 10000 ? 2 : 1))} km`);
const fmtTime = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const fmtValue = (v) => {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) {
    const d = new Date(v);
    if (!isNaN(d)) return d.toLocaleDateString();
  }
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
};

// ---------------------------------------------------------------------------
// Backend: Supabase, or a built-in demo with made-up assets
// ---------------------------------------------------------------------------

async function supabaseBackend() {
  const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
  const sb = createClient(C.supabaseUrl, C.supabaseKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });
  return {
    async getSession() { return (await sb.auth.getSession()).data.session; },
    onSignedOut(cb) { sb.auth.onAuthStateChange((evt) => { if (evt === 'SIGNED_OUT') cb(); }); },
    async sendCode(email) {
      const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
      if (error) throw error;
    },
    async verifyCode(email, token) {
      const { error } = await sb.auth.verifyOtp({ email, token, type: 'email' });
      if (error) throw error;
    },
    async signOut() { await sb.auth.signOut(); },
    async myAccess() {
      const { data, error } = await sb.rpc('my_access');
      if (error) throw error;
      return data?.[0] || null;
    },
    async nearest(lat, lon, limit, radius) {
      const { data, error } = await sb.rpc('nearest_assets', {
        p_lat: lat, p_lon: lon, p_limit: limit, p_max_distance_m: radius,
      });
      if (error) throw error;
      return data || [];
    },
    async logLocations(points) {
      const { error } = await sb.rpc('log_locations', { p_points: points });
      if (error) throw error;
    },
  };
}

function demoBackend() {
  let assets = null;
  let signedIn = store.get('demo_signed_in', false);
  const signOutCbs = [];
  const seed = (n) => { const x = Math.sin(n * 9301 + 49297) * 233280; return x - Math.floor(x); };
  const makeAssets = (lat, lon) => {
    const types = [['Poles', 'Pole'], ['Pits', 'Pit'], ['Cabinets', 'Cabinet'], ['Poles', 'Pole'], ['Joints', 'Splice joint']];
    const statuses = ['In service', 'In service', 'In service', 'Planned', 'Faulty'];
    return Array.from({ length: 80 }, (_, i) => {
      const [layer, type] = types[i % types.length];
      const d = 30 + seed(i) * 2500, b = seed(i + 100) * 2 * Math.PI;
      return {
        layer, asset_type: type, status: statuses[Math.floor(seed(i + 7) * statuses.length)],
        asset_id: `${type.slice(0, 3).toUpperCase()}-${String(10000 + i * 37).slice(1)}`,
        name: `${type} ${String(10000 + i * 37).slice(1)}`,
        lat: lat + (d * Math.cos(b)) / 111320,
        lon: lon + (d * Math.sin(b)) / (111320 * Math.cos(lat * Math.PI / 180)),
        attributes: { Material: ['Timber', 'Concrete', 'Steel'][i % 3], Installed: `20${10 + (i % 14)}-03-01T00:00:00Z`, Suburb: 'Demo' },
      };
    });
  };
  return {
    async getSession() { return signedIn ? { demo: true } : null; },
    onSignedOut(cb) { signOutCbs.push(cb); },
    async sendCode() { await new Promise((r) => setTimeout(r, 400)); },
    async verifyCode(_e, code) {
      if (code !== '123456') throw new Error('Demo mode: the code is 123456');
      signedIn = true; store.set('demo_signed_in', true);
    },
    async signOut() { signedIn = false; store.del('demo_signed_in'); signOutCbs.forEach((f) => f()); },
    async myAccess() { return { email: 'demo@example.com', full_name: 'Demo User', role: 'staff', authorised: true }; },
    async nearest(lat, lon, limit, radius) {
      assets ||= makeAssets(lat, lon);
      return assets
        .map((a) => ({ ...a, distance_m: haversine(lat, lon, a.lat, a.lon) }))
        .filter((a) => a.distance_m <= radius)
        .sort((a, b) => a.distance_m - b.distance_m)
        .slice(0, limit);
    },
    async logLocations(points) { console.info('[demo] logged', points); },
  };
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const S = {
  api: null,
  access: null,
  fix: null,             // latest GPS fix {lat, lon, accuracy, speed, heading, time}
  watchId: null,
  tracking: false,
  lastLog: store.get('last_log'),
  lastQuery: null,       // {lat, lon, radius}
  querying: false,
  assets: store.get('assets_cache', []),
  assetsAt: store.get('assets_cache_at'),
  queue: store.get('queue', []),
  radius: store.get('radius', C.defaultRadiusM),
  wakePref: store.get('wake_pref', true),
  wakeLock: null,
  heartbeat: null,
  openAsset: null,
  map: null,
  mapLayers: null,
  mapFitted: false,
};

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function show(view) {
  for (const v of ['loading', 'login', 'denied', 'main']) $('view-' + v).hidden = v !== view;
}

function showLogin(message = '', isError = false) {
  stopWatching();
  setTracking(false, { silent: true });
  $('form-email').hidden = false;
  $('form-code').hidden = true;
  setLoginMsg(message, isError);
  show('login');
}

function setLoginMsg(text, isError = false) {
  const m = $('login-msg');
  m.textContent = text;
  m.classList.toggle('error', isError);
}

async function enterApp() {
  show('loading');
  let access = null;
  try {
    access = await S.api.myAccess();
    store.set('access', access);
  } catch (e) {
    access = store.get('access');           // offline: trust last known access
    if (!access) { showLogin('Could not reach the server. Check your connection and try again.', true); return; }
  }
  if (!access || !access.authorised) {
    const exp = access?.access_expires;
    $('denied-msg').textContent = exp && new Date(exp) < new Date()
      ? `Your access ended on ${new Date(exp).toLocaleDateString()}. Contact your supervisor if you need it extended.`
      : 'Your access to this app is not active. Contact your supervisor if you think this is a mistake.';
    show('denied');
    return;
  }
  S.access = access;
  $('user-info').textContent = `Signed in as ${access.full_name || access.email}${access.role ? ` · ${access.role}` : ''}`;
  show('main');
  renderList();
  updateStatus();
  startWatching();
  if (store.get('tracking', false)) setTracking(true, { silent: true });
  flushQueue();
}

// ---------------------------------------------------------------------------
// Sign in
// ---------------------------------------------------------------------------

function wireLogin() {
  $('form-email').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('email').value.trim().toLowerCase();
    const btn = e.submitter || $('form-email').querySelector('button');
    btn.disabled = true;
    setLoginMsg('Sending code…');
    try {
      await S.api.sendCode(email);
      store.set('email', email);
      $('code-email').textContent = email;
      $('form-email').hidden = true;
      $('form-code').hidden = false;
      $('code').value = '';
      $('code').focus();
      setLoginMsg(DEMO ? 'Demo mode: enter 123456' : 'Check your email (and junk folder).');
    } catch (err) {
      const msg = /signups? not allowed|not found|otp_disabled|user not found/i.test(err.message || '')
        ? "That email isn't registered for this app. Ask your supervisor to invite you."
        : `Couldn't send the code: ${err.message || err}`;
      setLoginMsg(msg, true);
    } finally {
      btn.disabled = false;
    }
  });

  $('form-code').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.submitter || $('form-code').querySelector('button[type=submit]');
    btn.disabled = true;
    setLoginMsg('Signing in…');
    try {
      await S.api.verifyCode($('code-email').textContent, $('code').value.trim());
      setLoginMsg('');
      await enterApp();
    } catch (err) {
      setLoginMsg(/expired|invalid/i.test(err.message || '') ? 'That code is wrong or has expired. Try again or request a new one.' : (err.message || String(err)), true);
    } finally {
      btn.disabled = false;
    }
  });

  $('btn-code-back').addEventListener('click', () => {
    $('form-code').hidden = true;
    $('form-email').hidden = false;
    setLoginMsg('');
  });

  $('email').value = store.get('email', '');
}

async function signOut() {
  if (S.queue.length && !confirm(`${S.queue.length} location point(s) haven't uploaded yet and will be lost. Sign out anyway?`)) return;
  $('sheet-settings').close();
  setTracking(false, { silent: true });
  store.del('queue'); S.queue = [];
  store.del('assets_cache'); store.del('access'); store.del('tracking');
  S.assets = [];
  await S.api.signOut();
  showLogin('You have signed out.');
}

// ---------------------------------------------------------------------------
// Location
// ---------------------------------------------------------------------------

function startWatching() {
  if (!('geolocation' in navigator)) {
    $('position-text').textContent = 'This device or browser cannot provide location.';
    return;
  }
  if (S.watchId !== null) return;
  S.watchId = navigator.geolocation.watchPosition(onFix, onFixError, {
    enableHighAccuracy: true, maximumAge: 10000, timeout: 30000,
  });
}

function stopWatching() {
  if (S.watchId !== null) navigator.geolocation.clearWatch(S.watchId);
  S.watchId = null;
}

function onFixError(err) {
  const t = $('position-text');
  if (err.code === err.PERMISSION_DENIED) {
    t.innerHTML = '';
    t.append(el('strong', {}, 'Location is blocked. '), 'Allow location for this app in your phone\'s settings (or browser site settings), then reopen it.');
    stopWatching();
  } else if (!S.fix) {
    t.textContent = 'Still looking for a GPS signal…';
  }
}

function onFix(pos) {
  const c = pos.coords;
  S.fix = {
    lat: c.latitude, lon: c.longitude, accuracy: c.accuracy,
    speed: c.speed, heading: c.heading, time: new Date(pos.timestamp || Date.now()),
  };
  updateStatus();
  maybeLog();
  maybeQuery();
  updateDistances();
  updateMapUser();
}

// Log a point if tracking is on and enough time has passed or we've moved
function maybeLog(force = false) {
  const f = S.fix;
  if (!S.tracking || !f) return;
  if (f.accuracy > C.maxAccuracyM) return;
  const last = S.lastLog;
  const now = Date.now();
  const elapsed = last ? (now - last.t) / 1000 : Infinity;
  const moved = last ? haversine(last.lat, last.lon, f.lat, f.lon) : Infinity;
  const due = force || elapsed >= C.logMinIntervalSec || (moved >= C.logMinDistanceM && elapsed >= 10);
  if (!due) return;

  S.queue.push({
    lat: +f.lat.toFixed(7), lon: +f.lon.toFixed(7),
    accuracy: Math.round(f.accuracy * 10) / 10,
    speed: f.speed ?? null, heading: f.heading ?? null,
    recorded_at: new Date().toISOString(), source: 'track',
  });
  if (S.queue.length > 5000) S.queue.splice(0, S.queue.length - 5000);   // cap offline storage
  store.set('queue', S.queue);
  S.lastLog = { lat: f.lat, lon: f.lon, t: now };
  store.set('last_log', S.lastLog);
  updateStatus();
  flushQueue();
}

let flushing = false;
async function flushQueue() {
  if (flushing || !S.queue.length || !navigator.onLine || !S.access) return;
  flushing = true;
  try {
    while (S.queue.length) {
      const batch = S.queue.slice(0, 200);
      await S.api.logLocations(batch);
      S.queue.splice(0, batch.length);
      store.set('queue', S.queue);
    }
  } catch (e) {
    console.warn('Upload failed, will retry', e);
    if (/JWT|auth|401|403/i.test(e.message || '')) checkStillAuthorised();
  } finally {
    flushing = false;
    updateStatus();
  }
}

async function checkStillAuthorised() {
  if (!(await S.api.getSession())) showLogin('Your session ended. Please sign in again.');
}

function setTracking(on, { silent = false } = {}) {
  S.tracking = on;
  store.set('tracking', on);
  clearInterval(S.heartbeat);
  if (on) {
    startWatching();
    // watchPosition may go quiet when standing still, so poll as well
    S.heartbeat = setInterval(() => {
      navigator.geolocation.getCurrentPosition(onFix, () => {}, { enableHighAccuracy: true, maximumAge: 15000, timeout: 20000 });
      flushQueue();
    }, Math.max(15, C.logMinIntervalSec) * 1000);
    maybeLog(true);
    requestWakeLock();
    if (!silent) toast('Tracking on');
  } else {
    releaseWakeLock();
    if (!silent) toast('Tracking off');
  }
  updateStatus();
}

function onTrackButton() {
  if (S.tracking) { setTracking(false); return; }
  if (store.get('notice_ack', false)) { setTracking(true); return; }
  const dlg = $('dlg-notice');
  $('notice-text').textContent = C.trackingNotice;
  dlg.returnValue = '';
  dlg.showModal();
  dlg.addEventListener('close', () => {
    if (dlg.returnValue === 'ok') { store.set('notice_ack', true); setTracking(true); }
  }, { once: true });
}

async function requestWakeLock() {
  if (!S.tracking || !S.wakePref || !('wakeLock' in navigator) || S.wakeLock) return;
  try {
    S.wakeLock = await navigator.wakeLock.request('screen');
    S.wakeLock.addEventListener('release', () => { S.wakeLock = null; });
  } catch { /* not allowed right now (e.g. low battery) */ }
}

function releaseWakeLock() {
  S.wakeLock?.release().catch(() => {});
  S.wakeLock = null;
}

// ---------------------------------------------------------------------------
// Nearby assets
// ---------------------------------------------------------------------------

function maybeQuery(force = false) {
  const f = S.fix;
  if (!f || S.querying) return;
  const q = S.lastQuery;
  const moved = q ? haversine(q.lat, q.lon, f.lat, f.lon) : Infinity;
  if (force || !q || q.radius !== S.radius || moved >= C.requeryDistanceM) runQuery();
}

async function runQuery() {
  const f = S.fix;
  if (!f) { toast('Waiting for your location…'); return; }
  if (!navigator.onLine) { toast('Offline - showing the last list'); return; }
  S.querying = true;
  $('btn-refresh').disabled = true;
  $('list-summary').textContent = 'Searching…';
  try {
    const rows = await S.api.nearest(f.lat, f.lon, C.maxResults, S.radius);
    S.assets = rows;
    S.assetsAt = Date.now();
    S.lastQuery = { lat: f.lat, lon: f.lon, radius: S.radius };
    store.set('assets_cache', rows);
    store.set('assets_cache_at', S.assetsAt);
    renderList();
    renderMapAssets();
  } catch (e) {
    console.error(e);
    toast('Could not load assets. Try again.');
    renderList();
  } finally {
    S.querying = false;
    $('btn-refresh').disabled = false;
  }
}

// Distance/direction from where the user is now (updates as they walk)
function liveDistance(a) {
  if (!S.fix || a.lat == null) return { d: a.distance_m, dir: null };
  return {
    d: haversine(S.fix.lat, S.fix.lon, a.lat, a.lon),
    dir: compass(bearing(S.fix.lat, S.fix.lon, a.lat, a.lon)),
  };
}

function renderList() {
  const list = $('asset-list');
  list.innerHTML = '';
  const summary = $('list-summary');

  if (!S.assets.length) {
    summary.textContent = '';
    list.append(el('li', { class: 'empty' },
      S.lastQuery ? `No assets within ${fmtDist(S.radius)}. Try a larger radius in Settings.`
                  : S.fix ? 'Tap "Near me" to find assets.' : 'Waiting for your location…'));
    return;
  }

  const items = S.assets.map((a) => ({ a, ...liveDistance(a) })).sort((x, y) => x.d - y.d);
  const when = S.assetsAt ? ` · updated ${fmtTime(new Date(S.assetsAt))}` : '';
  summary.textContent = `${items.length} asset${items.length === 1 ? '' : 's'} within ${fmtDist(S.radius)}${when}`;

  for (const { a, d, dir } of items) {
    const key = `${a.layer}|${a.asset_id}`;
    const open = S.openAsset === key;
    const head = el('button', { class: 'asset-head', 'aria-expanded': String(open), onclick: () => {
      S.openAsset = open ? null : key; renderList();
    } },
      el('span', { class: 'asset-name' }, a.name || a.asset_id),
      el('span', { class: 'asset-dist', 'data-key': key }, fmtDist(d), el('small', {}, dir || '')),
      el('span', { class: 'asset-meta' },
        el('span', {}, a.asset_type || a.layer),
        a.status ? el('span', { class: 'status-tag' }, a.status) : null,
        el('span', {}, a.asset_id)),
    );
    const li = el('li', { class: 'asset' }, head);

    if (open) {
      const rows = [['Asset ID', a.asset_id], ['Layer', a.layer], ['Type', a.asset_type], ['Status', a.status],
        ...Object.entries(a.attributes || {})];
      const dl = el('dl', {}, rows.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, fmtValue(v))]));
      const dest = `${a.lat},${a.lon}`;
      li.append(el('div', { class: 'asset-body' }, dl,
        el('div', { class: 'asset-actions' },
          el('a', { class: 'btn primary', href: `https://www.google.com/maps/dir/?api=1&destination=${dest}`, target: '_blank', rel: 'noopener' }, 'Directions'),
          el('button', { class: 'btn', onclick: () => showOnMap(a) }, 'Show on map'),
          el('button', { class: 'btn', onclick: () => copy(a.asset_id) }, 'Copy ID'))));
    }
    list.append(li);
  }
}

// Update distances in place as the user walks (no rebuild, so taps aren't lost)
function updateDistances() {
  if (!S.assets.length || $('panel-list').hidden) return;
  for (const a of S.assets) {
    const span = document.querySelector(`.asset-dist[data-key="${CSS.escape(`${a.layer}|${a.asset_id}`)}"]`);
    if (!span) continue;
    const { d, dir } = liveDistance(a);
    span.firstChild.textContent = fmtDist(d);
    span.lastChild.textContent = dir || '';
  }
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied ' + text); }
  catch { toast(text); }
}

// ---------------------------------------------------------------------------
// Map (Leaflet + OpenStreetMap)
// ---------------------------------------------------------------------------

function ensureMap() {
  if (S.map || !window.L) return !!S.map;
  S.map = L.map('map', { zoomControl: true });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(S.map);
  S.mapLayers = { assets: L.layerGroup().addTo(S.map), user: L.layerGroup().addTo(S.map) };
  const f = S.fix || (S.assets[0] && { lat: S.assets[0].lat, lon: S.assets[0].lon });
  S.map.setView(f ? [f.lat, f.lon] : [-25.3, 133.8], f ? 16 : 4);
  renderMapAssets();
  updateMapUser();
  return true;
}

function updateMapUser() {
  if (!S.map || !S.fix) return;
  const g = S.mapLayers.user;
  g.clearLayers();
  const ll = [S.fix.lat, S.fix.lon];
  L.circle(ll, { radius: S.fix.accuracy, color: '#1a73e8', weight: 1, fillOpacity: 0.1 }).addTo(g);
  L.marker(ll, { icon: L.divIcon({ className: '', html: '<div class="you-marker"></div>', iconSize: [20, 20], iconAnchor: [10, 10] }), keyboard: false, interactive: false }).addTo(g);
}

function renderMapAssets() {
  if (!S.map) return;
  const g = S.mapLayers.assets;
  g.clearLayers();
  const pts = [];
  for (const a of S.assets) {
    if (a.lat == null) continue;
    const { d } = liveDistance(a);
    const pop = el('div', {}, el('strong', {}, a.name || a.asset_id), el('br'),
      `${a.asset_type || a.layer}${a.status ? ' · ' + a.status : ''}`, el('br'), fmtDist(d));
    L.marker([a.lat, a.lon], { icon: L.divIcon({ className: '', html: '<div class="asset-marker"></div>', iconSize: [16, 16], iconAnchor: [8, 8] }) })
      .bindPopup(pop).addTo(g);
    pts.push([a.lat, a.lon]);
  }
  if (!S.mapFitted && pts.length) {
    if (S.fix) pts.push([S.fix.lat, S.fix.lon]);
    S.map.fitBounds(pts, { padding: [30, 30], maxZoom: 18 });
    S.mapFitted = true;
  }
}

function showOnMap(a) {
  selectTab('map');
  if (!S.map) return;
  S.map.setView([a.lat, a.lon], 18);
  S.mapLayers.assets.eachLayer((m) => {
    const ll = m.getLatLng();
    if (Math.abs(ll.lat - a.lat) < 1e-9 && Math.abs(ll.lng - a.lon) < 1e-9) m.openPopup();
  });
}

function selectTab(which) {
  const isMap = which === 'map';
  $('tab-list').classList.toggle('active', !isMap);
  $('tab-map').classList.toggle('active', isMap);
  $('tab-list').setAttribute('aria-selected', String(!isMap));
  $('tab-map').setAttribute('aria-selected', String(isMap));
  $('panel-list').hidden = isMap;
  $('panel-map').hidden = !isMap;
  if (isMap) {
    if (!ensureMap()) { toast('Map is loading…'); return; }
    setTimeout(() => S.map.invalidateSize(), 50);
  } else {
    renderList();
  }
}

// ---------------------------------------------------------------------------
// Status display
// ---------------------------------------------------------------------------

function updateStatus() {
  const pill = $('track-pill');
  pill.classList.toggle('on', S.tracking);
  pill.classList.toggle('off', !S.tracking);
  $('track-pill-text').textContent = S.tracking
    ? (S.lastLog ? `Tracking · logged ${fmtTime(new Date(S.lastLog.t))}` : 'Tracking')
    : 'Tracking off';

  const btn = $('btn-track');
  btn.textContent = S.tracking ? 'Stop tracking' : 'Start tracking';
  btn.classList.toggle('tracking', S.tracking);
  btn.classList.toggle('primary', !S.tracking);

  const qp = $('queue-pill');
  qp.hidden = !S.queue.length;
  qp.textContent = `${S.queue.length} waiting to upload`;
  $('offline-pill').hidden = navigator.onLine;

  const t = $('position-text');
  if (S.fix) {
    const poor = S.fix.accuracy > C.maxAccuracyM;
    t.innerHTML = '';
    t.append(
      el('strong', {}, `${S.fix.lat.toFixed(5)}, ${S.fix.lon.toFixed(5)}`),
      ` · ±${Math.round(S.fix.accuracy)} m · ${fmtTime(S.fix.time)}`,
    );
    if (poor) t.append(el('span', { class: 'status-tag' }, ' · weak GPS'));
  }
}

// ---------------------------------------------------------------------------
// Start up
// ---------------------------------------------------------------------------

async function init() {
  document.title = C.appName;
  document.querySelectorAll('.app-name').forEach((n) => { n.textContent = C.appName; });

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW failed', e));
  }

  wireLogin();
  $('btn-track').addEventListener('click', onTrackButton);
  $('btn-refresh').addEventListener('click', () => (S.fix ? runQuery() : toast('Waiting for your location…')));
  $('tab-list').addEventListener('click', () => selectTab('list'));
  $('tab-map').addEventListener('click', () => selectTab('map'));
  $('btn-menu').addEventListener('click', () => {
    $('set-radius').value = String(S.radius);
    $('set-wakelock').checked = S.wakePref;
    $('sheet-settings').showModal();
  });
  $('set-radius').addEventListener('change', (e) => {
    S.radius = Number(e.target.value);
    store.set('radius', S.radius);
    maybeQuery(true);
  });
  $('set-wakelock').addEventListener('change', (e) => {
    S.wakePref = e.target.checked;
    store.set('wake_pref', S.wakePref);
    S.wakePref ? requestWakeLock() : releaseWakeLock();
  });
  $('btn-signout').addEventListener('click', signOut);
  $('btn-denied-signout').addEventListener('click', signOut);

  addEventListener('online', () => { updateStatus(); flushQueue(); maybeQuery(); });
  addEventListener('offline', updateStatus);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      requestWakeLock();
      flushQueue();
      if (S.tracking) navigator.geolocation.getCurrentPosition(onFix, () => {}, { enableHighAccuracy: true, maximumAge: 10000 });
    }
  });

  const unconfigured = !DEMO && (!C.supabaseUrl || C.supabaseUrl.includes('YOUR-PROJECT-REF'));
  if (unconfigured) {
    showLogin('This app has not been set up yet: add your Supabase details to config.js. To try it now, add ?demo to the address.', true);
    $('form-email').hidden = true;
    return;
  }

  try {
    S.api = DEMO ? demoBackend() : await supabaseBackend();
  } catch (e) {
    showLogin('Could not load the app. Check your internet connection and reopen it.', true);
    return;
  }
  if (DEMO) {
    const p = el('span', { class: 'pill warn' }, 'Demo data');
    document.querySelector('.status-row').append(p);
  }
  S.api.onSignedOut(() => showLogin('You have been signed out.'));

  const session = await S.api.getSession().catch(() => null);
  if (session) await enterApp();
  else showLogin(DEMO ? 'Demo mode: use any email, then code 123456.' : '');
}

init();
