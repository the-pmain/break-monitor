'use strict';

module.exports = function registerPublicRoutes(app, { db, ok, live, sseWrite }) {
  app.get('/api/health', async (_req, res) => {
    const cfg = await db.config();
    ok(res, { serverTime: Date.now(), version: 1, staffSource: cfg.staffSource });
  });
  app.get('/api/state', async (_req, res) => res.json(200, await db.state()));
  app.get('/api/events', async (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    res.write('retry: 4000\n\n');
    live.add(res);
    try { sseWrite(res, await db.state()); } catch {}
    const hb = setInterval(() => {
      if (res.writableEnded) return;
      try { res.write(': ping\n\n'); } catch {}
    }, 25000);
    const gone = () => { clearInterval(hb); live.delete(res); };
    req.on('close', gone);
    res.on('close', gone);
  });
};
