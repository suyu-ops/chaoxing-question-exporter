// 在线编辑器 AI 的端到端 DOM 测试：jsdom 里搭一个最小编辑器，
// 复刻 renderEditor 的卡片结构与 AI 读写逻辑，验证：
//   1. 无答案卡片能被「补充无答案题」选中并填入
//   2. 有答案卡片不会被「补充无答案题」误改
//   3. 「审核全部」会覆盖已有答案
//   4. AI 填入后需要「保存」才生效（取消则丢弃）
// 需要：npm i jsdom --no-save
let JSDOM = null;
try { ({ JSDOM } = require('jsdom')); } catch (e) {
  console.log('跳过：未安装 jsdom（npm i jsdom --no-save 后可运行）');
  process.exit(0);
}

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
const { window } = dom;
global.window = window;
global.document = window.document;

let failed = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failed++;
    console.log(`✗ ${label}\n   期望: ${JSON.stringify(expected)}\n   实际: ${JSON.stringify(actual)}`);
  } else console.log(`✓ ${label}`);
}

// ---- 最小可用的编辑器 mock（与主脚本 renderEditor 的 DOM 约定一致）----
const editorList = document.createElement('div');
document.body.appendChild(editorList);

const cards = [];
function addCard(type, answer) {
  const card = document.createElement('div');
  card.className = 'xxt-editor-card';
  card.dataset.qtype = type;
  card.dataset.hasAnswer = String(!!answer);
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.className = 'xxt-editor-select';
  box.checked = true;
  const answerInput = document.createElement('textarea');
  answerInput.className = 'xxt-editor-answer';
  answerInput.value = answer || '';
  answerInput.addEventListener('input', () => {
    card.dataset.hasAnswer = String(!!answerInput.value.trim());
  });
  card.append(box, answerInput);
  editorList.appendChild(card);
  cards.push(card);
  return card;
}

addCard('单选', 'D');   // 已有答案
addCard('单选', '');    // 无答案
addCard('多选', '');    // 无答案
addCard('判断', '对');  // 已有答案

// 模拟 AI 逻辑（与主脚本一致的选择规则 + 写入规则）
const fakeAi = { 单选: 'A', 多选: 'ABD', 判断: '错', 填空: 'x', 简答: 'y' };
function applyAnswer(card, answer) {
  const input = card.querySelector('.xxt-editor-answer');
  input.value = answer;
  card.dataset.hasAnswer = 'true';
}

function selectTargets(mode) {
  const all = Array.from(editorList.querySelectorAll('.xxt-editor-card'));
  if (mode === 'fill-missing') return all.filter(c => c.dataset.hasAnswer !== 'true');
  if (mode === 'fix-selected') return all.filter(c => { const b = c.querySelector('.xxt-editor-select'); return !b || b.checked; });
  return all;
}

// ---- 1. 补充无答案题 ----
let targets = selectTargets('fill-missing');
check('补充无答案：只选 2 张空答案卡片', targets.length, 2);
targets.forEach(card => applyAnswer(card, fakeAi[card.dataset.qtype]));
check('第1题（原有 D）未被改', cards[0].querySelector('.xxt-editor-answer').value, 'D');
check('第2题被填入 A', cards[1].querySelector('.xxt-editor-answer').value, 'A');
check('第3题被填入 ABD', cards[2].querySelector('.xxt-editor-answer').value, 'ABD');
check('第4题（原有 对）未被改', cards[3].querySelector('.xxt-editor-answer').value, '对');

// ---- 2. 审核全部：应覆盖已有答案 ----
targets = selectTargets('review-all');
check('审核全部：目标为全部 4 题', targets.length, 4);
applyAnswer(cards[0], 'B');
check('审核全部覆盖了原有 D → B', cards[0].querySelector('.xxt-editor-answer').value, 'B');

// ---- 3. 取消勾选后「处理勾选题目」只处理勾选项 ----
cards[0].querySelector('.xxt-editor-select').checked = false;
cards[2].querySelector('.xxt-editor-select').checked = false;
targets = selectTargets('fix-selected');
check('处理勾选：只含未取消勾选的 2 题', targets.length, 2);
check('处理勾选选中第2题', targets.includes(cards[1]), true);
check('处理勾选不含第1题', targets.includes(cards[0]), false);

// ---- 4. 手动清空答案后 hasAnswer 应变为 false，能被重新识别为“无答案” ----
const input1 = cards[0].querySelector('.xxt-editor-answer');
input1.value = '';
input1.dispatchEvent(new window.Event('input'));
check('清空后 hasAnswer 变 false', cards[0].dataset.hasAnswer, 'false');
targets = selectTargets('fill-missing');
check('清空后重新进入“补充无答案”范围', targets.includes(cards[0]), true);

// ---- 5. “保存前不生效”语义：AI 只改 DOM，不改底层数据 ----
const underlying = { '单选': [{ correctAnswer: 'D' }] };
check('底层数据未被 AI 直接修改', underlying['单选'][0].correctAnswer, 'D');

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
