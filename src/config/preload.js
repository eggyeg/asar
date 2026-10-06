const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('Native', {
  get: () => ipcRenderer.sendSync('cg'),
  set: c => ipcRenderer.send('cs', c),
  info: () => ipcRenderer.sendSync('ci'),
  restart: () => ipcRenderer.send('cr'),
  close: () => ipcRenderer.send('cc'),
  minimize: () => ipcRenderer.send('cm'),
  open: () => ipcRenderer.send('of'),
  update: () => ipcRenderer.invoke('cu'),
  restore: () => ipcRenderer.invoke('cx'),
  repairCaches: () => ipcRenderer.invoke('ck')
});
