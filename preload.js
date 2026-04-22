const { contextBridge, ipcRenderer, shell } = require('electron');

// Expõe uma API segura para o renderer (Angular)
contextBridge.exposeInMainWorld('electronAPI', {
  loadXml: () => ipcRenderer.invoke('load-xml'),
  openExternal: (url) => shell.openExternal(url),
  openAgentWindow: (payload) => ipcRenderer.invoke('agent:open-window', payload),
  generateAgentSuggestion: (payload) => ipcRenderer.invoke('agent:generate-suggestion', payload),
});

window.addEventListener('DOMContentLoaded', () => {
  console.log('Electron preload loaded');
});
