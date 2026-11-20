// 回归：题型推断的结论必须随题库一起持久化
//   用户反馈「导入后全是待归类，徽章只写“题型未知”，看不到规则建议的题型」。
// 根因：normalizeBankQuestion 白名单式重建题目时只保留答案/解析/AI 标注，
// 把 typeConfidence / typeReason / suggestedType 三个字段丢掉了。
// 而卡片上的「AI/规则建议：单选题」徽章和「归类依据」说明都读这几个字段，
// 于是题目一落盘就退回「题型未知」，用户无从判断要不要交给 AI 归类。
const fs = require('fs');
const path = require('path');
const { extractFunction, SRC } = require('./extract');

const src = fs.readFileSync(SRC, 'utf8');

const prelude = `
function hasRichContent(c) { return Array.isArray(c) && c.length > 0; }
function normalizeRichContent(parts) { return Array.isArray(parts) ? parts : []; }
function richContentToText(content) {
  return (content || []).map(part => (part && part.type === 'text' ? part.text : '')).join('');
}
function richTextOnly(content) { return richContentToText(content || []).trim(); }
function formatRichForText(content) { return richContentToText(content); }
function richContentIdentity(content) { return richTextOnly(content); }
function stripAnswerLabel(content) { return content; }
function normalizeBankRichContent(content) {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (Array.isArray(content)) return content;
  return [];
}
`;

const parts = [prelude, extractFunction(src, 'normalizeBankQuestion')];
const modulePath = path.join(__dirname, '.build-unsure-meta.js');
fs.writeFileSync(modulePath, parts.join('\n\n') + '\nmodule.exports = { normalizeBankQuestion };');
const { normalizeBankQuestion } = require(modulePath);

let failed = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failed++;
    console.log(`✗ ${label}\n   期望: ${JSON.stringify(expected)}\n   实际: ${JSON.stringify(actual)}`);
  } else console.log(`✓ ${label}`);
}

// ---- 规则推断出的「待归类」题目 ----
const inferred = {
  stem: '某段无法确定题型的材料文字',
  correctAnswer: '',
  explanation: '',
  typeName: '不确定',
  typeConfidence: 'low',
  typeReason: '题型信号冲突或不足，暂标为待归类',
  suggestedType: '单选'
};
const normalized = normalizeBankQuestion(inferred);
check('保留建议题型', normalized.suggestedType, '单选');
check('保留归类依据', normalized.typeReason, '题型信号冲突或不足，暂标为待归类');
check('保留推断置信度', normalized.typeConfidence, 'low');
check('非 AI 归类不写 typeSource', normalized.typeSource, undefined);

// ---- AI 归类过的题目：来源需保留，空建议题型不应留空字段 ----
const aiMarked = normalizeBankQuestion({
  stem: '另一段题干文字',
  typeConfidence: 'high',
  typeReason: 'AI 归类',
  typeSource: 'ai',
  suggestedType: ''
});
check('保留 AI 归类来源', aiMarked.typeSource, 'ai');
check('空建议题型不落空字段', aiMarked.suggestedType, undefined);
check('保留 AI 归类置信度', aiMarked.typeConfidence, 'high');

// ---- 正常题目不应凭空多出这些字段 ----
const plain = normalizeBankQuestion({
  stem: '以下哪个是质数？',
  options: [{ letter: 'A', text: '4' }, { letter: 'B', text: '7' }],
  correctAnswer: 'B'
});
check('普通题目无建议题型', plain.suggestedType, undefined);
check('普通题目无归类依据', plain.typeReason, undefined);
check('普通题目答案正常', plain.correctAnswer, 'B');

// ---- 超长依据会被截断，避免撑爆存储 ----
const longReason = '很长的依据'.repeat(200);
const truncated = normalizeBankQuestion({ stem: '题干', typeReason: longReason, suggestedType: '多选' });
check('归类依据被截断到 300 字内', truncated.typeReason.length <= 300, true);

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
