#!/usr/bin/env node
/* Run the Break Monitor server without Electron — handy for testing or for
   running it as a Windows service / on a headless box.
   Usage:  node src/server/standalone.js --port 8080 --seed */
'use strict';
const { createServer, localIPv4 } = require('./index');

const argv = process.argv.slice(2);
const arg = (name, fb) => { const i = argv.indexOf('--' + name); return i > -1 ? argv[i + 1] : fb; };
const flag = name => argv.includes('--' + name);

const port = Number(arg('port', process.env.PORT || 8080));

const srv = createServer({
  port, seedSample: flag('seed'), managerPin: arg('manager-pin'),
  supabaseUrl: arg('supabase-url'), supabaseKey: arg('supabase-key')
});
srv.listen().then(async () => {
  const cfg = await srv.db.config();
  console.log('Break Monitor server running');
  console.log('  data     : Supabase (coworkers, breaks)');
  console.log('  staff    :', cfg.staffSource === 'supabase' ? 'Supabase' : 'unconfigured');
  console.log('  local    : http://localhost:' + port);
  console.log('  network  : http://' + localIPv4() + ':' + port);
  if (flag('seed')) {
    const r = await srv.db.seedDemoActivity();
    if (!r.ok) console.warn('Demo seed skipped:', r.error);
  }
}).catch(err => { console.error('Failed to start:', err.message); process.exit(1); });

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => srv.stop().then(() => process.exit(0)));
