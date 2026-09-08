#!/usr/bin/env node
/* Break Monitor web server — serves the SPA and JSON API.
   Usage:  node src/server/standalone.js --port 8080 --seed */
'use strict';
const path = require('path');
const { createServer, localIPv4 } = require('./index');
const { diagnoseSupabase } = require('./env');

const argv = process.argv.slice(2);
const arg = (name, fb) => { const i = argv.indexOf('--' + name); return i > -1 ? argv[i + 1] : fb; };
const flag = name => argv.includes('--' + name);

const port = Number(arg('port', process.env.PORT || 8080));
const settingsPath = arg('settings') || path.join(process.cwd(), 'app-settings.json');

const srv = createServer({
  port, seedSample: flag('seed'), managerPin: arg('manager-pin'),
  settingsPath,
  supabaseUrl: arg('supabase-url'), supabaseKey: arg('supabase-key')
});
srv.listen().then(async () => {
  const cfg = await srv.db.config();
  console.log('Break Monitor web app running');
  console.log('  data     : Supabase (coworkers, breaks)');
  console.log('  staff    :', cfg.staffSource === 'supabase' ? 'Supabase' : 'unconfigured');
  if (cfg.staffSource !== 'supabase') {
    const why = diagnoseSupabase();
    if (why) console.warn('  supabase :', why);
  }
  console.log('  local    : http://localhost:' + port);
  console.log('  network  : http://' + localIPv4() + ':' + port);
  if (flag('seed')) {
    const r = await srv.db.seedDemoActivity();
    if (!r.ok) console.warn('Demo seed skipped:', r.error);
  }
}).catch(err => { console.error('Failed to start:', err.message); process.exit(1); });

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => srv.stop().then(() => process.exit(0)));
