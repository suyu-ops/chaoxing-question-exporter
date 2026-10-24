// 导出按钮端到端回归（jsdom）：
// 复刻“点击导出 → 弹格式选择 → 点导出”的真实流程，确认不会因为
// event.currentTarget 失效而静默失败。
// 需要：npm i jsdom --no-save
let JSDOM = null;
try { ({ JSDOM } = require('jsdom')); } catch (e) {
  console.log('跳过：未安装 jsdom（npm i jsdom --no-save 后可运行）');
  process.exit(0);
}

const dom = new JSDOM('<!doctype html><html><body><button id="export">导出题库</button></body></html>', { pretendToBeVisual: true });
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

// 模拟导出函数：记录调用时拿到的按钮是否可用
let exportCalls = [];
async function fakeExportActiveQuestionBank(format, button, options) {
  exportCalls.push({ format, hasButton: !!(button && button.tagName === 'BUTTON'), options });
  if (!button || button.tagName !== 'BUTTON') throw new Error('button is null');
  return true;
}

// 模拟选项弹窗：直接返回预设结果
async function fakeChooseOptions() {
  return { format: 'word', withAnswers: true, withExplanation: true };
}

// ===== 复刻修复后的处理器写法 =====
const button = document.getElementById('export');
button.addEventListener('click', async event => {
  const captured = event.currentTarget;          // 必须在 await 之前
  const choice = await fakeChooseOptions();
  if (!choice) return;
  try {
    await fakeExportActiveQuestionBank(choice.format, captured, {
      withAnswers: choice.withAnswers,
      withExplanation: choice.withExplanation
    });
  } catch (error) {
    console.log('catch:', error.message);
  }
});

// ===== 也验证“错误写法”确实会失败（用于证明这个坑真实存在）=====
let buggyFailed = false;
const button2 = document.createElement('button');
document.body.appendChild(button2);
button2.addEventListener('click', async event => {
  await new Promise(r => setTimeout(r, 5));
  const late = event.currentTarget;             // await 之后才读 → null
  if (!late) buggyFailed = true;
});
button2.click();

(async () => {
  button.click();
  await new Promise(r => setTimeout(r, 30));

  check('导出函数被调用 1 次', exportCalls.length, 1);
  check('导出函数拿到有效按钮', exportCalls[0] && exportCalls[0].hasButton, true);
  check('格式正确传递', exportCalls[0] && exportCalls[0].format, 'word');
  check('含解析选项被传递', exportCalls[0] && exportCalls[0].options.withExplanation, true);
  check('含答案选项被传递', exportCalls[0] && exportCalls[0].options.withAnswers, true);

  await new Promise(r => setTimeout(r, 20));
  check('（对照）await 后才读 currentTarget 确实拿到 null', buggyFailed, true);

  console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
  process.exit(failed ? 1 : 0);
})();
