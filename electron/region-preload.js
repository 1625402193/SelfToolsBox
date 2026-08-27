const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('regionAPI', {
  finish: (region) => ipcRenderer.send('region:finish', region),
  cancel: () => ipcRenderer.send('region:cancel'),
});
