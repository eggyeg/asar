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
  repairCaches: () => ipcRenderer.invoke('ck'),
  debug: {
    status: () => ipcRenderer.sendSync('dg'),
    start: () => ipcRenderer.invoke('ds'),
    stop: () => ipcRenderer.invoke('dx'),
    snapshot: () => ipcRenderer.invoke('dn'),
    tail: since => ipcRenderer.invoke('dt', since),
    onStart: on => ipcRenderer.invoke('dw', on),
    open: name => ipcRenderer.invoke('do', name ?? null),
    reveal: name => ipcRenderer.invoke('dr', name),
    copy: name => ipcRenderer.invoke('dy', name)
  }
});
