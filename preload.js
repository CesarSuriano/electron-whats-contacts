const { contextBridge, ipcRenderer, shell } = require('electron');

// Expõe uma API segura para o renderer (Angular)
contextBridge.exposeInMainWorld('electronAPI', {
  loadXml: () => ipcRenderer.invoke('load-xml'),
  openExternal: (url) => shell.openExternal(url),
  openAgentWindow: (payload) => ipcRenderer.invoke('agent:open-window', payload),
  generateAgentSuggestion: (payload) => ipcRenderer.invoke('agent:generate-suggestion', payload),
  getVersion: () => ipcRenderer.invoke('app:get-version'),
  checkUpdate: (updateUrl) => ipcRenderer.invoke('app:check-update', updateUrl),
  installUpdate: (downloadUrl) => ipcRenderer.invoke('app:install-update', downloadUrl),
});

window.addEventListener('DOMContentLoaded', () => {
  console.log('Electron preload loaded');
});
