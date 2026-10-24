// 复选框可见性端到端验证（jsdom）。
// 模拟学习通页面注入 `input[type=checkbox]{appearance:none;opacity:0}`
// 这类全局样式，确认脚本的复选框仍然有边框、有尺寸、勾选后变色。
// 需要：npm i jsdom --no-save
let JSDOM = null;
try { ({ JSDOM } = require('jsdom')); } catch (e) {
  console.log('跳过：未安装 jsdom（npm i jsdom --no-save 后可运行）');
  process.exit(0);
}

const fs = require('fs');
const path = require('path');
const { SRC } = require('./extract');

const src = fs.readFileSync(SRC, 'utf8');

let failed = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failed++;
    console.log(`✗ ${label}\n   期望: ${JSON.stringify(expected)}\n   实际: ${JSON.stringify(actual)}`);
  } else console.log(`✓ ${label}`);
}

// 抽出复选框相关的 CSS 段：必须从块注释的 "/*" 开始，否则注释残片会把
// 后续所有规则一起注释掉（这就是本测试第一版全部失败的原因）。
const cssStart = src.indexOf('/* 复选框必须显式绘制');
const cssEnd = src.indexOf('[data-xxt-theme="dark"] #xxt-editor-modal .xxt-editor-select:checked');
if (cssStart < 0 || cssEnd < 0) {
  console.log('✗ 未能定位复选框 CSS 段');
  process.exit(1);
}
let cssBlock = src.slice(cssStart, cssEnd + 260);
// 去掉开头的块注释，只保留规则本身
cssBlock = cssBlock.replace(/^\/\*[\s\S]*?\*\//, '');

const dom = new JSDOM(`<!doctype html><html><head>
<style>
/* 模拟学习通页面的全局样式：这会让原生 checkbox 完全看不见 */
input[type="checkbox"] {
  appearance: none !important;
  -webkit-appearance: none !important;
  opacity: 0 !important;
  width: 0 !important;
  height: 0 !important;
}
${cssBlock}
</style>
</head><body>
  <div id="xxt-editor-modal">
    <input type="checkbox" class="xxt-editor-select" id="c1">
    <input type="checkbox" class="xxt-editor-select xxt-check-on" id="c2" checked>
  </div>
  <div id="xxt-bank-modal">
    <div class="xxt-bank-card-head">
      <input type="checkbox" class="xxt-bank-check" data-bank-check="1" id="c3">
      <input type="checkbox" class="xxt-bank-check xxt-check-on" data-bank-check="1" id="c4" checked>
    </div>
  </div>
</body></html>`, { pretendToBeVisual: true });

const { window } = dom;
const { document } = window;
const getStyle = (el, prop) => window.getComputedStyle(el).getPropertyValue(prop);

// ---- 未勾选状态 ----
for (const [id, name] of [['c1', '编辑器'], ['c3', '题库']]) {
  const el = document.getElementById(id);
  const width = getStyle(el, 'width');
  const height = getStyle(el, 'height');
  const border = getStyle(el, 'border');
  const opacity = getStyle(el, 'opacity');
  const visibility = getStyle(el, 'visibility');
  check(`${name}复选框宽度不再是 0`, width !== '0px' && width !== '', true);
  check(`${name}复选框宽度为 17px`, width, '17px');
  check(`${name}复选框高度为 17px`, height, '17px');
  check(`${name}有可见边框`, /1\.5px solid/.test(border), true);
  check(`${name}不透明`, String(opacity).trim(), '1');
  check(`${name}可见`, visibility, 'visible');
}

// ---- 勾选状态 ----
for (const [id, name] of [['c2', '编辑器'], ['c4', '题库']]) {
  const el = document.getElementById(id);
  const bg = String(getStyle(el, 'background-color') || '').trim();
  const bgImage = getStyle(el, 'background-image');
  // 注意：jsdom 不解析 var(--xxt-accent)，勾选态取到的是 "var(--xxt-accent)"
  // 或空串。这里只断言「确实被勾选态规则接管了」（不再是未勾选的白色）。
  check(`${name}勾选态已脱离默认白底`, bg !== 'rgb(255, 255, 255)', true);
  check(`${name}勾选后显示对勾图形`, /svg|xml/.test(bgImage), true);
}

// ---- 关键对照：没有脚本样式的裸复选框会被宿主样式吃掉 ----
{
  const bare = document.createElement('input');
  bare.type = 'checkbox';
  document.body.appendChild(bare);
  const w = getStyle(bare, 'width');
  const op = getStyle(bare, 'opacity');
  check('（对照）裸复选框被宿主样式压成 0 宽', w, '0px');
  check('（对照）裸复选框透明', String(op).trim(), '0');
  bare.remove();
}

// ---- class 切换能翻转外观 ----
{
  const el = document.getElementById('c1');
  const before = getStyle(el, 'background-image');
  el.classList.add('xxt-check-on');
  const after = getStyle(el, 'background-image');
  check('加 xxt-check-on 后出现对勾', before !== after && /svg/.test(after), true);
  el.classList.remove('xxt-check-on');
  const back = getStyle(el, 'background-image');
  check('移除 class 后对勾消失', /svg/.test(back), false);
}

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
