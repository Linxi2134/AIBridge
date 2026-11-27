/* AIBridge 前端主控：路由 / 状态 / 流式对话 / 语音 */
(function () {
  'use strict';
  const { icon, escapeHtml, api, toast } = Core;

  const NAV = [
    {
      group: '总览',
      items: [
        { id: 'overview', label: '概览', icon: 'dashboard' },
        { id: 'chat', label: '对话', icon: 'chat' },
      ],
    },
    {
      group: '运行实例',
      items: [
        { id: 'game', label: '游戏', icon: 'play' },
        { id: 'login', label: '账号接入', icon: 'link' },
        { id: 'friends', label: '好友管理', icon: 'qq' },
        { id: 'models', label: '模型', icon: 'cpu' },
        { id: 'voice', label: '语音', icon: 'mic' },
      ],
    },
    {
      group: 'AI 能力',
      items: [
        { id: 'channels', label: '渠道', icon: 'plug' },
        { id: 'agents', label: '智能体', icon: 'bot' },
        { id: 'memory', label: '记忆', icon: 'globe' },
        { id: 'knowledge', label: '知识库', icon: 'book' },
        { id: 'skills', label: '技能', icon: 'package' },
        { id: 'video', label: '视频生成', icon: 'play' },
      ],
    },
    {
      group: '系统',
      items: [
        { id: 'sessions', label: '会话', icon: 'history' },
        { id: 'logs', label: '日志', icon: 'terminal' },
        { id: 'settings', label: '设置', icon: 'settings' },
      ],
    },
  ];

  if (window.AIBRIDGE_ANDROID) {
    for (const g of NAV) g.items = g.items.filter((it) => it.id !== 'game' && it.id !== 'login');
  }

  // 手机上用底部导航：四个高频入口 + 「更多」抽屉放其余页面。
  // 桌面端不渲染 tabbar（.tabbar 默认 display:none），侧栏保持原样。
  const TABS = [
    { id: 'overview', label: '概览', icon: 'dashboard' },
    { id: 'chat', label: '对话', icon: 'chat' },
    { id: 'memory', label: '记忆', icon: 'globe' },
    { id: 'logs', label: '日志', icon: 'terminal' },
    { id: '__more', label: '更多', icon: 'more' },
  ];
  const TAB_IDS = new Set(TABS.filter((t) => t.id !== '__more').map((t) => t.id));

  const App = {
    state: {
      route: 'overview',
      config: null,
      status: null,
      system: null,
      tools: [],
      sessions: [],
      channelTab: 'wechat',
      // 各渠道页未保存的草稿，按 tab 分开存：
      // 切 tab 会重渲染整页，只放在 DOM 里的输入值和开关状态会一起没
      channelForm: {},
      logTimer: null,
      memoryItems: [],
      memoryStats: null,
      memoryFilter: 'all',
      memoryQuery: '',
      login: {
        tab: 'qq',
        reachable: null,
        qrcode: '',
        error: '',
        polling: null,
        loggedIn: false,
        account: null,
        wechatQr: '',
      },
      friends: {
        items: [],
        query: '',
        loading: false,
        loaded: false,
      },
      napcat: {
        installed: false,
        running: false,
        starting: false,
        pid: null,
        qqPath: '',
        autoStart: true,
        timer: null,
      },
      onebot: {
        connections: 0,
        clients: [],
        ok: false,
        nickname: '',
        userId: '',
        error: '',
      },
      game: {
        windows: [],
        status: null,
        timer: null,
        goal: '',
        title: '',
        maxRounds: 10,
        dryRun: false,
        cursorRunning: false,
        llm: null,
      },
      mc: {
        status: null,
        frames: null,
        worlds: null,
        timer: null,
      },
    },
    chat: {
      messages: [],
      agentId: '',
      sessionId: '',
      busy: false,
      sessions: [],
      ui: {},
    },
  };

  // ---------------- 导航 ----------------
  function buildNav() {
    const nav = document.getElementById('nav');
    nav.innerHTML = NAV.map((g) => `
      <div class="nav-group">${g.group}</div>
      ${g.items.map((it) => `
        <button class="nav-item ${App.state.route === it.id ? 'active' : ''}" data-route="${it.id}">
          ${icon(it.icon, 17)}<span>${it.label}</span>
        </button>`).join('')}
    `).join('');

    nav.querySelectorAll('[data-route]').forEach((el) => {
      el.addEventListener('click', () => App.navigate(el.dataset.route));
    });
    renderProfile();
    buildTabbar();
  }

  // ---------------- 手机底部导航 / 更多抽屉 ----------------
  function moreRoutes() {
    const out = [];
    for (const g of NAV) for (const it of g.items) if (!TAB_IDS.has(it.id)) out.push(it);
    return out;
  }

  function buildTabbar() {
    if (!window.AIBRIDGE_ANDROID) return;
    const bar = document.getElementById('tabbar');
    if (!bar) return;
    bar.hidden = false;
    const route = App.state.route;
    const moreActive = !TAB_IDS.has(route);
    bar.innerHTML = TABS.map((t) => {
      const active = t.id === '__more' ? moreActive : t.id === route;
      return `<button class="tabbar-item${active ? ' active' : ''}" data-tab="${t.id}">
        ${icon(t.icon, 20)}<span>${t.label}</span>
      </button>`;
    }).join('');
    bar.querySelectorAll('[data-tab]').forEach((el) => {
      el.addEventListener('click', () => {
        const id = el.dataset.tab;
        if (id === '__more') openMoreSheet();
        else { closeMoreSheet(); App.navigate(id); }
      });
    });
  }

  function buildMoreGrid() {
    const grid = document.getElementById('moreGrid');
    if (!grid) return;
    grid.innerHTML = moreRoutes().map((it) => `
      <button class="sheet-item${App.state.route === it.id ? ' active' : ''}" data-more-route="${it.id}">
        ${icon(it.icon, 20)}<span>${escapeHtml(it.label)}</span>
      </button>`).join('');
    grid.querySelectorAll('[data-more-route]').forEach((el) => {
      el.addEventListener('click', () => {
        closeMoreSheet();
        App.navigate(el.dataset.moreRoute);
      });
    });
  }

  function openMoreSheet() {
    const root = document.getElementById('moreSheet');
    if (!root) return;
    buildMoreGrid();
    root.hidden = false;
  }

  function closeMoreSheet() {
    const root = document.getElementById('moreSheet');
    if (root) root.hidden = true;
  }

  /**
   * 左下角的智能体名片：显示当前默认人设和模型。
   * 不放配置项——点击直接进「智能体」页改。
   */
  function renderProfile() {
    const el = document.getElementById('sideProfile');
    if (!el) return;
    const cfg = App.state.config;
    const agents = (cfg && cfg.agents) || [];
    const agent = agents.find((a) => a.enabled !== false) || agents[0];
    if (!agent) {
      el.hidden = true;
      el.innerHTML = '';
      return;
    }
    const provider = ((cfg && cfg.providers) || []).find((p) => p.id === agent.providerId);
    const model = agent.model || provider?.models?.[0] || '';
    const sub = [provider?.name, model].filter(Boolean).join(' · ') || '未配置模型';
    const online = Boolean(App.state.status?.modelConfigured);
    el.hidden = false;
    el.title = agent.greeting || `打开「${agent.name}」`;
    el.innerHTML = `
      <div class="profile-avatar">${escapeHtml(String(agent.name || 'AI').trim().slice(0, 1))}</div>
      <div class="profile-meta">
        <div class="profile-name">${escapeHtml(agent.name || '智能体')}<span class="profile-dot ${online ? 'ok' : ''}"></span></div>
        <div class="profile-sub">${escapeHtml(sub)}</div>
      </div>
      ${icon('arrow', 14)}`;
  }

  App.navigate = function (route) {
    if (window.AIBRIDGE_ANDROID && (route === 'game' || route === 'login')) route = 'overview';
    closeMoreSheet();
    if (App.state.logTimer) { clearInterval(App.state.logTimer); App.state.logTimer = null; }
    if (App.state.login?.polling) { clearInterval(App.state.login.polling); App.state.login.polling = null; }
    App.state.route = route;
    location.hash = `#/${route}`;
    buildNav();
    App.render();
    if (route === 'sessions') App.loadSessions().then(() => App.render());
    if (route === 'chat') App.loadChatSessions();
    if (route === 'memory') App.loadMemory().then(() => App.render());
    if (route === 'friends') App.loadFriends().then(() => App.render());
    if (route === 'login') App.loadNapcat().then(() => App.render());
    if (route === 'game') App.loadGame().then(() => App.render());
    if (route === 'overview') {
      App.fetchSystem().then(() => {
        if (App.state.route === 'overview') App.render();
      }).catch(() => {});
    }
  };

  App.loadGame = async function () {
    const g = App.state.game;
    // 先取状态（快），再取窗口列表（要调 PowerShell，慢），别让慢的拖住首屏
    const s = await api('/api/game/status').catch(() => null);
    if (s) g.status = s;
    const c = await api('/api/game/cursor').catch(() => null);
    g.cursorRunning = Boolean(c?.running);
    const llm = await api('/api/llm/status').catch(() => null);
    if (llm) g.llm = llm;
    const login = await api('/api/mc/login/status').catch(() => null);
    if (login) App.state.mc.login = login;
    const m = await api('/api/mc/status').catch(() => null);
    if (m) App.state.mc.status = m;
    const fr = await api('/api/mc/frames').catch(() => null);
    if (fr) App.state.mc.frames = fr;
    // 进程内 agent 的能力与 jar 版本，决定界面上显示「直连」还是「旧版」
    const ag = await api('/api/mc/agent').catch(() => null);
    if (ag) App.state.mc.agent = ag;
    const worlds = await api('/api/mc/worlds').catch(() => null);
    if (worlds) App.state.mc.worlds = worlds;
    const w = await api('/api/game/windows').catch(() => ({ windows: [] }));
    g.windows = w.windows || [];
  };

  App.render = function () {
    const view = Views[App.state.route] || Views.overview;
    const titleEl = document.getElementById('pageTitle');
    const descEl = document.getElementById('pageDesc');
    const actionsEl = document.getElementById('topbarActions');
    const box = document.getElementById('view');

    titleEl.textContent = view.title;
    descEl.textContent = view.desc;
    actionsEl.innerHTML = view.actions ? view.actions() : '';

    box.className = `view ${view.flush ? 'flush' : ''}`;
    box.innerHTML = view.render();
    if (view.mount) view.mount(box);
  };

  // ---------------- 数据 ----------------
  App.fetchConfig = async function () {
    App.state.config = await api('/api/config');
    return App.state.config;
  };

  App.fetchStatus = async function () {
    App.state.status = await api('/api/status');
    return App.state.status;
  };

  App.fetchSystem = async function () {
    App.state.system = await api('/api/system');
    return App.state.system;
  };

  App.saveConfig = async function () {
    const cfg = App.state.config;
    await api('/api/config', { method: 'PUT', body: cfg });
    await App.fetchStatus().catch(() => {});
    updateStatusPill();
  };

  App.refresh = async function (rerender) {
    try {
      await Promise.all([App.fetchConfig(), App.fetchStatus()]);
      updateStatusPill();
      if (rerender) App.render();
    } catch (err) {
      toast(err.message, 'err');
    }
  };

  App.loadNapcat = async function () {
    const nc = App.state.napcat;
    try {
      Object.assign(nc, await api('/api/napcat/status'));
    } catch (_) { /* 忽略 */ }

    // OneBot 反向 WS 连接状态：这是「能不能收到 QQ 消息」的唯一真实指标
    const ob = App.state.onebot || (App.state.onebot = {});
    try {
      const s = await api('/api/channels/onebot/stats');
      ob.connections = s.connections || 0;
      ob.clients = s.clients || [];
    } catch (_) {
      ob.connections = 0;
    }
    if (ob.connections > 0) {
      try {
        const r = await api('/api/channels/onebot/test', { method: 'POST' });
        ob.ok = Boolean(r.ok);
        ob.nickname = r.nickname || '';
        ob.userId = String(r.userId || '');
        ob.error = r.error || '';
      } catch (err) {
        ob.ok = false;
        ob.error = err.message;
      }
    } else {
      ob.ok = false;
    }
  };

  App.loadFriends = async function () {
    App.state.friends.loading = true;
    try {
      const r = await api('/api/onebot/friends');
      App.state.friends.items = r.items || [];
    } catch (err) {
      toast(err.message, 'err');
      App.state.friends.items = [];
    } finally {
      App.state.friends.loading = false;
    }
  };

  App.loadMemory = async function () {
    try {
      const params = new URLSearchParams();
      if (App.state.memoryQuery) params.set('q', App.state.memoryQuery);
      if (App.state.memoryTier) params.set('tier', App.state.memoryTier);
      if (App.state.memoryTag) params.set('tag', App.state.memoryTag);
      if (App.state.memoryArchived !== undefined && App.state.memoryArchived !== '') {
        params.set('archived', App.state.memoryArchived);
      }
      params.set('limit', '50');
      params.set('offset', String((App.state.memoryPage || 0) * 50));
      const r = await api(`/api/memory?${params.toString()}`);
      App.state.memoryItems = r.items || [];
      App.state.memoryStats = r.stats || { total: 0, byScope: {}, max: 400 };
      App.state.memoryTotal = r.total || 0;
      App.state.memoryCounts = r.counts || null;
    } catch (err) {
      toast(err.message, 'err');
    }
  };

  App.loadSessions = async function () {
    try {
      const r = await api('/api/sessions');
      App.state.sessions = r.sessions || [];
    } catch (_) { /* ignore */ }
  };

  App.fetchLogs = async function () {
    try {
      const r = await api('/api/logs?limit=200');
      return r.logs || [];
    } catch (_) {
      return [];
    }
  };

  App.loadChatSessions = async function () {
    await App.loadSessions();
    App.chat.sessions = App.state.sessions.filter((s) => s.channel === 'web');
    const listBox = document.getElementById('chatSessionList');
    if (listBox) {
      listBox.innerHTML = App.chat.sessions.slice(0, 12).map((s) => `
        <div class="nav-item ${s.id === App.chat.sessionId ? 'active' : ''}" data-session="${escapeHtml(s.id)}" style="font-size:12.5px">
          <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(s.title || '新对话')}</span>
        </div>`).join('') || '<div class="text-sm text-muted" style="padding:4px 10px">暂无记录</div>';
      listBox.querySelectorAll('[data-session]').forEach((el) => {
        el.addEventListener('click', () => App.loadChatSession(el.dataset.session));
      });
    }
  };

  App.loadChatSession = async function (id) {
    try {
      const s = await api(`/api/sessions/${encodeURIComponent(id)}`);
      App.chat.sessionId = id;
      App.chat.agentId = s.agentId || App.chat.agentId;
      App.chat.messages = s.messages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({ role: m.role, content: m.content, tools: [] }));
      const sel = document.getElementById('chatAgent');
      if (sel) sel.value = App.chat.agentId;
      Views.renderMessages();
      App.loadChatSessions();
    } catch (err) {
      toast(err.message, 'err');
    }
  };

  // ---------------- 流式对话 ----------------
  App.sendChat = async function (text) {
    const st = App.chat;
    if (st.busy) return;

    st.messages.push({ role: 'user', content: text });
    const aiMsg = { role: 'assistant', content: '', tools: [], pending: true };
    st.messages.push(aiMsg);
    st.busy = true;

    const meta = document.getElementById('chatMeta');
    const sendBtn = document.getElementById('sendBtn');
    if (meta) meta.textContent = '正在生成…';
    if (sendBtn) sendBtn.disabled = true;

    Views.renderMessages();

    const agentId = st.agentId || App.state.config.agents[0]?.id;

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          channel: 'web',
          userId: 'admin',
          agentId,
          // 带上当前会话：不带的话服务端只能落到默认 web:admin，
          // 用户从左侧挑了历史会话再发一句，消息会写进另一条会话里
          session: st.sessionId || '',
          stream: true,
        }),
      });

      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let idx;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const chunk = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const lines = chunk.split('\n');
          // 事件名是单独一行（event: session），只找 data: 就会把它整帧漏掉
          const evLine = lines.find((l) => l.startsWith('event:'));
          const eventName = evLine ? evLine.slice(6).trim() : '';
          const line = lines.find((l) => l.startsWith('data:'));
          if (!line) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') continue;

          let evt;
          try { evt = JSON.parse(data); } catch (_) { continue; }

          // 会话 id 三种写法都接：命名事件 session、{type:'session'}、老的 {type:'start'}
          if (eventName === 'session' || evt.type === 'session' || evt.type === 'start') {
            const sid = String(evt.session || evt.sessionId || '').trim();
            if (sid && sid !== st.sessionId) {
              st.sessionId = sid;
              // 左侧列表的高亮得立刻跟上，不然用户以为还在旧会话里
              App.loadChatSessions();
            }
            continue;
          }

          if (evt.type === 'delta') {
            aiMsg.pending = false;
            aiMsg.content += evt.text;
            Views.appendToLast();
          } else if (evt.type === 'tool') {
            aiMsg.tools.push(evt.name);
            Views.renderMessages();
          } else if (evt.type === 'memory') {
            aiMsg.memories = evt.count;
            aiMsg.memoryTiers = evt.tiers || null;
            Views.renderMessages();
          } else if (evt.type === 'error') {
            aiMsg.pending = false;
            aiMsg.content = aiMsg.content || `出错了：${evt.message}`;
            Views.renderMessages();
          }
        }
      }

      aiMsg.pending = false;
      if (!aiMsg.content) aiMsg.content = '（没有返回内容）';
      Views.renderMessages();

      if (meta) meta.textContent = '就绪';
      App.loadChatSessions();

      // 语音播报
      if (App.state.config.voice.autoSpeak && aiMsg.content) {
        speak(aiMsg.content);
      }
    } catch (err) {
      aiMsg.pending = false;
      aiMsg.content = aiMsg.content || `请求失败：${err.message}`;
      Views.renderMessages();
      if (meta) meta.textContent = '出错了';
      toast(err.message, 'err');
    } finally {
      st.busy = false;
      if (sendBtn) sendBtn.disabled = false;
    }
  };

  // ---------------- 语音播报 ----------------
  let currentAudio = null;

  async function speak(text) {
    const v = App.state.config.voice;
    const plain = String(text).replace(/```[\s\S]*?```/g, '').replace(/[*#`>]/g, '').slice(0, 500);

    if (v.tts.enabled && v.tts.baseUrl) {
      try {
        const res = await fetch('/api/voice/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: plain }),
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw new Error(j.error || `HTTP ${res.status}`);
        }
        const blob = await res.blob();
        if (currentAudio) { currentAudio.pause(); currentAudio = null; }
        currentAudio = new Audio(URL.createObjectURL(blob));
        await currentAudio.play();
        return;
      } catch (err) {
        if (!v.browserFallback) { toast(`语音合成失败：${err.message}`, 'err'); return; }
      }
    }

    if (v.browserFallback && window.speechSynthesis) {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(plain);
      u.lang = 'zh-CN';
      u.rate = 1;
      window.speechSynthesis.speak(u);
    }
  }

  App.speak = speak;

  // ---------------- 状态指示 ----------------
  function updateStatusPill() {
    const el = document.getElementById('sideStatus');
    if (!el || !App.state.status) return;
    const st = App.state.status;
    const modelOk = st.modelConfigured;
    el.className = `status-pill ${modelOk ? 'ok' : 'bad'}`;
    el.querySelector('.txt').textContent = modelOk
      ? `服务运行中 · ${st.port}`
      : '待配置模型密钥';
    renderProfile();
  }

  // ---------------- 初始化 ----------------
  async function boot() {
    const hash = (location.hash || '').replace(/^#\/?/, '');
    if (hash && Views[hash]) App.state.route = hash;
    if (window.AIBRIDGE_ANDROID && (App.state.route === 'game' || App.state.route === 'login')) App.state.route = 'overview';

    document.getElementById('sideProfile')?.addEventListener('click', () => App.navigate('agents'));
    document.querySelectorAll('[data-sheet-close]').forEach((el) => {
      el.addEventListener('click', closeMoreSheet);
    });
    buildNav();

    try {
      const [, , toolsRes] = await Promise.all([
        App.fetchConfig(),
        App.fetchStatus(),
        api('/api/tools').catch(() => ({ tools: [] })),
        // 首屏就要用到，提前加载好，避免进入「账号接入」时按钮状态是空的
        App.loadNapcat(),
      ]);
      App.state.tools = toolsRes.tools || [];
      App.chat.agentId = App.state.config.agents[0]?.id || '';
      updateStatusPill();
    } catch (err) {
      toast(`加载配置失败：${err.message}`, 'err');
      document.getElementById('view').innerHTML = `<div class="notice warn">${icon('alert')}
        <div>无法连接到服务端。请确认 <code>node server.js</code> 正在运行。<br>${escapeHtml(err.message)}</div></div>`;
      return;
    }

    App.render();
    if (App.state.route === 'chat') App.loadChatSessions();
    if (App.state.route === 'memory') App.loadMemory().then(() => App.render());
    if (App.state.route === 'game') App.loadGame().then(() => App.render());
    if (App.state.route === 'overview') {
      App.fetchSystem().then(() => {
        if (App.state.route === 'overview') App.render();
      }).catch(() => {});
    }

    // 概览页要看到 CPU/内存的实时变化，5 秒拉一次；其他页不打扰服务端
    setInterval(() => {
      if (App.state.route !== 'overview') return;
      Promise.all([App.fetchSystem().catch(() => null), App.fetchStatus().catch(() => null)]).then(() => {
        updateStatusPill();
        const v = document.getElementById('view');
        if (v && App.state.route === 'overview' && !document.querySelector('.modal-mask')) App.render();
      });
    }, 5000);
  }

  window.addEventListener('hashchange', () => {
    const hash = (location.hash || '').replace(/^#\/?/, '');
    if (hash && Views[hash] && hash !== App.state.route) App.navigate(hash);
  });

  window.App = App;
  boot();
})();
