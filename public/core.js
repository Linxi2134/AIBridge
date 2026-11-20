/* AIBridge 前端核心：API / 图标 / Toast / Modal / 工具函数 */
(function () {
  'use strict';

  // ---------------- 访问口令 ----------------
  // 服务端可以用 AIBRIDGE_TOKEN 给 /api/* 加口令：本机回环自动放行，
  // 局域网/公网访问必须带 token。前端把它存在 localStorage，
  // 链接上直接带 ?token=xxx 也能一次性写入并清掉地址栏里的明文。
  const TOKEN_KEY = 'aibridge_token';
  let askedToken = false;

  function authToken() {
    try {
      const u = new URL(window.location.href);
      const fromUrl = u.searchParams.get('token');
      if (fromUrl) {
        localStorage.setItem(TOKEN_KEY, fromUrl);
        u.searchParams.delete('token');
        const qs = u.searchParams.toString();
        history.replaceState(null, '', u.pathname + (qs ? `?${qs}` : '') + u.hash);
        return fromUrl;
      }
      return localStorage.getItem(TOKEN_KEY) || '';
    } catch (_) {
      return '';
    }
  }

  // 全站统一注入请求头：绕过 Core.api 直接 fetch 的地方（聊天流、语音、上传）也不会漏口令。
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async function patchedFetch(input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const sameApi = /^\/api\//.test(url);
    const token = sameApi ? authToken() : '';
    const opts = { ...(init || {}) };
    if (token) {
      const headers = new Headers(opts.headers || {});
      if (!headers.has('x-aibridge-token')) headers.set('x-aibridge-token', token);
      opts.headers = headers;
    }
    const res = await nativeFetch(input, opts);
    if (sameApi && res.status === 403 && !token && !askedToken) {
      // 口令没配过又被打回：问一次，存下来再重试，避免用户对着满屏 403 发呆
      askedToken = true;
      const typed = window.prompt('这台服务器开启了访问口令（AIBRIDGE_TOKEN），请输入：');
      if (typed && typed.trim()) {
        try { localStorage.setItem(TOKEN_KEY, typed.trim()); } catch (_) { /* 隐私模式 */ }
        return window.fetch(input, init);
      }
    }
    return res;
  };

  // ---------------- 图标 ----------------
  const ICONS = {
    dashboard: '<path d="M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z"/>',
    chat: '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>',
    plug: '<path d="M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-6 6 6 6 0 0 1-6-6V8zM12 17v5"/>',
    cpu: '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3"/>',
    bot: '<rect x="3" y="8" width="18" height="12" rx="3"/><circle cx="9" cy="14" r="1.4" fill="currentColor" stroke="none"/><circle cx="15" cy="14" r="1.4" fill="currentColor" stroke="none"/><path d="M12 8V4M9 4h6"/>',
    mic: '<path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v1a7 7 0 0 1-14 0v-1M12 18v4M8 22h8"/>',
    history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 8v4l3 2"/>',
    terminal: '<path d="M4 17l6-5-6-5M12 19h8"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    check: '<path d="M20 6L9 17l-5-5"/>',
    x: '<path d="M18 6L6 18M6 6l12 12"/>',
    alert: '<circle cx="12" cy="12" r="10"/><path d="M12 8v5M12 16.5v.01"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-5M12 7.5v.01"/>',
    eye: '<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/>',
    trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    send: '<path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/>',
    play: '<path d="M6 4l14 8-14 8V4z"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
    refresh: '<path d="M21 2v6h-6M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16M3 12a9 9 0 0 1 15-6.7L21 8"/>',
    edit: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>',
    zap: '<path d="M13 2L3 14h8l-1 8 10-12h-8l1-8z"/>',
    volume: '<path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a9 9 0 0 1 0 14"/>',
    arrow: '<path d="M5 12h14M12 5l7 7-7 7"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    wechat: '<path d="M9 3C4.6 3 1 6 1 9.7c0 2.1 1.2 4 3.1 5.2L3.5 17l2.4-1.2c.9.3 1.9.4 2.9.4h.6"/><path d="M23 14.5c0-3-2.9-5.4-6.5-5.4S10 11.5 10 14.5s2.9 5.4 6.5 5.4c.8 0 1.6-.1 2.3-.3l2 1-.6-1.8c1.6-1 2.8-2.5 2.8-4.3z"/>',
    qq: '<path d="M12 2c3.3 0 6 2.7 6 6 0 1.5.6 2.4 1.4 3.6.9 1.3 1.6 2.6 1.6 4.4 0 1.6-.8 2.5-1.8 2.5-1.2 0-2-1.1-2.4-2.3-.6.8-1.5 1.4-2.4 1.8v1c0 .6-.5 1-1 1h-1.8c-.6 0-1-.4-1-1v-1c-.9-.4-1.8-1-2.4-1.8-.4 1.2-1.2 2.3-2.4 2.3-1 0-1.8-.9-1.8-2.5 0-1.8.7-3.1 1.6-4.4C5.4 10.4 6 9.5 6 8c0-3.3 2.7-6 6-6z"/>',
    key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="M11 12L21 2M17 6l3 3M14 9l3 3"/>',
    globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20z"/>',
    server: '<rect x="2" y="3" width="20" height="7" rx="2"/><rect x="2" y="14" width="20" height="7" rx="2"/><path d="M6 6.5v.01M6 17.5v.01"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
    wave: '<path d="M2 12h3l2-7 3 14 3-10 2 5h5"/>',
    download: '<path d="M12 3v12"/><path d="m7 11 5 5 5-5"/><path d="M4 20h16"/>',
  };

  function icon(name, size) {
    const path = ICONS[name] || ICONS.info;
    const s = size || 16;
    return `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
  }

  // ---------------- 请求 ----------------
  async function api(path, options) {
    const opts = options || {};
    const init = {
      method: opts.method || 'GET',
      headers: {},
    };
    if (opts.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    if (opts.raw) {
      init.body = opts.raw;
      init.headers = opts.headers || {};
    }
    const res = await fetch(path, init);
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('application/json')) {
      if (!res.ok) throw new Error(`请求失败 (${res.status})`);
      return res;
    }
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || json.message || `请求失败 (${res.status})`);
    return json;
  }

  // ---------------- Toast ----------------
  function toast(message, type) {
    const wrap = document.getElementById('toastWrap');
    const el = document.createElement('div');
    const t = type || 'info';
    el.className = `toast ${t}`;
    el.innerHTML = `${icon(t === 'ok' ? 'check' : t === 'err' ? 'alert' : 'info')}<div>${escapeHtml(message)}</div>`;
    wrap.appendChild(el);
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 220);
    }, t === 'err' ? 4200 : 2600);
  }

  // ---------------- Modal ----------------
  let modalStack = [];

  function openModal({ title, body, footer, wide, onMount, plain }) {
    const root = document.getElementById('modalRoot');
    root.classList.add('open');
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    // body / footer 一直按 HTML 串用（调用方自己负责转义），所以默认行为不能变；
    // 需要把服务端文本原样塞进弹窗时传 plain: true，由这里统一转义，
    // 免得每个调用点各写一遍 escapeHtml、漏一个就是一个 XSS。
    const bodyHtml = plain
      ? `<div style="white-space:pre-wrap;word-break:break-word">${escapeHtml(body)}</div>`
      : (body || '');
    mask.innerHTML = `
      <div class="modal ${wide ? 'wide' : ''}">
        <div class="modal-head">
          <h3>${escapeHtml(title || '')}</h3>
          <button class="close" data-close>${icon('x', 16)}</button>
        </div>
        <div class="modal-body">${bodyHtml}</div>
        ${footer ? `<div class="modal-foot">${footer}</div>` : ''}
      </div>`;
    mask.addEventListener('click', (e) => {
      if (e.target === mask || e.target.closest('[data-close]')) closeModal(mask);
    });
    root.appendChild(mask);
    modalStack.push(mask);
    if (onMount) onMount(mask);
    return mask;
  }

  function closeModal(mask) {
    const target = mask || modalStack[modalStack.length - 1];
    if (!target) return;
    target.remove();
    modalStack = modalStack.filter((m) => m !== target);
    if (!modalStack.length) document.getElementById('modalRoot').classList.remove('open');
  }

  function closeAllModals() {
    modalStack.forEach((m) => m.remove());
    modalStack = [];
    document.getElementById('modalRoot').classList.remove('open');
  }

  function confirmDialog({ title, message, confirmText, danger }) {
    return new Promise((resolve) => {
      const mask = openModal({
        title: title || '确认操作',
        body: `<div style="font-size:13.5px;color:var(--text-2);line-height:1.7">${escapeHtml(message || '')}</div>`,
        footer: `<button class="btn btn-ghost" data-close>取消</button>
                 <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${escapeHtml(confirmText || '确认')}</button>`,
      });
      mask.querySelector('[data-ok]').addEventListener('click', () => {
        closeModal(mask);
        resolve(true);
      });
      mask.addEventListener('click', (e) => {
        if (e.target.closest('[data-close]')) resolve(false);
      });
    });
  }

  // ---------------- 工具函数 ----------------
  function escapeHtml(str) {
    return String(str === undefined || str === null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** 轻量 Markdown：代码块、行内代码、粗体、链接 */
  function renderMarkdown(text) {
    let html = escapeHtml(text);
    const blocks = [];
    html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (m, lang, code) => {
      const idx = blocks.length;
      blocks.push(`<pre><code>${code.replace(/\n$/, '')}</code></pre>`);
      return `\u0000BLOCK${idx}\u0000`;
    });
    html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    html = html.replace(/\u0000BLOCK(\d+)\u0000/g, (m, i) => blocks[Number(i)]);
    return html;
  }

  function fmtTime(ts) {
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function fmtClock(ts) {
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function timeAgo(ts) {
    const diff = Date.now() - ts;
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
    return `${Math.floor(diff / 86400000)} 天前`;
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (_) { /* ignore */ }
    ta.remove();
    return Promise.resolve();
  }

  function debounce(fn, wait) {
    let t;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), wait || 300);
    };
  }

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

  // 全局事件委托：复制按钮
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-copy]');
    if (btn) {
      copyText(btn.dataset.copy).then(() => toast('已复制到剪贴板', 'ok'));
    }
  });

  window.Core = {
    icon, api, toast, openModal, closeModal, closeAllModals, confirmDialog,
    escapeHtml, renderMarkdown, fmtTime, fmtClock, timeAgo, copyText, debounce, $, $$,
    ICONS,
  };
})();
