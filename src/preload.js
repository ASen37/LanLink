'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('lanlinkDesktop', {
  isDesktop: true,
  appInfo: () => ipcRenderer.invoke('app-info'),
  pickFiles: () => ipcRenderer.invoke('pick-files'),
  pickFolder: (startPath) => ipcRenderer.invoke('pick-folder', startPath),
  pickShareFile: () => ipcRenderer.invoke('pick-share-file'),
  reveal: (target) => ipcRenderer.invoke('reveal', target),
  openDataDir: () => ipcRenderer.invoke('open-data'),
  changeDataDir: () => ipcRenderer.invoke('change-data-dir'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  }
});
