'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { startServer } = require('./server');
const { defaultDeviceName } = require('./core/identity');

let appServer = null;
let win = null;
let quitting = false;
let lockFile = null;

function processAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// 同一台电脑再次启动时使用独立配置目录，避免 Chromium 缓存冲突和身份重复
function claimProfile(base) {
  for (let index = 1; index <= 8; index++) {
    const dir = index === 1 ? base : `${base}-${index}`;
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      continue;
    }
    const lock = path.join(dir, 'instance.lock');
    for (let attempt = 0; attempt < 2; attempt++) {
      let fd = null;
      try {
        fd = fs.openSync(lock, 'wx');
      } catch (err) {
        if (err.code !== 'EEXIST') break;
        let pid = 0;
        try { pid = Number(fs.readFileSync(lock, 'utf8').trim()); } catch { continue; }
        if (processAlive(pid)) break;
        try { fs.unlinkSync(lock); } catch { break; }
        continue;
      }
      try {
        fs.writeFileSync(fd, String(process.pid));
        lockFile = lock;
        return { dir, index };
      } catch {
        continue;
      } finally {
        fs.closeSync(fd);
      }
    }
  }
  return { dir: `${base}-${process.pid}`, index: 9 };
}

const baseProfile = app.getPath('userData');
const profile = claimProfile(baseProfile);
if (profile.dir !== baseProfile) app.setPath('userData', profile.dir);

async function revealInOs(target) {
  const raw = String(target || '').trim();
  if (!raw) throw new Error('路径为空');
  const full = path.resolve(raw);
  const stat = await fsp.stat(full).catch(() => null);
  if (!stat) throw new Error('文件或文件夹不存在');
  if (stat.isDirectory()) {
    const message = await shell.openPath(full);
    if (message) throw new Error(message);
  } else {
    shell.showItemInFolder(full);
  }
}

async function createWindow() {
  const dataDir = path.join(app.getPath('userData'), 'data');
  const opts = {
    dataDir,
    uiPort: 0,
    tcpPort: 7411,
    discoveryPort: 7412,
    onReveal: (p) => revealInOs(p),
    log: (msg) => console.error(`[lanlink] ${msg}`)
  };
  if (profile.index > 1 && !fs.existsSync(path.join(dataDir, 'identity.json'))) {
    opts.name = `${defaultDeviceName()} ${profile.index}`;
  }
  appServer = await startServer(opts);

  win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#080b12',
    title: 'LanLink',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  });
  win.once('ready-to-show', () => win.show());
  win.loadURL(appServer.url);
  win.on('closed', () => { win = null; });
}

ipcMain.handle('pick-files', async () => {
  const result = await dialog.showOpenDialog(win, {
    title: '选择要发送的文件',
    properties: ['openFile', 'multiSelections']
  });
  return result.canceled ? [] : result.filePaths;
});

ipcMain.handle('reveal', async (_event, target) => {
  try {
    await revealInOs(target);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('open-data', async () => {
  if (appServer) await shell.openPath(appServer.manager.dataDir);
  return true;
});

ipcMain.handle('open-external', async (_event, url) => {
  const target = String(url || '');
  if (!/^https?:\/\//i.test(target)) throw new Error('无效链接');
  await shell.openExternal(target);
  return true;
});

ipcMain.handle('app-info', () => ({
  version: app.getVersion(),
  platform: process.platform,
  isDesktop: true
}));

app.whenReady().then(createWindow).catch((err) => {
  dialog.showErrorBox('LanLink 启动失败', err.message || String(err));
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('before-quit', (event) => {
  if (appServer && !quitting) {
    event.preventDefault();
    quitting = true;
    appServer.close().catch(() => {}).then(() => app.quit());
  }
});

app.on('will-quit', () => {
  if (lockFile) {
    try { fs.unlinkSync(lockFile); } catch { /* ignore */ }
    lockFile = null;
  }
});
