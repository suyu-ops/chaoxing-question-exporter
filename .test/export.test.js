// 导出链路回归：覆盖两个真实故障。
//   1. event.currentTarget 在 await 后变 null，导致导出函数拿到 null 按钮后抛错、
//      用户侧表现为“点了导出没有任何反应”。
//   2. 导出内容应能可选包含解析（TXT / MD / Word / PDF 全格式）。
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

// ============ 1. currentTarget 陷阱的结构性防护 ============
{
  const exportHandler = src.slice(
    src.indexOf("bankModal.querySelector('#xxt-bank-export').addEventListener"),
    src.indexOf("bankModal.querySelector('#xxt-bank-clear').addEventListener")
  );
  const previewIdx = exportHandler.indexOf('const choice = await xxtChooseExportOptions');
  const capturedAt = exportHandler.indexOf('const button = event.currentTarget');
  check('导出按钮在 await 之前被捕获', capturedAt > 0 && capturedAt < previewIdx, true);
  // 只统计“代码行”中的引用，注释里提到不算。
  const codeRefs = exportHandler
    .split('\n')
    .filter(line => !/^\s*\/\//.test(line.trim()) && line.includes('event.currentTarget'));
  check('代码中 event.currentTarget 只出现一次（捕获那次）', codeRefs.length, 1);

  // exportActiveQuestionBank 必须能容忍 null 按钮
  const fn = extractFunction(src, 'exportActiveQuestionBank');
  check('exportActiveQuestionBank 对按钮做了空值兜底', /actionButton/.test(fn), true);
  check('不再直接访问 button.textContent', /^\s*const originalText = button\.textContent;/m.test(fn), false);
}

// ============ 2. 格式化函数支持解析 ============
const code = buildModule({
  formatOutput: 'formatOutput',
  formatOutputMD: 'formatOutputMD',
  formatOutputWithAnswers: 'formatOutputWithAnswers',
  formatOutputWithAnswersMD: 'formatOutputWithAnswersMD',
  questionExplanationText: 'questionExplanationText',
  formatRichForText: 'formatRichForText',
  formatRichForMD: 'formatRichForMD',
  richContentToText: 'richContentToText',
  richTextOnly: 'richTextOnly',
  normalizeRichContent: 'normalizeRichContent',
  hasRichContent: 'hasRichContent',
  questionContent: 'questionContent',
  optionContent: 'optionContent',
  answerContent: 'answerContent',
  unavailableCorrectAnswerText: 'unavailableCorrectAnswerText',
  escapeMarkdownAlt: 'escapeMarkdownAlt',
  escapeMarkdownUrl: 'escapeMarkdownUrl',
  applyScoreDerivedAnswer: 'applyScoreDerivedAnswer',
  toScoreNumber: 'toScoreNumber'
});
const modulePath = path.join(__dirname, '.build-export.js');
fs.writeFileSync(modulePath, code);
const M = require(modulePath);

const q1 = {
  stem: '逻辑主义的代表人物是()。',
  stemContent: [{ type: 'text', text: '逻辑主义的代表人物是()。' }],
  options: [
    { letter: 'A', text: '布劳威尔', content: [{ type: 'text', text: '布劳威尔' }] },
    { letter: 'B', text: '哥德尔', content: [{ type: 'text', text: '哥德尔' }] },
    { letter: 'C', text: '希尔伯特', content: [{ type: 'text', text: '希尔伯特' }] },
    { letter: 'D', text: '罗素', content: [{ type: 'text', text: '罗素' }] }
  ],
  correctAnswer: 'D',
  correctAnswerContent: [{ type: 'text', text: 'D' }],
  explanation: '逻辑主义以罗素为代表，主张数学可化归为逻辑。'
};
const q2 = {
  stem: '没有解析的题目',
  stemContent: [{ type: 'text', text: '没有解析的题目' }],
  options: [
    { letter: 'A', text: '甲', content: [{ type: 'text', text: '甲' }] },
    { letter: 'B', text: '乙', content: [{ type: 'text', text: '乙' }] }
  ],
  correctAnswer: 'A',
  correctAnswerContent: [{ type: 'text', text: 'A' }]
};
const results = { '单选': [q1, q2], '多选': [], '填空': [], '判断': [], '简答': [] };
const typeOrder = ['单选'];

// --- TXT ---
const txtNoExp = M.formatOutput(results, typeOrder, true, false);
const txtExp = M.formatOutput(results, typeOrder, true, true);
check('TXT 不含解析时没有“解析：”', /解析：/.test(txtNoExp), false);
check('TXT 含解析时出现“解析：”', /解析：逻辑主义以罗素为代表/.test(txtExp), true);
check('TXT 无解析的题不凭空生成解析', (txtExp.match(/解析：/g) || []).length, 1);
check('TXT 答案仍正常输出', /答案：D/.test(txtExp), true);

// --- MD ---
const mdNoExp = M.formatOutputMD(results, typeOrder, true, false);
const mdExp = M.formatOutputMD(results, typeOrder, true, true);
check('MD 不含解析时没有“解析”标记', /\*\*解析：\*\*/.test(mdNoExp), false);
check('MD 含解析时出现引用块解析', /> \*\*解析：\*\* 逻辑主义以罗素为代表/.test(mdExp), true);
check('MD 无解析题不凭空生成', (mdExp.match(/\*\*解析：\*\*/g) || []).length, 1);

// --- 无答案但有解析 ---
const txtExpOnly = M.formatOutput(results, typeOrder, false, true);
check('只要解析不要答案时，不出现“答案：”', /答案：/.test(txtExpOnly), false);
check('只要解析时解析仍在', /解析：/.test(txtExpOnly), true);

// --- questionExplanationText ---
check('解析文本直接可用', M.questionExplanationText(q1), '逻辑主义以罗素为代表，主张数学可化归为逻辑。');
check('无解析返回空串', M.questionExplanationText(q2), '');
check('解析换行被折叠为空格', M.questionExplanationText({ explanation: '第一行\n第二行' }), '第一行 第二行');
check('null 安全', M.questionExplanationText(null), '');

// ============ 3. Word / PDF 源码接线 ============
check('Word 生成函数接受 withExplanation', /generateNativeDocxBlob\([^)]*withExplanation/.test(src), true);
check('Word 段落写入“解析：”', src.includes("nativeDocxTextRun('解析：'"), true);
check('PDF 生成函数接受 withExplanation', /generatePdf\([^)]*filename[^)]*withExplanation/.test(src), true);
check('PDF HTML 写入解析块', src.includes('xxt-pdf-explanation'), true);
check('PDF 解析使用蓝色区分答案', /xxt-pdf-explanation\{[^}]*2563eb/i.test(src), true);

// ============ 4. 导出选项弹窗带两个开关 ============
check('导出弹窗有“包含答案”开关', src.includes("makeToggle('withAnswers', '包含答案'"), true);
check('导出弹窗有“包含解析”开关', src.includes("makeToggle('withExplanation', '包含解析'"), true);
check('弹窗返回对象而非裸字符串', /finish\(\{ \.\.\.state \}, close\)/.test(src), true);
check('题库导出使用选项弹窗', src.includes('xxtChooseExportOptions({'), true);
check('面板导出使用选项弹窗', src.includes("defaultValue: getFormat(els) || 'word',"), true);

// ============ 5. 一键补解析 ============
check('AI 有单独的补解析接口', src.includes('xxtAiExplainQuestion'), true);
check('补解析提示词独立', src.includes('xxtBuildAiExplanationPrompt'), true);
check('题库区有补解析按钮', src.includes('data-ai-action="fill-explanation"'), true);
check('编辑器有补解析按钮', src.includes('data-editor-ai="fill-explanation"'), true);
check('题库单题可补解析', src.includes('runBankAiExplainForSingle'), true);
check('筛选支持“无解析”', src.includes('value="no-explanation"'), true);
{
  const applyFn = src.slice(
    src.indexOf('function applyAiAnswerToBankQuestions'),
    src.indexOf('async function runBankAiBatch')
  );
  const guardIdx = applyFn.indexOf('if (entry.explanationOnly)');
  const returnIdx = applyFn.indexOf('return;', guardIdx);
  const answerWriteIdx = applyFn.indexOf('question.correctAnswer = entry.answer');
  check('补解析分支存在', guardIdx > 0, true);
  check('补解析分支在写答案之前就 return', guardIdx < answerWriteIdx && returnIdx > guardIdx && returnIdx < answerWriteIdx, true);
}

fs.unlinkSync(modulePath);
console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
