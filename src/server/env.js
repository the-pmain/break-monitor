'use strict';
const fs = require('fs');
const path = require('path');

function parseEnv(text) {
  const out = {};
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
      val = val.slice(1, -1);
    out[key] = val;
  }
  return out;
}

function cleanEnv(v) {
  return String(v == null ? '' : v).trim().replace(/^['"]|['"]$/g, '').trim();
}

function firstNonEmpty(...vals) {
  for (const v of vals) {
    const s = cleanEnv(v);
    if (s) return s;
  }
  return '';
}

function normalizeSupabaseUrl(url) {
  const raw = cleanEnv(url);
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLowerCase();
    if (host.endsWith('.supabase.co') && !host.startsWith('db.'))
      return 'https://' + parsed.hostname;
  } catch { /* fall through */ }
  return raw.replace(/\/+$/, '').replace(/\/rest\/v1$/i, '').replace(/\/+$/, '');
}

function isUsableUrl(url) {
  const u = normalizeSupabaseUrl(url);
  if (!u || /YOUR_PROJECT/i.test(u)) return false;
  try {
    const parsed = new URL(u);
    const host = parsed.hostname.toLowerCase();
    return parsed.protocol === 'https:'
      && host.endsWith('.supabase.co')
      && !host.startsWith('db.')
      && (parsed.pathname === '/' || parsed.pathname === '');
  } catch { return false; }
}

function credsFrom(obj) {
  if (!obj) return null;
  const url = normalizeSupabaseUrl(firstNonEmpty(obj.SUPABASE_URL, obj.BREAK_MONITOR_SUPABASE_URL));
  const key = firstNonEmpty(obj.SUPABASE_SERVICE_ROLE_KEY, obj.SUPABASE_ANON_KEY, obj.BREAK_MONITOR_SUPABASE_KEY);
  return isUsableUrl(url) && key ? { url, key } : null;
}

function diagnoseSupabase(env = process.env) {
  const urlRaw = firstNonEmpty(env.BREAK_MONITOR_SUPABASE_URL, env.SUPABASE_URL);
  const key = firstNonEmpty(env.BREAK_MONITOR_SUPABASE_KEY, env.SUPABASE_SERVICE_ROLE_KEY, env.SUPABASE_ANON_KEY);
  if (!urlRaw && !key)
    return 'Supabase is not configured. Set SUPABASE_URL and SUPABASE_ANON_KEY on the host.';
  if (!urlRaw)
    return 'SUPABASE_URL is missing. Copy Project URL from Supabase → Settings → API (https://xxxx.supabase.co).';
  if (/^postgres(ql)?:/i.test(urlRaw) || /db\.[^.]+\.supabase\.co/i.test(urlRaw))
    return 'SUPABASE_URL looks like a database URI. Use the Project URL from Settings → API, not the database connection string.';
  if (!isUsableUrl(urlRaw))
    return 'SUPABASE_URL must be https://YOURPROJECT.supabase.co (no quotes, not the dashboard URL).';
  if (!key)
    return 'Supabase key is missing. Set SUPABASE_ANON_KEY or SUPABASE_SERVICE_ROLE_KEY from Settings → API.';
  return null;
}

function loadEnv(extraDirs = []) {
  const roots = [
    path.join(__dirname, '..', '..'),
    process.cwd(),
    ...extraDirs
  ];
  const seen = new Set();
  let fromFiles = null;
  for (const dir of roots) {
    const file = path.join(dir, '.env');
    if (seen.has(file)) continue;
    seen.add(file);
    try {
      const parsed = parseEnv(fs.readFileSync(file, 'utf8'));
      if (!fromFiles) fromFiles = credsFrom(parsed);
      for (const [k, v] of Object.entries(parsed)) {
        if (process.env[k] == null || process.env[k] === '') process.env[k] = v;
      }
    } catch { /* missing file is fine */ }
  }
  return fromFiles;
}

function supabaseFromEnv() {
  const url = normalizeSupabaseUrl(firstNonEmpty(process.env.BREAK_MONITOR_SUPABASE_URL, process.env.SUPABASE_URL));
  const key = firstNonEmpty(
    process.env.BREAK_MONITOR_SUPABASE_KEY,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    process.env.SUPABASE_ANON_KEY
  );
  return isUsableUrl(url) && key ? { url, key } : null;
}

module.exports = { loadEnv, supabaseFromEnv, diagnoseSupabase, isUsableUrl, normalizeSupabaseUrl };