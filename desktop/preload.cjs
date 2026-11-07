const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tabs', {
  platform: process.platform,
  select: id => ipcRenderer.send('select-tab', id),
  close: id => ipcRenderer.send('close-tab', id),
  toggleDark: id => ipcRenderer.send('toggle-dark', id),
  back: () => ipcRenderer.send('tab-action', 'back'),
  forward: () => ipcRenderer.send('tab-action', 'forward'),
  reload: () => ipcRenderer.send('tab-action', 'reload'),
  navigate: text => ipcRenderer.invoke('navigate-tab', text),
  onFocusAddress: callback => ipcRenderer.on('focus-address', () => callback()),
  onChange: callback => ipcRenderer.on('tabs-changed', (event, state) => callback(state)),
});
