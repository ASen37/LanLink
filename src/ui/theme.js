'use strict';

// 主题切换：在首帧之前套用，避免亮/暗闪烁。桌面页与访客页共用。
(function () {
  const KEY = 'lanlink-theme';
  const root = document.documentElement;

  function read() {
    try {
      return localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light';
    } catch {
      return 'light';
    }
  }

  function paint(theme) {
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
    const options = document.querySelectorAll('[data-theme-opt]');
    for (const btn of options) {
      const active = btn.dataset.themeOpt === theme;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
  }

  function apply(theme) {
    paint(theme);
    try { localStorage.setItem(KEY, theme); } catch { /* 隐私模式下忽略 */ }
  }

  paint(read());

  // 脚本在 <head> 执行时按钮还不存在，DOM 就绪后再同步一次激活态
  document.addEventListener('DOMContentLoaded', () => paint(root.dataset.theme || read()));

  document.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-theme-opt]');
    if (!btn) return;
    apply(btn.dataset.themeOpt === 'dark' ? 'dark' : 'light');
  });
})();
