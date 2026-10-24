// 文本/Markdown 题库解析回归测试。运行：node .test/parse.test.js
const fs = require('fs');
const path = require('path');
const { buildModule } = require('./extract');

const code = buildModule({
  xxtParseQuestionsFromText: 'xxtParseQuestionsFromText',
  xxtNormalizeType: 'xxtNormalizeType',
  xxtJudgeAnswerFromLetter: 'xxtJudgeAnswerFromLetter',
  xxtLooksLikeJudgeAnswer: 'xxtLooksLikeJudgeAnswer',
  xxtInferQuestionType: 'xxtInferQuestionType'
});const modulePath = path.join(__dirname, '.build-parse.js');
fs.writeFileSync(modulePath, code);
const { xxtParseQuestionsFromText, xxtNormalizeType } = require(modulePath);

let failed = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failed++;
    console.log(`✗ ${label}\n   期望: ${JSON.stringify(expected)}\n   实际: ${JSON.stringify(actual)}`);
  } else {
    console.log(`✓ ${label}`);
  }
}

// ---- 题型识别 ----
check('题型: 一、单项选择题', xxtNormalizeType('一、单项选择题'), '单选');
check('题型: 多选题', xxtNormalizeType('多选题'), '多选');
check('题型: 判断题', xxtNormalizeType('判断题'), '判断');
check('题型: 论述题', xxtNormalizeType('论述题'), '简答');
check('题型: 空字符串', xxtNormalizeType(''), '');

// ---- 完整试卷 ----
const sample = [
  '一、单项选择题（共10题）',
  '',
  '1.【单选题】小乘佛教始于()。',
  'A. 印度',
  'B. 日本',
  'C. 西藏',
  'D. 斯里兰卡',
  '答案：A',
  '',
  '2、藏传佛教格鲁派(黄教)的创立者是()。',
  'A. 慧能',
  'B. 仓央嘉措',
  'C. 达赖喇嘛',
  'D. 宗喀巴',
  '答案：D',
  '',
  '二、多项选择题',
  '',
  '3. 下列属于佛教流派的有()',
  'A. 禅宗',
  'B. 净土宗',
  'C. 道教',
  'D. 律宗',
  '答案：ABD',
  '解析：道教不是佛教流派。',
  '',
  '三、判断题',
  '',
  '4. 藏传佛教属于佛教三大语系之一。',
  '答案：正确',
  '',
  '四、填空题',
  '',
  '5. 佛教创立于公元前______世纪。',
  '答案：6',
  '',
  '五、简答题',
  '',
  '6. 简述佛教的四谛。',
  '答案：苦集灭道'
].join('\n');

const g = xxtParseQuestionsFromText(sample);
check('单选数量', g['单选'].length, 2);
check('多选数量', g['多选'].length, 1);
check('判断数量', g['判断'].length, 1);
check('填空数量', g['填空'].length, 1);
check('简答数量', g['简答'].length, 1);

check('单选1 题干', g['单选'][0].stem, '小乘佛教始于()。');
check('单选1 选项', g['单选'][0].options, ['印度', '日本', '西藏', '斯里兰卡']);
check('单选1 答案', g['单选'][0].correctAnswer, 'A');
check('单选2 答案', g['单选'][1].correctAnswer, 'D');
check('多选 答案归一化', g['多选'][0].correctAnswer, 'ABD');
check('多选 解析', g['多选'][0].explanation, '道教不是佛教流派。');
check('判断 答案归一化', g['判断'][0].correctAnswer, '对');
check('填空 答案', g['填空'][0].correctAnswer, '6');
check('简答 答案', g['简答'][0].correctAnswer, '苦集灭道');

// ---- Markdown 风格 ----
const md = [
  '### 一、单选题（共2题）',
  '',
  '**1.** 中国的首都是（ ）',
  '- A. 上海',
  '- B. 北京',
  '',
  '> **答案：** B',
  '',
  '**2.** 1+1=?',
  '- A. 1',
  '- B. 2',
  '- C. 3',
  '- D. 4',
  '',
  '> **答案：** B'
].join('\n');
const g2 = xxtParseQuestionsFromText(md);
check('Markdown 单选数量', g2['单选'].length, 2);
check('Markdown 第1题答案', g2['单选'][0] && g2['单选'][0].correctAnswer, 'B');

// ---- 无序号的纯选项文本不应产生垃圾题 ----
const noise = 'A. 这是没有题目的孤立选项\nB. 另一个孤立选项\n';
const g3 = xxtParseQuestionsFromText(noise);
const total3 = Object.values(g3).reduce((s, l) => s + l.length, 0);
check('孤立选项不产生无效题（允许 1 条纯文本兜底）', total3 <= 1, true);

// ---- 空输入 ----
const g4 = xxtParseQuestionsFromText('');
check('空输入不产生题目', Object.values(g4).reduce((s, l) => s + l.length, 0), 0);

// ---- 判断题型自动推断 ----
const inferJudge = [
  '1. 地球是圆的（ ）',
  'A. 正确',
  'B. 错误',
  '答案：A'
].join('\n');
const g5 = xxtParseQuestionsFromText(inferJudge);
check('自动推断为判断题', g5['判断'].length, 1);
check('判断题答案归一化', g5['判断'][0] && g5['判断'][0].correctAnswer, '对');

// ---- 选项字母必须递增，避免题干里的 A/B 被误判 ----
const tricky = [
  '1. 关于 A. 选项与 B. 选项的说法，正确的是（ ）',
  'A. 前者正确',
  'B. 后者正确',
  '答案：A'
].join('\n');
const g6 = xxtParseQuestionsFromText(tricky);
check('题干中的 A./B. 不被当作选项', g6['单选'].length, 1);
check('真实选项数量为 2', (g6['单选'][0] || {}).options, ['前者正确', '后者正确']);

fs.unlinkSync(modulePath);
console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
