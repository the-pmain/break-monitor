'use strict';
const { normalizeSupabaseUrl } = require('./env');

function formatTime(t) {
  if (t == null || t === '') return '';
  const s = String(t);
  return s.length >= 5 ? s.slice(0, 5) : s;
}

function toPgTime(t) {
  if (t == null || t === '') return null;
  const s = String(t).trim();
  if (!s) return null;
  if (/^\d{1,2}:\d{2}$/.test(s)) return s.padStart(5, '0') + ':00';
  if (/^\d{1,2}:\d{2}:\d{2}/.test(s)) return s;
  return s;
}

function pinsMatch(entered, stored) {
  const a = String(entered ?? '').replace(/\D/g, '');
  const b = String(stored ?? '').replace(/\D/g, '');
  if (!a || !b) return false;
  return a === b || Number(a) === Number(b);
}

function toMs(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  const n = Date.parse(v);
  return Number.isNaN(n) ? null : n;
}

function toIso(ms) {
  if (ms == null) return null;
  return new Date(ms).toISOString();
}

function firstRow(json) {
  if (!json) return null;
  if (Array.isArray(json)) return json[0] || null;
  return json;
}

function rowsToIds(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map(r => Number(r && r.id))
    .filter(n => Number.isFinite(n));
}

function rpcMissing(err) {
  if (!err) return false;
  const code = String(err.code || '');
  const msg = String(err.message || '');
  return err.status === 404 || code === 'PGRST202' || /could not find the function/i.test(msg);
}

function isActiveFlag(v) {
  if (v == null) return true;
  if (v === false || v === 0 || v === '0' || v === 'f' || v === 'false') return false;
  return true;
}

function isTrueFlag(v) {
  return v === true || v === 1 || v === '1' || v === 't' || v === 'true';
}

function toEmployee(row) {
  if (!row) return null;
  const category = row.category || '';
  return {
    id: Number(row.id),
    name: row.name || 'Unnamed',
    category,
    dept: category,
    shift_start: formatTime(row.schedule_start),
    shift_end: formatTime(row.schedule_end),
    active: isActiveFlag(row.active),
    created_at: row.created_at ? Date.parse(row.created_at) : Date.now()
  };
}

function toBreak(row) {
  if (!row || row.coworker_id == null) return null;
  const allowance = row.allowance_min == null ? 0 : Number(row.allowance_min);
  return {
    id: Number(row.id),
    employee_id: Number(row.coworker_id),
    allowance_min: allowance,
    started_at: toMs(row.started_at),
    ended_at: toMs(row.ended_at),
    ended_by: row.ended_by || null,
    is_room_leaved: isTrueFlag(row.is_room_leaved),
    is_floor_leaved: isTrueFlag(row.is_floor_leaved)
  };
}

function createSupabase({ url, key }) {
  const base = normalizeSupabaseUrl(url);
  const headers = {
    apikey: key,
    Authorization: 'Bearer ' + key,
    'Content-Type': 'application/json',
    Prefer: 'return=representation'
  };

  async function rest(method, path, body, extraHeaders) {
    const hdrs = Object.assign({}, headers, extraHeaders || {});
    if (body === undefined) delete hdrs['Content-Type'];
    const res = await fetch(base + path, {
      method,
      headers: hdrs,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await res.text();
    let json = null;
    if (text) {
      try { json = JSON.parse(text); } catch { json = { message: text }; }
    }
    if (!res.ok) {
      const msg = [
        json && (json.message || json.error_description || json.error),
        json && json.details,
        json && json.hint
      ].filter(Boolean).join(' — ') || ('Supabase HTTP ' + res.status);
      const err = new Error(msg);
      err.code = json && json.code;
      err.status = res.status;
      err.details = json && json.details;
      throw err;
    }
    return json;
  }

  async function pingTable(table) {
    try {
      await rest('GET', '/rest/v1/' + table + '?select=id&limit=1');
    } catch (err) {
      throw new Error('Supabase table "' + table + '" is missing or blocked: ' + err.message);
    }
  }

  return {
    url: base,
    async ping() {
      await pingTable('coworkers');
      await pingTable('breaks');
      return true;
    },

    async listCoworkers() {
      const rows = await rest('GET', '/rest/v1/coworkers?select=*&order=name.asc');
      return Array.isArray(rows) ? rows : [];
    },
    async getCoworker(id) {
      const rows = await rest('GET', '/rest/v1/coworkers?id=eq.' + encodeURIComponent(id) + '&select=*&limit=1');
      return Array.isArray(rows) && rows[0] ? rows[0] : null;
    },
    async addCoworker({ name, pin, dept = '', category = '', shiftStart = '', shiftEnd = '' }) {
      const rows = await rest('POST', '/rest/v1/coworkers', {
        name,
        category: category || dept || null,
        schedule_start: toPgTime(shiftStart),
        schedule_end: toPgTime(shiftEnd),
        pin: pin === '' || pin == null ? null : Number(pin)
      });
      const row = firstRow(rows);
      return row ? Number(row.id) : null;
    },
    async updateCoworker(id, patch) {
      const body = {};
      if (patch.name != null) body.name = patch.name;
      if (patch.dept != null) body.category = patch.dept || null;
      if (patch.category != null) body.category = patch.category || null;
      if (patch.shiftStart != null) body.schedule_start = toPgTime(patch.shiftStart);
      if (patch.shiftEnd != null) body.schedule_end = toPgTime(patch.shiftEnd);
      if (patch.pin) body.pin = Number(patch.pin);
      if (!Object.keys(body).length) return true;
      await rest('PATCH', '/rest/v1/coworkers?id=eq.' + encodeURIComponent(id), body);
      return true;
    },
    async setActive(id, active) {
      await rest('PATCH', '/rest/v1/coworkers?id=eq.' + encodeURIComponent(id), {
        active: !!active
      });
      return true;
    },
    async deleteBreaksForCoworker(coworkerId) {
      const id = Number(coworkerId);
      const listed = await rest(
        'GET',
        '/rest/v1/breaks?coworker_id=eq.' + encodeURIComponent(id) + '&select=id'
      );
      const ids = (Array.isArray(listed) ? rowsToIds(listed) : []);
      async function del(filter) {
        const rows = await rest(
          'DELETE',
          '/rest/v1/breaks?' + filter,
          undefined,
          { Prefer: 'return=representation' }
        );
        return Array.isArray(rows) ? rows.length : 0;
      }
      let removed = await del('coworker_id=eq.' + encodeURIComponent(id));
      const leftover = await rest(
        'GET',
        '/rest/v1/breaks?coworker_id=eq.' + encodeURIComponent(id) + '&select=id'
      );
      const leftIds = Array.isArray(leftover) ? rowsToIds(leftover) : [];
      if (leftIds.length) {
        removed += await del('id=in.(' + leftIds.join(',') + ')');
      }
      const still = await rest(
        'GET',
        '/rest/v1/breaks?coworker_id=eq.' + encodeURIComponent(id) + '&select=id'
      );
      const remain = Array.isArray(still) ? still.length : 0;
      if (remain > 0) {
        const err = new Error(
          'Supabase would not delete this person\'s break records (' + remain +
          ' still exist). Row-level security is blocking DELETE on public.breaks. Run supabase/schema.sql in the SQL editor.'
        );
        err.code = 'BREAKS_NOT_DELETED';
        throw err;
      }
      return Math.max(removed, ids.length);
    },
    async countBreaksForCoworker(coworkerId) {
      const rows = await rest(
        'GET',
        '/rest/v1/breaks?coworker_id=eq.' + encodeURIComponent(coworkerId) + '&select=id'
      );
      return Array.isArray(rows) ? rows.length : 0;
    },
    async removeCoworkerCascade(coworkerId) {
      const json = await rest('POST', '/rest/v1/rpc/remove_coworker_cascade', {
        target_id: Number(coworkerId)
      });
      if (json && typeof json === 'object' && !Array.isArray(json) && json.breaksRemoved != null)
        return { ok: true, breaksRemoved: Number(json.breaksRemoved) || 0 };
      return { ok: true, breaksRemoved: Number(json) || 0 };
    },
    rpcMissing,
    async removeCoworker(id) {
      await rest('DELETE', '/rest/v1/coworkers?id=eq.' + encodeURIComponent(id));
      return true;
    },

    async listOpenBreaks() {
      const rows = await rest('GET', '/rest/v1/breaks?ended_at=is.null&select=*&order=started_at.desc');
      return (Array.isArray(rows) ? rows : []).map(toBreak).filter(Boolean);
    },
    async openBreak(coworkerId) {
      const rows = await rest(
        'GET',
        '/rest/v1/breaks?coworker_id=eq.' + encodeURIComponent(coworkerId) +
          '&ended_at=is.null&select=*&order=started_at.desc&limit=1'
      );
      return toBreak(firstRow(rows));
    },
    async getBreak(id) {
      const rows = await rest('GET', '/rest/v1/breaks?id=eq.' + encodeURIComponent(id) + '&select=*&limit=1');
      return toBreak(firstRow(rows));
    },
    async insertBreak({ coworkerId, allowanceMin, startedAt, endedAt, endedBy, isRoomLeaved, isFloorLeaved }) {
      const body = {
        coworker_id: Number(coworkerId),
        allowance_min: Number(allowanceMin),
        started_at: toIso(startedAt == null ? Date.now() : startedAt),
        is_room_leaved: isRoomLeaved == null ? true : !!isRoomLeaved,
        is_floor_leaved: !!isFloorLeaved
      };
      if (endedAt != null) body.ended_at = toIso(endedAt);
      if (endedBy != null) body.ended_by = endedBy;
      const rows = await rest('POST', '/rest/v1/breaks', body);
      return toBreak(firstRow(rows));
    },
    async setBreakFlags(breakId, { isRoomLeaved, isFloorLeaved }) {
      await rest('PATCH', '/rest/v1/breaks?id=eq.' + encodeURIComponent(breakId), {
        is_room_leaved: !!isRoomLeaved,
        is_floor_leaved: !!isFloorLeaved
      });
      return true;
    },
    async endBreak(breakId, endedAt, endedBy) {
      const body = { ended_at: toIso(endedAt == null ? Date.now() : endedAt) };
      if (endedBy != null) body.ended_by = endedBy;
      await rest('PATCH', '/rest/v1/breaks?id=eq.' + encodeURIComponent(breakId), body);
      return true;
    },
    async historySince(ms) {
      const iso = toIso(ms);
      const rows = await rest(
        'GET',
        '/rest/v1/breaks?ended_at=not.is.null&ended_at=gte.' + encodeURIComponent(iso) +
          '&select=*&order=started_at.desc&limit=5000'
      );
      return (Array.isArray(rows) ? rows : []).map(toBreak).filter(Boolean);
    },
    async listBreaksFrom(ms) {
      const iso = toIso(ms);
      const rows = await rest(
        'GET',
        '/rest/v1/breaks?started_at=gte.' + encodeURIComponent(iso) +
          '&select=*&order=started_at.desc&limit=5000'
      );
      return (Array.isArray(rows) ? rows : []).map(toBreak).filter(Boolean);
    },
    async deleteAllBreaks() {
      await rest('DELETE', '/rest/v1/breaks?id=gte.0', undefined, { Prefer: 'return=minimal' });
      return true;
    }
  };
}

module.exports = {
  createSupabase, toEmployee, toBreak, pinsMatch, formatTime, toPgTime, toMs, toIso
};
