'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createSupabase, toEmployee, pinsMatch } = require('./supabase');
const { isUsableUrl, normalizeSupabaseUrl, diagnoseSupabase } = require('./env');

function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pin), salt, 32).toString('hex');
  return salt + ':' + hash;
}
function verifyPin(pin, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(String(pin), salt, 32);
  const known = Buffer.from(hash, 'hex');
  return known.length === test.length && crypto.timingSafeEqual(known, test);
}

const DEFAULT_CONFIG = {
  siteName: 'Break Monitor',
  allowances: [30, 15, 10, 5],
  allowanceLabels: { 30: 'Lunch break', 15: 'Long break', 10: 'Tea break', 5: 'Quick break' },
  graceSeconds: 60
};

function startOfDay(ts) { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); }

function mapBreakRow(b, byId, nowMs) {
  const e = byId.get(b.employee_id) || {};
  const category = e.category || e.dept || '';
  const started = b.started_at || 0;
  const ended = b.ended_at;
  const live = ended == null;
  const taken = live ? Math.max(0, nowMs - started) : (ended && started ? ended - started : 0);
  return {
    id: b.id, employeeId: b.employee_id, name: e.name || 'Unknown',
    dept: category, category,
    allowanceMin: b.allowance_min, startedAt: b.started_at, endedAt: b.ended_at,
    taken, over: taken - (Number(b.allowance_min) || 0) * 60000,
    endedBy: b.ended_by,
    isRoomLeaved: !!b.is_room_leaved,
    isFloorLeaved: !!b.is_floor_leaved,
    live
  };
}

function parseHm(s) {
  const m = String(s || '').match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function rosterAt(shiftStart, shiftEnd, nowMs) {
  const startMin = parseHm(shiftStart);
  const endMin = parseHm(shiftEnd);
  if (startMin == null || endMin == null) {
    return { onRoster: true, startAt: null, endAt: null, elapsedMs: null, remainingMs: null };
  }
  const now = new Date(nowMs);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const overnight = startMin > endMin;
  let onRoster;
  if (startMin === endMin) onRoster = true;
  else if (!overnight) onRoster = nowMin >= startMin && nowMin < endMin;
  else onRoster = nowMin >= startMin || nowMin < endMin;

  function atMinutes(dayOffset, mins) {
    const x = new Date(now);
    x.setDate(x.getDate() + dayOffset);
    x.setHours(Math.floor(mins / 60), mins % 60, 0, 0);
    return x.getTime();
  }

  let startAt, endAt;
  if (!overnight) {
    startAt = atMinutes(0, startMin);
    endAt = atMinutes(0, endMin);
  } else if (nowMin >= startMin) {
    startAt = atMinutes(0, startMin);
    endAt = atMinutes(1, endMin);
  } else {
    startAt = atMinutes(-1, startMin);
    endAt = atMinutes(0, endMin);
  }

  return {
    onRoster,
    startAt,
    endAt,
    elapsedMs: nowMs - startAt,
    remainingMs: endAt - nowMs
  };
}

function open(_unused, opts = {}) {
  return makeApi(opts);
}

function makeApi(opts = {}) {
  let sb = null;
  let coworkerCache = { at: 0, rows: [] };
  let activityCache = { at: 0, day: 0, breaks: [], history: [] };

  function bustActivity() {
    activityCache = { at: 0, day: 0, breaks: [], history: [] };
  }

  async function loadActivity(force) {
    const now = Date.now();
    const day = startOfDay(now);
    if (!force && activityCache.at && activityCache.day === day && now - activityCache.at < 8000)
      return activityCache;
    const [breaks, history] = await Promise.all([
      sb.listOpenBreaks(),
      sb.historySince(day)
    ]);
    activityCache = { at: now, day, breaks, history };
    return activityCache;
  }
  const settingsPath = opts.settingsPath || null;
  const local = {
    siteName: DEFAULT_CONFIG.siteName,
    allowances: DEFAULT_CONFIG.allowances.slice(),
    allowanceLabels: { ...DEFAULT_CONFIG.allowanceLabels },
    graceSeconds: DEFAULT_CONFIG.graceSeconds,
    managerPinHash: hashPin(opts.managerPin || process.env.MANAGER_PIN || '9119')
  };

  if (settingsPath) {
    try {
      const saved = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      if (saved.siteName) local.siteName = String(saved.siteName);
      if (Array.isArray(saved.allowances) && saved.allowances.length) local.allowances = saved.allowances.map(Number);
      if (saved.allowanceLabels && typeof saved.allowanceLabels === 'object') local.allowanceLabels = saved.allowanceLabels;
      if (saved.graceSeconds != null) local.graceSeconds = Number(saved.graceSeconds);
      if (saved.managerPinHash) local.managerPinHash = saved.managerPinHash;
    } catch { /* first run */ }
  }

  function saveLocal() {
    if (!settingsPath) return;
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({
      siteName: local.siteName,
      allowances: local.allowances,
      allowanceLabels: local.allowanceLabels,
      graceSeconds: local.graceSeconds,
      managerPinHash: local.managerPinHash
    }, null, 2));
  }

  function connectSupabase(url, key) {
    const u = normalizeSupabaseUrl(url || '');
    const k = String(key || '');
    if (u && k && isUsableUrl(u)) sb = createSupabase({ url: u, key: k });
    else sb = null;
    coworkerCache = { at: 0, rows: [] };
    bustActivity();
  }

  if (opts.supabaseUrl && opts.supabaseKey) connectSupabase(opts.supabaseUrl, opts.supabaseKey);

  function requireSb() {
    if (!sb) throw new Error('Supabase is not configured. Add SUPABASE_URL and a key to .env.');
  }

  async function loadCoworkers(force) {
    if (!sb) return [];
    if (!force && coworkerCache.at && Date.now() - coworkerCache.at < 12000)
      return coworkerCache.rows;
    try {
      const rows = (await sb.listCoworkers()).map(toEmployee);
      coworkerCache = { at: Date.now(), rows };
      return rows;
    } catch (err) {
      if (coworkerCache.at) return coworkerCache.rows;
      throw err;
    }
  }

  const api = {
    close() {},
    async setSetting(k, v) {
      if (k === 'site_name') local.siteName = String(v);
      else if (k === 'allowances') local.allowances = JSON.parse(String(v));
      else if (k === 'allowance_labels') local.allowanceLabels = JSON.parse(String(v));
      else if (k === 'grace_seconds') local.graceSeconds = Number(v);
      else if (k === 'manager_pin') local.managerPinHash = String(v);
      saveLocal();
    },

    async config() {
      return {
        siteName: local.siteName,
        allowances: local.allowances,
        allowanceLabels: local.allowanceLabels,
        graceSeconds: local.graceSeconds,
        staffSource: sb ? 'supabase' : 'unconfigured'
      };
    },

    hasSupabase: () => !!sb,
    supabaseUrl: () => (sb ? sb.url : ''),
    hasSupabaseKey: () => !!sb,
    async pingSupabase() { requireSb(); return sb.ping(); },
    useSupabase(url, key) { connectSupabase(url, key); },

    async listEmployees() {
      if (!sb) return [];
      return loadCoworkers();
    },
    async listAllEmployees() {
      return api.listEmployees();
    },
    async getEmployee(id) {
      if (!sb) return null;
      const hit = (await loadCoworkers())?.find(e => e.id === Number(id));
      if (hit) return hit;
      return toEmployee(await sb.getCoworker(id));
    },

    async authEmployee(id, pin) {
      if (!sb) return null;
      const row = await sb.getCoworker(id);
      if (!row || !pinsMatch(pin, row.pin)) return null;
      return toEmployee(row);
    },
    async authManager(pin) {
      return verifyPin(pin, local.managerPinHash);
    },

    async addEmployee({ name, pin, dept = '', category = '', shiftStart = '', shiftEnd = '' }) {
      requireSb();
      const id = await sb.addCoworker({ name, pin, category: category || dept, shiftStart, shiftEnd });
      coworkerCache = { at: 0, rows: [] };
      return id;
    },
    async updateEmployee(id, patch) {
      requireSb();
      const cur = await sb.getCoworker(id);
      if (!cur) return false;
      if (patch.category != null && patch.dept == null) patch.dept = patch.category;
      await sb.updateCoworker(id, patch);
      coworkerCache = { at: 0, rows: [] };
      return true;
    },
    async removeEmployee(id) {
      requireSb();
      const ob = await sb.openBreak(id);
      if (ob) await sb.endBreak(ob.id, Date.now(), 'manager');
      try {
        await sb.removeCoworker(id);
      } catch (err) {
        if (err.code === '23503')
          throw new Error('This person has break records, so they cannot be removed from coworkers.');
        throw err;
      }
      coworkerCache = { at: 0, rows: [] };
      bustActivity();
      return true;
    },

    async startBreak(id, allowanceMin, flags = {}) {
      requireSb();
      const emp = await api.getEmployee(id);
      if (emp && !emp.active)
        return { ok: false, error: 'You have already left for the day' };
      if (await sb.openBreak(id)) return { ok: false, error: 'Already on a break' };
      const allowed = (await api.config()).allowances;
      if (!allowed.includes(Number(allowanceMin))) return { ok: false, error: 'Unknown break length' };
      const row = await sb.insertBreak({
        coworkerId: id,
        allowanceMin: Number(allowanceMin),
        startedAt: Date.now(),
        isRoomLeaved: flags.isRoomLeaved == null ? true : !!flags.isRoomLeaved,
        isFloorLeaved: false
      });
      bustActivity();
      return { ok: true, breakId: row && row.id };
    },
    async endBreak(id, endedBy = 'employee') {
      requireSb();
      const ob = await sb.openBreak(id);
      if (!ob) return { ok: false, error: 'Not on a break' };
      const now = Date.now();
      await sb.endBreak(ob.id, now, endedBy);
      bustActivity();
      return { ok: true, taken: now - (ob.started_at || now), allowanceMin: ob.allowance_min };
    },
    async endBreakById(breakId, endedBy = 'manager') {
      requireSb();
      const b = await sb.getBreak(breakId);
      if (!b || b.ended_at) return { ok: false, error: 'Break not found or already ended' };
      await sb.endBreak(breakId, Date.now(), endedBy);
      bustActivity();
      return { ok: true };
    },
    async setBreakFlags(id, flags = {}) {
      requireSb();
      return { ok: false, error: 'Room cannot be changed after the break has started' };
    },

    async leaveShift(id) {
      requireSb();
      const ob = await sb.openBreak(id);
      if (ob) await sb.endBreak(ob.id, Date.now(), 'clock-out');
      await sb.setActive(id, false);
      coworkerCache = { at: 0, rows: [] };
      bustActivity();
      return { ok: true };
    },
    async returnToShift(id) {
      requireSb();
      await sb.setActive(id, true);
      coworkerCache = { at: 0, rows: [] };
      return { ok: true };
    },

    async state() {
      const now = Date.now();
      const cfg = await api.config();
      let staff = [];
      let breaks = [];
      let historyRows = [];
      const errors = [];
      if (!sb) {
        cfg.staffError = diagnoseSupabase() || 'Supabase is not configured';
      } else {
        try { staff = await api.listEmployees(); }
        catch (err) { errors.push(err.message); }
        try {
          const act = await loadActivity();
          breaks = act.breaks;
          historyRows = act.history;
        } catch (err) { errors.push(err.message); }
        cfg.staffError = errors.length ? errors.join(' · ') : null;
      }

      const breakMap = new Map(breaks.map(b => [b.employee_id, b]));

      const employees = staff.map(e => {
        const br = breakMap.get(e.id);
        const roster = rosterAt(e.shift_start, e.shift_end, now);
        const leftEarly = !e.active;
        const status = br ? 'break' : leftEarly ? 'left' : roster.onRoster ? 'working' : 'off';
        const category = e.category || e.dept || '';
        const started = br && br.started_at;
        const allowance = br ? br.allowance_min : 0;
        return {
          id: e.id, name: e.name, dept: category, category,
          shiftStart: e.shift_start, shiftEnd: e.shift_end,
          onRoster: roster.onRoster && !leftEarly,
          shiftStartedAt: roster.startAt,
          shiftElapsedMs: roster.elapsedMs,
          shiftRemainingMs: roster.remainingMs,
          active: e.active,
          status,
          break: br ? {
            id: br.id,
            allowanceMin: allowance,
            startedAt: started,
            dueAt: started != null ? started + allowance * 60000 : null,
            isRoomLeaved: !!br.is_room_leaved,
            isFloorLeaved: !!br.is_floor_leaved
          } : null
        };
      });

      const names = new Map(employees.map(e => [e.id, e.name]));
      const history = historyRows.map(b => {
        const started = b.started_at || 0;
        const ended = b.ended_at || 0;
        const taken = ended && started ? ended - started : 0;
        return {
          id: b.id, employeeId: b.employee_id,
          name: names.get(b.employee_id) || 'Unknown',
          allowanceMin: b.allowance_min,
          startedAt: b.started_at, endedAt: b.ended_at,
          taken,
          over: taken - b.allowance_min * 60000,
          endedBy: b.ended_by,
          isRoomLeaved: !!b.is_room_leaved,
          isFloorLeaved: !!b.is_floor_leaved
        };
      });

      return { serverTime: now, config: cfg, employees, history };
    },

    async historySince(ms) {
      requireSb();
      let staff = [];
      try { staff = await api.listEmployees(); } catch {}
      const byId = new Map(staff.map(e => [e.id, e]));
      return (await sb.historySince(ms)).map(b => mapBreakRow(b, byId, Date.now()));
    },

    async lateBreaks(fromMs, toMs) {
      requireSb();
      const now = Date.now();
      let staff = [];
      try { staff = await api.listEmployees(); } catch {}
      const byId = new Map(staff.map(e => [e.id, e]));
      const seen = new Set();
      const rows = [];

      function consider(b) {
        if (!b || seen.has(b.id)) return;
        const started = b.started_at || 0;
        const ended = b.ended_at;
        const live = ended == null;
        const taken = live ? Math.max(0, now - started) : Math.max(0, (ended || 0) - started);
        const over = taken - (Number(b.allowance_min) || 0) * 60000;
        if (over <= 0) return;
        const endPoint = live ? now : ended;
        if (endPoint < fromMs || started >= toMs) return;
        seen.add(b.id);
        rows.push(mapBreakRow(b, byId, now));
      }

      (await sb.listBreaksFrom(fromMs)).forEach(consider);
      (await sb.historySince(fromMs)).forEach(consider);
      (await sb.listOpenBreaks()).forEach(consider);
      rows.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
      return rows;
    },

    async seedDemoActivity() {
      requireSb();
      const emps = await api.listEmployees();
      if (emps.length < 4) return { ok: false, error: 'Add some staff first' };
      const now = Date.now(), M = 60000;
      await api.resetActivity();
      const past = [[0, 15, 148, 14.2], [1, 10, 132, 11.8], [2, 5, 120, 4.6], [3, 30, 96, 33.4],
                    [2, 5, 74, 5.1], [1, 15, 58, 15.9], [3, 5, 40, 4.4], [0, 10, 26, 9.7]];
      for (const [idx, mins, agoMin, takenMin] of past) {
        const e = emps[idx % emps.length];
        const start = now - agoMin * M;
        if (start < startOfDay(now)) continue;
        await sb.insertBreak({
          coworkerId: e.id, allowanceMin: mins, startedAt: start,
          endedAt: start + takenMin * M, endedBy: 'employee',
          isRoomLeaved: idx % 2 === 0, isFloorLeaved: false
        });
      }
      const live = [[0, 15, 9], [1, 10, 12.5], [4 % emps.length, 5, 1.2]];
      for (const [idx, mins, agoMin] of live) {
        const e = emps[idx];
        if (!(await sb.openBreak(e.id))) {
          await sb.insertBreak({
            coworkerId: e.id, allowanceMin: mins, startedAt: now - agoMin * M,
            isRoomLeaved: true, isFloorLeaved: false
          });
        }
      }
      bustActivity();
      return { ok: true };
    },

    async resetActivity() {
      requireSb();
      await sb.deleteAllBreaks();
      bustActivity();
      return { ok: true };
    }
  };

  return api;
}

module.exports = { open, hashPin, verifyPin, driverName: () => 'supabase' };
