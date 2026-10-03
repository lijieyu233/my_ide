const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('aiApproval', {
  show: callback => { ipcRenderer.on('ai-approval:show', (_event, data) => callback(data)); },
  answer: (id, approved, scope = 'once') => ipcRenderer.invoke('ai-approval:answer', id, { approved, scope }),
  stop: id => ipcRenderer.invoke('ai-approval:stop', id),
});
