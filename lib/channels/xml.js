'use strict';
/** 微信系协议使用的最小 XML 工具，避免引入第三方依赖。 */

/** 解析扁平 XML（不支持同名嵌套），返回普通对象 */
function parseXml(xml) {
  const out = {};
  if (!xml) return out;
  const src = String(xml);
  const re = /<([A-Za-z_][\w.-]*)>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))<\/\1>/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const key = m[1];
    if (key === 'xml') continue;
    out[key] = m[2] !== undefined ? m[2] : m[3];
  }
  return out;
}

function cdata(value) {
  const safe = String(value === undefined || value === null ? '' : value)
    .replace(/]]>/g, ']]]]><![CDATA[>');
  return `<![CDATA[${safe}]]>`;
}

/** 构造文本回复 XML */
function buildTextReply({ toUser, fromUser, content, createTime }) {
  return `<xml>
<ToUserName>${cdata(toUser)}</ToUserName>
<FromUserName>${cdata(fromUser)}</FromUserName>
<CreateTime>${createTime || Math.floor(Date.now() / 1000)}</CreateTime>
<MsgType>${cdata('text')}</MsgType>
<Content>${cdata(content)}</Content>
</xml>`;
}

module.exports = { parseXml, cdata, buildTextReply };
