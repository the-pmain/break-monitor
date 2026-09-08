'use strict';
/* Break Monitor — browser client (src/client). Served by src/server.
   Talks to the same origin. All timing is anchored to server time. */
(function () {
const MIN = 60000;
const $  = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

/* ---------------- api ---------------- */
const BASE = '';
const MGR_KEY = 'bm-director-session';
let mgrToken = null;
let mgrPin = null;

function persistDirector() {
  try {
    if (!mgrToken) localStorage.removeItem(MGR_KEY);
    else localStorage.setItem(MGR_KEY, JSON.stringify({ token: mgrToken, pin: mgrPin || undefined }));
  } catch {}
}

function setDirectorSession(token, pin) {
  mgrToken = token;
  if (pin) mgrPin = String(pin);
  persistDirector();
}

function clearDirectorSession() {
  mgrToken = null;
  mgrPin = null;
  persistDirector();
}

async function loginDirector(pin) {
  const res = await fetch(BASE + '/api/manager/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: String(pin) })
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false || !json.token) throw new Error(json.error || 'Incorrect PIN');
  setDirectorSession(json.token, pin);
  return json;
}

async function restoreDirectorSession() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(MGR_KEY) || 'null'); } catch {}
  if (!saved || (!saved.token && !saved.pin)) return;
  if (saved.pin) mgrPin = String(saved.pin);
  if (saved.token) {
    mgrToken = saved.token;
    try {
      const res = await fetch(BASE + '/api/manager/session', {
        headers: { 'x-manager-token': mgrToken }
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json.ok !== false) {
        persistDirector();
        return;
      }
    } catch {}
    mgrToken = null;
  }
  if (mgrPin && /^\d{4,8}$/.test(mgrPin)) {
    try { await loginDirector(mgrPin); } catch { clearDirectorSession(); }
  } else {
    clearDirectorSession();
  }
}

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (mgrToken) headers['x-manager-token'] = mgrToken;
  const res = await fetch(BASE + path, {
    method: opts.method,
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  let json = {};
  try { json = await res.json(); } catch {}
  if (res.status === 401 && path.indexOf('/api/manager/') === 0 && path !== '/api/manager/login' && mgrPin && !opts._retried) {
    try {
      await loginDirector(mgrPin);
      return api(path, Object.assign({}, opts, { _retried: true }));
    } catch {
      clearDirectorSession();
    }
  }
  if (!res.ok || json.ok === false) {
    if (res.status === 401 && session && opts.body && sameId(opts.body.employeeId, session.id)) {
      clearSession();
    }
    throw new Error(json.error || ('Request failed (' + res.status + ')'));
  }
  return json;
}

/* ---------------- clock ---------------- */
let offset = 0;                       // serverTime - clientTime
const now = () => Date.now() + offset;

/* ---------------- shared state ---------------- */
let ST = { employees: [], history: [], config: { allowances: [30,15,10,5], allowanceLabels: {}, siteName: 'Break Monitor' } };
let online = false, failures = 0;
const empById = id => ST.employees.find(e => Number(e.id) === Number(id));
const sameId = (a, b) => Number(a) === Number(b);
const cat = e => (e && (e.category || e.dept)) || '';

/* ---------------- formatting ---------------- */
const p2 = n => String(n).padStart(2, '0');
function validTs(ts) {
  const n = Number(ts);
  return Number.isFinite(n) && n > 0 ? n : null;
}
const fmtClock = ts => {
  const n = validTs(ts);
  if (n == null) return '—';
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return '—';
  return p2(d.getHours()) + ':' + p2(d.getMinutes());
};
const fmtDate = ts => {
  const n = validTs(ts);
  if (n == null) return '—';
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return '—';
  return p2(d.getDate()) + '/' + p2(d.getMonth() + 1) + '/' + d.getFullYear();
};
function todayYmd() {
  const d = new Date(now());
  return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
}
const fmtMS    = ms => { ms = Math.max(0, Math.round(ms / 1000)); return p2(Math.floor(ms / 60)) + ':' + p2(ms % 60); };
function fmtLoose(ms) { const s = Math.round(Math.abs(ms) / 1000), m = Math.floor(s / 60), r = s % 60; return m > 0 ? m + 'm ' + p2(r) + 's' : r + 's'; }
function dueAtFor(e) {
  if (!e || !e.break) return null;
  const due = validTs(e.break.dueAt);
  if (due != null) return due;
  const started = validTs(e.break.startedAt);
  const allow = Number(e.break.allowanceMin);
  if (started == null || !Number.isFinite(allow)) return null;
  return started + allow * MIN;
}
const remaining = e => {
  const due = dueAtFor(e);
  return due != null ? due - now() : 0;
};
function fmtSpan(ms) {
  const s = Math.max(0, Math.round(Math.abs(ms) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  if (h > 0) return h + 'h ' + m + 'm';
  return m + 'm';
}
function shiftLine(e) {
  const bits = [cat(e)];
  if (e.shiftStart) bits.push('Shift ' + e.shiftStart + ' – ' + e.shiftEnd);
  return bits.filter(Boolean).join(' · ');
}
function shiftProgress(e) {
  if (!e.shiftStart) return '';
  if (e.onRoster && e.shiftElapsedMs != null)
    return fmtSpan(e.shiftElapsedMs) + ' into shift' + (e.shiftRemainingMs != null ? ' · ' + fmtSpan(e.shiftRemainingMs) + ' left' : '');
  return 'Outside rostered hours';
}

function parseHm(s) {
  const m = String(s || '').match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function onRosterNow(e) {
  if (!e || e.active === false) return false;
  const startMin = parseHm(e.shiftStart);
  const endMin = parseHm(e.shiftEnd);
  if (startMin == null || endMin == null) return true;
  const d = new Date(now());
  const nowMin = d.getHours() * 60 + d.getMinutes();
  if (startMin === endMin) return true;
  if (startMin > endMin) return nowMin >= startMin || nowMin < endMin;
  return nowMin >= startMin && nowMin < endMin;
}

function personStatus(e) {
  if (e && e.break && e.break.id != null) {
    return remaining(e) < 0
      ? { key: 'overdue', color: '#e05555', label: 'Break overdue' }
      : { key: 'break', color: '#c5cdd8', label: 'On break' };
  }
  if (e && e.active === false) return { key: 'left', color: '#737D8C', label: 'Left for the day' };
  if (onRosterNow(e)) return { key: 'working', color: '#6ee7a8', label: 'On shift' };
  return { key: 'off', color: '#737D8C', label: 'Off shift' };
}

const COLORS = ['#3d4f6f','#4a5d82','#2e3a52','#5c6b80','#1e3250','#6b7a90','#252d3a','#8b96a8'];
const initials = n => String(n).trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
const colorOf  = id => COLORS[(Number(id) - 1) % COLORS.length];
const avatar   = (e, size) => '<span class="av" style="background:' + colorOf(e.id) +
  (size ? ';width:' + size + 'px;height:' + size + 'px;font-size:' + Math.round(size / 3) + 'px' : '') + '">' + esc(initials(e.name)) + '</span>';

/* ---------------- toasts ---------------- */
function toast(kind, title, body) {
  const n = document.createElement('div');
  n.className = 'toast ' + (kind || '');
  n.innerHTML = '<div><b>' + esc(title) + '</b><span>' + esc(body) + '</span></div>';
  $('#toasts').appendChild(n);
  setTimeout(() => { n.style.transition = '.3s'; n.style.opacity = '0'; n.style.transform = 'translateY(10px)';
                     setTimeout(() => n.remove(), 320); }, 5200);
}

function setConfirmBusy(on, label) {
  const veil = $('#confirmModal');
  const busy = $('#confirmBusy');
  const ok = $('#confirmOk');
  const cancel = $('#confirmCancel');
  if (veil) {
    veil.classList.toggle('is-busy', !!on);
    veil.setAttribute('aria-busy', on ? 'true' : 'false');
  }
  if (busy) {
    busy.classList.toggle('hidden', !on);
    const txt = $('#confirmBusyLabel');
    if (txt && label) txt.textContent = label;
  }
  if (ok) ok.disabled = !!on;
  if (cancel) cancel.disabled = !!on;
}

function paintConfirm({ title, lead, warn, okLabel }) {
  $('#confirmTitle').textContent = title || 'Are you sure?';
  $('#confirmLead').textContent = lead || '';
  const warnEl = $('#confirmWarn');
  warnEl.textContent = warn || '';
  warnEl.classList.toggle('hidden', !warn);
  $('#confirmOk').textContent = okLabel || 'Confirm';
}

function askConfirm({ title, lead, warn, okLabel, prepare, prepareLabel, onConfirm, confirmBusy }) {
  return new Promise(resolve => {
    const veil = $('#confirmModal');
    if (!veil) { resolve(window.confirm(title || 'Are you sure?')); return; }
    let settled = false;
    let locked = false;
    paintConfirm({ title, lead, warn, okLabel });
    setConfirmBusy(false);
    veil.classList.remove('hidden');

    const finish = yes => {
      if (settled) return;
      if (locked) return;
      settled = true;
      setConfirmBusy(false);
      veil.classList.add('hidden');
      $('#confirmOk').onclick = null;
      $('#confirmCancel').onclick = null;
      veil.onclick = null;
      document.removeEventListener('keydown', onKey);
      resolve(!!yes);
    };

    const onKey = e => {
      if (e.key === 'Escape' && !locked) finish(false);
    };
    document.addEventListener('keydown', onKey);
    $('#confirmCancel').onclick = () => finish(false);
    veil.onclick = e => { if (e.target === veil && !locked) finish(false); };
    $('#confirmOk').onclick = async () => {
      if (locked || settled) return;
      if (!onConfirm) { finish(true); return; }
      locked = true;
      setConfirmBusy(true, confirmBusy || 'Please wait…');
      try {
        await onConfirm();
        locked = false;
        finish(true);
      } catch (err) {
        locked = false;
        setConfirmBusy(false);
        toast('', 'Could not remove', err.message);
      }
    };
    $('#confirmCancel').focus();

    if (prepare) {
      setConfirmBusy(true, prepareLabel || 'Please wait…');
      Promise.resolve(prepare()).then(extra => {
        if (settled) return;
        if (extra) paintConfirm({
          title: extra.title != null ? extra.title : title,
          lead: extra.lead != null ? extra.lead : lead,
          warn: extra.warn != null ? extra.warn : warn,
          okLabel: extra.okLabel != null ? extra.okLabel : okLabel
        });
        setConfirmBusy(false);
        $('#confirmCancel').focus();
      }).catch(() => {
        if (settled) return;
        setConfirmBusy(false);
      });
    }
  });
}

/* ================= EMPLOYEE KIOSK ================= */
const SESSION_KEY = 'bm-employee-session';
let session = null;            // {id, pin}
let lastHomeKey = '';
let pinBuf = '', pinTarget = null;
const showK = id => ['#k-lock','#k-pin','#k-home'].forEach(s => $(s).classList.toggle('hidden', s !== id));
const staffPath = () => session ? '/staff/' + session.id : '/staff';

function readStoredSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    const id = Number(o && o.id);
    const pin = String((o && o.pin) || '');
    if (!Number.isFinite(id) || id < 1 || !/^\d{4}$/.test(pin)) return null;
    return { id, pin };
  } catch { return null; }
}

function persistSession() {
  try {
    if (!session) localStorage.removeItem(SESSION_KEY);
    else localStorage.setItem(SESSION_KEY, JSON.stringify({
      id: session.id, pin: session.pin
    }));
  } catch {}
}

function setSession(next) {
  session = next;
  persistSession();
}

function clearSession() {
  session = null;
  lastHomeKey = '';
  persistSession();
}

async function restoreEmployeeSession() {
  const saved = readStoredSession();
  if (!saved) return;
  try {
    const res = await fetch(BASE + '/api/employee/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employeeId: saved.id, pin: saved.pin })
    });
    if (res.status === 401) { clearSession(); return; }
    setSession(saved);
  } catch {
    setSession(saved);
  }
}

function renderPeople() {
  const g = $('#peopleGrid');
  const cfg = ST.config || {};
  let empty = 'No coworkers yet. A manager can add them under <b>Director → Staff</b>, or they can be added in the Supabase <code>coworkers</code> table.';
  if (cfg.staffSource === 'unconfigured')
    empty = 'Supabase is not configured yet. Add <code>SUPABASE_URL</code> and a key to the server <b>.env</b> file.';
  else if (cfg.staffError)
    empty = 'Could not load coworkers from Supabase: <b>' + esc(cfg.staffError) + '</b>';
  $('#noStaff').innerHTML = empty;
  $('#noStaff').classList.toggle('hidden', ST.employees.length > 0);
  g.innerHTML = ST.employees.map(e => {
    const st = personStatus(e);
    return '<a class="person" href="/staff/' + e.id + '" data-eid="' + esc(e.id) + '" data-st="' + st.key + '">' + avatar(e) +
      '<span><span class="nm">' + esc(e.name) + '</span>' +
      '<span class="mt"><i style="background:' + st.color + '"></i><span class="st">' + esc(st.label) + '</span></span></span></a>';
  }).join('');
}

function paintPeopleStatus() {
  const g = $('#peopleGrid');
  if (!g || $('#k-lock').classList.contains('hidden')) return;
  $$('#peopleGrid .person').forEach(el => {
    const e = empById(el.dataset.eid);
    if (!e) return;
    const st = personStatus(e);
    if (el.dataset.st === st.key) return;
    el.dataset.st = st.key;
    const i = el.querySelector('.mt i');
    const lab = el.querySelector('.mt .st');
    if (i) i.style.background = st.color;
    if (lab) lab.textContent = st.label;
  });
}

function buildPad(container, onKey) {
  container.innerHTML = ['1','2','3','4','5','6','7','8','9','clear','0','del']
    .map(k => '<button data-k="' + k + '" class="' + (k === 'clear' || k === 'del' ? 'util' : '') + '">' +
      (k === 'clear' ? 'Clear' : k === 'del' ? '⌫' : k) + '</button>').join('');
  container.addEventListener('click', e => { const b = e.target.closest('button'); if (b) onKey(b.dataset.k); });
}
const paintDots = (sel, len) => $$(sel + ' span').forEach((s, i) => s.classList.toggle('on', i < len));

function openPin(pid) {
  pinTarget = pid; pinBuf = '';
  const e = empById(pid); if (!e) return;
  $('#pinName').textContent = 'Hi ' + e.name.split(' ')[0];
  $('#pinDept').textContent = [shiftLine(e), e.status !== 'break' ? shiftProgress(e) : ''].filter(Boolean).join(' · ');
  $('#pinErr').textContent = ''; paintDots('#pinDots', 0); showK('#k-pin');
}

async function pinKey(k) {
  if (k === 'clear') pinBuf = '';
  else if (k === 'del') pinBuf = pinBuf.slice(0, -1);
  else if (pinBuf.length < 4) pinBuf += k;
  paintDots('#pinDots', pinBuf.length);
  $('#pinErr').textContent = '';
  if (pinBuf.length !== 4) return;

  const pin = pinBuf;
  try {
    await api('/api/employee/verify', { method: 'POST', body: { employeeId: pinTarget, pin } });
    lastHomeKey = '';
    setSession({ id: pinTarget, pin });
    navigate('/staff/' + pinTarget, { replace: true });
  } catch (err) {
    $('#pinErr').textContent = err.message;
    $('#pinDots').classList.add('shake');
    setTimeout(() => $('#pinDots').classList.remove('shake'), 420);
  }
  pinBuf = ''; paintDots('#pinDots', 0);
}

function byStart(a, b) {
  return (b.startedAt || 0) - (a.startedAt || 0);
}

function isOverAllowance(h) {
  return (h.over || 0) > 0;
}

function wherePills(room) {
  if (!room) return '<span class="mut">At station</span>';
  return '<span class="where-badges"><span class="pill quiet">Left room</span></span>';
}

const openFloor = new Set();
const CHEV = '<span class="floor-chev" aria-hidden="true"><svg width="12" height="12" viewBox="0 0 12 12"><path d="M4.2 2.2L8 6l-3.8 3.8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></span>';

function liveWhereCell(e) {
  if (e.status === 'break' && e.break)
    return wherePills(!!e.break.isRoomLeaved);
  if (e.status === 'working') return '<span class="mut">At station</span>';
  return '<span class="mut">—</span>';
}

function breaksForEmployee(id) {
  const rows = ST.history.filter(h => sameId(h.employeeId, id)).map(h => Object.assign({}, h, { live: false }));
  const e = empById(id);
  if (e && e.status === 'break' && e.break) {
    const started = validTs(e.break.startedAt);
    const taken = started != null ? Math.max(0, now() - started) : 0;
    const allow = (Number(e.break.allowanceMin) || 0) * MIN;
    rows.unshift({
      id: e.break.id, employeeId: e.id, name: e.name,
      allowanceMin: e.break.allowanceMin,
      startedAt: started, endedAt: null, taken, over: taken - allow,
      isRoomLeaved: !!e.break.isRoomLeaved,
      live: true
    });
  }
  return rows.sort(byStart);
}

function histBreakRow(h) {
  const live = !!h.live || !h.endedAt;
  const started = validTs(h.startedAt);
  const taken = live ? (started != null ? Math.max(0, now() - started) : 0) : (h.taken || 0);
  const over = live ? taken - (Number(h.allowanceMin) || 0) * MIN : (h.over || 0);
  const late = over > 0;
  const allow = h.allowanceMin != null && h.allowanceMin !== '' ? Number(h.allowanceMin) + ' min' : '—';
  const ended = live
    ? '<span class="pill break"><i class="d"></i>In progress</span>'
    : '<span class="num tiny mut">' + fmtClock(h.endedAt) + '</span>';
  const result = late ? '+' + fmtLoose(over) + ' over' : (live ? 'on break' : 'on time');
  return '<tr>' +
    '<td class="num tiny mut">' + fmtClock(started) + '</td>' +
    '<td>' + ended + '</td>' +
    '<td>' + wherePills(!!h.isRoomLeaved) + '</td>' +
    '<td class="num">' + allow + '</td>' +
    '<td class="num' + (late ? ' rem over' : '') + '">' + fmtLoose(taken) + '</td>' +
    '<td><span class="tag ' + (late ? 'bad' : 'ok') + '">' + result + '</span></td></tr>';
}

function nestedBreaksTable(rows) {
  if (!rows.length) return '<div class="empty">No breaks recorded yet today.</div>';
  return '<table class="nested"><thead><tr>' +
    '<th>Started</th><th>Ended</th><th>Where</th><th>Allowance</th><th>Taken</th><th>Result</th>' +
    '</tr></thead><tbody>' + rows.map(histBreakRow).join('') + '</tbody></table>';
}
const CIRC = 2 * Math.PI * 104;
function ringHTML() {
  return '<div class="ring-wrap"><svg width="236" height="236" viewBox="0 0 236 236">' +
    '<circle class="ring-bg" cx="118" cy="118" r="104" fill="none" stroke-width="16"/>' +
    '<circle class="ring-fg" id="ringFg" cx="118" cy="118" r="104" fill="none" stroke-width="16" stroke-linecap="round"/>' +
    '</svg><div class="ring-mid"><div class="t num" id="ringT">--:--</div><div class="l" id="ringL">remaining</div></div></div>' +
    '<div class="mut tiny" id="ringSub" style="margin-top:2px"></div>';
}

function paintRing() {
  if (!session) return;
  const e = empById(session.id); if (!e || e.status !== 'break') return;
  const fg = $('#ringFg'); if (!fg) return;
  const total = Math.max(1, (e.break.allowanceMin || 0) * MIN), rem = remaining(e);
  const frac = Math.max(0, Math.min(1, rem / total));
  fg.setAttribute('stroke-dasharray', CIRC);
  fg.setAttribute('stroke-dashoffset', rem < 0 ? 0 : CIRC * (1 - frac));
  const t = $('#ringT'), l = $('#ringL'), sub = $('#ringSub');
  if (rem < 0) {
    fg.classList.remove('warn'); fg.classList.add('over');
    t.textContent = '+' + fmtMS(-rem); t.className = 't num over overflash';
    l.textContent = 'over your break';
    sub.textContent = 'Allowance ' + e.break.allowanceMin + ' min · started ' + fmtClock(e.break.startedAt);
  } else {
    fg.classList.toggle('warn', rem < Math.min(2 * MIN, total * 0.2));
    fg.classList.remove('over');
    t.textContent = fmtMS(rem); t.className = 't num';
    l.textContent = 'remaining';
    sub.textContent = e.break.allowanceMin + ' min break · started ' + fmtClock(e.break.startedAt) +
      ' · due back ' + fmtClock(e.break.dueAt);
  }
}

function breakAllowances() {
  const raw = ST.config && ST.config.allowances;
  const list = (Array.isArray(raw) ? raw : []).map(Number).filter(n => n > 0 && n <= 240);
  return list.length ? list : [30, 15, 10, 5];
}

function allowanceGrid() {
  const labels = (ST.config && ST.config.allowanceLabels) || {};
  return '<div class="allow-grid">' + breakAllowances().map(m =>
    '<button type="button" class="allow" data-act="start" data-m="' + m + '">' +
      '<b class="num">' + m + '</b><span>minutes</span>' +
      '<small>' + esc(labels[m] || '') + '</small></button>').join('') + '</div>';
}

function renderHome() {
  if (!session) return;
  const e = empById(session.id);
  if (!e) { clearSession(); navigate('/staff', { replace: true }); return; }
  const c = $('#homeCard');
  const head = '<div class="home-top">' + avatar(e, 52) +
    '<span><h1>' + esc(e.name) + '</h1><div class="sh">' +
    esc(shiftLine(e)) + '</div></span></div>';

  if (e.status === 'break') {
    c.innerHTML = head + ringHTML() +
      '<div class="row-actions"><button class="btn danger" data-act="end">End break &amp; return to work</button></div>' +
      leaveBlock() +
      '<div class="footnote" style="margin:16px 0 0">Your manager can see this break on the dashboard.</div>';
    paintRing();
  } else if (e.status === 'left') {
    c.innerHTML = head +
      '<p class="mut" style="margin:18px 0 22px">You left for the day.</p>' +
      '<div class="row-actions"><button class="btn primary" data-act="return">Back on shift</button>' +
      '<button class="btn ghost" data-act="signout">Sign out</button></div>';
  } else {
    const offNote = e.status === 'off'
      ? '<p class="mut" style="margin:12px 0 0">Outside rostered hours — you can still start a break.</p>'
      : '';
    c.innerHTML = head +
      offNote +
      '<div class="allow-label">Select a break allowance</div>' +
      allowanceGrid() +
      leaveBlock() +
      '<div class="row-actions"><button class="btn ghost" data-act="signout">Sign out</button></div>';
  }
}

function leaveBlock() {
  return '<div class="leave-row">' +
    '<button class="btn leave" data-act="leave">Leave</button></div>';
}

$('#homeCard').addEventListener('click', async e => {
  const b = e.target.closest('[data-act]'); if (!b || !session || homeBusy) return;
  const act = b.dataset.act;
  if (act === 'signout') { clearSession(); navigate('/staff'); return; }
  const body = { employeeId: session.id, pin: session.pin };
  const mins = Number(b.dataset.m);
  const labels = {
    start: 'Starting ' + (mins || '') + '-minute break…',
    end: 'Ending break…',
    leave: 'Leaving for the day…',
    return: 'Signing back on…'
  };
  $$('#homeCard [data-act]').forEach(x => { x.disabled = true; });
  if (act === 'start') {
    b.classList.add('loading');
    if (!b.querySelector('.spin')) b.insertAdjacentHTML('beforeend', '<i class="spin"></i>');
  }
  setHomeBusy(true, labels[act] || 'Please wait…');
  try {
    if (act === 'start') {
      await api('/api/break/start', { method: 'POST', body: {
        ...body, allowanceMin: mins,
        isRoomLeaved: true, isFloorLeaved: false
      } });
      toast('info', 'Break started', mins + ' minutes · due back ' + fmtClock(now() + mins * MIN));
    } else if (act === 'end') {
      const emp = empById(session.id), rem = remaining(emp);
      await api('/api/break/end', { method: 'POST', body });
      toast(rem < 0 ? '' : 'good', 'Break ended',
        rem < 0 ? 'Returned ' + fmtLoose(rem) + ' late.' : 'Returned with ' + fmtLoose(rem) + ' to spare.');
    } else if (act === 'leave') {
      await api('/api/employee/leave', { method: 'POST', body });
      toast('info', 'Shift ended', 'You have left for the day.');
    } else if (act === 'return') {
      await api('/api/employee/return', { method: 'POST', body });
      toast('good', 'Back on shift', 'You can take breaks again.');
    }
    await refresh();
  } catch (err) {
    toast('', 'Something went wrong', err.message);
  } finally {
    setHomeBusy(false);
    if (session) renderHome();
    else if (currentRoute && (currentRoute.name === 'employee' || currentRoute.name === 'staff-home')) {
      navigate('/staff', { replace: true });
    } else { renderPeople(); showK('#k-lock'); }
  }
});

buildPad($('#pinPad'), pinKey);

/* ================= MANAGER ================= */
let mgrBuf = '';
buildPad($('#mgrPad'), async k => {
  if (k === 'clear') mgrBuf = '';
  else if (k === 'del') mgrBuf = mgrBuf.slice(0, -1);
  else if (mgrBuf.length < 4) mgrBuf += k;
  paintDots('#mgrDots', mgrBuf.length);
  $('#mgrErr').textContent = '';
  if (mgrBuf.length !== 4) return;
  const pin = mgrBuf; mgrBuf = '';
  try {
    await loginDirector(pin);
    ensureLateDates();
    loadSettings();
    applyRoute(Router.parse(location.pathname));
  } catch (err) {
    $('#mgrErr').textContent = err.message;
    $('#mgrDots').classList.add('shake');
    setTimeout(() => $('#mgrDots').classList.remove('shake'), 420);
  }
  paintDots('#mgrDots', 0);
});


function renderManager() {
  if (!mgrToken) return;
  const emps = ST.employees;
  const onBreak = emps.filter(e => e.status === 'break');
  const overdue = onBreak.filter(e => remaining(e) < 0);
  const onShift = emps.filter(e => e.status === 'working' || e.status === 'break');
  const liveRoom = onBreak.filter(e => e.break && e.break.isRoomLeaved);
  const roomPeople = new Map();
  liveRoom.forEach(e => roomPeople.set(e.id, e.name));
  ST.history.forEach(h => {
    if (h.isRoomLeaved) roomPeople.set(h.employeeId, h.name);
  });
  const roomNames = [...roomPeople.values()].map(n => n.split(' ')[0]).join(', ');
  const roomTimes = ST.history.filter(h => h.isRoomLeaved).length + liveRoom.length;

  $('#tiles').innerHTML = [
    ['On shift', onShift.length, onShift.length + ' of ' + emps.length + ' staff', ''],
    ['Working', onShift.length - onBreak.length, 'at their station', ''],
    ['On break', onBreak.length, onBreak.length ? onBreak.map(e => e.name.split(' ')[0]).join(', ') : 'nobody right now', ''],
    ['Left room', roomTimes, roomTimes === 1 ? '1 time today · ' + (roomNames || 'nobody') : roomTimes + ' times today · ' + (roomPeople.size ? roomPeople.size + ' people' : 'nobody'), ''],
    ['Overdue', overdue.length, overdue.length ? 'needs attention' : 'all within allowance', overdue.length ? 'alert' : ''],
    ['Breaks today', ST.history.length, roomTimes + ' left room', '']
  ].map(([k, v, f, cls]) => '<div class="tile ' + cls + '"><div class="k">' + k + '</div><div class="v num">' + v +
    '</div><div class="f">' + esc(f) + '</div></div>').join('');

  const banner = $('#overBanner');
  banner.classList.toggle('show', overdue.length > 0);
  if (overdue.length) $('#overBannerTxt').innerHTML = overdue.map(e =>
    '<b>' + esc(e.name) + '</b> is ' + fmtLoose(remaining(e)) + ' over a ' + e.break.allowanceMin + '-minute break').join(' &nbsp;·&nbsp; ');

  const lateN = overdue.length + ST.history.filter(isOverAllowance).length;
  const lateBadge = $('#lateTabCount');
  if (lateBadge) {
    lateBadge.textContent = lateN ? String(lateN) : '';
    lateBadge.classList.toggle('hidden', !lateN);
  }

  const rank = e => {
    if (e.status === 'break' && remaining(e) < 0) return 0;
    if (e.status === 'break' && e.break && e.break.isRoomLeaved) return 1;
    if (e.status === 'break') return 2;
    if (e.status === 'working') return 4;
    if (e.status === 'left') return 5;
    return 6;
  };
  const rows = [...emps].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  [...openFloor].forEach(id => { if (!breaksForEmployee(id).length) openFloor.delete(id); });

  $('#rosterSub').textContent = onShift.length + ' on shift · ' + onBreak.length + ' on break · ' +
    roomTimes + ' left room';
  $('#rosterBody').innerHTML = rows.map(e => {
    const br = e.status === 'break' ? e.break : null;
    const isBreak = !!br;
    const allowMin = isBreak && br.allowanceMin != null ? Number(br.allowanceMin) : NaN;
    const allowMs = Number.isFinite(allowMin) ? Math.max(1, allowMin * MIN) : MIN;
    const rem = isBreak ? remaining(e) : 0;
    const over = isBreak && rem < 0;
    const frac = isBreak ? Math.max(0, Math.min(1, rem / allowMs)) : 0;
    const barCls = over ? 'over' : (isBreak && rem < Math.min(2 * MIN, allowMs * 0.2) ? 'warn' : '');
    const pill = e.status === 'left' ? '<span class="pill off"><i class="d"></i>Left for the day</span>'
               : e.status === 'off' ? '<span class="pill off"><i class="d"></i>Off shift</span>'
               : over ? '<span class="pill over"><i class="d"></i>Overdue</span>'
               : isBreak ? '<span class="pill break"><i class="d"></i>On break</span>'
               : e.status === 'working' ? '<span class="pill working"><i class="d"></i>Working</span>'
               : '<span class="pill off"><i class="d"></i>—</span>';
    const theirBreaks = breaksForEmployee(e.id);
    const hasBreaks = theirBreaks.length > 0;
    const opened = hasBreaks && openFloor.has(Number(e.id));
    const breakCell = isBreak && Number.isFinite(allowMin) ? allowMin + ' min' : '—';
    const startCell = isBreak ? fmtClock(br.startedAt) : '—';
    const remCell = isBreak && dueAtFor(e)
      ? '<div class="rem num ' + (over ? 'over' : '') + '">' + (over ? '+' + fmtMS(-rem) + ' over' : fmtMS(rem)) + '</div>' +
        '<div class="bar"><i class="' + barCls + '" style="width:' + (over ? 100 : frac * 100).toFixed(1) + '%"></i></div>'
      : '<span class="mut">—</span>';
    const actionCell = isBreak && br.id != null
      ? '<button class="mini-btn" data-end="' + esc(br.id) + '">End break</button>'
      : '<span class="mut tiny">—</span>';
    const hint = hasBreaks
      ? (opened ? 'Hide today\'s breaks' : 'Show today\'s breaks')
      : '';
    const trClass = ['floor-row', over ? 'is-over' : '', hasBreaks ? 'has-breaks' : '', opened ? 'open' : '']
      .filter(Boolean).join(' ');
    const main = '<tr class="' + trClass + '" data-eid="' + esc(e.id) + '"' +
      (hasBreaks ? ' data-has-breaks="1" aria-expanded="' + String(opened) + '" title="' + esc(hint) + '"' : '') + '>' +
      '<td><div class="who">' + CHEV + avatar(e, 34) + '<span><div class="nm">' + esc(e.name) + '</div><div class="dp">' +
        esc([shiftLine(e), e.status !== 'break' ? shiftProgress(e) : '', hasBreaks ? (opened ? 'Hide breaks' : theirBreaks.length + (theirBreaks.length === 1 ? ' break today' : ' breaks today')) : ''].filter(Boolean).join(' · ')) +
        '</div></span></div></td>' +
      '<td>' + liveWhereCell(e) + '</td>' +
      '<td>' + pill + '</td>' +
      '<td class="tiny mut">' + breakCell + '</td>' +
      '<td class="tiny mut num">' + startCell + '</td>' +
      '<td>' + remCell + '</td>' +
      '<td class="right">' + actionCell + '</td></tr>';
    if (!opened) return main;
    return main + '<tr class="floor-detail' + (over ? ' is-over' : '') + '"><td colspan="7">' +
      nestedBreaksTable(theirBreaks) + '</td></tr>';
  }).join('');

  $('#histCount').textContent = ST.history.length + ' recorded · ' + roomTimes + ' left room';
  const todayHist = [...ST.history].sort(byStart);
  $('#histBody').innerHTML = todayHist.length ? todayHist.map(h => {
    const late = isOverAllowance(h);
    return '<tr>' +
      '<td class="num tiny mut">' + fmtClock(h.startedAt) + '</td>' +
      '<td class="num tiny mut">' + fmtClock(h.endedAt) + '</td>' +
      '<td><div class="who">' + avatar({ id: h.employeeId, name: h.name }, 28) +
        '<span><div class="nm">' + esc(h.name) + '</div></span></div></td>' +
      '<td>' + wherePills(h.isRoomLeaved) + '</td>' +
      '<td class="num">' + h.allowanceMin + ' min</td>' +
      '<td class="num' + (late ? ' rem over' : '') + '">' + fmtLoose(h.taken) + '</td>' +
      '<td><span class="tag ' + (late ? 'bad' : 'ok') + '">' + (late ? '+' + fmtLoose(h.over) + ' over' : 'on time') + '</span></td></tr>';
  }).join('') : '<tr><td colspan="7"><div class="empty">No breaks recorded yet today.</div></td></tr>';
}

$('#rosterBody').addEventListener('click', async e => {
  const b = e.target.closest('[data-end]');
  if (b) {
    b.disabled = true;
    try {
      await api('/api/manager/break/' + b.dataset.end + '/end', { method: 'POST' });
      toast('info', 'Break ended', 'Marked back at work by manager.');
      await refresh();
    } catch (err) { toast('', 'Could not end break', err.message); b.disabled = false; }
    return;
  }
  const row = e.target.closest('tr[data-eid]');
  if (!row || row.dataset.hasBreaks !== '1') return;
  const id = Number(row.dataset.eid);
  if (!Number.isFinite(id)) return;
  if (openFloor.has(id)) openFloor.delete(id); else openFloor.add(id);
  renderManager();
});

/* ---------------- history pane ---------------- */
let historyRows = [];
async function loadHistory() {
  if (!mgrToken) return;
  try {
    const r = await api('/api/manager/history?days=' + ($('#histDays').value || 7));
    historyRows = (r.history || []).slice().sort(byStart);
    $('#histTable').innerHTML = historyRows.length ? historyRows.map(h => {
      const late = isOverAllowance(h);
      return '<tr><td class="tiny mut num">' + fmtDate(h.startedAt) + '</td>' +
        '<td><b>' + esc(h.name) + '</b><div class="dp tiny mut">' + esc(h.category || h.dept) + '</div></td>' +
        '<td>' + wherePills(h.isRoomLeaved) + '</td>' +
        '<td class="num">' + h.allowanceMin + ' min</td>' +
        '<td class="num tiny mut">' + fmtClock(h.startedAt) + '</td>' +
        '<td class="num tiny mut">' + fmtClock(h.endedAt) + '</td>' +
        '<td class="num' + (late ? ' rem over' : '') + '">' + fmtLoose(h.taken) + '</td>' +
        '<td><span class="tag ' + (late ? 'bad' : 'ok') + '">' + (late ? '+' + fmtLoose(h.over) + ' over' : 'on time') + '</span></td></tr>';
    }).join('') : '<tr><td colspan="8"><div class="empty">No records for this period.</div></td></tr>';
  } catch (err) { toast('', 'Could not load history', err.message); }
}
$('#histDays').addEventListener('change', loadHistory);
$('#histCsv').addEventListener('click', () => {
  const rows = [['Date','Staff','Category','Allowance (min)','Started','Ended','Taken (min)','Over (min)','Left room','Ended by']];
  historyRows.forEach(h => rows.push([fmtDate(h.startedAt), h.name, h.category || h.dept, h.allowanceMin,
    fmtClock(h.startedAt), fmtClock(h.endedAt), (h.taken / MIN).toFixed(2), (h.over / MIN).toFixed(2),
    h.isRoomLeaved ? 'yes' : 'no', h.endedBy]));
  const csv = rows.map(r => r.map(v => '"' + String(v).replace(/"/g, '""') + '"').join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url; a.download = 'break-records.csv'; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
});

/* ---------------- late pane ---------------- */
let lateRows = [];
function ensureLateDates() {
  const t = todayYmd();
  if ($('#lateFrom') && !$('#lateFrom').value) $('#lateFrom').value = t;
  if ($('#lateTo') && !$('#lateTo').value) $('#lateTo').value = t;
}
function lateRange() {
  ensureLateDates();
  let from = $('#lateFrom').value;
  let to = $('#lateTo').value;
  const t = todayYmd();
  if (from > to) { const x = from; from = to; to = x; $('#lateFrom').value = from; $('#lateTo').value = to; }
  $('#lateToday').classList.toggle('on', from === t && to === t);
  return { from, to };
}
function lateTaken(h) {
  if (h.live || !h.endedAt) {
    const started = validTs(h.startedAt);
    return started != null ? Math.max(0, now() - started) : 0;
  }
  return h.taken || 0;
}
function lateOver(h) {
  return lateTaken(h) - (Number(h.allowanceMin) || 0) * MIN;
}
let lateLoading = false;
let lateLoadId = 0;
function setLateLoading(on) {
  lateLoading = !!on;
  const busy = $('#lateBusy');
  const card = $('.late-card');
  if (busy) {
    busy.classList.toggle('hidden', !on);
    busy.setAttribute('aria-busy', on ? 'true' : 'false');
  }
  if (card) card.classList.toggle('is-loading', !!on);
  if (on && $('#lateCount')) $('#lateCount').textContent = 'Loading…';
}
function paintLateTable() {
  if (lateLoading || !$('#lateTable')) return;
  const rows = lateRows;
  const stillOut = rows.filter(h => h.live || !h.endedAt).length;
  const totalOver = rows.reduce((a, h) => a + Math.max(0, lateOver(h)), 0);
  $('#lateCount').textContent = rows.length
    ? rows.length + ' late' + (stillOut ? ' · ' + stillOut + ' still out' : '') + ' · ' + fmtLoose(totalOver) + ' over'
    : '';
  $('#lateTable').innerHTML = rows.length ? rows.map(h => {
    const over = lateOver(h);
    const live = !!h.live || !h.endedAt;
    return '<tr class="is-over">' +
      '<td class="tiny mut num">' + fmtDate(h.startedAt) + '</td>' +
      '<td><b>' + esc(h.name) + '</b><div class="dp tiny mut">' + esc(h.category || h.dept) + '</div></td>' +
      '<td>' + wherePills(h.isRoomLeaved) + '</td>' +
      '<td class="num">' + h.allowanceMin + ' min</td>' +
      '<td class="num tiny mut">' + fmtClock(h.startedAt) + '</td>' +
      '<td>' + (live ? '<span class="pill over"><i class="d"></i>Still out</span>' : '<span class="num tiny mut">' + fmtClock(h.endedAt) + '</span>') + '</td>' +
      '<td class="num rem over">' + fmtLoose(lateTaken(h)) + '</td>' +
      '<td><span class="tag bad">+' + fmtLoose(over) + '</span></td></tr>';
  }).join('') : '<tr><td colspan="8"><div class="empty">No late breaks in this period.</div></td></tr>';
}
async function loadLate(opts) {
  if (!mgrToken) return;
  const silent = !!(opts && opts.silent);
  if (silent && lateLoading) return;
  const { from, to } = lateRange();
  const id = ++lateLoadId;
  if (!silent) setLateLoading(true);
  try {
    const r = await api('/api/manager/late?from=' + encodeURIComponent(from) + '&to=' + encodeURIComponent(to));
    if (id !== lateLoadId) return;
    lateRows = (r.late || []).slice().sort(byStart);
  } catch (err) {
    if (id !== lateLoadId) return;
    if (!silent) toast('', 'Could not load late breaks', err.message);
  } finally {
    if (id === lateLoadId && !silent) setLateLoading(false);
  }
  if (id === lateLoadId) paintLateTable();
}
$('#lateToday').addEventListener('click', () => {
  const t = todayYmd();
  $('#lateFrom').value = t;
  $('#lateTo').value = t;
  loadLate();
});
$('#lateFrom').addEventListener('change', loadLate);
$('#lateTo').addEventListener('change', loadLate);
$('#lateCsv').addEventListener('click', () => {
  const rows = [['Date','Staff','Category','Allowance (min)','Started','Ended','Taken (min)','Over (min)','Left room','Ended by']];
  lateRows.forEach(h => rows.push([fmtDate(h.startedAt), h.name, h.category || h.dept, h.allowanceMin,
    fmtClock(h.startedAt), (h.live || !h.endedAt) ? 'in progress' : fmtClock(h.endedAt),
    (lateTaken(h) / MIN).toFixed(2), (lateOver(h) / MIN).toFixed(2),
    h.isRoomLeaved ? 'yes' : 'no', h.endedBy || '']));
  const csv = rows.map(r => r.map(v => '"' + String(v).replace(/"/g, '""') + '"').join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url; a.download = 'late-breaks.csv'; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
});

/* ---------------- staff pane ---------------- */
let editingId = null;
async function loadStaff() {
  if (!mgrToken) return;
  try {
    const r = await api('/api/manager/employees');
    const list = r.employees;
    const onFloor = list.filter(e => e.active).length;
    $('#staffCount').textContent = onFloor + ' active · ' + list.length + ' total';
    $('#staffTable').innerHTML = list.length ? list.map(e =>
      '<tr><td><div class="who">' + avatar(e, 34) + '<span><div class="nm">' + esc(e.name) + '</div></span></div></td>' +
      '<td class="tiny mut">' + (esc(cat(e)) || '—') + '</td>' +
      '<td class="tiny mut num">' + (e.shiftStart ? esc(e.shiftStart + ' – ' + e.shiftEnd) : '—') + '</td>' +
      '<td>' + (e.active
        ? '<span class="pill working"><i class="d"></i>Active</span>'
        : '<span class="pill off"><i class="d"></i>Left for the day</span>') + '</td>' +
      '<td class="right"><button class="mini-btn" data-edit="' + e.id + '">Edit</button> ' +
      '<button class="mini-btn warn" data-del="' + e.id + '">Remove</button></td></tr>'
    ).join('') : '<tr><td colspan="5"><div class="empty">No coworkers yet — add the first one above, or in Supabase.</div></td></tr>';
    window.__staff = list;
  } catch (err) { toast('', 'Could not load staff', err.message); }
}

$('#staffTable').addEventListener('click', async e => {
  const ed = e.target.closest('[data-edit]'), del = e.target.closest('[data-del]');
  if (ed) {
    const emp = (window.__staff || []).find(x => x.id === Number(ed.dataset.edit)); if (!emp) return;
    editingId = emp.id;
    $('#fName').value = emp.name; $('#fDept').value = cat(emp);
    $('#fStart').value = emp.shiftStart; $('#fEnd').value = emp.shiftEnd; $('#fPin').value = '';
    $('#staffFormTitle').textContent = 'Edit ' + emp.name;
    $('#fSave').textContent = 'Save changes';
    $('#fCancel').classList.remove('hidden');
    $('#fMsg').textContent = 'Leave PIN blank to keep the current one.'; $('#fMsg').className = 'formmsg mut';
    $('#fName').focus();
  }
  if (del) {
    const emp = (window.__staff || []).find(x => x.id === Number(del.dataset.del)); if (!emp) return;
    const veil = $('#confirmModal');
    if (veil && !veil.classList.contains('hidden')) return;
    await askConfirm({
      title: 'Remove ' + emp.name + '?',
      lead: 'They will be removed from the sign-in screen and the live floor.',
      warn: 'Any break records for this person will also be deleted. This cannot be undone.',
      okLabel: 'Remove coworker',
      prepareLabel: 'Checking break records…',
      prepare: async () => {
        const r = await api('/api/manager/employees/' + emp.id + '/breaks');
        const count = Number(r.count) || 0;
        const warn = count === 1
          ? 'This will also delete their 1 break record. This cannot be undone.'
          : count > 0
            ? 'This will also delete all ' + count + ' of their break records. This cannot be undone.'
            : 'Any break records for this person will also be deleted. This cannot be undone.';
        return { warn };
      },
      confirmBusy: 'Removing ' + emp.name + '…',
      onConfirm: async () => {
        const r = await api('/api/manager/employees/' + emp.id, { method: 'DELETE' });
        const n = Number(r.breaksRemoved) || 0;
        toast('good', 'Removed', emp.name + (n
          ? ' · ' + n + ' break' + (n === 1 ? '' : 's') + ' deleted'
          : ' and their breaks were removed.'));
        if (session && sameId(session.id, emp.id)) clearSession();
        if (editingId === emp.id) resetStaffForm();
        loadStaff(); refresh();
      }
    });
  }
});

function resetStaffForm() {
  editingId = null;
  ['#fName','#fDept','#fStart','#fEnd','#fPin'].forEach(s => $(s).value = '');
  $('#staffFormTitle').textContent = 'Add a coworker';
  $('#fSave').textContent = 'Add coworker';
  $('#fCancel').classList.add('hidden');
  $('#fMsg').textContent = '';
}
$('#fCancel').addEventListener('click', resetStaffForm);

$('#fSave').addEventListener('click', async () => {
  const msg = $('#fMsg');
  const body = {
    name: $('#fName').value.trim(), category: $('#fDept').value.trim(),
    dept: $('#fDept').value.trim(),
    shiftStart: $('#fStart').value.trim(), shiftEnd: $('#fEnd').value.trim(),
    pin: $('#fPin').value.trim()
  };
  try {
    if (!body.name) throw new Error('Name is required');
    if (editingId) {
      if (body.pin && !/^\d{4}$/.test(body.pin)) throw new Error('PIN must be 4 digits');
      if (!body.pin) delete body.pin;
      await api('/api/manager/employees/' + editingId, { method: 'PATCH', body });
      toast('good', 'Saved', body.name + ' updated.');
    } else {
      if (!/^\d{4}$/.test(body.pin)) throw new Error('PIN must be 4 digits');
      await api('/api/manager/employees', { method: 'POST', body });
      toast('good', 'Coworker added', body.name + ' can now sign in.');
    }
    resetStaffForm(); loadStaff(); refresh();
  } catch (err) { msg.className = 'formmsg err'; msg.textContent = err.message; }
});

/* ---------------- settings pane ---------------- */
function loadSettings() {
  $('#sName').value = ST.config.siteName || '';
  $('#sAllow').value = (ST.config.allowances || []).join(', ');
  $('#sPin').value = '';
}
$('#sSave').addEventListener('click', async () => {
  const msg = $('#sMsg');
  try {
    const allowances = $('#sAllow').value.split(',').map(s => Number(s.trim())).filter(n => n > 0);
    if (!allowances.length) throw new Error('Enter at least one break length');
    const body = { siteName: $('#sName').value.trim() || 'Break Monitor', allowances };
    const pin = $('#sPin').value.trim();
    if (pin) { if (!/^\d{4,8}$/.test(pin)) throw new Error('Director PIN must be 4–8 digits'); body.managerPin = pin; }
    await api('/api/manager/settings', { method: 'POST', body });
    msg.className = 'formmsg ok'; msg.textContent = 'Saved';
    $('#sPin').value = '';
    await refresh();
    loadSettings();
    setTimeout(() => { msg.textContent = ''; }, 2500);
  } catch (err) { msg.className = 'formmsg err'; msg.textContent = err.message; }
});
$('#dSeed').addEventListener('click', async () => {
  try { await api('/api/manager/demo/seed', { method: 'POST' }); await refresh(); loadHistory(); loadLate();
        toast('good', 'Demo activity created', 'The floor now has live and historic breaks.'); }
  catch (err) { toast('', 'Could not create demo data', err.message); }
});
$('#dReset').addEventListener('click', async () => {
  if (!confirm('Delete every break record?\n\nCoworkers are kept. This cannot be undone.')) return;
  try { await api('/api/manager/demo/reset', { method: 'POST' }); await refresh(); loadHistory(); loadLate();
        toast('good', 'Records cleared', 'All break history removed.'); }
  catch (err) { toast('', 'Could not clear records', err.message); }
});

/* ================= routes, polling, tick ================= */
const Router = window.BMRouter;
let currentRoute = Router.parse('/staff');

function showMain(view) {
  $('#view-kiosk').classList.toggle('hidden', view !== 'kiosk');
  $('#view-mgr').classList.toggle('hidden', view !== 'mgr');
  $('#view-404').classList.toggle('hidden', view !== '404');
  $('#tab-kiosk').setAttribute('aria-selected', String(view === 'kiosk'));
  $('#tab-mgr').setAttribute('aria-selected', String(view === 'mgr'));
  const staffHref = staffPath();
  $('#tab-kiosk').setAttribute('href', staffHref);
  const brand = $('.brand');
  if (brand) brand.setAttribute('href', '/staff');
}

function setDocTitle() {
  const site = (ST.config && ST.config.siteName) || 'Break Monitor';
  if (!currentRoute || currentRoute.name === 'staff') document.title = site;
  else if (currentRoute.name === 'not-found') document.title = 'Not found · ' + site;
  else if (currentRoute.name === 'director') document.title = site + ' · Director';
  else if (currentRoute.name === 'employee') {
    const e = empById(currentRoute.employeeId);
    const logged = session && sameId(session.id, currentRoute.employeeId);
    document.title = site + ' · ' + (e ? e.name : 'Staff') + (logged ? '' : ' · PIN');
  } else document.title = site + ' · Staff';
}

function showDirectorPane(pane, loadData) {
  const id = Router.DIRECTOR_PANES.indexOf(pane) >= 0 ? pane : 'live';
  $$('.subtabs a').forEach(x => x.setAttribute('aria-selected', String(x.dataset.pane === id)));
  $$('[data-pane-body]').forEach(p => p.classList.toggle('hidden', p.dataset.paneBody !== id));
  $('#tab-mgr').setAttribute('href', '/director/' + id);
  if (!loadData) return;
  if (id === 'history') loadHistory();
  if (id === 'late') loadLate();
  if (id === 'staff') loadStaff();
}

function applyRoute(route) {
  currentRoute = route;
  setDocTitle();

  if (route.name === 'not-found') {
    showMain('404');
    return;
  }

  if (route.name === 'director') {
    showMain('mgr');
    showDirectorPane(route.pane, !!mgrToken);
    $('#m-gate').classList.toggle('hidden', !!mgrToken);
    $('#m-board').classList.toggle('hidden', !mgrToken);
    if (mgrToken) renderManager();
    else { mgrBuf = ''; paintDots('#mgrDots', 0); }
    return;
  }

  showMain('kiosk');

  if (route.name === 'staff') {
    renderPeople();
    showK('#k-lock');
    return;
  }

  if (route.name === 'staff-home') {
    navigate(session ? '/staff/' + session.id : '/staff', { replace: true });
    return;
  }

  if (route.name === 'employee') {
    const id = route.employeeId;
    const e = empById(id);
    if (!e) {
      if (ST.employees.length) {
        navigate(session ? '/staff/' + session.id : '/staff', { replace: true });
        return;
      }
      renderPeople();
      showK('#k-lock');
      return;
    }
    if (session && sameId(session.id, id)) {
      renderHome();
      showK('#k-home');
      lastHomeKey = homeKey();
      return;
    }
    if (pinTarget !== id) openPin(id);
    else showK('#k-pin');
    return;
  }

  renderPeople();
  showK('#k-lock');
}

function navigate(path, opts) {
  const replace = !!(opts && opts.replace);
  const incoming = Router.parse(path);
  const next = incoming.name === 'not-found' ? Router.cleanPath(path) : incoming.path;
  const route = incoming.name === 'not-found'
    ? { name: 'not-found', path: next }
    : incoming;
  const cur = Router.cleanPath(location.pathname);
  if (replace || next !== cur) {
    if (replace) history.replaceState({ path: next }, '', next);
    else history.pushState({ path: next }, '', next);
  }
  applyRoute(route);
}

function onAppLinkClick(e) {
  if (e.defaultPrevented || e.button !== 0) return;
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = e.target.closest('a[href]');
  if (!a || a.hasAttribute('download') || a.getAttribute('target') === '_blank') return;
  const href = a.getAttribute('href');
  if (!href || /^(mailto:|tel:|https?:)/i.test(href)) return;
  let url;
  try { url = new URL(a.href, location.origin); } catch { return; }
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  if (/\.[a-z0-9]+$/i.test(url.pathname)) return;
  e.preventDefault();
  navigate(url.pathname);
}

window.addEventListener('popstate', () => applyRoute(Router.parse(location.pathname)));
document.addEventListener('click', onAppLinkClick);

const alerted = new Set();
let live = null;
let homeBusy = false;

function setHomeBusy(on, label) {
  homeBusy = !!on;
  const card = $('#homeCard');
  if (!card) return;
  let veil = $('#homeBusy');
  if (!on) {
    if (veil) veil.remove();
    return;
  }
  if (!veil) {
    veil = document.createElement('div');
    veil.id = 'homeBusy';
    veil.className = 'home-busy';
    card.appendChild(veil);
  }
  veil.innerHTML = '<div class="spin"></div><span>' + esc(label || 'Please wait…') + '</span>';
}

function homeKey() {
  if (!session) return '';
  const e = empById(session.id);
  if (!e) return '';
  return e.status + ':' + (e.break && e.break.id ? e.break.id : '') +
    ':' + (e.break && e.break.isRoomLeaved ? '1' : '0');
}

function applyState(s) {
  if (!s || !s.employees) return;
  offset = (s.serverTime || Date.now()) - Date.now();
  ST = s;
  failures = 0;
  if (!online) { online = true; paintConn(); }
  $('#siteName').textContent = s.config.siteName || 'Break Monitor';
  setDocTitle();
  if ($('#serverFoot')) {
    const src = s.config.staffSource === 'supabase' ? ' · data from Supabase' :
      s.config.staffSource === 'unconfigured' ? ' · Supabase not configured' : '';
    $('#serverFoot').textContent = 'Break Monitor · ' + location.host + src;
  }

  const liveIds = new Set(ST.employees.filter(e => e.break).map(e => e.break.id));
  [...alerted].forEach(id => { if (!liveIds.has(id)) alerted.delete(id); });

  if (currentRoute && currentRoute.name === 'employee' && !$('#k-lock').classList.contains('hidden')) {
    applyRoute(currentRoute);
  } else if (!$('#k-lock').classList.contains('hidden')) renderPeople();
  if (session && !$('#k-home').classList.contains('hidden') && !homeBusy) {
    const key = homeKey();
    if (key !== lastHomeKey) { lastHomeKey = key; renderHome(); }
    else paintRing();
  }
  if (mgrToken && !$('#view-mgr').classList.contains('hidden')) renderManager();
  if (mgrToken && !$('[data-pane-body="late"]').classList.contains('hidden')) loadLate({ silent: true });
}

async function refresh() {
  try {
    const res = await fetch(BASE + '/api/state', { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    applyState(await res.json());
  } catch (err) {
    failures++;
    if (failures >= 2 && online) { online = false; paintConn(); }
    if (failures >= 2 && !online) paintConn(err.message);
  }
}

function connectLive() {
  if (live) { live.close(); live = null; }
  live = new EventSource(BASE + '/api/events');
  live.onmessage = ev => {
    try { applyState(JSON.parse(ev.data)); } catch {}
  };
  live.onopen = () => {
    failures = 0;
    if (!online) { online = true; paintConn(); }
  };
}

function paintConn(detail) {
  const c = $('#conn');
  c.classList.toggle('down', !online);
  $('#connTxt').textContent = online ? 'Connected' : 'Offline';
  $('#veil').classList.toggle('hidden', online);
  if (!online && detail) $('#veilTxt').textContent = 'Trying to reconnect… (' + detail + ')';
}

function tick() {
  const d = new Date(now());
  $('#wallclock').textContent = p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());

  ST.employees.forEach(e => {
    if (e.status === 'break' && remaining(e) <= 0 && !alerted.has(e.break.id)) {
      alerted.add(e.break.id);
      toast('', e.name.split(' ')[0] + ' is overdue',
        'The ' + e.break.allowanceMin + '-minute break ended at ' + fmtClock(e.break.dueAt) + '.');
    }
  });

  if (session && !$('#k-home').classList.contains('hidden')) paintRing();
  if (!$('#k-lock').classList.contains('hidden')) paintPeopleStatus();
  if (mgrToken && !$('#view-mgr').classList.contains('hidden') && !$('[data-pane-body="live"]').classList.contains('hidden')) renderManager();
  if (mgrToken && !$('[data-pane-body="late"]').classList.contains('hidden')) paintLateTable();
}

/* ---------------- boot ---------------- */
(async function start() {
  await refresh();
  // don't toast for breaks that were already overdue when this screen opened
  ST.employees.forEach(e => { if (e.status === 'break' && remaining(e) <= 0) alerted.add(e.break.id); });
  await restoreEmployeeSession();
  await restoreDirectorSession();
  if (session && ST.employees.length && !empById(session.id)) clearSession();
  let path = location.pathname || '/staff';
  const opened = Router.parse(path);
  if (session && (opened.name === 'staff-home' || path === '/' || path === '')) {
    path = '/staff/' + session.id;
  }
  navigate(path, { replace: true });
  $('#serverFoot').textContent = 'Break Monitor · ' + location.host +
    (ST.config && ST.config.staffSource === 'supabase' ? ' · data from Supabase' : '');
  tick();
  setInterval(tick, 1000);
  connectLive();
})();
})();
