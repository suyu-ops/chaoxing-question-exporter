// 回归：批量 AI 归类不能丢题
//   用户反馈「AI 审核归类后，有些题还留在待归类，但界面说全部写入了」。
// 根因：runBankAiBatch 里条目带的是「收集时」的数组下标，而每 5 条就落盘一次。
// saveQuestionBankState → normalizeQuestionBankState → normalizeQuestionBank
// 会把整库题目重建：下标失效，题目对象引用也失效。于是第二批开始
// applyAiReclassification 按下标删不到东西、按下标写不进答案，
// 题目被静默丢弃，而 changed 计数依旧累加。
// 修复后条目带稳定身份（题干+选项哈希），定位不再依赖下标。
const { extractFunction, SRC } = require('./extract');
const fs = require('fs');

const src = fs.readFileSync(SRC, 'utf8');

const prelude = `
const QUESTION_BANK_TYPES = ['单选', '多选', '填空', '判断', '简答'];
const QUESTION_BANK_UNSURE = '不确定';
const QUESTION_BANK_SLOTS = [...QUESTION_BANK_TYPES, QUESTION_BANK_UNSURE];
let __state = null;
function loadQuestionBankState() { return __state; }
function saveQuestionBankState(state) { __state = state; return state; }
function refreshBankModal() {}
function richTextOnly(content) { return (content || []).map(p => p.text || '').join('').trim(); }
function richContentIdentity(content) { return richTextOnly(content); }
function questionContent(q) { return (q && (q.stemContent || (q.stem ? [{ type: 'text', text: q.stem }] : []))) || []; }
function optionContent(o) { return (o && (o.content || [{ type: 'text', text: o.text || '' }])) || []; }
function getQuestionIdentity(type, question) {
  if (!question) return '';
  const normalize = v => String(v || '').replace(/\\s+/g, ' ').trim();
  const stem = normalize(question.stem || richContentIdentity(question.stemContent || []));
  if (!stem) return '';
  const options = (question.options || []).map(o =>
    normalize(o && o.letter) + ':' + normalize(o && (o.text || richContentIdentity(o.content || [])))
  ).join('|');
  return type + '|' + stem + '|' + options;
}
function bankQuestionIdentity(type, question) {
  const base = getQuestionIdentity(type, question);
  if (base) return base;
  return type + '|' + richContentIdentity(questionContent(question));
}
`;

const body = [
  extractFunction(src, 'locateBankQuestionIndex'),
  extractFunction(src, 'applyAiReclassification'),
  extractFunction(src, 'applyAiAnswerToBankQuestions')
].join('\n\n');

const code = `(function () {
${prelude}
${body}
return { applyAiAnswerToBankQuestions, bankQuestionIdentity, setState(s) { __state = s; }, getState() { return __state; } };
})()`;

const api = eval(code);

const UNS = '不确定';
const SINGLE = '单选';
const MULTI = '多选';
const ALL = ['单选', '多选', '填空', '判断', '简答', UNS];

function makeQuestion(n) {
  return {
    stem: '待归类题目 ' + n,
    stemContent: [{ type: 'text', text: '待归类题目 ' + n }],
    options: [{ letter: 'A', text: '选项A' + n, content: [{ type: 'text', text: '选项A' + n }] }],
    correctAnswer: '', correctAnswerContent: [], explanation: ''
  };
}
// 模拟 normalizeQuestionBank：落盘后题目对象全部重建
const clone = question => JSON.parse(JSON.stringify(question));

function freshBank(size) {
  const questions = Array.from({ length: size }, (_, i) => makeQuestion(i + 1));
  api.setState({
    activeBankId: 'b1',
    banks: [{
      id: 'b1', name: '测试题库', typeOrder: [UNS],
      results: { '单选': [], '多选': [], '填空': [], '判断': [], '简答': [], [UNS]: questions }
    }]
  });
  return questions;
}

// 与 runBankAiBatch 一致的批量节奏：凑够 batchSize 条就落盘并重建对象。
function runBatch(questions, verdicts, batchSize) {
  const targets = questions.map((question, index) => ({ type: UNS, question, index }));
  const pending = [];
  let submitted = 0;
  const flush = () => {
    const batch = pending.splice(0, pending.length);
    if (!batch.length) return;
    submitted += batch.length;
    api.applyAiAnswerToBankQuestions(batch);
    api.getState().banks.forEach(bank => {
      ALL.forEach(type => { bank.results[type] = (bank.results[type] || []).map(clone); });
    });
  };
  targets.forEach((row, i) => {
    pending.push({
      type: row.type,
      index: row.index,
      question: row.question,
      identity: api.bankQuestionIdentity(row.type, row.question),
      reclassifyTo: verdicts[i],
      answer: 'A',
      confidence: 0.9,
      reason: 'AI 判定'
    });
    if (pending.length >= batchSize) flush();
  });
  flush();
  return submitted;
}

let failed = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) {
    failed++;
    console.log(`✗ ${label}\n   期望: ${expected}\n   实际: ${actual}`);
  } else console.log(`✓ ${label}`);
}

// ---- 场景 1：8 题、每 5 条落盘（原先从第 6 题起全部丢失）----
const verdicts8 = [SINGLE, SINGLE, SINGLE, SINGLE, SINGLE, SINGLE, MULTI, MULTI];
const submitted8 = runBatch(freshBank(8), verdicts8, 5);
const bank1 = api.getState().banks[0];
const count1 = type => (bank1.results[type] || []).length;

check('提交条目数', submitted8, 8);
check('单选槽位保留 6 题', count1(SINGLE), 6);
check('多选槽位保留 2 题', count1(MULTI), 2);
check('待归类已清空', count1(UNS), 0);
check('题库总题数不变', ALL.reduce((sum, type) => sum + count1(type), 0), 8);
check('每道题都写入了答案',
  ALL.reduce((sum, type) => sum + (bank1.results[type] || []).filter(q => q.correctAnswer === 'A').length, 0), 8);

// ---- 场景 2：逐条落盘（batchSize = 1，下标每轮都失效）----
const verdicts6 = [SINGLE, MULTI, SINGLE, MULTI, SINGLE, MULTI];
runBatch(freshBank(6), verdicts6, 1);
const bank2 = api.getState().banks[0];
const count2 = type => (bank2.results[type] || []).length;
check('逐条落盘后单选 3 题', count2(SINGLE), 3);
check('逐条落盘后多选 3 题', count2(MULTI), 3);
check('逐条落盘后待归类清空', count2(UNS), 0);

// ---- 场景 3：条目指向已删除的题目时，必须跳过而不是写到别的题上 ----
const bank3Questions = freshBank(3);
const victim = bank3Questions[1];
api.getState().banks[0].results[UNS] = bank3Questions.filter(q => q !== victim);
api.applyAiAnswerToBankQuestions([{
  type: UNS,
  index: 1,
  question: victim,
  identity: api.bankQuestionIdentity(UNS, victim),
  reclassifyTo: SINGLE,
  answer: 'A',
  confidence: 0.9
}]);
const bank3 = api.getState().banks[0];
check('已删除的题目不会被写回', (bank3.results[SINGLE] || []).length, 0);
check('剩余题目留在原槽位', (bank3.results[UNS] || []).length, 2);
check('剩余题目没有被写上答案',
  (bank3.results[UNS] || []).every(q => !q.correctAnswer), true);

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
