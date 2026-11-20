// 回归：题目很多时不能卡死，更不能「识别不到」
//   用户反馈「题目过多还会卡死识别不到」（324 题的作业作答页，
//   面板一直停在「页面正在加载，正在识别题目…」）。
// 根因：字体解密前的 getCxSecretTargets 在没有 .font-cxsecret 元素时，
//   会对 body 下每个元素调用 getComputedStyle（324 题页面 4 万多个元素，
//   实测 4.3 万次调用、8.3 秒）。浏览器里每次 getComputedStyle 都可能
//   强制样式重算，主线程被拖住后 6 秒的「刚导航」窗口过期，提取流程
//   掉进 iframe-only 分支并返回空结果。
// 本用例在 jsdom 里生成一个 324 题的大页面，真实点击「提取本页题目」，
// 断言：①题目全部提取到 ②不再逐元素调用 getComputedStyle ③主线程阻塞可控。
let JSDOM = null;
try { ({ JSDOM } = require('jsdom')); } catch (e) {
  console.log('跳过：未安装 jsdom（npm i jsdom@30 --no-save 后可运行）');
  process.exit(0);
}

const fs = require('fs');
const { SRC } = require('./extract');

let failed = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failed++;
    console.log(`✗ ${label}\n   期望: ${JSON.stringify(expected)}\n   实际: ${JSON.stringify(actual)}`);
  } else console.log(`✓ ${label}`);
}
function checkTrue(label, cond, detail) {
  if (!cond) {
    failed++;
    console.log(`✗ ${label}${detail ? '\n   ' + detail : ''}`);
  } else console.log(`✓ ${label}`);
}

const src = fs.readFileSync(SRC, 'utf8');

// 324 题，每题带一个 60 按钮的富文本编辑器工具栏——和真实作业页的量级一致
// （真实页面实测 43,100 个元素，这里约 42,450 个）。
const QUESTION_COUNT = 324;
const TOOLBAR_BUTTON_COUNT = 60;

function buildEditorHtml() {
  return '<div class="edui-container"><div class="edui-toolbar">' +
    Array.from({ length: TOOLBAR_BUTTON_COUNT }, (_, i) =>
      `<div class="edui-btn" id="btn${i}"><span class="edui-icon"></span></div>`).join('') +
    '</div><div class="edui-body-container" contenteditable="true"><p>请在此作答</p></div></div>';
}

function buildQuestions() {
  return Array.from({ length: QUESTION_COUNT }, (_, i) => `
    <div class="questionLi" data="${i + 1}">
      <div class="Zy_TItle clearfix">
        <i class="fl">${i + 1}.</i>
        <div class="fl"><span class="newZy_TItle">（简答题）</span></div>
        <div class="qtContent">简答题目第 ${i + 1} 题，请简要说明。</div>
      </div>
      <div class="Py_answer">${buildEditorHtml()}</div>
    </div>`).join('');
}

const dom = new JSDOM(`<!doctype html><html><head>
  <style>.qtContent { font-family: "Microsoft YaHei"; }</style>
</head><body>
  <div id="coursetree"><div class="posCatalog_select" id="cur1001">1.1 章节</div></div>
  <div id="ZyBottom">${buildQuestions()}</div>
</body></html>`, {
  url: 'https://mooc1.chaoxing.com/mooc-ans/mooc2/work/dowork?courseId=1&classId=1',
  pretendToBeVisual: true,
  runScripts: 'outside-only'
});

const { window } = dom;
window.Element.prototype.getBoundingClientRect = function () {
  return { width: 360, height: 200, top: 80, left: 900, right: 1260, bottom: 280, x: 900, y: 80, toJSON() { return this; } };
};
window.GM_getValue = () => '';
window.GM_setValue = () => {};
window.GM_xmlhttpRequest = () => {};
window.GM_getResourceText = () => '';
window.docx = {};
window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener: () => {} }));
window.fetch = () => Promise.reject(new Error('no net'));

// 统计 getComputedStyle 调用次数。真实浏览器里每次调用都可能强制样式重算，
// 对整页每个元素调用一次是这起卡死的直接原因。
let gcsCalls = 0;
const realGetComputedStyle = window.getComputedStyle.bind(window);
window.getComputedStyle = function (...args) {
  gcsCalls++;
  return realGetComputedStyle(...args);
};

// 记录事件循环被阻塞的最长时间：每 100ms 打一次点，间隔超过阈值即视为卡顿。
let maxBlockMs = 0;
let lastTick = Date.now();
const blockTimer = setInterval(() => {
  const now = Date.now();
  const gap = now - lastTick - 100;
  if (gap > maxBlockMs) maxBlockMs = gap;
  lastTick = now;
}, 100);

const doc = window.document;
const elementCount = doc.querySelectorAll('*').length;
checkTrue('页面确实是大页面（元素数 > 40000）', elementCount > 40000, '实际元素数: ' + elementCount);
check('题目数符合预期', doc.querySelectorAll('.questionLi').length, QUESTION_COUNT);

let runtimeError = null;
try {
  window.eval(src.replace(/^[\s\S]*?\(function \(\) \{/, '(function () {'));
} catch (e) { runtimeError = e; }
check('脚本加载不抛错', runtimeError ? String(runtimeError.message) : null, null);

const wait = ms => new Promise(r => setTimeout(r, ms));
const click = id => {
  const el = doc.getElementById(id);
  if (el) el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
};

(async () => {
  doc.dispatchEvent(new window.Event('DOMContentLoaded'));
  await wait(900);

  // 打开设置与题库弹窗：让自身界面也参与 DOM，确保排除逻辑在大页面上同样生效。
  click('xxt-settingsBtn'); await wait(150);
  click('xxt-bankBtn'); await wait(250);

  gcsCalls = 0;
  lastTick = Date.now();
  const startedAt = Date.now();
  click('xxt-btnExtract');
  await wait(16000);
  clearInterval(blockTimer);
  const elapsed = Date.now() - startedAt;

  const status = (doc.getElementById('xxt-status') || {}).textContent || '';
  const stat = (doc.getElementById('xxt-stat') || {}).textContent || '';

  // ① 不能「识别不到」：324 题必须全部提取出来。
  checkTrue('提取到了全部题目（没有卡死/识别不到）',
    new RegExp(`成功提取 ${QUESTION_COUNT} 道题目`).test(status),
    `status: ${JSON.stringify(status)}  stat: ${JSON.stringify(stat)}`);
  check('题型统计正确', stat.replace(/\s+/g, ''), `${QUESTION_COUNT}简答题`);

  // ② 不再对整页元素逐个求样式：这是卡死的直接根因，必须为 0。
  //    （字体解密的精确定位路径走 querySelectorAll，不需要 getComputedStyle。）
  check('没有对整页元素逐个调用 getComputedStyle', gcsCalls, 0);

  // ③ 主线程阻塞必须有界。修复前实测 21.5 秒；这里给 12 秒的宽松上限，
  //    既能拦住量级回退，又不会因 CI 机器慢而误报。
  checkTrue('主线程阻塞在可控范围内（< 12000ms）', maxBlockMs < 12000, `实测最大阻塞: ${maxBlockMs}ms`);

  // ④ 整体耗时有界（修复前约 27s，修复后约 17s，其中 16s 是本用例的固定等待）。
  checkTrue('点击到出结果的耗时可控（< 25000ms）', elapsed < 25000, `实测耗时: ${elapsed}ms`);

  // ⑤ 大页面上题干依然干净：不能被界面文案或整页内容污染。
  click('xxt-btnEdit');
  await wait(1500);
  const editor = doc.getElementById('xxt-editor-modal');
  const cards = editor ? Array.from(editor.querySelectorAll('.xxt-editor-card')) : [];
  check('编辑器卡片数量与题目数一致', cards.length, QUESTION_COUNT);
  const stems = cards.map(card => {
    const area = card.querySelector('.xxt-editor-stem');
    return String(area ? area.value : '').replace(/\s+/g, ' ').trim();
  });
  check('第 1 题题干正确', stems[0], '简答题目第 1 题，请简要说明。');
  check('最后 1 题题干正确', stems[stems.length - 1], `简答题目第 ${QUESTION_COUNT} 题，请简要说明。`);
  const dirty = stems.filter(stem => !/^简答题目第 \d+ 题，请简要说明。$/.test(stem));
  checkTrue('全部题干都不含多余内容', dirty.length === 0,
    dirty.length ? `异常题干示例: ${JSON.stringify(dirty.slice(0, 3))}` : '');

  console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
  process.exit(failed === 0 ? 0 : 1);
})();
