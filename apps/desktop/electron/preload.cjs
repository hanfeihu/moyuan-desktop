const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('moyuanDesktop', {
  collectDiagnostics: () => ipcRenderer.invoke('moyuan:collect-diagnostics'),
})
