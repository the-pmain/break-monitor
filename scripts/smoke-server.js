'use strict';
const { createServer, CLIENT_DIR } = require('../src/server');
const fs = require('fs');
const path = require('path');

async function json(url, opts) {
  const res = await fetch(url, opts);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

(async () => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const srv = createServer({ port, seedSample: false, settingsPath: null });
  await srv.listen();
  const base = 'http://127.0.0.1:' + port;
  const fails = [];
  const check = (name, ok, extra) => {
    if (!ok) fails.push(name + (extra ? ' — ' + extra : ''));
    console.log((ok ? 'ok  ' : 'FAIL') + '  ' + name + (extra ? '  ' + extra : ''));
  };

  check('client dir exists', fs.existsSync(path.join(CLIENT_DIR, 'index.html')));

  const health = await json(base + '/api/health');
  check('GET /api/health', health.status === 200 && health.body.ok === true, JSON.stringify(health.body));

  const state = await json(base + '/api/state');
  check('GET /api/state', state.status === 200 && Array.isArray(state.body.employees), 'employees=' + (state.body.employees && state.body.employees.length));

  const home = await fetch(base + '/');
  const html = await home.text();
  check('GET / serves client', home.status === 200 && html.includes('Staff') && html.includes('app.js'));

  const js = await fetch(base + '/app.js');
  const jsText = await js.text();
  check('GET /app.js', js.status === 200 && jsText.includes('/api/state'));

  const css = await fetch(base + '/styles.css');
  check('GET /styles.css', css.status === 200 && (await css.text()).includes('--'));

  const spa = await fetch(base + '/staff');
  const spaHtml = await spa.text();
  check('GET /staff SPA fallback', spa.status === 200 && spaHtml.includes('Staff') && spaHtml.includes('/app.js'));

  const empPage = await fetch(base + '/staff/1');
  check('GET /staff/1 SPA fallback', empPage.status === 200 && (await empPage.text()).includes('/router.js'));

  const empAlias = await fetch(base + '/employee/1');
  check('GET /employee/1 SPA fallback', empAlias.status === 200 && (await empAlias.text()).includes('Staff'));

  const director = await fetch(base + '/director/history');
  const directorHtml = await director.text();
  check('GET /director/history SPA fallback', director.status === 200 && directorHtml.includes('Director') && directorHtml.includes('/router.js'));

  const settings = await fetch(base + '/director/settings');
  check('GET /director/settings SPA fallback', settings.status === 200 && (await settings.text()).includes('Site settings'));

  const unknownPage = await fetch(base + '/no-such-page');
  check('GET unknown page is SPA shell', unknownPage.status === 200 && (await unknownPage.text()).includes('Page not found'));

  const routerJs = await fetch(base + '/router.js');
  check('GET /router.js', routerJs.status === 200 && (await routerJs.text()).includes('DIRECTOR_PANES'));

  const Router = require('../src/client/router');
  const rRoot = Router.parse('/');
  check('parse / → /staff', rRoot.name === 'staff' && rRoot.path === '/staff');
  const rDir = Router.parse('/director');
  check('parse /director → /director/live', rDir.name === 'director' && rDir.pane === 'live' && rDir.path === '/director/live');
  const rHist = Router.parse('/director/history/');
  check('parse /director/history/', rHist.name === 'director' && rHist.pane === 'history');
  const rPin = Router.parse('/staff/42');
  check('parse /staff/42', rPin.name === 'employee' && rPin.employeeId === 42 && rPin.path === '/staff/42');
  const rEmp = Router.parse('/employee/7');
  check('parse /employee/7 → /staff/7', rEmp.name === 'employee' && rEmp.employeeId === 7 && rEmp.path === '/staff/7');
  const rHome = Router.parse('/staff/home');
  check('parse /staff/home', rHome.name === 'staff-home');
  check('pathFor employee', Router.pathFor({ name: 'employee', employeeId: 12 }) === '/staff/12');
  const rNope = Router.parse('/nope');
  check('parse unknown is not-found', rNope.name === 'not-found');
  const rBadPane = Router.parse('/director/foo');
  check('parse /director/foo is not-found', rBadPane.name === 'not-found');
  check('pathFor director settings', Router.pathFor({ name: 'director', pane: 'settings' }) === '/director/settings');

  const missingAsset = await fetch(base + '/no-such-file.js');
  check('GET missing asset is 404', missingAsset.status === 404);

  const verify = await json(base + '/api/employee/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ employeeId: 1, pin: '0000' })
  });
  check('POST /api/employee/verify rejects bad PIN', verify.status === 401 && verify.body.ok === false, verify.body.error);

  const login = await json(base + '/api/manager/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: '0000' })
  });
  check('POST /api/manager/login rejects bad PIN', login.status === 401 && login.body.ok === false);

  const sess = await json(base + '/api/manager/session');
  check('GET /api/manager/session requires session', sess.status === 401);

  const empBreaks = await json(base + '/api/manager/employees/1/breaks');
  check('GET /api/manager/employees/:id/breaks requires session', empBreaks.status === 401);

  const missing = await json(base + '/api/nope');
  check('unknown /api is 404', missing.status === 404);

  await srv.stop();
  if (fails.length) {
    console.error('\nFailed:\n' + fails.map(f => '  - ' + f).join('\n'));
    process.exit(1);
  }
  console.log('\nAll smoke checks passed');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
