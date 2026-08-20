# Break Monitor

Local-network break tracking for a shop floor, warehouse or office. One Windows
installer; on first launch each PC is set up as either the **server** (one
always-on PC that talks to Supabase and serves the LAN) or a **client** (everyone
else).

Staff and live breaks live in Supabase (`coworkers` and `breaks`). Staff sign in
with a name and 4-digit PIN, pick a break allowance, and get a live countdown.
Rostered hours come from `schedule_start` / `schedule_end` on the coworker row —
the app calculates time into the shift from that. Managers get a dashboard
showing who is on shift, who is on break, how long they have left, who is
overdue, and the daily history.

---

## Requirements

* Windows 10 or 11 (64-bit) for the installer.
* [Node.js 20 or newer](https://nodejs.org) - only on the PC that **builds** the
  installer. PCs that just run the app need nothing extra.
* The server PC needs a fixed local IP address and must stay switched on.

## Build the Windows installer

Double-click **`BUILD-WINDOWS-INSTALLER.bat`**, or from a terminal in this folder:

```
npm install
npm run dist
```

The installer appears in `dist\BreakMonitor-Setup-0.1.0.exe` (about 80 MB).
Copy that file to each PC and run it.

Other build targets:

| Command                 | Produces                                          |
|-------------------------|---------------------------------------------------|
| `npm run dist`          | `BreakMonitor-Setup-x.x.x.exe` - normal installer  |
| `npm run dist:portable` | A single portable .exe that needs no install       |
| `npm run dist:dir`      | An unpacked folder - useful for testing            |

### About the Windows security warning

The installer is **unsigned**, so SmartScreen will show
"Windows protected your PC" the first time it runs. Click *More info* ->
*Run anyway*. To remove the warning permanently you need a code-signing
certificate (roughly 200-400 GBP per year from a certificate authority); once
you have one, point electron-builder at it with the `CSC_LINK` and
`CSC_KEY_PASSWORD` environment variables.


## Run it without building (for a quick look)

```
npm install
npm start
```

## Run the server without Electron

Handy for a headless box or for running as a Windows service:

```
npm run server -- --port 8080
```

---

## First-time setup

**On the server PC**

1. Install and open Break Monitor.
2. Choose **This is the server PC** and keep port 8080. Staff are loaded from
   `.env` (`SUPABASE_URL` and `SUPABASE_ANON_KEY`).
3. Note the address it shows, e.g. `http://192.168.1.50:8080`. You can get it
   again any time from *File -> Copy server address*.
4. Allow the app through Windows Firewall when prompted (Private networks).
   If you miss the prompt, run PowerShell as administrator:

   ```
   New-NetFirewallRule -DisplayName "Break Monitor" -Direction Inbound `
     -Protocol TCP -LocalPort 8080 -Action Allow -Profile Private
   ```

5. Give the server PC a fixed IP (a DHCP reservation on your router is the
   tidiest way). If its address changes, clients stop finding it.

**On every other PC**

1. Install and open Break Monitor.
2. Choose **This is a staff PC** and enter the server address.
3. It checks the connection before saving.

Anyone can also just open the address in a browser - the app is served over HTTP
as well, so tablets and phones on the same Wi-Fi work with no install.

**Default manager PIN is `9119`. Change it under Director -> Settings.**

---

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
stay on this PC (`app-settings.json`). There is no `shifts` or `settings` table.

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

Copy `.env.example` to `.env` and fill in `SUPABASE_URL` plus `SUPABASE_ANON_KEY`
or `SUPABASE_SERVICE_ROLE_KEY`. The URL must be `https://xxxx.supabase.co` with
no `/rest/v1` suffix. Until those are set, the app still starts with an empty
staff list.

This PC only keeps `config.json` (server vs client mode) and optional
`app-settings.json`. There is no SQLite database.

## Security notes

This is designed for a trusted local network.

* Traffic is plain HTTP. Anyone on your LAN who knows the address can see the
  staff list and break statuses. Actions require a PIN.
* Coworker PINs are stored in Supabase as `numeric` (plain). The manager PIN is
  hashed (scrypt) and kept on the server PC, not in Supabase.
* Five wrong PINs locks that PIN for 30 seconds.
* Director sessions last 8 hours and are held in the server's memory only.
* Do **not** port-forward this to the internet. If you need remote access, put
  it behind a VPN.

## Project layout

```
src/server/             Node HTTP API (no Electron)
  index.js              createServer, listen, stop, SSE broadcast
  auth.js               PIN lockout and director sessions
  routes/               /api/health, employee, director
  http.js               Tiny dependency-free router + static files
  db.js                 App data layer (all tables in Supabase)
  supabase.js           Supabase REST client
  env.js                .env loader
  standalone.js         Run the server without Electron
src/client/             Browser UI, served by the server to PCs and phones
src/main/               Electron shell only (window, setup, client-mode)
  main.js               Entry point, menu, server vs client mode
  setup.html            First-run wizard
  error.html            "Can't reach the server" screen
  preload.js            Safe bridge for the two local pages
supabase/schema.sql     Tables to create in Supabase
```

There are no runtime npm dependencies - the server uses only Node built-ins.
`electron` / `electron-builder` are build-time only.

## Not built yet

Shift schedules and rostering beyond the times on each coworker, per-employee
break allowances, break approval workflows, multi-site support, printed reports,
automatic updates.



https://drive.google.com/file/d/1DFqH-5Jte7_-u3o-IafC-0Typ-4rR78h/view