'use strict';

(() => {
  const tokenMatch = location.pathname.match(/^\/u\/([0-9a-f]{32})/);
  const API = tokenMatch ? `/u/${tokenMatch[1]}/api` : null;

  const $ = (selector, root = document) => root.querySelector(selector);
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
  const MAX_FILES = 20000;
  const MAX_ROWS = 400;
  const FILE_WORKERS = 2;
  const CHUNK_WORKERS = 3;
  const FILE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3.5h7l4 4V20a1 1 0 01-1 1H7a1 1 0 01-1-1V4.5a1 1 0 011-1z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M14 3.5V8h4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>';
  const FOLDER_ICON = '<svg viewBox="0 0 16 16" shape-rendering="crispEdges" aria-hidden="true"><path d="M1 4h5v1H1zM1 5h1v7H1zM6 5h1v1H6zM7 5h7v1H7zM14 6h1v6h-1zM1 12h14v1H1zM10 8h4v1h-4z"/></svg>';
  const CHECK_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.6 4.6L19 7.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const CROSS_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

  const state = {
    info: null,
    mode: 'upload',
    sharePath: '',
    shareName: '',
    chunkSize: 4 * 1024 * 1024,
    deviceName: '',
    expiresAt: 0,
    localFiles: new Map(),
    picked: [],
    browseDir: '',
    batch: null,
    runtime: [],
    rowEls: new Map(),
    uploading: false,
    canceled: false,
    finished: false,
    filesTotal: 0,
    filesDone: 0,
    bytesTotal: 0,
    bytesDone: 0,
    startedAt: 0,
    speed: 0,
    speedSamples: null,
    speedTimer: null,
    pollTimer: null,
    controllers: new Set(),
    resultKind: null
  };

  class ApiError extends Error {
    constructor(message, status, data) {
      super(message || '请求失败');
      this.status = status || 0;
      this.data = data || null;
    }
  }

  function fmtBytes(n) {
    if (!Number.isFinite(n) || n < 0) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
  }

  function fmtDuration(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    if (total < 60) return `${total} 秒`;
    const min = Math.floor(total / 60);
    const sec = total % 60;
    if (min < 60) return `${min} 分 ${sec} 秒`;
    const hour = Math.floor(min / 60);
    return `${hour} 小时 ${min % 60} 分`;
  }

  function fmtExpiry(ts) {
    if (!ts) return '链接长期有效';
    try {
      return `链接有效至 ${new Date(ts).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
    } catch {
      return '链接有效期未知';
    }
  }

  function chunkLength(size, idx, chunkSize) {
    return Math.max(0, Math.min(chunkSize, size - idx * chunkSize));
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function api(pathname, { method = 'GET', body, headers = {}, signal } = {}) {
    if (!API) throw new ApiError('邀请链接无效', 404);
    const isBlob = body instanceof Blob;
    const res = await fetch(`${API}${pathname}`, {
      method,
      credentials: 'same-origin',
      headers: {
        ...(body !== undefined && !isBlob ? { 'Content-Type': 'application/json' } : {}),
        ...headers
      },
      body: body === undefined ? undefined : (isBlob ? body : JSON.stringify(body)),
      signal
    });
    const text = await res.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = { error: text }; }
    }
    if (!res.ok) {
      throw new ApiError(data && data.error ? data.error : `请求失败（${res.status}）`, res.status, data);
    }
    return data;
  }

  function showView(name) {
    $('#view-login').hidden = name !== 'login';
    $('#view-upload').hidden = name !== 'upload';
    $('#view-download').hidden = name !== 'download';
    const logged = name === 'upload' || name === 'download';
    $('#logout-btn').hidden = !logged;
    $('#mode-tabs').hidden = !logged;
    document.querySelectorAll('.mode-tab').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.mode === name);
    });
  }

  function showLogin(message) {
    abortAll();
    stopTimers();
    state.uploading = false;
    showView('login');
    const error = $('#login-error');
    if (message) {
      error.textContent = message;
      error.hidden = false;
    } else {
      error.hidden = true;
    }
    const input = $('#code-input');
    input.value = '';
    setTimeout(() => input.focus(), 60);
  }

  function showUploader(info) {
    state.info = info;
    state.deviceName = info.deviceName || '对方设备';
    state.chunkSize = info.chunkSize || state.chunkSize;
    state.expiresAt = info.expiresAt || 0;
    $('#host-name').textContent = state.deviceName;
    $('#expiry-text').textContent = fmtExpiry(state.expiresAt);
    const limits = [];
    if (info.maxFileBytes) limits.push(`单文件上限 ${fmtBytes(info.maxFileBytes)}`);
    if (info.maxBatchBytes) limits.push(`单批上限 ${fmtBytes(info.maxBatchBytes)}`);
    $('#selection-hint').textContent = limits.join(' · ');
    state.shareName = info.shareName || '';
    const downloadTab = $('#mode-download');
    if (downloadTab) downloadTab.hidden = !state.shareName;
    $('#share-host').textContent = state.deviceName;
    if (state.shareName) $('#share-badge').textContent = state.shareName;
    showView('upload');
  }

  // 共享目录（只读下载）
  function shareFileUrl(rel) {
    return `${API}/share/file?path=${encodeURIComponent(rel)}`;
  }

  async function openShare(path) {
    state.mode = 'download';
    state.sharePath = path || '';
    showView('download');
    const list = $('#share-list');
    const error = $('#share-error');
    const empty = $('#share-empty');
    error.hidden = true;
    empty.hidden = true;
    list.innerHTML = '<li class="file-row"><span class="faint">正在读取…</span></li>';
    try {
      const data = await api(`/share/list?path=${encodeURIComponent(state.sharePath)}`);
      renderShare(data);
    } catch (err) {
      if (err.status === 401) {
        showLogin('会话已过期，请重新输入访问码');
        return;
      }
      list.innerHTML = '';
      error.textContent = err.message || '读取失败';
      error.hidden = false;
    }
  }

  function renderShare(data) {
    const list = $('#share-list');
    const crumb = $('#share-crumb');
    const empty = $('#share-empty');
    if (data.kind === 'file') {
      crumb.textContent = `单个文件 · ${data.entries[0] ? data.entries[0].name : ''}`;
    } else {
      crumb.textContent = data.path ? `全部文件 / ${data.path.split('/').join(' / ')}` : '全部文件';
    }
    const rows = [];
    if (data.path) {
      rows.push(`<li class="file-row nav-row"><button class="nav-btn" type="button" data-share-dir="${esc(data.parent)}"><span class="file-ico">${FOLDER_ICON}</span><span>..</span><span class="faint">返回上级目录</span></button></li>`);
    }
    for (const item of data.entries) {
      if (item.dir) {
        rows.push(`<li class="file-row nav-row"><button class="nav-btn" type="button" data-share-dir="${esc(item.path)}"><span class="file-ico">${FOLDER_ICON}</span><span class="share-name">${esc(item.name)}/</span></button></li>`);
      } else {
        rows.push(`<li class="file-row"><span class="file-ico">${FILE_ICON}</span><div class="share-meta"><span class="share-name">${esc(item.name)}</span><span class="share-size">${fmtBytes(item.size)}</span></div><a class="nes-btn share-dl" href="${shareFileUrl(item.path)}" download="${esc(item.name)}">下载</a></li>`);
      }
    }
    list.innerHTML = rows.join('');
    empty.hidden = data.entries.length > 0;
  }

  function showPickerPanel() {
    $('#picker-panel').hidden = false;
    $('#progress-panel').hidden = true;
    $('#result-panel').hidden = true;
  }

  function showProgressPanel() {
    $('#picker-panel').hidden = true;
    $('#progress-panel').hidden = false;
    $('#result-panel').hidden = true;
  }

  function showResultPanel(kind, title, message) {
    state.resultKind = kind;
    $('#picker-panel').hidden = true;
    $('#progress-panel').hidden = true;
    const panel = $('#result-panel');
    panel.hidden = false;
    panel.classList.toggle('failed', kind !== 'success');
    $('#result-icon').innerHTML = kind === 'success' ? CHECK_ICON : CROSS_ICON;
    $('#result-title').textContent = title;
    $('#result-sub').textContent = message;
    const again = $('#again-btn');
    again.textContent = kind === 'failed' && state.picked.length ? '重试上传' : '重新选择文件';
  }

  function pickerError(message) {
    const el = $('#picker-error');
    el.textContent = message || '';
    el.hidden = !message;
  }

  function abortAll() {
    for (const controller of state.controllers) {
      try { controller.abort(); } catch { /* noop */ }
    }
    state.controllers.clear();
  }

  function stopTimers() {
    if (state.speedTimer) clearInterval(state.speedTimer);
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.speedTimer = null;
    state.pollTimer = null;
  }

  function selectionItems() {
    return state.picked;
  }

  function addSelection(items) {
    pickerError('');
    if (!items.length) return;
    let skipped = 0;
    for (const item of items) {
      if (!item || !item.file) continue;
      let rel = String(item.path || item.file.webkitRelativePath || item.file.name || '').replace(/\\/g, '/').replace(/^\/+/, '');
      if (!rel) continue;
      if (state.localFiles.has(rel)) {
        skipped += 1;
        continue;
      }
      if (state.localFiles.size >= MAX_FILES) {
        pickerError(`最多一次上传 ${MAX_FILES} 个文件`);
        break;
      }
      state.localFiles.set(rel, item.file);
      state.picked.push({ rel, file: item.file });
    }
    state.picked.sort((a, b) => a.rel.localeCompare(b.rel, undefined, { numeric: true }));
    if (skipped) pickerError(`${skipped} 个重复路径已跳过`);
    renderSelection();
    const input = $('#file-input');
    const folderInput = $('#folder-input');
    input.value = '';
    folderInput.value = '';
  }

  function clearSelection() {
    state.localFiles.clear();
    state.picked = [];
    state.browseDir = '';
    pickerError('');
    renderSelection();
  }

  // ---------------------------------------------------------------------
  // 已选文件浏览：按目录层级展示，支持进入子目录、返回上级、移除单个文件
  // ---------------------------------------------------------------------

  function fileName(rel) {
    const idx = rel.lastIndexOf('/');
    return idx === -1 ? rel : rel.slice(idx + 1);
  }

  function dirName(path) {
    const idx = path.lastIndexOf('/');
    return idx === -1 ? '' : path.slice(0, idx);
  }

  // 汇总当前目录下的子目录与直接文件
  function listDir(dir) {
    const prefix = dir ? `${dir}/` : '';
    const dirs = new Map();
    const files = [];
    for (const item of state.picked) {
      if (!item.rel.startsWith(prefix)) continue;
      const rest = item.rel.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) {
        files.push({ item, name: rest });
        continue;
      }
      const name = rest.slice(0, slash);
      const child = dirs.get(name) || { name, path: `${prefix}${name}`, bytes: 0, files: 0 };
      child.bytes += item.file.size;
      child.files += 1;
      dirs.set(name, child);
    }
    const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true });
    return {
      dirs: [...dirs.values()].sort(byName),
      files: files.sort((a, b) => byName({ name: a.name }, { name: b.name }))
    };
  }

  function fileIconSpan(folder = false) {
    const icon = document.createElement('span');
    icon.className = folder ? 'file-ico is-folder' : 'file-ico';
    icon.innerHTML = folder ? FOLDER_ICON : FILE_ICON;
    return icon;
  }

  function buildParentRow() {
    const li = document.createElement('li');
    li.className = 'file-row nav-row';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'nav-btn';
    btn.dataset.dir = dirName(state.browseDir);
    const main = document.createElement('span');
    main.className = 'file-main';
    const name = document.createElement('strong');
    name.textContent = '..';
    const sub = document.createElement('span');
    sub.className = 'file-sub';
    sub.textContent = '返回上级目录';
    main.append(name, sub);
    btn.append(fileIconSpan(true), main);
    li.append(btn);
    return li;
  }

  function buildFolderRow(dir) {
    const li = document.createElement('li');
    li.className = 'file-row nav-row';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'nav-btn';
    btn.dataset.dir = dir.path;
    const main = document.createElement('span');
    main.className = 'file-main';
    const name = document.createElement('strong');
    name.textContent = `${dir.name}/`;
    const sub = document.createElement('span');
    sub.className = 'file-sub';
    sub.textContent = `${dir.files} 个文件 · ${fmtBytes(dir.bytes)}`;
    main.append(name, sub);
    const chev = document.createElement('span');
    chev.className = 'nav-chev';
    chev.textContent = '>';
    btn.append(fileIconSpan(true), main, chev);
    li.append(btn);
    return li;
  }

  function buildFileRow(entry) {
    const li = document.createElement('li');
    li.className = 'file-row';
    const main = document.createElement('div');
    main.className = 'file-main';
    const name = document.createElement('strong');
    name.textContent = entry.name;
    const sub = document.createElement('span');
    sub.className = 'file-sub';
    sub.textContent = fmtBytes(entry.item.file.size);
    main.append(name, sub);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'nes-btn file-remove';
    remove.dataset.remove = entry.item.rel;
    remove.textContent = '移除';
    remove.setAttribute('aria-label', `移除 ${entry.name}`);
    li.append(fileIconSpan(false), main, remove);
    return li;
  }

  function renderSelection() {
    const selection = $('#selection');
    const list = $('#selection-list');
    if (!state.picked.length) {
      selection.hidden = true;
      $('#dropzone').hidden = false;
      $('#selection-count').textContent = '';
      $('#selection-size').textContent = '';
      state.browseDir = '';
      list.replaceChildren();
      return;
    }
    $('#dropzone').hidden = true;
    selection.hidden = false;

    // 目录被删空时自动回到根
    if (state.browseDir && !state.picked.some((p) => p.rel.startsWith(`${state.browseDir}/`))) {
      state.browseDir = '';
    }

    const total = state.picked.reduce((sum, p) => sum + p.file.size, 0);
    $('#selection-count').textContent = `${state.picked.length} 个文件`;
    $('#selection-size').textContent = fmtBytes(total);
    $('#browse-crumb').textContent = state.browseDir
      ? `全部文件 / ${state.browseDir.split('/').join(' / ')}`
      : '全部文件';

    const { dirs, files } = listDir(state.browseDir);
    const fragment = document.createDocumentFragment();
    if (state.browseDir) fragment.append(buildParentRow());
    for (const dir of dirs) fragment.append(buildFolderRow(dir));
    const room = Math.max(0, MAX_ROWS - dirs.length - (state.browseDir ? 1 : 0));
    for (const file of files.slice(0, room)) fragment.append(buildFileRow(file));
    const hidden = files.length - Math.min(files.length, room);
    if (hidden > 0) {
      const li = document.createElement('li');
      li.className = 'file-row';
      const main = document.createElement('div');
      main.className = 'file-main';
      const name = document.createElement('strong');
      name.textContent = `还有 ${hidden} 个文件`;
      const sub = document.createElement('span');
      sub.className = 'file-sub';
      sub.textContent = '当前目录只展示前 400 项，全部文件都会上传';
      main.append(name, sub);
      li.append(main);
      fragment.append(li);
    }
    list.replaceChildren(fragment);
  }

  function removePicked(rel) {
    const index = state.picked.findIndex((item) => item.rel === rel);
    if (index === -1) return;
    state.localFiles.delete(rel);
    state.picked.splice(index, 1);
    pickerError('');
    renderSelection();
  }

  async function walkEntry(entry, prefix) {
    if (!entry) return [];
    if (entry.isFile) {
      try {
        const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
        return [{ file, path: prefix + file.name }];
      } catch {
        return [];
      }
    }
    if (entry.isDirectory) {
      const reader = entry.createReader ? entry.createReader() : null;
      if (!reader) return [];
      const children = [];
      for (;;) {
        let batch;
        try {
          batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
        } catch {
          break;
        }
        if (!batch || !batch.length) break;
        children.push(...batch);
      }
      const out = [];
      const base = prefix + entry.name + '/';
      for (const child of children) {
        out.push(...await walkEntry(child, base));
        if (out.length >= MAX_FILES) break;
      }
      return out;
    }
    return [];
  }

  async function itemsFromDataTransfer(dt) {
    const entries = [];
    const plain = [];
    if (dt.items && dt.items.length) {
      for (const item of dt.items) {
        if (item.kind !== 'file') continue;
        const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
        if (entry) entries.push(entry);
        else {
          const file = item.getAsFile ? item.getAsFile() : null;
          if (file) plain.push({ file, path: file.name });
        }
      }
    }
    if (!entries.length && !plain.length && dt.files) {
      for (const file of dt.files) plain.push({ file, path: file.name });
    }
    const out = plain.slice();
    for (const entry of entries) {
      out.push(...await walkEntry(entry, ''));
      if (out.length >= MAX_FILES) break;
    }
    return out;
  }

  function validateSelection() {
    if (!state.picked.length) return '请先选择文件';
    if (state.picked.length > MAX_FILES) return `最多一次上传 ${MAX_FILES} 个文件`;
    const maxFile = state.info && state.info.maxFileBytes ? state.info.maxFileBytes : 0;
    const maxBatch = state.info && state.info.maxBatchBytes ? state.info.maxBatchBytes : 0;
    let total = 0;
    for (const item of state.picked) {
      if (maxFile && item.file.size > maxFile) {
        return `“${item.rel}”超过单文件上限 ${fmtBytes(maxFile)}`;
      }
      total += item.file.size;
    }
    if (maxBatch && total > maxBatch) {
      return `本批文件总量 ${fmtBytes(total)} 超过上限 ${fmtBytes(maxBatch)}`;
    }
    return '';
  }

  function deriveLabel(files) {
    if (!files.length) return '访客上传';
    const tops = new Set(files.map((f) => f.path.split('/')[0]));
    if (tops.size === 1) return [...tops][0];
    if (files.length === 1) return files[0].path.split('/').pop();
    return `访客上传（${files.length} 个文件）`;
  }

  function sumDoneBytes(file) {
    if (file.finished) return file.size;
    let sum = 0;
    for (const idx of file.doneSet) sum += chunkLength(file.size, idx, state.chunkSize);
    return sum;
  }

  function resetProgressState() {
    state.batch = null;
    state.runtime = [];
    state.rowEls.clear();
    state.filesTotal = 0;
    state.filesDone = 0;
    state.bytesTotal = 0;
    state.bytesDone = 0;
    state.speed = 0;
    state.speedSamples = null;
    state.canceled = false;
    state.finished = false;
    state.resultKind = null;
    $('#upload-list').textContent = '';
    $('#overall-bar').style.width = '0%';
    $('#pct').textContent = '0%';
    $('#progress-sub').textContent = '';
    $('#speed').textContent = '—';
    $('#eta').textContent = '';
    $('#files-meta').textContent = '';
    $('#bytes-meta').textContent = '';
  }

  async function startUpload() {
    if (state.uploading) return;
    const problem = validateSelection();
    if (problem) {
      pickerError(problem);
      return;
    }
    pickerError('');
    const startBtn = $('#start-btn');
    startBtn.disabled = true;
    startBtn.textContent = '正在准备…';
    resetProgressState();

    const files = state.picked.map((item) => ({
      path: item.rel,
      size: item.file.size,
      mtimeMs: Math.round(item.file.lastModified || 0)
    }));

    let response;
    try {
      response = await api('/batches', {
        method: 'POST',
        body: { label: deriveLabel(files), files }
      });
    } catch (err) {
      startBtn.disabled = false;
      startBtn.textContent = '开始上传';
      if (err.status === 401) return showLogin('登录已过期，请重新输入访问码');
      if (err.status === 410) return showLogin('访客链接已过期，请联系主机重新生成');
      pickerError(err.message);
      return;
    }
    startBtn.disabled = false;
    startBtn.textContent = '开始上传';

    state.batch = response.batch;
    state.chunkSize = response.chunkSize || state.chunkSize;
    state.filesTotal = response.batch.totalFiles;
    state.bytesTotal = response.batch.totalBytes;
    state.runtime = response.files.map((entry, index) => {
      const direct = state.localFiles.get(entry.path);
      const local = direct || (state.picked[index] && state.picked[index].file.size === entry.size
        ? state.picked[index].file
        : null);
      const doneSet = new Set(entry.done || []);
      return {
        id: entry.id,
        path: entry.path,
        size: entry.size,
        chunks: entry.chunks,
        doneSet,
        finished: Boolean(entry.finished),
        file: local,
        status: entry.finished ? 'done' : 'waiting',
        error: null
      };
    });
    for (const file of state.runtime) {
      if (file.finished) state.filesDone += 1;
      state.bytesDone += sumDoneBytes(file);
    }
    const missing = state.runtime.find((file) => !file.file);
    if (missing) {
      return failUpload('failed', '文件读取失败', `无法读取“${missing.path}”，请重新选择文件。`);
    }

    state.uploading = true;
    state.startedAt = Date.now();
    showProgressPanel();
    renderUploadList();
    updateProgressStats();
    startSpeedTimer();
    startPolling();

    if (response.batch.complete) {
      return finishSuccess();
    }
    try {
      await uploadAll();
    } catch (err) {
      if (err.status === 401) {
        return failUpload('failed', '登录已过期', '请重新输入访问码后继续上传。');
      }
      if (state.canceled || state.finished) return;
      failUpload('failed', '上传失败', err.message || '网络中断，请重试。');
    }
  }

  function renderUploadList() {
    const list = $('#upload-list');
    list.textContent = '';
    state.rowEls.clear();
    const fragment = document.createDocumentFragment();
    const shown = state.runtime.slice(0, MAX_ROWS);
    for (const file of shown) {
      const li = document.createElement('li');
      li.className = 'file-row';
      const icon = document.createElement('div');
      icon.className = 'file-ico';
      icon.innerHTML = FILE_ICON;
      const main = document.createElement('div');
      main.className = 'file-main';
      const line = document.createElement('div');
      line.className = 'file-line';
      const name = document.createElement('strong');
      name.textContent = file.path.split('/').pop();
      name.title = file.path;
      const status = document.createElement('span');
      status.className = 'file-state';
      status.textContent = '等待';
      line.append(name, status);
      const bar = document.createElement('div');
      bar.className = 'bar small';
      const fill = document.createElement('i');
      bar.append(fill);
      const sub = document.createElement('span');
      sub.className = 'file-sub';
      sub.textContent = `${file.path} · ${fmtBytes(file.size)}`;
      main.append(line, bar, sub);
      li.append(icon, main);
      fragment.append(li);
      state.rowEls.set(file.id, { li, status, fill, sub, bar });
    }
    if (state.runtime.length > shown.length) {
      const li = document.createElement('li');
      li.className = 'file-row';
      const main = document.createElement('div');
      main.className = 'file-main';
      const name = document.createElement('strong');
      name.textContent = `其余 ${state.runtime.length - shown.length} 个文件`;
      const sub = document.createElement('span');
      sub.className = 'file-sub';
      sub.textContent = '只展示前 400 个文件的进度，全部文件都会上传';
      main.append(name, sub);
      li.append(main);
      fragment.append(li);
    }
    list.replaceChildren(fragment);
    for (const file of state.runtime) updateRow(file);
  }

  function updateRow(file) {
    const row = state.rowEls.get(file.id);
    if (!row) return;
    const doneBytes = sumDoneBytes(file);
    const pct = file.size > 0 ? Math.min(1, doneBytes / file.size) : (file.finished ? 1 : 0);
    row.fill.style.width = `${(pct * 100).toFixed(1)}%`;
    row.li.classList.toggle('done', file.status === 'done');
    row.li.classList.toggle('failed', file.status === 'failed');
    if (file.status === 'done') {
      row.status.textContent = '已完成';
      row.status.className = 'file-state ok';
      row.sub.textContent = `${file.path} · ${fmtBytes(file.size)}`;
    } else if (file.status === 'failed') {
      row.status.textContent = '失败';
      row.status.className = 'file-state err';
      row.sub.textContent = file.error || `${file.path} · ${fmtBytes(file.size)}`;
    } else if (file.status === 'saving') {
      row.status.textContent = '保存中…';
      row.status.className = 'file-state';
      row.sub.textContent = `${file.path} · ${fmtBytes(file.size)}`;
    } else if (file.status === 'uploading') {
      row.status.textContent = `${Math.floor(pct * 100)}%`;
      row.status.className = 'file-state';
      row.sub.textContent = `${fmtBytes(doneBytes)} / ${fmtBytes(file.size)}`;
    } else {
      row.status.textContent = file.doneSet.size ? '待继续' : '等待';
      row.status.className = 'file-state';
      row.sub.textContent = `${file.path} · ${fmtBytes(file.size)}`;
    }
  }

  function updateProgressStats() {
    const pct = state.bytesTotal > 0
      ? Math.min(1, state.bytesDone / state.bytesTotal)
      : (state.filesTotal > 0 && state.filesDone >= state.filesTotal ? 1 : 0);
    $('#overall-bar').style.width = `${(pct * 100).toFixed(1)}%`;
    $('#pct').textContent = `${Math.floor(pct * 100)}%`;
    $('#progress-sub').textContent = state.filesTotal
      ? `已完成 ${state.filesDone}/${state.filesTotal} 个文件`
      : '';
    $('#files-meta').textContent = state.filesTotal ? `${state.filesDone}/${state.filesTotal} 个文件` : '';
    $('#bytes-meta').textContent = `${fmtBytes(state.bytesDone)} / ${fmtBytes(state.bytesTotal)}`;
    $('#speed').textContent = state.speed > 0 ? `${fmtBytes(state.speed)}/s` : '—';
    const remain = Math.max(0, state.bytesTotal - state.bytesDone);
    if (state.speed > 0 && remain > 0 && state.uploading) {
      $('#eta').textContent = `剩余约 ${fmtDuration((remain / state.speed) * 1000)}`;
    } else if (state.uploading) {
      $('#eta').textContent = state.filesDone < state.filesTotal ? '正在计算剩余时间…' : '';
    } else {
      $('#eta').textContent = '';
    }
  }

  function startSpeedTimer() {
    if (state.speedTimer) clearInterval(state.speedTimer);
    state.speedSamples = { at: performance.now(), bytes: state.bytesDone };
    state.speedTimer = setInterval(() => {
      if (!state.uploading) return;
      const now = performance.now();
      const dt = (now - state.speedSamples.at) / 1000;
      if (dt < 0.2) return;
      const delta = Math.max(0, state.bytesDone - state.speedSamples.bytes);
      const instant = delta / dt;
      state.speed = state.speed > 0 ? state.speed * 0.55 + instant * 0.45 : instant;
      state.speedSamples = { at: now, bytes: state.bytesDone };
      updateProgressStats();
    }, 600);
  }

  function startPolling() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = setInterval(async () => {
      if (!state.uploading || !state.batch) return;
      try {
        const status = await api(`/batches/${state.batch.id}`);
        if (!state.uploading) return;
        if (status.status === 'canceled') {
          failUpload('failed', '主机已取消上传', status.error || '主机取消了这次上传。已上传的部分会保留。');
        } else if (status.status === 'failed') {
          failUpload('failed', '主机无法继续接收', status.error || '主机报告上传失败。');
        }
      } catch (err) {
        if (err.status === 404) {
          failUpload('failed', '上传任务已结束', '主机上的上传任务已结束，请重新选择文件上传。');
        } else if (err.status === 401) {
          failUpload('failed', '登录已过期', '请重新输入访问码后继续上传。');
        }
      }
    }, 2500);
  }

  async function uploadAll() {
    const queue = state.runtime.filter((file) => !file.finished);
    const workers = Math.min(FILE_WORKERS, queue.length || 1);
    await Promise.all(Array.from({ length: workers }, () => fileWorker(queue)));
    if (state.canceled || state.finished) return;
    const result = await api(`/batches/${state.batch.id}/finish`, { method: 'POST' });
    if (result && result.complete) return finishSuccess();
    if (state.canceled || state.finished) return;
    throw new ApiError('仍有文件尚未完成，请重试', 500);
  }

  async function fileWorker(queue) {
    while (!state.canceled && !state.finished) {
      const file = queue.shift();
      if (!file) return;
      if (file.finished) continue;
      file.status = 'uploading';
      updateRow(file);
      try {
        await uploadFile(file);
      } catch (err) {
        if (state.canceled || state.finished) return;
        file.status = 'failed';
        file.error = err.message;
        updateRow(file);
        if (err.status === 401) throw err;
        throw err;
      }
      if (state.canceled || state.finished) return;
      file.status = 'saving';
      updateRow(file);
      const fin = await api(`/batches/${state.batch.id}/files/${file.id}/finish`, { method: 'POST' });
      file.finished = true;
      file.status = 'done';
      state.filesDone = state.runtime.filter((f) => f.finished).length;
      updateRow(file);
      updateProgressStats();
      if (fin && fin.complete) {
        finishSuccess();
        return;
      }
    }
  }

  async function uploadFile(file) {
    const missing = [];
    for (let idx = 0; idx < file.chunks; idx++) {
      if (!file.doneSet.has(idx)) missing.push(idx);
    }
    let cursor = 0;
    const workerCount = Math.min(CHUNK_WORKERS, missing.length || 1);
    const workers = Array.from({ length: workerCount }, async () => {
      while (!state.canceled && !state.finished) {
        const idx = missing[cursor++];
        if (idx === undefined) return;
        const start = idx * state.chunkSize;
        const end = Math.min(file.size, start + state.chunkSize);
        const blob = file.file.slice(start, end);
        await putChunk(file, idx, blob);
        file.doneSet.add(idx);
        state.bytesDone += blob.size;
        updateRow(file);
        updateProgressStats();
      }
    });
    await Promise.all(workers);
  }

  async function putChunk(file, idx, blob) {
    let attempt = 0;
    for (;;) {
      if (state.canceled || state.finished) throw new ApiError('已取消', 0);
      const controller = new AbortController();
      state.controllers.add(controller);
      try {
        await api(`/batches/${state.batch.id}/files/${file.id}/chunks/${idx}`, {
          method: 'PUT',
          body: blob,
          headers: { 'Content-Type': 'application/octet-stream' },
          signal: controller.signal
        });
        return;
      } catch (err) {
        if (state.canceled || state.finished) throw err;
        if (err.status === 401 || err.status === 409 || err.status === 410 || err.status === 413) throw err;
        if (err.status === 404) throw new ApiError('上传任务已结束', 404);
        attempt += 1;
        if (attempt > 4) throw new ApiError(`分块 ${idx + 1} 上传失败：${err.message}`, err.status || 0);
        await delay(350 * 2 ** (attempt - 1));
      } finally {
        state.controllers.delete(controller);
      }
    }
  }

  function finishSuccess() {
    if (!state.uploading && state.finished) return;
    state.uploading = false;
    state.finished = true;
    stopTimers();
    state.bytesDone = state.bytesTotal;
    state.filesDone = state.filesTotal;
    state.speed = 0;
    updateProgressStats();
    const elapsed = state.startedAt ? Date.now() - state.startedAt : 0;
    const summary = `${state.filesTotal} 个文件 · ${fmtBytes(state.bytesTotal)}${elapsed ? ` · 用时 ${fmtDuration(elapsed)}` : ''}`;
    showResultPanel('success', '上传完成', `${summary}。文件已保存到 ${state.deviceName} 的“访客上传”目录。`);
    state.batch = null;
  }

  function failUpload(kind, title, message) {
    if (state.finished) return;
    if (!state.uploading && state.resultKind) return;
    const wasUploading = state.uploading;
    state.uploading = false;
    state.canceled = true;
    abortAll();
    stopTimers();
    if (wasUploading && state.batch) {
      api(`/batches/${state.batch.id}/cancel`, { method: 'POST' }).catch(() => {});
    }
    showResultPanel(kind, title, message);
  }

  function cancelUpload() {
    if (!state.uploading) return;
    state.uploading = false;
    state.canceled = true;
    abortAll();
    stopTimers();
    if (state.batch) {
      api(`/batches/${state.batch.id}/cancel`, { method: 'POST' }).catch(() => {});
    }
    showResultPanel('canceled', '已取消上传', '已上传的部分会保留在主机，重新选择相同文件可以继续。');
  }

  async function retryUpload() {
    if (state.batch) {
      try { await api(`/batches/${state.batch.id}/cancel`, { method: 'POST' }); } catch { /* ignore */ }
    }
    resetProgressState();
    showPickerPanel();
    await startUpload();
  }

  function resetToPicker() {
    resetProgressState();
    clearSelection();
    showPickerPanel();
    const startBtn = $('#start-btn');
    startBtn.disabled = false;
    startBtn.textContent = '开始上传';
  }

  async function loadInfo() {
    const info = await api('/info');
    showUploader(info);
  }

  function bindEvents() {
    $('#code-input').addEventListener('input', (event) => {
      const digits = event.target.value.replace(/\D/g, '').slice(0, 6);
      if (event.target.value !== digits) event.target.value = digits;
    });

    $('#login-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const code = $('#code-input').value.trim();
      const error = $('#login-error');
      if (!/^\d{6}$/.test(code)) {
        error.textContent = '请输入 6 位数字访问码';
        error.hidden = false;
        return;
      }
      const button = $('#login-btn');
      button.disabled = true;
      button.textContent = '正在验证…';
      error.hidden = true;
      try {
        const res = await fetch(`${API}/login`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code })
        });
        let data = {};
        try { data = await res.json(); } catch { /* noop */ }
        if (!res.ok) {
          if (res.status === 410) {
            showLogin('访客链接已过期，请联系主机重新生成邀请链接。');
            return;
          }
          throw new ApiError(data.error || (res.status === 403 ? '访问码不正确' : `验证失败（${res.status}）`), res.status);
        }
        await loadInfo();
        resetToPicker();
        $('#logout-btn').hidden = false;
      } catch (err) {
        error.textContent = err.message || '验证失败，请重试';
        error.hidden = false;
        $('#code-input').select();
      } finally {
        button.disabled = false;
        button.textContent = '进入上传页';
      }
    });

    $('#logout-btn').addEventListener('click', async () => {
      if (state.uploading) await cancelUpload();
      try { await api('/logout', { method: 'POST' }); } catch { /* ignore */ }
      resetToPicker();
      showLogin();
    });

    $('#pick-files-btn').addEventListener('click', () => $('#file-input').click());
    $('#pick-folder-btn').addEventListener('click', () => $('#folder-input').click());
    $('#file-input').addEventListener('change', (event) => {
      const items = Array.from(event.target.files || []).map((file) => ({ file, path: file.webkitRelativePath || file.name }));
      addSelection(items);
    });
    $('#folder-input').addEventListener('change', (event) => {
      const items = Array.from(event.target.files || []).map((file) => ({ file, path: file.webkitRelativePath || file.name }));
      addSelection(items);
    });

    const drop = $('#dropzone');
    let dragDepth = 0;
    drop.addEventListener('dragenter', (event) => {
      event.preventDefault();
      dragDepth += 1;
      drop.classList.add('dragover');
    });
    drop.addEventListener('dragover', (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    });
    drop.addEventListener('dragleave', (event) => {
      event.preventDefault();
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) drop.classList.remove('dragover');
    });
    drop.addEventListener('drop', async (event) => {
      event.preventDefault();
      dragDepth = 0;
      drop.classList.remove('dragover');
      if (!event.dataTransfer) return;
      try {
        const items = await itemsFromDataTransfer(event.dataTransfer);
        if (!items.length) {
          pickerError('没有读取到文件，请使用“选择文件”按钮');
          return;
        }
        addSelection(items);
      } catch {
        pickerError('读取拖入的文件失败，请改用“选择文件”按钮');
      }
    });

    $('#clear-selection').addEventListener('click', () => {
      clearSelection();
      $('#file-input').value = '';
      $('#folder-input').value = '';
    });

    // 选择列表：进入目录 / 返回上级 / 移除单个文件
    $('#selection-list').addEventListener('click', (event) => {
      const removeBtn = event.target.closest('[data-remove]');
      if (removeBtn) {
        removePicked(removeBtn.dataset.remove);
        return;
      }
      const navBtn = event.target.closest('[data-dir]');
      if (navBtn) {
        state.browseDir = navBtn.dataset.dir || '';
        renderSelection();
      }
    });

    // 上传 / 下载切换 + 下载列表
    document.querySelectorAll('.mode-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.dataset.mode === 'download') {
          openShare(state.sharePath || '');
        } else {
          showView('upload');
        }
      });
    });
    $('#share-refresh').addEventListener('click', () => openShare(state.sharePath || ''));
    $('#share-list').addEventListener('click', (event) => {
      const navBtn = event.target.closest('[data-share-dir]');
      if (navBtn) openShare(navBtn.dataset.shareDir || '');
    });

    // 右下角「添加文件 / 文件夹」菜单
    const addBtn = $('#add-more-btn');
    const addList = $('#add-menu-list');
    const closeAddMenu = () => {
      addList.hidden = true;
      addBtn.setAttribute('aria-expanded', 'false');
    };
    addBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      const willOpen = addList.hidden;
      addList.hidden = !willOpen;
      addBtn.setAttribute('aria-expanded', String(willOpen));
    });
    addList.addEventListener('click', (event) => {
      const choice = event.target.closest('[data-add]');
      if (!choice) return;
      closeAddMenu();
      (choice.dataset.add === 'folder' ? $('#folder-input') : $('#file-input')).click();
    });
    document.addEventListener('click', (event) => {
      if (!addList.hidden && !event.target.closest('#add-menu')) closeAddMenu();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeAddMenu();
    });
    $('#start-btn').addEventListener('click', () => {
      startUpload();
    });
    $('#cancel-btn').addEventListener('click', () => {
      cancelUpload();
    });
    $('#again-btn').addEventListener('click', () => {
      if (state.resultKind === 'failed' && state.picked.length) retryUpload();
      else resetToPicker();
    });

    window.addEventListener('beforeunload', (event) => {
      if (!state.uploading) return;
      event.preventDefault();
      event.returnValue = '';
    });
    window.addEventListener('pagehide', () => {
      if (!state.uploading || !state.batch) return;
      try {
        navigator.sendBeacon(`${API}/batches/${state.batch.id}/cancel`);
      } catch { /* ignore */ }
    });
  }

  async function init() {
    if (!API) {
      document.body.textContent = '邀请链接无效或已失效';
      return;
    }
    bindEvents();
    try {
      await loadInfo();
      $('#logout-btn').hidden = false;
    } catch (err) {
      if (err.status === 401) {
        showLogin();
      } else if (err.status === 410) {
        showLogin('访客链接已过期，请联系主机重新生成邀请链接。');
      } else {
        showLogin(err.message || '无法连接到主机，请确认仍在同一局域网。');
      }
    }
  }

  init();
})();
