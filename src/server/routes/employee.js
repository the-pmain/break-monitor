'use strict';

module.exports = function registerEmployeeRoutes(app, { db, ok, bad, withPin, pushLater }) {
  app.post('/api/employee/verify', withPin, (req, res) => ok(res, { employee: { id: req.employee.id, name: req.employee.name } }));

  app.post('/api/break/start', withPin, async (req, res) => {
    const r = await db.startBreak(req.employee.id, req.body.allowanceMin, {
      isRoomLeaved: req.body.isRoomLeaved == null ? true : !!req.body.isRoomLeaved,
      isFloorLeaved: false
    });
    if (!r.ok) return bad(res, 400, r.error);
    ok(res, r);
    pushLater();
  });
  app.post('/api/break/flags', withPin, async (req, res) => {
    const r = await db.setBreakFlags(req.employee.id, {
      isRoomLeaved: !!req.body.isRoomLeaved,
      isFloorLeaved: false
    });
    if (!r.ok) return bad(res, 400, r.error);
    ok(res, r);
    pushLater();
  });
  app.post('/api/break/end', withPin, async (req, res) => {
    const r = await db.endBreak(req.employee.id, 'employee');
    if (!r.ok) return bad(res, 400, r.error);
    ok(res, r);
    pushLater();
  });
  app.post('/api/employee/leave', withPin, async (req, res) => {
    try {
      ok(res, await db.leaveShift(req.employee.id));
      pushLater();
    } catch (err) { return bad(res, 400, err.message); }
  });
  app.post('/api/employee/return', withPin, async (req, res) => {
    try {
      ok(res, await db.returnToShift(req.employee.id));
      pushLater();
    } catch (err) { return bad(res, 400, err.message); }
  });
};
