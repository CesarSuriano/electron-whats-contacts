const { contextBridge, ipcRenderer, shell } = require('electron');

// Expõe uma API segura para o renderer (Angular)
contextBridge.exposeInMainWorld('electronAPI', {
  loadXml: () => ipcRenderer.invoke('load-xml'),
  openExternal: (url) => shell.openExternal(url),
});

window.addEventListener('DOMContentLoaded', () => {
  console.log('Electron preload loaded');
});
