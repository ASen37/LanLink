'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('lanlinkDesktop', {
  isDesktop: true,
  appInfo: () => ipcRenderer.invoke('app-info'),
  pickFiles: () => ipcRenderer.invoke('pick-files'),
  reveal: (target) => ipcRenderer.invoke('reveal', target),
  openDataDir: () => ipcRenderer.invoke('open-data'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  }
});
