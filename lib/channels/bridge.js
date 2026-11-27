'use strict';
/**
 * 渠道操作桥接层
 *
 * 把各渠道的「主动操作」能力统一成一组接口，供 Agent 工具调用。
 * AI 通过这层可以主动发消息、查联系人、查群成员——而不只是被动回复。
 */
const store = require('../store');
const logs = require('../logs');
const onebot = require('./onebot');
const wechat = require('./wechat');
const wecom = require('./wecom');

const CHANNEL_LABELS = {
  onebot: 'QQ（OneBot）',
  wechat: '微信公众号',
  wecom: '企业微信',
  qq: 'QQ 官方机器人',
  web: '网页',
};

// 主动发送限流：防止模型失控刷屏
const sendTimes = [];
const MAX_PER_MINUTE = 20;

function checkRate() {
  const now = Date.now();
  while (sendTimes.length && now - sendTimes[0] > 60000) sendTimes.shift();
  if (sendTimes.length >= MAX_PER_MINUTE) {
    throw new Error(`主动发消息过于频繁（每分钟上限 ${MAX_PER_MINUTE} 条），请稍后再试`);
  }
  sendTimes.push(now);
}

function labelOf(channel) {
  return CHANNEL_LABELS[channel] || channel;
}

/** 各渠道当前支持的能力 */
function capabilities() {
  const cfg = store.getConfig();
  return {
    onebot: {
      enabled: !!cfg.channels.onebot.enabled,
      send: ['private', 'group'],
      listContacts: true,
      listMembers: true,
    },
    wechat: {
      enabled: !!cfg.channels.wechat.enabled,
      send: ['private'],
      listContacts: false,
      listMembers: false,
      note: '只能给 48 小时内互动过的 openid 发消息',
    },
    wecom: {
      enabled: !!cfg.channels.wecom.enabled,
      send: ['private'],
      listContacts: false,
      listMembers: false,
    },
    qq: {
      enabled: !!cfg.channels.qq.enabled,
      send: [],
      listContacts: false,
      listMembers: false,
      note: '官方机器人不支持主动发起会话',
    },
  };
}

/**
 * 主动发送消息
 * @param {object} p
 * @param {string} p.channel    onebot | wechat | wecom
 * @param {string} [p.targetType] private | group
 * @param {string} p.targetId   QQ号 / 群号 / openid / 企微 userid
 * @param {string} p.text
 * @param {string} [p.atUserId] 群聊时 @ 某人
 */
async function send({ channel, targetType = 'private', targetId, text, atUserId }) {
  const ch = String(channel || '').toLowerCase();
  const content = String(text || '').trim();

  if (!content) throw new Error('消息内容为空');
  if (content.length > 1500) throw new Error('消息过长，请控制在 1500 字以内');
  if (!targetId) throw new Error('缺少接收方 ID');

  // 限流必须放在参数/渠道校验之后：以前渠道写错、渠道未启用、
  // 给公众号发「群消息」这类根本发不出去的请求也照样扣一次配额，
  // 连点几次「测试发送」就把一分钟 20 条耗光，真正要发的消息反被拒。
  const channels = store.getConfig().channels;
  if (ch === 'qq') throw new Error('QQ 官方机器人不支持主动发起会话，只能被动回复');
  if (!['onebot', 'wechat', 'wecom'].includes(ch)) {
    throw new Error(`渠道「${channel}」不支持主动发消息`);
  }
  if (ch === 'wechat') {
    if (!channels.wechat.enabled) throw new Error('微信公众号渠道未启用');
    if (targetType === 'group') throw new Error('微信公众号不支持群发，只能给单个 openid 发消息');
  }
  if (ch === 'wecom') {
    if (!channels.wecom.enabled) throw new Error('企业微信渠道未启用');
    if (targetType === 'group') throw new Error('企业微信应用消息不支持群发，请指定单个 userid');
  }
  if (ch === 'onebot' && !channels.onebot.enabled) throw new Error('OneBot 渠道未启用');

  checkRate();

  if (ch === 'onebot') {
    const type = targetType === 'group' ? 'group' : 'private';
    await onebot.sendText({ type, targetId, text: content, atUserId, selfId: channels.onebot.selfId });
    logs.info('bridge', `已向 ${labelOf(ch)} ${type === 'group' ? '群' : ''}${targetId} 发送消息`);
    return { ok: true, channel: ch, targetType: type, targetId };
  }

  if (ch === 'wechat') {
    const ok = await wechat.sendCustomText(targetId, content);
    if (!ok) throw new Error('发送失败，可能是该用户 48 小时内未与公众号互动');
    logs.info('bridge', `已向 ${labelOf(ch)} ${targetId} 发送客服消息`);
    return { ok: true, channel: ch, targetType: 'private', targetId };
  }

  const ok = await wecom.sendText(targetId, content);
  if (!ok) throw new Error('发送失败，请检查 AgentId、可见范围与 userid 是否正确');
  logs.info('bridge', `已向 ${labelOf(ch)} ${targetId} 发送应用消息`);
  return { ok: true, channel: ch, targetType: 'private', targetId };
}

/**
 * 主动发送视频（视频生成结果回传用）。
 *
 * 只有 OneBot 能真的发视频文件；公众号/企微没有「主动发视频」接口，
 * 这里退化成文字 + 链接，并在返回值里标 degraded，别让上层以为视频发出去了。
 */
async function sendVideo({ channel, targetType = 'private', targetId, file, caption = '' }) {
  const ch = String(channel || '').toLowerCase();
  if (!targetId) throw new Error('缺少接收方 ID');
  if (ch === 'onebot') {
    const cfg = store.getConfig().channels.onebot;
    if (!cfg.enabled) throw new Error('OneBot 渠道未启用');
    await onebot.sendVideo({
      type: targetType === 'group' ? 'group' : 'private',
      targetId,
      filePath: file,
      caption,
    });
    return { ok: true, channel: ch, media: 'video' };
  }
  if (ch === 'wechat' || ch === 'wecom') {
    await send({ channel: ch, targetType, targetId, text: caption || '视频已生成，请在网页端查看' });
    return { ok: true, channel: ch, media: 'text', degraded: true };
  }
  throw new Error(`渠道「${channel}」不支持发送视频`);
}

/** 查询好友 / 群列表（仅 OneBot） */
async function listContacts(channel, type) {
  if (channel !== 'onebot') {
    throw new Error('只有 OneBot 11 渠道支持查询联系人与群列表');
  }
  const cfg = store.getConfig().channels.onebot;
  if (!cfg.enabled) throw new Error('OneBot 渠道未启用');

  if (type === 'groups') {
    const items = await onebot.getGroupList();
    return { type: 'groups', count: items.length, items: items.slice(0, 100) };
  }
  const items = await onebot.getFriendList();
  return { type: 'friends', count: items.length, items: items.slice(0, 100) };
}

/** 查询群成员（仅 OneBot） */
async function listGroupMembers(groupId) {
  const cfg = store.getConfig().channels.onebot;
  if (!cfg.enabled) throw new Error('OneBot 渠道未启用');
  if (!groupId) throw new Error('缺少群号');
  const items = await onebot.getGroupMemberList(groupId);
  return { group_id: String(groupId), count: items.length, items: items.slice(0, 100) };
}

/** 删除好友（不可恢复） */
async function deleteFriend(userId) {
  const cfg = store.getConfig().channels.onebot;
  if (!cfg.enabled) throw new Error('OneBot 渠道未启用');
  if (!userId) throw new Error('缺少 QQ 号');
  await onebot.deleteFriend(userId);
  logs.warn('bridge', `已删除好友 ${userId}`);
  return { ok: true, deleted: String(userId) };
}

/** 好友点赞（每人每天 1 次，每日上限 10 次） */
async function likeUser(userId, times) {
  const cfg = store.getConfig().channels.onebot;
  if (!cfg.enabled) throw new Error('OneBot 渠道未启用');
  if (!userId) throw new Error('缺少 QQ 号');
  await onebot.likeUser(userId, times);
  logs.info('bridge', `已给好友 ${userId} 点赞`);
  return { ok: true, liked: String(userId) };
}

/** 查询 QQ 资料 */
async function getUserInfo(userId) {
  const cfg = store.getConfig().channels.onebot;
  if (!cfg.enabled) throw new Error('OneBot 渠道未启用');
  return onebot.getStrangerInfo(userId);
}

module.exports = {
  send,
  sendVideo,
  listContacts,
  listGroupMembers,
  deleteFriend,
  likeUser,
  getUserInfo,
  capabilities,
  labelOf,
  CHANNEL_LABELS,
};
