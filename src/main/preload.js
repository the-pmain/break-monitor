'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('breakMonitor', {
  isDesktop: true,
  suggestions: () => ipcRenderer.invoke('setup:suggestions'),
  testServer:  url => ipcRenderer.invoke('setup:testServer', url),
  save:        cfg => ipcRenderer.invoke('setup:save', cfg),
  reconfigure: () => ipcRenderer.invoke('app:reconfigure'),
  retry:       () => ipcRenderer.invoke('app:retry')
});
