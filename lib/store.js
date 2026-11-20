'use strict';
/**
 * 配置与会话的持久化存储。
 * 使用 JSON 文件 + 防抖原子写入，避免引入数据库依赖。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// AIBRIDGE_DATA_DIR 与 memory.js 用的是同一个开关：整套数据（config/sessions）
// 一起搬走，测试/多实例才不会写坏真实配置。
// 以前只有 memory.js 认这个变量，config 永远落在 data/ 下——
// 结果「隔离数据目录」跑测试时，测试仍然改写了用户真实配置。
const DATA_DIR = process.env.AIBRIDGE_DATA_DIR
  ? path.resolve(process.env.AIBRIDGE_DATA_DIR)
  : path.join(ROOT, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/** 通用 JSON 文件容器：防抖写入 + 原子替换 */
class JsonFile {
  constructor(file, defaults) {
    this.file = file;
    this.defaults = defaults;
    this.data = null;
    this.timer = null;
    this.load();
  }

  load() {
    ensureDir();
    try {
      if (fs.existsSync(this.file)) {
        const raw = fs.readFileSync(this.file, 'utf8');
        this.data = raw.trim() ? JSON.parse(raw) : clone(this.defaults);
      } else {
        this.data = clone(this.defaults);
        this.flush();
      }
    } catch (err) {
      console.error(`[store] 读取 ${path.basename(this.file)} 失败，使用默认值:`, err.message);
      const backup = `${this.file}.broken-${Date.now()}`;
      try { fs.copyFileSync(this.file, backup); } catch (_) { /* ignore */ }
      this.data = clone(this.defaults);
    }
    // 与默认结构做一次浅层补全，保证升级后新增字段存在
    this.data = deepMerge(clone(this.defaults), this.data);
  }

  get() {
    return this.data;
  }

  set(next) {
    this.data = next;
    this.save();
  }

  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 120);
  }

  /**
   * 写入前把上一版内容存档。
   * 只对配置文件做（会话文件体积大且追加式，备份价值低）。
   */
  _archivePrevious() {
    try {
      if (!fs.existsSync(this.file)) return;
      const prev = fs.readFileSync(this.file, 'utf8');
      if (!prev.trim()) return;
      const next = JSON.stringify(this.data, null, 2);
      if (prev === next) return;

      const dir = path.join(DATA_DIR, 'backups');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      const base = path.basename(this.file, '.json');
      const d = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-`
        + `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

      let target = path.join(dir, `${base}-${stamp}.json`);
      let n = 1;
      while (fs.existsSync(target)) {
        target = path.join(dir, `${base}-${stamp}-${n}.json`);
        n += 1;
      }
      fs.writeFileSync(target, prev, 'utf8');

      // 只保留最近 40 个版本
      const all = fs.readdirSync(dir)
        .filter((f) => f.startsWith(`${base}-`) && f.endsWith('.json'))
        .sort();
      for (const old of all.slice(0, Math.max(0, all.length - 40))) {
        try { fs.unlinkSync(path.join(dir, old)); } catch (_) { /* ignore */ }
      }
    } catch (_) {
      // 备份失败不能影响正常写入
    }
  }

  flush() {
    ensureDir();
    if (path.basename(this.file) === 'config.json') this._archivePrevious();

    const tmp = `${this.file}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('[store] 写入失败:', err.message);
    }
  }
}

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** 用 defaults 补齐 target 中缺失的键（target 优先） */
function deepMerge(defaults, target) {
  if (!isPlainObject(defaults) || !isPlainObject(target)) return target === undefined ? defaults : target;
  const out = { ...defaults };
  for (const key of Object.keys(target)) {
    out[key] = isPlainObject(defaults[key]) && isPlainObject(target[key])
      ? deepMerge(defaults[key], target[key])
      : target[key];
  }
  return out;
}

const DEFAULT_CONFIG = {
  server: {
    port: 8787,
    publicUrl: '',
  },
  providers: [
    {
      id: 'prov_openai',
      name: 'OpenAI 兼容接口',
      type: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '',
      models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini'],
      headers: {},
    },
  ],
  agents: [
    {
      id: 'agent_default',
      name: '通用助手',
      providerId: 'prov_openai',
      model: 'gpt-4o-mini',
      systemPrompt:
        '你是一位可靠、亲切的中文 AI 助手。回答要准确、简洁、有条理。\n' +
        '当用户的问题需要实时信息或计算时，优先调用工具而不是猜测。\n' +
        '如果不知道答案，直接说明，不要编造。',
      temperature: 0.7,
      maxTokens: 1200,
      tools: ['get_time', 'calc', 'remember', 'recall', 'send_message', 'list_contacts', 'list_sessions'],
      keywords: [],
      channels: ['web', 'wechat', 'wecom', 'qq', 'onebot'],
      enabled: true,
      greeting: '你好，我是你的 AI 助手，有什么可以帮你？',
    },
  ],
  voice: {
    stt: {
      enabled: false,
      // api = 走 OpenAI 兼容接口；local = 本地 whisper.cpp，不联网
      provider: 'api',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '',
      model: 'whisper-1',
      language: 'zh',
      local: { model: 'sensevoice', threads: 0 },
    },
    tts: {
      enabled: false,
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '',
      model: 'tts-1',
      voice: 'alloy',
      speed: 1,
      format: 'mp3',
    },
    browserFallback: true,
    autoSpeak: false,
    // QQ 语音条（OneBot）：QQ 用的是 SILK 编码，收发都要转码
    qq: {
      enabled: false,      // 总开关
      listen: true,        // 收到语音时转成文字再理解
      reply: false,        // 回复时用语音条（否则回文字）
      alwaysVoice: false,  // 对方发文字也回语音（默认只在收到语音时才回语音）
      groupReply: false,   // 群聊里也发语音条（默认只在私聊发，群里太吵）
      maxChars: 80,        // 超过这个字数改回文字——几十秒的语音条不像人发的
      silkRate: 24000,     // 解码采样率，QQ 移动端一般 24000，微信偏 16000
      ttsFormat: 'wav',    // TTS 必须能出 wav，SILK 编码只吃 WAV/PCM
    },
  },
  // 电脑操控：让 AI 真的能看屏幕、动鼠标、敲键盘。
  // 默认全关——这是唯一能直接改动用户电脑的能力，必须显式开启。
  computer: {
    enabled: false,       // 总开关，关着时所有操控工具直接拒绝
    allowShell: false,    // 执行命令（高危，单独再开一道）
    allowLaunch: true,    // 启动程序（比执行命令安全，总开关开了就允许）
    maxWidth: 1600,       // 截图最大宽度，越小越省 token、也越看不清细节
    quality: 62,          // 截图 JPEG 质量
    timeoutMs: 20000,     // 单个操作超时
  },
  channels: {
    wechat: {
      enabled: false,
      appId: '',
      appSecret: '',
      token: '',
      encodingAesKey: '',
      mode: 'plain',
    },
    wecom: {
      enabled: false,
      corpId: '',
      agentId: '',
      secret: '',
      token: '',
      encodingAesKey: '',
    },
    qq: {
      enabled: false,
      appId: '',
      appSecret: '',
      token: '',
      sandbox: false,
    },
    onebot: {
      enabled: false,
      apiBase: 'http://127.0.0.1:3000',
      token: '',
      selfId: '',
      groupAtOnly: true,
      privateReply: true,
      replyAt: true,
      // 额外的反向 WS 监听端口：NapCat 客户端地址若写死 8082，也不用改 NapCat 配置
      wsPort: 8082,
      // 风控保护：把「秒回 + 并发 + 刷屏」这些机器特征抹掉
      antispam: {
        enabled: true,
        minIntervalMs: 2500,        // 两条消息之间的最小间隔
        jitterMs: 2000,             // 额外随机抖动，避免固定节奏
        perTargetCooldownMs: 10000, // 同一个用户/群两次回复的最小间隔
        maxPerMinute: 15,           // 每分钟最多发几条
        maxQueue: 30,               // 队列上限，超出的直接丢弃
        typingPerCharMs: 12,        // 按字数模拟打字耗时
        typingMaxMs: 4000,          // 打字延迟上限
        splitLong: true,            // 超长文本按句子切条
        maxLenPerMsg: 500,          // 单条最长字数
        maxSegments: 3,             // 一条回复最多切成几条
        mergeWindowMs: 1200,        // 同一个人连发时，这么多毫秒内合并成一次回复
        blockWords: [],             // 命中就整条不发的词（默认空，自行补充）
      },
    },
    // NapCat WebUI，用于在本系统内扫码登录 QQ
    napcatWebui: {
      baseUrl: 'http://127.0.0.1:6099',
      token: '',
      autoStart: true,
      qqPath: '',
    },
  },
  routing: {
    defaultAgentId: 'agent_default',
  },
  search: {
    provider: 'none',
    apiKey: '',
  },
  // 游戏操控：默认只读游戏数据（进程内直连），不截图给视觉模型
  game: { allowVision: false, providerId: '', model: '', reflex: true, menuControl: true, allowControl: true, moveView: true },
  memory: {
    enabled: true,
    autoExtract: true,
    model: '',
    injectLimit: 12,
    // 网页端可以和某个渠道账号共用「用户记忆」：绑上自己的 QQ 号以后，
    // 桌面程序里聊过的事 QQ 上也记得，反过来也一样。
    link: { enabled: false, channel: 'onebot', userId: '' },
  },
};

const configFile = new JsonFile(CONFIG_FILE, DEFAULT_CONFIG);
const sessionsFile = new JsonFile(SESSIONS_FILE, { sessions: {} });

/**
 * 「电脑管家」预置智能体。
 *
 * providerId / model 不能写死——用户可能一个 provider 都没配，也可能把默认的那个删了。
 * 这里拿现有配置里第一个能用的 provider 兜底，实在没有就留空，让用户自己去智能体页选。
 */
function makeComputerAgent(cfg) {
  const providers = (cfg && cfg.providers) || [];
  const usable = providers.find((p) => p && p.id && (p.models || []).length) || providers[0] || {};
  return {
    id: 'agent_computer',
    name: '电脑管家',
    providerId: usable.id || '',
    model: (usable.models || [])[0] || '',
    systemPrompt:
      '你是「电脑管家」，一个能直接操作 Windows 电脑的 AI。你不是在描述操作，你是真的在执行。\n'
      + '\n【工作方式】每件事都按这个循环走：\n'
      + '1. 先 see_screen 看当前屏幕。不确定状态时一律先看，不要猜。\n'
      + '2. 用 window_control 的 list 找到目标窗口，focus 切到前台。\n'
      + '3. 用 mouse_control / keyboard_input 操作。\n'
      + '4. 再 see_screen 确认结果。没成功就调整再试，不要假设成功。\n'
      + '\n【坐标】\n'
      + '- 截图返回的 screenWidth / screenHeight 是真实屏幕像素，鼠标坐标就用这个尺度。\n'
      + '- 如果 scale 小于 1，说明图被缩小过，真实坐标 = 图上量到的坐标 ÷ scale。\n'
      + '- 点之前可以先 move 再截图确认位置，比点错重来快。\n'
      + '\n【安全】\n'
      + '- 只做用户要求的事。任务完成就停，不要"顺手"清理、优化、关闭别的东西。\n'
      + '- 删除文件、改系统设置、执行命令之前，先说明你要做什么。\n'
      + '- 涉及钱、密码、账号、隐私的操作，一律先问再做。\n'
      + '- run_command 被安全策略拒绝时，换一种做法，不要想办法绕。\n'
      + '\n【表达】\n'
      + '- 动作之间不用长篇解释，一句"我打开记事本"就够。\n'
      + '- 结束后用一两句话报告：做了什么、看到了什么、结果如何。',
    temperature: 0.3,
    maxTokens: 1500,
    tools: [
      'see_screen', 'mouse_control', 'keyboard_input', 'window_control',
      'open_app', 'run_command', 'get_time', 'calc', 'remember', 'recall',
    ],
    keywords: ['打开', '关闭窗口', '帮我操作', '截图', '点一下', '输入', '桌面', '鼠标', '键盘'],
    // 只绑网页端。绑到 QQ / 微信等于把电脑交给任何一个能发消息的人。
    channels: ['web'],
    enabled: true,
    greeting: '我是电脑管家，可以直接帮你在电脑上操作。想做什么，说一声就行。',
  };
}

/**
 * 配置迁移：给已有用户补上新增的预置智能体。
 * 只在「从来没补过」时执行一次，之后用户手动删掉也不会再被塞回来。
 */
function migrateConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return false;
  const done = cfg.migrations || {};
  let changed = false;

  if (!done.computerAgent) {
    cfg.agents = Array.isArray(cfg.agents) ? cfg.agents : [];
    if (!cfg.agents.some((a) => a && a.id === 'agent_computer')) {
      cfg.agents.push(makeComputerAgent(cfg));
    }
    cfg.migrations = Object.assign({}, done, { computerAgent: true });
    changed = true;
  }

  return changed;
}

if (migrateConfig(configFile.get())) configFile.flush();

const MAX_SESSIONS = 500;
const MAX_MESSAGES_PER_SESSION = 200;

const store = {
  uid,

  getConfig() {
    return configFile.get();
  },

  saveConfig(patch) {
    const next = deepMerge(configFile.get(), patch || {});
    configFile.set(next);
    return next;
  },

  replaceConfig(next) {
    // 以「当前配置」为底，而不是 DEFAULT_CONFIG：
    // 以前请求体里没带的字段会被静默重置成默认值——一个只改主题的瘦客户端，
    // 就能顺手把用户的 API Key、渠道密钥、电脑操控开关全抹掉。
    // 数组（providers/agents）按入参整体替换，所以删除条目仍然生效。
    // 新增字段用 DEFAULT_CONFIG 兜底，保证老配置文件升级后不缺键。
    const base = deepMerge(clone(DEFAULT_CONFIG), clone(configFile.get()));
    configFile.set(deepMerge(base, next || {}));
    return configFile.get();
  },

  /** 按 id 查找模型提供商 */
  getProvider(id) {
    const cfg = configFile.get();
    return cfg.providers.find((p) => p.id === id) || cfg.providers[0] || null;
  },

  getAgent(id) {
    const cfg = configFile.get();
    return cfg.agents.find((a) => a.id === id) || null;
  },

  /** 渠道 + 关键词路由，返回最匹配的 Agent */
  routeAgent(channel, text) {
    const cfg = configFile.get();
    const list = cfg.agents.filter((a) => a.enabled !== false);
    if (!list.length) return null;
    const content = String(text || '').toLowerCase();

    const byKeyword = list.find((a) =>
      (a.keywords || []).some((k) => k && content.includes(String(k).toLowerCase()))
    );
    if (byKeyword) return byKeyword;

    const byChannel = list.find((a) => (a.channels || []).includes(channel));
    if (byChannel) return byChannel;

    const fallback = list.find((a) => a.id === cfg.routing.defaultAgentId);
    return fallback || list[0];
  },

  // ---------- 会话 ----------
  getSession(id) {
    return sessionsFile.get().sessions[id] || null;
  },

  listSessions() {
    const all = Object.values(sessionsFile.get().sessions);
    return all
      .map((s) => ({
        id: s.id,
        channel: s.channel,
        userId: s.userId,
        agentId: s.agentId,
        agentName: s.agentName,
        title: s.title,
        messageCount: s.messages.length,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  },

  upsertSession(id, patch) {
    const db = sessionsFile.get();
    const now = Date.now();
    let s = db.sessions[id];
    if (!s) {
      s = {
        id,
        channel: patch.channel || 'web',
        userId: patch.userId || '',
        agentId: patch.agentId || '',
        agentName: patch.agentName || '',
        title: patch.title || '',
        messages: [],
        createdAt: now,
        updatedAt: now,
      };
      db.sessions[id] = s;
    }
    Object.assign(s, patch, { updatedAt: now });
    if (s.messages.length > MAX_MESSAGES_PER_SESSION) {
      s.messages = s.messages.slice(-MAX_MESSAGES_PER_SESSION);
    }
    this._pruneSessions(db);
    sessionsFile.save();
    return s;
  },

  appendMessage(id, message) {
    const db = sessionsFile.get();
    const s = db.sessions[id];
    if (!s) return null;
    s.messages.push({ ...message, ts: message.ts || Date.now() });
    if (s.messages.length > MAX_MESSAGES_PER_SESSION) {
      s.messages = s.messages.slice(-MAX_MESSAGES_PER_SESSION);
    }
    s.updatedAt = Date.now();
    if (!s.title) {
      const firstUser = s.messages.find((m) => m.role === 'user');
      if (firstUser) s.title = String(firstUser.content).slice(0, 30);
    }
    sessionsFile.save();
    return s;
  },

  deleteSession(id) {
    const db = sessionsFile.get();
    delete db.sessions[id];
    sessionsFile.save();
  },

  clearSessions() {
    const db = sessionsFile.get();
    db.sessions = {};
    sessionsFile.save();
  },

  stats() {
    const db = sessionsFile.get();
    const list = Object.values(db.sessions);
    const messages = list.reduce((n, s) => n + s.messages.length, 0);
    const byChannel = {};
    for (const s of list) byChannel[s.channel] = (byChannel[s.channel] || 0) + 1;
    return { sessions: list.length, messages, byChannel };
  },

  _pruneSessions(db) {
    const ids = Object.keys(db.sessions);
    if (ids.length <= MAX_SESSIONS) return;
    ids
      .sort((a, b) => (db.sessions[a].updatedAt || 0) - (db.sessions[b].updatedAt || 0))
      .slice(0, ids.length - MAX_SESSIONS)
      .forEach((id) => delete db.sessions[id]);
  },

  flushAll() {
    configFile.flush();
    sessionsFile.flush();
  },

  // ---------------- 配置备份 ----------------

  backupDir() {
    return path.join(DATA_DIR, 'backups');
  },

  /** 列出配置历史版本（新的在前） */
  listBackups() {
    const dir = this.backupDir();
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((f) => f.startsWith('config-') && f.endsWith('.json'))
      .map((f) => {
        const full = path.join(dir, f);
        const st = fs.statSync(full);
        let agents = [];
        let providers = 0;
        try {
          const cfg = JSON.parse(fs.readFileSync(full, 'utf8'));
          agents = (cfg.agents || []).map((a) => a.name);
          providers = (cfg.providers || []).length;
        } catch (_) { /* 损坏的备份仍列出，便于排查 */ }
        return { name: f, size: st.size, mtime: st.mtimeMs, agents, providers };
      })
      .sort((a, b) => b.mtime - a.mtime);
  },

  /** 读取某个备份的完整内容 */
  readBackup(name) {
    const safe = path.basename(String(name || ''));
    if (!safe.startsWith('config-') || !safe.endsWith('.json')) {
      throw new Error('非法的备份文件名');
    }
    const full = path.join(this.backupDir(), safe);
    if (!fs.existsSync(full)) throw new Error('备份不存在');
    return JSON.parse(fs.readFileSync(full, 'utf8'));
  },

  /** 用备份覆盖当前配置（覆盖前会先把当前版本存档） */
  restoreBackup(name) {
    const data = this.readBackup(name);
    configFile._archivePrevious();
    configFile.data = deepMerge(clone(DEFAULT_CONFIG), data);
    configFile.flush();
    return configFile.data;
  },

  /** 立即备份当前配置 */
  snapshotNow() {
    try {
      const dir = this.backupDir();
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const d = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-`
        + `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
      const target = path.join(dir, `config-${stamp}-manual.json`);
      fs.writeFileSync(target, JSON.stringify(configFile.get(), null, 2), 'utf8');
      return path.basename(target);
    } catch (err) {
      throw new Error(`备份失败: ${err.message}`);
    }
  },
};

module.exports = store;
module.exports.DEFAULT_CONFIG = DEFAULT_CONFIG;
