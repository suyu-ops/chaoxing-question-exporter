// 用户反馈两个 bug 的回归测试：
//   A. 「多选和判断都被识别成单选」
//   B. 「选题时复选框没显示出来，是透明的」
const fs = require('fs');
const path = require('path');
const { buildModule, extractFunction, SRC } = require('./extract');

const src = fs.readFileSync(SRC, 'utf8');

let failed = 0;
function brief(v) {
  const t = JSON.stringify(v);
  return t === undefined ? String(v) : (t.length > 160 ? t.slice(0, 160) + '…' : t);
}
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failed++;
    console.log(`✗ ${label}\n   期望: ${brief(expected)}\n   实际: ${brief(actual)}`);
  } else console.log(`✓ ${label}`);
}

// ==================== A. 题型识别 ====================
// 需要把 TYPE_RULES 常量一起注入
const rulesMatch = src.match(/const TYPE_RULES = \[[\s\S]*?\n  \];/);
if (!rulesMatch) {
  console.log('✗ 未找到 TYPE_RULES 定义');
  process.exit(1);
}
const code = [
  rulesMatch[0],
  extractFunction(src, 'detectTypeFromText'),
  'module.exports = { detectTypeFromText };'
].join('\n\n');
const modulePath = path.join(__dirname, '.build-type.js');
fs.writeFileSync(modulePath, code);
const M = require(modulePath);

// --- 多选题的各种页面写法（回归重点）---
check('多选题', M.detectTypeFromText('多选题'), '多选');
check('多项选择题（旧实现误判为单选）', M.detectTypeFromText('多项选择题'), '多选');
check('二、多项选择题（共5题）', M.detectTypeFromText('二、多项选择题（共5题）'), '多选');
check('不定项选择题', M.detectTypeFromText('不定项选择题'), '多选');
check('不定项选择', M.detectTypeFromText('不定项选择'), '多选');
check('多项选择', M.detectTypeFromText('多项选择'), '多选');
check('【多选题】', M.detectTypeFromText('【多选题】'), '多选');
check('multiple choice', M.detectTypeFromText('Multiple Choice Question'), '多选');

// --- 判断题的各种写法 ---
check('判断题', M.detectTypeFromText('判断题'), '判断');
check('三、判断题', M.detectTypeFromText('三、判断题'), '判断');
check('正误判断题', M.detectTypeFromText('正误判断题'), '判断');
check('是非题', M.detectTypeFromText('是非题'), '判断');
check('【判断题】', M.detectTypeFromText('【判断题】'), '判断');
check('true/false', M.detectTypeFromText('True or False'), '判断');

// --- 单选不应被多选规则误伤 ---
check('单选题', M.detectTypeFromText('单选题'), '单选');
check('单项选择题', M.detectTypeFromText('单项选择题'), '单选');
check('选择题（宽泛词）', M.detectTypeFromText('选择题'), '单选');
check('一、单项选择题（共10题）', M.detectTypeFromText('一、单项选择题（共10题）'), '单选');
check('single choice', M.detectTypeFromText('Single Choice'), '单选');

// --- 其他题型 ---
check('填空题', M.detectTypeFromText('填空题'), '填空');
check('fill in the blank', M.detectTypeFromText('Fill in the blank'), '填空');
check('简答题', M.detectTypeFromText('简答题'), '简答');
check('论述题', M.detectTypeFromText('论述题'), '简答');
check('名词解释', M.detectTypeFromText('名词解释'), '简答');

// --- 边界 ---
check('空串返回 null', M.detectTypeFromText(''), null);
check('null 安全', M.detectTypeFromText(null), null);
check('无关文本返回 null', M.detectTypeFromText('认识非西方逻辑'), null);

// --- 关键顺序断言：多选必须优先于宽泛的“选择” ---
{
  const rules = rulesMatch[0];
  const multiIdx = rules.indexOf("type: '多选'");
  const singleIdx = rules.indexOf("type: '单选'");
  check('多选规则排在单选规则之前', multiIdx > 0 && multiIdx < singleIdx, true);
  const judgeIdx = rules.indexOf("type: '判断'");
  check('判断规则也在单选之前', judgeIdx > 0 && judgeIdx < singleIdx, true);
}

// ==================== A2. currentType 不再跨节粘连 ====================
{
  const fn = extractFunction(src, 'extractFromTiMuRoot');
  check('题型标题识别失败时清空 currentType', /currentType = detected \|\| null/.test(fn), true);
  check('缺少题型标题元素时也清空', /else \{[\s\S]{0,120}currentType = null;/.test(fn), true);
}

// ==================== B. 复选框可见性 ====================
{
  // CSS 层面：必须显式 appearance / 背景 / 尺寸，不能只依赖 accent-color
  const cssStart = src.indexOf('复选框必须显式绘制');
  check('存在复选框显式绘制样式', cssStart > 0, true);
  const cssBlock = src.slice(cssStart, cssStart + 2400);
  check('使用 appearance:none 抹平宿主样式', /appearance:\s*none\s*!important/.test(cssBlock), true);
  check('显式设置宽度', /width:\s*17px/.test(cssBlock), true);
  check('显式设置高度', /height:\s*17px/.test(cssBlock), true);
  check('显式设置边框（可见轮廓）', /border:\s*1\.5px solid/.test(cssBlock), true);
  check('显式设置不透明', /opacity:\s*1\s*!important/.test(cssBlock), true);
  check('显式设置可见', /visibility:\s*visible\s*!important/.test(cssBlock), true);
  check('勾选态使用内嵌 SVG 对勾', /xxt-check-on[\s\S]{0,600}data:image\/svg\+xml/.test(cssBlock), true);
  check('深色模式有独立配色', /data-xxt-theme="dark"[\s\S]{0,200}xxt-editor-select/.test(cssBlock), true);

  // 不再只用 accent-color 一种手段
  check('已移除“只靠 accent-color”的旧编辑器样式', src.includes('#xxt-editor-modal .xxt-editor-select { width:17px; height:17px; accent-color'), false);

  // JS 层面：勾选状态同步 class
  check('编辑器复选框勾选时加 xxt-check-on', /if \(select\.checked\) select\.classList\.add\('xxt-check-on'\)/.test(src), true);
  check('编辑器复选框 change 时切换 class', /select\.classList\.toggle\('xxt-check-on', select\.checked\)/.test(src), true);
  check('题库复选框初始带 xxt-check-on', /xxt-bank-check' \+ \(selected \? ' xxt-check-on' : ''\)/.test(src), true);
  check('题库复选框变化时切换 class', /box\.classList\.toggle\('xxt-check-on', box\.checked\)/.test(src), true);

  // 结构层面：复选框必须在标题行内（否则会被布局挤掉）
  check('编辑器复选框插入标题行', /titleRow\.insertBefore\(select, title\)/.test(src), true);
}

fs.unlinkSync(modulePath);
console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
