const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desk', { openReport: () => ipcRenderer.send('open-report') });
