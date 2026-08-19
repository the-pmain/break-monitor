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
  const srv = createServer({ port, seedSample: false });
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

  const hist = await json(base + '/api/manager/history');
  check('GET /api/manager/history requires session', hist.status === 401);

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
