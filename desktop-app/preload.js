const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  fetchChannels: () => ipcRenderer.invoke('fetch-channels'),
  openSettings: () => ipcRenderer.invoke('open-settings'),
  getGatewaySettings: () => ipcRenderer.invoke('get-gateway-settings'),
  saveGatewaySettings: (devices) => ipcRenderer.invoke('save-gateway-settings', devices),
  isElectron: true
});
