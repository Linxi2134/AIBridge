'use strict';
/**
 * Agent 可调用的内置工具。
 * 每个工具包含：OpenAI tools 定义 + 执行函数。
 */
const store = require('./store');
const logs = require('./logs');

/**
 * 是否是本机 / 内网地址。
 * http_request 是「给模型用的公网取数工具」，不是内网扫描器；
 * 而且模型的输入里可能混进别人塞的 URL（提示注入），闭着眼访问会把
 * 网关自己、路由器、NAS 的管理接口暴露给外部。
 * 说明：这里只做字面判断，不做 DNS 解析，域名的 DNS 重绑定不在防护范围内。
 */
function isPrivateHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h === '::1' || h === '::') return true;                 // IPv6 回环
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;              // IPv6 ULA
  if (h.startsWith('fe80:')) return true;                     // IPv6 链路本地
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;                    // 链路本地 / 云元数据
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;          // CGNAT
  return false;
}

// ---------------- 安全表达式求值 ----------------
const CONSTANTS = { pi: Math.PI, e: Math.E, tau: Math.PI * 2 };
const FUNCS = {
  abs: Math.abs, sqrt: Math.sqrt, cbrt: Math.cbrt,
  sin: Math.sin, cos: Math.cos, tan: Math.tan,
  asin: Math.asin, acos: Math.acos, atan: Math.atan,
  log: Math.log, log2: Math.log2, log10: Math.log10, exp: Math.exp,
  floor: Math.floor, ceil: Math.ceil, round: Math.round, trunc: Math.trunc,
  sign: Math.sign,
  min: Math.min, max: Math.max, pow: Math.pow,
  hypot: Math.hypot,
};

function tokenize(input) {
  const tokens = [];
  const src = String(input);
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i += 1; continue; }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      let j = i;
      while (j < src.length && /[0-9._]/.test(src[j])) j += 1;
      const raw = src.slice(i, j).replace(/_/g, '');
      const num = Number(raw);
      if (!Number.isFinite(num)) throw new Error(`非法数字: ${raw}`);
      tokens.push({ t: 'num', v: num });
      i = j;
      continue;
    }
    if (/[a-zA-Z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[a-zA-Z0-9_]/.test(src[j])) j += 1;
      tokens.push({ t: 'id', v: src.slice(i, j) });
      i = j;
      continue;
    }
    if ('+-*/%^(),'.includes(ch)) {
      tokens.push({ t: 'op', v: ch });
      i += 1;
      continue;
    }
    throw new Error(`表达式含非法字符: ${ch}`);
  }
  return tokens;
}

function evaluate(expr) {
  const tokens = tokenize(expr);
  let pos = 0;

  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const expect = (v) => {
    const tk = next();
    if (!tk || tk.v !== v) throw new Error(`期望 "${v}"`);
    return tk;
  };

  function parseExpr() { return parseAdditive(); }

  function parseAdditive() {
    let left = parseMultiplicative();
    while (peek() && (peek().v === '+' || peek().v === '-')) {
      const op = next().v;
      const right = parseMultiplicative();
      left = op === '+' ? left + right : left - right;
    }
    return left;
  }

  function parseMultiplicative() {
    let left = parseUnary();
    while (peek() && ['*', '/', '%'].includes(peek().v)) {
      const op = next().v;
      const right = parseUnary();
      if ((op === '/' || op === '%') && right === 0) throw new Error('除数不能为 0');
      left = op === '*' ? left * right : op === '/' ? left / right : left % right;
    }
    return left;
  }

  function parseUnary() {
    if (peek() && (peek().v === '-' || peek().v === '+')) {
      const op = next().v;
      const val = parseUnary();
      return op === '-' ? -val : val;
    }
    return parsePower();
  }

  function parsePower() {
    const base = parseAtom();
    if (peek() && peek().v === '^') {
      next();
      const exp = parseUnary(); // 右结合
      return Math.pow(base, exp);
    }
    return base;
  }

  function parseAtom() {
    const tk = next();
    if (!tk) throw new Error('表达式不完整');
    if (tk.t === 'num') return tk.v;
    if (tk.t === 'op' && tk.v === '(') {
      const val = parseExpr();
      expect(')');
      return val;
    }
    if (tk.t === 'id') {
      const name = tk.v.toLowerCase();
      if (peek() && peek().v === '(') {
        next();
        const args = [];
        if (peek() && peek().v !== ')') {
          args.push(parseExpr());
          while (peek() && peek().v === ',') { next(); args.push(parseExpr()); }
        }
        expect(')');
        const fn = FUNCS[name];
        if (!fn) throw new Error(`未知函数: ${tk.v}`);
        return fn(...args);
      }
      if (name in CONSTANTS) return CONSTANTS[name];
      throw new Error(`未知标识符: ${tk.v}`);
    }
    throw new Error(`无法解析的记号: ${tk.v}`);
  }

  const result = parseExpr();
  if (pos !== tokens.length) throw new Error('表达式存在多余内容');
  if (!Number.isFinite(result)) throw new Error('计算结果无效');
  return result;
}

// ---------------- 工具定义 ----------------
const TOOL_DEFS = {
  get_time: {
    definition: {
      type: 'function',
      function: {
        name: 'get_time',
        description: '获取当前的日期、时间和星期。当用户询问"现在几点""今天几号"等时间相关问题时使用。',
        parameters: {
          type: 'object',
          properties: {
            timezone: {
              type: 'string',
              description: 'IANA 时区名，例如 Asia/Shanghai。默认使用服务器本地时区。',
            },
          },
        },
      },
    },
    async run(args) {
      // 默认跟服务器本地时区走：文档写的就是「默认使用服务器本地时区」，
      // 以前硬编码 Asia/Shanghai，部署在欧洲/美洲的机器上会答错日期。
      const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      const wanted = String(args?.timezone || '').trim();
      const format = (zone) => new Intl.DateTimeFormat('zh-CN', {
        timeZone: zone,
        dateStyle: 'full',
        timeStyle: 'medium',
        weekday: 'long',
      }).format(new Date());

      let used = wanted || localTz;
      let formatted = '';
      try {
        formatted = format(used);
      } catch (_) {
        // 模型常编出不存在的时区名。以前吞掉异常后仍把编出来的名字回填，
        // 导致 datetime 与 timezone 两个字段互相矛盾，模型据此推算就会错。
        used = localTz;
        try { formatted = format(used); } catch (_2) { formatted = new Date().toLocaleString('zh-CN'); }
      }
      return {
        datetime: formatted,
        iso: new Date().toISOString(),
        timestamp: Date.now(),
        timezone: used,
        requestedTimezone: wanted && wanted !== used ? wanted : undefined,
      };
    },
  },

  calc: {
    definition: {
      type: 'function',
      function: {
        name: 'calc',
        description:
          '计算数学表达式。支持 + - * / % ^、括号、常量 pi/e，以及 sqrt、abs、sin、cos、log、min、max、pow 等函数。',
        parameters: {
          type: 'object',
          properties: {
            expression: { type: 'string', description: '要求值的数学表达式，例如 (12+8)*3/7' },
          },
          required: ['expression'],
        },
      },
    },
    async run(args) {
      const expr = String(args?.expression || '').trim();
      if (!expr) throw new Error('缺少 expression 参数');
      if (expr.length > 500) throw new Error('表达式过长');
      const value = evaluate(expr);
      return { expression: expr, result: value };
    },
  },

  http_request: {
    definition: {
      type: 'function',
      function: {
        name: 'http_request',
        description:
          '发起一次 HTTP 请求以获取外部数据（如公开 API、天气、汇率等）。仅支持 http/https，默认超时 15 秒。',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: '完整的请求地址' },
            method: { type: 'string', enum: ['GET', 'POST'], description: '请求方法，默认 GET' },
            headers: { type: 'object', description: '可选的请求头对象' },
            body: { type: 'string', description: 'POST 时的请求体（字符串）' },
          },
          required: ['url'],
        },
      },
    },
    async run(args) {
      const url = String(args?.url || '');
      if (!/^https?:\/\//i.test(url)) throw new Error('仅支持 http/https 地址');

      // 不让模型把本机/内网当成「公开 API」来探测：
      // 网关本身、路由器管理页、NAS 都在这张网里，而模型的输入来自不可信的外部内容。
      let host = '';
      try { host = new URL(url).hostname; } catch (_) { throw new Error('URL 格式不合法'); }
      if (isPrivateHost(host)) throw new Error('不允许访问本机或内网地址');

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      try {
        const res = await fetch(url, {
          method: (args?.method || 'GET').toUpperCase(),
          headers: args?.headers && typeof args.headers === 'object' ? args.headers : {},
          body: args?.body ? String(args.body) : undefined,
          signal: controller.signal,
        });
        // 只读前 256KB：以前是 res.text() 整包读进内存再截断，
        // 模型随手请求一个几十 MB 的文件就能把进程内存顶上去。
        const CAP = 256 * 1024;
        const chunks = [];
        let size = 0;
        if (res.body) {
          const reader = res.body.getReader();
          while (size < CAP) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(Buffer.from(value));
            size += value.length;
          }
          try { await reader.cancel(); } catch (_) { /* 已结束 */ }
        }
        const text = Buffer.concat(chunks).toString('utf8');
        return {
          status: res.status,
          contentType: res.headers.get('content-type') || '',
          body: text.slice(0, 4000),
          truncated: size >= CAP || text.length > 4000,
          bytesRead: size,
        };
      } finally {
        clearTimeout(timer);
      }
    },
  },

  web_search: {    definition: {
      type: 'function',
      function: {
        name: 'web_search',
        description: '联网搜索最新信息。当问题涉及实时新闻、当前价格、近期事件等需要外部信息时使用。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '搜索关键词' },
          },
          required: ['query'],
        },
      },
    },
    async run(args) {
      const cfg = store.getConfig().search || {};
      const query = String(args?.query || '').trim();
      if (!query) throw new Error('缺少 query 参数');
      if (!cfg.apiKey || cfg.provider === 'none') {
        return {
          available: false,
          note: '联网搜索未配置。请在「设置 → 联网搜索」中填入搜索服务 API Key 后重试，或直接基于已有知识回答。',
        };
      }
      try {
        if (cfg.provider === 'tavily') {
          const res = await fetch('https://api.tavily.com/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ api_key: cfg.apiKey, query, max_results: 5, search_depth: 'basic' }),
            // 搜索服务偶尔会挂住不回；没有超时的话整轮对话就卡在这里
            signal: AbortSignal.timeout(15000),
          });
          if (!res.ok) {
            // 以前不看状态码：401/429 的错误 JSON 里没有 results，
            // 就会被当成「搜索成功，0 条结果」喂给模型
            throw new Error(`搜索服务返回 HTTP ${res.status}`);
          }
          const json = await res.json();
          return {
            available: true,
            results: (json.results || []).map((r) => ({
              title: r.title, url: r.url, snippet: String(r.content || '').slice(0, 400),
            })),
          };
        }
        if (cfg.provider === 'serper') {
          const res = await fetch('https://google.serper.dev/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-KEY': cfg.apiKey },
            body: JSON.stringify({ q: query, num: 5 }),
            signal: AbortSignal.timeout(15000),
          });
          if (!res.ok) throw new Error(`搜索服务返回 HTTP ${res.status}`);
          const json = await res.json();
          return {
            available: true,
            results: (json.organic || []).slice(0, 5).map((r) => ({
              title: r.title, url: r.link, snippet: String(r.snippet || '').slice(0, 400),
            })),
          };
        }
        return { available: false, note: `不支持的搜索服务: ${cfg.provider}` };
      } catch (err) {
        logs.warn('tools', `web_search 失败: ${err.message}`);
        return { available: false, error: err.message };
      }
    },
  },

  remember: {
    definition: {
      type: 'function',
      function: {
        name: 'remember',
        description:
          '把值得长期记住的信息存入记忆库。当用户告知自己的身份、职业、偏好、重要约定，或出现需要跨对话保留的事实时调用。'
          + '不要记录一次性的寒暄、临时问题或你自己的解释。',
        parameters: {
          type: 'object',
          properties: {
            content: {
              type: 'string',
              description: '要记住的内容，一句话，第三人称陈述，不超过 40 字。例如「用户叫李雷，是一名后端工程师」',
            },
            scope: {
              type: 'string',
              enum: ['user', 'global'],
              description:
                'user = 只跟当前这位用户相关的私人信息；global = 客观事实、公共信息，或你自己的人设设定（任何会话都适用）',
            },
            importance: {
              type: 'number',
              description: '重要度 0.1~1.0。身份、长期偏好取 0.8；一般事实取 0.5',
            },
          },
          required: ['content'],
        },
      },
    },
    async run(args, ctx) {
      const memory = require('./memory');
      const content = String(args?.content || '').trim();
      if (!content) throw new Error('缺少 content 参数');
      if (content.length > 200) throw new Error('内容过长，请压缩到 200 字以内');

      const scope = args?.scope === 'global'
        ? 'global'
        : memory.userScope(ctx?.channel, ctx?.userId);

      const fact = memory.remember({
        scope,
        content,
        importance: args?.importance,
        source: `${ctx?.channel || 'web'}:${ctx?.userId || ''}`,
      });
      logs.info('memory', `已记住: ${content.slice(0, 40)}`, { scope });
      return { ok: true, saved: fact?.content, scope };
    },
  },

  recall: {
    definition: {
      type: 'function',
      function: {
        name: 'recall',
        description:
          '检索长期记忆。当你不确定之前是否和用户聊过某个话题、或需要确认某个细节时调用。'
          + '系统已自动注入相关记忆，仅在信息不足时补充检索。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '检索关键词或问题' },
          },
          required: ['query'],
        },
      },
    },
    async run(args, ctx) {
      const memory = require('./memory');
      const query = String(args?.query || '').trim();
      if (!query) throw new Error('缺少 query 参数');

      const scopes = ['global', `user:${ctx?.channel || 'web'}:${ctx?.userId || 'anonymous'}`];
      if (ctx?.agentId) scopes.push(`agent:${ctx.agentId}`);

      const facts = memory.recall({ text: query, scopes, limit: 8 });
      return {
        found: facts.length,
        memories: facts.map((f) => f.content),
        note: facts.length ? undefined : '记忆库中没有找到相关内容',
      };
    },
  },

  send_message: {
    definition: {
      type: 'function',
      function: {
        name: 'send_message',
        description:
          '主动给指定对象发送消息（QQ / 微信公众号 / 企业微信）。用于主动联系某人、通知某事、或在群里发言。'
          + '注意：当前会话的回复会自动送达，本工具只用于联系「其他」人或群。',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: '消息内容，不超过 1500 字' },
            channel: {
              type: 'string',
              enum: ['onebot', 'wechat', 'wecom'],
              description: '目标渠道。onebot=QQ，wechat=公众号，wecom=企业微信',
            },
            target_type: {
              type: 'string',
              enum: ['private', 'group'],
              description: 'private=私聊，group=群聊（仅 QQ 支持）',
            },
            target_id: {
              type: 'string',
              description: '接收方 ID：QQ 号 / 群号 / 公众号 openid / 企微 userid',
            },
            at_user: {
              type: 'string',
              description: '群聊时顺便 @ 的 QQ 号，可省略',
            },
          },
          required: ['text', 'channel', 'target_id'],
        },
      },
    },
    async run(args, ctx) {
      const bridge = require('./channels/bridge');
      const text = String(args?.text || '').trim();
      const channel = String(args?.channel || '').trim();
      const targetId = String(args?.target_id || '').trim();

      if (!text) throw new Error('缺少 text 参数');
      if (!channel) throw new Error('缺少 channel 参数');
      if (!targetId) throw new Error('缺少 target_id 参数');

      // 防止对当前会话重复发送（当前会话的回复由渠道适配器自动送达）
      if (ctx?.replyTarget
        && channel === ctx.channel
        && String(targetId) === String(ctx.replyTarget.id)) {
        return {
          skipped: true,
          note: '目标就是当前会话，你的回复会自动发送，无需重复调用',
        };
      }

      return bridge.send({
        channel,
        targetType: args?.target_type === 'group' ? 'group' : 'private',
        targetId,
        text,
        atUserId: args?.at_user ? String(args.at_user) : undefined,
      });
    },
  },

  list_contacts: {
    definition: {
      type: 'function',
      function: {
        name: 'list_contacts',
        description:
          '查看 QQ 好友列表或群列表，用于找到要主动联系的对象。仅 OneBot 11 渠道可用。'
          + '当用户说「告诉小王」「在某个群说一下」但你不知道对方 QQ 号时，先调用本工具查找。',
        parameters: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: ['friends', 'groups'],
              description: 'friends=好友列表，groups=群列表',
            },
          },
          required: ['type'],
        },
      },
    },
    async run(args) {
      const bridge = require('./channels/bridge');
      const type = args?.type === 'groups' ? 'groups' : 'friends';
      return bridge.listContacts('onebot', type);
    },
  },

  get_group_members: {
    definition: {
      type: 'function',
      function: {
        name: 'get_group_members',
        description: '查看某个 QQ 群的成员列表（昵称、QQ 号、身份）。仅 OneBot 11 渠道可用。',
        parameters: {
          type: 'object',
          properties: {
            group_id: { type: 'string', description: '群号' },
          },
          required: ['group_id'],
        },
      },
    },
    async run(args) {
      const bridge = require('./channels/bridge');
      const groupId = String(args?.group_id || '').trim();
      if (!groupId) throw new Error('缺少 group_id 参数');
      return bridge.listGroupMembers(groupId);
    },
  },

  list_sessions: {
    definition: {
      type: 'function',
      function: {
        name: 'list_sessions',
        description:
          '查看最近的对话记录，了解最近有哪些人找过你、最后聊了什么。'
          + '用于主动跟进、回顾上下文，或确认某个人的身份。',
        parameters: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: '返回条数，默认 10，最多 30' },
          },
        },
      },
    },
    async run(args) {
      const cfgStore = require('./store');
      const limit = Math.min(30, Math.max(1, Number(args?.limit) || 10));
      const sessions = cfgStore.listSessions().slice(0, limit);

      const items = sessions.map((s) => {
        const full = cfgStore.getSession(s.id);
        const last = full?.messages?.slice(-1)[0];
        return {
          channel: s.channel,
          user: s.userId,
          title: s.title || '',
          messageCount: s.messageCount,
          lastMessage: last ? String(last.content || '').slice(0, 80) : '',
          lastRole: last?.role || '',
          updatedAt: new Date(s.updatedAt).toISOString(),
        };
      });

      return { count: items.length, sessions: items };
    },
  },
  delete_friend: {
    definition: {
      type: 'function',
      function: {
        name: 'delete_friend',
        description:
          '删除一位 QQ 好友。这是不可恢复的危险操作，仅在用户明确要求删除某个好友时调用。'
          + '如果用户只说「删掉那个人」但没说清楚是谁，先用 list_contacts 确认身份。',
        parameters: {
          type: 'object',
          properties: {
            user_id: { type: 'string', description: '要删除的好友 QQ 号' },
          },
          required: ['user_id'],
        },
      },
    },
    async run(args) {
      const bridge = require('./channels/bridge');
      const userId = String(args?.user_id || '').trim();
      if (!userId) throw new Error('缺少 user_id 参数');
      return bridge.deleteFriend(userId);
    },
  },

  like_friend: {
    definition: {
      type: 'function',
      function: {
        name: 'like_friend',
        description: '给一位 QQ 好友的名片点赞。QQ 限制：同一个好友每天只能点 1 次，每天总共最多 10 次。',
        parameters: {
          type: 'object',
          properties: {
            user_id: { type: 'string', description: '好友 QQ 号' },
          },
          required: ['user_id'],
        },
      },
    },
    async run(args) {
      const bridge = require('./channels/bridge');
      const userId = String(args?.user_id || '').trim();
      if (!userId) throw new Error('缺少 user_id 参数');
      return bridge.likeUser(userId);
    },
  },

  // ---------------- 电脑操控 ----------------
  // 这组工具能真的动用户的鼠标键盘，所以每一个进来先查总开关。

  game_control: {
    definition: {
      type: 'function',
      function: {
        name: 'game_control',
        description:
          '操控电脑上正在运行的 Minecraft（我的世界）。'
          + 'action=start 让它按目标自己玩，action=stop 停止，action=status 查当前状态。'
          + 'start 会接管真实的鼠标和键盘，所以只能在桌面端（网页 / 桌面程序）使用，'
          + '并且游戏必须已经打开、已经进入世界。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['start', 'stop', 'status'], description: '要做什么' },
            goal: {
              type: 'string',
              description: '要它达成的目标，一句话，例如「砍三棵树再回到出生点」。不填就是自由探索',
            },
            rounds: { type: 'integer', description: '最多跑几轮，默认 20；填 0 表示不设上限，一直玩到你叫停' },
          },
          required: ['action'],
        },
      },
    },
    async run(args, ctx) {
      // 只放桌面端：QQ/微信上谁都能发消息，不能让人远程动鼠标
      if (ctx?.channel !== 'web') {
        return { ok: false, error: '游戏操控只能在桌面端使用（渠道消息一律拒绝）' };
      }
      const engine = require('./game/engine');

      if (args?.action === 'stop') {
        const r = engine.stop('对话里要求停止');
        return { ok: true, ...r };
      }

      if (args?.action === 'status') {
        const s = engine.status();
        // 带上窗口信息：游戏开着但循环没跑，和游戏根本没开，是两回事
        const wins = engine.listWindows();
        const mcTitle = (wins.windows || []).find((t) => /minecraft|我的世界/i.test(t)) || '';
        return {
          ok: true,
          running: s.running,
          mode: s.mode,
          goal: s.goal,
          round: s.round,
          maxRounds: s.maxRounds,
          gameWindow: mcTitle || '（没找到 Minecraft 窗口）',
          lastError: s.lastError || '',
        };
      }

      const goal = String(args?.goal || '').trim();
      const wins = engine.listWindows();
      const title = (wins.windows || []).find((t) => /minecraft|我的世界/i.test(t)) || '';
      if (!title) return { ok: false, error: '没找到 Minecraft 窗口，先把游戏打开并进入世界' };

      // 0 = 不设上限（完全接手），否则最多 200 轮
      const rawRounds = Number(args?.rounds);
      const rounds = rawRounds === 0 ? 0 : Math.max(1, Math.min(200, rawRounds || 20));
      // 强制进程内直连：不走视觉回退。连不上就说清楚原因，而不是偷偷去截屏动鼠标
      const r = await engine.start({ title, goal, maxRounds: rounds, dryRun: false, mode: 'agent' });
      if (!r.ok) {
        return {
          ok: false,
          error: r.error || '无法进入进程内直连',
          hint: '游戏要从「游戏」页的「启动游戏」打开（会挂 -javaagent），并且要先进到世界里',
        };
      }

      logs.info('tools', `开始游戏操控：${goal || '自由探索'}（${r.mode}）`);
      return {
        ok: true,
        mode: r.mode,
        modeReason: r.modeReason,
        goal,
        rounds,
        note: rounds === 0
          ? '已完全接管，会一直玩下去（只读游戏数据，不截图）。说「停下」结束'
          : `已接管 ${rounds} 轮（只读游戏数据，不截图）。说「停下」随时结束`,
      };
    },
  },

  see_screen: {
    definition: {
      type: 'function',
      function: {
        name: 'see_screen',
        description:
          '截取当前整个屏幕并看到真实画面。做任何需要"看"的操作（找按钮、确认结果、判断窗口状态）之前都先用它。'
          + '返回里有 screenWidth/screenHeight，那是真实屏幕像素尺寸；给鼠标工具传坐标时用这个尺寸。'
          + '如果 scale 小于 1，说明图被缩小过，真实坐标 = 图上量到的坐标 ÷ scale。',
        parameters: {
          type: 'object',
          properties: {
            max_width: { type: 'number', description: '截图最大宽度，默认 1600。想要看清细节可以调大到 2200。' },
          },
        },
      },
    },
    async run(args) {
      const computer = require('./computer');
      if (!computer.cfg().enabled) throw new Error('电脑操控未开启，请先在「设置 → 电脑操控」打开总开关');
      // 上限 1920：再大只是白白烧 token，而且超宽截图会让模型的坐标换算更容易出错
      const width = Math.max(320, Math.min(1920, Number(args?.max_width) || 1600));
      const r = await computer.screenshot({ maxWidth: width });
      if (!r.ok) throw new Error(r.error || '截图失败');

      const scaled = r.scale && r.scale < 1;
      return {
        __images: [r.dataUrl],
        screenWidth: r.screenWidth,
        screenHeight: r.screenHeight,
        screenOriginX: r.screenX,
        screenOriginY: r.screenY,
        imageWidth: r.imageWidth,
        imageHeight: r.imageHeight,
        scale: r.scale,
        foregroundWindow: r.foreground,
        hint: scaled
          ? `图被缩放到 ${r.imageWidth}×${r.imageHeight}（scale=${r.scale}）。真实坐标 = 图上坐标 ÷ ${r.scale}。`
          : '图与屏幕 1:1，图上坐标就是真实坐标。',
      };
    },
  },

  mouse_control: {
    definition: {
      type: 'function',
      function: {
        name: 'mouse_control',
        description:
          '控制鼠标：移动、左键/右键/双击、拖拽、滚轮。坐标是真实屏幕像素（先用 see_screen 看画面再决定点哪里）。'
          + '点之前建议先 move 再 see_screen 确认位置，避免点错。',
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['move', 'click', 'double', 'right', 'drag', 'scroll', 'position'],
              description: '要做的动作',
            },
            x: { type: 'number', description: '目标 X 坐标（move/click/double/right/drag 的起点）' },
            y: { type: 'number', description: '目标 Y 坐标' },
            toX: { type: 'number', description: 'drag 的终点 X' },
            toY: { type: 'number', description: 'drag 的终点 Y' },
            amount: { type: 'number', description: 'scroll 的格数，正数向上、负数向下' },
          },
          required: ['action'],
        },
      },
    },
    async run(args) {
      const computer = require('./computer');
      if (!computer.cfg().enabled) throw new Error('电脑操控未开启');
      const r = await computer.mouse(args || {});
      if (!r.ok) throw new Error(r.error || '鼠标操作失败');
      return r;
    },
  },

  keyboard_input: {
    definition: {
      type: 'function',
      function: {
        name: 'keyboard_input',
        description:
          '控制键盘。action=type 输入一段文字（支持中文）；action=key 按组合键，例如 "enter"、"ctrl+c"、"alt+tab"、"ctrl+shift+esc"。'
          + '输入前确认目标窗口已获得焦点（用 window_control 的 focus）。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['type', 'key'], description: 'type=输入文本，key=按键' },
            text: { type: 'string', description: 'action=type 时要输入的文字' },
            keys: { type: 'string', description: 'action=key 时的按键或组合键，如 "enter"、"ctrl+c"' },
          },
          required: ['action'],
        },
      },
    },
    async run(args) {
      const computer = require('./computer');
      if (!computer.cfg().enabled) throw new Error('电脑操控未开启');
      const r = await computer.keyboard(args || {});
      if (!r.ok) throw new Error(r.error || '键盘操作失败');
      return r;
    },
  },

  window_control: {
    definition: {
      type: 'function',
      function: {
        name: 'window_control',
        description:
          '管理窗口。action=list 列出当前所有可见窗口（标题和位置）；action=focus 把标题匹配的窗口切到前台。'
          + '要操作某个程序前，先 list 找到它，再 focus，然后再截图。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['list', 'focus'], description: 'list=列窗口，focus=切到前台' },
            title: { type: 'string', description: 'action=focus 时的窗口标题关键词（不区分大小写，支持部分匹配）' },
          },
          required: ['action'],
        },
      },
    },
    async run(args) {
      const computer = require('./computer');
      if (!computer.cfg().enabled) throw new Error('电脑操控未开启');
      const act = String(args?.action || 'list').toLowerCase();
      const r = act === 'focus'
        ? await computer.focusWindow(args?.title)
        : await computer.listWindows();
      if (!r.ok) throw new Error(r.error || '窗口操作失败');
      // 窗口多的时候只给前 40 个，避免把上下文塞爆
      if (Array.isArray(r.windows) && r.windows.length > 40) {
        r.windows = r.windows.slice(0, 40);
        r.truncated = true;
      }
      return r;
    },
  },

  open_app: {
    definition: {
      type: 'function',
      function: {
        name: 'open_app',
        description:
          '启动一个程序或打开文件/网址。path 可以是 exe 完整路径、系统命令（notepad、calc、explorer）或文档路径。'
          + '启动后建议等一两秒再 see_screen 确认。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '程序路径或命令名' },
            args: { type: 'string', description: '启动参数，可选' },
          },
          required: ['path'],
        },
      },
    },
    async run(args) {
      const computer = require('./computer');
      if (!computer.cfg().enabled) throw new Error('电脑操控未开启');
      const p = String(args?.path || '').trim();
      if (!p) throw new Error('缺少 path 参数');
      const r = await computer.launch(p, args?.args);
      if (!r.ok) throw new Error(r.error || '启动失败');
      logs.info('tools', `启动程序: ${p}`);
      return r;
    },
  },

  run_command: {
    definition: {
      type: 'function',
      function: {
        name: 'run_command',
        description:
          '在 cmd 里执行一条命令并拿到输出。适合批量文件操作、查系统信息、调用命令行工具。'
          + '不能做系统级危险操作（格式化、改启动项、删系统服务等，会被安全策略拒绝）。'
          + '需要「看结果再决定下一步」时用它，比开窗口点来点去快得多。',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: '要执行的命令' },
            cwd: { type: 'string', description: '工作目录，默认项目目录' },
            timeout: { type: 'number', description: '超时毫秒数，默认 30000，最大 120000' },
          },
          required: ['command'],
        },
      },
    },
    async run(args) {
      const computer = require('./computer');
      if (!computer.cfg().enabled) throw new Error('电脑操控未开启');
      const cmd = String(args?.command || '').trim();
      if (!cmd) throw new Error('缺少 command 参数');
      const r = await computer.shell(cmd, { cwd: args?.cwd, timeout: args?.timeout });
      if (!r.ok) throw new Error(r.error || '命令执行失败');
      return r;
    },
  },
};

const ALL_TOOL_META = [
  { name: 'get_time', label: '时间查询', desc: '获取当前日期时间' },
  { name: 'calc', label: '计算器', desc: '安全计算数学表达式' },
  { name: 'http_request', label: 'HTTP 请求', desc: '调用外部接口获取数据' },
  { name: 'web_search', label: '联网搜索', desc: '需要配置搜索 API' },
  { name: 'remember', label: '主动记忆', desc: '把重要信息存入长期记忆' },
  { name: 'recall', label: '记忆检索', desc: '按关键词查找历史记忆' },
  { name: 'send_message', label: '主动发消息', desc: '向 QQ / 微信 / 企微 发消息' },
  { name: 'list_contacts', label: '查联系人', desc: '查询 QQ 好友与群列表' },
  { name: 'get_group_members', label: '查群成员', desc: '查询 QQ 群成员列表' },
  { name: 'list_sessions', label: '查会话', desc: '查看最近谁找过你' },
  { name: 'like_friend', label: '好友点赞', desc: '名片点赞，每日有限额' },
  { name: 'delete_friend', label: '删除好友', desc: '不可恢复，危险操作' },
  { name: 'see_screen', label: '看屏幕', desc: '截屏，让 AI 看见当前桌面画面' },
  { name: 'mouse_control', label: '控制鼠标', desc: '移动、点击、拖拽、滚轮' },
  { name: 'keyboard_input', label: '控制键盘', desc: '输入文字、按组合键' },
  { name: 'window_control', label: '窗口管理', desc: '列出窗口、切换前台' },
  { name: 'game_control', label: '操控游戏', desc: '让 AI 自己玩 Minecraft（仅桌面端）' },
  { name: 'open_app', label: '打开程序', desc: '启动 exe 或打开文件' },
  { name: 'run_command', label: '执行命令', desc: '跑 cmd 命令，危险，需单独开启' },
];

// 安卓版没有桌面/游戏控制能力，工具列表里也不暴露，避免模型调用必失败的接口。
const ANDROID = process.env.AIBRIDGE_ANDROID === '1';
const DESKTOP_ONLY = new Set([
  'game_control', 'see_screen', 'mouse_control', 'keyboard_input',
  'window_control', 'open_app', 'run_command',
]);
const TOOL_META = ANDROID ? ALL_TOOL_META.filter((t) => !DESKTOP_ONLY.has(t.name)) : ALL_TOOL_META;

// 电脑操控类工具只允许桌面端（网页对话）触发：
// 渠道消息的发送者不一定是电脑主人——QQ 群里任何人 @ 一下、公众号随便谁发条消息，
// 都能让 AI 去截屏、动鼠标、敲命令。「总开关」回答的是「这台机器允不允许 AI 操控」，
// 不等于「任何渠道来的人都允许操控」，所以这里按渠道再拦一道。
const COMPUTER_ONLY = new Set([
  'see_screen', 'mouse_control', 'keyboard_input', 'window_control', 'open_app', 'run_command',
]);

/** 按名称列表构造 tools 定义数组 */
function buildToolSchema(names) {
  return (names || [])
    .filter((n) => !(ANDROID && DESKTOP_ONLY.has(n)))
    .map((n) => TOOL_DEFS[n]?.definition)
    .filter(Boolean);
}

/** 执行单个工具调用，返回字符串结果 */
async function executeTool(name, rawArgs, context) {
  if (ANDROID && DESKTOP_ONLY.has(name)) {
    return JSON.stringify({ error: 'Android 版不支持桌面/游戏控制工具' });
  }
  const tool = TOOL_DEFS[name];
  if (!tool) return JSON.stringify({ error: `未知工具: ${name}` });

  const ctxChannel = String((context && context.channel) || '');
  if (COMPUTER_ONLY.has(name) && ctxChannel && ctxChannel !== 'web') {
    logs.warn('tools', `拒绝来自 ${ctxChannel} 渠道的电脑操控请求: ${name}`);
    return JSON.stringify({ error: '电脑操控只能在桌面端（网页对话）里使用，渠道消息一律拒绝' });
  }

  let args = {};
  if (rawArgs) {
    if (typeof rawArgs === 'object') args = rawArgs;
    else {
      try { args = JSON.parse(rawArgs); } catch (_) {
        return JSON.stringify({ error: '工具参数不是合法 JSON' });
      }
    }
  }

  try {
    const result = await tool.run(args, context || {});
    return JSON.stringify(result);
  } catch (err) {
    logs.warn('tools', `工具 ${name} 执行失败: ${err.message}`);
    return JSON.stringify({ error: err.message });
  }
}

module.exports = { buildToolSchema, executeTool, TOOL_META, evaluate };
