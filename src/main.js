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

// 自定义数据目录记录在 userData/data-path.txt，卸载脚本据此清理
const DATA_POINTER = 'data-path.txt';

function customDataDir() {
  try {
    const file = path.join(app.getPath('userData'), DATA_POINTER);
    if (!fs.existsSync(file)) return '';
    const raw = fs.readFileSync(file, 'utf8').trim();
    if (!raw || !path.isAbsolute(raw)) return '';
    const stat = fs.statSync(raw);
    return stat.isDirectory() ? raw : '';
  } catch {
    return '';
  }
}

function resolveDataDir() {
  return customDataDir() || path.join(app.getPath('userData'), 'data');
}
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
  const dataDir = resolveDataDir();
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
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
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

ipcMain.handle('pick-folder', async (_event, startPath) => {
  const options = {
    title: '选择文件夹',
    properties: ['openDirectory', 'createDirectory']
  };
  const start = typeof startPath === 'string' ? startPath.trim() : '';
  if (start) options.defaultPath = start;
  const result = await dialog.showOpenDialog(win, options);
  if (result.canceled) return '';
  return result.filePaths[0] || '';
});

ipcMain.handle('pick-share-file', async () => {
  const result = await dialog.showOpenDialog(win, {
    title: '选择要共享的文件',
    properties: ['openFile']
  });
  if (result.canceled) return '';
  return result.filePaths[0] || '';
});

ipcMain.handle('change-data-dir', async () => {
  const current = resolveDataDir();
  const result = await dialog.showOpenDialog(win, {
    title: '选择新的数据目录',
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: path.dirname(current)
  });
  if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
  const target = path.resolve(result.filePaths[0]);
  if (target === path.resolve(current)) return { ok: false, error: '新目录与当前数据目录相同' };
  const entries = await fsp.readdir(target).catch(() => null);
  if (entries && entries.length) return { ok: false, error: '请选择空文件夹，避免与已有数据混在一起' };
  try {
    await fsp.mkdir(target, { recursive: true });
    if (fs.existsSync(current)) {
      await fsp.cp(current, target, { recursive: true, force: true });
    }
    const pointer = path.join(app.getPath('userData'), DATA_POINTER);
    await fsp.mkdir(path.dirname(pointer), { recursive: true });
    await fsp.writeFile(pointer, target, 'utf8');
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
  setTimeout(() => {
    app.relaunch();
    app.exit(0);
  }, 500);
  return { ok: true, dataDir: target };
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

app.setAppUserModelId('com.asen.lanlink');

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
