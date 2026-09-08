'use strict';
const dbLib = require('../db');

function parseDayStart(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime())) return null;
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

module.exports = function registerManagerRoutes(app, { db, ok, bad, manager, pushLater, auth }) {
  app.post('/api/manager/login', async (req, res) => {
    const g = auth.guard('mgr');
    if (g.locked) return bad(res, 429, `Too many attempts. Try again in ${g.seconds}s.`);
    if (!(await db.authManager(String((req.body || {}).pin || '')))) { auth.fail('mgr'); return bad(res, 401, 'Incorrect PIN'); }
    auth.clear('mgr');
    ok(res, { token: auth.issueToken() });
  });

  app.get('/api/manager/session', manager, (_req, res) => ok(res, { director: true }));

  app.post('/api/manager/break/:id/end', manager, async (req, res) => {
    const r = await db.endBreakById(Number(req.params.id), 'manager');
    if (!r.ok) return bad(res, 400, r.error);
    ok(res, r);
    pushLater();
  });

  app.get('/api/manager/history', manager, async (req, res) => {
    const days = Math.min(90, Math.max(1, Number(req.query.days || 1)));
    const d = new Date(); d.setHours(0, 0, 0, 0);
    ok(res, { history: await db.historySince(d.getTime() - (days - 1) * 86400000) });
  });

  app.get('/api/manager/late', manager, async (req, res) => {
    const fromMs = parseDayStart(req.query.from);
    const toStart = parseDayStart(req.query.to);
    if (fromMs == null || toStart == null) return bad(res, 400, 'Choose a from and to date (YYYY-MM-DD)');
    let start = fromMs;
    let end = toStart;
    if (end < start) { const tmp = start; start = end; end = tmp; }
    const span = end - start;
    if (span > 366 * 86400000) return bad(res, 400, 'Date range cannot be longer than 366 days');
    ok(res, { late: await db.lateBreaks(start, end + 86400000) });
  });

  app.get('/api/manager/employees', manager, async (_req, res) =>
    ok(res, { employees: (await db.listAllEmployees()).map(e => {
      const category = e.category || e.dept || '';
      return {
        id: e.id, name: e.name, category, dept: category,
        shiftStart: e.shift_start, shiftEnd: e.shift_end, active: e.active !== false
      };
    }) }));

  app.post('/api/manager/employees', manager, async (req, res) => {
    const { name, pin, shiftStart, shiftEnd } = req.body || {};
    const category = req.body.category ?? req.body.dept ?? '';
    if (!name || !String(name).trim()) return bad(res, 400, 'Name is required');
    if (!/^\d{4}$/.test(String(pin || ''))) return bad(res, 400, 'PIN must be 4 digits');
    try {
      ok(res, { id: await db.addEmployee({ name: String(name).trim(), pin: String(pin), category, dept: category, shiftStart, shiftEnd }) });
      pushLater();
    } catch (err) { return bad(res, 400, err.message); }
  });

  app.patch('/api/manager/employees/:id', manager, async (req, res) => {
    if (req.body.pin && !/^\d{4}$/.test(String(req.body.pin))) return bad(res, 400, 'PIN must be 4 digits');
    const patch = { ...req.body };
    if (patch.category != null) patch.dept = patch.category;
    try {
      if (!(await db.updateEmployee(Number(req.params.id), patch))) return bad(res, 404, 'Not found');
      ok(res);
      pushLater();
    } catch (err) { return bad(res, 400, err.message); }
  });

  app.get('/api/manager/employees/:id/breaks', manager, async (req, res) => {
    const emp = await db.getEmployee(Number(req.params.id));
    if (!emp) return bad(res, 404, 'Not found');
    ok(res, { count: await db.employeeBreakCount(Number(req.params.id)) });
  });

  app.delete('/api/manager/employees/:id', manager, async (req, res) => {
    try {
      const r = await db.removeEmployee(Number(req.params.id));
      if (!r.ok) return bad(res, 404, r.error || 'Not found');
      ok(res, { removed: true, id: r.id, name: r.name, breaksRemoved: r.breaksRemoved || 0 });
      pushLater();
    } catch (err) { return bad(res, 400, err.message); }
  });

  app.post('/api/manager/settings', manager, async (req, res) => {
    const b = req.body || {};
    if (b.siteName) await db.setSetting('site_name', String(b.siteName).slice(0, 60));
    if (Array.isArray(b.allowances) && b.allowances.length) {
      const list = [...new Set(b.allowances.map(Number).filter(n => n > 0 && n <= 240))].sort((a, x) => x - a);
      if (list.length) await db.setSetting('allowances', JSON.stringify(list));
    }
    if (b.managerPin) {
      if (!/^\d{4,8}$/.test(String(b.managerPin))) return bad(res, 400, 'Director PIN must be 4–8 digits');
      await db.setSetting('manager_pin', dbLib.hashPin(String(b.managerPin)));
    }
    ok(res, { config: await db.config() });
    pushLater();
  });

  app.post('/api/manager/demo/seed', manager, async (_req, res) => {
    const r = await db.seedDemoActivity();
    if (!r.ok) return bad(res, 400, r.error);
    ok(res);
    pushLater();
  });
  app.post('/api/manager/demo/reset', manager, async (_req, res) => {
    ok(res, await db.resetActivity());
    pushLater();
  });
};
