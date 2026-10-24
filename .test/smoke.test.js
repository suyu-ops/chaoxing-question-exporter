// 端到端冒烟测试：在 jsdom 中真实执行整个用户脚本，
// 确认 createPanel 不再因 TDZ 抛错、面板按钮真的绑上了事件。
// 这是针对「所有按钮都点不动」的直接回归。
// 需要：npm i jsdom --no-save
let JSDOM = null;
try { ({ JSDOM } = require('jsdom')); } catch (e) {
  console.log('跳过：未安装 jsdom（npm i jsdom --no-save 后可运行）');
  process.exit(0);
}

const fs = require('fs');
const path = require('path');
const { SRC } = require('./extract');

let failed = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failed++;
    console.log(`✗ ${label}\n   期望: ${JSON.stringify(expected)}\n   实际: ${JSON.stringify(actual)}`);
  } else console.log(`✓ ${label}`);
}

const src = fs.readFileSync(SRC, 'utf8');

// 构造一个足够「像学习通」的页面
const dom = new JSDOM(`<!doctype html><html><head></head><body>
  <div id="coursetree"><div class="posCatalog_select" id="cur1001">1.1 章节</div></div>
  <div id="lessonBody">课程正文</div>
</body></html>`, {
  url: 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=1',
  pretendToBeVisual: true,
  runScripts: 'outside-only'
});

const { window } = dom;
window.Element.prototype.getBoundingClientRect = function () {
  return { width: 360, height: 200, top: 80, left: 900, right: 1260, bottom: 280, x: 900, y: 80, toJSON() { return this; } };
};

// 收集运行时错误
const errors = [];
window.addEventListener('error', e => errors.push('window.onerror: ' + (e.message || e.error)));

// 提供最小 GM API 与浏览器能力
window.GM_getValue = () => '';
window.GM_setValue = () => {};
window.GM_xmlhttpRequest = () => {};
window.GM_getResourceText = () => '';
window.docx = {};
window.html2pdf = () => ({ set: () => ({ from: () => ({ toCanvas: async () => {}, get: async () => null, toPdf: () => ({ save: async () => {} }) }) }) });
window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener: () => {} }));

// jsdom 默认 top === window，脚本的 isInIframe 判定自然为 false，无需改动。

// 执行脚本主体（去掉 userscript 头，避免注释里的 @require 干扰）
const body = src.replace(/^[\s\S]*?\(function \(\) \{/, '(function () {');
let runtimeError = null;
try {
  window.eval(body);
} catch (e) {
  runtimeError = e;
}

check('脚本加载本身不抛错', runtimeError ? String(runtimeError.message) : null, null);

// 手动触发面板创建（脚本内部用 DOMContentLoaded / MutationObserver）
let panelError = null;
try {
  if (typeof window.__xxt_reset_extraction !== 'undefined' || true) {
    // createPanel 是闭包内部函数，这里通过触发事件让脚本自己调用
    window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
    // MutationObserver 是异步的，给一次微任务 + 宏任务
  }
} catch (e) {
  panelError = e;
}
check('触发初始化不抛错', panelError ? String(panelError.message) : null, null);

// 等待 MutationObserver / setTimeout 生效
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  await wait(700);

  const panel = window.document.getElementById('xxt-panel');
  check('面板已创建', !!panel, true);

  if (panel) {
    // 关键：按钮必须存在
    const ids = ['xxt-btnExtract', 'xxt-btnBatchExtract', 'xxt-bankBtn', 'xxt-settingsBtn',
                 'xxt-historyBtn', 'xxt-btnDownload', 'xxt-btnPreview', 'xxt-btnCopy',
                 'xxt-btnEdit', 'xxt-btnSaveToBank'];
    const missing = ids.filter(id => !window.document.getElementById(id));
    check('所有关键按钮都渲染出来', missing, []);

    // 关键：点击不能抛异常（说明事件已绑上，且处理函数不崩）
    const clickErrors = [];
    for (const id of ids) {
      const el = window.document.getElementById(id);
      if (!el) continue;
      try {
        el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
        await wait(30);
      } catch (e) {
        clickErrors.push({ id, error: String(e && e.message || e) });
      }
    }
    check('点击所有主按钮均不抛异常', clickErrors, []);

    // 题库区弹窗：打开后应有统一导出按钮和 AI 面板
    const bankBtn = window.document.getElementById('xxt-bankBtn');
    if (bankBtn) {
      bankBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await wait(120);
      const bankModal = window.document.getElementById('xxt-bank-modal');
      check('题库弹窗已渲染', !!bankModal, true);
      if (bankModal) {
        check('题库区有统一导出按钮', !!bankModal.querySelector('#xxt-bank-export'), true);
        check('题库区有导入题库按钮', !!bankModal.querySelector('#xxt-bank-import'), true);
        check('题库区有 AI 工具面板', !!bankModal.querySelector('#xxt-bank-ai-actions'), true);
        check('AI 面板含补解析按钮', !!bankModal.querySelector('[data-ai-action="fill-explanation"]'), true);
        const okBtns = bankModal.querySelectorAll('#xxt-bank-export, #xxt-bank-import, #xxt-bank-new, #xxt-bank-load');
        check('题库区按钮骨架完整', okBtns.length, 4);
      }
    }

    // 设置弹窗：节奏档位必须渲染
    const settingsBtn = window.document.getElementById('xxt-settingsBtn');
    if (settingsBtn) {
      settingsBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await wait(120);
      const modal = window.document.getElementById('xxt-settings-modal');
      if (modal) {
        check('设置里能选节奏档位', !!modal.querySelector('[data-pacing="safe"]'), true);
        check('设置里有存储占用显示', !!modal.querySelector('#xxt-storage-info'), true);
        check('设置里有 AI 配置入口', !!modal.querySelector('#xxt-ai-settings-btn'), true);
      }
    }
  }

  check('运行期未捕获错误为零', errors, []);

  console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
  process.exit(failed ? 1 : 0);
})();
