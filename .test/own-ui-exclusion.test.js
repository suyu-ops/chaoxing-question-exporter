// 回归：脚本自己的界面不能被当成题目
//   用户反馈「识别多了，连面板里的字也加进题库了」。
// 根因：题库筛选下拉里有 <option>单选题</option>/<option>判断题</option>，
// extractFromQuizPracticeRoot 把它当成「题型分区」，随后用 Range 从真实
// 题目一路截到面板里，把整块界面文案塞进题干。
// 本用例在 jsdom 里真实执行脚本并点「提取本页题目」，检查题干里不含自身文案。
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

const src = fs.readFileSync(SRC, 'utf8');

// 面板自带的文案，任何一个出现在题干里都算串味。
const OWN_UI_TEXT = [
  '学习通题目一键提取导出', '题库区快捷库管理', '星夜题库', 'OCS 接入说明',
  '整门课提取', '导出设置', '附加答案', '题库导入格式', '查看、编辑',
  '批量提取节奏', '档位说明', '本地存储占用', '重新扫描目录', '开始提取',
  '将当前页面与题库对比', '完成并关闭', '暂无历史记录'
];

const dom = new JSDOM(`<!doctype html><html><head></head><body>
  <div id="coursetree"><div class="posCatalog_select" id="cur1001">1.1 章节</div></div>
  <div id="quizRoot">
    <div class="type">单选题</div>
    <div class="stem">1. 太阳从哪边升起？</div>
    <ul><li>A、东</li><li>B、西</li></ul>
    <div class="type">判断题</div>
    <div class="stem">2. 地球是圆的。</div>
    <button class="opt">对</button><button class="opt">错</button>
  </div>
</body></html>`, {
  url: 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=1',
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

let runtimeError = null;
try {
  window.eval(src.replace(/^[\s\S]*?\(function \(\) \{/, '(function () {'));
} catch (e) { runtimeError = e; }
check('脚本加载不抛错', runtimeError ? String(runtimeError.message) : null, null);

const wait = ms => new Promise(r => setTimeout(r, ms));
const doc = window.document;
const click = id => {
  const el = doc.getElementById(id);
  if (el) el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
};

(async () => {
  doc.dispatchEvent(new window.Event('DOMContentLoaded'));
  await wait(800);

  // 把脚本自己的窗口全部打开：这是触发该 bug 的前提条件。
  click('xxt-settingsBtn'); await wait(150);
  click('xxt-historyBtn'); await wait(150);
  click('xxt-bankBtn'); await wait(250);
  click('xxt-btnBatchExtract'); await wait(200);

  click('xxt-btnExtract');
  await wait(4000);

  const status = (doc.getElementById('xxt-status') || {}).textContent || '';
  check('提取成功（未因自身界面而失败）', /成功提取 2 道题目/.test(status), true);

  click('xxt-btnEdit');
  await wait(400);
  const editor = doc.getElementById('xxt-editor-modal');
  check('编辑器已渲染', !!editor, true);

  const cards = editor ? Array.from(editor.querySelectorAll('.xxt-editor-card')) : [];
  check('题目数量正确（不多不少）', cards.length, 2);

  const stems = cards.map(card => {
    const area = card.querySelector('.xxt-editor-stem');
    return String(area ? area.value : '').replace(/\s+/g, ' ').trim();
  });
  check('题干 1 正确', stems[0], '太阳从哪边升起？');
  check('题干 2 正确', stems[1], '地球是圆的。');

  // 核心断言：任何题干里都不能出现脚本自己的界面文案。
  const leaked = OWN_UI_TEXT.filter(text => stems.some(stem => stem.includes(text)));
  check('题干里不含脚本自身界面文案', leaked, []);

  // 题干也不应该异常长（Range 跨出题目区域时会卷进整页文本）。
  const tooLong = stems.filter(stem => stem.length > 200);
  check('没有异常长的题干', tooLong, []);

  // 题库区筛选下拉的题型 option 不应被当作题型分区。
  const typeFilter = doc.getElementById('xxt-bank-type-filter');
  check('题库筛选下拉存在（bug 的触发源）', !!typeFilter, true);
  if (typeFilter) {
    const options = Array.from(typeFilter.querySelectorAll('option')).map(o => o.textContent.trim());
    check('筛选项里确实有会被误判的题型文案', options.includes('判断题'), true);
  }

  // 自检：这道防线不能把合法页面结构误伤。
  // 下面这些布局在真实页面里都存在，修复前题干是正常的，修复后必须保持正常。
  let extraFailed = 0;
  const expect = (label, actual, wanted) => {
    const ok = JSON.stringify(actual) === JSON.stringify(wanted);
    if (!ok) {
      extraFailed++;
      failed++;
      console.log(`✗ ${label}\n   期望: ${JSON.stringify(wanted)}\n   实际: ${JSON.stringify(actual)}`);
    } else console.log(`✓ ${label}`);
  };

  const scenarios = [
    {
      label: '题型标签与题目分属同级容器',
      html: `<div id="quizRoot">
        <div class="a"><div class="type">单选题</div></div>
        <div class="b"><div class="stem">1. 太阳从哪边升起？</div><ul><li>A、东</li><li>B、西</li></ul></div>
      </div>`,
      want: ['太阳从哪边升起？']
    },
    {
      label: '两个分区各自独立成块',
      html: `<div id="quizRoot">
        <div class="sec"><div class="type">单选题</div><div class="stem">1. 太阳从哪边升起？</div><ul><li>A、东</li><li>B、西</li></ul></div>
        <div class="sec"><div class="type">判断题</div><div class="stem">2. 地球是圆的。</div></div>
      </div>`,
      want: ['太阳从哪边升起？', '地球是圆的。']
    },
    {
      label: '长材料题的题干不被误删',
      html: `<div id="quizRoot">
        <div class="type">单选题</div>
        <div class="stem">1. 阅读下面的材料，回答问题。${'这是一段材料内容。'.repeat(20)}问：作者想表达什么？</div>
        <ul><li>A、思乡</li><li>B、喜悦</li></ul>
      </div>`,
      want: [`阅读下面的材料，回答问题。${'这是一段材料内容。'.repeat(20)}问：作者想表达什么？`]
    },
    {
      // 作业作答（dowork）页：每题标题里带「（简答题）」小标签，外面还有一层分区标题。
      // 单题容器内的题型小标签不能被当成新分区，否则 Range 会一路截到下一题。
      label: '单题容器内的题型标签不当作分区',
      html: `<div id="ZyBottom">
        <div class="secTitle">一. 简答题（共 2 题）</div>
        <div class="questionLi" data-question-id="q1">
          <div class="Zy_TItle"><i>1.</i><span class="newZy_TItle">（简答题）</span>
            <div class="qtContent">太阳从哪边升起？</div></div>
          <div class="Py_answer">请在此作答</div>
        </div>
        <div class="questionLi" data-question-id="q2">
          <div class="Zy_TItle"><i>2.</i><span class="newZy_TItle">（简答题）</span>
            <div class="qtContent">地球是圆的吗？</div></div>
          <div class="Py_answer">请在此作答</div>
        </div>
      </div>`,
      want: ['太阳从哪边升起？', '地球是圆的吗？']
    }
  ];

  for (const scenario of scenarios) {
    const stems = await extractStems(scenario.html);
    expect(scenario.label, stems, scenario.want);
  }

  console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
  process.exit(failed ? 1 : 0);
})();

// 用给定的页面正文跑一遍「点提取 → 打开编辑器 → 读题干」，用于自检各种布局。
async function extractStems(bodyHtml) {
  const dom = new JSDOM(`<!doctype html><html><head></head><body>${bodyHtml}</body></html>`, {
    url: 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=1',
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
  window.eval(fs.readFileSync(SRC, 'utf8').replace(/^[\s\S]*?\(function \(\) \{/, '(function () {'));

  const d = window.document;
  const fire = id => {
    const el = d.getElementById(id);
    if (el) el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  };
  d.dispatchEvent(new window.Event('DOMContentLoaded'));
  await wait(800);
  // 保持窗口全开：这是该 bug 的触发前提。
  fire('xxt-settingsBtn'); await wait(120);
  fire('xxt-bankBtn'); await wait(200);
  fire('xxt-btnExtract');
  await wait(3500);
  fire('xxt-btnEdit');
  await wait(400);

  const editor = d.getElementById('xxt-editor-modal');
  if (!editor) return [];
  return Array.from(editor.querySelectorAll('.xxt-editor-card')).map(card => {
    const area = card.querySelector('.xxt-editor-stem');
    return String(area ? area.value : '').replace(/\s+/g, ' ').trim();
  });
}
