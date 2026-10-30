'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const desktop = window.lanlinkDesktop || null;

const ACTIVE_STATUSES = new Set(['preparing', 'pairing', 'waiting', 'starting', 'transferring', 'finishing']);
const STATUS_LABEL = {
  preparing: '正在校验文件',
  pairing: '等待配对',
  waiting: '等待对方接受',
  starting: '正在准备',
  transferring: '传输中',
  finishing: '正在完成',
  completed: '已完成',
  failed: '失败',
  canceled: '已取消'
};
const STATUS_TAG = {
  preparing: 'active',
  pairing: 'active',
  waiting: 'active',
  starting: 'active',
  transferring: 'active',
  finishing: 'active',
  completed: 'done',
  failed: 'error',
  canceled: ''
};
const VIEW_META = {
  devices: ['设备', '在同一局域网内发现设备并直接发送文件'],
  transfers: ['传输', '实时查看收发进度、速度与剩余时间'],
  history: ['历史', '最近 100 条传输记录保存在本机'],
  settings: ['设置', '设备身份、接收位置与网络选项']
};

const modalRoot = $('#modal-root');
const toastsRoot = $('#toasts');

let state = null;
let view = 'devices';
let settingsDirty = false;
let requireCodePending = false;
let currentModal = null;
let pickerResolve = null;
let confirmResolve = null;
let dirPickerResolve = null;
let dirPickerPath = '';
let dirPickerParent = null;
let dirPickerValid = false;
let dirPickerSeq = 0;
let pathsPeer = null;
let lastStateAt = 0;
let eventSource = null;

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[ch]);
}

function fmtBytes(n) {
  const value = Number(n);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let idx = 0;
  let size = value;
  while (size >= 1024 && idx < units.length - 1) {
    size /= 1024;
    idx++;
  }
  return `${size >= 100 || idx === 0 ? Math.round(size) : size.toFixed(1)} ${units[idx]}`;
}

function fmtSpeed(n) {
  const value = Number(n);
  return value > 0 ? `${fmtBytes(value)}/s` : '—';
}

function fmtEta(sec) {
  const value = Math.round(Number(sec) || 0);
  if (value <= 0) return '';
  if (value < 60) return `${value} 秒`;
  if (value < 3600) return `${Math.floor(value / 60)} 分 ${value % 60} 秒`;
  return `${Math.floor(value / 3600)} 小时 ${Math.floor((value % 3600) / 60)} 分`;
}

const dateFmt = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
});

function fmtTime(ts) {
  if (!ts) return '—';
  try { return dateFmt.format(new Date(ts)); } catch { return '—'; }
}

function relTime(ts) {
  if (!ts) return '从未';
  const diff = Math.max(0, Date.now() - ts);
  if (diff < 8000) return '刚刚';
  if (diff < 60000) return `${Math.floor(diff / 1000)} 秒前`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  return `${Math.floor(diff / 3600000)} 小时前`;
}

function shortFp(fp) {
  const value = String(fp || '');
  return value ? `${value.slice(0, 16)}…` : '—';
}

function initialOf(name) {
  const chars = [...String(name || 'L').trim()];
  return (chars[0] || 'L').toUpperCase();
}

function avatarVariant(seed) {
  const value = String(seed || '');
  let hash = 0;
  for (let i = 0; i < value.length; i++) hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  return ['', 'green', 'warm', 'violet', 'rose'][hash % 5];
}

function avatarHtml(seed, name, cls = '') {
  return `<div class="avatar ${avatarVariant(seed)} ${cls}">${esc(initialOf(name))}</div>`;
}

function statusLabel(t) {
  return STATUS_LABEL[t.status] || t.status;
}

function toast(message, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = String(message);
  toastsRoot.appendChild(el);
  while (toastsRoot.children.length > 5) toastsRoot.firstElementChild.remove();
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 220);
  }, 4200);
}

async function api(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  let data = {};
  try { data = await res.json(); } catch { /* noop */ }
  if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
  return data;
}

function applyState(next) {
  if (!next || !next.device || !next.settings) return;
  state = next;
  lastStateAt = Date.now();
  renderDevice();
  renderGuest();
  renderPeers();
  renderTransfers();
  renderHistory();
  renderSettings();
  updateStatus();
  syncModals();
}

function updateStatus() {
  const pill = $('#status-pill');
  if (!state) return;
  pill.classList.add('online');
  const discovery = state.settings.discoveryEnabled ? '自动发现' : '仅手动连接';
  $('#listen-status').textContent = `监听 :${state.device.tcpPort} · ${discovery}`;
}

function setConnecting() {
  const pill = $('#status-pill');
  pill.classList.remove('online');
  $('#listen-status').textContent = '连接已断开，正在重新连接…';
}

function renderDevice() {
  const device = state.device;
  const avatar = $('#me-avatar');
  avatar.textContent = initialOf(device.name);
  avatar.className = `avatar ${avatarVariant(device.id)}`;
  $('#me-name').textContent = device.name || '本机';
  $('#me-id').textContent = `ID ${String(device.id || '').slice(0, 12)}`;
  if ($('#me-port')) $('#me-port').textContent = String(device.tcpPort ?? '—');
  if ($('#me-fingerprint')) $('#me-fingerprint').textContent = shortFp(device.fingerprint);
  $('#hero-tcp-port').textContent = String(device.tcpPort ?? '—');
  const online = state.peers.filter((p) => p.online).length;
  $('#hero-device-count').textContent = String(online);
  $('#nav-devices-count').textContent = online ? String(online) : '';
  const active = state.transfers.filter((t) => ACTIVE_STATUSES.has(t.status)).length;
  $('#nav-transfers-count').textContent = active ? String(active) : '';
}

function renderGuest() {
  const guest = state.guest || {};
  const enabled = Boolean(guest.enabled);
  const running = Boolean(guest.running);
  const panel = $('#guest-panel');
  if (!panel) return;

  panel.classList.toggle('enabled', enabled && running);
  panel.classList.toggle('error', enabled && !running);

  const stateLabel = $('#guest-state');
  stateLabel.textContent = !enabled ? '未开启' : running ? '运行中' : '启动失败';
  stateLabel.className = `guest-state ${!enabled ? '' : running ? 'on' : 'error'}`;

  $('#guest-desc').textContent = !enabled
    ? '对方无需安装 LanLink，用浏览器打开链接并输入访问码即可把文件上传到本机。'
    : running
      ? `访客可在同一局域网内浏览器上传，文件保存到 ${guest.inbox || '接收目录'}。`
      : (guest.error || '访客服务未能启动，请检查端口是否被占用。');

  const urls = Array.isArray(guest.urls) ? guest.urls : [];
  const primary = enabled && running ? urls[0] || '' : '';
  $('#guest-cred').hidden = !primary;
  $('#guest-url').textContent = primary || '—';
  $('#guest-code').textContent = guest.code || '------';
  $('#guest-expiry').textContent = !enabled
    ? ''
    : guest.expiresAt
      ? `有效至 ${fmtTime(guest.expiresAt)}`
      : '长期有效';

  const toggle = $('#guest-toggle-btn');
  toggle.textContent = enabled ? '关闭访客上传' : '开启访客上传';
    toggle.classList.toggle('is-primary', !enabled);
  $('#guest-rotate-btn').hidden = !enabled;

  $('#set-guest-inbox').textContent = guest.inbox || '—';
  $('#set-guest-urls').innerHTML = primary
    ? urls.map((url) => `<div class="guest-url-row"><code>${esc(url)}</code><button class="nes-btn" data-action="guest-copy-url" data-url="${esc(url)}">复制</button></div>`).join('')
    : `<span class="muted">${enabled ? esc(guest.error || '服务未运行') : '开启后在这里显示可用地址'}</span>`;

  // 地址多于 3 条时，列表内部滚动，这里补一句说明
  const more = $('#set-guest-urls-more');
  if (more) {
    more.hidden = !primary || urls.length <= 3;
    more.textContent = urls.length > 3 ? `共 ${urls.length} 个可用地址，列表可滚动查看` : '';
  }
}

function renderPeers() {
  const grid = $('#peer-grid');
  const peers = state.peers || [];
  const online = peers.filter((p) => p.online).length;
  const trusted = peers.filter((p) => p.trusted).length;
  const connected = peers.filter((p) => p.connected).length;

  $('#peers-count').textContent = peers.length
    ? `${online} 台在线 · ${trusted} 台已配对`
    : '搜索中…';
  $('#peer-empty').classList.toggle('show', peers.length === 0);

  const sig = JSON.stringify(peers) + state.autoTrust;
  if (grid.__sig === sig) return;
  grid.__sig = sig;

  grid.innerHTML = peers.map((peer) => {
    const isOnline = Boolean(peer.online);
    const paired = Boolean(peer.trusted);
    const live = Boolean(peer.connected);
    const dropped = peer.offlineAt && peer.offlineAt > (peer.lastSeen || 0);
    const offlineText = dropped ? '刚刚断开' : `离线 · ${relTime(peer.lastSeen)}`;
    const address = peer.host ? `${peer.host}${peer.tcpPort ? `:${peer.tcpPort}` : ''}` : '地址未知';
    const stateTag = live
      ? '<span class="tag info"><span class="dot connected"></span>已连接</span>'
      : isOnline
        ? '<span class="tag ok"><span class="dot online"></span>在线</span>'
        : '<span class="tag off"><span class="dot"></span>离线</span>';
    const disconnectBtn = (live || paired)
      ? `<button class="nes-btn" data-action="disconnect" data-peer="${esc(peer.id)}">断开</button>`
      : '';
    let actions = '';
    if (paired) {
      actions = `<button class="nes-btn is-primary" data-action="send" data-peer="${esc(peer.id)}" ${isOnline ? '' : 'disabled'}>发送文件</button>`;
      actions += disconnectBtn;
      if (!isOnline && peer.host) {
        actions += `<button class="nes-btn" data-action="pair" data-peer="${esc(peer.id)}">重连</button>`;
      }
    } else {
      actions = `<button class="nes-btn is-primary" data-action="pair" data-peer="${esc(peer.id)}" ${isOnline ? '' : 'disabled'}>配对</button>`;
      actions += disconnectBtn;
    }
    return `
      <article class="peer-card ${isOnline ? '' : 'offline'}">
        <div class="peer-head">
          ${avatarHtml(peer.id, peer.name)}
          <div class="peer-title">
            <strong>${esc(peer.name)}${paired ? '<span class="tag ok">已配对</span>' : ''}</strong>
            <span>${esc(address)}</span>
          </div>
        </div>
        <div class="peer-state">
          ${stateTag}
          <span class="faint">${isOnline ? '局域网可见' : offlineText}</span>
        </div>
        <div class="peer-meta">
          <span>设备 ID <code>${esc(String(peer.id).slice(0, 18))}</code></span>
          <span>指纹 <code>${esc(shortFp(peer.fingerprint))}</code></span>
        </div>
        <div class="peer-actions">${actions}</div>
      </article>`;
  }).join('');
}

function renderTransfers() {
  const list = state.transfers || [];
  const active = list.filter((t) => ACTIVE_STATUSES.has(t.status));
  $('#transfer-empty').classList.toggle('show', list.length === 0);

  const summary = $('#transfer-summary');
  const totalBytes = list.reduce((sum, t) => sum + (t.totalBytes || t.preparedTotal || 0), 0);
  const guestCount = list.filter((t) => t.guest).length;
  const summarySig = `${active.map((t) => t.id).join(',')}|${list.length}|${totalBytes}|${guestCount}`;
  if (summary.__sig !== summarySig) {
    summary.__sig = summarySig;
    if (list.length === 0) {
      summary.innerHTML = '';
    } else {
      summary.innerHTML = `
        <div class="summary-chip"><b>${active.length}</b> 个进行中</div>
        <div class="summary-chip">本批共 <b>${fmtBytes(totalBytes)}</b></div>
        ${guestCount ? `<div class="summary-chip">访客上传 <b>${guestCount}</b> 个</div>` : ''}
        ${guestCount < list.length ? '<div class="summary-chip">AES-256-GCM 加密通道</div>' : ''}`;
    }
  }

  const container = $('#transfer-list');
  const sig = JSON.stringify(list.map((t) => ({
    id: t.id, status: t.status, bytes: Math.round(t.bytes), total: t.totalBytes,
    prep: Math.round(t.preparedBytes || 0), prepTotal: t.preparedTotal,
    speed: t.speed, eta: t.eta, filesDone: t.filesDone, current: t.currentFile,
    error: t.error, label: t.rootLabel, guest: t.guest, ip: t.guestIp
  })));
  if (container.__sig === sig) return;
  container.__sig = sig;

  container.innerHTML = list.map((t) => {
    const incoming = t.direction === 'in';
    const isActive = ACTIVE_STATUSES.has(t.status);
    const indeterminate = ['preparing', 'pairing', 'waiting', 'starting'].includes(t.status) && !t.progress;
    const pct = Math.max(0, Math.min(100, Math.round((t.progress || 0) * 1000) / 10));
    const total = t.totalBytes || 0;
    const bytes = t.bytes || 0;
    const stats = [];
    if (t.status === 'preparing') {
      stats.push(`<span><b>${fmtBytes(t.preparedBytes || 0)}</b> / ${fmtBytes(t.preparedTotal || 0)}</span>`);
    } else {
      stats.push(`<span><b>${fmtBytes(bytes)}</b> / ${fmtBytes(total)}</span>`);
    }
    if (isActive && t.speed > 0) stats.push(`<span>${fmtSpeed(t.speed)}</span>`);
    if (isActive && t.eta > 0 && t.status === 'transferring') stats.push(`<span>剩余 ${fmtEta(t.eta)}</span>`);
    if (t.totalFiles > 0) stats.push(`<span>${t.filesDone || 0}/${t.totalFiles} 个文件</span>`);
    if (t.resumedBytes > 0) stats.push(`<span>续传 ${fmtBytes(t.resumedBytes)}</span>`);
    const tail = [];
    if (t.destDir && (t.status === 'completed' || t.direction === 'in')) {
      tail.push(`<button class="nes-btn" data-action="reveal" data-path="${esc(t.destDir)}">打开位置</button>`);
    }
    if (isActive) {
      tail.push(`<button class="nes-btn is-error" data-action="cancel" data-id="${esc(t.id)}">取消</button>`);
    }
    const peerName = (t.peer && t.peer.name) || '未知设备';
    const meta = `${incoming ? '来自' : '发送至'} ${esc(peerName)}${t.guestIp ? ` · ${esc(t.guestIp)}` : ''} · ${esc(t.rootLabel)}`;
    return `
      <article class="transfer-card ${incoming ? 'in' : ''} ${t.status === 'failed' ? 'failed' : ''}">
        <div class="transfer-top">
          <div class="dir-badge">${incoming
            ? '<svg viewBox="0 0 24 24"><path d="M12 4v11m0 0l-4-4m4 4l4-4M5 20h14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>'
            : '<svg viewBox="0 0 24 24"><path d="M12 20V9m0 0l-4 4m4-4l4 4M5 4h14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>'}</div>
          <div class="transfer-title">
            <strong>${esc(t.rootLabel)}${t.guest ? '<span class="tag info">访客</span>' : ''}</strong>
            <span>${meta}</span>
          </div>
          <span class="status-tag ${STATUS_TAG[t.status] || ''}">${esc(statusLabel(t))}</span>
        </div>
        ${indeterminate
          ? '<div class="progress-placeholder" aria-hidden="true"></div>'
          : `<progress class="nes-progress ${incoming ? 'is-success' : 'is-primary'}" value="${pct}" max="100" aria-label="传输进度 ${pct}%"></progress>`}
        <div class="transfer-stats">
          ${stats.join('')}
          <span class="spacer"></span>
          ${tail.join('')}
        </div>
        ${t.currentFile ? `<div class="transfer-current">${esc(t.currentFile)}</div>` : ''}
        ${t.error ? `<div class="transfer-error">${esc(t.error)}</div>` : ''}
      </article>`;
  }).join('');
}

function renderHistory() {
  const history = state.history || [];
  $('#history-count').textContent = history.length ? `${history.length} 条记录` : '';
  $('#history-empty').classList.toggle('show', history.length === 0);
  const clearBtn = $('#history-clear');
  if (clearBtn) clearBtn.hidden = history.length === 0;

  const container = $('#history-list');
  const sig = JSON.stringify(history.map((h) => [h.id, h.status, h.peer && h.peer.name, h.rootLabel, h.guest, h.guestIp]));
  if (container.__sig === sig) return;
  container.__sig = sig;

  container.innerHTML = history.map((h) => {
    const incoming = h.direction === 'in';
    const statusClass = h.status === 'completed' ? 'completed' : h.status === 'failed' ? 'failed' : h.status === 'canceled' ? 'canceled' : '';
    const statusText = h.status === 'completed' ? '已完成' : h.status === 'failed' ? '失败' : h.status === 'canceled' ? '已取消' : h.status;
    const revealTarget = h.status === 'completed' ? (h.destDir || h.srcPath || null) : null;
    const reveal = revealTarget
      ? `<button class="nes-btn" data-action="reveal" data-path="${esc(revealTarget)}" title="在资源管理器中打开位置">打开</button>`
      : '';
    const remove = `<button class="nes-btn" data-action="history-remove" data-id="${esc(h.id)}" title="删除这条记录">删除</button>`;
    return `
      <article class="history-item">
        <div class="history-icon">${incoming
          ? '<svg viewBox="0 0 24 24"><path d="M12 4v11m0 0l-4-4m4 4l4-4M5 20h14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>'
          : '<svg viewBox="0 0 24 24"><path d="M12 20V9m0 0l-4 4m4-4l4 4M5 4h14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>'}</div>
        <div class="history-main">
          <strong>${esc(h.rootLabel)}${h.guest ? '<span class="tag info">访客</span>' : ''}</strong>
          <span>${incoming ? '来自' : '发送至'} ${esc((h.peer && h.peer.name) || '未知设备')}${h.guestIp ? ` · ${esc(h.guestIp)}` : ''} · ${fmtBytes(h.totalBytes)} · ${fmtTime(h.endedAt)}${h.error ? ` · ${esc(h.error)}` : ''}</span>
        </div>
        <span class="history-status ${statusClass}">${esc(statusText)}</span>
        <div class="history-actions">${reveal}${remove}</div>
      </article>`;
  }).join('');
}

function renderSettings() {
  const s = state.settings;
  const d = state.device;
  const setText = (selector, value) => {
    const el = $(selector);
    if (el) el.textContent = value;
  };
  setText('#set-fingerprint', d.fingerprint || '');
  setText('#set-address', `TCP ${d.tcpPort} · 监听所有网卡`);
  setText('#set-data-dir', d.dataDir || '');
  setText('#set-tcp-port', String(d.tcpPort ?? '—'));
  setText('#set-udp-port', String(d.discoveryPort ?? '—'));

  if (settingsDirty) return;
  const nameInput = $('#set-name');
  if (document.activeElement !== nameInput) nameInput.value = s.deviceName || '';
  $('#set-download').value = s.downloadDir || '';
  $('#set-auto-accept').checked = Boolean(s.autoAccept);
  if (!requireCodePending) {
    $('#set-require-code').checked = s.requireCode !== false;
    $('#no-code-warning').hidden = s.requireCode !== false;
  }
  $('#set-archive').checked = Boolean(s.archiveEnabled);
  if (document.activeElement !== $('#set-ttl')) $('#set-ttl').value = String(s.partialTtlHours ?? 24);
  $('#set-discovery').checked = Boolean(s.discoveryEnabled);
  $('#set-guest-enabled').checked = Boolean(s.guestEnabled);
  const sharePath = s.guestShareDir || '';
  $('#set-guest-share').checked = Boolean(sharePath);
  const shareField = $('#set-guest-share-path');
  if (shareField && document.activeElement !== shareField) shareField.value = sharePath;
  if (document.activeElement !== $('#set-guest-port')) $('#set-guest-port').value = String(s.guestPort ?? 7420);
  if (document.activeElement !== $('#set-guest-expiry')) $('#set-guest-expiry').value = String(s.guestExpiryHours ?? 12);
  if (document.activeElement !== $('#set-guest-max-file')) $('#set-guest-max-file').value = String(s.guestMaxFileMB ?? 4096);
  if (document.activeElement !== $('#set-guest-max-batch')) $('#set-guest-max-batch').value = String(s.guestMaxBatchMB ?? 20480);
}

function switchView(next) {
  if (!VIEW_META[next]) return;
  view = next;
  $$('#nav .nav-item').forEach((btn) => btn.classList.toggle('active', btn.dataset.view === next));
  $$('.view').forEach((section) => section.classList.toggle('active', section.id === `view-${next}`));
  const [title, sub] = VIEW_META[next];
  $('#view-title').textContent = title;
  $('#view-sub').textContent = sub;
  if (next === 'devices' && state) renderPeers();
}

function openModal(type, key, html) {
  currentModal = { type, key };
  modalRoot.innerHTML = `<div class="modal-backdrop" data-backdrop="1"><div class="modal" role="dialog" aria-modal="true">${html}</div></div>`;
  const focusTarget = modalRoot.querySelector('[data-autofocus]');
  if (focusTarget) setTimeout(() => focusTarget.focus(), 30);
}

function closeModal() {
  const resolver = pickerResolve;
  pickerResolve = null;
  const dirResolver = dirPickerResolve;
  dirPickerResolve = null;
  const confirm = confirmResolve;
  confirmResolve = null;
  currentModal = null;
  modalRoot.innerHTML = '';
  if (resolver) resolver(null);
  if (dirResolver) dirResolver(null);
  if (confirm) confirm(false);
}

// 统一风格的确认弹窗（替代原生 window.confirm）
function confirmDialog(message, options = {}) {
  const {
    title = '确认操作',
    okText = '确定',
    cancelText = '取消',
    danger = false
  } = options;
  return new Promise((resolve) => {
    const previous = confirmResolve;
    confirmResolve = null;
    if (previous) previous(false);
    confirmResolve = resolve;
    const html = `
      <h3>${esc(title)}</h3>
      <p class="dialog-text">${esc(message)}</p>
      <div class="modal-actions">
        <button class="nes-btn" data-action="confirm-cancel">${esc(cancelText)}</button>
        <button class="nes-btn ${danger ? 'is-error' : 'is-primary'}" data-action="confirm-ok" data-autofocus>${esc(okText)}</button>
      </div>`;
    openModal('confirm', 'confirm', html);
  });
}

function finishConfirm(value) {
  const resolve = confirmResolve;
  confirmResolve = null;
  currentModal = null;
  modalRoot.innerHTML = '';
  if (resolve) resolve(Boolean(value));
}

// 桌面端优先用系统文件夹选择框，浏览器模式退回页面内的目录浏览器
async function chooseFolder(startPath) {
  if (desktop && typeof desktop.pickFolder === 'function') {
    try {
      const dir = await desktop.pickFolder(String(startPath || ''));
      return dir || null;
    } catch (err) {
      toast(err.message || '无法打开文件夹选择框', 'error');
      return null;
    }
  }
  return openDirPicker(startPath);
}

function openDirPicker(startPath) {
  return new Promise((resolve) => {
    if (dirPickerResolve) {
      const previous = dirPickerResolve;
      dirPickerResolve = null;
      previous(null);
    }
    dirPickerResolve = resolve;
    dirPickerPath = String(startPath || '');
    dirPickerParent = null;
    dirPickerValid = false;
    const html = `
      <h3>选择文件夹</h3>
      <p>浏览本机文件夹，或直接输入绝对路径。</p>
      <div class="dir-picker">
        <div class="dir-toolbar">
          <button class="nes-btn" data-action="dir-up" id="dir-up" disabled>上一级</button>
          <span class="dir-path" id="dir-path">${esc(dirPickerPath || '此电脑')}</span>
        </div>
        <div class="dir-list" id="dir-list"><span class="muted">正在读取…</span></div>
        <div class="dir-input-row">
          <input class="nes-input" id="dir-input" value="${esc(dirPickerPath)}" placeholder="输入绝对路径，例如 D:\\Downloads" autocomplete="off">
          ${desktop && typeof desktop.pickFolder === 'function'
            ? '<button class="nes-btn" data-action="dir-native">选择本地文件夹</button>'
            : '<button class="nes-btn" data-action="dir-go">前往</button>'}
        </div>
      </div>
      <div class="modal-actions">
        <button class="nes-btn" data-action="modal-close">取消</button>
        <button class="nes-btn is-primary" data-action="dir-choose" disabled>选择此文件夹</button>
      </div>`;
    openModal('dir-picker', 'dir', html);
    const input = $('#dir-input');
    if (input) {
      input.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        goDirFromInput().catch((err) => toast(err.message, 'error'));
      });
    }
    loadDir(startPath || '').catch((err) => toast(err.message, 'error'));
  });
}

async function loadDir(target) {
  const list = $('#dir-list');
  if (!list) return;
  const seq = ++dirPickerSeq;
  list.innerHTML = '<span class="muted">正在读取…</span>';
  try {
    const data = await api('/api/list-dir', { path: target || '' });
    if (seq !== dirPickerSeq || !dirPickerResolve || !$('#dir-list')) return;
    dirPickerPath = data.path || '';
    dirPickerParent = data.parent || null;
    dirPickerValid = Boolean(dirPickerPath);
    const chooseBtn = $('[data-action="dir-choose"]');
    if (chooseBtn) chooseBtn.disabled = !dirPickerValid;
    const label = $('#dir-path');
    if (label) label.textContent = dirPickerPath || '此电脑';
    const upBtn = $('#dir-up');
    if (upBtn) upBtn.disabled = !dirPickerParent;
    const input = $('#dir-input');
    if (input && document.activeElement !== input) input.value = dirPickerPath;
    const entries = Array.isArray(data.entries) ? data.entries : [];
    list.innerHTML = entries.length
      ? entries.map((entry) => `
          <button class="dir-row" data-action="dir-open" data-path="${esc(entry.path)}">
            <svg viewBox="0 0 24 24"><path d="M3.5 7.5a2 2 0 012-2h3.2l1.8 2h8a2 2 0 012 2v7a2 2 0 01-2 2h-13a2 2 0 01-2-2z" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>
            <span>${esc(entry.name)}</span>
          </button>`).join('')
      : '<span class="muted">此文件夹下没有子文件夹</span>';
  } catch (err) {
    if (seq !== dirPickerSeq) return;
    dirPickerValid = false;
    const chooseBtn = $('[data-action="dir-choose"]');
    if (chooseBtn) chooseBtn.disabled = true;
    if ($('#dir-list')) list.innerHTML = `<span class="muted">${esc(err.message)}</span>`;
  }
}

async function goDirFromInput() {
  const input = $('#dir-input');
  if (!input) return;
  await loadDir(input.value.trim());
}

function finishDirPicker(value) {
  const resolver = dirPickerResolve;
  dirPickerResolve = null;
  currentModal = null;
  modalRoot.innerHTML = '';
  if (resolver) resolver(value || null);
}

function syncModals() {
  if (!state) return;
  const busy = currentModal && !['pair', 'offer'].includes(currentModal.type);
  if (busy) return;

  const pair = (state.pairRequests || []).find((r) => r.initiated === false) || (state.pairRequests || [])[0];
  if (pair) {
    const key = `${pair.sessionId}:${pair.initiated ? 'out' : 'in'}`;
    if (currentModal && currentModal.type === 'pair' && currentModal.key === key) return;
    showPairModal(pair);
    return;
  }

  const offer = (state.offers || [])[0];
  if (offer) {
    if (currentModal && currentModal.type === 'offer' && currentModal.key === offer.id) return;
    showOfferModal(offer);
    return;
  }

  if (currentModal && (currentModal.type === 'pair' || currentModal.type === 'offer')) closeModal();
}

function showPairModal(req) {
  const incoming = req.initiated === false;
  const name = req.peer && req.peer.name ? req.peer.name : '对方设备';
  const host = req.peer && req.peer.host ? `（${esc(req.peer.host)}）` : '';
  const noCode = req.codeRequired === false
    || (Boolean(state.settings) && state.settings.requireCode === false);
  let html;
  if (noCode) {
    html = `
      <h3>${incoming ? '配对请求' : '等待对方确认'}</h3>
      <p>${incoming
        ? `${esc(name)}${host} 请求与本机配对。`
        : `已向 ${esc(name)}${host} 发起配对，等待对方确认。`}</p>
      <div class="modal-note">${incoming
        ? '当前为免验证码模式：请确认这是你认识的设备，接受后该设备身份会被记住。'
        : '当前为免验证码模式：对方确认后即可完成配对。'}</div>
      <div class="modal-actions">
        <button class="nes-btn" data-action="pair-decline" data-id="${esc(req.sessionId)}">${incoming ? '拒绝' : '取消配对'}</button>
        ${incoming ? `<button class="nes-btn is-primary" data-action="pair-accept" data-id="${esc(req.sessionId)}">允许配对</button>` : ''}
      </div>`;
  } else {
    const code = String(req.sas || '------');
    const digits = code.split('').map((d) => `<span>${esc(d)}</span>`).join('');
    html = `
      <h3>${incoming ? '配对请求' : '等待对方确认'}</h3>
      <p>${incoming
        ? `${esc(name)} 请求与本机配对。请确认两台电脑上显示相同的验证码：`
        : `已向 ${esc(name)} 发起配对。请让对方核对下面的验证码：`}</p>
      <div class="pair-code">${digits}</div>
      <div class="modal-note">验证码由双方临时密钥与身份密钥共同派生。若两边不一致，请拒绝并检查网络是否被劫持。</div>
      <div class="modal-actions">
        <button class="nes-btn" data-action="pair-decline" data-id="${esc(req.sessionId)}">${incoming ? '拒绝' : '取消配对'}</button>
        ${incoming ? `<button class="nes-btn is-primary" data-action="pair-accept" data-id="${esc(req.sessionId)}">验证码一致，接受</button>` : ''}
      </div>`;
  }
  openModal('pair', `${req.sessionId}:${incoming ? 'in' : 'out'}`, html);
}

function showOfferModal(offer, dest = (state && state.settings.downloadDir) || '') {
  const html = `
    <h3>接收文件</h3>
    <p><b>${esc(offer.peer.name)}</b> 想要发送“${esc(offer.rootLabel)}”</p>
    <div class="offer-files">
      <span><b>${esc(offer.totalFiles)}</b> 个文件 · <b>${fmtBytes(offer.totalBytes)}</b></span>
      <span>所有分块都会逐块校验，断线后可续传。</span>
    </div>
    <div class="field">
      <span>接收位置</span>
      <div class="input-row">
        <input class="nes-input" id="offer-dest" value="${esc(dest)}" autocomplete="off">
        <button class="nes-btn" data-action="offer-pick">选择</button>
      </div>
    </div>
    <div class="modal-actions">
      <button class="nes-btn" data-action="offer-decline" data-id="${esc(offer.id)}">拒绝</button>
      <button class="nes-btn is-primary" data-action="offer-accept" data-id="${esc(offer.id)}">接收</button>
    </div>`;
  openModal('offer', offer.id, html);
}

function openPathsDialog(peerId = null) {
  pathsPeer = peerId || null;
  const peer = pathsPeer && state ? state.peers.find((p) => p.id === pathsPeer) : null;
  const hint = desktop
    ? '可以点下方按钮选择文件或文件夹，也可以直接输入本机绝对路径。'
    : '浏览器模式：请输入本机上的绝对路径（每行一个）。';
  const html = `
    <h3>发送文件</h3>
    <p>${peer ? `发送到 <b>${esc(peer.name)}</b>。` : ''}${hint}</p>
    <div class="field">
      <span>文件或文件夹路径</span>
      <input class="nes-input" id="paths-input" placeholder="例如 D:\\Downloads\\report.pdf" autocomplete="off" data-autofocus>
    </div>
    <div class="modal-actions">
      ${desktop ? '<button class="nes-btn" data-action="paths-files">选择文件</button><button class="nes-btn" data-action="paths-folder">选择文件夹</button>' : ''}
      <button class="nes-btn" data-action="modal-close">取消</button>
      <button class="nes-btn is-primary" data-action="paths-submit">${peer ? '发送' : '下一步'}</button>
    </div>`;
  openModal('paths', peerId || 'any', html);
}

function openManualModal(prefillHost = '') {
  const parts = String(prefillHost || '').split('.').slice(0, 4).map((p) => p.replace(/\D/g, '').slice(0, 3));
  while (parts.length < 4) parts.push('');
  const segHtml = parts.map((part, idx) => `
    <input class="ip-seg" maxlength="3" inputmode="numeric" autocomplete="off" value="${esc(part)}"${idx === 0 ? ' data-autofocus' : ''}>`).join('<span class="ip-dot">.</span>');
  const html = `
    <h3>手动连接 IP</h3>
    <p>输入对方电脑的局域网 IP 与接收端口。连接后仍需核对 6 位验证码完成首次配对。</p>
    <div class="field"><span>IP 地址</span><div class="ip-row">${segHtml}</div></div>
    <div class="field"><span>端口</span><input class="nes-input" id="manual-port" type="number" min="1" max="65535" value="7411"></div>
    <div class="modal-actions">
      <button class="nes-btn" data-action="modal-close">取消</button>
      <button class="nes-btn is-primary" data-action="manual-submit">连接</button>
    </div>`;
  openModal('manual', prefillHost || 'new', html);
  bindIpSegments();
}

function bindIpSegments() {
  const segs = $$('.ip-seg', modalRoot);
  segs.forEach((seg, idx) => {
    seg.addEventListener('input', () => {
      const digits = seg.value.replace(/\D/g, '').slice(0, 3);
      seg.value = Number(digits) > 255 ? digits.slice(0, 2) : digits;
      if (seg.value.length === 3 && segs[idx + 1]) segs[idx + 1].focus();
    });
    seg.addEventListener('keydown', (event) => {
      if (event.key === 'Backspace' && !seg.value && segs[idx - 1]) segs[idx - 1].focus();
      if (event.key === '.' && seg.value && segs[idx + 1]) {
        event.preventDefault();
        segs[idx + 1].focus();
      }
    });
    seg.addEventListener('paste', (event) => {
      event.preventDefault();
      const text = (event.clipboardData ? event.clipboardData.getData('text') : '').trim();
      if (!text) return;
      if (text.includes('.')) {
        const pasted = text.split('.').map((p) => p.replace(/\D/g, '').slice(0, 3));
        pasted.forEach((p, i) => { if (segs[idx + i]) segs[idx + i].value = p; });
        const next = Math.min(idx + pasted.length, 3);
        segs[next].focus();
      } else {
        const digits = text.replace(/\D/g, '');
        let pos = 0;
        for (let i = idx; i < 4 && pos < digits.length; i++) {
          const len = Math.min(3, digits.length - pos);
          segs[i].value = digits.slice(pos, pos + len);
          pos += len;
        }
        const last = segs.findLastIndex((s) => s.value);
        segs[Math.min(last + 1, 3)].focus();
      }
    });
  });
}

function choosePeer() {
  return new Promise((resolve) => {
    pickerResolve = resolve;
    const candidates = state ? state.peers.filter((p) => p.online) : [];
    const choices = candidates.map((p) => `
      <button data-action="send-to" data-peer="${esc(p.id)}">
        ${avatarHtml(p.id, p.name)}
        <span><strong>${esc(p.name)}</strong><span>${esc(p.host || '')}${p.tcpPort ? `:${p.tcpPort}` : ''} · ${p.trusted ? '已配对' : '未配对，将先请求配对'}</span></span>
      </button>`).join('');
    const html = `
      <h3>选择接收设备</h3>
      <p>文件会通过加密通道直接发送到所选设备。</p>
      ${candidates.length
        ? `<div class="peer-choice">${choices}</div>`
        : '<div class="modal-note">当前没有在线的设备。请确保对方也打开了 LanLink，或使用手动连接 IP。</div>'}
      <div class="modal-actions">
        <button class="nes-btn" data-action="picker-manual">手动连接 IP</button>
        <button class="nes-btn" data-action="modal-close">取消</button>
      </div>`;
    openModal('picker', 'picker', html);
  });
}

function resolvePicker(peerId) {
  const resolver = pickerResolve;
  pickerResolve = null;
  closeModal();
  if (resolver) resolver(peerId);
}

function parsePaths(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);
}

async function sendFlow(paths, peerId) {
  let target = peerId;
  if (!target) target = await choosePeer();
  if (!target) return;
  await api('/api/send', { peerId: target, paths });
  toast('已加入发送队列，正在校验文件…', 'success');
  switchView('transfers');
}

async function submitPaths() {
  const input = $('#paths-input');
  const paths = parsePaths(input ? input.value : '');
  if (!paths.length) {
    toast('请选择文件或输入至少一个路径', 'warning');
    return;
  }
  const target = pathsPeer;
  closeModal();
  await sendFlow(paths, target);
}

async function pickPaths(kind) {
  if (!desktop) return;
  const target = pathsPeer;
  if (kind === 'folder') {
    const dir = await chooseFolder((state && state.settings.downloadDir) || '');
    if (!dir) { openPathsDialog(target); return; }
    await sendFlow([dir], target);
    return;
  }
  const files = await desktop.pickFiles();
  if (!files || !files.length) return;
  closeModal();
  await sendFlow(files, target);
}

async function connectManual() {
  const segs = $$('.ip-seg').map((seg) => seg.value.trim());
  if (segs.some((seg) => !seg)) { toast('请输入完整的 IP 地址', 'warning'); return; }
  if (segs.some((seg) => Number(seg) > 255)) { toast('IP 每段必须在 0–255 之间', 'warning'); return; }
  const host = segs.join('.');
  const port = Number($('#manual-port')?.value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) { toast('端口必须是 1–65535', 'warning'); return; }
  const button = modalRoot.querySelector('[data-action="manual-submit"]');
  if (button) button.disabled = true;
  try {
    const result = await api('/api/connect', { host, port });
    closeModal();
    if (result.trusted) toast(`已连接到 ${result.peer.name}`, 'success');
    else toast(`已连接 ${result.peer.name}，请核对配对验证码`, 'info');
  } catch (err) {
    if (button) button.disabled = false;
    toast(err.message, 'error');
  }
}

async function acceptPair(peerId) {
  try {
    await api(`/api/pair/${encodeURIComponent(peerId)}`, { accept: true });
    closeModal();
    toast('已配对，可以开始发送', 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function declinePair(peerId) {
  try { await api(`/api/pair/${encodeURIComponent(peerId)}`, { accept: false }); } catch (err) { toast(err.message, 'error'); }
  closeModal();
}

async function acceptOffer(id) {
  const destInput = $('#offer-dest');
  const destDir = destInput ? destInput.value.trim() : '';
  try {
    await api(`/api/incoming/${encodeURIComponent(id)}/accept`, { destDir });
    closeModal();
    toast('已开始接收文件', 'success');
    switchView('transfers');
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function declineOffer(id) {
  try { await api(`/api/incoming/${encodeURIComponent(id)}/decline`, {}); } catch (err) { toast(err.message, 'error'); }
  closeModal();
}

async function pickOfferDest() {
  const offerId = currentModal && currentModal.type === 'offer' ? currentModal.key : null;
  const input = $('#offer-dest');
  const current = input ? input.value.trim() : '';
  const dir = await chooseFolder(current || (state && state.settings.downloadDir) || '');
  const offer = offerId && state ? (state.offers || []).find((o) => o.id === offerId) : null;
  if (offer) showOfferModal(offer, dir || current);
}

async function enableCodeAndPair(peer) {
  const ok = await confirmDialog(
    `“${peer.name}”已开启配对验证。要继续配对，本机也需要开启验证码校验。`,
    { title: '需要开启验证码', okText: '开启并继续' }
  );
  if (!ok) return false;
  try {
    await api('/api/settings', { requireCode: true });
    if (state && state.settings) state.settings.requireCode = true;
    return true;
  } catch (err) {
    toast(err.message, 'error');
    return false;
  }
}

async function pairPeer(peerId, { skipCheck = false } = {}) {
  const peer = state ? state.peers.find((p) => p.id === peerId) : null;
  if (!peer) { toast('设备已离线', 'warning'); return; }
  if (!peer.host || !peer.tcpPort) { openManualModal(peer.host || ''); return; }
  if (!skipCheck && state && state.settings && state.settings.requireCode === false && peer.requireCode !== false) {
    if (await enableCodeAndPair(peer)) await pairPeer(peerId, { skipCheck: true });
    return;
  }
  try {
    const result = await api('/api/connect', { host: peer.host, port: peer.tcpPort });
    if (peer.trusted) {
      toast(`已重新连接 ${peer.name}`, 'success');
      return;
    }
    const noCode = (state && state.settings && state.settings.requireCode === false) || peer.requireCode === false;
    toast(noCode
      ? `正在与 ${result.peer.name} 配对，请等待对方确认`
      : `正在与 ${result.peer.name} 配对，请核对验证码`, 'info');
  } catch (err) {
    if (err.data && err.data.code === 'PAIR_CODE_REQUIRED') {
      if (await enableCodeAndPair(peer)) await pairPeer(peerId, { skipCheck: true });
      return;
    }
    toast(err.message, 'error');
  }
}

async function disconnectPeer(peerId) {
  try {
    await api('/api/disconnect', { peerId });
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function removeHistory(id) {
  try {
    await api(`/api/history/${encodeURIComponent(id)}`, {});
    toast('已删除该记录', 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function clearHistory() {
  if (!(await confirmDialog('确定清空全部历史记录？此操作不可恢复。', { title: '清空历史记录', okText: '清空', danger: true }))) return;
  try {
    await api('/api/history/clear', {});
    toast('历史记录已清空', 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function copyText(text, message) {
  const value = String(text || '');
  if (!value) { toast('暂无可复制的内容', 'warning'); return false; }
  try {
    await navigator.clipboard.writeText(value);
    toast(message, 'success');
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = value;
    document.body.appendChild(area);
    area.select();
    try { document.execCommand('copy'); toast(message, 'success'); return true; }
    catch { toast('复制失败，请手动选择内容', 'error'); return false; }
    finally { area.remove(); }
  }
}

async function copyFingerprint() {
  if (!state) return;
  await copyText(state.device.fingerprint || '', '设备指纹已复制');
}

function guestUrl() {
  return state && state.guest && Array.isArray(state.guest.urls) ? state.guest.urls[0] || '' : '';
}

async function toggleGuest() {
  if (!state) return;
  const enable = !state.settings.guestEnabled;
  try {
    await api('/api/settings', { guestEnabled: enable });
    const input = $('#set-guest-enabled');
    if (input) input.checked = enable;
    await fetchState();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function copyGuestLink() {
  const url = guestUrl();
  if (!url) { toast('请先开启访客上传', 'warning'); return; }
  await copyText(url, '访客链接已复制');
}

async function copyGuestCode() {
  const code = state && state.guest ? state.guest.code || '' : '';
  if (!code) { toast('请先开启访客上传', 'warning'); return; }
  await copyText(code, '访问码已复制');
}

async function openGuestLink() {
  const url = guestUrl();
  if (!url) { toast('请先开启访客上传', 'warning'); return; }
  if (desktop && desktop.openExternal) {
    try { await desktop.openExternal(url); }
    catch (err) { toast(err.message || '无法打开链接', 'error'); }
    return;
  }
  window.open(url, '_blank', 'noopener');
}

async function rotateGuest() {
  if (!state || !state.guest || !state.guest.enabled) { toast('请先开启访客上传', 'warning'); return; }
  if (!(await confirmDialog('更新后旧链接和访问码立即失效，进行中的访客上传会被中断。继续？', { title: '更新访客链接', okText: '继续' }))) return;
  try {
    await api('/api/guest/rotate', {});
    await fetchState();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function revealPath(target) {
  if (!target) return;
  if (desktop) {
    try {
      const result = await desktop.reveal(target);
      if (result && result.ok === false) toast(result.error || '文件或文件夹不存在', 'error');
    } catch (err) {
      toast(err.message || '无法打开位置', 'error');
    }
    return;
  }
  try {
    await api('/api/reveal', { path: target });
  } catch (err) {
    toast(err.message || '无法打开文件位置', 'error');
  }
}

async function openDataDir() {
  if (!state) return;
  if (desktop) {
    try { await desktop.openDataDir(); } catch (err) { toast(err.message || '无法打开目录', 'error'); }
    return;
  }
  try {
    await api('/api/reveal', { path: state.device.dataDir });
    return;
  } catch { /* fall back to copying the path */ }
  try {
    await navigator.clipboard.writeText(state.device.dataDir || '');
    toast('数据目录已复制到剪贴板', 'success');
  } catch {
    toast(state.device.dataDir || '', 'info');
  }
}

async function pickGuestShare(kind) {
  const field = $('#set-guest-share-path');
  const current = (field && field.value.trim()) || (state.settings.downloadDir || '');
  let picked = '';
  if (kind === 'file') {
    if (!desktop || typeof desktop.pickShareFile !== 'function') {
      toast('仅桌面版支持选择共享文件', 'warning');
      return;
    }
    picked = await desktop.pickShareFile();
  } else {
    picked = await chooseFolder(current);
  }
  if (!picked) return;
  field.value = picked;
  $('#set-guest-share').checked = true;
  try {
    await api('/api/settings', { guestShareDir: picked, guestEnabled: true });
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function pickDownloadDir() {
  const field = $('#set-download');
  const dir = await chooseFolder((field && field.value.trim()) || '');
  if (!dir) return;
  $('#set-download').value = dir;
  markSettingsDirty();
}

function markSettingsDirty() {
  settingsDirty = true;
  $('#settings-hint').textContent = '有未保存的更改';
}

async function saveSettings() {
  const name = $('#set-name').value.trim();
  if (!name) { toast('设备名称不能为空', 'warning'); return; }
  const ttl = Number($('#set-ttl').value);
  const guestPort = Number($('#set-guest-port').value);
  if ($('#set-guest-enabled').checked && (!Number.isInteger(guestPort) || guestPort < 1024 || guestPort > 65535)) {
    toast('访客端口需在 1024–65535 之间', 'warning');
    return;
  }
  const guestExpiry = Number($('#set-guest-expiry').value);
  const guestMaxFile = Number($('#set-guest-max-file').value);
  const guestMaxBatch = Number($('#set-guest-max-batch').value);
  const button = $('#save-settings');
  button.disabled = true;
  try {
    await api('/api/settings', {
      deviceName: name,
      downloadDir: $('#set-download').value.trim(),
      autoAccept: $('#set-auto-accept').checked,
      requireCode: $('#set-require-code').checked,
      archiveEnabled: $('#set-archive').checked,
      discoveryEnabled: $('#set-discovery').checked,
      partialTtlHours: Number.isFinite(ttl) ? ttl : 24,
      guestEnabled: $('#set-guest-enabled').checked,
      guestPort: Number.isFinite(guestPort) ? guestPort : undefined,
      guestExpiryHours: Number.isFinite(guestExpiry) ? guestExpiry : undefined,
      guestMaxFileMB: Number.isFinite(guestMaxFile) ? guestMaxFile : undefined,
      guestMaxBatchMB: Number.isFinite(guestMaxBatch) ? guestMaxBatch : undefined,
      guestShareDir: $('#set-guest-share').checked ? $('#set-guest-share-path').value.trim() : ''
    });
    settingsDirty = false;
    $('#settings-hint').textContent = '设置已保存';
    toast('设置已保存', 'success');
    setTimeout(() => {
      if (!settingsDirty && $('#settings-hint').textContent === '设置已保存') $('#settings-hint').textContent = '';
    }, 2600);
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    button.disabled = false;
  }
}

async function changeDataDir() {
  if (!desktop || typeof desktop.changeDataDir !== 'function') {
    toast('仅桌面版支持更改数据目录', 'warning');
    return;
  }
  const ok = await confirmDialog(
    '将把当前数据（身份、配置、历史）复制到新目录，然后重启应用生效。请选择一个空文件夹。',
    { title: '更改数据目录', okText: '选择目录' }
  );
  if (!ok) return;
  const result = await desktop.changeDataDir();
  if (!result || result.canceled) return;
  if (!result.ok) {
    toast(result.error || '更改失败', 'error');
    return;
  }
  toast('数据目录已更改，正在重启…', 'success');
}

async function resetSettings() {
  if (!(await confirmDialog('恢复所有设置为默认值？设备名称与已配对设备会保留。', { title: '恢复默认设置', okText: '恢复', danger: true }))) return;
  try {
    await api('/api/settings/reset', {});
    settingsDirty = false;
    $('#settings-hint').textContent = '已恢复默认设置';
    toast('已恢复默认设置', 'success');
    setTimeout(() => {
      if (!settingsDirty && $('#settings-hint').textContent === '已恢复默认设置') $('#settings-hint').textContent = '';
    }, 2600);
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function cancelTransfer(id) {
  try {
    await api(`/api/transfers/${encodeURIComponent(id)}/cancel`, {});  } catch (err) {
    toast(err.message, 'error');
  }
}

async function refreshPeers() {
  try {
    const res = await fetch('/api/state', { cache: 'no-store' });
    if (res.ok) applyState(await res.json());
    toast('设备列表已刷新', 'info');
  } catch {
    toast('无法连接到本机服务', 'error');
  }
}

async function handleDrop(event) {
  event.preventDefault();
  $('#dropzone').classList.remove('drag');
  if (!desktop) {
    toast('浏览器模式无法读取拖入文件的本地路径，请点击后手动输入', 'warning');
    return;
  }
  const files = [...(event.dataTransfer?.files || [])];
  const paths = files.map((file) => desktop.getPathForFile(file)).filter(Boolean);
  if (!paths.length) { toast('未能读取文件路径', 'warning'); return; }
  await sendFlow(paths, null);
}

function bindEvents() {
  $('#nav').addEventListener('click', (event) => {
    const btn = event.target.closest('[data-view]');
    if (btn) switchView(btn.dataset.view);
  });

  $('#quick-send-btn').addEventListener('click', () => openPathsDialog());
  $('#manual-connect-btn').addEventListener('click', () => openManualModal());
  $('#copy-fp').addEventListener('click', () => copyFingerprint().catch((err) => toast(err.message, 'error')));
  $('#history-clear').addEventListener('click', () => clearHistory());
  $('#open-data-dir').addEventListener('click', () => openDataDir());
  const changeDirBtn = $('#change-data-dir');
  if (changeDirBtn) changeDirBtn.addEventListener('click', () => changeDataDir().catch((err) => toast(err.message, 'error')));
  $('#pick-download').addEventListener('click', () => pickDownloadDir().catch((err) => toast(err.message, 'error')));
  $('#pick-guest-share-dir').addEventListener('click', () => pickGuestShare('dir').catch((err) => toast(err.message, 'error')));
  $('#pick-guest-share-file').addEventListener('click', () => pickGuestShare('file').catch((err) => toast(err.message, 'error')));
  // 两个访客开关即时生效，并同步到设备页的访客卡片
  $('#set-require-code').addEventListener('change', async (event) => {
    const box = event.target;
    const next = box.checked;
    if (!next) {
      const ok = await confirmDialog(
        '关闭验证码后：\n\n· 任何拿到访客链接的人都能直接上传/下载\n· 同一局域网内的设备可以发起配对，只需你点确认\n\n仅建议在完全可信的家庭或办公室网络中使用。',
        { title: '关闭验证码校验', okText: '仍然关闭' }
      );
      if (!ok) {
        box.checked = true;
        return;
      }
    }
    // 弹窗期间可能有状态推送把开关改回旧值，这里以点击时的意图为准
    requireCodePending = true;
    box.checked = next;
    try {
      await api('/api/settings', { requireCode: next });
      $('#no-code-warning').hidden = next;
    } catch (err) {
      box.checked = !next;
      toast(err.message, 'error');
    } finally {
      requireCodePending = false;
    }
  });

  $('#set-guest-enabled').addEventListener('change', async (event) => {
    const checked = event.target.checked;
    try {
      await api('/api/settings', { guestEnabled: checked });
    } catch (err) {
      event.target.checked = !checked;
      toast(err.message, 'error');
    }
  });

  $('#set-guest-share').addEventListener('change', async (event) => {
    const box = event.target;
    const field = $('#set-guest-share-path');
    try {
      if (box.checked) {
        let dir = field.value.trim();
        if (!dir) {
          dir = await chooseFolder(state.settings.downloadDir || '');
          if (!dir) {
            box.checked = false;
            return;
          }
          field.value = dir;
        }
        // 开启下载共享时同时开启访客模式，设备页卡片才会显示“运行中”
        await api('/api/settings', { guestShareDir: dir, guestEnabled: true });
      } else {
        field.value = '';
        await api('/api/settings', { guestShareDir: '' });
      }
    } catch (err) {
      box.checked = !box.checked;
      toast(err.message, 'error');
    }
  });
  $('#save-settings').addEventListener('click', () => saveSettings());
  const resetBtn = $('#reset-settings');
  if (resetBtn) resetBtn.addEventListener('click', () => resetSettings());
  $('#refresh-peers').addEventListener('click', () => refreshPeers());

  const dropzone = $('#dropzone');
  dropzone.addEventListener('click', () => openPathsDialog());
  dropzone.addEventListener('dragenter', (event) => {
    event.preventDefault();
    dropzone.classList.add('drag');
  });
  dropzone.addEventListener('dragover', (event) => {
    event.preventDefault();
    dropzone.classList.add('drag');
  });
  dropzone.addEventListener('dragleave', (event) => {
    if (!dropzone.contains(event.relatedTarget)) dropzone.classList.remove('drag');
  });
  dropzone.addEventListener('drop', (event) => {
    handleDrop(event).catch((err) => toast(err.message, 'error'));
  });
  dropzone.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    openPathsDialog();
  });

  ['set-name', 'set-download', 'set-ttl', 'set-guest-port', 'set-guest-expiry', 'set-guest-max-file', 'set-guest-max-batch'].forEach((id) => {
    $(`#${id}`).addEventListener('input', markSettingsDirty);
  });
  ['set-auto-accept', 'set-archive', 'set-discovery', 'set-guest-enabled'].forEach((id) => {
    $(`#${id}`).addEventListener('change', markSettingsDirty);
  });

  document.addEventListener('click', (event) => {
    const el = event.target.closest('[data-action]');
    if (!el) return;
    const action = el.dataset.action;
    const id = el.dataset.id;
    const run = (promise) => Promise.resolve(promise).catch((err) => toast(err.message || '操作失败', 'error'));
    switch (action) {
      case 'send':
        openPathsDialog(el.dataset.peer);
        break;
      case 'pair':
        run(pairPeer(el.dataset.peer));
        break;
      case 'disconnect':
        run(disconnectPeer(el.dataset.peer));
        break;
      case 'history-remove':
        run(removeHistory(id));
        break;
      case 'cancel':
        run(cancelTransfer(id));
        break;
      case 'reveal':
        run(revealPath(el.dataset.path));
        break;
      case 'modal-close':
        closeModal();
        break;
      case 'dir-open':
        run(loadDir(el.dataset.path));
        break;
      case 'dir-up':
        run(loadDir(dirPickerParent || ''));
        break;
      case 'dir-go':
        run(goDirFromInput());
        break;
      case 'dir-native':
        run((async () => {
          const dir = await desktop.pickFolder(dirPickerPath || '');
          if (dir) finishDirPicker(dir);
        })());
        break;
      case 'confirm-ok':
        finishConfirm(true);
        break;
      case 'confirm-cancel':
        finishConfirm(false);
        break;
      case 'dir-choose':
        finishDirPicker(dirPickerPath);
        break;
      case 'paths-submit':
        run(submitPaths());
        break;
      case 'paths-files':
        run(pickPaths('files'));
        break;
      case 'paths-folder':
        run(pickPaths('folder'));
        break;
      case 'send-to':
        resolvePicker(el.dataset.peer);
        break;
      case 'picker-manual':
        resolvePicker(null);
        openManualModal();
        break;
      case 'manual-submit':
        run(connectManual());
        break;
      case 'pair-accept':
        run(acceptPair(id));
        break;
      case 'pair-decline':
        run(declinePair(id));
        break;
      case 'offer-accept':
        run(acceptOffer(id));
        break;
      case 'offer-decline':
        run(declineOffer(id));
        break;
      case 'offer-pick':
        run(pickOfferDest());
        break;
      case 'guest-toggle':
        run(toggleGuest());
        break;
      case 'guest-copy-link':
        run(copyGuestLink());
        break;
      case 'guest-copy-url':
        run(copyText(el.dataset.url, '链接已复制'));
        break;
      case 'guest-copy-code':
        run(copyGuestCode());
        break;
      case 'guest-open':
        run(openGuestLink());
        break;
      case 'guest-rotate':
        run(rotateGuest());
        break;
      default:
        break;
    }
  });

  modalRoot.addEventListener('click', (event) => {
    if (event.target && event.target.dataset && event.target.dataset.backdrop === '1') {
      if (currentModal && !['pair', 'offer'].includes(currentModal.type)) closeModal();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !currentModal) return;
    if (['pair', 'offer'].includes(currentModal.type)) return;
    closeModal();
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && Date.now() - lastStateAt > 3000) fetchState();
  });
}

async function fetchState() {
  try {
    const res = await fetch('/api/state', { cache: 'no-store' });
    if (!res.ok) throw new Error('state');
    applyState(await res.json());
  } catch {
    setConnecting();
  }
}

function connectEvents() {
  if (typeof EventSource === 'undefined') return;
  eventSource = new EventSource('/api/events');
  eventSource.addEventListener('state', (event) => {
    try { applyState(JSON.parse(event.data)); } catch { /* noop */ }
  });
  eventSource.addEventListener('toast', (event) => {
    try {
      const data = JSON.parse(event.data);
      toast(data.message, data.type);
    } catch { /* noop */ }
  });
  eventSource.addEventListener('open', () => {
    if (state) updateStatus();
    else fetchState();
  });
  eventSource.addEventListener('error', () => {
    setConnecting();
  });
}

async function init() {
  bindEvents();
  connectEvents();
  await fetchState();
  setInterval(() => {
    if (Date.now() - lastStateAt > 5000) fetchState();
  }, 8000);
}

init();
