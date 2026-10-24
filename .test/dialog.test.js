// “任务点未完成”弹层检测回归。
// 关键点：学习通这个弹窗**没有** layui / artDialog 之类的稳定 class
// （截图：白底圆角卡片 + “提示” + “去学习 / 下一节”），
// 旧实现按类名查必然漏，这里用真实结构验证文本锚点方案。
// 需要：npm i jsdom --no-save
let JSDOM = null;
try { ({ JSDOM } = require('jsdom')); } catch (e) {
  console.log('跳过：未安装 jsdom（npm i jsdom --no-save 后可运行）');
  process.exit(0);
}

const fs = require('fs');
const path = require('path');
const { buildModule } = require('./extract');

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
const { window } = dom;
global.window = window;
global.document = window.document;
global.Node = window.Node;
global.MouseEvent = window.MouseEvent;

const prelude = [
  'const unsafeWindow = undefined;',
  'const XXT_BLOCKING_LAYER_TEXT = /还有任务点未完成|任务点未完成|是否去完成|尚未完成/;',
  'const XXT_BLOCKING_LAYER_IGNORE = /#xxt-panel|#xxt-.*-modal|#xxt-batch-progress-card/;',
  'function collectBatchCatalogDocuments(){ return [document]; }',
  'function getBatchHostWindows(){ return [window]; }',
  'function appendBatchLog(msg){ global.__logs = global.__logs || []; global.__logs.push(msg); }',
  'function batchSleep(ms){ return new Promise(r=>setTimeout(r,ms)); }',
  'function findBatchNativeNextButton(){ return null; }'
].join('\n');

const code = buildModule({
  normalizeBatchText: 'normalizeBatchText',
  findBatchBlockingAnchors: 'findBatchBlockingAnchors',
  resolveBatchBlockingDialog: 'resolveBatchBlockingDialog',
  findBatchBlockingDialog: 'findBatchBlockingDialog',
  isBatchNodeVisible: 'isBatchNodeVisible',
  findBatchDialogNextButton: 'findBatchDialogNextButton',
  clickBatchBlockingDialogNext: 'clickBatchBlockingDialogNext'
}, prelude);

const modulePath = path.join(__dirname, '.build-dialog2.js');
fs.writeFileSync(modulePath, code);
const M = require(modulePath);

let failed = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failed++;
    console.log(`✗ ${label}\n   期望: ${JSON.stringify(expected)}\n   实际: ${JSON.stringify(actual)}`);
  } else console.log(`✓ ${label}`);
}

// jsdom 没有布局引擎，getBoundingClientRect 恒为 0，会让可见性判断全部为 false。
// 这里统一给所有元素一个非零矩形；display:none / visibility:hidden 仍由
// isBatchNodeVisible 内部的 computedStyle 判断（jsdom 支持行内样式计算）。
const ELEMENT_SIZE = { width: 420, height: 220 };
window.Element.prototype.getBoundingClientRect = function () {
  return {
    width: ELEMENT_SIZE.width, height: ELEMENT_SIZE.height,
    top: 300, left: 600, right: 600 + ELEMENT_SIZE.width, bottom: 300 + ELEMENT_SIZE.height,
    x: 600, y: 300, toJSON() { return this; }
  };
};
function stubRect() { /* 兼容旧调用：矩形已全局 stub，无需单独设置 */ }

// ===== 场景 A：完全复刻截图的结构，无任何框架类名 =====
document.body.innerHTML = `
  <div id="app">
    <div class="course-page">章节测验内容</div>
    <div class="mask" id="mask"></div>
    <div id="popup-1" style="position:fixed;background:#fff;border-radius:12px;">
      <div class="hd"><span>提示</span><a class="x">×</a></div>
      <div class="bd">当前章节还有任务点未完成，是否去完成？</div>
      <div class="ft">
        <a id="goStudy" style="border-radius:999px;">去学习</a>
        <a id="nextOne" style="border-radius:999px;">下一节</a>
      </div>
    </div>
  </div>`;
stubRect(document.querySelector('#popup-1'));

let clicked = [];
document.querySelector('#goStudy').addEventListener('click', () => clicked.push('去学习'));
document.querySelector('#nextOne').addEventListener('click', () => clicked.push('下一节'));

check('无类名弹窗：能检出', !!M.findBatchBlockingDialog(window), true);
check('无类名弹窗：能点到“下一节”', M.clickBatchBlockingDialogNext(window), true);
check('无类名弹窗：绝不点“去学习”', clicked, ['下一节']);

// ===== 场景 B：按钮是 <button><span>下一节</span></button> 嵌套 =====
document.body.innerHTML = `
  <div id="popup-2">
    <div>当前章节还有任务点未完成，是否去完成？</div>
    <button id="go2">去学习</button>
    <button id="next2"><span>下一节</span></button>
  </div>`;
stubRect(document.querySelector('#popup-2'));
clicked = [];
document.querySelector('#go2').addEventListener('click', () => clicked.push('去学习'));
document.querySelector('#next2').addEventListener('click', () => clicked.push('下一节'));
check('嵌套 span 按钮能点中', M.clickBatchBlockingDialogNext(window), true);
check('嵌套 span 不点去学习', clicked, ['下一节']);

// ===== 场景 C：弹窗里有额外“下一节”文字干扰（正文提到“下一节”）=====
document.body.innerHTML = `
  <div id="popup-3">
    <div>当前章节还有任务点未完成，是否去完成？点击"下一节"可跳过。</div>
    <button id="go3">去学习</button>
    <button id="next3">下一节</button>
  </div>`;
stubRect(document.querySelector('#popup-3'));
clicked = [];
document.querySelector('#go3').addEventListener('click', () => clicked.push('去学习'));
document.querySelector('#next3').addEventListener('click', () => clicked.push('下一节'));
check('正文含“下一节”时仍点按钮', M.clickBatchBlockingDialogNext(window), true);
check('正文干扰下不点去学习', clicked, ['下一节']);

// ===== 场景 D：页面本身有“下一节”按钮，但没弹窗 → 不应误点 =====
document.body.innerHTML = `
  <div id="lessonBody">
    <button id="prevNextFocusNext">下一节</button>
  </div>`;
stubRect(document.querySelector('#lessonBody'));
clicked = [];
document.querySelector('#prevNextFocusNext').addEventListener('click', () => clicked.push('页面下一节'));
check('无弹窗时不误点页面按钮', M.clickBatchBlockingDialogNext(window), false);
check('无弹窗时零点击', clicked, []);

// ===== 场景 E：隐藏弹窗不处理 =====
document.body.innerHTML = `
  <div id="popup-4" style="display:none;">
    <div>当前章节还有任务点未完成</div>
    <button id="next4">下一节</button>
  </div>`;
stubRect(document.querySelector('#popup-4'));
check('隐藏弹窗不处理', M.clickBatchBlockingDialogNext(window), false);

// ===== 场景 F：无关弹窗不误触 =====
document.body.innerHTML = `
  <div id="popup-5">
    <div>确定删除该笔记吗？</div>
    <button id="ok5">确定</button>
    <button id="next5">下一节</button>
  </div>`;
stubRect(document.querySelector('#popup-5'));
check('无关弹窗不处理', M.clickBatchBlockingDialogNext(window), false);

// ===== 场景 G：不能把脚本自己的面板当弹窗 =====
document.body.innerHTML = `
  <div id="xxt-panel">
    <div>当前章节还有任务点未完成，是否去完成？</div>
    <button id="selfNext">下一节</button>
  </div>`;
stubRect(document.querySelector('#xxt-panel'));
clicked = [];
document.querySelector('#selfNext').addEventListener('click', () => clicked.push('脚本面板'));
check('不把脚本自身面板当弹窗', M.clickBatchBlockingDialogNext(window), false);
check('脚本面板零点击', clicked, []);

// ===== 场景 H：真实学习页整页文本很长，不应误判整页为弹窗 =====
document.body.innerHTML = `
  <div id="wholePage">
    <div>当前章节还有任务点未完成，是否去完成？</div>
    <div>${'很长的课程正文。'.repeat(60)}</div>
    <button>下一节</button>
  </div>`;
// 整页超过 400 字应被排除（靠文本长度，不靠尺寸）
check('超长容器不当弹窗', M.findBatchBlockingDialog(window), null);

fs.unlinkSync(modulePath);
console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
