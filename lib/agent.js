'use strict';
/**
 * Agent 运行器：负责组织上下文、调用模型、执行工具、写入会话。
 */
const store = require('./store');
const llm = require('./llm');
const logs = require('./logs');
const memory = require('./memory');
const { buildToolSchema, executeTool } = require('./tools');

const MAX_TOOL_ROUNDS = 4;
const HISTORY_LIMIT = 24;

const CHANNEL_LABELS = {
  web: '网页',
  wechat: '微信公众号',
  wecom: '企业微信',
  qq: 'QQ 官方机器人',
  onebot: 'QQ（OneBot）',
};

/**
 * 解析会话标识，得出「回复目标」与「发言人」。
 * OneBot 群聊的会话 ID 形如 group_<群号>_<QQ号>。
 */
function parseSession(channel, userId) {
  const uid = String(userId || '');

  if (channel === 'onebot') {
    const m = uid.match(/^group_(\d+)_(\d+)$/);
    if (m) {
      return {
        scene: 'group',
        groupId: m[1],
        speakerId: m[2],
        replyTarget: { type: 'group', id: m[1], atUserId: m[2] },
      };
    }
    return {
      scene: 'private',
      speakerId: uid,
      replyTarget: { type: 'private', id: uid },
    };
  }

  if (channel === 'wechat' || channel === 'wecom' || channel === 'qq') {
    return {
      scene: 'private',
      speakerId: uid,
      replyTarget: { type: 'private', id: uid },
    };
  }

  return { scene: 'web', speakerId: uid, replyTarget: null };
}

/** 构造「当前会话」提示块，让模型知道自己正在哪、跟谁说话 */
function buildSessionBlock(channel, userId, names = {}) {
  const info = parseSession(channel, userId);
  const channelName = CHANNEL_LABELS[channel] || channel;
  const who = names.nickname ? `${names.nickname}（${info.speakerId}）` : info.speakerId;

  let sceneText;
  if (info.scene === 'group') {
    const gname = names.groupName ? `「${names.groupName}」` : '';
    sceneText = `群聊${gname} ${info.groupId}，当前发言人 ${who}`;
  } else if (info.scene === 'web') {
    sceneText = `与访客 ${who} 的网页对话`;
  } else {
    sceneText = `私聊，对方 ${who}`;
  }

  const hint = channel === 'web'
    ? '你的回复会直接显示在网页上。如需主动联系他人，可用 send_message 指定渠道与目标。'
    : '你的回复会自动发送给对方，不需要再调用 send_message 回复当前会话。send_message 仅用于主动联系其他的人或群。';

  return {
    info,
    block: `\n\n【当前会话】\n渠道：${channelName}\n场景：${sceneText}\n${hint}`,
  };
}

/**
 * 从工具结果里摘出图片。
 *
 * OpenAI 的 tool 消息只能放文本，所以工具用 `__images: [dataUrl]` 这个约定
 * 把图带出来，这里摘掉字段、返回干净的文本 + 图片数组，
 * 由调用方紧跟一条 user 消息把图挂上去。
 *
 * 必须摘干净：base64 留在 tool content 里会瞬间把上下文烧光。
 *
 * @returns {{content: string, images: string[]}}
 */
function extractToolImages(output) {
  try {
    const parsed = JSON.parse(output);
    if (parsed && Array.isArray(parsed.__images) && parsed.__images.length) {
      const images = parsed.__images
        .filter((u) => typeof u === 'string' && u.startsWith('data:image/'))
        .slice(0, 2);
      delete parsed.__images;
      return { content: JSON.stringify(parsed), images };
    }
  } catch (_) { /* 不是 JSON 就原样传 */ }
  return { content: output, images: [] };
}

function buildMessages(agent, history, userText, extraSystem, images) {
  const messages = [];
  let sys = String(agent.systemPrompt || '').trim();
  if (extraSystem) sys += extraSystem;
  if (sys) messages.push({ role: 'system', content: sys });

  for (const m of history.slice(-HISTORY_LIMIT)) {
    if (m.role === 'user' || m.role === 'assistant') {
      if (m.content) messages.push({ role: m.role, content: String(m.content) });
    }
  }

  if (images && images.length) {
    // 多模态：文字 + 图片。图片用 data URL，OpenAI 兼容接口都吃这一套。
    const content = [{ type: 'text', text: userText }];
    for (const url of images.slice(0, 3)) {
      content.push({ type: 'image_url', image_url: { url } });
    }
    messages.push({ role: 'user', content });
  } else {
    messages.push({ role: 'user', content: userText });
  }
  return messages;
}

/**
 * 运行一次 Agent 对话。
 * @param {object} opts
 * @param {string} opts.channel      渠道标识 web / wechat / wecom / qq
 * @param {string} opts.userId       渠道内用户唯一标识
 * @param {string} opts.text         用户输入
 * @param {string} [opts.agentId]    指定 Agent，缺省按渠道与关键词路由
 * @param {boolean} [opts.stream]    是否流式
 * @param {function} [opts.onEvent]  事件回调
 * @param {AbortSignal} [opts.signal]
 */
/**
 * 模型名必须落在该服务的 models 列表里，否则退回第一个。
 *
 * 起因：智能体的「模型」是个自由输入框，被填成服务商的名字（「本地 Qwen2.5-7B」），
 * 于是把服务商名字当模型名发给 DeepSeek，直接 HTTP 400，前端只显示「（没有返回内容）」。
 * 与其让用户对着空回复猜，不如在这里兜住并留一条日志。
 */
function resolveModel(provider, wanted) {
  const list = (provider && provider.models) || [];
  const want = String(wanted || '').trim();
  if (!want) return list[0] || '';
  if (!list.length || list.includes(want)) return want;
  logs.warn('agent', `模型「${want}」不在服务「${(provider && (provider.name || provider.id)) || '?'}」的列表里，改用 ${list[0]}`);
  return list[0];
}

async function run(opts) {
  const {
    channel = 'web',
    userId = 'anonymous',
    text,
    agentId,
    stream = true,
    onEvent = () => {},
    signal,
    images = [],
    names = {},
  } = opts;

  const input = String(text || '').trim();
  if (!input) throw new Error('输入内容为空');

  const agent = agentId ? store.getAgent(agentId) : store.routeAgent(channel, input);
  if (!agent) throw new Error('没有可用的智能体，请先在「智能体」中创建');
  if (agent.enabled === false) throw new Error(`智能体「${agent.name}」已停用`);

  const provider = store.getProvider(agent.providerId);
  if (!provider) throw new Error('智能体未绑定模型提供商');
  if (!provider.apiKey && !provider.headers?.Authorization) {
    // 仍然允许尝试（部分本地服务无需 key），但给出明确日志
    logs.warn('agent', `提供商「${provider.name}」未配置 API Key`);
  }

  const sessionId = opts.sessionId || `${channel}:${userId}`;
  const existing = store.getSession(sessionId);
  const history = existing ? existing.messages : [];

  store.upsertSession(sessionId, {
    channel,
    userId,
    agentId: agent.id,
    agentName: agent.name,
    title: existing?.title || input.slice(0, 30),
  });
  store.appendMessage(sessionId, {
    role: 'user',
    content: images.length ? `${input}（附图 ${images.length} 张）` : input,
  });

  onEvent({ type: 'start', sessionId, agent: { id: agent.id, name: agent.name } });

  // 会话上下文：让模型知道自己在哪个渠道、跟谁说话，才能正确调用主动操作工具
  const sessionCtx = buildSessionBlock(channel, userId, names);

  // 技能包：只往系统提示词里加「怎么做」，不授予任何新工具权限。
  // 技能声明的 tools 只是建议，真正可用的工具仍然由 agent.tools 决定。
  let skillsBlock = '';
  let skillTools = [];
  try {
    const cfgAll = store.getConfig();
    const skillsCfg = cfgAll.skills || {};
    const ids = Array.isArray(agent.skills) ? agent.skills.filter(Boolean) : [];
    if (skillsCfg.enabled !== false && skillsCfg.autoInject !== false && ids.length) {
      const skills = require('./skills');
      skillsBlock = skills.instructionsOf(ids);
      skillTools = skills.toolsOf(ids);
      if (skillsBlock) onEvent({ type: 'skills', count: ids.length });
    }
  } catch (err) {
    logs.warn('skills', `技能注入失败: ${err.message}`);
  }

  // 知识库：用用户这句话去检索本地资料，命中片段拼进上下文；
  // 是否自动注入由 knowledge.autoInject 与智能体自己的 knowledge 配置共同决定。
  let kbBlock = '';
  let kbEnabled = false;
  let kbHits = 0;
  try {
    const cfgAll = store.getConfig();
    const kbCfg = cfgAll.knowledge || {};
    const agentKb = agent.knowledge || {};
    kbEnabled = kbCfg.enabled !== false
      && (agentKb.enabled === true || (agentKb.enabled !== false && kbCfg.autoInject !== false));
    if (kbEnabled && kbCfg.autoInject !== false) {
      const kb = require('./kb');
      const cols = (Array.isArray(agentKb.collections) && agentKb.collections.length)
        ? agentKb.collections
        : (Array.isArray(kbCfg.collections) ? kbCfg.collections : []);
      const hits = kb.search({ query: input, collections: cols, k: kbCfg.topK || 4 });
      kbHits = hits.length;
      if (hits.length) {
        const maxChars = Math.max(400, Number(kbCfg.maxChars) || 1800);
        const lines = [];
        let used = 0;
        for (const hit of hits) {
          const text = String(hit.text || '').slice(0, 600);
          if (used + text.length > maxChars) break;
          used += text.length;
          lines.push(`- （${hit.title}）${text}`);
        }
        if (lines.length) {
          kbBlock = '\n\n【知识库】以下是从本地知识库检索到的资料片段，回答时优先依据这些内容；'
            + '片段里没有的细节不要编造，可以说明「资料里没有提到」。\n' + lines.join('\n');
        }
        onEvent({ type: 'knowledge', count: hits.length });
      }
    }
  } catch (err) {
    logs.warn('kb', `知识库检索失败: ${err.message}`);
  }

  // 注入长期记忆（跨会话共享：global + 该人格 + 该用户）
  // 记忆按「清晰 / 模糊 / 隐约」分档注入，模型才知道哪条能当事实用
  const memCfg = store.getConfig().memory || {};
  let memoryBlock = '';
  let memoryFacts = [];
  if (memCfg.enabled !== false) {
    try {
      memoryFacts = memory.recall({
        text: input,
        scopes: ['global', `agent:${agent.id}`, memory.userScope(channel, userId)],
        limit: memCfg.injectLimit || 12,
      });
      if (memoryFacts.length) {
        memoryBlock = memory.formatMemoryBlock(memoryFacts);
        onEvent({
          type: 'memory',
          count: memoryFacts.length,
          tiers: {
            clear: memoryFacts.filter((f) => f._tier === 'clear').length,
            fuzzy: memoryFacts.filter((f) => f._tier === 'fuzzy').length,
            vague: memoryFacts.filter((f) => f._tier === 'vague').length,
          },
        });
      }
    } catch (err) {
      logs.warn('memory', `记忆注入失败: ${err.message}`);
    }
  }

  const messages = buildMessages(
    agent, history, input,
    sessionCtx.block + skillsBlock + kbBlock + memoryBlock,
    images
  );
  // 知识库开着时额外给一个 kb_search 工具（模型可以自己决定再查一次）。
  // 技能包不在这里扩权：skillTools 只用于提示词里的建议，不并进 schema。
  const baseTools = Array.isArray(agent.tools) ? agent.tools.slice() : [];
  if (kbEnabled && !baseTools.includes('kb_search')) baseTools.push('kb_search');
  const toolSchema = buildToolSchema(baseTools);
  let toolsDisabled = toolSchema.length === 0;
  let finalText = '';
  let usage = null;
  let rounds = 0;

  try {
    while (rounds <= MAX_TOOL_ROUNDS) {
      rounds += 1;

      const callOpts = {
        provider,
        model: resolveModel(provider, agent.model),
        messages,
        tools: toolsDisabled ? undefined : toolSchema,
        temperature: typeof agent.temperature === 'number' ? agent.temperature : 0.7,
        maxTokens: agent.maxTokens,
        signal,
      };

      let result;
      if (stream) {
        result = await llm.chatStream({
          ...callOpts,
          onDelta: (delta) => onEvent({ type: 'delta', text: delta }),
        });
      } else {
        result = await llm.chat(callOpts);
      }

      usage = result.usage || usage;

      if (result.toolCalls && result.toolCalls.length) {
        // 回填 assistant 的 tool_calls 消息
        messages.push({
          role: 'assistant',
          content: result.content || null,
          tool_calls: result.toolCalls,
        });

        for (const call of result.toolCalls) {
          const name = call.function?.name || '';
          let argsPreview = call.function?.arguments || '{}';
          onEvent({ type: 'tool', name, args: argsPreview });
          logs.info('agent', `调用工具 ${name}`, argsPreview);

          let output = await executeTool(name, call.function?.arguments, {
            userId,
            channel,
            agentId: agent.id,
            sessionId,
            replyTarget: sessionCtx.info.replyTarget,
            speakerId: sessionCtx.info.speakerId,
            scene: sessionCtx.info.scene,
            groupId: sessionCtx.info.groupId,
          });

          // 截图类工具会把画面用 __images 带出来，这里摘成独立消息，
          // 模型下一轮就能"看见"屏幕。
          const picked = extractToolImages(output);
          output = picked.content;

          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: output,
          });

          if (picked.images.length) {
            messages.push({
              role: 'user',
              content: [
                { type: 'text', text: `（这是工具 ${name} 刚返回的画面，请据此判断下一步）` },
                ...picked.images.map((url) => ({ type: 'image_url', image_url: { url } })),
              ],
            });
          }

          onEvent({ type: 'tool_result', name, result: output });
        }

        if (rounds > MAX_TOOL_ROUNDS) {
          finalText = '（已达到工具调用上限，请补充更多信息后重试）';
          onEvent({ type: 'delta', text: finalText });
          break;
        }
        continue;
      }

      finalText += result.content || '';
      break;
    }
  } catch (err) {
    // 若因 tools 参数被服务端拒绝，降级重试一次
    const msg = String(err.message || '');
    const toolRejected = !toolsDisabled && /tool|function|400|invalid/i.test(msg) && rounds === 1;
    if (toolRejected) {
      logs.warn('agent', '模型可能不支持工具调用，降级为纯对话重试');
      toolsDisabled = true;
      rounds = 0;
      try {
        const result = stream
          ? await llm.chatStream({
              provider,
              model: resolveModel(provider, agent.model),
              messages,
              temperature: agent.temperature,
              maxTokens: agent.maxTokens,
              signal,
              onDelta: (d) => onEvent({ type: 'delta', text: d }),
            })
          : await llm.chat({
              provider,
              model: resolveModel(provider, agent.model),
              messages,
              temperature: agent.temperature,
              maxTokens: agent.maxTokens,
              signal,
            });
        finalText = result.content || '';
        usage = result.usage || usage;
      } catch (err2) {
        logs.error('agent', `模型调用失败: ${err2.message}`);
        onEvent({ type: 'error', message: err2.message });
        throw err2;
      }
    } else {
      logs.error('agent', `模型调用失败: ${msg}`);
      onEvent({ type: 'error', message: msg });
      throw err;
    }
  }

  store.appendMessage(sessionId, {
    role: 'assistant',
    content: finalText,
    agentId: agent.id,
  });

  onEvent({ type: 'done', text: finalText, usage, sessionId });

  // 异步提炼长期记忆，不阻塞回复
  if (memCfg.autoExtract !== false && finalText && input.length >= 6) {
    memory
      .extractFromTurn({
        userText: input,
        replyText: finalText,
        agent,
        userId,
        channel,
        provider,
        model: resolveModel(provider, memCfg.model || agent.model),
      })
      .then((facts) => {
        if (facts.length) {
          logs.info('memory', `自动提取 ${facts.length} 条记忆`, facts.map((f) => f.content.slice(0, 24)));
        }
      })
      .catch((err) => logs.warn('memory', `记忆提取失败: ${err.message}`));
  }

  return { sessionId, text: finalText, agentId: agent.id, usage, memories: memoryFacts.length };
}

module.exports = { run, extractToolImages };
