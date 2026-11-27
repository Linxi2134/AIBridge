/* 技能页面：技能包安装 / 启停 / 查看说明 / 分配给智能体 */
(function () {
  'use strict';
  const { icon, escapeHtml, api, toast } = Core;
  window.Views = window.Views || {};

  // 页面状态放模块级：App.render 每次都会重建整块 DOM，挂在元素上的状态会一起丢掉
  const state = {
    loading: true,
    error: '',
    skills: [],
    path: '',
    installing: false,
    busyId: '',
  };

  // views.js 里的 emptyState 没导出，这里按同样的结构补一份，样式才一致
  function empty(title, desc, iconName) {
    return `<div class="empty">${icon(iconName || 'info', 40)}<h4>${escapeHtml(title)}</h4><p>${escapeHtml(desc || '')}</p></div>`;
  }

  function fmtTime(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return '—';
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  // 服务端要的是纯 base64，DataURL 的 `data:...;base64,` 前缀必须去掉，否则解码出来是坏字节
  function readBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const raw = String(reader.result || '');
        const comma = raw.indexOf(',');
        resolve(comma >= 0 ? raw.slice(comma + 1) : raw);
      };
      reader.onerror = () => reject(new Error('读取本地文件失败'));
      reader.readAsDataURL(file);
    });
  }

  function agentsOf() {
    const cfg = App.state.config;
    return (cfg && cfg.agents) || [];
  }

  function tagsOf(list, cls) {
    if (!list || !list.length) return '<span class="text-muted">—</span>';
    return list.map((t) => `<span class="tag${cls ? ` ${cls}` : ''}">${escapeHtml(t)}</span>`).join(' ');
  }

  // ---------------- 渲染 ----------------
  function installCard() {
    const disabled = state.installing;
    return `<div class="card mb-3">
      <div class="card-head">
        <h3>安装技能</h3>
        <span class="sub">技能包是一个含 skill.json 的 zip</span>
      </div>
      <div class="card-body">
        <div class="flex items-center gap-2" style="flex-wrap:wrap">
          <button class="btn btn-primary" data-sk-zip ${disabled ? 'disabled' : ''}>
            ${icon('plus', 14)} ${disabled ? '安装中…' : '选择 .zip 安装'}
          </button>
          <span class="text-sm text-muted">大小上限 10MB，包内文件数不超过 200 个</span>
        </div>
        <div class="hr"></div>
        <div class="field">
          <label>或填写服务端目录路径</label>
          <div class="flex items-center gap-2" style="flex-wrap:wrap">
            <input class="input" id="skPath" style="flex:1;min-width:220px;font-family:var(--mono);font-size:12.5px"
              value="${escapeHtml(state.path)}" placeholder="例如 D:\\skills\\translator">
            <button class="btn btn-ghost" data-sk-path ${disabled ? 'disabled' : ''}>${icon('link', 14)} 从目录安装</button>
          </div>
          <div class="desc">路径由服务端（这台电脑）解析，目录里必须有 skill.json；重复安装同一个 id 会覆盖。</div>
        </div>
        <input type="file" id="skZip" accept=".zip" hidden>
      </div>
    </div>`;
  }

  function assignBlock(skill) {
    const agents = agentsOf();
    if (!agents.length) return '<span class="text-sm text-muted">还没有智能体</span>';
    return agents.map((a) => {
      const list = Array.isArray(a.skills) ? a.skills : [];
      const on = list.includes(skill.id);
      return `<label class="flex items-center gap-2 text-sm" style="cursor:pointer;padding:3px 0">
        <input type="checkbox" data-sk-assign="${escapeHtml(skill.id)}" data-agent="${escapeHtml(a.id)}" ${on ? 'checked' : ''}>
        <span>${escapeHtml(a.name || a.id)}</span>
      </label>`;
    }).join('');
  }

  function skillCard(skill) {
    const enabled = Boolean(skill.enabled);
    const busy = state.busyId === skill.id;
    const assetCount = (skill.assets || []).length;
    return `<div class="card" style="${enabled ? '' : 'opacity:.72'}">
      <div class="card-head">
        <h3>${escapeHtml(skill.name || skill.id)}</h3>
        <span class="tag">v${escapeHtml(skill.version || '0.0.0')}</span>
        ${enabled ? '<span class="tag ok">已启用</span>' : '<span class="tag">已停用</span>'}
        <div class="grow"></div>
        <button class="switch ${enabled ? 'on' : ''}" data-sk-toggle="${escapeHtml(skill.id)}"
          role="switch" aria-checked="${enabled}" title="${enabled ? '停用' : '启用'}" ${busy ? 'disabled' : ''}></button>
      </div>
      <div class="card-body">
        <div style="font-size:13px;line-height:1.65;color:var(--text-2)">${escapeHtml(skill.description || '（没有描述）')}</div>
        <div style="display:flex;flex-direction:column;gap:7px;margin-top:12px">
          <div class="kv-row"><span class="k">触发词</span><span class="v" style="display:flex;gap:5px;flex-wrap:wrap">${tagsOf(skill.triggers, 'info')}</span></div>
          <div class="kv-row"><span class="k">工具建议</span><span class="v" style="display:flex;gap:5px;flex-wrap:wrap">${tagsOf(skill.tools)}</span></div>
          <div class="kv-row"><span class="k">资料文件</span><span class="v">${assetCount} 个${assetCount ? ` · ${escapeHtml((skill.assets || []).slice(0, 4).join('、'))}${assetCount > 4 ? ' …' : ''}` : ''}</span></div>
          <div class="kv-row"><span class="k">安装时间</span><span class="v">${fmtTime(skill.installedAt)}</span></div>
        </div>
        <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border)">
          <div class="text-sm text-muted" style="margin-bottom:4px">分配给智能体（只在该智能体的对话里加载）</div>
          <div class="flex gap-3" style="flex-wrap:wrap">${assignBlock(skill)}</div>
        </div>
        <div class="flex gap-2" style="flex-wrap:wrap;margin-top:14px">
          <button class="btn btn-ghost btn-sm" data-sk-view="${escapeHtml(skill.id)}">${icon('eye', 13)} 查看说明</button>
          <button class="btn btn-danger btn-sm" data-sk-del="${escapeHtml(skill.id)}">${icon('trash', 13)} 卸载</button>
        </div>
      </div>
    </div>`;
  }

  function listBlock() {
    if (state.loading && !state.skills.length) {
      return `<div class="card"><div class="card-body text-sm text-muted">加载技能列表…</div></div>`;
    }
    if (state.error) {
      return `<div class="notice warn">${icon('alert')}
        <div>加载技能失败：${escapeHtml(state.error)}<br>检查服务端是否已启用 /api/skills 接口，然后点右上角刷新。</div></div>`;
    }
    if (!state.skills.length) {
      return `<div class="card">${empty('还没有安装技能', '上传一个 zip，或填入服务端已有的技能目录', 'package')}</div>`;
    }
    return `<div class="grid grid-2" style="align-items:start">${state.skills.map(skillCard).join('')}</div>`;
  }

  function shell() {
    const enabled = state.skills.filter((s) => s.enabled).length;
    return `
      ${installCard()}
      <div class="text-sm text-muted" style="margin-bottom:10px">
        已安装 ${state.skills.length} 个技能 · 启用 ${enabled} 个 · 启用技能的说明会拼进智能体的系统提示词
      </div>
      ${listBlock()}`;
  }

  // ---------------- 视图 ----------------
  const skills = {
    title: '技能',
    desc: '给智能体装上可复用的能力包：说明、触发词与资料',
    actions() {
      return `<button class="btn btn-ghost btn-sm" data-act="sk-refresh">${icon('refresh', 14)} 刷新</button>`;
    },
    render() {
      return shell();
    },
    mount(root) {
      // 异步回来时用户可能已经切页，别把旧页面画到别的路由上
      const alive = () => App.state.route === 'skills';
      const rerender = () => {
        if (!alive()) return;
        root.innerHTML = shell();
        wire(root);
      };

      async function loadSkills() {
        if (!state.skills.length) state.loading = true;
        try {
          const r = await api('/api/skills');
          state.skills = r.skills || [];
          state.error = '';
        } catch (err) {
          state.error = err.message;
          toast(`加载技能失败：${err.message}`, 'err');
        } finally {
          state.loading = false;
        }
      }

      async function installFromZip(file) {
        if (!file) return;
        if (file.size > 10 * 1048576) { toast('技能包不能超过 10MB', 'err'); return; }
        state.installing = true;
        rerender();
        try {
          const dataBase64 = await readBase64(file);
          const r = await api('/api/skills/install', { method: 'POST', body: { filename: file.name, dataBase64 } });
          toast(`已安装「${(r.skill && r.skill.name) || file.name}」`, 'ok');
          await loadSkills();
        } catch (err) {
          toast(`安装失败：${err.message}`, 'err');
        } finally {
          state.installing = false;
          rerender();
        }
      }

      async function installFromPath() {
        const input = root.querySelector('#skPath');
        const path = (input ? input.value : state.path).trim();
        state.path = path;
        if (!path) { toast('请填写服务端目录路径', 'err'); return; }
        state.installing = true;
        rerender();
        try {
          const r = await api('/api/skills/install', { method: 'POST', body: { path } });
          toast(`已安装「${(r.skill && r.skill.name) || path}」`, 'ok');
          state.path = '';
          await loadSkills();
        } catch (err) {
          toast(`安装失败：${err.message}`, 'err');
        } finally {
          state.installing = false;
          rerender();
        }
      }

      async function toggleSkill(skill) {
        const enabled = !skill.enabled;
        state.busyId = skill.id;
        rerender();
        try {
          const r = await api(`/api/skills/${encodeURIComponent(skill.id)}/enabled`, {
            method: 'POST',
            body: { enabled },
          });
          const idx = state.skills.findIndex((x) => x.id === skill.id);
          if (idx >= 0) state.skills[idx] = { ...state.skills[idx], ...(r.skill || {}), enabled };
          toast(enabled ? '已启用' : '已停用', 'ok');
        } catch (err) {
          toast(`操作失败：${err.message}`, 'err');
        } finally {
          state.busyId = '';
          rerender();
        }
      }

      async function uninstall(skill) {
        if (!window.confirm(`卸载技能「${skill.name || skill.id}」？技能目录会被删除，已分配的智能体将不再加载它。`)) return;
        try {
          await api(`/api/skills/${encodeURIComponent(skill.id)}`, { method: 'DELETE' });
          toast('已卸载', 'ok');
          await loadSkills();
        } catch (err) {
          toast(`卸载失败：${err.message}`, 'err');
        }
        rerender();
      }

      async function showInstructions(skill) {
        const mask = Core.openModal({
          title: `技能说明 · ${skill.name || skill.id}`,
          wide: true,
          body: '<div class="text-sm text-muted">加载中…</div>',
          footer: '<button class="btn btn-ghost" data-close>关闭</button>',
        });
        const bodyEl = mask.querySelector('.modal-body');
        try {
          const r = await api(`/api/skills/${encodeURIComponent(skill.id)}`);
          const files = (r.files || []).join('、');
          bodyEl.innerHTML = `
            <div class="flex items-center gap-2" style="flex-wrap:wrap;margin-bottom:10px">
              <span class="tag">v${escapeHtml((r.skill && r.skill.version) || skill.version || '0.0.0')}</span>
              <span class="text-sm text-muted">${files ? `资料文件：${escapeHtml(files)}` : '没有资料文件'}</span>
            </div>
            <div style="white-space:pre-wrap;font-size:12.5px;line-height:1.75;background:var(--surface-2);border:1px solid var(--border);border-radius:8px;padding:12px;max-height:52vh;overflow:auto">${escapeHtml((r.skill && r.skill.instructions) || r.instructions || '（这个技能没有 instructions）')}</div>`;
        } catch (err) {
          bodyEl.innerHTML = `<div class="notice warn">${icon('alert')}<div>加载失败：${escapeHtml(err.message)}</div></div>`;
          toast(`加载技能说明失败：${err.message}`, 'err');
        }
      }

      async function assign(skillId, agentId, checked) {
        const agent = agentsOf().find((a) => a.id === agentId);
        if (!agent) { toast('找不到这个智能体', 'err'); return; }
        const before = Array.isArray(agent.skills) ? agent.skills.slice() : [];
        const next = new Set(before);
        if (checked) next.add(skillId);
        else next.delete(skillId);
        agent.skills = Array.from(next);
        try {
          // 整份配置回写：后端按对象整体替换，只发一部分字段会把别的配置清掉
          await App.saveConfig();
          toast(checked ? '已分配给该智能体' : '已取消分配', 'ok');
        } catch (err) {
          agent.skills = before;
          toast(`保存分配失败：${err.message}`, 'err');
          rerender();
        }
      }

      function wire(scope) {
        scope.querySelector('[data-sk-zip]')?.addEventListener('click', () => {
          const input = scope.querySelector('#skZip');
          if (input) input.click();
        });

        const zipInput = scope.querySelector('#skZip');
        if (zipInput) {
          zipInput.addEventListener('change', () => {
            const file = zipInput.files && zipInput.files[0];
            zipInput.value = '';
            if (file) installFromZip(file);
          });
        }

        scope.querySelector('[data-sk-path]')?.addEventListener('click', installFromPath);

        const pathInput = scope.querySelector('#skPath');
        if (pathInput) {
          // 输入框内容存进 state：开关技能会重渲染整页，不存就丢了
          pathInput.addEventListener('input', () => { state.path = pathInput.value; });
          pathInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); installFromPath(); }
          });
        }

        scope.querySelectorAll('[data-sk-toggle]').forEach((el) => {
          el.addEventListener('click', () => {
            const skill = state.skills.find((x) => x.id === el.dataset.skToggle);
            if (skill) toggleSkill(skill);
          });
        });

        scope.querySelectorAll('[data-sk-view]').forEach((el) => {
          el.addEventListener('click', () => {
            const skill = state.skills.find((x) => x.id === el.dataset.skView);
            if (skill) showInstructions(skill);
          });
        });

        scope.querySelectorAll('[data-sk-del]').forEach((el) => {
          el.addEventListener('click', () => {
            const skill = state.skills.find((x) => x.id === el.dataset.skDel);
            if (skill) uninstall(skill);
          });
        });

        scope.querySelectorAll('[data-sk-assign]').forEach((el) => {
          el.addEventListener('change', () => {
            assign(el.dataset.skAssign, el.dataset.agent, el.checked);
          });
        });
      }

      async function refreshAll() {
        if (!state.skills.length) state.loading = true;
        await loadSkills();
        rerender();
      }

      document.querySelector('[data-act="sk-refresh"]')?.addEventListener('click', refreshAll);

      wire(root);
      refreshAll();
    },
  };

  Views.skills = skills;
})();
