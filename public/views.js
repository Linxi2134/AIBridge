/* AIBridge 前端页面 */
(function () {
  'use strict';
  const { icon, escapeHtml, renderMarkdown, fmtTime, fmtClock, timeAgo, api, toast } = Core;

  // ---------------- 通用表单 helper ----------------
  function field(label, inputHtml, desc) {
    return `<div class="field">
      <label>${label}</label>
      ${inputHtml}
      ${desc ? `<div class="desc">${desc}</div>` : ''}
    </div>`;
  }

  function input(id, value, opts) {
    const o = opts || {};
    return `<input class="input" id="${id}" type="${o.type || 'text'}"
      value="${escapeHtml(value === undefined || value === null ? '' : value)}"
      placeholder="${escapeHtml(o.placeholder || '')}"
      ${o.mono ? 'style="font-family:var(--mono);font-size:12.5px"' : ''}
      ${o.readonly ? 'readonly' : ''}>`;
  }

  function textarea(id, value, opts) {
    const o = opts || {};
    return `<textarea class="textarea" id="${id}" rows="${o.rows || 4}"
      placeholder="${escapeHtml(o.placeholder || '')}"
      ${o.mono ? 'style="font-family:var(--mono);font-size:12.5px"' : ''}>${escapeHtml(value || '')}</textarea>`;
  }

  function select(id, options, value) {
    const opts = options.map((o) => {
      const val = typeof o === 'string' ? o : o.value;
      const label = typeof o === 'string' ? o : o.label;
      return `<option value="${escapeHtml(val)}" ${String(val) === String(value) ? 'selected' : ''}>${escapeHtml(label)}</option>`;
    }).join('');
    return `<select class="select" id="${id}">${opts}</select>`;
  }

  function switchEl(id, on) {
    return `<button class="switch ${on ? 'on' : ''}" id="${id}" role="switch" aria-checked="${on}"></button>`;
  }

  function copyBox(value) {
    return `<div class="copy-box"><span class="val">${escapeHtml(value)}</span>
      <button data-copy="${escapeHtml(value)}">复制</button></div>`;
  }

  function emptyState(title, desc, iconName) {
    return `<div class="empty">${icon(iconName || 'info', 40)}<h4>${escapeHtml(title)}</h4><p>${escapeHtml(desc || '')}</p></div>`;
  }

  // ============================================================
  // 概览
  // ============================================================
  const overview = {
    title: '概览',
    desc: '这台电脑与运行实例的实时状况',
    actions() {
      return `<button class="btn btn-ghost btn-sm" data-act="refresh">${icon('refresh', 14)} 刷新</button>`;
    },
    render() {
      const cfg = App.state.config;
      const st = App.state.status;
      if (!cfg || !st) return emptyState('加载中…', '');

      const sys = App.state.system;
      const host = sys && sys.host;
      const cpu = (host && host.cpu) || {};
      const mem = (host && host.mem) || {};
      const disk = (host && host.disk) || {};
      const instances = (sys && sys.instances) || [];
      const ai = (sys && sys.ai) || {};
      const gb = (n) => (Number(n) || 0) / 1073741824;
      const pctBar = (v, color) => `<div style="height:5px;border-radius:3px;background:var(--surface-3);overflow:hidden;margin-top:9px">
        <div style="width:${Math.max(0, Math.min(100, Number(v) || 0))}%;height:100%;background:${color || 'var(--primary)'};opacity:.85"></div>
      </div>`;
      const memLine = host ? `${gb(mem.used).toFixed(1)} / ${gb(mem.total).toFixed(1)} GB` : '--';
      const diskLine = ((disk.drives || []).map((d) => `${d.mount} ${d.usage}%`).join(' · ')) || '—';
      const onlineCount = instances.filter((i) => i.status === 'ok').length;

      const instanceRows = instances.map((i) => {
        const tag = i.status === 'ok'
          ? `<span class="tag ok">${escapeHtml(i.statusText || '运行中')}</span>`
          : i.status === 'warn'
            ? `<span class="tag warn">${escapeHtml(i.statusText || '异常')}</span>`
            : `<span class="tag">${escapeHtml(i.statusText || '未运行')}</span>`;
        return `<div class="list-row" data-goto="${escapeHtml(i.page || 'overview')}" title="打开详情">
          <div class="avatar" style="background:var(--surface-3);color:var(--text-2);border:1px solid var(--border)">${icon(i.icon || 'server', 15)}</div>
          <div class="grow">
            <div class="name">${escapeHtml(i.name)} ${tag}</div>
            <div class="desc">${escapeHtml(i.detail || '')}</div>
          </div>
          <div class="text-sm text-muted" style="text-align:right;white-space:nowrap">${escapeHtml(i.meta || '')}</div>
        </div>`;
      }).join('');

      return `
      <div class="grid grid-4">
        <div class="stat">
          <div class="label">${icon('cpu', 13)} CPU</div>
          <div class="value">${host ? cpu.usage : '--'}<span style="font-size:14px;color:var(--text-3);font-weight:500"> %</span></div>
          ${pctBar(cpu.usage, 'var(--primary)')}
          <div class="hint">${host ? `${cpu.cores} 核 · ${escapeHtml(String(cpu.model || '').slice(0, 28))}` : '读取中…'}</div>
        </div>
        <div class="stat">
          <div class="label">${icon('server', 13)} 内存</div>
          <div class="value">${host ? mem.usage : '--'}<span style="font-size:14px;color:var(--text-3);font-weight:500"> %</span></div>
          ${pctBar(mem.usage, 'var(--success)')}
          <div class="hint">${memLine}</div>
        </div>
        <div class="stat">
          <div class="label">${icon('history', 13)} 磁盘</div>
          <div class="value">${host && disk.drives && disk.drives.length ? disk.usage : '--'}<span style="font-size:14px;color:var(--text-3);font-weight:500"> %</span></div>
          ${pctBar(disk.usage, 'var(--warn)')}
          <div class="hint">${host ? `${gb(disk.free).toFixed(0)} GB 可用 · ${(disk.drives || []).length} 个盘` : '读取中…'}</div>
        </div>
        <div class="stat">
          <div class="label">${icon('zap', 13)} 在线时长</div>
          <div class="value" style="font-size:22px">${host ? formatUptime(host.uptime) : '--'}</div>
          <div style="height:5px;margin-top:9px"></div>
          <div class="hint">${host ? `网关 ${formatUptime(host.gateway.uptime)} · PID ${host.gateway.pid}` : '读取中…'}</div>
        </div>
      </div>

      <div class="grid grid-2 mt-4" style="align-items:start">
        <div class="card">
          <div class="card-head"><h3>这台电脑</h3><span class="sub">${host ? `采样于 ${fmtClock(sys.ts)}` : '读取中…'}</span></div>
          <div class="card-body">
            ${host ? `<div class="kv">
              <div class="kv-row"><span class="k">主机名</span><span class="v mono">${escapeHtml(host.hostname)}</span></div>
              <div class="kv-row"><span class="k">系统</span><span class="v">${escapeHtml(host.version || `${host.platform} ${host.release}`)} · ${escapeHtml(host.arch)}</span></div>
              <div class="kv-row"><span class="k">处理器</span><span class="v">${escapeHtml(host.cpu.model)} · ${host.cpu.cores} 核</span></div>
              <div class="kv-row"><span class="k">内存</span><span class="v">${memLine}</span></div>
              <div class="kv-row"><span class="k">磁盘</span><span class="v" title="${escapeHtml(diskLine)}">${escapeHtml(diskLine)}</span></div>
              <div class="kv-row"><span class="k">局域网 IP</span><span class="v mono">${escapeHtml(host.ip || '未连接')}</span></div>
              <div class="kv-row"><span class="k">网关占用</span><span class="v">${(host.gateway.rss / 1048576).toFixed(0)} MB · ${escapeHtml(host.gateway.node)}</span></div>
              <div class="kv-row"><span class="k">本地时间</span><span class="v">${fmtClock(Date.now())}</span></div>
            </div>` : emptyState('读取中…', '正在采样 CPU 与磁盘')}
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h3>运行实例</h3><span class="sub">${onlineCount} / ${instances.length} 在线</span></div>
          <div class="list">${instanceRows || emptyState('没有实例', '')}</div>
          <div class="card-body" style="border-top:1px solid var(--border)">
            <div class="kv">
              <div class="kv-row"><span class="k">模型服务</span><span class="v">${ai.modelConfigured ? '已配置' : '待配置'} · ${ai.agents || 0} 个智能体</span></div>
              <div class="kv-row"><span class="k">渠道</span><span class="v">${ai.channels || 0} / 4 已启用${ai.onebotConnections ? ` · OneBot ${ai.onebotConnections} 个连接` : ''}</span></div>
              <div class="kv-row"><span class="k">会话 / 消息</span><span class="v">${ai.sessions || 0} / ${ai.messages || 0}</span></div>
              <div class="kv-row"><span class="k">长期记忆</span><span class="v">${ai.memory || 0} 条</span></div>
            </div>
          </div>
        </div>
      </div>

      ${!st.modelConfigured ? `<div class="notice warn mt-4">${icon('alert')}
        <div><strong>还没有配置模型密钥。</strong>前往「模型」页填写 API Key，否则对话与渠道消息都无法生成回复。</div>
      </div>` : ''}
      `;
    },
    mount(root) {
      root.querySelectorAll('[data-goto]').forEach((el) => {
        el.style.cursor = 'pointer';
        el.addEventListener('click', () => App.navigate(el.dataset.goto));
      });
      const btn = document.querySelector('[data-act="refresh"]');
      if (btn) btn.addEventListener('click', async () => {
        await Promise.all([App.fetchSystem().catch(() => null), App.refresh(false).catch(() => null)]);
        App.render();
      });
    },
  };

  function formatUptime(sec) {
    if (sec < 60) return `${sec} 秒`;
    if (sec < 3600) return `${Math.floor(sec / 60)} 分钟`;
    if (sec < 86400) return `${Math.floor(sec / 3600)} 小时 ${Math.floor((sec % 3600) / 60)} 分`;
    return `${Math.floor(sec / 86400)} 天`;
  }

  // ============================================================
  // 对话
  // ============================================================
  const chat = {
    title: '对话',
    desc: '直接在网页里测试智能体，支持语音输入与播报',
    flush: true,
    actions() {
      const st = App.state.status;
      const on = App.state.config?.voice?.autoSpeak;
      return `
        <button class="btn btn-ghost btn-sm" data-act="voice-toggle">
          ${icon('volume', 14)} ${on ? '语音播报已开' : '语音播报已关'}
        </button>
        <button class="btn btn-ghost btn-sm" data-act="clear">${icon('trash', 14)} 清空</button>`;
    },
    render() {
      const cfg = App.state.config;
      const agents = cfg.agents.filter((a) => a.enabled !== false);
      const curAgent = App.chat.agentId || agents[0]?.id || '';

      const agentOptions = agents
        .map((a) => `<option value="${escapeHtml(a.id)}" ${a.id === curAgent ? 'selected' : ''}>${escapeHtml(a.name)}</option>`)
        .join('');
      const sessionList = App.chat.sessions.slice(0, 12).map((s) => `
        <div class="nav-item ${s.id === App.chat.sessionId ? 'active' : ''}" data-session="${escapeHtml(s.id)}" style="font-size:12.5px">
          <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(s.title || '新对话')}</span>
        </div>`).join('');

      return `
      <div class="chat-wrap">
        <div class="chat-side">
          <div>
            <h4 style="margin-bottom:8px">当前智能体</h4>
            <select class="select" id="chatAgent" style="font-size:13px">${agentOptions || '<option value="">无可用智能体</option>'}</select>
          </div>
          <button class="btn btn-ghost btn-sm" data-act="new-chat" style="width:100%">${icon('plus', 14)} 新建对话</button>
          <div style="flex:1;min-height:0">
            <h4 style="margin-bottom:8px">最近对话</h4>
            <div id="chatSessionList" style="display:flex;flex-direction:column;gap:2px">${sessionList || '<div class="text-sm text-muted" style="padding:4px 10px">暂无记录</div>'}</div>
          </div>
        </div>

        <div class="chat-main">
          <div class="chat-head">
            <div class="grow">
              <div class="title">${escapeHtml(agents.find((a) => a.id === curAgent)?.name || '未选择智能体')}</div>
              <div class="meta" id="chatMeta">${App.chat.busy ? '正在生成…' : '就绪'}</div>
            </div>
            <span class="tag info" id="chatModelTag">${escapeHtml(modelLabel(agents.find((a) => a.id === curAgent)))}</span>
          </div>

          <div class="messages" id="messages"></div>

          <div class="chat-input">
            <div class="input-box">
              <textarea id="chatInput" rows="1" placeholder="输入消息，Enter 发送 / Shift+Enter 换行"></textarea>
              <button class="mic-btn" id="micBtn" title="按住说话">${icon('mic')}</button>
              <button class="send-btn" id="sendBtn" title="发送">${icon('send')}</button>
            </div>
            <div class="chat-foot">
              <span id="voiceHint">${voiceStatusText()}</span>
              <span class="grow"></span>
              <span>Enter 发送 · Shift+Enter 换行</span>
            </div>
          </div>
        </div>
      </div>`;
    },
    mount(root) {
      const inputEl = root.querySelector('#chatInput');
      const sendBtn = root.querySelector('#sendBtn');
      const micBtn = root.querySelector('#micBtn');
      const msgBox = root.querySelector('#messages');
      const meta = root.querySelector('#chatMeta');

      App.chat.ui = { inputEl, sendBtn, micBtn, msgBox, meta };

      renderMessages();

      root.querySelector('#chatAgent').addEventListener('change', (e) => {
        App.chat.agentId = e.target.value;
        const a = App.state.config.agents.find((x) => x.id === e.target.value);
        root.querySelector('.chat-head .title').textContent = a?.name || '';
        root.querySelector('#chatModelTag').textContent = modelLabel(a);
      });

      inputEl.addEventListener('input', () => {
        inputEl.style.height = 'auto';
        inputEl.style.height = `${Math.min(inputEl.scrollHeight, 150)}px`;
      });

      inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          doSend();
        }
      });

      sendBtn.addEventListener('click', doSend);
      micBtn.addEventListener('click', toggleRecord);

      msgBox.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-speak]');
        if (!btn) return;
        const m = App.chat.messages[Number(btn.dataset.speak)];
        if (m?.content) App.speak(m.content);
      });

      root.querySelector('[data-act="new-chat"]')?.addEventListener('click', () => {
        App.chat.messages = [];
        App.chat.sessionId = '';
        App.loadChatSessions();
        renderMessages();
      });

      root.querySelectorAll('[data-session]').forEach((el) => {
        el.addEventListener('click', () => App.loadChatSession(el.dataset.session));
      });

      const clearBtn = document.querySelector('[data-act="clear"]');
      if (clearBtn) {
        clearBtn.addEventListener('click', async () => {
          if (!(await Core.confirmDialog({ title: '清空对话', message: '仅清空当前网页中的对话内容，历史会话仍保留在「会话」页。', confirmText: '清空' }))) return;
          App.chat.messages = [];
          renderMessages();
        });
      }

      const vBtn = document.querySelector('[data-act="voice-toggle"]');
      if (vBtn) {
        vBtn.addEventListener('click', () => {
          const cfg = App.state.config;
          cfg.voice.autoSpeak = !cfg.voice.autoSpeak;
          App.saveConfig().then(() => {
            vBtn.innerHTML = `${icon('volume', 14)} ${cfg.voice.autoSpeak ? '语音播报已开' : '语音播报已关'}`;
            const hint = root.querySelector('#voiceHint');
            if (hint) hint.textContent = voiceStatusText();
          });
        });
      }

      // ---- 发送 ----
      async function doSend() {
        const text = inputEl.value.trim();
        if (!text || App.chat.busy) return;
        inputEl.value = '';
        inputEl.style.height = 'auto';
        await App.sendChat(text);
      }

      // ---- 录音 ----
      let recorder = null;
      let chunks = [];
      let recStream = null;
      let browserRec = null;

      /** 浏览器内置语音识别（无 STT 服务时的兜底） */
      function startBrowserSTT() {
        const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SR) {
          toast('当前浏览器不支持内置语音识别，请在「语音」页配置 STT 服务', 'err');
          return;
        }
        try {
          const rec = new SR();
          browserRec = rec;
          rec.lang = 'zh-CN';
          rec.interimResults = false;
          rec.maxAlternatives = 1;
          rec.onstart = () => {
            micBtn.classList.add('recording');
            meta.textContent = '正在聆听…再次点击结束';
          };
          rec.onresult = (e) => {
            const text = e.results[0][0].transcript;
            inputEl.value = text;
            inputEl.focus();
            inputEl.dispatchEvent(new Event('input'));
            meta.textContent = '识别完成，确认后发送';
          };
          rec.onerror = (e) => {
            micBtn.classList.remove('recording');
            meta.textContent = '就绪';
            if (e.error === 'not-allowed') toast('麦克风权限被拒绝', 'err');
            else if (e.error === 'network') toast('浏览器语音识别需要联网，建议配置 STT 服务', 'err');
            else if (e.error !== 'aborted') toast(`识别失败：${e.error}`, 'err');
          };
          rec.onend = () => { micBtn.classList.remove('recording'); browserRec = null; };
          rec.start();
        } catch (err) {
          toast(`无法启动语音识别：${err.message}`, 'err');
        }
      }

      async function toggleRecord() {
        if (browserRec) {
          browserRec.stop();
          return;
        }
        if (recorder && recorder.state === 'recording') {
          recorder.stop();
          return;
        }
        // 未配置 STT 时优先用浏览器内置识别
        if (!App.state.config.voice.stt.enabled && App.state.config.voice.browserFallback) {
          startBrowserSTT();
          return;
        }
        if (!navigator.mediaDevices?.getUserMedia) {
          toast('当前浏览器不支持录音，请使用 Chrome / Edge', 'err');
          return;
        }
        try {
          recStream = await navigator.mediaDevices.getUserMedia({ audio: true });
          chunks = [];
          const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
            ? 'audio/webm;codecs=opus'
            : 'audio/webm';
          recorder = new MediaRecorder(recStream, { mimeType: mime });
          recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
          recorder.onstop = async () => {
            micBtn.classList.remove('recording');
            meta.textContent = '正在识别语音…';
            recStream?.getTracks().forEach((t) => t.stop());
            const blob = new Blob(chunks, { type: 'audio/webm' });
            if (blob.size < 800) { meta.textContent = '就绪'; return; }

            const sttEnabled = App.state.config.voice.stt.enabled;
            if (!sttEnabled) {
              meta.textContent = '就绪';
              toast('语音识别未启用，请先在「语音」页配置', 'err');
              return;
            }
            try {
              const res = await fetch('/api/voice/stt', {
                method: 'POST',
                headers: { 'Content-Type': 'audio/webm' },
                body: blob,
              });
              const json = await res.json();
              if (!res.ok) throw new Error(json.error || '识别失败');
              if (json.text) {
                inputEl.value = json.text;
                inputEl.focus();
                inputEl.dispatchEvent(new Event('input'));
                meta.textContent = '识别完成，确认后发送';
              } else {
                toast('没有识别到内容', 'err');
                meta.textContent = '就绪';
              }
            } catch (err) {
              toast(`语音识别失败：${err.message}`, 'err');
              meta.textContent = '就绪';
            }
          };
          recorder.start();
          micBtn.classList.add('recording');
          meta.textContent = '录音中…再次点击结束';
        } catch (err) {
          toast(`无法访问麦克风：${err.message}`, 'err');
        }
      }
    },
  };

  function modelLabel(agent) {
    if (!agent) return '—';
    const p = App.state.config.providers.find((x) => x.id === agent.providerId);
    return `${p?.name || '未知服务'} · ${agent.model || '默认模型'}`;
  }

  function voiceStatusText() {
    const v = App.state.config.voice;
    const stt = v.stt.enabled ? '语音输入已就绪' : '语音输入未启用';
    const tts = v.tts.enabled ? '播报已启用' : '播报未启用';
    return `${stt} · ${tts}`;
  }

  function renderMessages() {
    const box = App.chat.ui?.msgBox || document.getElementById('messages');
    if (!box) return;
    const list = App.chat.messages;
    if (!list.length) {
      const agent = App.state.config.agents.find((a) => a.id === (App.chat.agentId || App.state.config.agents[0]?.id));
      box.innerHTML = `<div class="empty" style="margin:auto">
        ${icon('chat', 40)}
        <h4>${escapeHtml(agent?.name || '开始对话')}</h4>
        <p>${escapeHtml(agent?.greeting || '输入消息开始，或点击麦克风说话')}</p>
      </div>`;
      return;
    }
    box.innerHTML = list.map((m, i) => {
      if (m.role === 'user') {
        return `<div class="msg user"><div class="avatar me">我</div><div class="bubble">${escapeHtml(m.content)}</div></div>`;
      }
      const tools = (m.tools || []).map((t) => {
        const meta = (App.state.tools || []).find((x) => x.name === t);
        return `<div class="tool-chip">${icon('zap', 12)} ${escapeHtml(meta?.label || t)}</div>`;
      }).join('');
      const canSpeak = !m.pending && m.content;
      const memChip = m.memories
        ? `<div class="tool-chip mem" title="按记忆强度分档注入，模糊的会提示模型先确认">${icon('globe', 12)} 召回 ${m.memories} 条记忆${
          m.memoryTiers
            ? `<span style="opacity:.7;margin-left:4px">清晰${m.memoryTiers.clear || 0} · 模糊${m.memoryTiers.fuzzy || 0}${m.memoryTiers.vague ? ` · 隐约${m.memoryTiers.vague}` : ''}</span>`
            : ''
        }</div>`
        : '';
      return `<div class="msg ai"><div class="avatar ai">AI</div>
        <div style="display:flex;flex-direction:column;align-items:flex-start">
          ${memChip}${tools}
          <div class="bubble">${m.pending && !m.content ? '<span class="typing-dot"></span>' : renderMarkdown(m.content || '')}</div>
          ${canSpeak ? `<button class="speak-btn" data-speak="${i}" title="朗读这条回复">${icon('volume', 11)} 朗读</button>` : ''}
        </div>
      </div>`;
    }).join('');
    box.scrollTop = box.scrollHeight;
  }

  function appendToLast(text) {
    const box = App.chat.ui?.msgBox;
    if (!box) return;
    const bubbles = box.querySelectorAll('.msg.ai .bubble');
    const last = bubbles[bubbles.length - 1];
    if (last) {
      const lastMsg = App.chat.messages[App.chat.messages.length - 1];
      last.innerHTML = renderMarkdown(lastMsg.content || '');
      box.scrollTop = box.scrollHeight;
    }
  }

  // ---------------- 渠道编辑态 ----------------
  /**
   * 渠道页每个字段的编辑值都存在视图状态里，DOM 只是它的投影。
   * 改之前开关状态只写在按钮的 class 上、保存时再回头读 DOM，
   * 所以切页签（= 重新渲染）就把还没保存的改动全冲掉了。
   */
  function chState(tab) {
    if (!App.state.channelForm) App.state.channelForm = {};
    if (!App.state.channelForm[tab]) App.state.channelForm[tab] = {};
    return App.state.channelForm[tab];
  }

  /** 取字段值：状态里没有（没改过）才回落到配置值 */
  function chVal(tab, id, fallback) {
    const f = App.state.channelForm?.[tab];
    if (f && Object.prototype.hasOwnProperty.call(f, id)) return f[id];
    return fallback === undefined || fallback === null ? '' : fallback;
  }

  /** 取开关值：状态里没有才回落到配置里的布尔 */
  function chOn(tab, id, fallback) {
    const f = App.state.channelForm?.[tab];
    return f && Object.prototype.hasOwnProperty.call(f, id) ? Boolean(f[id]) : Boolean(fallback);
  }

  function chSet(tab, id, value) {
    chState(tab)[id] = value;
  }

  // ============================================================
  // 渠道
  // ============================================================
  const channels = {
    title: '渠道接入',
    desc: '把微信、企业微信、QQ 接到同一套 AI 能力上',
    actions() {
      return `<button class="btn btn-primary btn-sm" data-act="save-channels">${icon('check', 14)} 保存配置</button>`;
    },
    render() {
      const tab = App.state.channelTab || 'wechat';
      const tabs = [
        { id: 'wechat', label: '微信公众号', icon: 'wechat' },
        { id: 'wecom', label: '企业微信', icon: 'server' },
        { id: 'qq', label: 'QQ 官方机器人', icon: 'qq' },
        { id: 'onebot', label: 'OneBot 11', icon: 'terminal' },
      ];
      return `
      <div class="card mb-3">
        <div style="display:flex;gap:4px;padding:6px;background:var(--surface-2);border-radius:var(--radius)">
          ${tabs.map((t) => `<button class="btn btn-sm ${tab === t.id ? 'btn-primary' : 'btn-ghost'}"
            style="${tab === t.id ? '' : 'background:transparent;border-color:transparent'}"
            data-tab="${t.id}">${icon(t.icon, 14)} ${t.label}</button>`).join('')}
        </div>
      </div>
      <div id="channelPanel">${renderChannelPanel(tab)}</div>`;
    },
    mount(root) {
      const tab = App.state.channelTab || 'wechat';
      root.querySelectorAll('[data-tab]').forEach((el) => {
        el.addEventListener('click', () => {
          // 只切页签：各字段的值早就在视图状态里，重渲染自然带过去
          App.state.channelTab = el.dataset.tab;
          App.render();
        });
      });

      const panel = root.querySelector('#channelPanel');

      // 输入即写回状态，切页签、保存后重渲染都不会丢改动
      const syncInput = (e) => {
        const el = e.target;
        if (el && el.id && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) chSet(tab, el.id, el.value);
      };
      panel.addEventListener('input', syncInput);
      panel.addEventListener('change', syncInput);

      panel.querySelectorAll('.switch').forEach((sw) => {
        sw.addEventListener('click', () => {
          // 开关真相在状态里，class 只负责显示
          const on = !chOn(tab, sw.id, sw.classList.contains('on'));
          chSet(tab, sw.id, on);
          sw.classList.toggle('on', on);
          sw.setAttribute('aria-checked', String(on));
          if (sw.id === 'sw-enable') {
            const badge = sw.closest('.card-head')?.querySelector('.tag');
            if (badge) {
              badge.textContent = on ? '已启用' : '未启用';
              badge.className = `tag ${on ? 'ok' : ''}`;
            }
          }
        });
      });

      document.querySelector('[data-act="save-channels"]')?.addEventListener('click', async () => {
        const cfg = App.state.config;
        // 优先读视图状态；没动过的字段回落到 DOM，等价于配置原值
        const get = (id) => chVal(tab, id, panel.querySelector(`#${id}`)?.value ?? '');
        const isOn = (id) => chOn(tab, id, panel.querySelector(`#${id}`)?.classList.contains('on'));

        if (tab === 'wechat') {
          cfg.channels.wechat = {
            ...cfg.channels.wechat,
            enabled: isOn('sw-enable'),
            appId: get('wx-appid').trim(),
            appSecret: get('wx-secret').trim(),
            token: get('wx-token').trim(),
            encodingAesKey: get('wx-aes').trim(),
            mode: 'plain',
          };
        } else if (tab === 'wecom') {
          cfg.channels.wecom = {
            ...cfg.channels.wecom,
            enabled: isOn('sw-enable'),
            corpId: get('wc-corp').trim(),
            agentId: get('wc-agent').trim(),
            secret: get('wc-secret').trim(),
            token: get('wc-token').trim(),
            encodingAesKey: get('wc-aes').trim(),
          };
        } else if (tab === 'onebot') {
          cfg.channels.onebot = {
            ...cfg.channels.onebot,
            enabled: isOn('sw-enable'),
            apiBase: get('ob-api').trim(),
            token: get('ob-token').trim(),
            selfId: get('ob-self').trim(),
            groupAtOnly: isOn('sw-group-at'),
            privateReply: isOn('sw-private'),
            replyAt: isOn('sw-reply-at'),
          };
        } else {
          cfg.channels.qq = {
            ...cfg.channels.qq,
            enabled: isOn('sw-enable'),
            appId: get('qq-appid').trim(),
            appSecret: get('qq-secret').trim(),
            token: get('qq-token').trim(),
            sandbox: isOn('sw-sandbox'),
          };
        }
        await App.saveConfig();
        // 存好了就以服务端返回的配置为准，别让旧草稿盖住刚保存的结果
        if (App.state.channelForm) delete App.state.channelForm[tab];
        toast('渠道配置已保存', 'ok');
        App.render();
      });

      panel.querySelector('[data-act="test-onebot"]')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.innerHTML = '<span class="loading-inline" style="border-color:rgba(67,97,238,.25);border-top-color:var(--primary)"></span> 连接中…';
        try {
          const r = await api('/api/channels/onebot/test', {
            method: 'POST',
            body: {
              apiBase: panel.querySelector('#ob-api').value.trim(),
              token: panel.querySelector('#ob-token').value.trim(),
            },
          });
          if (r.ok) {
            const via = r.via === 'websocket' ? 'WebSocket' : 'HTTP';
            toast(`连接成功 · ${r.nickname || '未知昵称'} (${r.userId || '—'}) · 经 ${via}`, 'ok');
          } else {
            toast(`连接失败：${r.error}`, 'err');
          }
        } catch (err) {
          toast(err.message, 'err');
        } finally {
          btn.disabled = false;
          btn.innerHTML = `${icon('zap', 14)} 测试连接`;
        }
      });
    },
  };

  function baseUrl() {
    const cfg = App.state.config;
    if (cfg.server.publicUrl) return cfg.server.publicUrl.replace(/\/+$/, '');
    return `http://localhost:${App.state.status?.port || cfg.server.port}`;
  }

  /** 反向 WebSocket 地址：http→ws，https→wss */
  function wsUrl() {
    return `${baseUrl().replace(/^http/, 'ws')}/ws/onebot`;
  }

  function renderChannelPanel(tab) {
    const cfg = App.state.config.channels;
    if (tab === 'wechat') {
      const c = cfg.wechat;
      // 状态里有改动就用改动，没有才用配置；否则切页签回来又变回旧值
      const en = chOn(tab, 'sw-enable', c.enabled);
      return `
      <div class="grid grid-2" style="align-items:start">
        <div class="card">
          <div class="card-head">
            <h3>微信公众号</h3>
            <span class="tag ${en ? 'ok' : ''}">${en ? '已启用' : '未启用'}</span>
            <div style="margin-left:auto">${switchEl('sw-enable', en)}</div>
          </div>
          <div class="card-body">
            ${field('AppID', input('wx-appid', chVal(tab, 'wx-appid', c.appId), { placeholder: 'wx开头的18位字符', mono: true }))}
            ${field('AppSecret', input('wx-secret', chVal(tab, 'wx-secret', c.appSecret), { placeholder: '公众号后台 → 基本配置', mono: true, type: 'password' }))}
            ${field('Token', input('wx-token', chVal(tab, 'wx-token', c.token), { placeholder: '自定义，需与后台填写一致', mono: true }), '用于校验回调签名，建议 16 位以上随机字符串')}
            ${field('EncodingAESKey', input('wx-aes', chVal(tab, 'wx-aes', c.encodingAesKey), { placeholder: '明文模式可留空', mono: true }), '后台选「安全模式」时必填（43 位），已支持密文收发；留空走明文')}
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h3>接入步骤</h3></div>
          <div class="card-body">
            <div class="section-title">回调地址</div>
            ${copyBox(`${baseUrl()}/hook/wechat`)}
            <div class="notice info mt-3">${icon('info')}
              <div>填入公众号后台「设置与开发 → 基本配置 → 服务器配置」。消息加解密方式请选择<strong>明文模式</strong>，Token 与上方保持一致。</div>
            </div>
            <hr class="hr">
            <div class="steps">
              <div class="step"><div class="num">1</div><div class="body"><strong>准备公网地址</strong><p>微信要求 80/443 端口的公网域名。本地调试可用内网穿透（如 cpolar、frp、ngrok），把公网地址填到下方「设置 → 公网地址」。</p></div></div>
              <div class="step"><div class="num">2</div><div class="body"><strong>填写服务器配置</strong><p>URL 填上方回调地址，Token 与页面一致，EncodingAESKey 可随机生成。</p></div></div>
              <div class="step"><div class="num">3</div><div class="body"><strong>启用并验证</strong><p>先打开上方「已启用」开关并保存，再点公众号后台的「提交」，验证通过即接入成功。</p></div></div>
              <div class="step"><div class="num">4</div><div class="body"><strong>开启语音识别（可选）</strong><p>公众号后台「功能设置」中开启语音识别，用户发语音时会自动转成文字送入模型。</p></div></div>
            </div>
          </div>
        </div>
      </div>`;
    }

    if (tab === 'wecom') {
      const c = cfg.wecom;
      const en = chOn(tab, 'sw-enable', c.enabled);
      return `
      <div class="grid grid-2" style="align-items:start">
        <div class="card">
          <div class="card-head">
            <h3>企业微信自建应用</h3>
            <span class="tag ${en ? 'ok' : ''}">${en ? '已启用' : '未启用'}</span>
            <div style="margin-left:auto">${switchEl('sw-enable', en)}</div>
          </div>
          <div class="card-body">
            ${field('企业 ID (CorpID)', input('wc-corp', chVal(tab, 'wc-corp', c.corpId), { placeholder: 'ww开头的字符', mono: true }))}
            ${field('应用 AgentId', input('wc-agent', chVal(tab, 'wc-agent', c.agentId), { placeholder: '应用详情页可见', mono: true }))}
            ${field('应用 Secret', input('wc-secret', chVal(tab, 'wc-secret', c.secret), { placeholder: '应用详情页可见', mono: true, type: 'password' }))}
            ${field('Token', input('wc-token', chVal(tab, 'wc-token', c.token), { placeholder: '接收消息设置中自定义', mono: true }))}
            ${field('EncodingAESKey', input('wc-aes', chVal(tab, 'wc-aes', c.encodingAesKey), { placeholder: '43 位字符，必填', mono: true }), '企业微信强制加密，此项必填')}
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h3>接入步骤</h3></div>
          <div class="card-body">
            <div class="section-title">回调地址</div>
            ${copyBox(`${baseUrl()}/hook/wecom`)}
            <div class="notice info mt-3">${icon('info')}
              <div>企业微信要求回调地址可公网访问。系统已完整实现 AES-256-CBC 解密与签名校验。</div>
            </div>
            <hr class="hr">
            <div class="steps">
              <div class="step"><div class="num">1</div><div class="body"><strong>创建自建应用</strong><p>企业微信管理后台 → 应用管理 → 自建 → 创建应用，记录 AgentId 与 Secret。</p></div></div>
              <div class="step"><div class="num">2</div><div class="body"><strong>配置接收消息</strong><p>进入应用 → 接收消息 → 设置 API 接收，URL 填上方地址，随机获取 Token 与 EncodingAESKey。</p></div></div>
              <div class="step"><div class="num">3</div><div class="body"><strong>填入并保存</strong><p>把 Token / EncodingAESKey / CorpID / AgentId / Secret 填入左侧，打开开关后保存。</p></div></div>
              <div class="step"><div class="num">4</div><div class="body"><strong>可见范围</strong><p>在应用「可见范围」中加入需要使用机器人的成员或部门。</p></div></div>
            </div>
          </div>
        </div>
      </div>`;
    }

    if (tab === 'onebot') {
      const c = cfg.onebot;
      const en = chOn(tab, 'sw-enable', c.enabled);
      const ob = App.state.status?.onebot || { connections: 0, clients: [] };
      const connTag = ob.connections > 0
        ? `<span class="tag ok">WebSocket 已连 ${ob.connections} 个</span>`
        : '<span class="tag">WebSocket 未连接</span>';

      return `
      <div class="grid grid-2" style="align-items:start">
        <div class="card">
          <div class="card-head">
            <h3>OneBot 11</h3>
            <span class="tag ${en ? 'ok' : ''}">${en ? '已启用' : '未启用'}</span>
            <div style="margin-left:auto">${switchEl('sw-enable', en)}</div>
          </div>
          <div class="card-body">
            <div class="flex items-center gap-2 mb-3" style="flex-wrap:wrap">
              ${connTag}
              <span class="text-sm text-muted">兼容 NapCat / LLOneBot / Lagrange / go-cqhttp / Shamrock</span>
            </div>
            ${field('HTTP API 地址', input('ob-api', chVal(tab, 'ob-api', c.apiBase), { placeholder: 'http://127.0.0.1:3000', mono: true }), '实现端的 HTTP 服务器地址。只用 WebSocket 时可不填')}
            ${field('Access Token', input('ob-token', chVal(tab, 'ob-token', c.token), { placeholder: '实现端设置的 token，留空表示不校验', mono: true, type: 'password' }), '同时用于上报鉴权与 API 调用')}
            ${field('机器人 QQ 号', input('ob-self', chVal(tab, 'ob-self', c.selfId), { placeholder: '可选。多账号时用于精确路由', mono: true }))}
            <div class="switch-row">
              ${switchEl('sw-group-at', chOn(tab, 'sw-group-at', c.groupAtOnly !== false))}
              <div><div class="label">群聊仅在被 @ 时回复</div><div class="hint">关闭后响应群内所有消息，注意调用成本</div></div>
            </div>
            <div class="switch-row" style="border-top:1px solid var(--border)">
              ${switchEl('sw-private', chOn(tab, 'sw-private', c.privateReply !== false))}
              <div><div class="label">响应私聊消息</div><div class="hint">关闭后只处理群聊</div></div>
            </div>
            <div class="switch-row" style="border-top:1px solid var(--border)">
              ${switchEl('sw-reply-at', chOn(tab, 'sw-reply-at', c.replyAt !== false))}
              <div><div class="label">群聊回复时 @ 提问者</div><div class="hint">让对方能收到提醒</div></div>
            </div>
            <button class="btn btn-soft mt-3" data-act="test-onebot">${icon('zap', 14)} 测试连接</button>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h3>两种接法，任选其一</h3></div>
          <div class="card-body">
            <div class="section-title">方式一 · 反向 WebSocket（推荐）</div>
            ${copyBox(wsUrl())}
            <div class="desc" style="margin-top:6px">填到实现端的「WebSocket 客户端 / 反向 WS」地址。长连接，延迟更低，不需要暴露 HTTP API 端口。</div>

            <hr class="hr">

            <div class="section-title">方式二 · HTTP 上报</div>
            ${copyBox(`${baseUrl()}/hook/onebot`)}
            <div class="desc" style="margin-top:6px">填到实现端的「HTTP 上报 / Webhook」地址。每条消息一次 POST，需能访问到本服务。</div>

            <div class="notice info mt-3">${icon('info')}
              <div>两种方式可以同时开。系统优先用 WebSocket 发消息，连不上时自动回退 HTTP API。</div>
            </div>

            <hr class="hr">
            <div class="steps">
              <div class="step"><div class="num">1</div><div class="body"><strong>实现端设 Token</strong><p>在 NapCat / LLOneBot 等实现里设置 Access Token，填到左侧，用于双向鉴权。</p></div></div>
              <div class="step"><div class="num">2</div><div class="body"><strong>配连接地址</strong><p>反向 WS 填上方第一个地址，HTTP 上报填第二个。同机可用 127.0.0.1，跨机要填对方能访问到的地址。</p></div></div>
              <div class="step"><div class="num">3</div><div class="body"><strong>启用并验证</strong><p>打开开关保存。用 WS 时页面会显示连接数；点「测试连接」能拿到机器人昵称即成功。</p></div></div>
            </div>

            <div class="notice warn mt-3">${icon('alert')}
              <div>OneBot 11 是社区协议，各类实现都基于非官方途径，用个人号接入存在账号风险，请自行评估。</div>
            </div>
          </div>
        </div>
      </div>`;
    }

    const c = cfg.qq;
    const en = chOn(tab, 'sw-enable', c.enabled);
    return `
    <div class="grid grid-2" style="align-items:start">
      <div class="card">
        <div class="card-head">
          <h3>QQ 机器人</h3>
          <span class="tag ${en ? 'ok' : ''}">${en ? '已启用' : '未启用'}</span>
          <div style="margin-left:auto">${switchEl('sw-enable', en)}</div>
        </div>
        <div class="card-body">
          ${field('AppID', input('qq-appid', chVal(tab, 'qq-appid', c.appId), { placeholder: '机器人后台 → 开发设置', mono: true }))}
          ${field('AppSecret', input('qq-secret', chVal(tab, 'qq-secret', c.appSecret), { placeholder: '用于 Ed25519 签名校验', mono: true, type: 'password' }))}
          ${field('Token', input('qq-token', chVal(tab, 'qq-token', c.token), { placeholder: '预留字段，可留空', mono: true }))}
          <div class="switch-row">
            ${switchEl('sw-sandbox', chOn(tab, 'sw-sandbox', c.sandbox))}
            <div><div class="label">沙箱环境</div><div class="hint">调试阶段可开启，使用 sandbox.api.sgroup.qq.com</div></div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h3>接入步骤</h3></div>
        <div class="card-body">
          <div class="section-title">回调地址</div>
          ${copyBox(`${baseUrl()}/hook/qq`)}
          <div class="notice info mt-3">${icon('info')}
            <div>QQ 开放平台使用 <strong>Ed25519</strong> 签名校验回调。系统会用 AppSecret 派生密钥对自动完成验证与应答。</div>
          </div>
          <hr class="hr">
          <div class="steps">
            <div class="step"><div class="num">1</div><div class="body"><strong>注册机器人</strong><p>前往 q.qq.com 创建机器人，完成主体认证，获取 AppID 与 AppSecret。</p></div></div>
            <div class="step"><div class="num">2</div><div class="body"><strong>配置回调</strong><p>开发设置 → 回调配置，填入上方地址。平台会发起一次验证请求，系统会自动应答。</p></div></div>
            <div class="step"><div class="num">3</div><div class="body"><strong>订阅事件</strong><p>勾选「单聊消息」「群聊 @ 消息」事件，否则收不到用户消息。</p></div></div>
            <div class="step"><div class="num">4</div><div class="body"><strong>发布上线</strong><p>沙箱调试通过后提交审核，上线后可被添加到群聊或单聊。</p></div></div>
          </div>
        </div>
      </div>
    </div>`;
  }

  // ============================================================
  // 模型
  // ============================================================
  const models = {
    title: '模型服务',
    desc: '接入任意 OpenAI 兼容接口：官方、中转、自建、本地',
    actions() {
      return `<button class="btn btn-primary btn-sm" data-act="add-provider">${icon('plus', 14)} 添加服务</button>`;
    },
    render() {
      const providers = App.state.config.providers;
      if (!providers.length) {
        return `<div class="card">${emptyState('还没有模型服务', '点击右上角「添加服务」接入你的第一个模型 API')}</div>`;
      }
      const rows = providers.map((p) => {
        const configured = Boolean(p.apiKey);
        return `<div class="list-row">
          <div class="avatar" style="background:var(--primary-soft);color:var(--primary)">${icon('cpu', 15)}</div>
          <div class="grow">
            <div class="name">${escapeHtml(p.name)} ${configured ? '<span class="tag ok" style="margin-left:6px">已配置</span>' : '<span class="tag warn" style="margin-left:6px">缺密钥</span>'}</div>
            <div class="desc mono">${escapeHtml(p.baseUrl)}</div>
          </div>
          <span class="tag">${(p.models || []).length} 个模型</span>
          <button class="btn btn-ghost btn-sm" data-test="${escapeHtml(p.id)}">${icon('zap', 13)} 测试</button>
          <button class="btn btn-ghost btn-sm" data-edit="${escapeHtml(p.id)}">${icon('edit', 13)} 编辑</button>
          <button class="btn btn-danger btn-sm btn-icon" data-del="${escapeHtml(p.id)}">${icon('trash', 13)}</button>
        </div>`;
      }).join('');

      const agentUsage = App.state.config.agents.map((a) => {
        const p = providers.find((x) => x.id === a.providerId);
        return `<div class="list-row">
          <div class="grow"><div class="name">${escapeHtml(a.name)}</div>
          <div class="desc">${escapeHtml(p?.name || '未绑定')} · ${escapeHtml(a.model || '未指定模型')}</div></div>
          <span class="tag ${a.enabled ? 'ok' : ''}">${a.enabled ? '启用' : '停用'}</span>
        </div>`;
      }).join('');

      return `
      <div class="card">
        <div class="card-head"><h3>模型服务</h3><span class="sub">支持自定义 Base URL，兼容 OpenAI / DeepSeek / 通义 / Ollama 等</span></div>
        <div class="list">${rows}</div>
      </div>
      <div class="card mt-4">
        <div class="card-head"><h3>智能体使用情况</h3></div>
        <div class="list">${agentUsage || emptyState('暂无智能体', '')}</div>
      </div>`;
    },
    mount(root) {
      document.querySelector('[data-act="add-provider"]')?.addEventListener('click', () => openProviderModal(null));

      root.querySelectorAll('[data-edit]').forEach((el) => {
        el.addEventListener('click', () => {
          const p = App.state.config.providers.find((x) => x.id === el.dataset.edit);
          openProviderModal(p);
        });
      });

      root.querySelectorAll('[data-del]').forEach((el) => {
        el.addEventListener('click', async () => {
          const id = el.dataset.del;
          const p = App.state.config.providers.find((x) => x.id === id);
          if (App.state.config.providers.length <= 1) {
            toast('至少保留一个模型服务', 'err');
            return;
          }
          if (!(await Core.confirmDialog({ title: '删除模型服务', message: `确定删除「${p.name}」？使用该服务的智能体需要重新绑定。`, confirmText: '删除', danger: true }))) return;
          App.state.config.providers = App.state.config.providers.filter((x) => x.id !== id);
          await App.saveConfig();
          App.render();
          toast('已删除', 'ok');
        });
      });

      root.querySelectorAll('[data-test]').forEach((el) => {
        el.addEventListener('click', async () => {
          const id = el.dataset.test;
          const p = App.state.config.providers.find((x) => x.id === id);
          el.disabled = true;
          el.innerHTML = '<span class="loading-inline" style="border-color:rgba(0,0,0,.15);border-top-color:var(--primary)"></span>';
          try {
            const r = await api('/api/providers/test', { method: 'POST', body: { provider: p } });
            if (r.ok) toast(`连接成功 · ${r.model} · ${r.latency}ms`, 'ok');
            else toast(`连接失败：${r.error}`, 'err');
          } catch (err) {
            toast(err.message, 'err');
          } finally {
            el.disabled = false;
            el.innerHTML = `${icon('zap', 13)} 测试`;
          }
        });
      });
    },
  };

  function openProviderModal(provider) {
    const isNew = !provider;
    const p = provider || {
      id: `prov_${Date.now().toString(36)}`,
      name: '',
      type: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '',
      models: [],
      headers: {},
    };

    const mask = Core.openModal({
      title: isNew ? '添加模型服务' : '编辑模型服务',
      wide: true,
      body: `
        ${field('名称', input('pv-name', p.name, { placeholder: '例如：DeepSeek、公司中转、本地 Ollama' }))}
        ${field('Base URL', input('pv-base', p.baseUrl, { placeholder: 'https://api.openai.com/v1', mono: true }), '末尾不需要 /chat/completions，系统会自动拼接')}
        ${field('API Key', input('pv-key', p.apiKey, { placeholder: 'sk-...', mono: true, type: 'password' }), '本地模型（如 Ollama）可留空')}
        ${field('模型列表', input('pv-models', (p.models || []).join(', '), { placeholder: 'gpt-4o-mini, gpt-4o', mono: true }), '用英文逗号分隔，第一个为默认')}
        ${field('自定义请求头（可选）', textarea('pv-headers', JSON.stringify(p.headers || {}, null, 2), { rows: 3, mono: true, placeholder: '{"X-Custom": "value"}' }), '部分中转服务需要额外的鉴权头')}
      `,
      footer: `<button class="btn btn-ghost" data-close>取消</button>
               <button class="btn btn-primary" data-save>保存</button>`,
    });

    mask.querySelector('[data-save]').addEventListener('click', async () => {
      const name = mask.querySelector('#pv-name').value.trim() || '未命名服务';
      const baseUrl = mask.querySelector('#pv-base').value.trim();
      if (!baseUrl) { toast('请填写 Base URL', 'err'); return; }

      let headers = {};
      const headersRaw = mask.querySelector('#pv-headers').value.trim();
      if (headersRaw) {
        try { headers = JSON.parse(headersRaw); } catch (_) { toast('自定义请求头不是合法 JSON', 'err'); return; }
      }

      const next = {
        id: p.id,
        name,
        type: 'openai',
        baseUrl,
        apiKey: mask.querySelector('#pv-key').value.trim(),
        models: mask.querySelector('#pv-models').value.split(',').map((s) => s.trim()).filter(Boolean),
        headers,
      };

      const list = App.state.config.providers;
      const idx = list.findIndex((x) => x.id === p.id);
      if (idx >= 0) list[idx] = next; else list.push(next);

      await App.saveConfig();
      Core.closeModal(mask);
      App.render();
      toast('已保存', 'ok');
    });
  }

  // ============================================================
  // 智能体
  // ============================================================
  const agents = {
    title: '智能体',
    desc: '为不同渠道与场景配置专属人设、模型与工具',
    actions() {
      return `<button class="btn btn-primary btn-sm" data-act="add-agent">${icon('plus', 14)} 新建智能体</button>`;
    },
    render() {
      const list = App.state.config.agents;
      const tools = App.state.tools || [];
      const cards = list.map((a) => {
        const p = App.state.config.providers.find((x) => x.id === a.providerId);
        const channelTags = (a.channels || []).map((c) => ({
          web: '网页', wechat: '微信', wecom: '企微', qq: 'QQ',
        })[c] || c).map((label) => `<span class="tag">${escapeHtml(label)}</span>`).join('');
        const toolTags = (a.tools || []).map((t) => {
          const meta = tools.find((x) => x.name === t);
          return `<span class="tag info">${escapeHtml(meta?.label || t)}</span>`;
        }).join('');

        return `<div class="card" style="overflow:hidden">
          <div class="card-head">
            <div class="avatar" style="background:var(--primary-soft);color:var(--primary)">${icon('bot', 15)}</div>
            <div class="grow">
              <h3>${escapeHtml(a.name)} ${a.enabled === false ? '<span class="tag">已停用</span>' : ''}</h3>
              <div class="sub">${escapeHtml(p?.name || '未绑定服务')} · ${escapeHtml(a.model || '未指定')} · 温度 ${a.temperature}</div>
            </div>
            <button class="btn btn-ghost btn-sm" data-edit-agent="${escapeHtml(a.id)}">${icon('edit', 13)} 编辑</button>
            <button class="btn btn-ghost btn-sm" data-dup-agent="${escapeHtml(a.id)}">${icon('copy', 13)} 复制</button>
            <button class="btn btn-danger btn-sm btn-icon" data-del-agent="${escapeHtml(a.id)}">${icon('trash', 13)}</button>
          </div>
          <div class="card-body" style="padding-top:14px">
            <div style="font-size:12.5px;color:var(--text-2);line-height:1.65;max-height:66px;overflow:hidden;
              display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical">${escapeHtml(a.systemPrompt || '（未设置系统提示词）')}</div>
            <div class="flex gap-2 mt-3" style="flex-wrap:wrap">
              ${channelTags || '<span class="tag">未绑定渠道</span>'}
              ${toolTags}
              ${(a.keywords || []).length ? `<span class="tag warn">关键词 ${a.keywords.length}</span>` : ''}
            </div>
          </div>
        </div>`;
      }).join('');

      return `<div class="grid grid-2" style="align-items:start">${cards || emptyState('还没有智能体', '点击右上角新建')}</div>`;
    },
    mount(root) {
      document.querySelector('[data-act="add-agent"]')?.addEventListener('click', () => openAgentModal(null));

      root.querySelectorAll('[data-edit-agent]').forEach((el) => {
        el.addEventListener('click', () => {
          const a = App.state.config.agents.find((x) => x.id === el.dataset.editAgent);
          openAgentModal(a);
        });
      });

      root.querySelectorAll('[data-dup-agent]').forEach((el) => {
        el.addEventListener('click', async () => {
          const a = App.state.config.agents.find((x) => x.id === el.dataset.dupAgent);
          const copy = JSON.parse(JSON.stringify(a));
          copy.id = `agent_${Date.now().toString(36)}`;
          copy.name = `${a.name} 副本`;
          App.state.config.agents.push(copy);
          await App.saveConfig();
          App.render();
          toast('已复制', 'ok');
        });
      });

      root.querySelectorAll('[data-del-agent]').forEach((el) => {
        el.addEventListener('click', async () => {
          const id = el.dataset.delAgent;
          if (App.state.config.agents.length <= 1) { toast('至少保留一个智能体', 'err'); return; }
          const a = App.state.config.agents.find((x) => x.id === id);
          if (!(await Core.confirmDialog({ title: '删除智能体', message: `确定删除「${a.name}」？`, confirmText: '删除', danger: true }))) return;
          App.state.config.agents = App.state.config.agents.filter((x) => x.id !== id);
          if (App.state.config.routing.defaultAgentId === id) {
            App.state.config.routing.defaultAgentId = App.state.config.agents[0].id;
          }
          await App.saveConfig();
          App.render();
          toast('已删除', 'ok');
        });
      });
    },
  };

  function openAgentModal(agent) {
    const isNew = !agent;
    const cfg = App.state.config;
    const tools = App.state.tools || [];
    const a = agent ? JSON.parse(JSON.stringify(agent)) : {
      id: `agent_${Date.now().toString(36)}`,
      name: '',
      providerId: cfg.providers[0]?.id || '',
      model: cfg.providers[0]?.models?.[0] || '',
      systemPrompt: '你是一位可靠、亲切的中文 AI 助手。回答要准确、简洁、有条理。',
      temperature: 0.7,
      maxTokens: 1200,
      tools: ['get_time', 'calc', 'remember', 'recall', 'send_message', 'list_contacts', 'list_sessions'],
      keywords: [],
      channels: ['web', 'wechat', 'wecom', 'qq'],
      enabled: true,
      greeting: '你好，我是你的 AI 助手，有什么可以帮你？',
    };

    const providerOpts = cfg.providers.map((p) => ({ value: p.id, label: p.name }));
    const channelChecks = [
      { id: 'web', label: '网页' },
      { id: 'wechat', label: '微信公众号' },
      { id: 'wecom', label: '企业微信' },
      { id: 'qq', label: 'QQ 官方' },
      { id: 'onebot', label: 'OneBot 11' },
    ].map((c) => `<label class="flex items-center gap-2" style="font-size:13px;cursor:pointer">
      <input type="checkbox" class="ch-check" value="${c.id}" ${(a.channels || []).includes(c.id) ? 'checked' : ''}>
      <span>${c.label}</span>
    </label>`).join('');

    const toolChecks = tools.map((t) => `<label class="flex items-center gap-2" style="font-size:13px;cursor:pointer" title="${escapeHtml(t.desc)}">
      <input type="checkbox" class="tool-check" value="${t.name}" ${(a.tools || []).includes(t.name) ? 'checked' : ''}>
      <span>${escapeHtml(t.label)}</span>
    </label>`).join('');

    const mask = Core.openModal({
      title: isNew ? '新建智能体' : '编辑智能体',
      wide: true,
      body: `
        <div class="grid grid-2" style="gap:14px">
          <div>${field('名称', input('ag-name', a.name, { placeholder: '例如：客服小助手' }))}</div>
          <div>${field('欢迎语', input('ag-greet', a.greeting, { placeholder: '用户首次进入时的问候' }))}</div>
        </div>
        <div class="grid grid-2" style="gap:14px">
          <div>${field('模型服务', select('ag-provider', providerOpts, a.providerId))}</div>
          <div>${field('模型', select('ag-model', (() => {
            const p = (App.state.config.providers || []).find((x) => x.id === a.providerId);
            const list = (p && p.models) || [];
            const opts = [{ value: '', label: '默认（服务的第一个模型）' }];
            for (const m of list) opts.push({ value: m, label: m });
            // 老配置里可能存着列表外的值（比如被填成了服务名），保留一项并标出来
            if (a.model && list.length && !list.includes(a.model)) {
              opts.push({ value: a.model, label: `${a.model}（服务不支持，建议改掉）` });
            }
            return opts;
          })(), a.model || ''), '只能选这个服务真实支持的模型')}</div>
        </div>
        ${field('系统提示词', textarea('ag-prompt', a.systemPrompt, { rows: 6, placeholder: '定义角色、语气、边界与输出格式' }), '这是决定回答风格的核心，建议写清楚身份、能力边界和输出要求')}
        <div class="grid grid-2" style="gap:14px">
          <div>${field('温度 (0-2)', input('ag-temp', a.temperature, { type: 'number' }), '越低越稳定，越高越有创造性')}</div>
          <div>${field('最大输出 Token', input('ag-max', a.maxTokens, { type: 'number' }))}</div>
        </div>
        ${field('可用工具', `<div class="grid grid-2" style="gap:8px">${toolChecks}</div>`, '模型会在需要时自动调用；未配置的服务会自动跳过')}
        ${field('绑定渠道', `<div class="grid grid-2" style="gap:8px">${channelChecks}</div>`, '同一渠道有多个智能体时，按关键词优先匹配')}
        ${field('触发关键词', input('ag-keywords', (a.keywords || []).join(', '), { placeholder: '价格, 报价, 客服' }), '用户消息命中任一关键词时优先使用该智能体，留空表示不启用关键词路由')}
        <div class="switch-row">
          ${switchEl('ag-enabled', a.enabled !== false)}
          <div><div class="label">启用此智能体</div><div class="hint">停用后不会接收任何渠道消息</div></div>
        </div>
      `,
      footer: `<button class="btn btn-ghost" data-close>取消</button>
               <button class="btn btn-primary" data-save>保存</button>`,
    });

    mask.querySelector('#ag-provider').addEventListener('change', (e) => {
      const p = cfg.providers.find((x) => x.id === e.target.value);
      const sel = mask.querySelector('#ag-model');
      if (!sel) return;
      const opts = [{ value: '', label: '默认（服务的第一个模型）' }];
      for (const m of (p && p.models) || []) opts.push({ value: m, label: m });
      sel.innerHTML = opts
        .map((o) => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</option>`)
        .join('');
    });

    mask.querySelector('[data-save]').addEventListener('click', async () => {
      const name = mask.querySelector('#ag-name').value.trim();
      if (!name) { toast('请填写名称', 'err'); return; }

      const next = {
        ...a,
        name,
        greeting: mask.querySelector('#ag-greet').value.trim(),
        providerId: mask.querySelector('#ag-provider').value,
        model: mask.querySelector('#ag-model').value.trim(),
        systemPrompt: mask.querySelector('#ag-prompt').value,
        temperature: Number(mask.querySelector('#ag-temp').value) || 0.7,
        maxTokens: Number(mask.querySelector('#ag-max').value) || 1200,
        tools: Array.from(mask.querySelectorAll('.tool-check:checked')).map((x) => x.value),
        channels: Array.from(mask.querySelectorAll('.ch-check:checked')).map((x) => x.value),
        keywords: mask.querySelector('#ag-keywords').value.split(',').map((s) => s.trim()).filter(Boolean),
        enabled: mask.querySelector('#ag-enabled').classList.contains('on'),
      };

      const list = App.state.config.agents;
      const idx = list.findIndex((x) => x.id === a.id);
      if (idx >= 0) list[idx] = next; else list.push(next);

      await App.saveConfig();
      Core.closeModal(mask);
      App.render();
      toast('已保存', 'ok');
    });
  }

  // ============================================================
  // 语音
  // ============================================================
  const voice = {
    title: '语音能力',
    desc: '接入自定义语音识别与合成 API，实现听说一体',
    actions() {
      return `<button class="btn btn-primary btn-sm" data-act="save-voice">${icon('check', 14)} 保存配置</button>`;
    },
    render() {
      const v = App.state.config.voice;
      const stt = v.stt;
      const tts = v.tts;
      const vqq = v.qq || {};
      const android = Boolean(window.AIBRIDGE_ANDROID);
      const sttProvider = android ? 'api' : (stt.provider === 'local' ? 'local' : 'api');

      return `
      <div class="grid grid-2" style="align-items:start">
        <div class="card">
          <div class="card-head">
            <h3>语音输入 · STT</h3>
            <span class="tag ${stt.enabled ? 'ok' : ''}">${stt.enabled ? '已启用' : '未启用'}</span>
            <div style="margin-left:auto">${switchEl('sw-stt', stt.enabled)}</div>
          </div>
          <div class="card-body">
            <input type="hidden" id="stt-provider" value="${sttProvider}" />
            <div class="flex items-center gap-2 mb-3">
              <button type="button" class="btn btn-sm ${sttProvider === 'local' ? 'btn-ghost' : 'btn-primary'}" data-prov="api">${icon('globe', 13)} 云端 API</button>
              ${android ? '' : `<button type="button" class="btn btn-sm ${sttProvider === 'local' ? 'btn-primary' : 'btn-ghost'}" data-prov="local">${icon('cpu', 13)} 本地识别</button>`}
            </div>

            <div id="sttApiBox" ${sttProvider === 'local' ? 'hidden' : ''}>
              ${field('服务地址', input('stt-base', stt.baseUrl, { placeholder: 'https://api.openai.com/v1', mono: true }), '系统会向 {地址}/audio/transcriptions 发送 multipart 请求')}
              ${field('API Key', input('stt-key', stt.apiKey, { placeholder: 'sk-...', mono: true, type: 'password' }))}
              <div class="grid grid-2" style="gap:12px">
                <div>${field('模型', input('stt-model', stt.model, { placeholder: 'whisper-1', mono: true }))}</div>
                <div>${field('语言', input('stt-lang', stt.language, { placeholder: 'zh', mono: true }), '留空自动检测')}</div>
              </div>
              <div class="notice mt-2">${icon('info')}
                <div>兼容 OpenAI Whisper、Groq、硅基流动、本地 faster-whisper 等任意 OpenAI 协议实现。上传音频为 webm/opus 格式。</div>
              </div>
            </div>

            <div id="sttLocalBox" ${android || stt.provider !== 'local' ? 'hidden' : ''}>
              ${field('引擎 / 模型', select('stt-local-model', [
                { value: 'sensevoice', label: 'SenseVoice · 228 MB（最快，中英日韩粤）' },
                { value: 'base', label: 'whisper base · 59 MB（小，中文一般）' },
                { value: 'small', label: 'whisper small · 190 MB（中文够用，慢）' },
                { value: 'medium', label: 'whisper medium · 539 MB（最准，很慢）' },
              ], stt.local?.model || 'sensevoice'), 'SenseVoice 跑在进程内，10 秒音频约 0.3 秒；whisper 是外部进程，同样音频要 3~8 秒')}
              <div class="grid grid-2" style="gap:12px">
                <div>${field('语言', input('stt-lang-local', stt.language, { placeholder: 'zh', mono: true }), '中文填 zh')}</div>
                <div>${field('线程数', input('stt-threads', stt.local?.threads || 0, { type: 'number' }), '留 0 自动（CPU 核数 - 2）')}</div>
              </div>
              <div id="sttLocalStatus" class="notice mt-2" style="align-items:flex-start">
                <div>${icon('cpu')}</div>
                <div id="sttLocalText" style="flex:1">正在检查本地引擎…</div>
              </div>
              <div class="flex items-center gap-2 mt-2">
                <button type="button" class="btn btn-soft btn-sm" data-act="stt-download">${icon('download', 14)} 下载 / 重新下载</button>
                <span class="hint" id="sttLocalHint"></span>
              </div>
              <div class="notice mt-2">${icon('info')}
                <div>引擎是 <strong>whisper.cpp</strong>，装在 <code>runtime/stt/</code>，纯本地推理。
                  录音会先在本地用 ffmpeg 转成 16kHz 单声道，再喂给模型，音频不出这台机器。</div>
              </div>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <h3>语音输出 · TTS</h3>
            <span class="tag ${tts.enabled ? 'ok' : ''}">${tts.enabled ? '已启用' : '未启用'}</span>
            <div style="margin-left:auto">${switchEl('sw-tts', tts.enabled)}</div>
          </div>
          <div class="card-body">
            ${field('服务地址', input('tts-base', tts.baseUrl, { placeholder: 'https://api.openai.com/v1', mono: true }), '系统会向 {地址}/audio/speech 发送 JSON 请求')}
            ${field('API Key', input('tts-key', tts.apiKey, { placeholder: 'sk-...', mono: true, type: 'password' }))}
            <div class="grid grid-2" style="gap:12px">
              <div>${field('模型', input('tts-model', tts.model, { placeholder: 'tts-1', mono: true }))}</div>
              <div>${field('音色', input('tts-voice', tts.voice, { placeholder: 'alloy / nova / shimmer', mono: true }))}</div>
            </div>
            <div class="grid grid-2" style="gap:12px">
              <div>${field('语速', input('tts-speed', tts.speed, { type: 'number' }), '0.25 ~ 4.0')}</div>
              <div>${field('格式', select('tts-format', ['mp3', 'opus', 'aac', 'flac', 'wav'], tts.format))}</div>
            </div>
            <button class="btn btn-soft mt-2" data-act="test-tts">${icon('play', 14)} 试听效果</button>
          </div>
        </div>
      </div>

      <div class="card mt-4">
        <div class="card-head">
          <h3>QQ 语音条</h3>
          <span class="tag ${vqq.enabled ? 'ok' : ''}">${vqq.enabled ? '已启用' : '未启用'}</span>
          <span class="sub">收发都要转 SILK</span>
          <div style="margin-left:auto">${switchEl('sw-qq-voice', vqq.enabled)}</div>
        </div>
        <div class="card-body">
          <div class="notice">${icon('info')}
            <div>QQ 语音条用的是腾讯自研的 <strong>SILK</strong> 编码，STT 和 TTS 都不认，标准 ffmpeg 也解不了。
              这里用 silk-wasm 在本地转码，所以<strong>语音合成服务必须能输出 wav</strong>（mp3 没法转 SILK）。</div>
          </div>
          <div class="switch-row" style="border-top:1px solid var(--border)">
            ${switchEl('sw-qq-listen', vqq.listen !== false)}
            <div><div class="label">收到语音时转成文字</div><div class="hint">不开的话，别人发语音只会收到「我听不懂语音」</div></div>
          </div>
          <div class="switch-row" style="border-top:1px solid var(--border)">
            ${switchEl('sw-qq-reply', vqq.reply)}
            <div><div class="label">用语音条回复</div><div class="hint">默认只在对方发语音时才回语音，像人在对着说话</div></div>
          </div>
          <div class="switch-row" style="border-top:1px solid var(--border)">
            ${switchEl('sw-qq-always', vqq.alwaysVoice)}
            <div><div class="label">对方发文字也回语音</div><div class="hint">想让它一直用语音聊天时打开</div></div>
          </div>
          <div class="switch-row" style="border-top:1px solid var(--border)">
            ${switchEl('sw-qq-group', vqq.groupReply)}
            <div><div class="label">群聊里也发语音条</div><div class="hint">默认只在私聊发，群里太吵</div></div>
          </div>
          <div class="grid grid-2 mt-2" style="gap:12px">
            ${field('超过多少字改回文字', input('qq-maxchars', vqq.maxChars || 80, { type: 'number' }),
              '几十秒的语音条不像人发的，默认 80 字')}
            ${field('解码采样率', select('qq-silkrate',
              [{ value: '24000', label: '24000 Hz（QQ 移动端）' },
                { value: '16000', label: '16000 Hz（微信常见）' }],
              String(vqq.silkRate || 24000)),
              '解出来音调不对就换一个')}
          </div>
        </div>
      </div>

      <div class="card mt-4">
        <div class="card-head"><h3>播放与降级策略</h3></div>
        <div class="card-body">
          <div class="switch-row">
            ${switchEl('sw-autospeak', v.autoSpeak)}
            <div><div class="label">AI 回复后自动播报</div><div class="hint">在网页对话页生效，渠道侧不受影响</div></div>
          </div>
          <div class="switch-row" style="border-top:1px solid var(--border)">
            ${switchEl('sw-fallback', v.browserFallback)}
            <div><div class="label">浏览器内置语音兜底</div><div class="hint">未配置 TTS 服务时，使用系统语音合成朗读回复（音质取决于系统）</div></div>
          </div>
          <div class="notice mt-2">${icon('info')}
            <div>语音输入在网页端通过浏览器录音上传；QQ / OneBot 渠道下，收到的语音条会先转成文字再理解。
              微信、企微官方接口不提供语音消息内容，只能靠平台给的转写结果，拿不到时会提示对方发文字。</div>
          </div>
        </div>
      </div>`;
    },
    mount(root) {
      root.querySelectorAll('.switch').forEach((sw) => {
        sw.addEventListener('click', () => sw.classList.toggle('on'));
      });

      // ---- STT 后端切换 ----
      // 不整页重渲染：重渲染会把用户刚填的 key 冲掉，这里只切显隐
      const provInput = root.querySelector('#stt-provider');
      const apiBox = root.querySelector('#sttApiBox');
      const localBox = root.querySelector('#sttLocalBox');
      root.querySelectorAll('[data-prov]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const v = btn.dataset.prov;
          provInput.value = v;
          if (apiBox) apiBox.hidden = v === 'local';
          if (localBox) localBox.hidden = v !== 'local';
          root.querySelectorAll('[data-prov]').forEach((b) => {
            const on = b.dataset.prov === v;
            b.classList.toggle('btn-primary', on);
            b.classList.toggle('btn-ghost', !on);
          });
          if (v === 'local') refreshLocal();
        });
      });

      // ---- 本地引擎状态 ----
      let localTimer = null;
      const mb = (n) => (Number(n || 0) / 1048576).toFixed(1);

      async function refreshLocal() {
        const textEl = root.querySelector('#sttLocalText');
        if (!textEl) return;
        let st;
        try {
          st = await (await fetch('/api/voice/local')).json();
        } catch (err) {
          textEl.textContent = `读取状态失败：${err.message}`;
          return;
        }
        if (!st.supported) {
          textEl.textContent = '本地识别目前只支持 Windows。';
          return;
        }

        const j = st.job || {};
        if (j.active) {
          const pct = j.total ? Math.min(100, Math.round((j.got / j.total) * 100)) : 0;
          textEl.innerHTML = `${j.kind === 'binary' ? '下载引擎' : '下载模型'} ${pct}%（${mb(j.got)} / ${mb(j.total)} MB）`;
          if (localTimer) clearTimeout(localTimer);
          localTimer = setTimeout(refreshLocal, 900);
          return;
        }
        if (j.error) {
          textEl.innerHTML = `<span style="color:var(--danger)">下载失败：${escapeHtml(j.error)}</span>`;
          return;
        }

        const cur = (st.models || []).find((m) => m.key === st.current);
        if (st.ready) {
          textEl.innerHTML = `已就绪 · <b>${escapeHtml(cur ? cur.label : st.current)}</b>`;
        } else {
          const lack = [];
          if (cur && cur.engine === 'whisper' && !st.binary) lack.push('引擎');
          if (!cur || !cur.ready) lack.push(`模型 ${escapeHtml(st.current)}`);
          textEl.innerHTML = `还缺：${lack.join(' 和 ')}。点下面的按钮下载，之后离线也能用。`;
        }
      }

      root.querySelector('[data-act="stt-download"]')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        const model = root.querySelector('#stt-local-model')?.value || 'small';
        btn.disabled = true;
        try {
          const res = await fetch('/api/voice/local/download', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model }),
          });
          const j = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
          toast('开始下载，完成后页面会自动更新', 'ok');
          refreshLocal();
        } catch (err) {
          toast(`下载失败：${err.message}`, 'err');
        } finally {
          btn.disabled = false;
        }
      });

      if (localBox && !localBox.hidden) refreshLocal();

      document.querySelector('[data-act="save-voice"]')?.addEventListener('click', async () => {
        const cfg = App.state.config;
        const get = (id) => root.querySelector(`#${id}`)?.value ?? '';
        const provider = root.querySelector('#stt-provider')?.value || 'api';
        cfg.voice.stt = {
          enabled: root.querySelector('#sw-stt').classList.contains('on'),
          provider,
          baseUrl: get('stt-base').trim(),
          apiKey: get('stt-key').trim(),
          model: get('stt-model').trim(),
          language: (provider === 'local' ? get('stt-lang-local') : get('stt-lang')).trim(),
          local: {
            model: get('stt-local-model') || 'small',
            threads: Number(get('stt-threads')) || 0,
          },
        };
        cfg.voice.tts = {
          enabled: root.querySelector('#sw-tts').classList.contains('on'),
          baseUrl: get('tts-base').trim(),
          apiKey: get('tts-key').trim(),
          model: get('tts-model').trim(),
          voice: get('tts-voice').trim(),
          speed: Number(get('tts-speed')) || 1,
          format: get('tts-format'),
        };
        cfg.voice.autoSpeak = root.querySelector('#sw-autospeak').classList.contains('on');
        cfg.voice.browserFallback = root.querySelector('#sw-fallback').classList.contains('on');
        cfg.voice.qq = {
          enabled: root.querySelector('#sw-qq-voice')?.classList.contains('on') || false,
          listen: root.querySelector('#sw-qq-listen')?.classList.contains('on') || false,
          reply: root.querySelector('#sw-qq-reply')?.classList.contains('on') || false,
          alwaysVoice: root.querySelector('#sw-qq-always')?.classList.contains('on') || false,
          groupReply: root.querySelector('#sw-qq-group')?.classList.contains('on') || false,
          maxChars: Number(get('qq-maxchars')) || 80,
          silkRate: Number(get('qq-silkrate')) || 24000,
          // SILK 编码只吃 WAV，这条不给用户改，避免配出跑不通的组合
          ttsFormat: 'wav',
        };
        await App.saveConfig();
        // 开了语音条却选了 mp3 的 TTS，等到真发语音才报错就太晚了
        if (cfg.voice.qq.enabled && cfg.voice.qq.reply && cfg.voice.tts.format !== 'wav') {
          toast('语音条已开启，但 TTS 格式是 ' + cfg.voice.tts.format
            + '，QQ 语音条需要 wav。请把上面的「格式」改成 wav', 'warn');
        } else {
          toast('语音配置已保存', 'ok');
        }
      });

      document.querySelector('[data-act="test-tts"]')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        const cfg = App.state.config.voice.tts;
        const payload = {
          text: '你好，我是你的 AI 助手。这是一段语音合成测试。',
          baseUrl: root.querySelector('#tts-base').value.trim(),
          apiKey: root.querySelector('#tts-key').value.trim(),
          model: root.querySelector('#tts-model').value.trim(),
          voice: root.querySelector('#tts-voice').value.trim(),
          speed: Number(root.querySelector('#tts-speed').value) || 1,
          format: root.querySelector('#tts-format').value,
        };
        if (!payload.baseUrl) { toast('请先填写服务地址', 'err'); return; }

        btn.disabled = true;
        btn.innerHTML = '<span class="loading-inline" style="border-color:rgba(67,97,238,.25);border-top-color:var(--primary)"></span> 合成中…';
        try {
          const res = await fetch('/api/voice/test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          if (!res.ok) {
            const j = await res.json().catch(() => ({}));
            throw new Error(j.error || `HTTP ${res.status}`);
          }
          const blob = await res.blob();
          const audio = new Audio(URL.createObjectURL(blob));
          await audio.play();
          toast('播放中…', 'ok');
        } catch (err) {
          toast(`合成失败：${err.message}`, 'err');
        } finally {
          btn.disabled = false;
          btn.innerHTML = `${icon('play', 14)} 试听效果`;
        }
      });
    },
  };

  // ============================================================
  // 长期记忆
  // ============================================================
  function scopeKind(scope) {
    if (scope === 'global') return 'global';
    if (String(scope).startsWith('agent:')) return 'agent';
    if (String(scope).startsWith('user:')) return 'user';
    return 'global';
  }

  function scopeLabel(scope) {
    const kind = scopeKind(scope);
    if (kind === 'global') return '公共';
    if (kind === 'agent') return '人格';
    return '用户';
  }

  function scopeDetail(scope) {
    if (String(scope).startsWith('agent:')) return String(scope).slice(6);
    if (String(scope).startsWith('user:')) return String(scope).slice(5);
    return '';
  }

  // ---------------- 记忆强度可视化 ----------------
  const TIER_META = {
    clear: { label: '清晰', color: 'var(--success)', cls: 'ok' },
    fuzzy: { label: '模糊', color: 'var(--warn)', cls: 'warn' },
    vague: { label: '隐约', color: 'var(--danger)', cls: 'err' },
  };

  function tierMeta(tier) {
    return TIER_META[tier] || TIER_META.fuzzy;
  }

  /**
   * 分档优先用后端算好的 tier；万一字段缺失（老数据 / 接口裁剪），
   * 就按强度就地推一档，别让整页都显示成「模糊」。
   */
  function tierOf(f) {
    if (f && f.tier) return f.tier;
    const s = f && f.strength !== undefined ? Number(f.strength) : 1;
    if (!Number.isFinite(s)) return 'clear';
    if (s >= 0.7) return 'clear';
    if (s >= 0.32) return 'fuzzy';
    return 'vague';
  }

  /** 强度条：一眼看出这条记忆还剩多少 */
  function strengthBar(f, width = 120) {
    const pct = Math.round((f.strength === undefined ? 1 : f.strength) * 100);
    const m = tierMeta(tierOf(f));
    return `<div style="display:flex;align-items:center;gap:6px">
      <div style="width:${width}px;height:4px;border-radius:2px;background:var(--bg-3);overflow:hidden">
        <div style="width:${pct}%;height:100%;border-radius:2px;background:${m.color};opacity:.9"></div>
      </div>
      <span style="font-size:11.5px;color:var(--text-3);font-variant-numeric:tabular-nums">${pct}%</span>
    </div>`;
  }

  // 曲线点缓存：翻页、切筛选、重渲染同一批记忆时不用反复打接口
  const sparkCache = new Map();

  /** 把 { day, r } 点集折算成 svg 折线坐标 */
  function sparkPolyline(list, days, w, h) {
    const span = Math.max(1, Number(days) || 30);
    return list.map((p) => {
      const x = (w * Math.min(1, Math.max(0, Number(p.day) || 0))) / span;
      const y = h - Math.min(1, Math.max(0, Number(p.r) || 0)) * h;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
  }

  /**
   * 遗忘曲线缩略图。口径只有一套：后端 /api/memory/:id/curve（30 天采样、S 下限 0.05）。
   * 前端先按同一套公式画个兜底版本顶上，接口回来再换真实数据 ——
   * 既不会闪空白，也不会出现「前后端两条曲线对不上」的旧问题。
   */
  function memorySpark(f, w = 58, h = 16) {
    const S = Math.max(0.05, Number(f.stability) || 1);
    const days = 30;
    const key = `${f.id}|${S}`;
    let list = sparkCache.get(key);
    if (!list) {
      list = [];
      for (let i = 0; i <= days; i += 1) list.push({ day: i, r: Math.exp(-i / S) });
    }
    const m = tierMeta(tierOf(f));
    return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="color:${m.color};flex:none"
      data-spark="${escapeHtml(f.id)}" data-spark-key="${escapeHtml(key)}" data-spark-days="${days}"
      title="未来 ${days} 天的记忆强度走势">
      <polyline points="${sparkPolyline(list, days, w, h)}" fill="none" stroke="currentColor" stroke-width="1.3"
        stroke-linecap="round" opacity=".75"></polyline>
    </svg>`;
  }

  /**
   * 用后端曲线重画缩略图。接口失败就保留上一步的本地兜底：
   * 一条记忆取不到曲线不该让整页报错，更不该退回自己另算一套参数。
   */
  async function loadSparks(box) {
    const els = Array.from(box.querySelectorAll('svg[data-spark]'));
    if (!els.length) return;

    let idx = 0;
    // 并发 4 个足够：太多了浏览器会把请求排队，页面反而更慢
    const worker = async () => {
      while (idx < els.length) {
        const el = els[idx];
        idx += 1;
        if (!el.isConnected) continue;
        const key = el.dataset.sparkKey;
        let list = sparkCache.get(key);
        if (!list) {
          const days = Number(el.dataset.sparkDays) || 30;
          try {
            const r = await api(`/api/memory/${encodeURIComponent(el.dataset.spark)}/curve?days=${days}`);
            if (Array.isArray(r?.curve) && r.curve.length) {
              list = r.curve;
              sparkCache.set(key, list);
            }
          } catch (_) { /* 老服务端没有这个接口：兜底曲线已经画好了 */ }
        }
        const poly = el.querySelector('polyline');
        if (!poly || !list) continue;
        if (!el.isConnected) continue;
        const w = Number(el.getAttribute('width')) || 58;
        const h = Number(el.getAttribute('height')) || 16;
        poly.setAttribute('points', sparkPolyline(list, el.dataset.sparkDays, w, h));
      }
    };

    await Promise.all([worker(), worker(), worker(), worker()]);
  }

  /** 三档占比条：一眼看出整体记忆健康度 */
  function tierBar(byTier, total) {
    const t = byTier || {};
    const sum = Math.max(1, total || 0);
    const seg = ['clear', 'fuzzy', 'vague'].map((k) => {
      const n = t[k] || 0;
      return { k, n, pct: (n / sum) * 100 };
    }).filter((s) => s.pct > 0);
    if (!seg.length) {
      return '<div style="height:6px;border-radius:3px;background:var(--bg-3)"></div>';
    }
    return `<div style="display:flex;height:6px;border-radius:3px;overflow:hidden;background:var(--bg-3)">
      ${seg.map((s) => `<div style="width:${s.pct}%;background:${tierMeta(s.k).color};opacity:.85"
        title="${tierMeta(s.k).label} ${s.n} 条"></div>`).join('')}
    </div>`;
  }

  const memoryView = {
    title: '长期记忆',
    desc: '跨会话、跨渠道共享的认知，让 AI 记得住人和事',
    actions() {
      return `<button class="btn btn-ghost btn-sm" data-act="mem-consolidate" title="合并相似记忆、加固常用的、把沉底的归档">${icon('zap', 14)} 巩固</button>
              <button class="btn btn-ghost btn-sm" data-act="mem-refresh">${icon('refresh', 14)} 刷新</button>
              <button class="btn btn-primary btn-sm" data-act="mem-add">${icon('plus', 14)} 添加记忆</button>`;
    },
    render() {
      const stats = App.state.memoryStats || { total: 0, byScope: {}, max: 400 };
      const items = App.state.memoryItems || [];
      const filter = App.state.memoryFilter || 'all';

      const counts = { global: 0, user: 0, agent: 0 };
      for (const [scope, n] of Object.entries(stats.byScope || {})) {
        const k = scopeKind(scope);
        counts[k] = (counts[k] || 0) + n;
      }

      const filtered = filter === 'all'
        ? items
        : items.filter((f) => scopeKind(f.scope) === filter);

      const tabs = [
        { id: 'all', label: '全部', n: stats.total },
        { id: 'global', label: '公共', n: counts.global },
        { id: 'user', label: '用户', n: counts.user },
        { id: 'agent', label: '人格', n: counts.agent },
      ];

      const rows = filtered.map((f) => {
        const kind = scopeKind(f.scope);
        const tagCls = kind === 'global' ? 'info' : kind === 'agent' ? 'warn' : '';
        const imp = Math.round((f.importance || 0.5) * 100);
        const m = tierMeta(tierOf(f));
        const strengthPct = Math.round((f.strength === undefined ? 1 : f.strength) * 100);
        const stab = f.halfLifeDays !== undefined ? f.halfLifeDays : Math.round((f.stability || 0) * 0.69 * 10) / 10;
        return `<div class="list-row" style="align-items:flex-start;${f.archived ? 'opacity:.6' : ''}">
          <div style="width:3px;height:34px;border-radius:2px;flex:none;margin-top:2px;
            background:${kind === 'global' ? 'var(--primary)' : kind === 'agent' ? 'var(--warn)' : 'var(--success)'};
            opacity:${0.3 + (f.importance || 0.5) * 0.7}"></div>
          <div class="grow">
            <div class="name" style="font-weight:450;line-height:1.55">${escapeHtml(f.content)}</div>
            <div class="desc" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
              <span class="tag ${tagCls}">${scopeLabel(f.scope)}${scopeDetail(f.scope) ? ' · ' + escapeHtml(scopeDetail(f.scope)) : ''}</span>
              <span class="tag ${m.cls}" title="记忆强度 ${strengthPct}%，稳定期约 ${stab} 天">${m.label} ${strengthPct}%</span>
              <span>稳定期 ${stab} 天</span>
              <span>想起 ${f.reps !== undefined ? f.reps : (f.hits || 0)} 次${f.lapses ? ` · 遗忘 ${f.lapses} 次` : ''}</span>
              <span>重要度 ${imp}%</span>
              <span>${f.ageDays !== undefined ? `${f.ageDays} 天前想起` : timeAgo(f.updatedAt)}</span>
              ${f.archived ? '<span class="tag">已沉睡</span>' : ''}
            </div>
            <div style="display:flex;align-items:center;gap:10px;margin-top:6px">
              ${strengthBar(f)}
              ${memorySpark(f)}
            </div>
          </div>
          <button class="btn btn-ghost btn-sm" data-touch-mem="${escapeHtml(f.id)}" title="模拟「想起来一次」，会加固这条记忆">${icon('refresh', 13)} 想起</button>
          <button class="btn btn-ghost btn-sm" data-edit-mem="${escapeHtml(f.id)}">${icon('edit', 13)}</button>
          <button class="btn btn-danger btn-sm btn-icon" data-del-mem="${escapeHtml(f.id)}">${icon('trash', 13)}</button>
        </div>`;
      }).join('');

      const byTier = stats.byTier || { clear: 0, fuzzy: 0, vague: 0 };
      const archived = stats.archived || 0;
      const avgStrength = Math.round((stats.avgStrength || 0) * 100);
      const avgStab = stats.avgStabilityDays || 0;

      return `
      <div class="grid grid-4 mb-3">
        <div class="stat">
          <div class="label">${icon('cpu', 13)} 记忆总数</div>
          <div class="value">${stats.total}<span style="font-size:14px;color:var(--text-3);font-weight:500"> / ${stats.max || 400}</span></div>
          <div class="hint">${archived ? `${archived} 条已沉睡（强线索可唤醒）` : '超出后自动淘汰低价值记忆'}</div>
        </div>
        <div class="stat">
          <div class="label">${icon('wave', 13)} 平均强度</div>
          <div class="value">${avgStrength}<span style="font-size:14px;color:var(--text-3);font-weight:500">%</span></div>
          <div style="margin-top:8px">${tierBar(byTier, stats.total - archived)}</div>
          <div class="hint" style="margin-top:6px">清晰 ${byTier.clear || 0} · 模糊 ${byTier.fuzzy || 0} · 隐约 ${byTier.vague || 0}</div>
        </div>
        <div class="stat">
          <div class="label">${icon('globe', 13)} 公共 / 人格</div>
          <div class="value">${counts.global}<span style="font-size:14px;color:var(--text-3);font-weight:500"> / ${counts.agent}</span></div>
          <div class="hint">所有会话共享的认知</div>
        </div>
        <div class="stat">
          <div class="label">${icon('shield', 13)} 用户记忆</div>
          <div class="value">${counts.user}</div>
          <div class="hint">平均稳定期 ${avgStab} 天，越常想起越牢</div>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <div style="display:flex;gap:4px">
            ${tabs.map((t) => `<button class="btn btn-sm ${filter === t.id ? 'btn-primary' : 'btn-ghost'}"
              style="${filter === t.id ? '' : 'background:transparent;border-color:transparent'}"
              data-mem-tab="${t.id}">${t.label} <span style="opacity:.65;margin-left:2px">${t.n}</span></button>`).join('')}
          </div>
          <div style="margin-left:auto;display:flex;gap:8px;align-items:center">
            <input class="input" id="memSearch" placeholder="搜索记忆内容…"
              value="${escapeHtml(App.state.memoryQuery || '')}"
              style="width:220px;height:32px;font-size:13px">
            <button class="btn btn-danger btn-sm" data-act="mem-clear">${icon('trash', 13)} 清空</button>
          </div>
        </div>
        <div class="list">
          ${rows || emptyState(
            App.state.memoryQuery ? '没有匹配的记忆' : '还没有任何记忆',
            App.state.memoryQuery ? '换个关键词试试' : '正常对话几轮后会自动提炼，也可以手动添加',
            'cpu'
          )}
        </div>
      </div>

      <div class="notice info mt-4">${icon('info')}
        <div>
          <strong>记忆是按人脑的规律走的</strong>：每条记忆有独立的稳定期，越久没想起强度越低；
          快忘光时被提起，反而加固得最狠（合意困难）；相似的多条会互相干扰、也会被合并。
          强度低于 32% 时注入会给模型标成「隐约」，让它先跟你确认而不是当成事实。
          <br>
          <strong>公共认知</strong>对所有会话可见，<strong>用户记忆</strong>只在该用户的对话里注入，
          <strong>人格记忆</strong>让同一个智能体在微信、QQ、网页上保持一致。
        </div>
      </div>`;
    },
    mount(root) {
      const reload = async () => {
        await App.loadMemory();
        App.render();
      };

      // 曲线以后端为准，异步补画；失败自动留着本地兜底，不挡页面
      loadSparks(root);

      document.querySelector('[data-act="mem-refresh"]')?.addEventListener('click', reload);

      document.querySelector('[data-act="mem-consolidate"]')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        try {
          const r = await api('/api/memory/consolidate', { method: 'POST', body: {} });
          toast(`巩固完成：合并 ${r.merged} · 加固 ${r.boosted} · 沉睡 ${r.archived}`, 'ok');
          await reload();
        } catch (err) {
          toast(err.message, 'err');
        } finally {
          btn.disabled = false;
        }
      });

      root.querySelectorAll('[data-touch-mem]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          try {
            await api(`/api/memory/${encodeURIComponent(btn.dataset.touchMem)}/touch`, { method: 'POST', body: {} });
            toast('已加固这条记忆', 'ok');
            await reload();
          } catch (err) {
            toast(err.message, 'err');
            btn.disabled = false;
          }
        });
      });

      root.querySelectorAll('[data-mem-tab]').forEach((el) => {
        el.addEventListener('click', () => {
          App.state.memoryFilter = el.dataset.memTab;
          App.render();
        });
      });

      const search = root.querySelector('#memSearch');
      if (search) {
        let timer;
        search.addEventListener('input', () => {
          clearTimeout(timer);
          timer = setTimeout(async () => {
            App.state.memoryQuery = search.value.trim();
            await App.loadMemory();
            const active = document.activeElement === search;
            App.render();
            if (active) {
              const el = document.getElementById('memSearch');
              if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
            }
          }, 320);
        });
      }

      document.querySelector('[data-act="mem-add"]')?.addEventListener('click', () => openMemoryModal(null));

      root.querySelectorAll('[data-edit-mem]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const f = (App.state.memoryItems || []).find((x) => x.id === btn.dataset.editMem);
          openMemoryModal(f);
        });
      });

      root.querySelectorAll('[data-del-mem]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          await api(`/api/memory/${encodeURIComponent(btn.dataset.delMem)}`, { method: 'DELETE' });
          toast('已删除', 'ok');
          await reload();
        });
      });

      document.querySelector('[data-act="mem-clear"]')?.addEventListener('click', async () => {
        if (!(await Core.confirmDialog({
          title: '清空记忆库',
          message: '将删除全部长期记忆，AI 会忘记之前记住的所有事情。此操作不可恢复。',
          confirmText: '全部清空',
          danger: true,
        }))) return;
        await api('/api/memory', { method: 'DELETE' });
        toast('记忆库已清空', 'ok');
        await reload();
      });
    },
  };

  function openMemoryModal(fact) {
    const isNew = !fact;
    const f = fact || { id: '', scope: 'global', content: '', importance: 0.6 };
    const agents = App.state.config.agents || [];
    const scopeOptions = [
      { value: 'global', label: '公共认知（所有会话可见）' },
      ...agents.map((a) => ({ value: `agent:${a.id}`, label: `人格记忆 · ${a.name}` })),
    ];

    const mask = Core.openModal({
      title: isNew ? '添加记忆' : '编辑记忆',
      body: `
        ${field('记忆内容', textarea('mem-content', f.content, { rows: 3, placeholder: '一句话陈述，例如：用户叫李雷，是一名后端工程师' }), '第三人称陈述，不超过 200 字')}
        ${field('归属', select('mem-scope', scopeOptions, f.scope), '公共认知所有人可见；人格记忆只在该智能体下生效。用户记忆请在对话中由模型自动记录。')}
        ${field('重要度（0.1 ~ 1.0）', input('mem-imp', f.importance, { type: 'number' }), '越高越不容易被淘汰，也更容易被召回')}
      `,
      footer: `<button class="btn btn-ghost" data-close>取消</button>
               <button class="btn btn-primary" data-save>保存</button>`,
    });

    mask.querySelector('[data-save]').addEventListener('click', async () => {
      const content = mask.querySelector('#mem-content').value.trim();
      if (!content) { toast('请填写内容', 'err'); return; }
      const payload = {
        content,
        scope: mask.querySelector('#mem-scope').value,
        importance: Number(mask.querySelector('#mem-imp').value) || 0.6,
      };
      try {
        if (isNew) {
          await api('/api/memory', { method: 'POST', body: payload });
        } else {
          await api(`/api/memory/${encodeURIComponent(f.id)}`, { method: 'PUT', body: payload });
        }
        Core.closeModal(mask);
        toast('已保存', 'ok');
        await App.loadMemory();
        App.render();
      } catch (err) {
        toast(err.message, 'err');
      }
    });
  }

  // ============================================================
  // 账号接入（扫码登录）
  // ============================================================
  function renderQQLogin(st) {
    const cfg = App.state.config.channels.napcatWebui || {};
    const nc = App.state.napcat || {};
    const ob = App.state.onebot || {};

    // OneBot 连接状态条——判断「能不能收到 QQ 消息」只看这个
    let procBar;
    if (ob.ok) {
      procBar = `<div class="flex items-center gap-2" style="margin-bottom:14px;padding:10px 12px;background:var(--success-soft);border:1px solid #c9ecda;border-radius:8px">
        <span class="tag ok" style="background:#fff">已接入</span>
        <span class="text-sm" style="color:#0b6b3d">${escapeHtml(ob.nickname || 'QQ')}${ob.userId ? ` (${escapeHtml(ob.userId)})` : ''} · 反向 WS 已连接</span>
      </div>`;
    } else if (ob.connections > 0) {
      procBar = `<div class="notice warn" style="margin-bottom:14px">${icon('alert')}
        <div>WebSocket 已连上，但调用 OneBot 接口失败：${escapeHtml(ob.error || '未知原因')}</div>
      </div>`;
    } else {
      procBar = `<div class="notice warn" style="margin-bottom:14px">${icon('alert')}
        <div>还没收到 NapCat 的连接。请在 NapCat 的「网络配置」里添加 <b>WebSocket 客户端</b>，地址填
          <code style="font-size:12px">ws://127.0.0.1:8787/ws/onebot</code> 或
          <code style="font-size:12px">ws://127.0.0.1:8082/ws</code>，Token 与下方一致。</div>
      </div>`;
      if (nc.lastError) {
        procBar += `<div class="notice warn" style="margin-bottom:14px">${icon('alert')}
          <div>${escapeHtml(nc.lastError)}</div>
        </div>`;
      }
    }

    const statusTag = st.loggedIn
      ? '<span class="tag ok">已登录</span>'
      : st.reachable === true
        ? '<span class="tag warn">WebUI 已连接</span>'
        : st.reachable === false
          ? '<span class="tag danger">未连接</span>'
          : '<span class="tag">未检测</span>';

    let rightPanel;
    if (ob.ok) {
      // 已通过 OneBot 拿到账号信息，比 WebUI 的登录状态更可靠
      rightPanel = `
        <div style="text-align:center;padding:26px 0">
          <div class="avatar ai" style="width:68px;height:68px;border-radius:50%;font-size:20px;margin:0 auto">QQ</div>
          <div style="font-size:16px;font-weight:600;margin-top:12px">${escapeHtml(ob.nickname || '已接入')}</div>
          <div class="text-sm text-muted mono">QQ ${escapeHtml(ob.userId || '—')}</div>
          <div class="notice ok mt-4" style="text-align:left;background:var(--success-soft);border-color:#c9ecda;color:#0b6b3d">
            ${icon('check')}<div>NapCat 已连上，消息能进来也能发出去。</div>
          </div>
          <button class="btn btn-primary btn-lg mt-3" data-act="ncw-apply">${icon('zap', 15)} 启用为 AI 机器人</button>
        </div>`;
    } else if (st.loggedIn) {
      const acc = st.account || {};
      rightPanel = `
        <div style="text-align:center;padding:26px 0">
          ${acc.avatar
            ? `<img src="${escapeHtml(acc.avatar)}" style="width:68px;height:68px;border-radius:50%;border:1px solid var(--border)">`
            : `<div class="avatar ai" style="width:68px;height:68px;border-radius:50%;font-size:20px;margin:0 auto">QQ</div>`}
          <div style="font-size:16px;font-weight:600;margin-top:12px">${escapeHtml(acc.nickname || '已登录')}</div>
          <div class="text-sm text-muted mono">QQ ${escapeHtml(acc.uin || '—')}</div>
          <div class="notice ok mt-4" style="text-align:left;background:var(--success-soft);border-color:#c9ecda;color:#0b6b3d">
            ${icon('check')}<div>账号已登录 NapCat，现在把它接入 AI 即可开始工作。</div>
          </div>
          <button class="btn btn-primary btn-lg mt-3" data-act="ncw-apply">${icon('zap', 15)} 启用为 AI 机器人</button>
        </div>`;
    } else if (st.qrcode) {
      rightPanel = `
        <div style="display:flex;flex-direction:column;align-items:center;gap:10px;padding:18px 0">
          <img src="${st.qrcode}" alt="QQ 登录二维码"
            style="width:216px;height:216px;border:1px solid var(--border);border-radius:12px;padding:10px;background:#fff">
          <div style="font-size:13px;color:var(--text-2)">打开手机 QQ → 扫一扫</div>
          <div class="text-sm text-muted">扫码后请留意手机上的确认提示</div>
          <button class="btn btn-ghost btn-sm mt-2" data-act="ncw-refresh">${icon('refresh', 13)} 刷新二维码</button>
        </div>`;
    } else if (st.reachable === false) {
      rightPanel = emptyState('未检测到 NapCat', '请先启动 NapCat，再点击左侧「检测连接」', 'server');
    } else {
      rightPanel = emptyState('等待获取二维码', '完成左侧配置后点击「检测连接」', 'link');
    }

    return `
    <div class="grid grid-2" style="align-items:start">
      <div class="card">
        <div class="card-head">
          <h3>QQ 扫码登录</h3>
          ${statusTag}
        </div>
          <div class="card-body">
            ${procBar}
            ${field('NapCat WebUI 地址', input('ncw-base', cfg.baseUrl, { placeholder: 'http://127.0.0.1:6099', mono: true }), 'NapCat 启动后控制台会打印 WebUI 地址与 token')}
          ${field('WebUI Token', input('ncw-token', cfg.token, { placeholder: '控制台打印的 token', mono: true, type: 'password' }), '可在 NapCat 启动日志或 config/webui.json 中找到')}
          <button class="btn btn-primary" data-act="ncw-probe">${icon('link', 14)} 检测连接</button>

          ${st.error ? `<div class="notice warn mt-3">${icon('alert')}<div>${escapeHtml(st.error)}</div></div>` : ''}

          <hr class="hr">
          <div class="section-title">接入步骤</div>
          <div class="steps">
            <div class="step"><div class="num">1</div><div class="body"><strong>自己装一份 NapCat</strong><p>用 NapCat 一键包独立运行，与日常 QQ 互不干扰。装好后它会自己登录 QQ。</p></div></div>
            <div class="step"><div class="num">2</div><div class="body"><strong>加一个 WebSocket 客户端</strong><p>NapCat 的「网络配置」里填 <code>ws://127.0.0.1:8787/ws/onebot</code>（或 <code>ws://127.0.0.1:8082/ws</code>），Token 填下面这个。</p></div></div>
            <div class="step"><div class="num">3</div><div class="body"><strong>回来看状态</strong><p>顶部出现绿色「已接入」就说明通了，点右侧按钮启用为机器人。</p></div></div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h3>${ob.ok ? '连接状态' : '扫码区'}</h3><span class="sub">${ob.ok ? '消息收发通道正常' : '登录后本系统会自动接管消息'}</span></div>
        <div class="card-body">${rightPanel}</div>
      </div>
    </div>`;
  }

  function renderWechatLogin(st) {
    const cfg = App.state.config.channels.wechat;
    const configured = Boolean(cfg.appId && cfg.appSecret);

    let qrPanel;
    if (!configured) {
      qrPanel = `
        <div class="notice">${icon('info')}
          <div>请先在「渠道 → 微信公众号」填写 AppID 与 AppSecret，才能生成关注二维码。</div>
        </div>
        <button class="btn btn-ghost mt-3" data-act="goto-wechat-channel">${icon('arrow', 14)} 去配置公众号</button>`;
    } else if (st.wechatQr) {
      qrPanel = `
        <div style="display:flex;flex-direction:column;align-items:center;gap:10px;padding:16px 0">
          <img src="${st.wechatQr}" alt="公众号二维码"
            style="width:216px;height:216px;border:1px solid var(--border);border-radius:12px;padding:8px;background:#fff">
          <div style="font-size:13px;color:var(--text-2)">微信扫一扫 → 关注公众号</div>
          <div class="text-sm text-muted">关注后直接发消息即可对话</div>
          <button class="btn btn-ghost btn-sm mt-2" data-act="wx-qr">${icon('refresh', 13)} 重新生成</button>
        </div>`;
    } else {
      qrPanel = `
        <div style="text-align:center;padding:26px 0">
          <div class="empty" style="padding:0 0 16px">
            ${icon('wechat', 40)}
            <h4>生成公众号关注二维码</h4>
            <p>用户扫码关注后，就能在微信里直接和 AI 对话</p>
          </div>
          <button class="btn btn-primary" data-act="wx-qr">${icon('link', 14)} 生成二维码</button>
        </div>`;
    }

    return `
    <div class="grid grid-2" style="align-items:start">
      <div class="card">
        <div class="card-head"><h3>微信接入</h3></div>
        <div class="card-body">
          <div class="notice warn">${icon('alert')}
            <div>
              <strong>个人微信无法扫码登录。</strong>微信从未开放个人号的机器人接口，早期网页版协议已在 2017 年前后关闭。
              市面上「扫码登录个人微信」的方案都基于逆向协议，违反《微信个人帐号使用规范》，封号风险高，本项目不提供。
            </div>
          </div>

          <div class="section-title mt-3">官方支持的三条路</div>
          <table class="table" style="font-size:12.5px">
            <thead><tr><th>方式</th><th>能做什么</th><th>门槛</th></tr></thead>
            <tbody>
              <tr><td><strong>公众号</strong></td><td>粉丝私聊、被动回复、客服消息</td><td>注册即可</td></tr>
              <tr><td><strong>企业微信</strong></td><td>内部成员、应用消息、群聊</td><td>企业认证</td></tr>
              <tr><td><strong>微信客服</strong></td><td>外部客户咨询</td><td>企业认证</td></tr>
            </tbody>
          </table>

          <div class="notice info mt-3">${icon('info')}
            <div>三条路里，<strong>公众号</strong>门槛最低：注册后填好 AppID / AppSecret，用户扫码关注即可对话。右侧可以直接生成关注二维码。</div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h3>扫码关注</h3><span class="sub">微信官方唯一支持的扫码接入</span></div>
        <div class="card-body" style="text-align:center">${qrPanel}</div>
      </div>
    </div>`;
  }

  const loginView = {
    title: '账号接入',
    desc: '扫码登录 QQ，或扫码关注公众号接入微信',
    actions() {
      const tab = App.state.login?.tab || 'qq';
      return `<div style="display:flex;gap:4px;padding:4px;background:var(--surface-2);border-radius:8px">
        <button class="btn btn-sm ${tab === 'qq' ? 'btn-primary' : 'btn-ghost'}"
          style="${tab === 'qq' ? '' : 'background:transparent;border-color:transparent'}" data-login-tab="qq">QQ 扫码</button>
        <button class="btn btn-sm ${tab === 'wechat' ? 'btn-primary' : 'btn-ghost'}"
          style="${tab === 'wechat' ? '' : 'background:transparent;border-color:transparent'}" data-login-tab="wechat">微信</button>
      </div>`;
    },
    render() {
      const st = App.state.login;
      return st.tab === 'wechat' ? renderWechatLogin(st) : renderQQLogin(st);
    },
    mount(root) {
      const st = App.state.login;
      const nc = App.state.napcat;

      // 状态已在 navigate 阶段加载好。这里绝不能再触发 render——
      // 否则会替换掉下面刚绑定的按钮，表现就是「点了没反应」。
      const loadNc = () => App.loadNapcat();

      // 启动 / 停止
      root.querySelector('[data-act="nc-start"]')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.innerHTML = '<span class="loading-inline"></span> 启动中…';
        try {
          const r = await api('/api/napcat/start', { method: 'POST' });
          if (!r.ok) throw new Error(r.error || '启动失败');
          nc.starting = true;
          App.render();
          pollNc();
        } catch (err) {
          toast(err.message, 'err');
          nc.starting = false;
          App.render();
        }
      });

      root.querySelector('[data-act="nc-stop"]')?.addEventListener('click', async () => {
        if (!(await Core.confirmDialog({
          title: '停止 NapCat',
          message: '会结束 QQ 进程。下次启动服务时会自动重新拉起。',
          confirmText: '停止',
          danger: true,
        }))) return;
        try {
          await api('/api/napcat/stop', { method: 'POST' });
          nc.running = false;
          nc.pid = null;
          App.render();
          toast('已停止', 'ok');
        } catch (err) {
          toast(err.message, 'err');
        }
      });

      // 启动后轮询直到就绪
      const pollNc = () => {
        if (nc.timer) return;
        let n = 0;
        nc.timer = setInterval(async () => {
          n += 1;
          await loadNc();
          // 起来了、报错了、或超时，都要停下来
          if (nc.running || nc.lastError || n > 40) {
            clearInterval(nc.timer);
            nc.timer = null;
            nc.starting = false;
            if (App.state.route === 'login') App.render();
            if (nc.running) toast('NapCat 已就绪', 'ok');
            else if (nc.lastError) toast(nc.lastError, 'err');
          }
        }, 1500);
      };
      if (nc.starting) pollNc();

      // tab 按钮在顶栏，不在 root 内，需从 document 查询
      document.querySelectorAll('[data-login-tab]').forEach((el) => {
        el.addEventListener('click', () => {
          st.tab = el.dataset.loginTab;
          App.render();
        });
      });

      document.querySelector('[data-act="goto-wechat-channel"]')?.addEventListener('click', () => {
        App.state.channelTab = 'wechat';
        App.navigate('channels');
      });

      // ---- QQ：检测连接 ----
      root.querySelector('[data-act="ncw-probe"]')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        const baseUrl = root.querySelector('#ncw-base').value.trim();
        const token = root.querySelector('#ncw-token').value.trim();
        if (!baseUrl) { toast('请填写 WebUI 地址', 'err'); return; }

        btn.disabled = true;
        btn.innerHTML = '<span class="loading-inline"></span> 检测中…';
        st.error = '';
        try {
          const probe = await api('/api/login/napcat/probe', {
            method: 'POST',
            body: { baseUrl, token },
          });
          st.reachable = probe.reachable;
          if (!probe.reachable) {
            st.error = `无法连接 ${probe.baseUrl}。请确认 NapCat 已启动，且地址端口正确。`;
            App.render();
            return;
          }

          // 已经通过 OneBot 反向 WS 连上了，就不必再走 WebUI 扫码
          await App.loadNapcat();
          if (App.state.onebot?.ok) {
            toast('NapCat 已连接，无需重复登录', 'ok');
            App.render();
            return;
          }
          if (!token) {
            st.error = 'WebUI 已连通，但还需要填写 Token 才能获取二维码。';
            App.render();
            return;
          }

          // 先看是否已经登录
          const status = await api('/api/login/napcat/status', { method: 'POST' }).catch(() => null);
          if (status?.isLogin) {
            st.loggedIn = true;
            st.account = status.info;
            App.render();
            toast('该账号已登录', 'ok');
            return;
          }

          const qr = await api('/api/login/napcat/qrcode', { method: 'POST' });
          st.qrcode = qr.qrcode;
          App.state.config.channels.napcatWebui = { baseUrl, token };
          await App.saveConfig();
          App.render();
          startPolling();
        } catch (err) {
          st.error = err.message;
          App.render();
        } finally {
          const b = root.querySelector('[data-act="ncw-probe"]');
          if (b) { b.disabled = false; b.innerHTML = `${icon('link', 14)} 检测连接`; }
        }
      });

      // ---- QQ：刷新二维码 ----
      root.querySelector('[data-act="ncw-refresh"]')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        try {
          const r = await api('/api/login/napcat/refresh', { method: 'POST' });
          st.qrcode = r.qrcode;
          App.render();
          toast('二维码已刷新', 'ok');
        } catch (err) {
          toast(err.message, 'err');
          btn.disabled = false;
        }
      });

      // ---- QQ：启用为机器人 ----
      root.querySelector('[data-act="ncw-apply"]')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.innerHTML = '<span class="loading-inline"></span> 配置中…';
        try {
          const r = await api('/api/login/napcat/apply', {
            method: 'POST',
            body: { selfId: st.account?.uin || '' },
          });
          await App.refresh();
          toast(`已接入 · OneBot API ${r.apiBase}`, 'ok');
          setTimeout(() => App.navigate('channels'), 600);
        } catch (err) {
          toast(err.message, 'err');
          btn.disabled = false;
          btn.innerHTML = `${icon('zap', 15)} 启用为 AI 机器人`;
        }
      });

      // ---- 微信：生成二维码 ----
      root.querySelector('[data-act="wx-qr"]')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.innerHTML = '<span class="loading-inline" style="border-color:rgba(67,97,238,.25);border-top-color:var(--primary)"></span> 生成中…';
        try {
          const r = await api('/api/login/wechat/qrcode', { method: 'POST' });
          st.wechatQr = r.image;
          App.render();
          toast('二维码已生成，30 天内有效', 'ok');
        } catch (err) {
          toast(err.message, 'err');
          btn.disabled = false;
          btn.innerHTML = `${icon('link', 14)} 生成二维码`;
        }
      });

      // 已有二维码且未登录时，继续轮询
      if (st.qrcode && !st.loggedIn) startPolling();
    },
  };

  function startPolling() {
    const st = App.state.login;
    if (st.polling) return;
    st.polling = setInterval(async () => {
      if (App.state.route !== 'login') { stopPolling(); return; }
      try {
        const r = await api('/api/login/napcat/status', { method: 'POST' });
        if (r.isLogin) {
          stopPolling();
          st.loggedIn = true;
          st.account = r.info;
          st.qrcode = '';
          App.render();
          toast(`登录成功${r.info?.nickname ? ' · ' + r.info.nickname : ''}`, 'ok');
        } else if (!r.hasQrcode && st.qrcode) {
          st.qrcode = '';
          App.render();
        }
      } catch (_) { /* 忽略轮询错误 */ }
    }, 2500);
  }

  function stopPolling() {
    const st = App.state.login;
    if (st?.polling) {
      clearInterval(st.polling);
      st.polling = null;
    }
  }

  // ============================================================
  // 好友管理
  // ============================================================
  const friendsView = {
    title: '好友管理',
    desc: '查看、点赞、删除 QQ 好友',
    actions() {
      return `<button class="btn btn-ghost btn-sm" data-act="friends-refresh">${icon('refresh', 14)} 刷新</button>`;
    },
    render() {
      const st = App.state.friends;
      const enabled = App.state.config.channels.onebot?.enabled;

      if (!enabled) {
        return `
        <div class="card">
          <div class="card-body" style="text-align:center;padding:52px 24px">
            <div class="empty" style="padding:0 0 18px">
              ${icon('link', 40)}
              <h4>OneBot 渠道未启用</h4>
              <p>需要先在「账号接入」用手机 QQ 扫码登录，才能管理好友</p>
            </div>
            <button class="btn btn-primary" data-act="goto-login">${icon('link', 14)} 去扫码登录</button>
          </div>
        </div>`;
      }

      const q = String(st.query || '').trim().toLowerCase();
      const all = st.items || [];
      const list = q
        ? all.filter((f) => String(f.user_id).includes(q)
          || (f.nickname || '').toLowerCase().includes(q)
          || (f.remark || '').toLowerCase().includes(q))
        : all;

      return `
      <div class="card">
        <div class="card-head">
          <h3>QQ 好友</h3>
          <span class="sub">共 ${all.length} 位</span>
          <div style="margin-left:auto">
            <input class="input" id="friendSearch" placeholder="搜索昵称 / 备注 / QQ 号"
              value="${escapeHtml(st.query || '')}" style="width:240px;height:32px;font-size:13px">
          </div>
        </div>
        <div class="list">
          ${list.map((f) => {
            const label = f.remark || f.nickname || '未知';
            const sub = (f.remark && f.nickname && f.remark !== f.nickname)
              ? `<span style="color:var(--text-3);font-weight:400"> · ${escapeHtml(f.nickname)}</span>` : '';
            return `<div class="list-row">
              <div class="avatar me" style="width:32px;height:32px;border-radius:50%;font-size:12px;flex:none">${escapeHtml(label.slice(0, 1))}</div>
              <div class="grow">
                <div class="name" style="font-weight:450">${escapeHtml(label)}${sub}</div>
                <div class="desc mono">${escapeHtml(f.user_id)}</div>
              </div>
              <button class="btn btn-ghost btn-sm" data-like="${escapeHtml(f.user_id)}" title="给名片点赞">${icon('zap', 14)}</button>
              <button class="btn btn-danger btn-sm btn-icon" data-del-friend="${escapeHtml(f.user_id)}" title="删除好友">${icon('trash', 13)}</button>
            </div>`;
          }).join('') || `<div style="padding:36px;text-align:center" class="text-sm text-muted">
            ${st.loading ? '加载中…' : (q ? '没有匹配的好友' : '好友列表为空')}
          </div>`}
        </div>
      </div>

      <div class="notice info mt-4">${icon('info')}
        <div>
          <strong>删除好友不可恢复</strong>，删除后对方不会收到通知，但会从你的好友列表里消失。
          <strong>名片点赞</strong>对同一好友每天只能点 1 次，每天总共最多 10 次，超出会被 QQ 拒绝。
        </div>
      </div>`;
    },
    mount(root) {
      const st = App.state.friends;

      // 直接打开 /#/friends 时 hashchange 不触发，这里兜底加载一次
      if (!st.loaded) {
        st.loaded = true;
        App.loadFriends().then(() => App.render());
      }

      document.querySelector('[data-act="friends-refresh"]')?.addEventListener('click', () => {
        App.loadFriends().then(() => App.render());
      });

      root.querySelector('[data-act="goto-login"]')?.addEventListener('click', () => App.navigate('login'));

      const search = root.querySelector('#friendSearch');
      if (search) {
        let timer;
        search.addEventListener('input', () => {
          clearTimeout(timer);
          timer = setTimeout(() => {
            st.query = search.value;
            App.render();
            const el = document.getElementById('friendSearch');
            if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
          }, 180);
        });
      }

      root.querySelectorAll('[data-like]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const id = btn.dataset.like;
          btn.disabled = true;
          try {
            await api('/api/onebot/friends/like', { method: 'POST', body: { user_id: id, times: 1 } });
            toast('已点赞', 'ok');
          } catch (err) {
            toast(err.message, 'err');
            btn.disabled = false;
          }
        });
      });

      root.querySelectorAll('[data-del-friend]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const id = btn.dataset.delFriend;
          const f = (App.state.friends.items || []).find((x) => x.user_id === id);
          const name = f?.remark || f?.nickname || id;
          if (!(await Core.confirmDialog({
            title: '删除好友',
            message: `确定要删除「${name}」（${id}）吗？此操作不可恢复，对方不会收到通知。`,
            confirmText: '删除',
            danger: true,
          }))) return;

          btn.disabled = true;
          try {
            await api(`/api/onebot/friends/${encodeURIComponent(id)}`, { method: 'DELETE' });
            App.state.friends.items = App.state.friends.items.filter((x) => x.user_id !== id);
            App.render();
            toast(`已删除 ${name}`, 'ok');
          } catch (err) {
            toast(err.message, 'err');
            btn.disabled = false;
          }
        });
      });
    },
  };

  // ============================================================
  // 会话
  // ============================================================
  const sessions = {
    title: '会话记录',
    desc: '查看各渠道的历史对话',
    actions() {
      return `<button class="btn btn-danger btn-sm" data-act="clear-sessions">${icon('trash', 14)} 清空全部</button>`;
    },
    render() {
      const list = App.state.sessions || [];
      if (!list.length) return `<div class="card">${emptyState('还没有会话', '在「对话」页发一条消息，或等待渠道用户接入')}</div>`;

      const channelName = { web: '网页', wechat: '微信', wecom: '企微', qq: 'QQ' };
      const rows = list.map((s) => `<tr data-open="${escapeHtml(s.id)}" style="cursor:pointer">
        <td><div style="font-weight:550">${escapeHtml(s.title || '（无标题）')}</div>
          <div class="text-sm text-muted mono">${escapeHtml(s.id.slice(0, 40))}</div></td>
        <td><span class="tag ${s.channel === 'web' ? 'info' : ''}">${channelName[s.channel] || s.channel}</span></td>
        <td>${escapeHtml(s.agentName || '—')}</td>
        <td>${s.messageCount}</td>
        <td class="text-sm text-muted">${timeAgo(s.updatedAt)}</td>
        <td><button class="btn btn-danger btn-sm btn-icon" data-del-session="${escapeHtml(s.id)}">${icon('trash', 13)}</button></td>
      </tr>`).join('');

      return `<div class="card">
        <table class="table">
          <thead><tr><th>会话</th><th>渠道</th><th>智能体</th><th>消息</th><th>更新时间</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
    },
    mount(root) {
      root.querySelectorAll('[data-open]').forEach((tr) => {
        tr.addEventListener('click', async (e) => {
          if (e.target.closest('[data-del-session]')) return;
          const id = tr.dataset.open;
          try {
            const s = await api(`/api/sessions/${encodeURIComponent(id)}`);
            const body = s.messages.map((m) => {
              const isUser = m.role === 'user';
              return `<div style="margin-bottom:12px;display:flex;flex-direction:column;align-items:${isUser ? 'flex-end' : 'flex-start'}">
                <div style="font-size:11px;color:var(--text-3);margin-bottom:3px">${isUser ? '用户' : 'AI'} · ${fmtTime(m.ts)}</div>
                <div style="max-width:88%;padding:9px 13px;border-radius:10px;font-size:13px;line-height:1.65;white-space:pre-wrap;
                  background:${isUser ? 'var(--primary)' : 'var(--surface-2)'};color:${isUser ? '#fff' : 'var(--text)'};
                  border:${isUser ? 'none' : '1px solid var(--border)'}">${escapeHtml(m.content || '')}</div>
              </div>`;
            }).join('');
            Core.openModal({
              title: s.title || '会话详情',
              wide: true,
              body: `<div style="max-height:56vh;overflow-y:auto">${body || '<div class="text-muted">暂无消息</div>'}</div>`,
            });
          } catch (err) {
            toast(err.message, 'err');
          }
        });
      });

      root.querySelectorAll('[data-del-session]').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const id = btn.dataset.delSession;
          if (!(await Core.confirmDialog({ title: '删除会话', message: '删除后不可恢复，确定继续？', confirmText: '删除', danger: true }))) return;
          await api(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
          App.loadSessions().then(() => App.render());
          toast('已删除', 'ok');
        });
      });

      document.querySelector('[data-act="clear-sessions"]')?.addEventListener('click', async () => {
        if (!(await Core.confirmDialog({ title: '清空全部会话', message: '将删除所有渠道的对话记录，此操作不可恢复。', confirmText: '全部删除', danger: true }))) return;
        await api('/api/sessions', { method: 'DELETE' });
        App.loadSessions().then(() => App.render());
        toast('已清空', 'ok');
      });
    },
  };

  // ============================================================
  // 日志
  // ============================================================
  const logs = {
    title: '运行日志',
    desc: '实时查看服务端事件，便于排查接入问题',
    actions() {
      return `<button class="btn btn-ghost btn-sm" data-act="clear-logs">${icon('trash', 14)} 清空</button>`;
    },
    render() {
      return `<div class="card">
        <div class="card-head"><h3>日志流</h3><span class="sub">每 2 秒自动刷新</span></div>
        <div class="log-stream" id="logStream"></div>
      </div>`;
    },
    mount(root) {
      const box = root.querySelector('#logStream');

      // level 直接拼进 class 属性，只放行 [a-z-]；别的字符一律丢掉
      const levelCls = (lvl) => (/^[a-z-]+$/i.test(String(lvl || '')) ? String(lvl).toLowerCase() : '');

      const paint = (list) => {
        if (!box.isConnected) return;
        box.innerHTML = list.slice().reverse().map((l) => `
          <div class="log-line ${levelCls(l.level)}">
            <span class="t">${fmtClock(l.ts)}</span>
            <span class="s">${escapeHtml(l.scope)}</span>
            <span class="m">${escapeHtml(l.message)}</span>
          </div>`).join('') || '<div class="text-muted">暂无日志</div>';
      };
      App.fetchLogs().then(paint);

      // 幂等：同一页可能被重渲染多次，先清掉旧定时器，否则轮询会越叠越多
      if (App.state.logTimer) { clearInterval(App.state.logTimer); App.state.logTimer = null; }
      App.state.logTimer = setInterval(() => {
        if (App.state.route !== 'logs') {
          clearInterval(App.state.logTimer);
          App.state.logTimer = null;
          return;
        }
        App.fetchLogs().then(paint);
      }, 2000);

      document.querySelector('[data-act="clear-logs"]')?.addEventListener('click', async () => {
        await api('/api/logs', { method: 'DELETE' });
        paint([]);
        toast('已清空', 'ok');
      });
    },
  };

  // ============================================================
  // 设置
  // ============================================================
  const settings = {
    title: '系统设置',
    desc: '公网地址、联网搜索与数据管理',
    actions() {
      return `<button class="btn btn-primary btn-sm" data-act="save-settings">${icon('check', 14)} 保存</button>`;
    },
    render() {
      const cfg = App.state.config;
      const st = App.state.status;
      const search = cfg.search || { provider: 'none', apiKey: '' };

      return `
      <div class="grid grid-2" style="align-items:start">
        <div class="card">
          <div class="card-head"><h3>服务与网络</h3></div>
          <div class="card-body">
            ${field('服务端口', input('set-port', cfg.server.port, { type: 'number', mono: true }), '修改后需重启服务生效')}
            ${field('公网地址', input('set-public', cfg.server.publicUrl, { placeholder: 'https://ai.example.com', mono: true }), '用于生成微信/QQ 回调地址。使用内网穿透时填穿透后的域名')}
            <div class="kv mt-3">
              <div class="kv-row"><span class="k">本地访问</span><span class="v mono">http://localhost:${st.port}</span></div>
              <div class="kv-row"><span class="k">Node 版本</span><span class="v mono">${st.node}</span></div>
              <div class="kv-row"><span class="k">运行时长</span><span class="v">${formatUptime(st.uptime)}</span></div>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h3>联网搜索</h3><span class="sub">供「联网搜索」工具使用</span></div>
          <div class="card-body">
            ${field('服务商', select('set-search', [
              { value: 'none', label: '不启用' },
              { value: 'tavily', label: 'Tavily（推荐）' },
              { value: 'serper', label: 'Serper (Google)' },
            ], search.provider))}
            ${field('API Key', input('set-search-key', search.apiKey, { placeholder: 'tvly-...', mono: true, type: 'password' }))}
            <div class="notice">${icon('info')}
              <div>配置后，智能体可在需要实时信息时自动调用搜索工具。未配置时模型会明确告知无法联网。</div>
            </div>
          </div>
        </div>
      </div>

      <div class="card mt-4">
        <div class="card-head"><h3>长期记忆</h3><span class="sub">跨会话共享的认知</span></div>
        <div class="card-body">
          <div class="switch-row">
            ${switchEl('sw-mem-enabled', cfg.memory?.enabled !== false)}
            <div><div class="label">启用长期记忆</div><div class="hint">对话前自动注入相关记忆，模型也可主动写入</div></div>
          </div>
          <div class="switch-row" style="border-top:1px solid var(--border)">
            ${switchEl('sw-mem-auto', cfg.memory?.autoExtract !== false)}
            <div><div class="label">自动提炼</div><div class="hint">每轮对话后异步提炼值得记住的事实，会额外消耗少量 token</div></div>
          </div>
          <div class="switch-row" style="border-top:1px solid var(--border)">
            ${switchEl('sw-mem-link', cfg.memory?.link?.enabled === true)}
            <div style="flex:1">
              <div class="label">与 QQ 共用记忆</div>
              <div class="hint">桌面程序里说的事，QQ 上问它也会记得；填你私聊它用的那个 QQ 号。人格记忆本来就跨渠道共享，这里管的是「关于你」的部分</div>
            </div>
            <input class="input" id="set-mem-link-qq" style="width:170px"
              placeholder="QQ 号" value="${escapeHtml(cfg.memory?.link?.userId || '')}" />
          </div>
          <div class="grid grid-2 mt-3" style="gap:14px">
            <div>${field('每次召回条数', input('set-mem-limit', cfg.memory?.injectLimit || 12, { type: 'number' }), '注入 system prompt 的记忆上限，建议 8~15')}</div>
            <div>${field('提炼用模型', input('set-mem-model', cfg.memory?.model || '', { placeholder: '留空则用智能体的模型', mono: true }), '可指定更便宜的小模型做提炼')}</div>
          </div>
          <div class="notice mt-2">${icon('info')}
            <div>关闭「自动提炼」后，模型仍可通过「主动记忆」工具写入；关闭「启用长期记忆」则完全停用记忆功能。记忆内容可在「记忆」页查看和编辑。</div>
          </div>
        </div>
      </div>

      <div class="card mt-4">
        <div class="card-head">
          <h3>电脑操控</h3>
          <span class="sub">让 AI 真的能看屏幕、动鼠标、敲键盘</span>
        </div>
        <div class="card-body">
          <div class="switch-row">
            ${switchEl('sw-pc-enabled', cfg.computer?.enabled === true)}
            <div><div class="label">允许 AI 操控这台电脑</div><div class="hint">开启后，「电脑管家」智能体可以截屏、移动鼠标、输入文字、开关窗口</div></div>
          </div>
          <div class="switch-row" style="border-top:1px solid var(--border)">
            ${switchEl('sw-pc-launch', cfg.computer?.allowLaunch !== false)}
            <div><div class="label">允许启动程序</div><div class="hint">打开 exe、文档或网址</div></div>
          </div>
          <div class="switch-row" style="border-top:1px solid var(--border)">
            ${switchEl('sw-pc-shell', cfg.computer?.allowShell === true)}
            <div><div class="label">允许执行命令 <span class="chip" style="color:var(--danger)">高危</span></div><div class="hint">让 AI 在 cmd 里跑命令。格式化、改启动项、删系统服务等操作会被安全策略直接拒绝</div></div>
          </div>
          <div class="grid grid-2 mt-3" style="gap:14px">
            <div>${field('截图最大宽度', input('set-pc-width', cfg.computer?.maxWidth || 1600, { type: 'number' }), '越小越省 token，看不清细节时可调到 2200')}</div>
            <div>${field('截图质量', input('set-pc-quality', cfg.computer?.quality || 62, { type: 'number' }), 'JPEG 质量 30~90，默认 62')}</div>
          </div>
          <div class="notice mt-2">${icon('info')}
            <div>操控能力只对绑定了<b>网页端</b>的智能体生效——绑到 QQ 或微信，等于把电脑交给任何一个能给你发消息的人。操作全程会记在「运行日志」里。</div>
          </div>
          <div class="notice mt-2">${icon('eye')}
            <div>「电脑管家」用的模型<b>必须支持图片输入</b>，否则它截了屏也看不见。纯文本模型（如只写代码的那类）请换一个带视觉的。</div>
          </div>
        </div>
      </div>

      <div class="card mt-4">
        <div class="card-head" data-act="backup-head" style="cursor:pointer" title="点击展开或收起">
          <h3>配置备份</h3>
          <span class="sub">每次修改自动存档，保留最近 40 版</span>
          <div style="margin-left:auto;display:flex;gap:8px;align-items:center">
            <button class="btn btn-ghost btn-sm" data-act="backup-now">${icon('history', 13)} 立即备份</button>
            <button class="btn btn-ghost btn-sm" data-act="backup-toggle" aria-expanded="false">展开</button>
          </div>
        </div>
        <div id="backupBody" hidden>
          <div class="list" id="backupList">
            <div class="text-sm text-muted" style="padding:16px">加载中…</div>
          </div>
        </div>
      </div>

      <div class="card mt-4">
        <div class="card-head"><h3>数据管理</h3></div>
        <div class="list">
          <div class="list-row">
            <div class="grow"><div class="name">配置备份</div><div class="desc">导出当前全部配置（含密钥），用于迁移或备份</div></div>
            <button class="btn btn-ghost btn-sm" data-act="export">${icon('copy', 13)} 导出 JSON</button>
          </div>
          <div class="list-row">
            <div class="grow"><div class="name">导入配置</div><div class="desc">从 JSON 文件恢复配置，会覆盖当前设置</div></div>
            <button class="btn btn-ghost btn-sm" data-act="import">${icon('arrow', 13)} 选择文件</button>
            <input type="file" id="importFile" accept="application/json" style="display:none">
          </div>
          <div class="list-row">
            <div class="grow"><div class="name">清空会话记录</div><div class="desc">删除所有渠道的对话历史，配置不受影响</div></div>
            <button class="btn btn-danger btn-sm" data-act="wipe">${icon('trash', 13)} 清空</button>
          </div>
        </div>
      </div>

      <div class="card mt-4">
        <div class="card-head"><h3>关于</h3></div>
        <div class="card-body">
          <div class="kv">
            <div class="kv-row"><span class="k">版本</span><span class="v">AIBridge v${st.version}</span></div>
            <div class="kv-row"><span class="k">数据存储</span><span class="v mono">data/config.json · data/sessions.json</span></div>
            <div class="kv-row"><span class="k">依赖</span><span class="v">零第三方依赖，仅需 Node.js ≥ 18</span></div>
          </div>
        </div>
      </div>`;
    },
    mount(root) {
      root.querySelectorAll('.switch').forEach((sw) => {
        sw.addEventListener('click', () => sw.classList.toggle('on'));
      });

      // ---- 配置备份 ----
      const renderBackups = async () => {
        const box = document.getElementById('backupList');
        if (!box) return;
        try {
          const r = await api('/api/backups');
          const items = r.items || [];
          box.innerHTML = items.length
            ? items.map((b) => `
              <div class="list-row">
                <div class="grow">
                  <div class="name" style="font-weight:450">
                    ${fmtTime(b.mtime)}${b.name.includes('manual') ? '<span class="tag info" style="margin-left:8px">手动</span>' : ''}
                  </div>
                  <div class="desc">
                    ${b.agents.length ? '智能体：' + escapeHtml(b.agents.join('、')) : '无智能体'}
                    · ${(b.size / 1024).toFixed(1)} KB
                  </div>
                </div>
                <button class="btn btn-ghost btn-sm" data-restore="${escapeHtml(b.name)}">恢复</button>
              </div>`).join('')
            : '<div class="text-sm text-muted" style="padding:16px">还没有备份。修改任何配置后会自动生成。</div>';

          box.querySelectorAll('[data-restore]').forEach((btn) => {
            btn.addEventListener('click', () => doRestore(btn.dataset.restore));
          });
        } catch (err) {
          box.innerHTML = `<div class="text-sm text-muted" style="padding:16px">加载失败：${escapeHtml(err.message)}</div>`;
        }
      };

      const doRestore = async (name) => {
        if (!(await Core.confirmDialog({
          title: '恢复配置',
          message: `将用这个版本覆盖当前配置。当前版本会先自动存档，随时可以再切回来。`,
          confirmText: '恢复',
        }))) return;
        try {
          const r = await api('/api/backups/restore', { method: 'POST', body: { name } });
          await App.refresh();
          toast(`已恢复 · ${r.agents} 个智能体`, 'ok');
          renderBackups();
        } catch (err) {
          toast(err.message, 'err');
        }
      };

      const backupBody = document.getElementById('backupBody');
      const backupToggle = document.querySelector('[data-act="backup-toggle"]');

      const setBackupOpen = (open) => {
        if (!backupBody) return;
        backupBody.hidden = !open;
        if (backupToggle) {
          backupToggle.textContent = open ? '收起' : '展开';
          backupToggle.setAttribute('aria-expanded', String(open));
        }
        if (open) renderBackups();
      };

      document.querySelector('[data-act="backup-head"]')?.addEventListener('click', () => {
        setBackupOpen(Boolean(backupBody?.hidden));
      });

      document.querySelector('[data-act="backup-toggle"]')?.addEventListener('click', (e) => {
        e.stopPropagation();
        setBackupOpen(Boolean(backupBody?.hidden));
      });

      document.querySelector('[data-act="backup-now"]')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          await api('/api/backups', { method: 'POST' });
          toast('已创建备份', 'ok');
          setBackupOpen(true);
        } catch (err) {
          toast(err.message, 'err');
        }
      });

      document.querySelector('[data-act="save-settings"]')?.addEventListener('click', async () => {
        const cfg = App.state.config;
        cfg.server.publicUrl = root.querySelector('#set-public').value.trim().replace(/\/+$/, '');
        cfg.search = {
          provider: root.querySelector('#set-search').value,
          apiKey: root.querySelector('#set-search-key').value.trim(),
        };
        cfg.memory = {
          ...cfg.memory,
          enabled: root.querySelector('#sw-mem-enabled').classList.contains('on'),
          autoExtract: root.querySelector('#sw-mem-auto').classList.contains('on'),
          injectLimit: Number(root.querySelector('#set-mem-limit').value) || 12,
          model: root.querySelector('#set-mem-model').value.trim(),
          link: {
            enabled: root.querySelector('#sw-mem-link').classList.contains('on'),
            channel: cfg.memory?.link?.channel || 'onebot',
            userId: root.querySelector('#set-mem-link-qq').value.trim(),
          },
        };
        cfg.computer = {
          ...cfg.computer,
          enabled: root.querySelector('#sw-pc-enabled').classList.contains('on'),
          allowLaunch: root.querySelector('#sw-pc-launch').classList.contains('on'),
          allowShell: root.querySelector('#sw-pc-shell').classList.contains('on'),
          maxWidth: Number(root.querySelector('#set-pc-width').value) || 1600,
          quality: Number(root.querySelector('#set-pc-quality').value) || 62,
        };
        await App.saveConfig();
        toast('设置已保存', 'ok');
      });

      document.querySelector('[data-act="export"]')?.addEventListener('click', () => {
        const blob = new Blob([JSON.stringify(App.state.config, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `aibridge-config-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        toast('已导出', 'ok');
      });

      document.querySelector('[data-act="import"]')?.addEventListener('click', () => {
        root.querySelector('#importFile').click();
      });

      root.querySelector('#importFile')?.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        try {
          const text = await file.text();
          const json = JSON.parse(text);
          if (!json.providers || !json.agents) throw new Error('文件格式不正确');
          App.state.config = json;
          await App.saveConfig();
          await App.refresh(true);
          toast('配置已导入', 'ok');
        } catch (err) {
          toast(`导入失败：${err.message}`, 'err');
        }
      });

      document.querySelector('[data-act="wipe"]')?.addEventListener('click', async () => {
        if (!(await Core.confirmDialog({ title: '清空会话', message: '将删除所有渠道的对话历史，此操作不可恢复。', confirmText: '清空', danger: true }))) return;
        await api('/api/sessions', { method: 'DELETE' });
        toast('已清空', 'ok');
      });
    },
  };

  // ---------------- 游戏 ----------------
  function gameShotHtml(st) {
    const fr = App.state.mc?.frames;
    if (fr?.running) {
      return `<img id="mc-live" src="/api/mc/frame?t=${Date.now()}"
        style="width:100%;border-radius:8px;border:1px solid var(--border);display:block;background:#000">
        <div class="text-sm text-muted mt-2">实时画面 · ${fr.fps || 0} fps · 操作权归 AI</div>`;
    }
    if (!st || !st.lastShot) {
      return `<div class="empty">${icon('play', 40)}<h4>还没有画面</h4><p>点开始后，每一轮都会截一张</p></div>`;
    }
    return `<img src="/api/game/shot?t=${st.lastShot.at}"
      style="width:100%;border-radius:8px;border:1px solid var(--border);display:block">`;
  }

  function stepLabel(h) {
    const a = h.action;
    if (a === 'look') return `look yaw=${h.yaw ?? '?'} pitch=${h.pitch ?? '?'}`;
    if (a === 'hold') return `hold ${h.key || ''} ${h.ms || 0}ms`;
    if (a === 'key') return `key ${h.key || ''}`;
    if (a === 'select') return `select 第${Number(h.slot || 0) + 1}格`;
    if (a === 'chat') return `chat "${String(h.text || '').slice(0, 24)}"`;
    if (a === 'blocks') return `扫描方块 r=${h.r || 4}${h.filter ? ` ${h.filter}` : ''}`;
    if (a === 'see') return '看一眼画面';
    if (a === 'attack') return '左键';
    if (a === 'use') return '右键';
    if (a === 'mc') return `mc ${h.cmd || '?'}${h.text ? ` ${h.text}` : ''}`;
    return `${a}${h.key ? ` ${h.key}` : ''}${h.x !== undefined ? ` (${h.x},${h.y})` : ''}`;
  }

  function gameHistoryHtml(st) {
    const list = (st && st.history) || [];
    if (!list.length) return '<div class="text-muted text-sm">还没有动作</div>';
    return list.slice().reverse().map((h) => {
      const act = stepLabel(h);
      const flag = h.done ? '<span class="tag ok">完成</span>'
        : h.dryRun ? '<span class="tag">干跑</span>'
          : h.skipped ? '<span class="tag warn">跳过</span>'
            : h.error ? '<span class="tag danger">失败</span>'
              : h.note ? `<span class="tag ok">${escapeHtml(h.note)}</span>` : '';
      return `<div class="flex items-start gap-2" style="padding:7px 0;border-bottom:1px solid var(--border)">
        <span class="tag" style="flex-shrink:0">${h.round}</span>
        <div style="min-width:0">
          <div class="text-sm" style="font-family:var(--mono)">${escapeHtml(act)} ${flag}</div>
          <div class="text-sm text-muted">${escapeHtml(h.reason || '')}${h.error ? ` · ${escapeHtml(h.error)}` : ''}</div>
        </div>
      </div>`;
    }).join('');
  }

  /** 进程内直连状态：agent 在不在、能不能玩、jar 是哪版 */
  function agentCardHtml() {
    const a = App.state.mc?.agent;
    if (!a) return '';
    const online = Boolean(a.online);
    const missing = a.missing || [];
    const full = online && missing.length === 0;
    const build = a.build || {};
    // build.ok 是后端综合判断（有 javac 且版本够读游戏 jar）；
    // 老接口没有这个字段，退回只看 jdk 是否存在
    const canBuild = build.ok !== undefined ? Boolean(build.ok) : Boolean(build.jdk);
    const need = Number(build.requiredJava) || 21;
    const hasClient = build.versionJar ? build.versionJar.exists !== false : true;

    const badge = !online
      ? '<span class="tag">未连接</span>'
      : full
        ? '<span class="tag ok">已连接 · 全部能力</span>'
        : `<span class="tag warn">旧版 · 缺 ${missing.length} 项</span>`;

    // 编译按钮只在环境齐了的时候给；缺 JDK 时给下载入口，别让人点了才发现不行
    const buildRow = canBuild
      ? `<div class="flex gap-2 mt-2">
          <button class="btn btn-ghost btn-sm" data-act="mc-agent-build">${icon('refresh', 13)} 重新编译 agent</button>
        </div>`
      : `<div class="flex gap-2 mt-2 items-center">
          <button class="btn btn-ghost btn-sm" data-act="mc-agent-build">${icon('refresh', 13)} 重新编译 agent</button>
          <a class="text-sm" href="${escapeHtml(build.downloadUrl || 'https://adoptium.net/')}" target="_blank" rel="noopener">下载 JDK ${need}+</a>
        </div>`;

    let body;
    if (!online) {
      body = `<div class="text-sm text-muted">游戏没在跑，或者没带 <code>-javaagent</code> 启动。
        用下面的「启动游戏」按钮启动，agent 会自动加载，4 秒后就能连上。</div>`;
      if (!canBuild) {
        body += `<div class="text-sm mt-2" style="color:var(--warn)">
          本机没找到能用的 JDK ${need}（${escapeHtml(build.hint || '需要 javac')}），agent 没法重新编译。</div>`;
      }
      body += buildRow;
    } else if (!full) {
      body = `<div class="text-sm text-muted">当前 jar 是旧版（api ${escapeHtml(a.api || '1')}），
        能转视角和走路，但<strong>挖方块、放方块、看背包、扫描周围方块</strong>还用不了。
        ${canBuild ? '重新编译一次就能补上。' : `需要本机装 JDK ${need} 才能重新编译。`}</div>${buildRow}`;
    } else {
      body = `<div class="text-sm text-muted">agent 在游戏进程里，直接调游戏 API：
        转视角、按住走、挖、放、扫描方块。<strong>全程不产生鼠标键盘事件，你的光标不会被动。</strong>
        一轮只要几十毫秒，比截图快一个数量级。</div>`;
      if (!canBuild) body += `<div class="text-sm text-muted mt-2">（本机没装 JDK，暂时不能重新编译——不影响使用。）</div>`;
    }

    if (canBuild && !hasClient) {
      body += `<div class="text-sm mt-2" style="color:var(--warn)">缺 26.3 客户端 jar，先在「游戏」页下载版本再编译。</div>`;
    }

    const jar = a.jar || {};
    const jdkText = canBuild
      ? escapeHtml(String(build.jdk.version || 'JDK'))
      : '未装';
    return `<div class="card">
      <div class="card-head"><h3>控制 Mod</h3>${badge}</div>
      <div class="card-body">
        ${body}
        <div class="text-sm text-muted mt-3" style="font-family:var(--mono);font-size:12px">
          jar ${jar.exists ? `${(jar.size / 1024).toFixed(1)} KB` : '缺失'}
          · JDK ${jdkText}
          ${online ? ` · api ${escapeHtml(a.api || '1')} · 在世界里：${a.inWorld ? '是' : '否'}` : ''}
          ${full ? '' : ` · 已有能力：${(a.caps || []).join(', ') || '无'}`}
        </div>
        <div id="mc-agent-out" class="text-sm mt-2" style="display:none"></div>
      </div>
    </div>`;
  }

  /** 存档管理：新建 / 选择 / 进入由 AI 和 Web 共用 */
  function worldsCardHtml() {
    const d = App.state.mc.worlds;
    if (!d) {
      return `<div class="card">
        <div class="card-head"><h3>存档管理</h3></div>
        <div class="card-body">${emptyState('读取中…', '需要先启动 Minecraft 并连接控制 Mod')}</div>
      </div>`;
    }
    const levels = Array.isArray(d.levels) ? d.levels : [];
    const rows = levels.length
      ? levels.map((w) => {
        const mode = w.gamemode ? ` · ${escapeHtml(w.gamemode)}` : '';
        const cmd = w.commands ? '<span class="tag warn">允许作弊</span>' : '<span class="tag ok">无作弊</span>';
        const time = w.lastPlayed ? new Date(w.lastPlayed).toLocaleString() : '—';
        return `<div class="flex items-center gap-2" style="padding:9px 0;border-bottom:1px solid var(--border)">
          <div style="flex:1;min-width:0">
            <div class="flex items-center gap-2" style="flex-wrap:wrap"><strong>${escapeHtml(w.name || w.id)}</strong>${cmd}</div>
            <div class="text-sm text-muted">${escapeHtml(w.id)}${mode} · ${escapeHtml(time)}</div>
          </div>
          <button class="btn btn-ghost btn-sm" data-world-play="${escapeHtml(w.id)}">${icon('play', 13)} 进入</button>
        </div>`;
      }).join('')
      : emptyState('还没有存档', '点「新建无作弊生存」开始');
    return `<div class="card">
      <div class="card-head">
        <h3>存档管理</h3>
        <div class="flex gap-2">
          <button class="btn btn-ghost btn-sm" data-act="world-refresh">${icon('refresh', 13)} 刷新</button>
          <button class="btn btn-primary btn-sm" data-act="world-new">${icon('plus', 13)} 新建无作弊生存</button>
        </div>
      </div>
      <div class="card-body">
        ${d.warning ? `<div class="notice warn mb-2">${icon('alert')}<div>存档详情读取失败，仅显示目录名：${escapeHtml(d.warning)}</div></div>` : ''}
        ${rows}
      </div>
    </div>`;
  }

  /** 世界状态：直连模式下的「眼睛」 */
  function worldCardHtml(st, live) {
    // AI 跑任务时 st.world 每轮刷新；空闲时用 mod 的实时 /state，离线才退回旧快照
    const w = st.running && st.world ? st.world : (live || st.world);
    if (!w) {
      return `<div class="card">
        <div class="card-head"><h3>世界状态</h3></div>
        <div class="card-body">${emptyState('还没有世界数据', '开始一次 AI 任务后显示位置、生命与准星')}</div>
      </div>`;
    }
    const t = w.target || {};
    const targetText = t.type === 'block'
      ? `方块 ${t.id} @ (${(t.pos || []).join(', ')}) 距离 ${t.dist}`
      : t.type === 'entity' ? `生物 ${t.id} 距离 ${t.dist}` : '空气';
    return `<div class="card">
      <div class="card-head"><h3>世界状态</h3><span class="sub">${w.dimension || ''}</span></div>
      <div class="card-body">
        <div class="grid grid-2" style="gap:12px">
          <div>
            <div class="text-sm text-muted">位置</div>
            <div style="font-family:var(--mono);font-size:13px">${w.x} / ${w.y} / ${w.z}</div>
          </div>
          <div>
            <div class="text-sm text-muted">朝向</div>
            <div style="font-family:var(--mono);font-size:13px">yaw ${w.yaw} · pitch ${w.pitch}</div>
          </div>
          <div>
            <div class="text-sm text-muted">生命 / 饥饿</div>
            <div style="font-family:var(--mono);font-size:13px">${w.health} / ${w.food}</div>
          </div>
          <div>
            <div class="text-sm text-muted">准星</div>
            <div class="text-sm">${escapeHtml(targetText)}</div>
          </div>
        </div>
      </div>
    </div>`;
  }

  /** 本地模型：游戏实例的一部分，独立成卡，不再藏在「运行配置」里 */
  function llmCardHtml() {
    const l = App.state.game.llm;
    if (!l) {
      return `<div class="card">
        <div class="card-head"><h3>本地模型</h3></div>
        <div class="card-body">${emptyState('读取中…', '正在读取 llama.cpp 状态')}</div>
      </div>`;
    }
    const tag = !l.installed
      ? '<span class="tag">未安装</span>'
      : l.running
        ? (l.ready ? '<span class="tag ok">运行中</span>' : '<span class="tag warn">启动中</span>')
        : '<span class="tag">未启动</span>';
    return `<div class="card">
      <div class="card-head"><h3>本地模型</h3>${tag}</div>
      <div class="card-body">
        <div class="kv">
          <div class="kv-row"><span class="k">模型</span><span class="v">${escapeHtml(l.model || '—')}</span></div>
          <div class="kv-row"><span class="k">地址</span><span class="v mono">${l.running ? `127.0.0.1:${l.port}` : '—'}</span></div>
          <div class="kv-row"><span class="k">进程</span><span class="v">${l.pid ? `PID ${l.pid}` : '—'}</span></div>
        </div>
        <div class="switch-row" style="border-top:1px solid var(--border);margin-top:10px">
          ${switchEl('game-llm', Boolean(l.running))}
          <div>
            <div class="label">启用本地模型</div>
            <div class="hint">${!l.installed
              ? '没装本地模型（runtime/llm 下缺 llama-server 或模型）'
              : l.running
                ? (l.ready ? '一次决策约 0.3 秒，不联网、不花钱' : '启动中…模型 4.4GB，首次约 10 秒')
                : '打开就在本机跑 Qwen2.5-7B，不联网、不花钱'}</div>
          </div>
        </div>
      </div>
    </div>`;
  }

  function mcCardHtml() {
    const m = App.state.mc?.status;
    if (!m) return '';
    const busy = m.phase === 'downloading';
    const running = m.phase === 'running';

    let badge;
    let body;

    if (busy) {
      badge = `<span class="tag warn" id="mc-badge">下载中 ${m.percent}%</span>`;
      body = `<div style="height:6px;background:var(--surface-2);border-radius:3px;overflow:hidden">
          <div id="mc-bar" style="width:${m.percent}%;height:100%;background:var(--primary);transition:width .3s"></div>
        </div>
        <div class="text-sm text-muted mt-2" id="mc-progress">${m.done}/${m.total} 个文件 · ${m.mb}/${m.totalMb} MB</div>`;
    } else if (running) {
      badge = '<span class="tag ok">游戏中</span>';
      body = '<div class="text-sm text-muted">游戏窗口已经打开，切过去就能玩。用「目标窗口」选 Minecraft 可以让 AI 接管。</div>';
    } else if (m.installed) {
      badge = '<span class="tag ok">已就绪</span>';
      body = `<div class="flex gap-2">
          <button class="btn btn-primary" data-act="mc-launch">${icon('play', 14)} 启动游戏</button>
          <button class="btn btn-ghost" data-act="mc-assets">${icon('refresh', 13)} 下载音效资源</button>
        </div>
        <div class="text-sm text-muted mt-2">离线模式，用户名 AIBridge。音效资源 460MB，不装也能玩，只是没声音。</div>`;
    } else {
      badge = '<span class="tag">未下载</span>';
      body = `<button class="btn btn-primary" data-act="mc-install">${icon('play', 14)} 下载 ${m.version}（约 123 MB）</button>
        <div class="text-sm text-muted mt-2">从 Mojang 官方源下载，只含客户端与依赖库，几分钟就好。</div>`;
    }

    return `<div class="card">
      <div class="card-head"><h3>客户端</h3><span class="sub">Minecraft ${escapeHtml(m.version)}</span>${badge}</div>
      <div class="card-body">
        ${body}
        ${m.installed ? field('画面内嵌', switchEl('mc-embed', Boolean(App.state.mc?.frames?.running)),
          '把游戏窗口移到屏幕外，画面只在界面里显示，键鼠操作全部归 AI') : ''}
        ${m.error ? `<div class="notice warn mt-3">${icon('alert')}<div>${escapeHtml(m.error)}</div></div>` : ''}
      </div>
    </div>`;
  }

  const gameView = {
    title: '游戏',
    desc: 'Minecraft 实例：客户端、控制 Mod、本地模型与实时画面',
    render() {
      const g = App.state.game;
      const st = g.status || {};
      const running = Boolean(st.running);
      const agentMode = st.mode === 'agent';

      const winOptions = [{ value: '', label: '整个屏幕（全屏截图）' }]
        .concat((g.windows || []).map((t) => ({ value: t, label: t })));

      const tokens = (st.usage?.prompt || 0) + (st.usage?.completion || 0);

      const modeBadge = running
        ? (agentMode
          ? '<span class="tag info">进程内直连</span>'
          : '<span class="tag warn">截图模式</span>')
        : '<span class="tag">AI 空闲</span>';

      const m = App.state.mc?.status;
      const a = App.state.mc?.agent;
      const w = running ? (st.world || a?.state) : (a?.state || st.world);
      const clientRunning = Boolean(m && m.phase === 'running') || Boolean(a && a.online);
      const clientTag = !m
        ? '<span class="tag">状态未知</span>'
        : !m.installed
          ? '<span class="tag warn">未安装</span>'
          : clientRunning
            ? '<span class="tag ok">客户端运行中</span>'
            : '<span class="tag">已就绪</span>';
      const modTag = a && a.online
        ? `<span class="tag ok">Mod 已连接${a.api ? ` · api ${escapeHtml(String(a.api))}` : ''}</span>`
        : '<span class="tag">Mod 未连接</span>';
      const summary = [];
      if (a?.online) summary.push(a.inWorld ? '已进入世界' : '停在标题界面');
      if (running) summary.push(`目标「${st.goal || '未填写'}」 · ${st.round || 0}/${st.maxRounds || 0} 轮`);
      if (g.llm?.running) summary.push(g.llm.ready ? `本地模型就绪（:${g.llm.port}）` : '本地模型启动中');
      if (!summary.length) summary.push('选择目标窗口与任务后点开始');
      const worldText = w
        ? `${String(w.dimension || 'minecraft:overworld').replace('minecraft:', '')} · ${Math.round(w.x)}/${Math.round(w.y)}/${Math.round(w.z)}`
        : '未进入世界';
      const mini = (label, value) => `<div>
        <div class="text-sm text-muted">${label}</div>
        <div style="font-weight:600;font-size:13.5px;margin-top:2px">${escapeHtml(value)}</div>
      </div>`;

      return `
      <div class="card">
        <div class="card-body" style="display:flex;align-items:center;gap:14px;flex-wrap:wrap">
          <div class="avatar" style="width:44px;height:44px;border-radius:12px;background:var(--primary-soft);color:var(--primary);border:1px solid #dde4fd">
            ${icon('play', 21)}
          </div>
          <div style="flex:1;min-width:220px">
            <div class="flex items-center gap-2" style="flex-wrap:wrap">
              <h2 style="margin:0;font-size:19px;letter-spacing:-.3px">Minecraft ${escapeHtml(m?.version || '26.3')}</h2>
              ${clientTag}${modTag}${modeBadge}
            </div>
            <div class="text-sm text-muted" style="margin-top:3px">${escapeHtml(summary.join(' · '))}</div>
          </div>
          <div class="flex gap-2" style="flex-wrap:wrap">
            ${!m || !m.installed
              ? `<button class="btn btn-primary" data-act="mc-install">${icon('download', 14)} 下载客户端</button>`
              : !clientRunning
                ? `<button class="btn btn-primary" data-act="mc-launch">${icon('play', 14)} 启动游戏</button>`
                : ''}
            ${running ? `<button class="btn btn-danger" data-act="game-stop">停止 AI</button>` : ''}
            <button class="btn btn-ghost" data-act="game-refresh">${icon('refresh', 13)} 刷新</button>
          </div>
        </div>
        <div class="card-body" style="border-top:1px solid var(--border);padding-top:14px;padding-bottom:14px">
          <div class="grid grid-4" style="gap:14px">
            ${mini('客户端', m ? (m.pid ? `PID ${m.pid}` : m.phase === 'downloading' ? `下载 ${m.percent}%` : (m.installed ? '已安装' : '未安装')) : '未知')}
            ${mini('控制 Mod', a?.online ? `api ${a.api} · 8788` : '未连接')}
            ${mini('本地模型', g.llm ? (g.llm.running ? (g.llm.ready ? `就绪 · :${g.llm.port}` : '启动中') : (g.llm.installed ? '未启动' : '未安装')) : '未知')}
            ${mini('世界', worldText)}
          </div>
        </div>
      </div>

      <div class="mt-4">${worldsCardHtml()}</div>

      <div class="grid grid-2 mt-4" style="align-items:start">
        <div class="card">
          <div class="card-head">
            <h3>运行配置</h3>
            ${modeBadge}
          </div>
          <div class="card-body">
            ${field('正版账号', (() => {
              const lg = App.state.mc.login || {};
              if (lg.loggedIn) {
                return `<div class="flex items-center gap-2">
                  <span class="tag">${escapeHtml(lg.name || '已登录')}</span>
                  <button class="btn btn-ghost btn-sm" data-act="mc-logout">退出登录</button>
                </div>`;
              }
              if (lg.pending) {
                return `<div>
                  <div class="text-sm">浏览器打开 <b>${escapeHtml(lg.uri || 'https://microsoft.com/link')}</b>，输入代码：</div>
                  <div style="font-size:20px;font-weight:700;letter-spacing:2px;margin:6px 0">${escapeHtml(lg.userCode || '')}</div>
                  <div class="text-sm text-muted">授权完成后会自动登录…</div>
                </div>`;
              }
              return `<button class="btn btn-primary btn-sm" data-act="mc-login">登录微软账号</button>`;
            })(), '登录后可以用正版名字进正版服务器；不登录就是离线模式（只能玩单人）')}
            ${field('目标窗口', select('game-title', winOptions, g.title),
              '选「整个屏幕」截全屏；选具体窗口只截它的客户区。选中 Minecraft 会自动切进程内直连')}
            ${field('让它做什么', textarea('game-goal', g.goal, { rows: 3, placeholder: '例如：砍三块木头，然后做个工作台' }),
              '描述越具体，动作越靠谱')}
            ${field('决策模型', select('game-model', (() => {
              const opts = [{ value: '', label: '跟随默认模型' }];
              for (const p of App.state.config.providers || []) {
                for (const m of (p.models || [])) opts.push({ value: `${p.id}|${m}`, label: `${p.name} · ${m}` });
              }
              return opts;
            })(), (App.state.config.game?.providerId || '') + '|' + (App.state.config.game?.model || '')),
              '可以让本地模型专门跑游戏（快、免费、离线），聊天继续用云端')}
            <div class="grid grid-2" style="gap:10px">
              ${field('最多几轮', input('game-rounds', g.maxRounds, { type: 'number' }),
                agentMode || !running ? '直连模式一轮约 2~4 秒' : '每轮约 7 秒')}
              ${field('轮间隔(ms)', input('game-interval', 1500, { type: 'number' }), '太快容易点在动画中间')}
            </div>
            ${(App.state.config.game?.providerId === 'local' && !(g.llm && g.llm.ready))
              ? `<div class="notice warn mb-2">${icon('alert')}<div>决策模型选的是本地，但本地模型没启动——先打开上面的开关，否则游戏会连不上</div></div>`
              : ''}
            ${field('允许动视角', switchEl('game-view', App.state.config.game?.moveView !== false),
              App.state.config.game?.moveView === false
                ? '已锁定：AI 挖/放时会临时对准，动作完成立刻把视角还原到你的角度'
                : '关掉后 AI 不再改你的朝向（MC 也就不会一直抢鼠标）')}
            ${field('允许操控角色', switchEl('game-allow', App.state.config.game?.allowControl !== false),
              App.state.config.game?.allowControl === false
                ? '已关闭：AI 只能看不能动（读状态、看方块、看容器），任何会动角色的动作都会被拒绝'
                : '关掉后 AI 只能观察，不能走路/挖掘/放置/合成——相当于一个只读开关')}
            ${field('干跑模式', switchEl('game-dry', g.dryRun),
              '开启时只决策不操作，先确认它想得对再关掉')}
            <div class="flex gap-2 mt-3">
              ${running
                ? `<button class="btn btn-danger" data-act="game-stop">停止</button>`
                : `<button class="btn btn-primary" data-act="game-start">${icon('play', 14)} 开始</button>`}
              <button class="btn btn-ghost" data-act="game-refresh">${icon('refresh', 13)} 刷新窗口</button>
            </div>
            ${running && st.modeReason ? `<div class="text-sm text-muted mt-2">当前：${escapeHtml(st.modeReason)}</div>` : ''}
            ${st.lastError ? `<div class="notice warn mt-3">${icon('alert')}<div>${escapeHtml(st.lastError)}</div></div>` : ''}
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <h3>实时画面</h3>
            <span class="sub" id="game-counter">${st.round || 0} / ${st.maxRounds || 0} 轮 · ${tokens} tokens</span>
          </div>
          <div class="card-body">
            <div id="game-shot-wrap">${gameShotHtml(st)}</div>
            <div class="mt-3" id="game-history">${gameHistoryHtml(st)}</div>
          </div>
        </div>
      </div>
      <div class="grid grid-2 mt-4" style="align-items:start">
        ${worldCardHtml(st, a?.state)}
        ${llmCardHtml()}
      </div>

      <div class="grid grid-2 mt-4" style="align-items:start">
        ${mcCardHtml()}
        ${agentCardHtml()}
      </div>`;
    },
    mount(root) {
      const g = App.state.game;

      const sync = () => {
        const t = root.querySelector('#game-title');
        const goal = root.querySelector('#game-goal');
        const rounds = root.querySelector('#game-rounds');
        if (t) g.title = t.value;
        if (goal) g.goal = goal.value;
        if (rounds) g.maxRounds = Number(rounds.value) || 10;
      };

      root.querySelector('#game-title')?.addEventListener('change', sync);
      root.querySelector('#game-goal')?.addEventListener('input', sync);
      root.querySelector('#game-rounds')?.addEventListener('input', sync);

      root.querySelector('[data-act="world-refresh"]')?.addEventListener('click', async () => {
        const r = await api('/api/mc/worlds').catch(() => null);
        if (r) App.state.mc.worlds = r;
        App.render();
      });

      root.querySelector('[data-act="world-new"]')?.addEventListener('click', async (e) => {
        const name = prompt('新存档名称（生存、关闭作弊）', `AI生存-${new Date().toISOString().slice(5, 16).replace(/[-:T]/g, '')}`);
        if (!name) return;
        const btn = e.currentTarget;
        btn.disabled = true;
        try {
          let r = null;
          for (let i = 0; i < 6; i++) {
            r = await api('/api/mc/world/create', { method: 'POST', body: { name, gamemode: 'survival' } });
            if (r.ok) break;
            if (!r.retry) throw new Error(r.error || '创建世界失败');
            await new Promise((resolve) => setTimeout(resolve, 1200));
          }
          if (!r || !r.ok) throw new Error((r && r.error) || '创建世界失败');
          toast(`已创建「${name}」，正在加载…`, 'ok');
          const wl = await api('/api/mc/worlds').catch(() => null);
          if (wl) App.state.mc.worlds = wl;
          App.render();
        } catch (err) {
          toast(err.message, 'err');
        } finally {
          btn.disabled = false;
        }
      });

      root.querySelectorAll('[data-world-play]').forEach((el) => {
        el.addEventListener('click', async () => {
          const id = el.dataset.worldPlay;
          el.disabled = true;
          try {
            const r = await api('/api/mc/world/play', { method: 'POST', body: { id } });
            if (!r.ok) throw new Error(r.error || '打开存档失败');
            toast(`正在进入「${id}」…`, 'ok');
          } catch (err) {
            toast(err.message, 'err');
          } finally {
            el.disabled = false;
          }
        });
      });

      root.querySelector('#game-llm')?.addEventListener('click', async (e) => {
        const el = e.currentTarget;
        const on = !el.classList.contains('on');
        el.classList.toggle('on', on);
        el.setAttribute('aria-checked', String(on));
        toast(on ? '正在启动本地模型…' : '正在停止…', 'ok');
        try {
          const r = await api(on ? '/api/llm/start' : '/api/llm/stop', { method: 'POST' });
          if (on && !r.ok) throw new Error(r.error || '启动失败');
          App.state.game.llm = r;
          toast(on ? `本地模型就绪（${r.port}）` : '本地模型已停止', 'ok');
        } catch (err) {
          el.classList.toggle('on', !on);
          el.setAttribute('aria-checked', String(!on));
          toast(err.message, 'err');
          App.state.game.llm = await api('/api/llm/status').catch(() => App.state.game.llm);
        }
        App.render();
      });

      root.querySelector('[data-act="mc-login"]')?.addEventListener('click', async (e) => {
        e.currentTarget.disabled = true;
        try {
          const r = await api('/api/mc/login/start', { method: 'POST' });
          if (!r.ok) throw new Error(r.error || '申请设备码失败');
          App.state.mc.login = Object.assign({}, App.state.mc.login, { pending: true, userCode: r.userCode, uri: r.uri });
          App.render();
          // 轮询直到授权完成或超时
          const t0 = Date.now();
          const timer = setInterval(async () => {
            if (Date.now() - t0 > 15 * 60 * 1000) { clearInterval(timer); return; }
            const p2 = await api('/api/mc/login/poll', { method: 'POST' }).catch(() => null);
            if (!p2) return;
            if (p2.pending) return;
            clearInterval(timer);
            if (p2.ok) {
              toast(`登录成功：${p2.name}`, 'ok');
            } else {
              toast(p2.error || '登录失败', 'err');
            }
            App.state.mc.login = await api('/api/mc/login/status').catch(() => null);
            App.render();
          }, 3000);
        } catch (err) {
          toast(err.message, 'err');
          e.currentTarget.disabled = false;
        }
      });

      root.querySelector('[data-act="mc-logout"]')?.addEventListener('click', async () => {
        await api('/api/mc/login/logout', { method: 'POST' }).catch(() => null);
        App.state.mc.login = await api('/api/mc/login/status').catch(() => null);
        toast('已退出正版账号', 'ok');
        App.render();
      });

      root.querySelector('#game-view')?.addEventListener('click', async (e) => {
        const el = e.currentTarget;
        const on = !(App.state.config.game?.moveView !== false);
        el.classList.toggle('on', on);
        el.setAttribute('aria-checked', String(on));
        App.state.config.game = Object.assign({}, App.state.config.game, { moveView: on });
        await App.saveConfig();
        toast(on ? 'AI 可以转视角了' : '视角已锁定：AI 动完会还原', on ? 'ok' : 'warn');
        App.render();
      });

      root.querySelector('#game-allow')?.addEventListener('click', async (e) => {
        const el = e.currentTarget;
        const on = !(App.state.config.game?.allowControl !== false);
        el.classList.toggle('on', on);
        el.setAttribute('aria-checked', String(on));
        App.state.config.game = Object.assign({}, App.state.config.game, { allowControl: on });
        await App.saveConfig();
        toast(on ? 'AI 可以操控角色了' : '已关闭操控：AI 只能看，不能动角色', on ? 'ok' : 'warn');
        App.render();
      });

      root.querySelector('#game-dry')?.addEventListener('click', (e) => {
        g.dryRun = !g.dryRun;
        e.currentTarget.classList.toggle('on', g.dryRun);
        e.currentTarget.setAttribute('aria-checked', String(g.dryRun));
      });

      root.querySelectorAll('[data-act="game-refresh"]').forEach((el) => el.addEventListener('click', async () => {
        await App.loadGame();
        App.render();
        toast('窗口列表已刷新', 'ok');
      }));

      root.querySelector('[data-act="mc-agent-build"]')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        const out = root.querySelector('#mc-agent-out');
        btn.disabled = true;
        const old = btn.innerHTML;
        btn.innerHTML = '<span class="loading-inline"></span> 编译中…';
        if (out) { out.style.display = 'block'; out.textContent = '正在调用 javac，最多等 4 分钟…'; }
        try {
          const r = await api('/api/mc/agent/build', { method: 'POST', body: {} });
          if (out) {
            out.style.display = 'block';
            out.innerHTML = `<pre style="white-space:pre-wrap;font-size:12px;margin:0">${escapeHtml(r.output || '')}</pre>`;
          }
          if (r.ok) {
            toast('编译完成，重启游戏后生效', 'ok');
            await App.loadGame();
            App.render();
          } else {
            toast(r.hint || '编译失败，看下面的输出', 'err');
          }
        } catch (err) {
          toast(err.message, 'err');
          if (out) out.textContent = err.message;
        } finally {
          btn.disabled = false;
          btn.innerHTML = old;
        }
      });

      root.querySelector('#game-model')?.addEventListener('change', async (e) => {
        const [pid, model] = String(e.target.value || '').split('|');
        App.state.config.game = Object.assign({}, App.state.config.game, {
          providerId: pid || '',
          model: model || '',
        });
        await App.saveConfig();
        toast(pid ? '游戏已改用这个模型' : '游戏模型：跟随默认', 'ok');
      });

      root.querySelector('[data-act="game-start"]')?.addEventListener('click', async (e) => {
        sync();
        const interval = Number(root.querySelector('#game-interval')?.value) || 1500;

        if (!g.dryRun) {
          const ok = await Core.confirmDialog({
            title: 'AI 会真的操作',
            message: '干跑已关闭：AI 会真的移动鼠标、敲键盘。想先看它怎么想，把「干跑模式」打开。',
            confirmText: '开始操作',
          });
          if (!ok) return;
        }

        const btn = e.currentTarget;
        btn.disabled = true;
        btn.innerHTML = '<span class="loading-inline"></span> 启动中…';
        try {
          const r = await api('/api/game/start', {
            method: 'POST',
            body: {
              title: g.title,
              goal: g.goal,
              maxRounds: g.maxRounds,
              intervalMs: interval,
              dryRun: g.dryRun,
              // 固定走进程内直连：不截屏、不动鼠标。连不上会直接报错
              mode: 'agent',
            },
          });
          if (!r.ok) throw new Error(r.error || '启动失败');
          toast(g.dryRun ? '已开始（干跑，不会真的操作）' : '已开始，AI 会真的操作键鼠', 'ok');
          startPolling();
          App.render();
        } catch (err) {
          toast(err.message, 'err');
          btn.disabled = false;
          btn.innerHTML = `${icon('play', 14)} 开始`;
        }
      });

      root.querySelectorAll('[data-act="game-stop"]').forEach((el) => el.addEventListener('click', async () => {
        try {
          await api('/api/game/stop', { method: 'POST' });
          toast('已停止', 'ok');
        } catch (err) {
          toast(err.message, 'err');
        }
        stopPolling();
        App.render();
      }));

      function startPolling() {
        stopPolling();
        g.timer = setInterval(async () => {
          if (App.state.route !== 'game') { stopPolling(); return; }
          const s = await api('/api/game/status').catch(() => null);
          if (!s) return;
          const wasRunning = Boolean(g.status?.running);
          g.status = s;

          const wrap = document.querySelector('#game-shot-wrap');
          if (wrap) wrap.innerHTML = gameShotHtml(s);
          const hist = document.querySelector('#game-history');
          if (hist) hist.innerHTML = gameHistoryHtml(s);
          const counter = document.querySelector('#game-counter');
          if (counter) {
            const tk = (s.usage?.prompt || 0) + (s.usage?.completion || 0);
            counter.textContent = `${s.round} / ${s.maxRounds} 轮 · ${tk} tokens`;
          }
          // 运行状态变了才整页重绘（否则会打断输入框）
          if (wasRunning !== Boolean(s.running)) {
            stopPolling();
            App.render();
          }
        }, 1600);
      }

      function stopPolling() {
        if (g.timer) { clearInterval(g.timer); g.timer = null; }
      }

      if (g.status?.running) startPolling();

      // ---------------- Minecraft ----------------
      const mc = App.state.mc;

      // 头部和「客户端」卡里都有启动/下载按钮，绑定全部同名动作
      root.querySelectorAll('[data-act="mc-install"]').forEach((el) => el.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.innerHTML = '<span class="loading-inline"></span> 准备下载…';
        try {
          await api('/api/mc/install', { method: 'POST', body: {} });
          toast('开始下载，几分钟就好', 'ok');
          setTimeout(pollMc, 800);
        } catch (err) {
          toast(err.message, 'err');
          btn.disabled = false;
          btn.innerHTML = '重试下载';
        }
      }));

      root.querySelectorAll('[data-act="mc-assets"]').forEach((el) => el.addEventListener('click', async (e) => {
        e.currentTarget.disabled = true;
        await api('/api/mc/assets', { method: 'POST', body: {} }).catch(() => {});
        toast('开始下载音效资源（460MB，会比较久）', 'ok');
        setTimeout(pollMc, 800);
      }));

      root.querySelectorAll('[data-act="mc-launch"]').forEach((el) => el.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.innerHTML = '<span class="loading-inline"></span> 启动中…';
        try {
          const r = await api('/api/mc/launch', { method: 'POST', body: { username: 'AIBridge' } });
          if (!r.ok) throw new Error(r.error || '启动失败');
          toast('游戏启动中，十几秒后窗口出现', 'ok');
          setTimeout(pollMc, 4000);
        } catch (err) {
          toast(err.message, 'err');
          btn.disabled = false;
          btn.innerHTML = '启动游戏';
        }
      }));

      function pollMc() {
        if (mc.timer) clearInterval(mc.timer);
        mc.timer = setInterval(async () => {
          if (App.state.route !== 'game') { clearInterval(mc.timer); mc.timer = null; return; }
          const m = await api('/api/mc/status').catch(() => null);
          if (!m) return;
          const before = mc.status?.phase;
          mc.status = m;

          // 下载中只更新进度条，避免整页重绘打断输入
          if (m.phase === 'downloading') {
            const bar = document.querySelector('#mc-bar');
            const txt = document.querySelector('#mc-progress');
            const badge = document.querySelector('#mc-badge');
            if (bar) bar.style.width = `${m.percent}%`;
            if (txt) txt.textContent = `${m.done}/${m.total} 个文件 · ${m.mb}/${m.totalMb} MB`;
            if (badge) badge.textContent = `下载中 ${m.percent}%`;
            return;
          }

          if (before !== m.phase) {
            clearInterval(mc.timer);
            mc.timer = null;
            App.render();
          }
        }, 1500);
      }

      if (mc.status?.phase === 'downloading') pollMc();

      // ---- 画面内嵌：窗口移出屏幕，画面流进界面 ----
      root.querySelector('#mc-embed')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        const on = !App.state.mc.frames?.running;
        btn.classList.toggle('on', on);
        try {
          const r = await api('/api/mc/frames', {
            method: 'POST',
            body: { on, title: 'Minecraft', width: 960 },
          }).catch(() => null);
          if (!r?.ok) throw new Error('启动画面采集失败');
          await api('/api/mc/embed', {
            method: 'POST',
            body: { action: on ? 'hide' : 'show', title: 'Minecraft' },
          }).catch(() => null);
          toast(on ? '画面已内嵌，游戏窗口移到屏幕外' : '窗口已恢复', 'ok');
          await App.loadGame();
          App.render();
        } catch (err) {
          btn.classList.toggle('on', !on);
          toast(err.message, 'err');
        }
      });

      if (App.state.mc.frames?.running) {
        const timer = setInterval(() => {
          const img = document.querySelector('#mc-live');
          if (!img || App.state.route !== 'game') { clearInterval(timer); return; }
          img.src = `/api/mc/frame?t=${Date.now()}`;
        }, 700);
      }
    },
  };

  window.Views = {
    overview, chat, channels, models, agents, voice, memory: memoryView,
    login: loginView, friends: friendsView, game: gameView, sessions, logs, settings,
    // 供 app.js 复用
    renderMessages, appendToLast, voiceStatusText, modelLabel, stopPolling,
  };
})();
