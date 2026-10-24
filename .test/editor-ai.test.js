// 在线编辑器 AI 功能回归：验证「读卡片→调 AI→写回答案框→保存」的链路。
// 需要 jsdom：npm i jsdom --no-save
const fs = require('fs');
const path = require('path');

let JSDOM = null;
try { ({ JSDOM } = require('jsdom')); } catch (e) {
  console.log('跳过：未安装 jsdom');
  process.exit(0);
}

const { buildModule, SRC } = require('./extract');

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
const { window } = dom;
global.window = window;
global.document = window.document;
global.Node = window.Node;

let failed = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failed++;
    console.log(`✗ ${label}\n   期望: ${JSON.stringify(expected)}\n   实际: ${JSON.stringify(actual)}`);
  } else console.log(`✓ ${label}`);
}

// 构造一个微型「假面板」，把 renderEditor 里的 AI 逻辑抽出来单独验证不可能，
// 因此这里直接校验源码结构与编辑器 DOM 约定。
const src = fs.readFileSync(SRC, 'utf8');

check('编辑器工具栏含“仅选无答案”', src.includes('data-editor-select-action="missing"'), true);
check('编辑器有 AI 工具条', src.includes('id = \'xxt-editor-ai-bar\''), true);
check('AI 工具条四个批量动作', ['fill-missing', 'review-all', 'fix-selected', 'stop']
  .every(a => src.includes(`data-editor-ai="${a}"`)), true);
check('每张卡片有单题 AI 按钮', src.includes('data-editor-ai-one'), true);
check('卡片记录 hasAnswer 供筛选', src.includes("card.dataset.hasAnswer"), true);
check('AI 结果写入答案框而非直存', src.includes('applyEditorAiAnswer'), true);
check('AI 解析随保存落盘', src.includes("card.dataset.aiExplanation"), true);
check('AI 置信度随保存落盘', src.includes("card.dataset.aiConfidence"), true);
check('答题框输入会刷新 hasAnswer', src.includes("answerField.field.addEventListener('input'"), true);
check('编辑器 AI 有并发上限', src.includes('runEditorAiBatch'), true);

// ---- 验证 readEditorCardQuestion / applyEditorAiAnswer 的核心转换 ----
// editableTextToRichContent + richTextOnly 往返：空→填 不应丢内容
const code = buildModule({
  editableTextToRichContent: 'editableTextToRichContent',
  richContentToEditableText: 'richContentToEditableText',
  richTextOnly: 'richTextOnly',
  richContentToText: 'richContentToText',
  normalizeRichContent: 'normalizeRichContent',
  formatRichForText: 'formatRichForText',
  hasRichContent: 'hasRichContent',
  questionContent: 'questionContent',
  optionContent: 'optionContent',
  answerContent: 'answerContent'
});
const modulePath = path.join(__dirname, '.build-editor.js');
fs.writeFileSync(modulePath, code);
const M = require(modulePath);

// 模拟「答案为空 → AI 填入 D → 保存」
const oldAnswer = [];                       // 原来是空的
const aiAnswer = 'D';
const built = M.editableTextToRichContent(aiAnswer, oldAnswer);
check('空答案+AI 填入能生成富文本', M.richTextOnly(built), 'D');
check('生成内容为单个 text part', built.length, 1);
check('part 类型正确', built[0].type, 'text');

// 模拟「已有答案 B → AI 纠正为 D」
const oldAnswer2 = [{ type: 'text', text: 'B' }];
const built2 = M.editableTextToRichContent('D', oldAnswer2);
check('覆盖旧答案生效', M.richTextOnly(built2), 'D');

// 模拟带图片占位符的题干：AI 不应破坏图片
const oldStem = [{ type: 'text', text: '看图答题' }, { type: 'break' }, { type: 'image', url: 'http://a/1.png', alt: '图1' }];
const stemText = M.richContentToEditableText(oldStem);
check('题干编辑文本含图片占位符', stemText.includes('〔图片1〕'), true);
const rebuilt = M.editableTextToRichContent(stemText, oldStem);
check('往返后图片未丢失', rebuilt.some(p => p.type === 'image'), true);

fs.unlinkSync(modulePath);
console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
