'use strict';
const path = require('path');
const os = require('os');
const { createApp } = require('./http');
const dbLib = require('./db');
const { loadEnv, supabaseFromEnv } = require('./env');
const { createAuth } = require('./auth');
const registerPublicRoutes = require('./routes/public');
const registerEmployeeRoutes = require('./routes/employee');
const registerManagerRoutes = require('./routes/manager');

loadEnv();

const CLIENT_DIR = path.join(__dirname, '..', 'client');

function localIPv4() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return '127.0.0.1';
}

function createServer(opts = {}) {
  const port = Number(opts.port || 8080);
  const envSb = supabaseFromEnv();
  const db = dbLib.open(null, {
    managerPin: opts.managerPin,
    settingsPath: opts.settingsPath,
    seedSample: false,
    supabaseUrl: opts.supabaseUrl || (envSb && envSb.url),
    supabaseKey: opts.supabaseKey || (envSb && envSb.key)
  });

  const app = createApp(CLIENT_DIR);

  const ok  = (res, body = {}) => res.json(200, { ok: true, ...body });
  const bad = (res, code, error) => res.json(code, { ok: false, error });
  const auth = createAuth(db, { bad });

  const live = new Set();
  function sseWrite(res, payload) {
    if (res.writableEnded) return;
    try { res.write('data: ' + JSON.stringify(payload) + '\n\n'); } catch {}
  }
  async function broadcast() {
    if (!live.size) return;
    let state;
    try { state = await db.state(); } catch { return; }
    for (const res of [...live]) sseWrite(res, state);
  }
  function pushLater() {
    setImmediate(() => broadcast().catch(() => {}));
  }

  const ctx = {
    db, ok, bad, auth,
    withPin: auth.withPin,
    manager: auth.manager,
    live, sseWrite, pushLater
  };
  registerPublicRoutes(app, ctx);
  registerEmployeeRoutes(app, ctx);
  registerManagerRoutes(app, ctx);

  const server = app.server;
  let stopping = null;
  return {
    app, db, port,
    driver: dbLib.driverName(),
    address: () => `http://${localIPv4()}:${port}`,
    listen() {
      return new Promise((resolve, reject) => {
        const onError = err => reject(err);
        server.once('error', onError);
        server.requestTimeout = 0;
        server.headersTimeout = 0;
        server.timeout = 0;
        server.listen(port, '0.0.0.0', () => { server.off('error', onError); resolve(server); });
      });
    },
    stop() {
      if (stopping) return stopping;
      stopping = new Promise(r => {
        for (const res of live) {
          try { res.end(); } catch {}
        }
        live.clear();
        const done = () => { try { db.close(); } catch {} r(); };
        if (!server.listening) { done(); return; }
        server.close(err => {
          if (err && err.code !== 'ERR_SERVER_NOT_RUNNING') console.error(err);
          done();
        });
      });
      return stopping;
    }
  };
}

module.exports = { createServer, localIPv4, CLIENT_DIR };
