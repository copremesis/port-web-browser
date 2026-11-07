const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tabs', {
  platform: process.platform,
  select: id => ipcRenderer.send('select-tab', id),
  close: id => ipcRenderer.send('close-tab', id),
  toggleDark: id => ipcRenderer.send('toggle-dark', id),
  onChange: callback => ipcRenderer.on('tabs-changed', (event, state) => callback(state)),
});
