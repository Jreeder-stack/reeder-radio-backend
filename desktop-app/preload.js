const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  fetchChannels: () => ipcRenderer.invoke('fetch-channels'),
  openSettings: () => ipcRenderer.invoke('open-settings'),
  fetchGatewayChannels: () => ipcRenderer.invoke('fetch-channels'),
  connectGateway: (channel) => ipcRenderer.invoke('gateway-connect', channel),
  disconnectGateway: () => ipcRenderer.invoke('gateway-disconnect'),
  startGatewayPtt: () => ipcRenderer.invoke('gateway-ptt-start'),
  endGatewayPtt: () => ipcRenderer.invoke('gateway-ptt-end'),
  sendGatewayPcm: (bytes, sequence) => ipcRenderer.send('gateway-tx-pcm', {bytes, sequence}),
  onGatewayAudio: (callback) => {
    const fn = (_event, data) => callback(data);
    ipcRenderer.on('gateway-transport-event', fn);
    return () => ipcRenderer.removeListener('gateway-transport-event', fn);
  },
  getGatewaySettings: () => ipcRenderer.invoke('get-gateway-settings'),
  saveGatewaySettings: (devices) => ipcRenderer.invoke('save-gateway-settings', devices),
  isElectron: true
});

if (window.location.protocol === 'https:' || window.location.protocol === 'http:') {
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const data = event.data;
    if (!data || data.source !== 'cf33-gateway-transport') return;
    ipcRenderer.send('gateway-transport-event', data);
  });
}
