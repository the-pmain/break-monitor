# Break Monitor

Web SPA for shop-floor, warehouse or office break tracking. A Node server
serves the single-page app and JSON API; staff and live breaks live in
Supabase (`coworkers` and `breaks`).

Staff sign in with a name and 4-digit PIN, pick a break allowance, and get a
live countdown. Rostered hours come from `schedule_start` / `schedule_end`
on the coworker row. Managers get a dashboard showing who is on shift, who
is on break, how long they have left, who is overdue, and the daily history.

Open the app in any browser on the same network (desktop, tablet or phone).

---

## Requirements

* [Node.js 20 or newer](https://nodejs.org)

## Run locally

```
npm start
```

Then open [http://localhost:8080](http://localhost:8080). Default port is
`8080` (`PORT` or `--port` to change it).

```
npm start -- --port 8080
```

On Windows you can also double-click **`RUN-APP.bat`**.

## First-time setup

1. Copy `.env.example` to `.env` and fill in `SUPABASE_URL` plus
   `SUPABASE_ANON_KEY` or `SUPABASE_SERVICE_ROLE_KEY`. The URL must be
   `https://xxxx.supabase.co` with no `/rest/v1` suffix. Until those are set,
   the app still starts with an empty staff list.
2. Start the server and open the address it prints (local and LAN).
3. **Default manager PIN is `9119`.** Change it under Director → Settings.

Staff on other devices only need the URL in a browser — no install.

## Using it

**Staff** - tap your name, enter your PIN, pick a break length, and the
countdown starts. It turns amber near the end and red once you are over. Tap
*End break* when you are back. Shift time on screen is calculated from the
person's rostered hours (`schedule_start` / `schedule_end`).

**Director** - enter the manager PIN.

* *Live floor* - tiles, an overdue banner, and a live table. You can end
  someone's break for them if they forget.
* *History* - every completed break for the last 1-90 days, exportable to CSV
  for payroll or HR.
* *Staff* - add, edit and remove coworkers in Supabase, and reset PINs.
* *Settings* - site name, break lengths, manager PIN, and a
  demo-data generator for showing the app to someone.

---

## Where the data lives

Supabase holds staff and breaks. Site name, break lengths and the manager PIN
are stored on the host as `app-settings.json`. There is no `shifts` or
`settings` table.

**`coworkers`** — staff

| Column | Used as |
|--------|---------|
| `id` | Identity |
| `name` | Sign-in name |
| `category` | Category / team |
| `schedule_start` / `schedule_end` | Rostered shift (the app calculates time into / left on shift from this) |
| `pin` | 4-digit PIN (numeric) |

**`breaks`** — live and finished breaks (`coworker_id` references `coworkers.id`)

| Column | Type |
|--------|------|
| `id` | bigint identity |
| `coworker_id` | bigint, FK to coworkers |
| `allowance_min` | integer |
| `started_at` / `ended_at` | timestamptz (`ended_at` null = still on break) |
| `ended_by` | text |

## Security notes

This is designed for a trusted network.

* Traffic is plain HTTP unless you put TLS in front of it. Anyone who can
  reach the URL can see the staff list and break statuses. Actions require a PIN.
* Coworker PINs are stored in Supabase as `numeric` (plain). The manager PIN is
  hashed (scrypt) and kept on the server as `app-settings.json`, not in Supabase.
* Five wrong PINs locks that PIN for 30 seconds.
* Director sessions last 8 hours and are held in the server's memory only.
* Do **not** port-forward this to the internet. If you need remote access, put
  it behind a VPN.

## Project layout

```
src/server/             Node HTTP API
  index.js              createServer, listen, stop, SSE broadcast
  auth.js               PIN lockout and director sessions
  routes/               /api/health, employee, director
  http.js               Tiny dependency-free router + SPA static files
  db.js                 App data layer (all tables in Supabase)
  supabase.js           Supabase REST client
  env.js                .env loader
  standalone.js         Process entry — serves the SPA
src/client/             Single-page UI (served to any browser)
supabase/schema.sql     Tables to create in Supabase
```

There are no npm runtime dependencies — the server uses only Node built-ins.

## Tests

```
npm test
```

## Not built yet

Shift schedules and rostering beyond the times on each coworker, per-employee
break allowances, break approval workflows, multi-site support, printed reports.
