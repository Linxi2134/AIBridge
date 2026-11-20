/* Android 壳的界面裁剪：去掉游戏入口、游戏控制和本地模型设置。 */
(function () {
  'use strict';
  const params = new URLSearchParams(location.search);
  const on = params.get('android') === '1' || /AIBridgeAndroid/i.test(navigator.userAgent);
  if (!on) return;
  window.AIBRIDGE_ANDROID = true;
  document.documentElement.classList.add('android');

  const style = document.createElement('style');
  style.textContent = `
    .android .nav-item[data-route="game"],
    .android .nav-item[data-route="login"] { display: none !important; }
    .android #sttLocalBox, .android [data-prov="local"] { display: none !important; }
    .android #optLlm, .android #optPassive, .android #optPreview { display: none !important; }
  `;
  document.head.appendChild(style);

  // 聊天页的三行开关是 label.row，隐藏 input 不够，连标题一起移除。
  document.addEventListener('DOMContentLoaded', () => {
    for (const id of ['optLlm', 'optPassive', 'optPreview']) {
      const input = document.getElementById(id);
      if (input && input.closest('.row')) input.closest('.row').remove();
    }
  });
})();
