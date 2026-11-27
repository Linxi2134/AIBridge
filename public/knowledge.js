/* 知识库页面：集合 / 文档管理 / 检索测试 */
(function () {
  'use strict';
  const { icon, escapeHtml, api, toast } = Core;
  window.Views = window.Views || {};

  // 页面状态放模块级：App.render 每次都会重建整块 DOM，挂在元素上的状态会一起丢掉
  const state = {
    loading: true,
    error: '',
    collections: [],
    stats: null,
    selectedId: '',
    docs: [],
    docsLoading: false,
    docsError: '',
    previewId: '',
    previewLoading: false,
    previewChunks: [],
    query: '',
    scopeCurrent: true,
    searching: false,
    searched: false,
    hits: [],
    uploading: false,
  };

  // views.js 里的 emptyState 没导出，这里按同样的结构补一份，样式才一致
  function empty(title, desc, iconName) {
    return `<div class="empty">${icon(iconName || 'info', 40)}<h4>${escapeHtml(title)}</h4><p>${escapeHtml(desc || '')}</p></div>`;
  }

  function fmtBytes(n) {
    const v = Number(n) || 0;
    if (v < 1024) return `${v} B`;
    if (v < 1048576) return `${(v / 1024).toFixed(1)} KB`;
    return `${(v / 1048576).toFixed(1)} MB`;
  }

  function fmtScore(n) {
    const v = Number(n);
    return Number.isFinite(v) ? v.toFixed(2) : '0.00';
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

  function currentCollection() {
    return state.collections.find((c) => c.id === state.selectedId) || null;
  }

  function collectionName(id) {
    const c = state.collections.find((x) => x.id === id);
    return c ? c.name : id;
  }

  // ---------------- 渲染 ----------------
  function collectionCard() {
    const rows = state.collections.map((c) => {
      const active = c.id === state.selectedId;
      return `<div class="list-row" data-kb-col="${escapeHtml(c.id)}"
        style="cursor:pointer;padding:10px 12px;gap:6px;${active ? 'background:var(--primary-soft)' : ''}">
        <div class="grow">
          <div class="name" style="${active ? 'color:var(--primary)' : ''}">${escapeHtml(c.name || '未命名集合')}</div>
          <div class="desc">${Number(c.docCount) || 0} 篇 · ${Number(c.chunkCount) || 0} 块 · ${fmtBytes(c.bytes)}</div>
        </div>
        <button class="btn btn-ghost btn-sm" data-kb-rename="${escapeHtml(c.id)}" title="重命名">${icon('edit', 13)}</button>
        <button class="btn btn-danger btn-sm btn-icon" data-kb-del-col="${escapeHtml(c.id)}" title="删除集合">${icon('trash', 13)}</button>
      </div>`;
    }).join('');

    let body;
    if (state.loading && !state.collections.length) {
      body = '<div class="text-sm text-muted" style="padding:12px 14px">加载中…</div>';
    } else if (!state.collections.length) {
      body = empty('还没有集合', '先建一个集合，比如「公司制度」或「产品文档」', 'book');
    } else {
      body = rows;
    }

    return `<div class="card">
      <div class="card-head">
        <h3>集合</h3>
        <span class="sub">${state.collections.length} 个</span>
        <div class="grow"></div>
        <button class="btn btn-primary btn-sm" data-kb-new-col>${icon('plus', 13)} 新建</button>
      </div>
      <div class="list">${body}</div>
    </div>`;
  }

  function docRows() {
    return state.docs.map((d) => {
      const isOpen = state.previewId === d.id;
      const row = `<div class="list-row" style="align-items:flex-start">
        <div class="grow">
          <div class="name" style="line-height:1.5">${escapeHtml(d.title || '未命名文档')}</div>
          <div class="desc" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
            <span>${fmtBytes(d.size)}</span>
            <span>${Number(d.chunks) || 0} 块</span>
            <span title="${escapeHtml(d.source || '')}">来源 ${escapeHtml(d.source || '粘贴文本')}</span>
          </div>
        </div>
        <button class="btn btn-ghost btn-sm" data-kb-prev="${escapeHtml(d.id)}">${icon('eye', 13)} ${isOpen ? '收起' : '预览'}</button>
        <button class="btn btn-danger btn-sm btn-icon" data-kb-del-doc="${escapeHtml(d.id)}" title="删除文档">${icon('trash', 13)}</button>
      </div>`;
      if (!isOpen) return row;

      let inner;
      if (state.previewLoading) {
        inner = '<div class="text-sm text-muted" style="padding:6px 0">加载预览…</div>';
      } else if (!state.previewChunks.length) {
        inner = '<div class="text-sm text-muted" style="padding:6px 0">没有可预览的块</div>';
      } else {
        inner = state.previewChunks.map((chunk, i) => {
          const text = typeof chunk === 'string' ? chunk : (chunk && chunk.text) || '';
          return `<div style="margin-top:8px;padding:9px 11px;background:var(--surface);border:1px solid var(--border);border-radius:8px;font-size:12.5px;line-height:1.7;white-space:pre-wrap;max-height:150px;overflow:auto">
            <div class="text-sm text-muted" style="margin-bottom:4px">块 ${i + 1}</div>${escapeHtml(text)}</div>`;
        }).join('');
      }
      return row + `<div style="padding:0 18px 14px 18px;background:var(--surface-2);border-bottom:1px solid var(--border)">${inner}</div>`;
    }).join('');
  }

  function docsCard() {
    const col = currentCollection();
    const disabled = !col || state.uploading;
    const headActions = col
      ? `<button class="btn btn-primary btn-sm" data-kb-upload ${disabled ? 'disabled' : ''}>
           ${icon('plus', 13)} ${state.uploading ? '上传中…' : '上传文件'}
         </button>
         <button class="btn btn-ghost btn-sm" data-kb-paste ${disabled ? 'disabled' : ''}>${icon('edit', 13)} 粘贴文本</button>`
      : '';

    let body;
    if (!col) {
      body = empty('先选择一个集合', '左侧新建或点选集合后，就能上传文档和粘贴文本', 'book');
    } else if (state.docsLoading) {
      body = '<div class="text-sm text-muted" style="padding:14px 18px">加载文档中…</div>';
    } else if (state.docsError) {
      body = `<div class="notice warn" style="margin:14px 18px">${icon('alert')}
        <div>加载文档失败：${escapeHtml(state.docsError)}</div></div>`;
    } else if (!state.docs.length) {
      body = empty('这个集合还没有文档', '上传 txt / md / docx / xlsx，或直接粘贴文本', 'download');
    } else {
      body = docRows();
    }

    return `<div class="card">
      <div class="card-head">
        <h3>${col ? escapeHtml(col.name) : '文档'}</h3>
        <span class="sub">${col ? `${state.docs.length} 篇文档` : '未选择集合'}</span>
        <div class="grow"></div>
        ${headActions}
      </div>
      <div class="list">${body}</div>
      ${col ? `<div class="card-body" style="padding-top:12px;border-top:1px solid var(--border)">
        <div class="text-sm text-muted">支持 txt / md / json / csv / html / docx / xlsx；pdf、doc、xls 需要服务端装有 pdftotext 或 LibreOffice 转换器。</div>
      </div>` : ''}
    </div>`;
  }

  function searchCard() {
    const col = currentCollection();
    let results;
    if (state.searching) {
      results = '<div class="text-sm text-muted" style="margin-top:12px">检索中…</div>';
    } else if (state.searchError) {
      results = `<div class="notice warn" style="margin-top:12px">${icon('alert')}<div>检索失败：${escapeHtml(state.searchError)}</div></div>`;
    } else if (!state.searched) {
      results = '<div class="text-sm text-muted" style="margin-top:12px">输入一句话，看看 AI 回答前会召回哪些块。空查询不返回结果。</div>';
    } else if (!state.hits.length) {
      results = `<div class="empty">${icon('eye', 40)}<h4>没有命中任何块</h4><p>换个关键词，或确认选中的集合里有文档</p></div>`;
    } else {
      results = state.hits.map((h) => `
        <div style="border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-top:10px">
          <div class="flex items-center gap-2" style="flex-wrap:wrap;margin-bottom:6px">
            <span class="tag info">${escapeHtml(h.title || '未命名文档')}</span>
            <span class="tag">块 #${Number(h.chunkIndex) || 0}</span>
            <span class="tag warn">分数 ${fmtScore(h.score)}</span>
            <span class="text-sm text-muted">${escapeHtml(collectionName(h.collectionId))}</span>
          </div>
          <div style="white-space:pre-wrap;font-size:12.5px;line-height:1.7;color:var(--text-2);max-height:180px;overflow:auto">${escapeHtml(h.text || '')}</div>
        </div>`).join('');
    }

    return `<div class="card">
      <div class="card-head">
        <h3>检索测试</h3>
        <span class="sub">实际注入前召回的就是这些块</span>
      </div>
      <div class="card-body">
        <div class="flex items-center gap-2" style="flex-wrap:wrap">
          <input class="input" id="kbSearch" style="flex:1;min-width:180px"
            placeholder="输入一句话，例如：年假有几天" value="${escapeHtml(state.query)}">
          <label class="flex items-center gap-2 text-sm text-muted" style="cursor:pointer${col ? '' : ';opacity:.55'}">
            <input type="checkbox" id="kbScope" ${state.scopeCurrent && col ? 'checked' : ''} ${col ? '' : 'disabled'}> 仅当前集合
          </label>
          <button class="btn btn-primary btn-sm" data-kb-search ${state.searching ? 'disabled' : ''}>
            ${icon('zap', 13)} 检索
          </button>
        </div>
        ${results}
      </div>
    </div>`;
  }

  function shell() {
    const s = state.stats || { collections: 0, docs: 0, chunks: 0, bytes: 0 };
    return `
      <div class="text-sm text-muted" style="margin-bottom:10px">
        全库 ${Number(s.collections) || 0} 个集合 · ${Number(s.docs) || 0} 篇文档 · ${Number(s.chunks) || 0} 个块 · ${fmtBytes(s.bytes)}
        ${state.error ? ` · <span style="color:var(--danger)">${escapeHtml(state.error)}</span>` : ''}
      </div>
      <div style="display:grid;grid-template-columns:236px minmax(0,1fr);gap:14px;align-items:start">
        ${collectionCard()}
        <div style="display:flex;flex-direction:column;gap:14px;min-width:0">
          ${docsCard()}
          ${searchCard()}
        </div>
      </div>
      <input type="file" id="kbFile" hidden
        accept=".txt,.md,.markdown,.json,.csv,.html,.htm,.docx,.xlsx,.pdf,.doc,.xls">`;
  }

  // ---------------- 视图 ----------------
  const knowledge = {
    title: '知识库',
    desc: '上传资料，让 AI 回答时引用你自己的文档',
    actions() {
      return `<button class="btn btn-ghost btn-sm" data-act="kb-refresh">${icon('refresh', 14)} 刷新</button>`;
    },
    render() {
      return shell();
    },
    mount(root) {
      // 异步回来时用户可能已经切页，别把旧页面画到别的路由上
      const alive = () => App.state.route === 'knowledge';
      const rerender = () => {
        if (!alive()) return;
        root.innerHTML = shell();
        wire(root);
      };

      async function loadDocs() {
        const id = state.selectedId;
        state.previewId = '';
        state.previewChunks = [];
        if (!id) {
          state.docs = [];
          state.docsError = '';
          state.docsLoading = false;
          return;
        }
        state.docsLoading = true;
        try {
          const r = await api(`/api/kb/collections/${encodeURIComponent(id)}/docs`);
          state.docs = r.docs || [];
          state.docsError = '';
        } catch (err) {
          state.docs = [];
          state.docsError = err.message;
          toast(`加载文档失败：${err.message}`, 'err');
        } finally {
          state.docsLoading = false;
        }
      }

      async function loadCollections() {
        try {
          const r = await api('/api/kb/collections');
          state.collections = r.collections || [];
          state.error = '';
          const stats = await api('/api/kb/stats').catch(() => null);
          if (stats) state.stats = stats;
          // 选中的集合可能已经被删掉：退回到第一个，避免右侧一直空着
          if (!state.collections.some((c) => c.id === state.selectedId)) {
            state.selectedId = state.collections[0]?.id || '';
          }
          return true;
        } catch (err) {
          state.error = err.message;
          toast(`加载知识库失败：${err.message}`, 'err');
          return false;
        }
      }

      async function refreshAll() {
        if (!state.collections.length) state.loading = true;
        await loadCollections();
        state.loading = false;
        await loadDocs();
        rerender();
      }

      async function selectCollection(id) {
        if (state.selectedId === id) return;
        state.selectedId = id;
        state.hits = [];
        state.searched = false;
        state.searchError = '';
        rerender();
        await loadDocs();
        rerender();
      }

      function openCollectionModal(col) {
        const isNew = !col;
        const c = col || { name: '', description: '' };
        const mask = Core.openModal({
          title: isNew ? '新建集合' : '重命名集合',
          body: `
            <div class="field">
              <label>名称</label>
              <input class="input" id="kbColName" value="${escapeHtml(c.name || '')}" placeholder="例如：公司制度">
            </div>
            <div class="field">
              <label>描述</label>
              <input class="input" id="kbColDesc" value="${escapeHtml(c.description || '')}" placeholder="可选，说明这个集合放什么">
              <div class="desc">一个集合就是一组主题相同的文档，智能体可以只挂其中几个。</div>
            </div>`,
          footer: `<button class="btn btn-ghost" data-close>取消</button>
                   <button class="btn btn-primary" data-ok>保存</button>`,
        });
        mask.querySelector('#kbColName')?.focus();

        mask.querySelector('[data-ok]').addEventListener('click', async () => {
          const name = mask.querySelector('#kbColName').value.trim();
          const description = mask.querySelector('#kbColDesc').value.trim();
          if (!name) { toast('请填写集合名称', 'err'); return; }
          try {
            if (isNew) {
              const r = await api('/api/kb/collections', { method: 'POST', body: { name, description } });
              if (r.collection?.id) {
                state.selectedId = r.collection.id;
                state.docs = [];
              }
              toast('集合已创建', 'ok');
            } else {
              await api(`/api/kb/collections/${encodeURIComponent(c.id)}`, { method: 'PATCH', body: { name, description } });
              toast('已保存', 'ok');
            }
            Core.closeModal(mask);
            await loadCollections();
            await loadDocs();
            rerender();
          } catch (err) {
            toast(`保存失败：${err.message}`, 'err');
          }
        });
      }

      async function removeCollection(col) {
        if (!window.confirm(`删除集合「${col.name}」？其中的 ${Number(col.docCount) || 0} 篇文档会一并删除，不可恢复。`)) return;
        try {
          await api(`/api/kb/collections/${encodeURIComponent(col.id)}`, { method: 'DELETE' });
          toast('集合已删除', 'ok');
          if (state.selectedId === col.id) state.selectedId = '';
          await loadCollections();
          await loadDocs();
          rerender();
        } catch (err) {
          toast(`删除失败：${err.message}`, 'err');
        }
      }

      async function uploadFile(file) {
        if (!file) return;
        const col = currentCollection();
        if (!col) { toast('请先选择一个集合', 'err'); return; }
        // 服务端请求体上限 25MB，base64 会膨胀 4/3，18MB 是能安全通过的上限
        if (file.size > 18 * 1048576) {
          toast('文件过大（前端上限 18MB）', 'err');
          return;
        }
        state.uploading = true;
        rerender();
        try {
          const dataBase64 = await readBase64(file);
          await api(`/api/kb/collections/${encodeURIComponent(col.id)}/docs`, {
            method: 'POST',
            body: {
              title: file.name.replace(/\.[^.]+$/, ''),
              filename: file.name,
              mime: file.type || '',
              dataBase64,
            },
          });
          toast(`已导入「${file.name}」`, 'ok');
          await loadCollections();
          await loadDocs();
        } catch (err) {
          toast(`导入失败：${err.message}`, 'err');
        } finally {
          state.uploading = false;
          rerender();
        }
      }

      function openPasteModal() {
        const col = currentCollection();
        if (!col) { toast('请先选择一个集合', 'err'); return; }
        const mask = Core.openModal({
          title: `粘贴文本到「${col.name}」`,
          wide: true,
          body: `
            <div class="field">
              <label>标题</label>
              <input class="input" id="kbPasteTitle" placeholder="例如：产品需求说明">
            </div>
            <div class="field">
              <label>内容</label>
              <textarea class="textarea" id="kbPasteText" rows="10" placeholder="粘贴纯文本或 Markdown"></textarea>
              <div class="desc">按段落切块，约 400~700 字一块，检索命中后作为上下文注入。</div>
            </div>`,
          footer: `<button class="btn btn-ghost" data-close>取消</button>
                   <button class="btn btn-primary" data-ok>保存</button>`,
        });
        mask.querySelector('#kbPasteTitle')?.focus();

        mask.querySelector('[data-ok]').addEventListener('click', async () => {
          const title = mask.querySelector('#kbPasteTitle').value.trim();
          const text = mask.querySelector('#kbPasteText').value;
          if (!title) { toast('请填写标题', 'err'); return; }
          if (!text.trim()) { toast('内容不能为空', 'err'); return; }
          try {
            await api(`/api/kb/collections/${encodeURIComponent(col.id)}/docs`, {
              method: 'POST',
              body: { title, filename: `${title}.txt`, mime: 'text/plain', text },
            });
            Core.closeModal(mask);
            toast('已保存', 'ok');
            await loadCollections();
            await loadDocs();
            rerender();
          } catch (err) {
            toast(`保存失败：${err.message}`, 'err');
          }
        });
      }

      async function removeDoc(doc) {
        if (!window.confirm(`删除文档「${doc.title}」？这份文档的所有块都会被移除。`)) return;
        try {
          await api(`/api/kb/docs/${encodeURIComponent(doc.id)}`, { method: 'DELETE' });
          toast('文档已删除', 'ok');
          if (state.previewId === doc.id) { state.previewId = ''; state.previewChunks = []; }
          await loadCollections();
          await loadDocs();
          rerender();
        } catch (err) {
          toast(`删除失败：${err.message}`, 'err');
        }
      }

      async function togglePreview(doc) {
        if (state.previewId === doc.id) {
          state.previewId = '';
          state.previewChunks = [];
          rerender();
          return;
        }
        state.previewId = doc.id;
        state.previewChunks = [];
        state.previewLoading = true;
        rerender();
        try {
          const r = await api(`/api/kb/docs/${encodeURIComponent(doc.id)}`);
          state.previewChunks = (r.preview || []).slice(0, 3);
        } catch (err) {
          state.previewChunks = [];
          toast(`加载预览失败：${err.message}`, 'err');
        } finally {
          state.previewLoading = false;
          if (state.previewId === doc.id) rerender();
        }
      }

      async function runSearch() {
        const input = root.querySelector('#kbSearch');
        const q = (input ? input.value : state.query).trim();
        state.query = input ? input.value : state.query;
        if (!q) { toast('请输入检索内容', 'err'); return; }
        const scopeBox = root.querySelector('#kbScope');
        state.scopeCurrent = scopeBox ? scopeBox.checked : state.scopeCurrent;

        const params = new URLSearchParams();
        params.set('q', q);
        if (state.scopeCurrent && state.selectedId) params.set('collections', state.selectedId);
        params.set('k', '8');

        state.searching = true;
        state.searchError = '';
        rerender();
        try {
          const r = await api(`/api/kb/search?${params.toString()}`);
          state.hits = r.hits || [];
          state.searched = true;
        } catch (err) {
          state.hits = [];
          state.searched = true;
          state.searchError = err.message;
          toast(`检索失败：${err.message}`, 'err');
        } finally {
          state.searching = false;
          rerender();
        }
      }

      function wire(scope) {
        scope.querySelector('[data-kb-new-col]')?.addEventListener('click', () => openCollectionModal(null));

        scope.querySelectorAll('[data-kb-col]').forEach((el) => {
          el.addEventListener('click', () => selectCollection(el.dataset.kbCol));
        });

        scope.querySelectorAll('[data-kb-rename]').forEach((el) => {
          el.addEventListener('click', (e) => {
            // 行本身是「选中集合」，点按钮不该顺带切集合
            e.stopPropagation();
            const c = state.collections.find((x) => x.id === el.dataset.kbRename);
            if (c) openCollectionModal(c);
          });
        });

        scope.querySelectorAll('[data-kb-del-col]').forEach((el) => {
          el.addEventListener('click', (e) => {
            e.stopPropagation();
            const c = state.collections.find((x) => x.id === el.dataset.kbDelCol);
            if (c) removeCollection(c);
          });
        });

        scope.querySelector('[data-kb-upload]')?.addEventListener('click', () => {
          const input = scope.querySelector('#kbFile');
          if (input) input.click();
        });

        const fileInput = scope.querySelector('#kbFile');
        if (fileInput) {
          fileInput.addEventListener('change', () => {
            const file = fileInput.files && fileInput.files[0];
            fileInput.value = '';
            if (file) uploadFile(file);
          });
        }

        scope.querySelector('[data-kb-paste]')?.addEventListener('click', openPasteModal);

        scope.querySelectorAll('[data-kb-prev]').forEach((el) => {
          el.addEventListener('click', () => {
            const doc = state.docs.find((x) => x.id === el.dataset.kbPrev);
            if (doc) togglePreview(doc);
          });
        });

        scope.querySelectorAll('[data-kb-del-doc]').forEach((el) => {
          el.addEventListener('click', () => {
            const doc = state.docs.find((x) => x.id === el.dataset.kbDelDoc);
            if (doc) removeDoc(doc);
          });
        });

        scope.querySelector('[data-kb-search]')?.addEventListener('click', runSearch);

        const searchInput = scope.querySelector('#kbSearch');
        if (searchInput) {
          searchInput.addEventListener('input', () => { state.query = searchInput.value; });
          searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); runSearch(); }
          });
        }

        const scopeBox = scope.querySelector('#kbScope');
        if (scopeBox) {
          scopeBox.addEventListener('change', () => { state.scopeCurrent = scopeBox.checked; });
        }
      }

      document.querySelector('[data-act="kb-refresh"]')?.addEventListener('click', refreshAll);

      wire(root);
      refreshAll();
    },
  };

  Views.knowledge = knowledge;
})();
