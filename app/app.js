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
    // detectSessionInUrl: also accept the sign-in LINK from Supabase's default
    // email (useful for testing). Installed iPhone apps still need the code.
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  return {
    async getSession() { return (await sb.auth.getSession()).data.session; },
    onSignedOut(cb) { sb.auth.onAuthStateChange((evt) => { if (evt === 'SIGNED_OUT') cb(); }); },
    async sendCode(email) {
      const { error } = await sb.auth.signInWithOtp({
        email,
        options: { shouldCreateUser: false, emailRedirectTo: location.origin + location.pathname },
      });
      if (error) throw error;
    },
    async verifyCode(email, token) {
      const { error } = await sb.auth.verifyOtp({ email, token, type: 'email' });
      if (error) throw error;
    },
    async signInPassword(email, password) {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
    },
    async changePassword(password) {
      const { error } = await sb.auth.updateUser({ password });
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
    // ---- work logs (Log On / Log Off)
    async userId() { return (await sb.auth.getSession()).data.session?.user?.id; },
    async uploadPhoto(path, blob) {
      const { error } = await sb.storage.from('work-photos')
        .upload(path, blob, { contentType: blob.type || 'image/jpeg', upsert: false });
      if (error) throw error;
    },
    async logOn(p) {
      const { data, error } = await sb.rpc('log_on', {
        p_work_id: p.workId, p_layer: p.layer, p_asset_id: p.assetId, p_lat: p.lat, p_lon: p.lon,
        p_circuit_id: p.circuitId, p_project_id: p.projectId, p_fault_id: p.faultId,
        p_user_lat: p.userLat, p_user_lon: p.userLon, p_user_accuracy: p.userAccuracy,
      });
      if (error) throw error;
      return data;
    },
    async logOff(p) {
      const { data, error } = await sb.rpc('log_off', { p_work_id: p.workId, p_comments: p.comments });
      if (error) throw error;
      return data;
    },
    // Whole network (Distance > Show all), fetched 1000 rows at a time
    async allAssets() {
      const page = 1000, out = [];
      for (let from = 0; ; from += page) {
        const { data, error } = await sb.rpc('all_assets').range(from, from + page - 1);
        if (error) throw error;
        out.push(...(data || []));
        if (!data || data.length < page) break;
      }
      return out;
    },
    async workStatus(keys) {
      const { data, error } = await sb.rpc('asset_work_status', { p_assets: keys, p_closed_days: SETTINGS.closed_visible_days });
      if (error) throw error;
      return data || [];
    },
    async myOpenWork() {
      const { data, error } = await sb.rpc('my_open_work');
      if (error) throw error;
      return data || [];
    },
    async settings() {
      const { data, error } = await sb.rpc('app_settings');
      if (error) throw error;
      return data;
    },
    async logJointIncident(p) {
      const { data, error } = await sb.rpc('log_joint_incident', {
        p_work_id: p.workId, p_comments: p.comments, p_photos: p.photos,
      });
      if (error) throw error;
      return data;
    },
    async logIncident(p) {
      const { data, error } = await sb.rpc('log_incident', {
        p_id: p.id, p_type: p.type, p_comments: p.comments,
        p_lat: p.lat, p_lon: p.lon, p_accuracy: p.accuracy, p_photos: p.photos,
      });
      if (error) throw error;
      return data;
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
    async signInPassword(_e, password) {
      await new Promise((r) => setTimeout(r, 300));
      if (password !== 'demo1234') throw new Error('Invalid login credentials');
      signedIn = true; store.set('demo_signed_in', true);
    },
    async changePassword() { await new Promise((r) => setTimeout(r, 300)); },
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
    // ---- work logs, kept in memory (and localStorage) for the demo
    async userId() { return 'demo-user'; },
    async uploadPhoto(path, blob) { console.info('[demo] upload', path, blob.size, blob.type); await new Promise((r) => setTimeout(r, 150)); },
    async logOn(p) {
      await new Promise((r) => setTimeout(r, 200));
      const jobs = store.get('demo_jobs', {});
      const key = `${p.layer}|${p.assetId}`;
      if (jobs[key]?.status === 'Open') throw new Error('This asset is already open');
      if (!p.circuitId && !p.projectId && !p.faultId) throw new Error('Enter a Circuit ID, Project ID or Fault ID to log on');
      const dist = haversine(p.userLat, p.userLon, p.lat, p.lon);
      if (dist > SETTINGS.logon_max_distance_m) throw new Error(`You are ${Math.round(dist)} m from this asset. You must be within ${SETTINGS.logon_max_distance_m} m to log on.`);
      const job = { asset_layer: p.layer, asset_id: p.assetId, work_id: p.workId, status: 'Open', is_mine: true,
        field_worker_name: 'Demo User', work_started_at: new Date().toISOString(), work_completed_at: null,
        asset_name: p.assetName, asset_lat: p.lat, asset_lon: p.lon };
      jobs[key] = job; store.set('demo_jobs', jobs);
      return { work_id: p.workId, status: 'Open', work_started_at: job.work_started_at, field_worker_name: 'Demo User' };
    },
    async logOff(p) {
      await new Promise((r) => setTimeout(r, 200));
      const jobs = store.get('demo_jobs', {});
      const job = Object.values(jobs).find((j) => j.work_id === p.workId);
      if (!job || job.status !== 'Open') throw new Error('Job not found or already closed');
      const done = new Date();
      if (!p.comments) throw new Error('Enter a comment describing the work carried out');
      job.status = 'Closed'; job.work_completed_at = done.toISOString(); job.closed_by_name = 'Demo User';
      job.duration_mins = Math.round((done - new Date(job.work_started_at)) / 600) / 100;
      store.set('demo_jobs', jobs);
      return { work_id: p.workId, status: 'Closed', work_completed_at: job.work_completed_at, duration_mins: job.duration_mins, closed_by_name: 'Demo User' };
    },
    async allAssets() {
      if (!assets) throw new Error('Search once first');
      return assets.map((a) => ({ ...a }));
    },
    async workStatus(keys) {
      const jobs = store.get('demo_jobs', {});
      if (!keys) return Object.values(jobs);
      return keys.map((k) => jobs[`${k.layer}|${k.asset_id}`]).filter(Boolean);
    },
    async myOpenWork() {
      return Object.values(store.get('demo_jobs', {})).filter((j) => j.status === 'Open')
        .map((j) => ({ ...j, work_id: j.work_id }));
    },
    async settings() { return { logon_max_distance_m: 50, logon_max_gps_accuracy_m: 100, closed_visible_days: 2, logon_overdue_hours: 4, logoff_prompt_distance_m: 30 }; },
    async logJointIncident(p) {
      await new Promise((r) => setTimeout(r, 200));
      const jobs = store.get('demo_jobs', {});
      const job = Object.values(jobs).find((j) => j.work_id === p.workId);
      if (!job || job.status !== 'Open') throw new Error('This job is closed. Log On again to report an incident on it.');
      if (!p.comments || !p.photos.length) throw new Error('Describe the incident and add a photo');
      job.asset_integrity_issue = 'Yes';
      job.integrity_issue_comments = [job.integrity_issue_comments, `${fmtWhen(new Date().toISOString())} - ${p.comments}`].filter(Boolean).join('\n');
      store.set('demo_jobs', jobs);
      console.info('[demo] joint incident', JSON.stringify({ work: p.workId, comments: p.comments, photos: p.photos.length }));
      return { work_id: p.workId, asset_integrity_issue: 'Yes' };
    },
    async logIncident(p) {
      await new Promise((r) => setTimeout(r, 200));
      if (!p.type || !p.comments || !p.photos.length) throw new Error('Choose a type, describe the incident and add a photo');
      console.info('[demo] incident', JSON.stringify({ type: p.type, comments: p.comments, photos: p.photos.length }));
      return { incident_id: p.id };
    },
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
  lastQuery: null,       // {lat, lon, radius}
  querying: false,
  assets: store.get('assets_cache', []),
  assetsAt: store.get('assets_cache_at'),
  radius: store.get('radius', C.defaultRadiusM),
  openAsset: null,
  map: null,
  mapLayers: null,
  mapFitted: false,
  markers: {},           // asset key -> map marker
  work: {},              // asset key -> latest job {status, work_id, is_mine, ...}
  myOpen: [],            // my open jobs (for the "logged on" banner)
  popup: null,           // {a, m, ok} for the open map popup
};

// App name in the banner (older config.js files still say 'Field Assets')
const APP_NAME = (!C.appName || C.appName === 'Field Assets') ? 'FibreconX Field App' : C.appName;
const CLOSED_DAYS = 2;   // recently-closed window; the database setting (app_settings closed_visible_days) wins
// Log On distance etc. come from the database (app_settings in 06_work_logs.sql); these are fallbacks
const SETTINGS = { logon_max_distance_m: 50, logon_max_gps_accuracy_m: 100, closed_visible_days: CLOSED_DAYS, logon_overdue_hours: 4, logoff_prompt_distance_m: 30 };
const assetKey = (a) => `${a.layer}|${a.asset_id}`;

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function show(view) {
  for (const v of ['loading', 'login', 'denied', 'main']) $('view-' + v).hidden = v !== view;
}

// 'password' (pilot: no emails needed) or 'code' (emailed 6-digit code). Set in config.js.
const LOGIN_METHOD = C.loginMethod === 'code' ? 'code' : 'password';

function showLogin(message = '', isError = false) {
  stopWatching();
  $('form-email').hidden = LOGIN_METHOD !== 'code';
  $('form-password').hidden = LOGIN_METHOD !== 'password';
  $('form-code').hidden = true;
  $('login-intro').textContent = LOGIN_METHOD === 'password'
    ? 'Sign in with the email and password you were given.'
    : 'Sign in with the email address you were invited with.';
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
  loadSettings();
  loadMyOpenWork();
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
      setLoginMsg(DEMO ? 'Demo mode: enter 123456'
        : 'Check your email (and junk folder). If the email has a link instead of a code, open it on this phone.');
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

  // Email + password sign-in
  $('form-password').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('pw-email').value.trim().toLowerCase();
    const btn = e.submitter || $('form-password').querySelector('button[type=submit]');
    btn.disabled = true;
    setLoginMsg('Signing in…');
    try {
      await S.api.signInPassword(email, $('pw-password').value);
      store.set('email', email);
      $('pw-password').value = '';
      setLoginMsg('');
      await enterApp();
    } catch (err) {
      const m = err.message || String(err);
      setLoginMsg(/invalid login|invalid credentials|invalid_grant/i.test(m)
        ? 'Email or password is incorrect. Check them and try again, or ask your supervisor to reset your password.'
        : /rate|too many/i.test(m) ? 'Too many attempts. Wait a few minutes and try again.'
        : /fetch|network/i.test(m) ? 'Could not reach the server. Check your connection and try again.'
        : `Couldn't sign in: ${m}`, true);
    } finally {
      btn.disabled = false;
    }
  });

  $('pw-show').addEventListener('change', (e) => {
    $('pw-password').type = e.target.checked ? 'text' : 'password';
  });

  $('email').value = store.get('email', '');
  $('pw-email').value = store.get('email', '');
}

// Change password (password sign-in only)
function wireChangePassword() {
  $('pw-change-section').hidden = LOGIN_METHOD !== 'password';
  $('btn-change-pw').addEventListener('click', async () => {
    const msg = $('pw-change-msg');
    const p1 = $('pw-new').value, p2 = $('pw-new2').value;
    msg.classList.add('error');
    if (p1.length < 8) { msg.textContent = 'Use at least 8 characters.'; return; }
    if (p1 !== p2) { msg.textContent = "The two passwords don't match."; return; }
    $('btn-change-pw').disabled = true;
    msg.classList.remove('error');
    msg.textContent = 'Saving…';
    try {
      await S.api.changePassword(p1);
      $('pw-new').value = ''; $('pw-new2').value = '';
      msg.textContent = 'Password changed.';
    } catch (err) {
      msg.classList.add('error');
      const m = err.message || String(err);
      msg.textContent = /same|different/i.test(m) ? 'Choose a password different from your current one.'
        : /weak|short|characters/i.test(m) ? `That password isn't strong enough: ${m}`
        : `Couldn't change password: ${m}`;
    } finally {
      $('btn-change-pw').disabled = false;
    }
  });
}

async function signOut() {
  $('sheet-settings').close();
  store.del('assets_cache'); store.del('access');
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
    $('position-text').hidden = false;
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
    t.hidden = false;
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
  maybeQuery();
  updateDistances();
  updateMapUser();
  checkAway();
  // If a popup is open and the person has moved into (or out of) Log On range, refresh it
  if (S.popup) {
    const why = logOnCheck(S.popup.a).why || '';
    if (why !== S.popup.why) { S.popup.why = why; S.popup.m.setPopupContent(buildPopup(S.popup.a)); }
  }
}

// "Find Assets Near Me": get a fresh GPS fix, then search
function findNearMe() {
  if (!('geolocation' in navigator)) { toast('This device cannot provide location.'); return; }
  const btn = $('sel-distance');
  // A GPS position from the last 20 seconds is good enough: search straight away
  if (S.fix && Date.now() - S.fix.time.getTime() < 20000) { if (!S.querying) runQuery(); return; }
  btn.disabled = true;
  navigator.geolocation.getCurrentPosition(
    (pos) => { btn.disabled = false; onFix(pos); if (!S.querying) runQuery(); },
    () => { btn.disabled = false; if (S.fix) runQuery(); else toast('Waiting for your location…'); },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 },
  );
}

// ---------------------------------------------------------------------------
// Nearby assets
// ---------------------------------------------------------------------------

// Distance "Show all" is stored as radius 0
const showingAll = () => S.radius === 0;

function maybeQuery(force = false) {
  const f = S.fix;
  if (!f || S.querying) return;
  const q = S.lastQuery;
  if (showingAll()) {                         // whole network already loaded: no need to re-search when moving
    if (force || !q || q.radius !== 0) runQuery();
    return;
  }
  const moved = q ? haversine(q.lat, q.lon, f.lat, f.lon) : Infinity;
  // Re-search after moving a set distance (sooner when the radius is small)
  if (force || !q || q.radius !== S.radius || moved >= Math.min(C.requeryDistanceM, S.radius / 2)) runQuery();
}

async function runQuery() {
  const f = S.fix;
  if (!f) { toast('Waiting for your location…'); return; }
  if (!navigator.onLine) { toast('Offline - showing the last list'); return; }
  S.querying = true;
  $('list-summary').textContent = showingAll() ? 'Loading the whole network…' : 'Searching…';
  try {
    const all = showingAll();
    if (all && !S.assets.length) await S.api.nearest(f.lat, f.lon, C.maxResults, 500);   // demo: make sure there's data
    const rows = all ? await S.api.allAssets() : await S.api.nearest(f.lat, f.lon, C.maxResults, S.radius);
    if (S.lastQuery?.radius !== S.radius) S.mapFitted = false;   // re-fit the map when switching to/from Show all
    S.assets = rows;
    S.assetsAt = Date.now();
    S.lastQuery = { lat: f.lat, lon: f.lon, radius: S.radius };
    if (!all) {                               // the whole network is too big to keep for offline use
      store.set('assets_cache', rows);
      store.set('assets_cache_at', S.assetsAt);
    }
    await refreshWorkStatus();
    renderList();
    renderMapAssets();
  } catch (e) {
    console.error(e);
    toast('Could not load assets. Try again.');
    renderList();
  } finally {
    S.querying = false;
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
      S.lastQuery ? (showingAll() ? 'No assets in the network yet.' : `No assets within ${fmtDist(S.radius)}. Try a larger distance.`)
                  : S.fix ? 'Choose a distance to see what\'s around you.' : 'Waiting for your location…'));
    return;
  }

  let items = S.assets.map((a) => ({ a, ...liveDistance(a) })).sort((x, y) => (x.d ?? Infinity) - (y.d ?? Infinity));
  const when = S.assetsAt ? ` · updated ${fmtTime(new Date(S.assetsAt))}` : '';
  const LIST_MAX = 100;   // Show all: list the nearest 100, the map shows everything
  if (showingAll()) {
    summary.textContent = `${items.length.toLocaleString()} assets in the network`
      + (items.length > LIST_MAX ? ` · nearest ${LIST_MAX} listed, all on the Map` : '') + when;
    items = items.slice(0, LIST_MAX);
  } else {
    summary.textContent = `${items.length} asset${items.length === 1 ? '' : 's'} within ${fmtDist(S.radius)}${when}`;
  }

  for (const { a, d, dir } of items) {
    const key = `${a.layer}|${a.asset_id}`;
    const open = S.openAsset === key;
    const head = el('button', { class: 'asset-head', 'aria-expanded': String(open), onclick: () => {
      S.openAsset = open ? null : key; renderList();
    } },
      el('span', { class: 'asset-name' }, a.name || a.asset_id),
      S.work[key] ? el('span', { class: 'asset-status' }, workTag(S.work[key])) : null,   // OPEN / CLOSED, top right
      // List: "By User" on the left, "@ time date" on the right (colour shows open/closed)
      S.work[key] ? el('span', { class: `asset-work ${S.work[key].status === 'Open' ? 'open' : 'closed'}` },
        el('span', { class: 'asset-work-who' }, `By ${workUser(S.work[key])}`),
        el('span', { class: 'asset-work-when' }, `@ ${fmtWhen(S.work[key].status === 'Open' ? S.work[key].work_started_at : S.work[key].work_completed_at)}`)) : null,
    );
    const li = el('li', { class: 'asset' }, head);

    if (open) {
      const rows = [['Asset ID', a.asset_id], ['Layer', a.layer], ['Type', a.asset_type], ['Status', a.status],
        ...Object.entries(a.attributes || {})];
      const dl = el('dl', {}, rows.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, fmtValue(v))]));
      li.append(el('div', { class: 'asset-body' }, dl,
        el('div', { class: 'asset-work-actions' }, ...workButton(a),
          el('button', { class: 'btn showmap-btn', onclick: () => showOnMap(a) }, 'Show on map'))));
    }
    list.append(li);
  }
}

// Update distances in place as the user walks (no rebuild, so taps aren't lost)
let assetIndex = { list: null, map: new Map() };
const assetByKey = (key) => {
  if (assetIndex.list !== S.assets) assetIndex = { list: S.assets, map: new Map(S.assets.map((a) => [assetKey(a), a])) };
  return assetIndex.map.get(key);
};

function updateDistances() {
  if (!S.assets.length || $('panel-list').hidden) return;
  for (const span of document.querySelectorAll('.asset-dist[data-key]')) {   // only the items in the list
    const a = assetByKey(span.dataset.key);
    if (!a) continue;
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
// Map (Leaflet)
// ---------------------------------------------------------------------------

// Background maps. Pick one in config.js with  basemap: 'openfreemap' | 'carto-light' | 'esri-light-gray' | 'osm'
//   openfreemap     - OpenFreeMap Positron: clean, sharp at every zoom, free, no account or key.
//                     Vector map drawn by MapLibre (loaded only when needed).
//   carto-light     - CARTO Positron: very clean, sharp at street level. Needs a free key:
//                     carto.com/basemaps/apikey, then set  basemapKey: '...'  in config.js
//   esri-light-gray - Esri Light Gray Canvas: clean, no key (covered by your ArcGIS licence);
//                     tiles stop at zoom 16 and are enlarged beyond that
//   osm             - standard OpenStreetMap (busier)
// Default: openfreemap (carto-light if a basemapKey is set). If the chosen map can't load,
// the app falls back to esri-light-gray, then osm, so the map is never blank.
const ESRI = 'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas';
const BASEMAPS = {
  'carto-light': (key) => [{
    url: `https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png${key ? `?key=${encodeURIComponent(key)}` : ''}`,
    opts: { subdomains: 'abcd', maxZoom: 20,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>' },
  }],
  'esri-light-gray': () => [
    { url: `${ESRI}/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}`,
      opts: { maxNativeZoom: 16, maxZoom: 20, attribution: 'Esri, HERE, Garmin, &copy; OpenStreetMap contributors' } },
    { url: `${ESRI}/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}`,   // street names and place labels
      opts: { maxNativeZoom: 16, maxZoom: 20 } },
  ],
  osm: () => [{ url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    opts: { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' } }],
};

const OPENFREEMAP = {
  style: 'https://tiles.openfreemap.org/styles/positron',
  attribution: '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> '
    + '&copy; <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> '
    + 'Data from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
  css: 'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css',
  js: ['https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js',
       'https://unpkg.com/@maplibre/maplibre-gl-leaflet@0.1.2/leaflet-maplibre-gl.js'],
};
const loadScript = (src) => new Promise((resolve, reject) => {
  const el2 = document.createElement('script');
  el2.src = src; el2.crossOrigin = 'anonymous'; el2.onload = resolve; el2.onerror = () => reject(new Error(`Could not load ${src}`));
  document.head.append(el2);
});
const hasWebGL = () => {
  try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch { return false; }
};

async function addOpenFreeMap(map) {
  try {
    if (!hasWebGL()) throw new Error('WebGL not available');
    if (!document.querySelector(`link[href="${OPENFREEMAP.css}"]`)) {
      document.head.append(el('link', { rel: 'stylesheet', href: OPENFREEMAP.css, crossorigin: 'anonymous' }));
    }
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), 15000));
    if (!window.maplibregl) await Promise.race([loadScript(OPENFREEMAP.js[0]), timeout]);
    if (!L.maplibreGL) await Promise.race([loadScript(OPENFREEMAP.js[1]), timeout]);
    if (!L.maplibreGL) throw new Error('map library missing');
    L.maplibreGL({ style: OPENFREEMAP.style, attribution: OPENFREEMAP.attribution, maxZoom: 20 }).addTo(map);
    S.mapCredit = OPENFREEMAP.attribution;
  } catch (e) {
    console.warn('OpenFreeMap could not load - using Esri Light Gray instead:', e.message);
    addBasemap(map, 'esri-light-gray');
  }
}

function addBasemap(map, forced) {
  const name = forced || (BASEMAPS[C.basemap] || C.basemap === 'openfreemap' ? C.basemap
    : (C.basemapKey ? 'carto-light' : 'openfreemap'));
  if (name === 'openfreemap' && !C.basemapUrl) { addOpenFreeMap(map); return; }
  const defs = C.basemapUrl
    ? [{ url: C.basemapUrl, opts: { maxZoom: 20, attribution: C.basemapAttribution || '' } }]
    : BASEMAPS[name](C.basemapKey);
  S.mapCredit = defs[0].opts.attribution || '';
  const layers = defs.map((b) => L.tileLayer(b.url, b.opts).addTo(map));
  // If the chosen background won't load (wrong key, blocked site), fall back to OpenStreetMap
  if (name !== 'osm' && layers[0].on) {
    let errors = 0, loaded = 0;
    layers[0].on('tileload', () => { loaded++; });
    layers[0].on('tileerror', () => {
      if (++errors >= 6 && !loaded) {
        layers.forEach((l) => map.removeLayer(l));
        BASEMAPS.osm().forEach((b) => L.tileLayer(b.url, b.opts).addTo(map));
        S.mapCredit = BASEMAPS.osm()[0].opts.attribution;
        console.warn(`Basemap "${name}" failed to load - using OpenStreetMap instead`);
      }
    });
  }
}

// Map credits: OpenStreetMap's licence needs a visible credit, so instead of the
// full-width bar there's a small (i) button in the corner that shows it when tapped.
function addCreditsButton(map) {
  if (!L.Control?.extend) return;
  const Credits = L.Control.extend({
    options: { position: 'bottomright' },
    onAdd() {
      const box = L.DomUtil.create('div', 'map-credits');
      const btn = L.DomUtil.create('button', 'map-credits-btn', box);
      const txt = L.DomUtil.create('div', 'map-credits-text', box);
      btn.type = 'button'; btn.textContent = 'i';
      btn.setAttribute('aria-label', 'Map credits'); btn.setAttribute('aria-expanded', 'false');
      txt.hidden = true;
      btn.addEventListener('click', () => {
        txt.innerHTML = `${S.mapCredit || ''} | <a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>`;
        txt.hidden = !txt.hidden;
        btn.setAttribute('aria-expanded', String(!txt.hidden));
      });
      L.DomEvent.disableClickPropagation(box);
      return box;
    },
  });
  new Credits().addTo(map);
}

// ---- asset ID labels: only when zoomed in to street level, placed to avoid overlaps
const LABEL_MIN_ZOOM = 17;
const LABEL_FONT = '700 11.5px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
let labelCtx = null;
const labelWidth = (t) => {
  labelCtx ||= document.createElement('canvas').getContext('2d');
  labelCtx.font = LABEL_FONT;
  return Math.ceil(labelCtx.measureText(t).width) + 6;
};
const escHtml = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function renderLabels() {
  const g = S.mapLayers?.labels;
  if (!g || !S.map?.getZoom || !S.map.latLngToContainerPoint) return;
  g.clearLayers();
  if (S.map.getZoom() < LABEL_MIN_ZOOM) return;
  const view = S.map.getBounds().pad(0.15);
  const pts = S.assets.filter((a) => a.lat != null && view.contains([a.lat, a.lon]))
    .map((a) => ({ a, p: S.map.latLngToContainerPoint([a.lat, a.lon]) }));
  // Things a label must not cover: every point (and the blue "You" dot)
  const R = 10, H = 15;
  const blocked = pts.map(({ p }) => ({ x1: p.x - R, y1: p.y - R, x2: p.x + R, y2: p.y + R }));
  if (S.fix) { const u = S.map.latLngToContainerPoint([S.fix.lat, S.fix.lon]); blocked.push({ x1: u.x - 11, y1: u.y - 11, x2: u.x + 11, y2: u.y + 11 }); }
  const hit = (b) => blocked.some((o) => b.x1 < o.x2 && b.x2 > o.x1 && b.y1 < o.y2 && b.y2 > o.y1);
  // Open jobs get first pick of the best spots, then nearest-to-centre first
  const c = S.map.getSize ? S.map.getSize().divideBy(2) : { x: 0, y: 0 };
  pts.sort((x, y) => (S.work[assetKey(y.a)]?.status === 'Open') - (S.work[assetKey(x.a)]?.status === 'Open')
    || (Math.hypot(x.p.x - c.x, x.p.y - c.y) - Math.hypot(y.p.x - c.x, y.p.y - c.y)));
  for (const { a, p } of pts) {
    const text = a.asset_id;
    if (!text) continue;
    const w = labelWidth(text);
    // Try right, left, above, below, then the diagonals
    const spots = [[R + 2, -H / 2], [-R - 2 - w, -H / 2], [-w / 2, -R - 2 - H], [-w / 2, R + 2],
      [R - 2, -R - H + 2], [R - 2, R - 2], [-R + 2 - w, -R - H + 2], [-R + 2 - w, R - 2]];
    for (const [dx, dy] of spots) {
      const b = { x1: p.x + dx, y1: p.y + dy, x2: p.x + dx + w, y2: p.y + dy + H };
      if (hit(b)) continue;
      blocked.push(b);
      L.marker([a.lat, a.lon], {
        icon: L.divIcon({ className: 'asset-label-icon', html: `<span class="asset-label">${escHtml(text)}</span>`,
          iconSize: [w, H], iconAnchor: [-dx, -dy] }),
        interactive: false, keyboard: false, zIndexOffset: -500,
      }).addTo(g);
      break;
    }
  }
}

function ensureMap() {
  if (S.map || !window.L) return !!S.map;
  S.map = L.map('map', { zoomControl: true, attributionControl: false });   // credits are behind the small (i) button
  addBasemap(S.map);
  addCreditsButton(S.map);
  S.mapLayers = { assets: L.layerGroup().addTo(S.map), labels: L.layerGroup().addTo(S.map), user: L.layerGroup().addTo(S.map) };
  S.map.on?.('zoomend moveend', renderLabels);
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

// Canvas point styles (used when there are lots of points) - same look as the normal markers
const FAST_STYLE = {
  idle:   { radius: 7, color: '#ffffff', weight: 2, fillColor: '#111418', fillOpacity: 1 },
  recent: { radius: 7.5, color: '#22c55e', weight: 3, fillColor: '#111418', fillOpacity: 1 },
};

function renderMapAssets() {
  if (!S.map) return;
  const g = S.mapLayers.assets;
  const reopenKey = S.popup ? assetKey(S.popup.a) : null;   // keep an open popup open across refreshes
  g.clearLayers();
  S.markers = {};
  const pts = [];
  const fast = S.assets.length > (C.mapFastDrawOver || 400) && !!L.circleMarker && !!L.canvas;
  if (fast) S.canvas ||= L.canvas({ padding: 0.5, tolerance: 6 });   // tolerance: easier to tap small points
  for (const a of S.assets) {
    if (a.lat == null) continue;
    const key = assetKey(a);
    const st = markerState(S.work[key]);
    // Lots of points (e.g. Show all): draw them on a canvas, which stays fast with thousands.
    // Open jobs always use the normal pulsing marker so they stand out.
    const m = (fast && st !== 'open')
      ? L.circleMarker([a.lat, a.lon], { renderer: S.canvas, ...FAST_STYLE[st] })
      : L.marker([a.lat, a.lon], {
        icon: L.divIcon({ className: 'asset-icon', html: `<div class="asset-marker ${st}"></div>`, iconSize: [22, 22], iconAnchor: [11, 11] }),
        zIndexOffset: st === 'open' ? 1000 : 0,
      });
    m.bindPopup(() => buildPopup(a), { minWidth: 170, maxWidth: 240, autoPanPadding: [20, 20] }).addTo(g);
    m.on('popupopen', () => { S.popup = { a, m, why: logOnCheck(a).why || '' }; });
    m.on('popupclose', () => { if (S.popup?.m === m) S.popup = null; });
    S.markers[key] = m;
    pts.push([a.lat, a.lon]);
  }
  if (!S.mapFitted && pts.length) {
    if (S.fix) pts.push([S.fix.lat, S.fix.lon]);
    S.map.fitBounds(pts, { padding: [30, 30], maxZoom: 18 });
    S.mapFitted = true;
  }
  if (reopenKey && S.markers[reopenKey] && !$('panel-map').hidden) S.markers[reopenKey].openPopup();
  renderLabels();
}

function showOnMap(a) {
  if (!S.assets.some((x) => assetKey(x) === assetKey(a))) {   // e.g. an open job far from here
    S.assets.push(a);
    renderMapAssets();
  }
  selectTab('map');
  if (!S.map) return;
  S.map.setView([a.lat, a.lon], 18);
  S.markers[assetKey(a)]?.openPopup();
}

// Re-draw markers and re-open the popup for one asset (after its status changes)
function refreshAssetOnMap(a) {
  renderList();
  renderMapAssets();
  if (S.map && !$('panel-map').hidden) S.markers[assetKey(a)]?.openPopup();
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
// Work logs (Log On / Log Off) and incidents
// ---------------------------------------------------------------------------

// Map point style for an asset's latest job:
//   open   - green (someone is logged on)
//   recent - black with green outline (closed in the last closed_visible_days days)
//   idle   - black (closed, nothing recent)
function markerState(w) {
  if (!w) return 'idle';
  if (w.status === 'Open') return 'open';
  const days = Number(SETTINGS.closed_visible_days) || 0;
  const recent = !!w.work_completed_at && Date.now() - new Date(w.work_completed_at).getTime() < days * 86400000;
  return recent ? 'recent' : 'idle';
}

function workTag(w) {
  if (!w) return null;
  return el('span', { class: `work-tag ${w.status === 'Open' ? 'open' : 'closed'}` }, w.status.toUpperCase());
}

// "15:05 23/10/2026" (24-hour time, then the date)
function fmtWhen(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const p2 = (n) => String(n).padStart(2, '0');
  return `${p2(d.getHours())}:${p2(d.getMinutes())} ${p2(d.getDate())}/${p2(d.getMonth() + 1)}/${d.getFullYear()}`;
}

// ["Opened by Bob", "@ 10:41 23/10/2026"] / ["Closed by Bob", "@ 15:05 22/10/2026"]
function workParts(w) {
  if (!w) return ['', ''];
  if (w.status === 'Open') return [`Opened by ${w.is_mine ? 'you' : (w.field_worker_name || 'another user')}`, `@ ${fmtWhen(w.work_started_at)}`];
  return [`Closed by ${w.is_mine && !w.closed_by_name ? 'you' : (w.closed_by_name || w.field_worker_name || 'another user')}`, `@ ${fmtWhen(w.work_completed_at)}`];
}
// Name of the person who opened (or closed) the job
function workUser(w) {
  return w.status === 'Open'
    ? (w.field_worker_name || (w.is_mine ? 'You' : 'Another user'))
    : (w.closed_by_name || w.field_worker_name || (w.is_mine ? 'You' : 'Another user'));
}
// One line (map popup): "Closed by Bob @ 15:05 22/10/2026"
const workLine = (w) => (w ? workParts(w).join(' ') : '');

async function refreshWorkStatus() {
  if (!S.assets.length) return;
  try {
    const rows = await S.api.workStatus(showingAll() ? null : S.assets.map((a) => ({ layer: a.layer, asset_id: a.asset_id })));
    S.work = {};
    for (const r of rows) S.work[`${r.asset_layer}|${r.asset_id}`] = r;
  } catch (e) {
    console.warn('Could not load work status', e);
  }
}

// Keep OPEN / CLOSED up to date without a new search, so a colleague's Log On
// shows up within a minute. Only redraws when something has actually changed.
async function pollWorkStatus() {
  if (!S.api || !S.assets.length || S.querying || !navigator.onLine || document.visibilityState !== 'visible') return;
  const before = JSON.stringify(S.work);
  await refreshWorkStatus();
  if (JSON.stringify(S.work) !== before) { renderList(); renderMapAssets(); }
  loadMyOpenWork();
}

async function loadSettings() {
  try { Object.assign(SETTINGS, await S.api.settings() || {}); } catch (e) { console.warn('Using default settings', e); }
}

async function loadMyOpenWork() {
  try { S.myOpen = await S.api.myOpenWork(); } catch (e) { console.warn(e); }
  renderActiveJobs();
  checkOverdue();
}

// The asset for one of my open jobs (from the current list, or rebuilt from the job)
const jobAsset = (j) => S.assets.find((x) => x.layer === j.asset_layer && x.asset_id === j.asset_id)
  || { layer: j.asset_layer, asset_id: j.asset_id, name: j.asset_name, lat: j.asset_lat, lon: j.asset_lon, asset_type: j.asset_layer };

// ---- Log Off reminders (only while the app is open):
//   * logged on longer than SETTINGS.logon_overdue_hours
//   * moved more than SETTINGS.logoff_prompt_distance_m away from the asset

const overdueMs = () => (Number(SETTINGS.logon_overdue_hours) || 4) * 3600000;
const awayLimit = () => Number(SETTINGS.logoff_prompt_distance_m) || 30;
const isOverdue = (j) => Date.now() - new Date(j.work_started_at).getTime() >= overdueMs();
const SNOOZE_MS = { time: 30 * 60000, away: 30 * 60000 };   // "Still working": remind again in 30 minutes
const fmtLength = (ms) => {
  const m = Math.floor(ms / 60000), h = Math.floor(m / 60);
  return `${h} hour${h === 1 ? '' : 's'}${m % 60 ? ` ${m % 60} min` : ''}`;
};

// How far I am from the job's asset, or null if the GPS isn't good enough to say
function awayDistance(j) {
  const f = S.fix;
  if (!f || j.asset_lat == null || j.asset_lon == null) return null;
  if (f.accuracy > 50 || Date.now() - f.time.getTime() > 2 * 60000) return null;   // poor or stale GPS: don't nag
  return haversine(f.lat, f.lon, j.asset_lat, j.asset_lon);
}
const isAway = (j) => { const d = awayDistance(j); return d !== null && d > awayLimit(); };

let reminder = null;   // { job, reason }

function checkOverdue() {
  if (!S.myOpen?.length || document.visibilityState !== 'visible') return;
  if (document.querySelector('dialog[open]')) return;          // don't interrupt a form that's being filled in
  const snooze = store.get('overdue_snooze', {});
  const now = Date.now();
  for (const k of Object.keys(snooze)) if (!S.myOpen.some((j) => k.startsWith(j.work_id))) delete snooze[k];   // tidy old ones
  store.set('overdue_snooze', snooze);
  const snoozed = (j, r) => snooze[`${j.work_id}|${r}`] > now;
  let job = null, reason = null;
  for (const j of S.myOpen) {
    if (isAway(j) && !snoozed(j, 'away')) { job = j; reason = 'away'; break; }
    if (isOverdue(j) && !snoozed(j, 'time')) { job = j; reason = 'time'; break; }
  }
  if (!job) return;
  reminder = { job, reason };
  $('overdue-asset').textContent = job.asset_name || job.asset_id;
  if (reason === 'away') {
    $('overdue-title').textContent = 'Have you left this asset?';
    $('overdue-text').textContent =
      `You're about ${fmtDist(awayDistance(job))} from this asset and still logged on to it. If you've finished, please Log Off now.`;
  } else {
    $('overdue-title').textContent = 'Still working here?';
    $('overdue-text').textContent =
      `You've been logged on for ${fmtLength(now - new Date(job.work_started_at).getTime())} (since ${fmtWhen(job.work_started_at)}). ` +
      `If you've finished, please Log Off now.`;
  }
  $('dlg-overdue').showModal();
}

// Called on every GPS update: redraw the banner when "moved away" changes, and remind once
let lastAwayKey = '';
function checkAway() {
  if (!S.myOpen?.length) return;
  const key = S.myOpen.map((j) => (isAway(j) ? j.work_id : '')).join(',');
  if (key === lastAwayKey) return;
  lastAwayKey = key;
  renderActiveJobs();
  checkOverdue();
}

function wireOverdue() {
  $('btn-overdue-logoff').addEventListener('click', () => {
    $('dlg-overdue').close();
    if (reminder) openLogOff(jobAsset(reminder.job));
  });
  $('btn-overdue-snooze').addEventListener('click', () => {
    if (reminder) {
      const snooze = store.get('overdue_snooze', {});
      snooze[`${reminder.job.work_id}|${reminder.reason}`] = Date.now() + SNOOZE_MS[reminder.reason];
      store.set('overdue_snooze', snooze);
    }
    $('dlg-overdue').close();
    toast("OK - we'll remind you again in 30 minutes.");
    checkOverdue();   // the other reminder may still be due
  });
}

// Banner under the main buttons: "You're logged on to Joint 0001 since 9:14"
function renderActiveJobs() {
  const box = $('active-jobs');
  box.innerHTML = '';
  box.hidden = !S.myOpen.length;
  for (const j of S.myOpen) {
    const a = jobAsset(j);
    const late = isOverdue(j);
    const away = isAway(j);
    box.append(el('div', { class: `active-job${late || away ? ' overdue' : ''}` },
      el('span', { class: 'work-tag open' }, 'OPEN'),
      el('div', { class: 'active-job-text' },
        el('div', {}, `You're logged on to:`),
        el('strong', { class: 'active-job-asset' }, j.asset_name || j.asset_id),
        el('div', {}, `since ${fmtWhen(j.work_started_at)}`)),
      el('div', { class: 'active-job-btns' },
        // Log Off works from anywhere, even when the asset is no longer in the list or on the map
        el('button', { class: 'btn small danger-fill', onclick: () => openLogOff(a) }, 'Log Off'),
        a.lat != null ? el('button', { class: 'btn small', onclick: () => {
          S.work[assetKey(a)] ||= { status: 'Open', is_mine: true, work_id: j.work_id, work_started_at: j.work_started_at };
          showOnMap(a);
        } }, 'Show') : null),
      // Reminder across the full width of the banner, on one line
      away ? el('div', { class: 'overdue-note' }, `You've moved away - please Log Off`)
        : late ? el('div', { class: 'overdue-note' }, `Over ${SETTINGS.logon_overdue_hours || 4} hours - please Log Off`) : null));
  }
}

// Can the person log on to this asset from where they are now?
function logOnCheck(a) {
  const max = SETTINGS.logon_max_distance_m, acc = SETTINGS.logon_max_gps_accuracy_m;
  if (!S.fix) return { ok: false, why: 'Waiting for your location…' };
  if (S.fix.accuracy > acc) {
    return { ok: false, why: `GPS signal too weak (±${Math.round(S.fix.accuracy)} m). Move outside or wait for a better signal.` };
  }
  const d = haversine(S.fix.lat, S.fix.lon, a.lat, a.lon);
  if (d > max) return { ok: false, why: `You're ${fmtDist(d)} away. Move within ${fmtDist(max)} to log on.` };
  return { ok: true, d };
}

const getFreshFix = () => new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(
  resolve, reject, { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 }));

// Fresh GPS position (or a recent one) before saving anything
async function currentFix(msg) {
  msg('Checking your location…');
  try { onFix(await getFreshFix()); } catch { /* fall back to the last known position */ }
  if (!S.fix || Date.now() - S.fix.time.getTime() > 120000) {
    throw new Error('Could not get your current location. Check location is allowed and try again.');
  }
  return S.fix;
}

// Log On / Log Off button (+ reason if not allowed), used in the list and the map popup
function workButton(a, compact = false) {
  const w = S.work[assetKey(a)];
  const cls = compact ? ' small' : '';
  if (w?.status === 'Open') {
    return w.is_mine ? [el('button', { class: `btn danger-fill${cls}`, onclick: () => openLogOff(a) }, 'Log Off')] : [];
  }
  const chk = logOnCheck(a);
  return [
    el('button', { class: `btn logon-btn${cls}`, disabled: !chk.ok, onclick: () => openLogOn(a) }, 'Log On'),
    chk.ok ? null : el('div', { class: 'popup-note' }, chk.why),
  ];
}

// Small, tidy popup for the map: just the asset name (centred) and the Log On / Log Off button
function buildPopup(a) {
  const w = S.work[assetKey(a)];
  const mine = w?.status === 'Open' && w.is_mine;
  if (!mine) {
    return el('div', { class: 'popup' },
      el('div', { class: 'popup-title' }, el('strong', {}, a.name || a.asset_id)),
      ...workButton(a, true));
  }
  // Logged on here: Log Off is the main button; the small warning button opens Log Joint Incident
  const joint = el('button', { type: 'button', class: 'popup-joint', 'aria-label': 'Log Joint Incident', title: 'Log Joint Incident',
    onclick: () => { S.map?.closePopup?.(); openJointIncident(a); } });
  joint.innerHTML = '<svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true">'
    + '<path d="M12 2.6 1.4 21h21.2z" fill="#d92d20" stroke="#d92d20" stroke-width="1.6" stroke-linejoin="round"/>'
    + '<rect x="10.9" y="8.6" width="2.2" height="7" rx="1.1" fill="#fff"/><circle cx="12" cy="18.1" r="1.25" fill="#fff"/></svg>';
  return el('div', { class: 'popup' },
    el('div', { class: 'popup-title' }, el('strong', {}, a.name || a.asset_id)),
    el('div', { class: 'popup-actions' }, ...workButton(a, true), joint));
}

// ---- photos

async function compressImage(file, maxDim = 1600, quality = 0.82) {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
    bmp.close?.();
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', quality));
    if (blob) return blob;
  } catch { /* fall back to the original file */ }
  return file;
}

// A photo picker bound to a button, a hidden <input type=file> and a thumbnail strip
function photoPicker(btnId, inputId, thumbsId, onChange) {
  const photos = [];
  const render = () => {
    const t = $(thumbsId);
    t.innerHTML = '';
    photos.forEach((p, i) => t.append(el('div', { class: 'thumb' },
      el('img', { src: p.url, alt: `Photo ${i + 1}` }),
      el('button', { type: 'button', class: 'thumb-del', 'aria-label': `Remove photo ${i + 1}`, onclick: () => {
        URL.revokeObjectURL(p.url); photos.splice(i, 1); render(); onChange();
      } }, '×'))));
    $(btnId).textContent = photos.length ? 'Take another photo' : 'Take photo';
  };
  $(btnId).addEventListener('click', () => $(inputId).click());
  $(inputId).addEventListener('change', async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    for (const f of files) {
      if (photos.length >= 10) { toast('Up to 10 photos'); break; }
      const blob = await compressImage(f);
      photos.push({ blob, url: URL.createObjectURL(blob) });
    }
    render(); onChange();
  });
  return {
    get list() { return photos; },
    reset() { photos.splice(0).forEach((p) => URL.revokeObjectURL(p.url)); render(); },
  };
}

const safeName = (s) => String(s || 'asset').replace(/[\\/:*?"<>|#%{}^~\[\]`]+/g, '-').trim().slice(0, 80) || 'asset';
const storageKey = (s) => s.replace(/[^A-Za-z0-9._-]+/g, '_');
const newId = () => (crypto.randomUUID ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  }));

// Upload photos as "<base>_<n>.jpg" under <user>/<record id>/
async function uploadPhotos(photos, recordId, base, setMsg) {
  if (!photos.length) return [];
  const uid = await S.api.userId();
  if (!uid) throw new Error('Your session has ended. Sign in again.');
  const out = [];
  for (let i = 0; i < photos.length; i++) {
    setMsg(`Uploading photo ${i + 1} of ${photos.length}…`);
    const blob = photos[i].blob;
    const ext = /png/.test(blob.type) ? 'png' : /heic|heif/.test(blob.type) ? 'heic' : 'jpg';
    const fileName = `${safeName(base)}_${i + 1}.${ext}`;
    const path = `${uid}/${recordId}/${storageKey(fileName)}`;
    await S.api.uploadPhoto(path, blob);
    out.push({ path, file_name: fileName });
  }
  return out;
}

const friendlyError = (e) => {
  const m = e?.message || String(e);
  if (/fetch|network|load failed/i.test(m)) return 'No connection. Check your signal and try again.';
  if (/JWT|session/i.test(m)) return 'Your session has ended. Sign out and sign in again.';
  return m;
};
const formMsg = (id) => (t, err = false) => { $(id).textContent = t; $(id).classList.toggle('error', err); };

// ---- Log On: Circuit ID / Project ID / Fault ID (at least one)

let logOnAsset = null;
const jobIds = () => ({ circuit: $('in-circuit').value.trim(), project: $('in-project').value.trim(), fault: $('in-fault').value.trim() });

function openLogOn(a) {
  if (!navigator.onLine) { toast('You need a connection to Log On.'); return; }
  const chk = logOnCheck(a);
  if (!chk.ok) { toast(chk.why, 4000); return; }
  logOnAsset = a;
  $('logon-asset').textContent = a.name || a.asset_id;
  ['in-circuit', 'in-project', 'in-fault'].forEach((id) => { $(id).value = ''; });
  $('logon-msg').textContent = '';
  updateLogOnForm();
  $('dlg-logon').showModal();
}

function updateLogOnForm() {
  const ids = jobIds();
  const ok = !!(ids.circuit || ids.project || ids.fault);
  $('btn-logon-submit').disabled = !ok;
  $('logon-hint').textContent = ok ? '' : 'Enter a Circuit ID, Project ID or Fault ID to log on.';
}

async function submitLogOn(e) {
  e.preventDefault();
  const a = logOnAsset;
  const msg = formMsg('logon-msg');
  $('btn-logon-submit').disabled = true;
  try {
    const fix = await currentFix(msg);
    const chk = logOnCheck(a);
    if (!chk.ok) throw new Error(chk.why);
    const ids = jobIds();
    const workId = newId();
    msg('Saving…');
    const res = await S.api.logOn({
      workId, layer: a.layer, assetId: a.asset_id, assetName: a.name, lat: a.lat, lon: a.lon,
      circuitId: ids.circuit || null, projectId: ids.project || null, faultId: ids.fault || null,
      userLat: fix.lat, userLon: fix.lon, userAccuracy: fix.accuracy,
    });
    const job = { asset_layer: a.layer, asset_id: a.asset_id, work_id: workId, status: 'Open', is_mine: true,
      field_worker_name: res?.field_worker_name, work_started_at: res?.work_started_at || new Date().toISOString() };
    S.work[assetKey(a)] = job;
    S.myOpen = [...S.myOpen.filter((j) => j.work_id !== workId),
      { work_id: workId, asset_layer: a.layer, asset_id: a.asset_id, asset_name: a.name, asset_lat: a.lat, asset_lon: a.lon, work_started_at: job.work_started_at }];
    $('dlg-logon').close();
    renderActiveJobs();
    refreshAssetOnMap(a);
    toast(`Logged on to ${a.name || a.asset_id} · status OPEN`);
  } catch (err) {
    console.error(err);
    msg(friendlyError(err), true);
    updateLogOnForm();
  }
}

// ---- Log Off: a comment describing the work is required

let logOffAsset = null;

function openLogOff(a) {
  if (!navigator.onLine) { toast('You need a connection to Log Off.'); return; }
  logOffAsset = a;
  $('logoff-asset').textContent = a.name || a.asset_id;
  $('work-comment').value = '';
  $('logoff-msg').textContent = '';
  updateLogOffForm();
  $('dlg-logoff').showModal();
}

function updateLogOffForm() {
  const ok = !!$('work-comment').value.trim();
  $('btn-logoff-submit').disabled = !ok;
  $('logoff-hint').textContent = ok ? '' : 'Enter a comment describing the work to log off.';
}

async function submitLogOff(e) {
  e.preventDefault();
  const a = logOffAsset;
  const job = myOpenJob(a);
  const msg = formMsg('logoff-msg');
  if (!job?.work_id) { msg('Could not find the open job for this asset. Refresh and try again.', true); return; }
  $('btn-logoff-submit').disabled = true;
  try {
    msg('Saving…');
    const res = await S.api.logOff({ workId: job.work_id, comments: $('work-comment').value.trim() });
    S.work[assetKey(a)] = { ...job, status: 'Closed', is_mine: true, closed_by_name: res?.closed_by_name,
      work_completed_at: res?.work_completed_at || new Date().toISOString() };
    S.myOpen = S.myOpen.filter((j) => j.work_id !== job.work_id);
    $('dlg-logoff').close();
    renderActiveJobs();
    refreshAssetOnMap(a);
    const mins = res?.duration_mins;
    toast(`Logged off · status CLOSED${mins != null ? ` · ${Number(mins).toFixed(2)} min` : ''}`, 4000);
  } catch (err) {
    console.error(err);
    msg(friendlyError(err), true);
    updateLogOffForm();
  }
}

// My open job on this asset (from the banner list first, then the map/list status)
function myOpenJob(a) {
  const w = S.work[assetKey(a)];
  return S.myOpen.find((j) => j.asset_layer === a.layer && j.asset_id === a.asset_id)
    || (w?.status === 'Open' && w.is_mine ? w : null);
}

// ---- Log Joint Incident: an issue with the asset I'm logged on to.
// Saved on that job's work log (asset_integrity_issue / integrity_issue_comments)
// with photos in work_log_photos (tag 'integrity').

let jointAsset = null;
let jointPhotos = null;

function openJointIncident(a) {
  if (!navigator.onLine) { toast('You need a connection to log a joint incident.'); return; }
  if (!myOpenJob(a)) { toast('Log On to this asset first.'); return; }
  jointAsset = a;
  $('joint-asset').textContent = a.name || a.asset_id;
  $('in-joint-comment').value = '';
  jointPhotos.reset();
  $('joint-msg').textContent = '';
  updateJointForm();
  $('dlg-joint').showModal();
}

function updateJointForm() {
  const ok = !!($('in-joint-comment').value.trim() && jointPhotos.list.length);
  $('btn-joint-submit').disabled = !ok;
  $('joint-hint').textContent = ok ? '' : 'Describe the incident and take at least one photo to submit.';
}

async function submitJointIncident(e) {
  e.preventDefault();
  const a = jointAsset;
  const job = myOpenJob(a);
  const msg = formMsg('joint-msg');
  if (!job?.work_id) { msg('Could not find the open job for this asset. Refresh and try again.', true); return; }
  $('btn-joint-submit').disabled = true;
  try {
    const d = new Date(), p2 = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
    const photos = await uploadPhotos(jointPhotos.list, job.work_id, `${a.name || a.asset_id}_integrity_${stamp}`, msg);
    msg('Saving…');
    await S.api.logJointIncident({ workId: job.work_id, comments: $('in-joint-comment').value.trim(), photos });
    job.asset_integrity_issue = 'Yes';                                   // so the point shows the red outline after Log Off
    if (S.work[assetKey(a)]) S.work[assetKey(a)].asset_integrity_issue = 'Yes';
    $('dlg-joint').close();
    toast('Joint incident saved to this job. Thank you.', 4000);
  } catch (err) {
    console.error(err);
    msg(friendlyError(err), true);
    updateJointForm();
  }
}

// ---- Log Incident: fault or network issue, with optional photos

let incidentPhotos = null;
const INCIDENT_TYPES = Array.isArray(C.incidentTypes) && C.incidentTypes.length ? C.incidentTypes
  : ['Fault', 'Network issue', 'Damaged asset', 'Safety hazard', 'Other'];

function openIncident() {
  if (!navigator.onLine) { toast('You need a connection to log an incident.'); return; }
  $('in-incident-type').value = '';
  $('in-incident-comment').value = '';
  incidentPhotos.reset();
  $('incident-msg').textContent = '';
  $('incident-location').textContent = S.fix
    ? `Your location (±${Math.round(S.fix.accuracy)} m) will be recorded with the report.`
    : 'Your location will be recorded with the report.';
  updateIncidentForm();
  $('dlg-incident').showModal();
}

function updateIncidentForm() {
  const ok = !!($('in-incident-type').value && $('in-incident-comment').value.trim() && incidentPhotos.list.length);
  $('btn-incident-submit').disabled = !ok;
  $('incident-hint').textContent = ok ? '' : 'Choose a type, describe the incident and take at least one photo to submit.';
}

async function submitIncident(e) {
  e.preventDefault();
  const msg = formMsg('incident-msg');
  $('btn-incident-submit').disabled = true;
  try {
    const fix = await currentFix(msg);
    const id = newId();
    const type = $('in-incident-type').value;
    const photos = await uploadPhotos(incidentPhotos.list, id, `Incident_${type}`, msg);
    msg('Saving…');
    await S.api.logIncident({ id, type, comments: $('in-incident-comment').value.trim(),
      lat: fix.lat, lon: fix.lon, accuracy: fix.accuracy, photos });
    $('dlg-incident').close();
    toast('Incident reported. Thank you.', 4000);
  } catch (err) {
    console.error(err);
    msg(friendlyError(err), true);
    updateIncidentForm();
  }
}

function wireWorkForms() {
  ['in-circuit', 'in-project', 'in-fault'].forEach((id) => $(id).addEventListener('input', updateLogOnForm));
  $('work-comment').addEventListener('input', updateLogOffForm);
  $('form-logon').addEventListener('submit', submitLogOn);
  $('form-logoff').addEventListener('submit', submitLogOff);
  $('btn-logon-cancel').addEventListener('click', () => $('dlg-logon').close());
  $('btn-logoff-cancel').addEventListener('click', () => $('dlg-logoff').close());

  const sel = $('in-incident-type');
  INCIDENT_TYPES.forEach((t) => sel.append(el('option', { value: t }, t)));
  incidentPhotos = photoPicker('btn-incident-photo', 'in-incident-photo', 'incident-thumbs', updateIncidentForm);
  sel.addEventListener('change', updateIncidentForm);
  $('in-incident-comment').addEventListener('input', updateIncidentForm);
  $('form-incident').addEventListener('submit', submitIncident);
  $('btn-incident-cancel').addEventListener('click', () => $('dlg-incident').close());
  $('btn-incident').addEventListener('click', openIncident);

  jointPhotos = photoPicker('btn-joint-photo', 'in-joint-photo', 'joint-thumbs', updateJointForm);
  $('in-joint-comment').addEventListener('input', updateJointForm);
  $('form-joint').addEventListener('submit', submitJointIncident);
  $('btn-joint-cancel').addEventListener('click', () => $('dlg-joint').close());
}

// ---------------------------------------------------------------------------
// Status display
// ---------------------------------------------------------------------------

function updateStatus() {
  $('offline-pill').hidden = navigator.onLine;

  // Coordinates aren't shown; this line only appears for location problems
  if (S.fix) $('position-text').hidden = true;
}

// ---------------------------------------------------------------------------
// Start up
// ---------------------------------------------------------------------------

async function init() {
  // Earlier versions could record location; clear anything they left on the phone
  ['queue', 'tracking', 'last_log', 'notice_ack', 'wake_pref'].forEach((k) => store.del(k));

  // If the user arrived from an email link that failed, Supabase puts the reason in the URL
  const hashParams = new URLSearchParams(location.hash.slice(1));
  const linkError = hashParams.get('error_description') || hashParams.get('error') || '';

  document.title = APP_NAME;
  document.querySelectorAll('.app-name').forEach((n) => { n.textContent = APP_NAME; });

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW failed', e));
  }

  // Keep the radius to one of the distance options (snaps old saved values to the nearest)
  const radiusOptions = [...$('sel-distance').options].map((o) => Number(o.value));
  if (!radiusOptions.includes(S.radius)) {
    S.radius = radiusOptions.reduce((a, b) => (Math.abs(b - S.radius) < Math.abs(a - S.radius) ? b : a));
    store.set('radius', S.radius);
  }

  wireLogin();
  wireChangePassword();
  wireWorkForms();
  // Distance dropdown: choosing a distance searches around the current position
  const showDistance = () => { $('sel-distance').value = String(S.radius); };   // chosen distance is ticked in the list
  showDistance();
  $('sel-distance').addEventListener('change', (e) => {
    S.radius = Number(e.target.value);
    store.set('radius', S.radius);
    showDistance();
    findNearMe();
  });
  $('tab-list').addEventListener('click', () => selectTab('list'));
  $('tab-map').addEventListener('click', () => selectTab('map'));
  $('btn-menu').addEventListener('click', () => $('sheet-settings').showModal());
  // Map key: open with the button, close with ×
  const setLegend = (open) => {
    $('map-legend').hidden = !open;
    $('btn-legend').hidden = open;
    $('btn-legend').setAttribute('aria-expanded', String(open));
  };
  $('btn-legend').addEventListener('click', () => setLegend(true));
  $('btn-legend-close').addEventListener('click', () => setLegend(false));
  $('btn-signout').addEventListener('click', signOut);
  $('btn-denied-signout').addEventListener('click', signOut);

  addEventListener('online', () => { updateStatus(); maybeQuery(); });
  addEventListener('offline', updateStatus);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      // Coming back to the app: refresh the position so distances are current
      if (S.access) navigator.geolocation.getCurrentPosition(onFix, () => {}, { enableHighAccuracy: true, maximumAge: 10000 });
      if (S.access) pollWorkStatus();   // pick up anything colleagues logged while the app was in the background
    }
  });
  setInterval(() => {                                             // and every 45 seconds while it's open
    if (!S.access) return;
    pollWorkStatus();
    if (!navigator.onLine) { renderActiveJobs(); checkOverdue(); }  // long-job reminder works offline too
  }, 45000);
  wireOverdue();

  const unconfigured = !DEMO && (!C.supabaseUrl || C.supabaseUrl.includes('YOUR-PROJECT-REF'));
  if (unconfigured) {
    showLogin('This app has not been set up yet: add your Supabase details to config.js. To try it now, add ?demo to the address.', true);
    $('form-email').hidden = true;
    $('form-password').hidden = true;
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
  if (session) {
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    await enterApp();
  } else if (linkError) {
    history.replaceState(null, '', location.pathname + location.search);
    showLogin(/expired/i.test(linkError)
      ? 'That sign-in link has expired or was already used. Request a new one.'
      : `Sign-in link didn't work: ${linkError}`, true);
  } else {
    showLogin(DEMO ? (LOGIN_METHOD === 'password' ? 'Demo mode: use any email and the password demo1234.' : 'Demo mode: use any email, then code 123456.') : '');
  }
}

init();
