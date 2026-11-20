'use strict';
/**
 * 聊天小窗
 *
 * 和主界面共用同一个会话（web:admin），所以对话记录两边是同一份；
 * 记忆作用域也一样，设置里绑定 QQ 号以后，跟 QQ 那边就是同一个「你」。
 *
 * 语音链路：
 *   麦克风 → MediaRecorder(webm/opus) → POST /api/voice/stt → 文本 → /api/chat
 *   回复 → POST /api/voice/tts → <audio> 播放
 *
 * 唤醒：常驻监听 → 能量 VAD 切出一句话 → 转文字 → 命中唤醒词才当指令，
 * 没命中直接丢弃（不发给模型，省 token）。
 */
(function () {
  const $ = (id) => document.getElementById(id);

  const S = {
    agentId: null,
    agentName: '爱丽丝',
    userId: 'admin',
    channel: 'web',
    busy: false,
    transcribing: false,
    speaking: false,
    armed: false,
    stt: false,
    tts: false,
    wakeOn: false,
    speakOn: false,
    beepOn: true,
    wakeWord: '爱丽丝',
  };

  // ---------------- 小工具 ----------------

  function setState(text, live) {
    const el = $('state');
    el.textContent = text;
    el.classList.toggle('live', !!live);
  }

  function tip(text) {
    const el = $('tip');
    if (!text) { el.hidden = true; return; }
    el.innerHTML = text;
    el.hidden = false;
  }

  /** tip 的入参会拼服务端返回的文案，进 innerHTML 之前先转义 */
  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function scrollDown() {
    const l = $('list');
    l.scrollTop = l.scrollHeight;
  }

  function bridge(name) {
    const fn = window[name];
    return typeof fn === 'function' ? fn : null;
  }

  // ---------------- 消息渲染 ----------------

  function showEmpty() {
    const l = $('list');
    if (l.children.length) return;
    l.innerHTML = `<div class="empty">
      <b>${S.agentName}</b> 在这儿<br>
      打字直接聊，点麦克风说话<br>
      开了语音唤醒后，喊一声「${S.wakeWord}」就行
    </div>`;
  }

  function addMsg(who, text, opts) {
    const empty = $('list').querySelector('.empty');
    if (empty) empty.remove();

    const wrap = document.createElement('div');
    wrap.className = 'msg ' + (who === 'me' ? 'me' : 'ai');
    const bubble = document.createElement('div');
    bubble.className = 'bubble' + (opts && opts.pending ? ' pending' : '');
    bubble.textContent = text || '';
    wrap.appendChild(bubble);

    const meta = document.createElement('div');
    meta.className = 'meta';
    if (opts && opts.meta) meta.textContent = opts.meta;
    wrap.appendChild(meta);

    $('list').appendChild(wrap);
    scrollDown();
    return bubble;
  }

  // ---------------- 对话 ----------------

  async function send(text) {
    text = String(text || '').trim();
    if (!text || S.busy) return;
    S.busy = true;
    $('btnSend').disabled = true;
    setState('正在回复…');
    addMsg('me', text);
    const bubble = addMsg('ai', '', { pending: true });
    const meta = bubble.parentElement.querySelector('.meta');
    let full = '';

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          channel: S.channel,
          userId: S.userId,
          agentId: S.agentId,
          stream: true,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || 'HTTP ' + res.status);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buf = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const lines = chunk.split('\n');
          // 服务端可能发命名事件（event: session），事件名不会出现在 data: 行里
          const evLine = lines.find((l) => l.startsWith('event:'));
          const eventName = evLine ? evLine.slice(6).trim() : '';
          const line = lines.find((l) => l.startsWith('data:'));
          if (!line) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') continue;
          let evt;
          try { evt = JSON.parse(data); } catch (_) { continue; }

          // 会话控制帧不是正文，别当增量拼进气泡
          if (eventName === 'session' || evt.type === 'session' || evt.type === 'start') continue;

          if (evt.type === 'delta') {
            bubble.classList.remove('pending');
            full += evt.text;
            bubble.textContent = full;
            scrollDown();
          } else if (evt.type === 'tool') {
            meta.textContent = '用了一下「' + evt.name + '」';
          } else if (evt.type === 'memory') {
            meta.textContent = '想起了 ' + evt.count + ' 件事';
          } else if (evt.type === 'error') {
            bubble.classList.remove('pending');
            bubble.textContent = full || ('出错了：' + evt.message);
          }
        }
      }

      bubble.classList.remove('pending');
      if (!full) bubble.textContent = '（模型没有返回内容——多半是模型名填错或额度用尽，去「日志」页看具体报错）';
    } catch (err) {
      bubble.classList.remove('pending');
      bubble.textContent = '请求失败：' + err.message;
    } finally {
      S.busy = false;
      $('btnSend').disabled = false;
      setState(S.wakeOn ? '在听（说「' + S.wakeWord + '」）' : '就绪', S.wakeOn);
    }

    if (full && S.speakOn) speak(full);
  }

  // ---------------- 提示音 ----------------

  let beepCtx = null;

  /**
   * 用 WebAudio 现场合成，不依赖任何音频文件，也不需要配 TTS。
   * 唤醒时如果没配 TTS，「我在」是没声音的，光靠这个音让人知道它听见了。
   */
  function beep(kind) {
    if (!S.beepOn) return;
    try {
      beepCtx = beepCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (beepCtx.state === 'suspended') beepCtx.resume();
      const now = beepCtx.currentTime;
      // 上扬＝唤醒成功 / 短促＝开始录音 / 下降＝没听清
      const seq = kind === 'up' ? [[784, 0], [1175, 0.11]]
        : kind === 'down' ? [[520, 0], [392, 0.12]]
          : [[880, 0]];
      for (const [freq, delay] of seq) {
        const osc = beepCtx.createOscillator();
        const gain = beepCtx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        const t0 = now + delay;
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.exponentialRampToValueAtTime(0.14, t0 + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.15);
        osc.connect(gain);
        gain.connect(beepCtx.destination);
        osc.start(t0);
        osc.stop(t0 + 0.2);
      }
    } catch (_) { /* 播不出声不影响功能 */ }
  }

  // ---------------- 录音 / 识别 ----------------

  let micStream = null;
  let audioCtx = null;
  let analyser = null;
  let sampleBuf = null;
  let wakeTimer = null;
  let wake = null;      // { noise, hot, utt, silentAt }
  let manual = null;    // 手动录音句柄

  async function getStream() {
    if (micStream && micStream.getTracks().every((t) => t.readyState === 'live')) return micStream;
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    return micStream;
  }

  /** 开一段录音，返回 { stop(), done: Promise<Blob> }
   *
   *  直接录 16kHz 单声道 PCM 并自己封 WAV，不走 MediaRecorder。
   *  原因：webm/opus 送到服务端还得用 ffmpeg 转一遍，实测这一趟要 0.6~1 秒，
   *  比 SenseVoice 推理本身（0.3 秒）还贵。录成 WAV 后服务端能直接用。
   */
  // 录音用的 AudioContext 只建一次，反复 close 会撞上浏览器「每页最多 6 个」的限制，
  // 唤醒模式下几次就哑了。
  let recCtx = null;

  function getRecCtx() {
    if (!recCtx || recCtx.state === 'closed') {
      recCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    }
    // 关键：新建的 AudioContext 可能是 suspended，不 resume 的话
    // onaudioprocess 一次都不触发，录出来是 44 字节的空 WAV —— 表现就是「语音输入没反应」
    if (recCtx.state === 'suspended') recCtx.resume().catch(() => {});
    return recCtx;
  }

  function record(maxMs) {
    const ctx = getRecCtx();
    const src = ctx.createMediaStreamSource(micStream);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const mute = ctx.createGain();
    mute.gain.value = 0;   // 必须连到 destination 才会持续触发，但音量归零避免回授

    const chunks = [];
    let stopped = false;

    proc.onaudioprocess = (e) => {
      if (stopped) return;
      chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    };
    src.connect(proc);
    proc.connect(mute);
    mute.connect(ctx.destination);

    let resolveDone;
    const done = new Promise((r) => { resolveDone = r; });
    const rate = ctx.sampleRate;

    const finish = () => {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      try { proc.disconnect(); src.disconnect(); mute.disconnect(); } catch (_) {}
      resolveDone(encodeWav(chunks, rate));
    };

    const timer = setTimeout(finish, maxMs);
    return { stop: finish, done, sampleRate: rate };
  }

  /** Float32 分片 → 16bit PCM WAV */
  function encodeWav(chunks, sampleRate) {
    let len = 0;
    for (const c of chunks) len += c.length;
    const buf = new ArrayBuffer(44 + len * 2);
    const view = new DataView(buf);
    const w = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };

    w(0, 'RIFF');
    view.setUint32(4, 36 + len * 2, true);
    w(8, 'WAVE');
    w(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);          // PCM
    view.setUint16(22, 1, true);          // 单声道
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    w(36, 'data');
    view.setUint32(40, len * 2, true);

    let off = 44;
    for (const c of chunks) {
      for (let i = 0; i < c.length; i++) {
        const s = Math.max(-1, Math.min(1, c[i]));
        view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        off += 2;
      }
    }
    return new Blob([buf], { type: 'audio/wav' });
  }

  async function transcribe(blob) {
    // 16k 单声道 16bit：0.1 秒才 3.2KB，低于 4KB 基本就是没录到东西
    if (!blob || blob.size < 4000) return '';
    const res = await fetch('/api/voice/stt', {
      method: 'POST',
      headers: { 'Content-Type': blob.type || 'audio/wav' },
      body: blob,
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || '识别失败');
    return String(j.text || '').trim();
  }

  /**
   * 唤醒词匹配，分三层，从严到松：
   *   1. 原词 + 字间允许标点空格
   *   2. 同音字（STT 最常犯的错：爱丽丝 → 艾莉丝 / 爱丽思）
   *   3. 编辑距离 ≤1 的模糊匹配（处理非同音的错字）
   * 只在前两层都没命中时才走第三层，避免把正常说话误判成唤醒。
   */
  const HOMOPHONES = [
    ['爱', '艾', '唉', '哎', '暧', '嗳'],
    ['丽', '莉', '俐', '俪', '琍', '厉', '立'],
    ['丝', '思', '斯', '厮', '撕', '司', '私'],
    ['小', '晓', '筱', '肖'],
    ['美', '梅', '酶', '每', '镁'],
    ['冰', '兵', '并', '饼'],
  ];

  function escapeRe(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function homophonesOf(ch) {
    const g = HOMOPHONES.find((x) => x.includes(ch));
    return g || [ch];
  }

  /** 同音字 + 字间标点容错的正则 */
  function fuzzyPattern(word) {
    const parts = [...word].map((c) => {
      const g = homophonesOf(c);
      return g.length > 1 ? `(?:${g.map(escapeRe).join('|')})` : escapeRe(c);
    });
    return new RegExp(parts.join('[\\s，,。.、！!？?；;：:]*'));
  }

  const PUNCT = /[\s，,。.、！!？?；;：:、"'“”‘’（）()【】\[\]—…·]/;

  /** 去掉标点并把剩余字符映射回原串下标，模糊匹配用 */
  function normalizeWithMap(text) {
    const chars = [];
    const map = [];
    for (let i = 0; i < text.length; i++) {
      if (PUNCT.test(text[i])) continue;
      chars.push(text[i]);
      map.push(i);
    }
    return { norm: chars.join(''), map };
  }

  /**
   * 在 text 里找与 word 编辑距离最小的子串（允许任意起点）。
   * 返回原串坐标 { start, end }，找不到或差距太大返回 null。
   */
  function fuzzyFind(text, word, maxDist) {
    const w = [...word];
    const m = w.length;
    if (!m) return null;

    const { norm, map } = normalizeWithMap(text);
    const t = [...norm];
    if (!t.length) return null;

    // prev[j] = 用 t 的前 i 个字符去匹配 w 的前 j 个字符的代价。
    // 起始行按 0..m 递增（必须把整个唤醒词匹配完），而每行的第 0 列固定为 0
    // —— 这一列才是「可以从任意位置开始」的来源。
    // （如果起始行也全 0，等于允许只匹配唤醒词的后半截，「意思」就会被当成「丽丝」）
    let prev = new Array(m + 1).fill(0).map((_, j) => j);
    let best = { dist: Infinity, end: -1 };

    for (let i = 1; i <= t.length; i++) {
      const cur = new Array(m + 1).fill(0);
      for (let j = 1; j <= m; j++) {
        const cost = t[i - 1] === w[j - 1] ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      }
      // 用 <= 而不是 <：代价相同时取更靠后的终点，也就是覆盖更长的原文区间。
      // 否则「爱丽四」会在第 2 个字就以「爱丽 + 删掉丝」的代价 1 命中，
      // 区间长度不够又被下面的长度检查否掉，等于白算。
      if (cur[m] <= best.dist) best = { dist: cur[m], end: i };
      prev = cur;
    }

    if (best.dist > maxDist || best.end < 0) return null;

    // 匹配到的原文区间必须够长：短于唤醒词长度的都是「只对上一半」，宁可漏判
    const startN = Math.max(0, best.end - m);
    if (best.end - startN < m) return null;

    return { start: map[startN], end: map[best.end - 1] + 1 };
  }

  function splitWake(text) {
    const raw = String(text || '');

    // 1) 原词 / 2) 同音字
    for (const re of [fuzzyPattern(S.wakeWord)]) {
      const m = raw.match(re);
      if (m) {
        const rest = (raw.slice(0, m.index) + raw.slice(m.index + m[0].length))
          .replace(/^[\s，,。.！!？?、]+/, '').trim();
        return { hit: true, rest };
      }
    }

    // 3) 编辑距离 ≤1（两字以内的唤醒词太容易误判，不启用）
    if ([...S.wakeWord].length >= 3) {
      const hit = fuzzyFind(raw, S.wakeWord, 1);
      if (hit) {
        const rest = (raw.slice(0, hit.start) + raw.slice(hit.end))
          .replace(/^[\s，,。.！!？?、]+/, '').trim();
        return { hit: true, rest };
      }
    }

    return { hit: false, rest: raw };
  }

  async function handleUtterance(blob, direct) {
    S.transcribing = true;
    setState('正在识别…');
    try {
      const text = await transcribe(blob);
      if (!text) { setState(wakeText(), S.wakeOn); return; }

      if (direct) {
        // 手动说话时如果也喊了名字，别把「爱丽丝」当成正文发过去
        const w = splitWake(text);
        await send(w.hit && w.rest ? w.rest : text);
        return;
      }

      const { hit, rest } = splitWake(text);
      if (!hit) {
        // 没喊名字：只有刚被唤醒的 12 秒内才当指令
        if (S.armed) { S.armed = false; await send(text); }
        else setState(wakeText(), S.wakeOn);
        return;
      }
      if (rest) { beep('up'); await send(rest); return; }

      // 只喊了名字：先给个听觉反馈（没配 TTS 时这就是唯一的「我在」），再应一声
      beep('up');
      S.armed = true;
      setTimeout(() => { S.armed = false; }, 12000);
      await speak('我在');
      setState('在听，说吧…', true);
    } catch (err) {
      setState('识别失败');
      beep('down');
      tip('语音识别失败：' + err.message);
      setTimeout(() => setState(wakeText(), S.wakeOn), 2500);
    } finally {
      S.transcribing = false;
    }
  }

  function wakeText() {
    return S.wakeOn ? '在听（说「' + S.wakeWord + '」）' : '就绪';
  }

  // ---------------- 手动说话 ----------------

  async function toggleMic() {
    if (!S.stt) { tip('语音识别还没启用，先去「语音」页配置 STT 服务'); return; }
    if (manual) { manual.stop(); return; }

    try { await getStream(); } catch (err) {
      tip('拿不到麦克风：' + err.message + '（检查系统麦克风权限）');
      return;
    }

    tip('');
    const rec = record(60000);
    manual = rec;
    beep('tick');
    $('btnMic').classList.add('rec');
    setState('正在听…说完点一下结束');

    const blob = await rec.done;
    manual = null;
    $('btnMic').classList.remove('rec');
    if (!blob || blob.size < 4000) {
      setState('就绪');
      beep('down');
      tip('没录到声音——检查麦克风是否被别的程序占用、或者系统里被静音了');
      return;
    }
    await handleUtterance(blob, true);
  }

  // ---------------- 语音唤醒 ----------------

  async function startWake() {
    if (!S.stt) {
      tip('语音唤醒需要 STT 服务：去「语音」页填一个 Whisper 兼容接口的 Base URL 和 Key');
      return false;
    }
    try { await getStream(); } catch (err) {
      tip('拿不到麦克风：' + err.message);
      return false;
    }

    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') await audioCtx.resume();

    if (!analyser) {
      const src = audioCtx.createMediaStreamSource(micStream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.55;
      src.connect(analyser);
      sampleBuf = new Float32Array(analyser.fftSize);
    }

    wake = { noise: 0.004, hot: 0, utt: null, silentAt: 0 };
    if (wakeTimer) clearInterval(wakeTimer);
    wakeTimer = setInterval(tick, 100);
    setState(wakeText(), true);
    return true;
  }

  function stopWake() {
    // 关唤醒就真的把麦克风放开：否则地址栏的录制标志一直亮着，
    // 用户会以为程序在后台偷听。录音用的上下文留着复用（见 getRecCtx 的注释）。
    releaseAudio({ keepRecCtx: true });
    setState('就绪');
  }

  /**
   * 释放麦克风与音频上下文。
   *
   * 之前只在「停下唤醒」里清定时器，track 和 AudioContext 一路挂着：
   * 窗口关了、页面切走了，系统里仍然是「某程序正在录音」，
   * 手机上还会占着麦克风通道，别的 App 录不了音。
   * 这里按从重到轻的顺序收，任何一步失败都不该拦住后面的释放。
   */
  function releaseAudio(opts) {
    const keepRecCtx = !!(opts && opts.keepRecCtx);

    if (wakeTimer) clearInterval(wakeTimer);
    wakeTimer = null;

    if (wake && wake.utt) { try { wake.utt.stop(); } catch (_) { /* 已经收尾过 */ } }
    wake = null;
    if (manual) { try { manual.stop(); } catch (_) { /* 已经收尾过 */ } }
    manual = null;

    const btnMic = $('btnMic');
    if (btnMic) btnMic.classList.remove('rec');
    const btnWake = $('btnWake');
    if (btnWake) btnWake.classList.remove('rec');

    // 麦克风指示灯只认 track，必须显式 stop，光丢引用不会熄
    if (micStream) {
      try { micStream.getTracks().forEach((t) => t.stop()); } catch (_) { /* 已经被浏览器收回 */ }
      micStream = null;
    }

    analyser = null;
    sampleBuf = null;

    if (audioCtx) {
      try { if (audioCtx.state !== 'closed') audioCtx.close(); } catch (_) { /* 关不掉就算了 */ }
      audioCtx = null;
    }
    if (beepCtx) {
      try { if (beepCtx.state !== 'closed') beepCtx.close(); } catch (_) { /* 关不掉就算了 */ }
      beepCtx = null;
    }
    // 录音上下文默认一起关；切页签这种短暂离开时保留，避免反复新建撞上数量上限
    if (!keepRecCtx && recCtx) {
      try { if (recCtx.state !== 'closed') recCtx.close(); } catch (_) { /* 关不掉就算了 */ }
      recCtx = null;
    }
  }

  /** 100ms 一次：算能量 → 判有没有人在说话 → 切句 */
  function tick() {
    if (!wake || !analyser) return;
    // 自己在说话、或在等回复时不采集，否则会把喇叭里的声音当成指令
    if (S.speaking || S.busy || S.transcribing) return;

    analyser.getFloatTimeDomainData(sampleBuf);
    let sum = 0;
    for (let i = 0; i < sampleBuf.length; i++) sum += sampleBuf[i] * sampleBuf[i];
    const rms = Math.sqrt(sum / sampleBuf.length);
    const now = performance.now();

    if (!wake.utt) {
      // 噪声地板只在安静时更新，不然一说话阈值就被抬上去，后面就听不见了
      if (rms < wake.noise * 1.8) wake.noise = wake.noise * 0.97 + rms * 0.03;
      const thr = Math.max(0.012, wake.noise * 3);
      if (rms > thr) {
        if (++wake.hot >= 2) {
          wake.utt = record(9000);
          wake.silentAt = 0;
          $('btnWake').classList.add('rec');
        }
      } else {
        wake.hot = 0;
      }
      return;
    }

    const stopThr = Math.max(0.01, wake.noise * 2.2);
    if (rms > stopThr) wake.silentAt = 0;
    else if (!wake.silentAt) wake.silentAt = now;

    if (wake.silentAt && now - wake.silentAt > 800) {
      const u = wake.utt;
      wake.utt = null;
      wake.hot = 0;
      $('btnWake').classList.remove('rec');
      u.stop();
      u.done.then((blob) => handleUtterance(blob, false)).catch(() => {});
    }
  }

  // ---------------- 播报 ----------------

  async function speak(text) {
    if (!S.tts || !text) return;
    S.speaking = true;
    try {
      const res = await fetch('/api/voice/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: String(text).slice(0, 500) }),
      });
      if (!res.ok) throw new Error('tts');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      await new Promise((resolve) => {
        audio.onended = resolve;
        audio.onerror = resolve;
        audio.play().catch(resolve);
      });
      URL.revokeObjectURL(url);
    } catch (_) {
      /* 播报失败不打断对话 */
    } finally {
      S.speaking = false;
    }
  }

  // ---------------- 开关 ----------------

  async function setWake(on) {
    const btn = $('btnWake');
    if (on) {
      const ok = await startWake();
      if (!ok) { btn.classList.remove('on'); $('optWake').checked = false; return; }
    } else {
      stopWake();
    }
    S.wakeOn = on;
    btn.classList.toggle('on', on);
    $('optWake').checked = on;
    localStorage.setItem('aibridge.chat.wake', on ? '1' : '0');
  }

  function setSpeak(on) {
    S.speakOn = on;
    $('btnSpeak').classList.toggle('on', on);
    $('optSpeak').checked = on;
    localStorage.setItem('aibridge.chat.speak', on ? '1' : '0');
  }

  function setBeep(on) {
    S.beepOn = on;
    $('optBeep').checked = on;
    localStorage.setItem('aibridge.chat.beep', on ? '1' : '0');
  }

  /**
   * 全局快捷键（Ctrl+Alt+J）由启动器 Eval 进来：
   * 没在录音就开始，正在录就结束——一个键当开关用。
   */
  window.__startVoice = function () {
    if (S.busy) return;
    if (manual) { manual.stop(); return; }
    toggleMic();
  };

  /**
   * 「只看不点」：给游戏窗口加 WS_EX_TRANSPARENT | WS_EX_NOACTIVATE。
   *
   * 效果：画面照常实时渲染（真实游戏画面，不是截图），
   * 但点它不夺焦点、MC 也不会锁鼠标——鼠标可以一直待在别的程序里。
   * 关掉就恢复正常，可以自己进去玩。
   */
  async function setPassive(on) {
    try {
      const r = await fetch('/api/mc/passive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ on, title: 'Minecraft' }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || '设置失败');
      // chat 窗是独立页面，没有 Core.toast；提示条才是这里的既有反馈方式
      tip(esc(on ? '游戏窗口已设为「只看不点」' : '已恢复正常，可以自己玩了'));
    } catch (err) {
      tip(esc('设置失败：' + err.message));
      const el = $('optPassive');
      if (el) el.checked = !on;
    }
  }

  // ---------------- AI 画面预览 ----------------

  let previewTimer = null;

  /**
   * 把游戏画面拉到聊天窗里。
   *
   * 用途：一边看 AI 在游戏里干什么，一边鼠标自由地用别的程序——
   * 不用切回游戏窗口（切回去 MC 就锁鼠标了）。
   *
   * 每 700ms 抓一张，服务端走 /api/mc/frame 转发给 mod 的 /frame（mod 里是 Screenshot.grab）。
   */
  async function setPreview(on) {
    const box = $('preview');
    box.hidden = !on;
    if (previewTimer) { clearInterval(previewTimer); previewTimer = null; }

    // 抓帧由服务端的 mcFrames 负责（窗口截图 → JPEG 缓存），开关时通知它启停
    try {
      await fetch('/api/mc/frames', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ on, title: 'Minecraft' }),
      });
    } catch (_) { /* 服务没起来就先不管 */ }

    if (!on) return;

    const tick = () => {
      const img = $('previewImg');
      if (img) img.src = '/api/mc/frame?t=' + Date.now();
    };
    tick();
    previewTimer = setInterval(tick, 600);
  }

  // ---------------- 本地模型开关 ----------------

  async function refreshLlm() {
    try {
      const st = await (await fetch('/api/llm/status')).json();
      const box = $('optLlm');
      box.checked = Boolean(st.ready);
      box.disabled = !st.installed;
      box.title = st.installed ? '' : '没装本地模型';
    } catch (_) { /* 服务没起来就先不管 */ }
  }

  async function toggleLlm(on) {
    tip(on ? '正在启动本地模型…首次约 10 秒' : '正在停止…');
    try {
      const r = await (await fetch(on ? '/api/llm/start' : '/api/llm/stop', { method: 'POST' })).json();
      if (on && !r.ok) throw new Error(r.error || '启动失败');
      $('optLlm').checked = Boolean(r.ready);
      tip(on ? `本地模型就绪（端口 ${r.port}）` : '本地模型已停止');
    } catch (err) {
      $('optLlm').checked = !on;
      tip('本地模型：' + err.message);
    }
  }

  // ---------------- 启动 ----------------

  async function init() {
    // 顶栏拖动
    $('bar').addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      const drag = bridge('winDrag');
      if (drag) drag();
    });
    $('btnClose').addEventListener('click', async () => {
      // 关窗前先收音频：窗口只是被隐藏，页面还在跑，不主动放就会一直占着麦克风
      if (S.wakeOn) await setWake(false);
      releaseAudio();
      const hide = bridge('winHide');
      if (hide) hide();
      else window.close();
    });

    // 输入
    const input = $('input');
    const grow = () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 96) + 'px';
    };
    input.addEventListener('input', grow);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const t = input.value;
        input.value = '';
        grow();
        send(t);
      }
    });
    $('btnSend').addEventListener('click', () => {
      const t = input.value;
      input.value = '';
      grow();
      send(t);
    });
    $('btnMic').addEventListener('click', toggleMic);
    $('btnWake').addEventListener('click', () => setWake(!S.wakeOn));
    $('btnSpeak').addEventListener('click', () => setSpeak(!S.speakOn));

    // 更多菜单
    const menu = $('menu');
    $('btnMore').addEventListener('click', (e) => {
      e.stopPropagation();
      menu.hidden = !menu.hidden;
    });
    document.addEventListener('click', (e) => {
      if (!menu.hidden && !menu.contains(e.target) && e.target !== $('btnMore')) menu.hidden = true;
    });
    $('optWake').addEventListener('change', (e) => setWake(e.target.checked));
    $('optSpeak').addEventListener('change', (e) => setSpeak(e.target.checked));
    $('optBeep').addEventListener('change', (e) => setBeep(e.target.checked));
    $('optLlm').addEventListener('change', (e) => toggleLlm(e.target.checked));
    $('optPassive').addEventListener('change', (e) => setPassive(e.target.checked));
    $('optPreview').addEventListener('change', (e) => setPreview(e.target.checked));
    refreshLlm();
    $('optWord').addEventListener('change', (e) => {
      S.wakeWord = (e.target.value || '爱丽丝').trim().slice(0, 8) || '爱丽丝';
      e.target.value = S.wakeWord;
      localStorage.setItem('aibridge.chat.word', S.wakeWord);
      if (S.wakeOn) setState(wakeText(), true);
    });
    $('optMain').addEventListener('click', () => {
      const open = bridge('openMain');
      if (open) open();
      menu.hidden = true;
    });
    $('optVoice').addEventListener('click', () => {
      const open = bridge('openMain');
      if (open) open();
      menu.hidden = true;
      tip('在管理面板左侧「语音」页配置 STT / TTS');
    });

    // 配置
    let cfg = null;
    try {
      cfg = await (await fetch('/api/config')).json();
    } catch (_) {
      setState('连不上服务');
      tip('连不上本地服务（8787）。可能刚被停掉了，托盘里点「重启服务」试试。');
      return;
    }

    const agent = (cfg.agents || []).find((a) => a.id === cfg.routing?.defaultAgentId) || (cfg.agents || [])[0];
    if (agent) {
      S.agentId = agent.id;
      S.agentName = agent.name;
      $('name').textContent = agent.name;
      $('avatar').textContent = agent.name.slice(0, 1);
    }

    S.stt = !!(cfg.voice && cfg.voice.stt && cfg.voice.stt.enabled);
    S.tts = !!(cfg.voice && cfg.voice.tts && cfg.voice.tts.enabled);

    S.wakeWord = localStorage.getItem('aibridge.chat.word') || '爱丽丝';
    $('optWord').value = S.wakeWord;

    // 默认值：STT 没配就别把麦克风按钮做成「能按但没用」
    $('btnMic').classList.toggle('off', !S.stt);
    $('btnWake').classList.toggle('off', !S.stt);

    setSpeak(localStorage.getItem('aibridge.chat.speak') === '1' && S.tts);
    setBeep(localStorage.getItem('aibridge.chat.beep') !== '0');

    if (!S.stt) {
      tip('语音识别未启用：管理面板 →「语音」页填 STT 接口后，麦克风和唤醒才可用。<a id="tipGo">去配置</a>');
      const go = $('tipGo');
      if (go) go.addEventListener('click', () => {
        const open = bridge('openMain');
        if (open) open();
      });
    }

    await loadHistory();
    showEmpty();
    setState('就绪');

    // 上次开着唤醒就接着开（浏览器要求用户手势才能起音频，失败就静默放弃）
    if (localStorage.getItem('aibridge.chat.wake') === '1' && S.stt) {
      setWake(true).catch(() => {});
    }

    // 告诉启动器「页面好了」。它可能攒着一个快捷键请求在等这一刻
    const ready = bridge('chatReady');
    if (ready) ready();
  }

  async function loadHistory() {
    try {
      const res = await fetch('/api/sessions/' + encodeURIComponent(S.channel + ':' + S.userId));
      if (!res.ok) return;
      const s = await res.json();
      const list = (s.messages || []).filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.content).slice(-40);
      for (const m of list) addMsg(m.role === 'user' ? 'me' : 'ai', m.content);
    } catch (_) { /* 没历史也不影响 */ }
  }

  // 页面被切走或卸载时释放音频资源。
  // 唤醒模式开着时不收麦克风：那正是用户要的「后台一直听着」，
  // 硬收会让界面显示「在听」而实际已经聋了。
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden') return;
    if (S.wakeOn || manual) return;
    releaseAudio({ keepRecCtx: true });
  });

  // 真卸载时连录音上下文一起关，页面都没了没有再复用的必要
  window.addEventListener('pagehide', () => releaseAudio());
  window.addEventListener('beforeunload', () => releaseAudio());

  init().catch((err) => {
    setState('出错了');
    tip('初始化失败：' + err.message);
  });
})();
