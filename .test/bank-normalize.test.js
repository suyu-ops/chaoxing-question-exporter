// 题库规范化回归：确保 AI 标注（来源/置信度/时间）与解析在存取过程中不丢失。
// 这类字段很容易被 normalizeBankQuestion 白名单式重建时静默丢掉。
const fs = require('fs');
const path = require('path');
const { extractFunction, SRC } = require('./extract');

const src = fs.readFileSync(SRC, 'utf8');
const prelude = [
  'const QUESTION_BANK_TYPES = ["\u5355\u9009","\u591a\u9009","\u586b\u7a7a","\u5224\u65ad","\u7b80\u7b54"];',
  'const TYPE_MAP = {"\u591a\u9009\u9898":"\u591a\u9009","\u5355\u9009\u9898":"\u5355\u9009","\u9009\u62e9\u9898":"\u5355\u9009","\u586b\u7a7a\u9898":"\u586b\u7a7a","\u5224\u65ad\u9898":"\u5224\u65ad","\u7b80\u7b54\u9898":"\u7b80\u7b54","\u8bba\u8ff0\u9898":"\u7b80\u7b54","\u95ee\u7b54\u9898":"\u7b80\u7b54"};'
].join('\n');

const needed = [
  'normalizeBankQuestion', 'normalizeBankRichContent', 'normalizeRichContent',
  'normalizeAnswerText', 'richTextOnly', 'richContentToText', 'formatRichForText',
  'hasRichContent', 'stripAnswerLabel', 'detectTypeFromText', 'decodeFontCipherText'
];

const parts = [prelude];
for (const name of needed) {
  try { parts.push(extractFunction(src, name)); } catch (e) { /* 个别是可选的 */ }
}
const modulePath = path.join(__dirname, '.build-nbq.js');
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

const aiQuestion = {
  stem: '逻辑主义的代表人物是()。',
  options: [
    { letter: 'A', text: '布劳威尔' },
    { letter: 'B', text: '哥德尔' },
    { letter: 'C', text: '希尔伯特' },
    { letter: 'D', text: '罗素' }
  ],
  correctAnswer: 'D',
  answerSource: 'ai',
  aiConfidence: 0.92,
  aiUpdatedAt: '2026-01-01T00:00:00.000Z',
  explanation: '罗素是逻辑主义代表人物'
};

const n = normalizeBankQuestion(aiQuestion);
check('AI 来源保留', n.answerSource, 'ai');
check('AI 置信度保留', n.aiConfidence, 0.92);
check('AI 时间保留', n.aiUpdatedAt, '2026-01-01T00:00:00.000Z');
check('解析保留', n.explanation, '罗素是逻辑主义代表人物');
check('答案保留', n.correctAnswer, 'D');
check('题干保留', n.stem, '逻辑主义的代表人物是()。');
check('选项数不变', n.options.length, 4);

// 幂等：再规范化一次不应丢字段
const n2 = normalizeBankQuestion(n);
check('二次规范化 AI 来源仍在', n2.answerSource, 'ai');
check('二次规范化置信度仍在', n2.aiConfidence, 0.92);

// 非 AI 题不应凭空带上 answerSource
const plain = normalizeBankQuestion({
  stem: '普通题目',
  options: [{ letter: 'A', text: 'a' }, { letter: 'B', text: 'b' }],
  correctAnswer: 'A'
});
check('普通题无 AI 标记', plain.answerSource, undefined);
check('普通题 AI 置信度为 undefined', plain.aiConfidence, undefined);

// 置信度越界应被夹到 0-1
const clamped = normalizeBankQuestion({ ...aiQuestion, aiConfidence: 1.8 });
check('置信度上限夹紧', clamped.aiConfidence, 1);
const clampedLow = normalizeBankQuestion({ ...aiQuestion, aiConfidence: -0.5 });
check('置信度下限夹紧', clampedLow.aiConfidence, 0);

// 非法置信度（NaN）不应写入
const noConfidence = normalizeBankQuestion({ ...aiQuestion, aiConfidence: 'abc' });
check('非法置信度不写入', noConfidence.aiConfidence, undefined);
check('但 AI 来源仍保留', noConfidence.answerSource, 'ai');

// 空答案的题也要能存（AI 补充前的状态）
const noAnswer = normalizeBankQuestion({ stem: '没有答案的题', options: [{ letter: 'A', text: 'x' }] });
check('空答案题能保存', !!noAnswer, true);
check('空答案为空字符串', noAnswer.correctAnswer, '');

fs.unlinkSync(modulePath);
console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
