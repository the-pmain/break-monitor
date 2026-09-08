'use strict';
/* Client URL map for the Break Monitor SPA. No bundler — this file is
   loaded in the browser and also required by the smoke test. */
(function (root) {
  const DIRECTOR_PANES = ['live', 'history', 'late', 'staff', 'settings'];

  function cleanPath(pathname) {
    const raw = String(pathname || '/').split('?')[0].split('#')[0];
    const trimmed = raw.replace(/\/+$/, '');
    return trimmed || '/';
  }

  function employeeRoute(id) {
    const employeeId = Number(id);
    return { name: 'employee', employeeId, path: '/staff/' + employeeId };
  }

  function parseEmployeeHead(parts, path) {
    if (parts[1] === 'home' && !parts[2]) return { name: 'staff-home', path: '/staff/home' };
    if (parts[1] && /^\d+$/.test(parts[1]) && !parts[2]) return employeeRoute(parts[1]);
    if (!parts[1]) return { name: 'staff', path: '/staff' };
    return { name: 'not-found', path: path };
  }

  function parse(pathname) {
    const path = cleanPath(pathname);
    const parts = path.split('/').filter(Boolean);

    if (!parts.length) {
      return { name: 'staff', path: '/staff' };
    }

    const head = parts[0];
    if (head === 'director' || head === 'manager') {
      if (parts[2]) return { name: 'not-found', path: path };
      if (!parts[1]) return { name: 'director', pane: 'live', path: '/director/live' };
      if (!DIRECTOR_PANES.includes(parts[1])) return { name: 'not-found', path: path };
      return { name: 'director', pane: parts[1], path: '/director/' + parts[1] };
    }

    if (head === 'staff' || head === 'kiosk' || head === 'employee' || head === 'employees') {
      return parseEmployeeHead(parts, path);
    }

    return { name: 'not-found', path: path };
  }

  function pathFor(route) {
    if (!route) return '/staff';
    if (route.name === 'staff-home') return '/staff/home';
    if (route.name === 'employee') return '/staff/' + Number(route.employeeId);
    if (route.name === 'director') {
      const pane = DIRECTOR_PANES.includes(route.pane) ? route.pane : 'live';
      return '/director/' + pane;
    }
    if (route.name === 'not-found') return route.path || '/staff';
    return '/staff';
  }

  function isAppPath(pathname) {
    return parse(pathname).name !== 'not-found' || cleanPath(pathname) === '/';
  }

  const api = { DIRECTOR_PANES, parse, pathFor, cleanPath, isAppPath };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BMRouter = api;
})(typeof window !== 'undefined' ? window : globalThis);
