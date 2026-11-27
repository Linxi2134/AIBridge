/* 视频生成页面：接口配置 / 提交任务 / 任务列表 / 发送到渠道 */
(function () {
  'use strict';
  const { icon, escapeHtml, api, toast, confirmDialog, fmtTime } = Core;
  window.Views = window.Views || {};

  const POLL_INTERVAL = 5000;
  // 这三个状态算「任务还在跑」，见到就起轮询
  const PENDING = ['queued', 'running', 'downloading'];

  const STATUS = {
    queued: { label: '排队', cls: '' },
    running: { label: '生成中', cls: 'info' },
    downloading: { label: '下载中', cls: 'info' },
    succeeded: { label: '成功', cls: 'ok' },
    failed: { label: '失败', cls: 'danger' },
    sent: { label: '已发送', cls: 'ok' },
  };

  const PROVIDERS = [
    { id: 'openai', label: 'OpenAI 兼容（/v1/videos）', baseUrl: 'https://api.openai.com/v1', model: 'sora-2' },
    { id: 'minimax', label: 'MiniMax 海螺', baseUrl: 'https://api.minimax.chat/v1', model: 'MiniMax-Hailuo-02' },
    { id: 'ark', label: '火山方舟 Seedance', baseUrl: 'https://ark.cn-beijing.volces.com', model: 'doubao-seedance-1-0-pro' },
    { id: 'zhipu', label: '智谱 CogVideoX', baseUrl: 'https://open.bigmodel.cn', model: 'cogvideox-2' },
    { id: 'custom', label: '自定义（自己填路径与字段）', baseUrl: '', model: '' },
  ];

  // 只有这三个渠道能收视频；公众号 / 企微没有「主动发视频」接口，服务端会退化成文字+链接
  const CHANNELS = [
    { id: 'onebot', label: 'OneBot 11（可直接发视频）', real: true },
    { id: 'wechat', label: '微信公众号（只能发文字+链接）', real: false },
    { id: 'wecom', label: '企业微信（只能发文字+链接）', real: false },
  ];

  // 页面状态放模块级：App.render 每次都会重建整块 DOM，挂在元素上的状态会一起丢掉
  const state = {
    loading: true,
    error: '',
    jobs: [],
    status: null,
    draft: null,        // 配置草稿：未保存的改动留在这里，重渲染不丢
    saving: false,
    prompt: '',
    image: '',
    imageName: '',
    size: '',
    seconds: '',
    generating: false,
    busyId: '',
    sendOpenId: '',
    sendChannel: '',
    sendTargetType: 'private',
    sendTargetId: '',
    timer: null,        // 轮询定时器，幂等：同一时刻最多一个
    polling: false,
    root: null,
    sig: '',            // 任务列表的渲染签名，轮询时内容没变就不动 DOM
  };

  // views.js 里的 emptyState 没导出，这里按同样的结构补一份，样式才一致
  function empty(title, desc, iconName) {
    return `<div class="empty">${icon(iconName || 'info', 40)}<h4>${escapeHtml(title)}</h4><p>${escapeHtml(desc || '')}</p></div>`;
  }

  function fmtBytes(n) {
    const v = Number(n) || 0;
    if (v <= 0) return '';
    if (v < 1024) return `${v} B`;
    if (v < 1048576) return `${(v / 1024).toFixed(1)} KB`;
    return `${(v / 1048576).toFixed(1)} MB`;
  }

  function providerLabel(id) {
    const p = PROVIDERS.find((x) => x.id === id);
    return p ? p.label : (id || '—');
  }

  // ---------------- 配置草稿 ----------------
  function videoCfg() {
    return (App.state.config && App.state.config.videoGen) || {};
  }

  function draft() {
    if (state.draft) return state.draft;
    const vg = videoCfg();
    const c = vg.custom || {};
    state.draft = {
      enabled: Boolean(vg.enabled),
      provider: String(vg.provider || 'openai'),
      baseUrl: String(vg.baseUrl || ''),
      apiKey: String(vg.apiKey || ''),
      model: String(vg.model || ''),
      size: String(vg.size || ''),
      seconds: vg.seconds === undefined || vg.seconds === null ? '' : String(vg.seconds),
      pollMs: vg.pollMs === undefined || vg.pollMs === null ? '3000' : String(vg.pollMs),
      custom: {
        submitPath: String(c.submitPath || ''),
        submitBody: String(c.submitBody || ''),
        statusPath: String(c.statusPath || ''),
        statusField: String(c.statusField || 'status'),
        urlField: String(c.urlField || 'video_url'),
        doneValues: String(c.doneValues || 'succeeded,completed,success'),
        failValues: String(c.failValues || 'failed,error'),
      },
    };
    return state.draft;
  }

  function setDraft(path, value) {
    const d = draft();
    const parts = String(path).split('.');
    let obj = d;
    for (let i = 0; i < parts.length - 1; i += 1) {
      if (!obj[parts[i]] || typeof obj[parts[i]] !== 'object') obj[parts[i]] = {};
      obj = obj[parts[i]];
    }
    obj[parts[parts.length - 1]] = value;
  }

  // 草稿和已保存配置是否不一致（决定是否显示「未保存」以及生成前是否提醒）
  function collect() {
    if (!state.draft || !state.root) return state.draft;
    state.root.querySelectorAll('[data-vd]').forEach((el) => {
      setDraft(el.dataset.vd, el.value);
    });
    return state.draft;
  }

  function dirty() {
    const d = state.draft;
    if (!d) return false;
    const vg = videoCfg();
    const c = vg.custom || {};
    const dc = d.custom || {};
    const s = (v) => String(v === undefined || v === null ? '' : v).trim();
    return s(d.enabled ? '1' : '0') !== s(vg.enabled ? '1' : '0')
      || s(d.provider) !== s(vg.provider || 'openai')
      || s(d.baseUrl) !== s(vg.baseUrl)
      || s(d.apiKey) !== s(vg.apiKey)
      || s(d.model) !== s(vg.model)
      || s(d.size) !== s(vg.size)
      || s(d.seconds) !== s(vg.seconds)
      || s(d.pollMs) !== s(vg.pollMs)
      || s(dc.submitPath) !== s(c.submitPath)
      || s(dc.submitBody) !== s(c.submitBody)
      || s(dc.statusPath) !== s(c.statusPath)
      || s(dc.statusField) !== s(c.statusField || 'status')
      || s(dc.urlField) !== s(c.urlField || 'video_url')
      || s(dc.doneValues) !== s(c.doneValues || 'succeeded,completed,success')
      || s(dc.failValues) !== s(c.failValues || 'failed,error');
  }

  // ---------------- 表单 helper ----------------
  function cfgField(label, inputHtml, desc) {
    return `<div class="field">
      <label>${escapeHtml(label)}</label>
      ${inputHtml}
      ${desc ? `<div class="desc">${escapeHtml(desc)}</div>` : ''}
    </div>`;
  }

  function dInput(key, value, opts) {
    const o = opts || {};
    const attrs = [
      'class="input"',
      `data-vd="${key}"`,
      `type="${o.type || 'text'}"`,
      `value="${escapeHtml(value === undefined || value === null ? '' : value)}"`,
      `placeholder="${escapeHtml(o.placeholder || '')}"`,
    ];
    if (o.min !== undefined) attrs.push(`min="${o.min}"`);
    if (o.step !== undefined) attrs.push(`step="${o.step}"`);
    if (o.mono) attrs.push('style="font-family:var(--mono);font-size:12.5px"');
    return `<input ${attrs.join(' ')}>`;
  }

  function dArea(key, value, opts) {
    const o = opts || {};
    return `<textarea class="textarea" data-vd="${key}" rows="${o.rows || 6}"
      placeholder="${escapeHtml(o.placeholder || '')}"
      style="font-family:var(--mono);font-size:12.5px">${escapeHtml(value || '')}</textarea>`;
  }

  // ---------------- 渲染：配置 ----------------
  function customBlock(d) {
    return `<div class="hr"></div>
      <div class="text-sm text-muted" style="margin-bottom:10px">
        自定义适配器：提交和轮询两段请求都自己描述，模板里的占位符会被替换成这次任务的参数。
      </div>
      <div class="grid grid-2" style="align-items:start">
        <div>
          ${cfgField('提交路径', dInput('custom.submitPath', d.custom.submitPath, { mono: true, placeholder: '/videos' }), '拼在 Base URL 后面')}
          ${cfgField('提交模板（JSON）', dArea('custom.submitBody', d.custom.submitBody, {
            rows: 7,
            placeholder: '{\n  "model": "{model}",\n  "prompt": "{prompt}",\n  "size": "{size}",\n  "seconds": "{seconds}",\n  "image": "{image}"\n}',
          }), '可用占位符：{prompt} {model} {size} {seconds} {image}；留空则发 {prompt, model, image}')}
        </div>
        <div>
          ${cfgField('轮询路径', dInput('custom.statusPath', d.custom.statusPath, { mono: true, placeholder: '/videos/{id}' }), '{id} 会替换成提交拿到的任务 id')}
          ${cfgField('状态字段', dInput('custom.statusField', d.custom.statusField, { mono: true, placeholder: 'status 或 data.status' }), '支持点号取嵌套字段')}
          ${cfgField('视频地址字段', dInput('custom.urlField', d.custom.urlField, { mono: true, placeholder: 'video_url 或 data.video_url' }))}
          ${cfgField('完成值', dInput('custom.doneValues', d.custom.doneValues, { mono: true, placeholder: 'succeeded,completed,success' }), '逗号分隔，状态等于其中之一就算完成')}
          ${cfgField('失败值', dInput('custom.failValues', d.custom.failValues, { mono: true, placeholder: 'failed,error' }), '逗号分隔，命中就标记失败')}
        </div>
      </div>`;
  }

  function configCard(d) {
    const p = PROVIDERS.find((x) => x.id === d.provider) || PROVIDERS[0];
    const isCustom = d.provider === 'custom';
    const busy = state.saving;
    return `<div class="card mb-3" id="vdConfig">
      <div class="card-head">
        <h3>接口配置</h3>
        <span class="tag ${d.enabled ? 'ok' : ''}">${d.enabled ? '已启用' : '未启用'}</span>
        ${dirty() ? '<span class="tag warn" data-vd-dirty="1">未保存</span>' : ''}
        <div class="grow"></div>
        <button class="switch ${d.enabled ? 'on' : ''}" data-vd-enabled role="switch"
          aria-checked="${d.enabled}" title="${d.enabled ? '停用' : '启用'}"></button>
        <button class="btn btn-primary btn-sm" data-vd-save ${busy ? 'disabled' : ''}>
          ${icon('check', 13)} ${busy ? '保存中…' : '保存'}
        </button>
      </div>
      <div class="card-body">
        <div class="grid grid-2" style="align-items:start">
          <div>
            ${cfgField('服务商', `<select class="select" data-vd="provider">${PROVIDERS.map((x) =>
              `<option value="${x.id}" ${x.id === d.provider ? 'selected' : ''}>${escapeHtml(x.label)}</option>`).join('')}</select>`,
              isCustom ? '自定义适配器：路径与字段全部自己填' : `例如 ${p.baseUrl}`)}
            ${cfgField('Base URL', dInput('baseUrl', d.baseUrl, { mono: true, placeholder: p.baseUrl || 'https://your-gateway/v1' }), '填到 /v1 这一级，适配器自己拼后面的路径')}
            ${cfgField('API Key', dInput('apiKey', d.apiKey, { type: 'password', mono: true, placeholder: 'sk-…' }), '只存在本机 data/config.json，不会发到别处')}
            ${cfgField('模型', dInput('model', d.model, { mono: true, placeholder: p.model || 'my-video-model' }), '留空则用适配器自带的默认模型')}
          </div>
          <div>
            ${cfgField('尺寸', dInput('size', d.size, { mono: true, placeholder: '1280x720 或 720P' }), '各服务商取值不同：OpenAI 走 1280x720，MiniMax 走 720P')}
            ${cfgField('时长（秒）', dInput('seconds', d.seconds, { type: 'number', min: 1, step: 1, placeholder: '8' }))}
            ${cfgField('轮询间隔（毫秒）', dInput('pollMs', d.pollMs, { type: 'number', min: 500, step: 100, placeholder: '3000' }), '服务端多久查一次进度，太小会白费请求，建议 3000 以上')}
          </div>
        </div>
        ${isCustom ? customBlock(d) : ''}
      </div>
    </div>`;
  }

  // ---------------- 渲染：生成 ----------------
  function generateCard() {
    const saved = videoCfg();
    const on = Boolean(saved.enabled);
    const img = state.image
      ? `<div class="flex items-center gap-2" style="margin-top:10px;flex-wrap:wrap">
           <img src="${escapeHtml(state.image)}" alt="首帧预览"
             style="width:78px;height:52px;object-fit:cover;border-radius:6px;border:1px solid var(--border)">
           <span class="text-sm text-muted">已选首帧：${escapeHtml(state.imageName || '图片')}</span>
           <button class="btn btn-ghost btn-sm" data-vd-image-clear>${icon('x', 12)} 移除</button>
         </div>`
      : '<div class="text-sm text-muted" style="margin-top:8px">首帧图可选，加上就是图生视频（自定义模板里用 {image} 引用）。</div>';

    return `<div class="card mb-3" id="vdGen">
      <div class="card-head">
        <h3>生成视频</h3>
        <span class="sub">${on ? `当前服务商 ${escapeHtml(providerLabel(saved.provider))}` : '未启用，先启用并保存上方配置'}</span>
      </div>
      <div class="card-body">
        ${on ? '' : `<div class="notice warn" style="margin-bottom:12px">${icon('alert')}
          <div>视频生成还没启用，直接提交会被服务端拒绝。把上方配置填好、打开开关并保存后再点生成。</div></div>`}
        <div class="field">
          <label>提示词</label>
          <textarea class="textarea" id="vdPrompt" rows="4"
            placeholder="描述画面：主体、动作、镜头、光线…（上限 2000 字）">${escapeHtml(state.prompt)}</textarea>
          <div class="desc">写清主体 + 动作 + 镜头，比一句泛泛的描述稳得多。</div>
        </div>
        <div class="flex items-center gap-2" style="flex-wrap:wrap">
          <input class="input" id="vdSize" style="max-width:200px" value="${escapeHtml(state.size)}"
            placeholder="尺寸（默认 ${escapeHtml(String(saved.size || '1280x720'))}）">
          <input class="input" id="vdSeconds" type="number" min="1" step="1" style="max-width:170px"
            value="${escapeHtml(state.seconds)}" placeholder="秒数（默认 ${escapeHtml(String(saved.seconds || 8))}）">
          <button class="btn btn-ghost btn-sm" data-vd-image>${icon('plus', 13)} 首帧图</button>
          <div class="grow"></div>
          <button class="btn btn-primary" data-vd-generate ${state.generating ? 'disabled' : ''}>
            ${icon('play', 14)} ${state.generating ? '提交中…' : '生成'}
          </button>
        </div>
        ${img}
      </div>
    </div>`;
  }

  // ---------------- 渲染：任务列表 ----------------
  function sendableChannels() {
    const ch = (App.state.config && App.state.config.channels) || {};
    return CHANNELS.filter((c) => ch[c.id] && ch[c.id].enabled);
  }

  function sendPanel(job) {
    const available = sendableChannels();
    if (!available.length) {
      return `<div style="margin-top:10px">
        <div class="notice warn">${icon('alert')}
          <div>没有启用中的可发送渠道。先到「渠道」页把 OneBot 11 / 微信公众号 / 企业微信 里的至少一个启用。</div>
        </div>
      </div>`;
    }
    const ch = available.find((c) => c.id === state.sendChannel) || available[0];
    const group = state.sendTargetType === 'group';
    return `<div style="margin-top:10px;padding:12px 13px;background:var(--surface-2);border:1px solid var(--border);border-radius:9px">
      <div class="flex items-center gap-2" style="flex-wrap:wrap">
        <select class="select" data-vd-send-channel style="width:auto;min-width:190px">
          ${available.map((c) => `<option value="${c.id}" ${c.id === ch.id ? 'selected' : ''}>${escapeHtml(c.label)}</option>`).join('')}
        </select>
        <select class="select" data-vd-send-type style="width:auto;min-width:100px">
          <option value="private" ${group ? '' : 'selected'}>私聊</option>
          <option value="group" ${group ? 'selected' : ''}>群聊</option>
        </select>
        <input class="input" data-vd-send-target style="flex:1;min-width:160px"
          value="${escapeHtml(state.sendTargetId)}"
          placeholder="${group ? '群号' : '接收方 ID（QQ 号 / openid）'}">
        <button class="btn btn-primary btn-sm" data-vd-send-go="${escapeHtml(job.id)}">${icon('send', 13)} 发送</button>
        <button class="btn btn-ghost btn-sm" data-vd-send-close>取消</button>
      </div>
      <div class="text-sm text-muted" style="margin-top:7px">
        ${ch.real ? 'OneBot 11 能直接把视频文件发出去。' : '这个渠道没有「主动发视频」接口，会退化成文字 + 链接。'}
        目标 ID 由渠道决定：OneBot 填 QQ 号或群号。
      </div>
    </div>`;
  }

  function jobRow(job) {
    const st = STATUS[job.status] || { label: job.status || '未知', cls: '' };
    const isDone = job.status === 'succeeded';
    const isFailed = job.status === 'failed';
    const sent = job.notified === 'sent';
    const busy = state.busyId === job.id;
    const isOpen = state.sendOpenId === job.id;
    const prompt = String(job.prompt || '');
    const short = prompt.length > 140 ? `${prompt.slice(0, 140)}…` : prompt;
    const fileUrl = `/api/video/file/${encodeURIComponent(job.id)}`;
    const rawProgress = job.progress;
    const progress = rawProgress === undefined || rawProgress === null || rawProgress === '' ? NaN : Number(rawProgress);
    const progressTag = Number.isFinite(progress)
      ? `<span class="tag">进度 ${Math.max(0, Math.min(100, Math.round(progress)))}%</span>`
      : '';
    const metaBits = [];
    if (job.size) metaBits.push(`尺寸 ${job.size}`);
    if (Number(job.seconds) > 0) metaBits.push(`${Number(job.seconds)} 秒`);
    if (fmtBytes(job.bytes)) metaBits.push(fmtBytes(job.bytes));
    metaBits.push(`任务 ${job.id}`);

    return `<div style="border:1px solid var(--border);border-radius:10px;padding:12px 14px">
      <div class="flex items-center gap-2" style="flex-wrap:wrap">
        <span class="tag info">${escapeHtml(job.provider || '—')}</span>
        ${job.model ? `<span class="tag">${escapeHtml(job.model)}</span>` : ''}
        <span class="tag ${st.cls}">${escapeHtml(st.label)}</span>
        ${sent ? '<span class="tag ok">已发送</span>' : ''}
        ${progressTag}
        <div class="grow"></div>
        <span class="text-sm text-muted">${job.createdAt ? escapeHtml(fmtTime(job.createdAt)) : '—'}</span>
      </div>
      <div style="margin-top:9px;font-size:13px;line-height:1.65;color:var(--text-2);word-break:break-word"
        title="${escapeHtml(prompt)}">${escapeHtml(short || '（没有提示词）')}</div>
      <div class="text-sm text-muted" style="margin-top:4px">${escapeHtml(metaBits.join(' · '))}</div>
      ${job.error ? `<div class="notice warn" style="margin-top:9px">${icon('alert')}
        <div>${isFailed ? '失败原因：' : '上次错误：'}${escapeHtml(job.error)}</div></div>` : ''}
      ${isDone ? `<video controls preload="metadata" src="${fileUrl}"
        style="width:100%;max-height:280px;margin-top:10px;border-radius:9px;background:#000"></video>` : ''}
      <div class="flex items-center gap-2" style="flex-wrap:wrap;margin-top:10px">
        ${isDone ? `<a class="btn btn-ghost btn-sm" href="${fileUrl}" download="${escapeHtml(job.id)}.mp4">
          ${icon('download', 13)} 下载</a>` : ''}
        ${isDone ? `<button class="btn btn-soft btn-sm" data-vd-send="${escapeHtml(job.id)}">
          ${icon('send', 13)} ${isOpen ? '收起' : '发送'}</button>` : ''}
        ${(isDone || isFailed) ? `<button class="btn btn-danger btn-sm" data-vd-del="${escapeHtml(job.id)}"
          ${busy ? 'disabled' : ''}>${icon('trash', 13)} 删除</button>` : ''}
        ${PENDING.includes(job.status) ? '<span class="text-sm text-muted">正在生成，可离开本页，任务在服务端继续跑</span>' : ''}
      </div>
      ${isOpen ? sendPanel(job) : ''}
    </div>`;
  }

  function jobsBlock() {
    if (state.loading && !state.jobs.length) {
      return '<div class="text-sm text-muted" style="padding:4px 0">加载任务列表…</div>';
    }
    if (state.error && !state.jobs.length) {
      return `<div class="notice warn">${icon('alert')}
        <div>加载视频任务失败：${escapeHtml(state.error)}</div></div>`;
    }
    if (!state.jobs.length) {
      return empty('还没有视频任务', '在上面写一句提示词，点「生成」就会开始排队', 'play');
    }
    const pending = state.jobs.filter((j) => PENDING.includes(j.status)).length;
    const okCount = state.jobs.filter((j) => j.status === 'succeeded').length;
    const failCount = state.jobs.filter((j) => j.status === 'failed').length;
    return `<div class="text-sm text-muted">
        最近 ${state.jobs.length} 条 · 进行中 ${pending} · 成功 ${okCount} · 失败 ${failCount}
        ${pending ? ' · 每 5 秒自动刷新' : ''}
      </div>
      ${state.jobs.map(jobRow).join('')}`;
  }

  function jobsCard() {
    return `<div class="card">
      <div class="card-head">
        <h3>任务列表</h3>
        <span class="sub">最近 30 条</span>
        <div class="grow"></div>
        <button class="btn btn-ghost btn-sm" data-vd-refresh>${icon('refresh', 13)} 刷新</button>
      </div>
      <div class="card-body" id="vdJobs" style="display:flex;flex-direction:column;gap:12px">${jobsBlock()}</div>
    </div>`;
  }

  function statusLine() {
    const st = state.status || {};
    const pending = Number.isFinite(Number(st.pending))
      ? Number(st.pending)
      : state.jobs.filter((j) => PENDING.includes(j.status)).length;
    const okCount = Number.isFinite(Number(st.succeeded))
      ? Number(st.succeeded)
      : state.jobs.filter((j) => j.status === 'succeeded').length;
    const failCount = Number.isFinite(Number(st.failed))
      ? Number(st.failed)
      : state.jobs.filter((j) => j.status === 'failed').length;
    const on = st.enabled === undefined ? null : Boolean(st.enabled);
    const head = on === null ? '视频生成' : (on ? '视频生成已开启' : '视频生成未开启');
    const err = state.error ? ` · <span class="text-danger">${escapeHtml(state.error)}</span>` : '';
    return `${head} · 进行中 ${pending} · 成功 ${okCount} · 失败 ${failCount}${err}`;
  }

  function shell() {
    if (!App.state.config) {
      return `<div id="vdRoot">${empty('配置还没加载完', '稍等一下，或点右上角刷新', 'info')}</div>`;
    }
    return `<div id="vdRoot">
      <div class="text-sm text-muted" style="margin-bottom:10px">${statusLine()}</div>
      ${configCard(draft())}
      ${generateCard()}
      ${jobsCard()}
      <input type="file" id="vdImageFile" accept="image/*" hidden>
    </div>`;
  }

  // ---------------- 页面存活判断 ----------------
  // 异步回来时可能已经切走：路由变了或这一屏节点已经被替换，就不要往 DOM 上画
  function alive() {
    return App.state.route === 'video'
      && Boolean(state.root)
      && state.root.isConnected
      && Boolean(state.root.querySelector('#vdRoot'));
  }

  function rerenderAll() {
    if (!alive()) return;
    state.root.innerHTML = shell();
    wire(state.root);
    state.sig = jobsSignature();
  }

  function rerenderJobs() {
    if (!alive()) return;
    const box = state.root.querySelector('#vdJobs');
    if (!box) return;
    box.innerHTML = jobsBlock();
    wireJobs(box);
    state.sig = jobsSignature();
  }

  // 轮询时只有内容真的变了才重建列表，避免把正在播放的视频打断
  function jobsSignature() {
    return JSON.stringify([
      state.loading,
      state.error,
      state.sendOpenId,
      state.sendChannel,
      state.sendTargetType,
      state.busyId,
      state.jobs.map((j) => [j.id, j.status, j.progress, j.error, j.notified, j.provider, j.model]),
    ]);
  }

  // ---------------- 数据 ----------------
  async function loadJobs(silent) {
    try {
      const r = await api('/api/video/jobs?limit=30');
      state.jobs = r.jobs || [];
      state.status = r.status || null;
      state.error = '';
      return true;
    } catch (err) {
      state.error = err.message;
      if (!silent) toast(`加载视频任务失败：${err.message}`, 'err');
      return false;
    } finally {
      state.loading = false;
    }
  }

  function hasPending() {
    return state.jobs.some((j) => PENDING.includes(j.status));
  }

  // ---------------- 自动轮询 ----------------
  function startPoll() {
    if (state.timer) return; // 幂等：已经在跑就不再叠加第二个 interval
    state.timer = setInterval(pollOnce, POLL_INTERVAL);
  }

  function stopPoll() {
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
  }

  async function pollOnce() {
    if (!alive()) { stopPoll(); return; }
    if (state.polling) return;
    state.polling = true;
    try {
      await loadJobs(true);
      if (!alive()) { stopPoll(); return; }
      if (jobsSignature() !== state.sig) rerenderJobs();
      if (!hasPending()) stopPoll();
    } finally {
      state.polling = false;
    }
  }

  async function refreshAll() {
    if (!state.jobs.length) state.loading = true;
    await loadJobs(false);
    rerenderAll();
    if (hasPending()) startPoll();
  }

  // ---------------- 操作 ----------------
  async function saveConfig() {
    const cfg = App.state.config;
    if (!cfg) { toast('配置还没加载完，稍后再试', 'err'); return; }
    collect();
    const d = state.draft || draft();
    const prev = cfg.videoGen || {};
    cfg.videoGen = {
      ...prev,
      enabled: Boolean(d.enabled),
      provider: d.provider || 'openai',
      baseUrl: String(d.baseUrl || '').trim(),
      apiKey: String(d.apiKey || '').trim(),
      model: String(d.model || '').trim(),
      size: String(d.size || '').trim(),
      seconds: Number(d.seconds) || 0,
      pollMs: Math.max(500, Number(d.pollMs) || 3000),
      custom: {
        ...(prev.custom || {}),
        submitPath: String((d.custom && d.custom.submitPath) || '').trim(),
        submitBody: String((d.custom && d.custom.submitBody) || '').trim(),
        statusPath: String((d.custom && d.custom.statusPath) || '').trim(),
        statusField: String((d.custom && d.custom.statusField) || '').trim() || 'status',
        urlField: String((d.custom && d.custom.urlField) || '').trim() || 'video_url',
        doneValues: String((d.custom && d.custom.doneValues) || '').trim() || 'succeeded,completed,success',
        failValues: String((d.custom && d.custom.failValues) || '').trim() || 'failed,error',
      },
    };
    state.saving = true;
    rerenderAll();
    try {
      // 整份配置回写：后端按对象整体替换，只发一部分字段会把别的配置清掉
      await api('/api/config', { method: 'PUT', body: cfg });
      await App.fetchConfig();
      // 存好了就以服务端返回的配置为准，别让旧草稿盖住刚保存的结果
      state.draft = null;
      toast('视频生成配置已保存', 'ok');
    } catch (err) {
      toast(`保存失败：${err.message}`, 'err');
    } finally {
      state.saving = false;
      rerenderAll();
    }
  }

  async function submitJob() {
    const root = state.root;
    const promptEl = root && root.querySelector('#vdPrompt');
    if (promptEl) state.prompt = promptEl.value;
    const sizeEl = root && root.querySelector('#vdSize');
    if (sizeEl) state.size = sizeEl.value;
    const secEl = root && root.querySelector('#vdSeconds');
    if (secEl) state.seconds = secEl.value;

    const prompt = String(state.prompt || '').trim();
    if (!prompt) { toast('请先写一段提示词', 'err'); return; }
    if (prompt.length > 2000) { toast('提示词不能超过 2000 字', 'err'); return; }
    const saved = videoCfg();
    if (!saved.enabled) { toast('视频生成未启用，先在配置卡打开开关并保存', 'err'); return; }
    collect();
    if (dirty()) toast('配置有未保存的改动，本次会按已保存的配置生成', 'warn');

    const body = { prompt };
    const size = String(state.size || '').trim();
    if (size) body.size = size;
    const seconds = Number(String(state.seconds || '').trim());
    if (Number.isFinite(seconds) && seconds > 0) body.seconds = seconds;
    // FileReader 读出来的就是 data URL，服务端直接解 base64
    if (state.image) body.image = state.image;

    state.generating = true;
    rerenderAll();
    try {
      const r = await api('/api/video/generate', { method: 'POST', body });
      const id = (r.job && r.job.id) || '';
      toast(`已提交任务 ${id}`, 'ok');
      state.prompt = '';
      state.image = '';
      state.imageName = '';
      state.size = '';
      state.seconds = '';
      await loadJobs(true);
      rerenderAll();
      if (hasPending()) startPoll();
    } catch (err) {
      toast(`提交失败：${err.message}`, 'err');
    } finally {
      state.generating = false;
      rerenderAll();
    }
  }

  function readImage(file) {
    if (!/^image\//.test(file.type || '')) { toast('请选择图片文件', 'err'); return; }
    if (file.size > 6 * 1048576) { toast('首帧图不要超过 6MB', 'err'); return; }
    const reader = new FileReader();
    reader.onload = () => {
      state.image = String(reader.result || '');
      state.imageName = file.name;
      rerenderAll();
    };
    reader.onerror = () => toast('读取图片失败', 'err');
    reader.readAsDataURL(file);
  }

  function openSend(id) {
    if (state.sendOpenId === id) { state.sendOpenId = ''; rerenderJobs(); return; }
    state.sendOpenId = id;
    const available = sendableChannels();
    if (!available.some((c) => c.id === state.sendChannel)) {
      state.sendChannel = available[0] ? available[0].id : '';
    }
    state.sendTargetType = 'private';
    state.sendTargetId = '';
    rerenderJobs();
  }

  async function sendJob(id) {
    const job = state.jobs.find((j) => j.id === id);
    if (!job) { toast('任务不在列表里了，刷新一下', 'err'); return; }
    const available = sendableChannels();
    const channel = available.find((c) => c.id === state.sendChannel) || available[0];
    if (!channel) { toast('没有启用的可发送渠道', 'err'); return; }
    const targetId = String(state.sendTargetId || '').trim();
    if (!targetId) { toast('请填写接收方 ID', 'err'); return; }

    state.busyId = id;
    rerenderJobs();
    try {
      const r = await api(`/api/video/jobs/${encodeURIComponent(id)}/send`, {
        method: 'POST',
        body: {
          channel: channel.id,
          targetType: state.sendTargetType === 'group' ? 'group' : 'private',
          targetId,
        },
      });
      if (r && r.degraded) toast('该渠道只能发文字+链接', 'warn');
      else toast('已发送', 'ok');
      state.sendOpenId = '';
      await loadJobs(true);
    } catch (err) {
      toast(`发送失败：${err.message}`, 'err');
    } finally {
      state.busyId = '';
      rerenderJobs();
    }
  }

  async function removeJob(id) {
    const job = state.jobs.find((j) => j.id === id);
    const tip = job && job.prompt ? `（${String(job.prompt).slice(0, 60)}）` : '';
    const yes = await confirmDialog({
      title: '删除任务',
      message: `确定删除任务 ${id}${tip}？本地视频文件会一起删掉，不可恢复。`,
      confirmText: '删除',
      danger: true,
    });
    if (!yes) return;
    state.busyId = id;
    rerenderJobs();
    try {
      await api(`/api/video/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' });
      toast('任务已删除', 'ok');
      if (state.sendOpenId === id) state.sendOpenId = '';
      await loadJobs(true);
    } catch (err) {
      toast(`删除失败：${err.message}`, 'err');
    } finally {
      state.busyId = '';
      rerenderJobs();
    }
  }

  // ---------------- 事件 ----------------
  function wireJobs(scope) {
    if (!scope) return;

    scope.querySelectorAll('[data-vd-send]').forEach((el) => {
      el.addEventListener('click', () => openSend(el.dataset.vdSend));
    });

    scope.querySelectorAll('[data-vd-del]').forEach((el) => {
      el.addEventListener('click', () => removeJob(el.dataset.vdDel));
    });

    scope.querySelectorAll('[data-vd-send-go]').forEach((el) => {
      el.addEventListener('click', () => sendJob(el.dataset.vdSendGo));
    });

    scope.querySelectorAll('[data-vd-send-close]').forEach((el) => {
      el.addEventListener('click', () => { state.sendOpenId = ''; rerenderJobs(); });
    });

    const chSel = scope.querySelector('[data-vd-send-channel]');
    if (chSel) {
      chSel.addEventListener('change', () => {
        state.sendChannel = chSel.value;
        rerenderJobs(); // 渠道会改变下面那句提示
      });
    }

    const typeSel = scope.querySelector('[data-vd-send-type]');
    if (typeSel) {
      typeSel.addEventListener('change', () => {
        state.sendTargetType = typeSel.value === 'group' ? 'group' : 'private';
        rerenderJobs(); // placeholder 跟着「私聊 / 群聊」变
      });
    }

    const target = scope.querySelector('[data-vd-send-target]');
    if (target) {
      target.addEventListener('input', () => { state.sendTargetId = target.value; });
    }
  }

  // 打字时只更新「未保存」角标，不重渲染整页：重渲染会丢焦点和光标位置
  function refreshDirtyBadge() {
    if (!alive()) return;
    const head = state.root.querySelector('#vdConfig .card-head');
    if (!head) return;
    const badge = head.querySelector('[data-vd-dirty]');
    if (dirty()) {
      if (badge) return;
      const grow = head.querySelector('.grow');
      const el = document.createElement('span');
      el.className = 'tag warn';
      el.dataset.vdDirty = '1';
      el.textContent = '未保存';
      head.insertBefore(el, grow || null);
    } else if (badge) {
      badge.remove();
    }
  }

  function wire(root) {
    root.querySelector('[data-vd-enabled]')?.addEventListener('click', () => {
      const d = draft();
      d.enabled = !d.enabled;
      rerenderAll();
    });

    root.querySelector('[data-vd-save]')?.addEventListener('click', saveConfig);

    // 输入即写回草稿：切服务商、保存中重渲染都不会丢改动
    root.querySelectorAll('[data-vd]').forEach((el) => {
      const sync = () => {
        setDraft(el.dataset.vd, el.value);
        refreshDirtyBadge();
      };
      el.addEventListener('input', sync);
      el.addEventListener('change', () => {
        sync();
        // 服务商决定下面要不要展开自定义适配器的字段
        if (el.dataset.vd === 'provider') rerenderAll();
      });
    });

    const prompt = root.querySelector('#vdPrompt');
    if (prompt) prompt.addEventListener('input', () => { state.prompt = prompt.value; });

    const size = root.querySelector('#vdSize');
    if (size) size.addEventListener('input', () => { state.size = size.value; });

    const seconds = root.querySelector('#vdSeconds');
    if (seconds) seconds.addEventListener('input', () => { state.seconds = seconds.value; });

    root.querySelector('[data-vd-image]')?.addEventListener('click', () => {
      root.querySelector('#vdImageFile')?.click();
    });

    const fileInput = root.querySelector('#vdImageFile');
    if (fileInput) {
      fileInput.addEventListener('change', () => {
        const f = fileInput.files && fileInput.files[0];
        fileInput.value = '';
        if (f) readImage(f);
      });
    }

    root.querySelector('[data-vd-image-clear]')?.addEventListener('click', () => {
      state.image = '';
      state.imageName = '';
      rerenderAll();
    });

    root.querySelector('[data-vd-generate]')?.addEventListener('click', submitJob);
    root.querySelector('[data-vd-refresh]')?.addEventListener('click', () => { refreshAll(); });

    wireJobs(root.querySelector('#vdJobs'));
  }

  // ---------------- 视图 ----------------
  const video = {
    title: '视频生成',
    desc: '文生视频 / 图生视频：提交任务、盯进度、发到渠道',
    actions() {
      return `<button class="btn btn-ghost btn-sm" data-act="vd-refresh">${icon('refresh', 14)} 刷新</button>`;
    },
    render() {
      return shell();
    },
    mount(root) {
      state.root = root;
      draft();      // 进来就把草稿建好，后面所有重渲染都从它取
      // 重进页面先清掉上一轮的定时器，再由「有没有进行中的任务」决定是否重起，避免多个 interval 叠加
      stopPoll();
      document.querySelector('[data-act="vd-refresh"]')?.addEventListener('click', refreshAll);
      wire(root);
      refreshAll();
    },
  };

  Views.video = video;
})();
