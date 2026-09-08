'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MGR_TTL_MS = 365 * 24 * 3600 * 1000;

function createAuth(db, { bad, sessionsPath } = {}) {
  const attempts = new Map();
  const tokens = new Map();

  function loadTokens() {
    if (!sessionsPath) return;
    try {
      const raw = JSON.parse(fs.readFileSync(sessionsPath, 'utf8'));
      const now = Date.now();
      Object.entries(raw || {}).forEach(([t, exp]) => {
        if (Number(exp) > now) tokens.set(t, Number(exp));
      });
    } catch {}
  }

  function saveTokens() {
    if (!sessionsPath) return;
    try {
      const obj = {};
      const now = Date.now();
      for (const [t, exp] of tokens) {
        if (exp > now) obj[t] = exp;
      }
      fs.mkdirSync(path.dirname(sessionsPath), { recursive: true });
      fs.writeFileSync(sessionsPath, JSON.stringify(obj));
    } catch {}
  }

  loadTokens();

  function guard(key) {
    const rec = attempts.get(key);
    if (rec && rec.until > Date.now()) return { locked: true, seconds: Math.ceil((rec.until - Date.now()) / 1000) };
    return { locked: false };
  }
  function fail(key) {
    const rec = attempts.get(key) || { n: 0, until: 0 };
    rec.n += 1;
    if (rec.n >= 5) { rec.until = Date.now() + 30000; rec.n = 0; }
    attempts.set(key, rec);
  }
  function clear(key) { attempts.delete(key); }

  const newToken = () => crypto.randomBytes(24).toString('hex');
  function issueToken() {
    const t = newToken();
    tokens.set(t, Date.now() + MGR_TTL_MS);
    saveTokens();
    return t;
  }
  function validToken(t) {
    const exp = tokens.get(t);
    if (!exp) return false;
    if (exp < Date.now()) { tokens.delete(t); saveTokens(); return false; }
    tokens.set(t, Date.now() + MGR_TTL_MS);
    saveTokens();
    return true;
  }

  async function withPin(req, res, next) {
    const { employeeId, pin } = req.body || {};
    const key = 'emp:' + employeeId;
    const g = guard(key);
    if (g.locked) return bad(res, 429, `Too many attempts. Try again in ${g.seconds}s.`);
    const emp = await db.authEmployee(Number(employeeId), String(pin || ''));
    if (!emp) { fail(key); return bad(res, 401, 'Incorrect PIN'); }
    clear(key);
    req.employee = emp;
    await next();
  }

  function manager(req, res, next) {
    const t = req.headers['x-manager-token'];
    if (!t || !validToken(t)) return bad(res, 401, 'Director session expired');
    next();
  }

  return { guard, fail, clear, newToken, issueToken, tokens, validToken, withPin, manager };
}

module.exports = { createAuth };
