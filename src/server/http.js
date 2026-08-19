'use strict';
/* A very small HTTP router built on node:http — no third-party dependencies.
   Enough for a LAN app: static files, JSON bodies, :params, middleware. */
const http = require('http');
const fs = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',   '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json'
};

function compile(pattern) {
  const keys = [];
  const rx = '^' + pattern.replace(/[.+*?^${}()|[\]\\]/g, '\\$&')
    .replace(/:(\w+)/g, (_m, k) => { keys.push(k); return '([^/]+)'; }) + '$';
  return { rx: new RegExp(rx), keys };
}

function createApp(staticDir) {
  const routes = [];
  const add = (method, pattern, ...handlers) => routes.push({ method, ...compile(pattern), handlers });

  const app = {
    get:    (p, ...h) => add('GET', p, ...h),
    post:   (p, ...h) => add('POST', p, ...h),
    patch:  (p, ...h) => add('PATCH', p, ...h),
    delete: (p, ...h) => add('DELETE', p, ...h),

    server: http.createServer(async (req, res) => {
      res.json = (code, obj) => {
        const body = JSON.stringify(obj);
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(body);
      };
      let parsed;
      try { parsed = new URL(req.url, 'http://localhost'); } catch { return res.json(400, { ok: false, error: 'Bad URL' }); }
      const pathname = decodeURIComponent(parsed.pathname);
      req.query = Object.fromEntries(parsed.searchParams);

      const match = routes.find(r => r.method === req.method && r.rx.test(pathname));
      if (match) {
        const m = pathname.match(match.rx);
        req.params = Object.fromEntries(match.keys.map((k, i) => [k, m[i + 1]]));
        try {
          req.body = await readJson(req);
        } catch (err) {
          return res.json(400, { ok: false, error: err.message });
        }
        let i = 0;
        const next = async () => {
          const h = match.handlers[i++];
          if (!h) return;
          await h(req, res, next);
        };
        try { await next(); }
        catch (err) { if (!res.writableEnded) res.json(500, { ok: false, error: err.message }); }
        return;
      }

      if (pathname.startsWith('/api/')) return res.json(404, { ok: false, error: 'Unknown endpoint' });
      if (req.method !== 'GET') return res.json(405, { ok: false, error: 'Method not allowed' });
      return serveStatic(staticDir, pathname, res);
    })
  };
  return app;
}

function readJson(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return Promise.resolve({});
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > 262144) { reject(new Error('Request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function serveStatic(dir, pathname, res) {
  let rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.resolve(dir, rel);
  if (!file.startsWith(path.resolve(dir))) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<h1>404</h1><p>Not found. <a href="/">Go to Break Monitor</a></p>');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(buf);
  });
}

module.exports = { createApp };
