'use strict';
const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { loadEnv, supabaseFromEnv } = require('../server/env');
loadEnv();

let win = null;
let server = null;

const configPath = () => path.join(app.getPath('userData'), 'config.json');

function readConfig() {
  try { return JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch { return null; }
}
function writeConfig(cfg) {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 900, minHeight: 640,
    backgroundColor: '#111722',
    show: false,
    title: 'Break Monitor',
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return;       // aborted / subframe, ignore
    console.error('did-fail-load', code, desc, url);
    loadError(desc || 'Could not reach the server', url);
  });
  return win;
}

function loadError(message, url) {
  const target = pathToFileURL(path.join(__dirname, 'error.html')).href +
    '?m=' + encodeURIComponent(message) + '&u=' + encodeURIComponent(url || '');
  win.loadURL(target);
}

async function boot() {
  const cfg = readConfig();
  if (!cfg || !cfg.mode) return win.loadFile(path.join(__dirname, 'setup.html'));

  if (cfg.mode === 'server') {
    try {
      loadEnv([app.getPath('userData')]);
      const envSb = supabaseFromEnv();
      const { createServer } = require('../server');
      server = createServer({
        port: cfg.port || 8080,
        seedSample: false,
        settingsPath: path.join(app.getPath('userData'), 'app-settings.json'),
        supabaseUrl: envSb && envSb.url,
        supabaseKey: envSb && envSb.key
      });
      await server.listen();
      const page = `http://127.0.0.1:${server.port}/`;
      await waitForHealth(page + 'api/health');
      win.loadURL(page);
    } catch (err) {
      console.error('server boot failed', err);
      const busy = /EADDRINUSE/i.test(err.message);
      loadError(busy
        ? `Port ${cfg.port || 8080} is already in use. Choose a different port in Settings.`
        : 'Server failed to start: ' + err.message, '');
    }
  } else {
    win.loadURL(cfg.serverUrl);
  }
}

function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: openSettings },
        { type: 'separator' },
        { label: 'Copy server address', click: copyAddress },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'forceReload' },
        { type: 'separator' },
        { role: 'togglefullscreen', accelerator: 'F11' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'toggleDevTools' }
      ]
    },
    {
      label: 'Help',
      submenu: [{
        label: 'About Break Monitor',
        click: () => {
          const cfg = readConfig() || {};
          dialog.showMessageBox(win, {
            type: 'info', title: 'Break Monitor',
            message: `Break Monitor ${app.getVersion()}`,
            detail: cfg.mode === 'server'
              ? `Running in Server mode on port ${cfg.port}\nData: Supabase (coworkers, breaks)\nStaff connect to: ${server ? server.address() : ''}`
              : `Running in Client mode\nConnected to: ${cfg.serverUrl || '—'}`
          });
        }
      }]
    }
  ]));
}

async function openSettings() {
  const cfg = readConfig() || {};
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['Cancel', 'Change setup'],
    defaultId: 1, cancelId: 0,
    title: 'Settings',
    message: 'Reconfigure this installation?',
    detail: cfg.mode === 'server'
      ? `Currently the SERVER for this site (port ${cfg.port}).\nChanging this will restart the app. Break data stays in Supabase.`
      : `Currently a CLIENT connected to ${cfg.serverUrl}.`
  });
  if (response !== 1) return;
  try { fs.unlinkSync(configPath()); } catch {}
  if (server) { await server.stop(); server = null; }
  win.loadFile(path.join(__dirname, 'setup.html'));
}

function copyAddress() {
  const { clipboard } = require('electron');
  const cfg = readConfig() || {};
  const addr = cfg.mode === 'server' && server ? server.address() : (cfg.serverUrl || '');
  if (addr) { clipboard.writeText(addr); dialog.showMessageBox(win, { message: 'Copied', detail: addr }); }
}

/* ---------------- IPC from setup / error pages ---------------- */
ipcMain.handle('setup:suggestions', () => {
  const { localIPv4 } = require('../server');
  return { ip: localIPv4(), defaultPort: 8080, version: app.getVersion() };
});

ipcMain.handle('setup:testServer', async (_e, url) => {
  try {
    const base = String(url).replace(/\/+$/, '');
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch(base + '/api/health', { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return { ok: false, error: 'Server replied ' + r.status };
    const j = await r.json();
    return j && j.ok ? { ok: true } : { ok: false, error: 'That address is not a Break Monitor server' };
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? 'No response (timed out)' : err.message };
  }
});

ipcMain.handle('setup:save', async (_e, cfg) => {
  writeConfig(cfg);
  await boot();
  return { ok: true };
});

ipcMain.handle('app:reconfigure', async () => {
  try { fs.unlinkSync(configPath()); } catch {}
  if (server) { await server.stop(); server = null; }
  win.loadFile(path.join(__dirname, 'setup.html'));
});
ipcMain.handle('app:retry', async () => { await boot(); });

async function shutdown() {
  if (!server) return;
  const s = server;
  server = null;
  try { await s.stop(); } catch (err) { console.error('shutdown', err); }
}

async function waitForHealth(url) {
  let last = 'not ready';
  for (let i = 0; i < 25; i++) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 400);
      const r = await fetch(url, { signal: ctrl.signal });
      clearTimeout(t);
      if (r.ok) return;
      last = 'HTTP ' + r.status;
    } catch (err) {
      last = err.message;
    }
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error('Server did not become ready: ' + last);
}

/* ---------------- lifecycle ---------------- */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

  app.whenReady().then(() => {
    createWindow();
    buildMenu();
    boot();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) { createWindow(); boot(); } });
  });

  app.on('window-all-closed', () => { shutdown().finally(() => app.quit()); });
  app.on('before-quit', e => {
    if (!server) return;
    e.preventDefault();
    shutdown().finally(() => app.quit());
  });
}
