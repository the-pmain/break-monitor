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

function normalizeSupabaseUrl(url) {
  return String(url || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/rest\/v1$/i, '')
    .replace(/\/+$/, '');
}

function isUsableUrl(url) {
  const u = normalizeSupabaseUrl(url);
  if (!u) return false;
  if (/YOUR_PROJECT/i.test(u)) return false;
  try {
    const parsed = new URL(u);
    return parsed.protocol === 'https:' && parsed.hostname.endsWith('.supabase.co') && (parsed.pathname === '/' || parsed.pathname === '');
  } catch { return false; }
}

function credsFrom(obj) {
  if (!obj) return null;
  const url = normalizeSupabaseUrl(obj.SUPABASE_URL || obj.BREAK_MONITOR_SUPABASE_URL || '');
  const key = obj.SUPABASE_SERVICE_ROLE_KEY || obj.SUPABASE_ANON_KEY || obj.BREAK_MONITOR_SUPABASE_KEY || '';
  return isUsableUrl(url) && key ? { url, key } : null;
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
  const url = normalizeSupabaseUrl(process.env.BREAK_MONITOR_SUPABASE_URL || process.env.SUPABASE_URL || '');
  const key = process.env.BREAK_MONITOR_SUPABASE_KEY
    || process.env.SUPABASE_SERVICE_ROLE_KEY
    || process.env.SUPABASE_ANON_KEY
    || '';
  return isUsableUrl(url) && key ? { url, key } : null;
}

module.exports = { loadEnv, supabaseFromEnv, isUsableUrl, normalizeSupabaseUrl };