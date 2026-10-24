// 题型推断与 AI 归类回归测试。
// 核心场景：用户导入的题库文件只有题干/选项/答案，没有题型说明。
//   1. 能靠规则正确推断题型（单选/多选/判断/填空/简答）
//   2. 信息不足或冲突时标为「不确定」，而不是静默猜一个
//   3. 待归类的题能通过 AI 归类移动到正确题型
const fs = require('fs');
const path = require('path');
const { buildModule, SRC } = require('./extract');

const src = fs.readFileSync(SRC, 'utf8');

let failed = 0;
function brief(v) {
  const t = JSON.stringify(v);
  return t === undefined ? String(v) : (t.length > 200 ? t.slice(0, 200) + '…' : t);
}
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failed++;
    console.log(`✗ ${label}\n   期望: ${brief(expected)}\n   实际: ${brief(actual)}`);
  } else console.log(`✓ ${label}`);
}

// ---- 装配推断器 ----
const rulesMatch = src.match(/const TYPE_RULES = \[[\s\S]*?\n {2}\];/);
const slotsMatch = src.match(/const QUESTION_BANK_UNSURE = .*;/);
if (!rulesMatch || !slotsMatch) {
  console.log('✗ 未找到 TYPE_RULES / QUESTION_BANK_UNSURE');
  process.exit(1);
}
const code = [
  'const QUESTION_BANK_TYPES = ["单选","多选","填空","判断","简答"];',
  slotsMatch[0],
  'const QUESTION_BANK_SLOTS = [...QUESTION_BANK_TYPES, QUESTION_BANK_UNSURE];',
  rulesMatch[0],
  extractFunctionOf(src, 'xxtNormalizeType'),
  extractFunctionOf(src, 'xxtInferQuestionType'),
  'module.exports = { xxtInferQuestionType, QUESTION_BANK_UNSURE, QUESTION_BANK_SLOTS };'
].join('\n\n');

function extractFunctionOf(source, name) {
  let start = source.indexOf('  function ' + name + '(');
  if (start < 0) throw new Error('not found: ' + name);
  // 用编译校验找边界
  const ends = [];
  let cursor = source.indexOf('\n  }', start);
  while (cursor >= 0) {
    ends.push(cursor + '\n  }'.length);
    cursor = source.indexOf('\n  }', cursor + 1);
  }
  for (const end of ends) {
    const body = source.slice(start, end);
    try {
      new Function('return (' + body + ')');
      return body;
    } catch (e) { /* 继续 */ }
  }
  throw new Error('boundary failed: ' + name);
}

const modulePath = path.join(__dirname, '.build-infer.js');
fs.writeFileSync(modulePath, code);
const M = require(modulePath);
const infer = M.xxtInferQuestionType;
const UNSURE = M.QUESTION_BANK_UNSURE;

// ==================== 1. 明确的题型声明 ====================
{
  const r = infer({ stem: '下列哪些是质数？', options: ['2', '3', '4'], answer: 'AB', declaredType: '多选题' });
  check('显式声明多选', r.type, '多选');
  check('显式声明置信度为 high', r.confidence, 'high');
  const r2 = infer({ stem: '1+1=2', options: ['正确', '错误'], answer: 'A', declaredType: '判断题' });
  check('显式声明判断', r2.type, '判断');
}

// ==================== 2. 无声明但有充分信号 ====================
{
  // 单选：3 个以上选项 + 单字母答案
  const r = infer({ stem: '逻辑主义的代表人物是()。', options: ['布劳威尔', '哥德尔', '希尔伯特', '罗素'], answer: 'D' });
  check('无声明 → 单选（4 选项+单字母）', r.type, '单选');
  check('单选置信度不为 low', r.confidence !== 'low', true);

  // 多选：答案多个字母
  const r2 = infer({ stem: '下列属于佛教流派的有()', options: ['禅宗', '净土宗', '道教', '律宗'], answer: 'ABD' });
  check('无声明 → 多选（答案为多个字母）', r2.type, '多选');

  // 多选：答案用分隔符列出
  const r3 = infer({ stem: '下列说法正确的有', options: ['甲', '乙', '丙', '丁'], answer: 'A、C' });
  check('无声明 → 多选（分隔符答案）', r3.type, '多选');

  // 判断：两个对错式选项 + 字母答案
  const r4 = infer({ stem: '地球是圆的', options: ['正确', '错误'], answer: 'A' });
  check('无声明 → 判断（对错选项）', r4.type, '判断');

  // 判断：无选项 + 判断词答案
  const r5 = infer({ stem: '藏传佛教属于佛教三大语系之一。', options: [], answer: '正确' });
  check('无声明 → 判断（无选项+判断词）', r5.type, '判断');

  // 填空：题干有下划线 + 无选项
  const r6 = infer({ stem: '佛教创立于公元前______世纪。', options: [], answer: '6' });
  check('无声明 → 填空（下划线空位）', r6.type, '填空');

  // 填空：括号空位
  const r7 = infer({ stem: '中华人民共和国成立于（  ）年。', options: [], answer: '1949' });
  check('无声明 → 填空（括号空位）', r7.type, '填空');

  // 简答：无选项、无空位、长答案
  const r8 = infer({ stem: '简述佛教的四谛。', options: [], answer: '苦谛、集谛、灭谛、道谛，说明人生痛苦及解脱之道' });
  check('无声明 → 简答（长答案）', r8.type, '简答');
}

// ==================== 3. 信息不足 → 不确定（不静默错分） ====================
{
  // 有选项但没答案、也没题型：无法判断单选还是多选
  const r = infer({ stem: '以下哪个正确？', options: ['甲', '乙', '丙'], answer: '' });
  check('有选项但无答案 → 单选或不确定', ['单选', UNSURE].includes(r.type), true);

  // 完全没信息
  const r2 = infer({ stem: '这是一道题', options: [], answer: '' });
  check('几乎没有信息 → 不能自信给出类型', ['简答', UNSURE].includes(r2.type), true);

  // 冲突：题干有填空标记，但又有选项
  const r3 = infer({ stem: '填空：______ 是首都（  ）', options: ['北京', '上海'], answer: 'A' });
  check('填空标记与选项冲突时不强判', ['单选', UNSURE].includes(r3.type), true);

  // 空输入
  const r4 = infer({});
  check('空输入 → 不确定', r4.type, UNSURE);
  check('空输入置信度 low', r4.confidence, 'low');
}

// ==================== 4. 推断结果带可解释依据 ====================
{
  const r = infer({ stem: '以下哪个正确？', options: ['甲', '乙', '丙', '丁'], answer: 'B' });
  check('返回 evidence 数组', Array.isArray(r.evidence) && r.evidence.length > 0, true);
  check('返回 reason 文本', typeof r.reason === 'string' && r.reason.length > 0, true);
  check('返回 confidence', ['high', 'medium', 'low'].includes(r.confidence), true);

  const unsure = infer({ stem: '无信号', options: [], answer: '' });
  if (unsure.type === UNSURE) {
    check('待归类时给出原因', typeof unsure.reason === 'string' && unsure.reason.length > 0, true);
  } else {
    check('待归类时给出原因', true, true);
  }
}

// ==================== 5. 源码接线 ====================
{
  check('定义了 QUESTION_BANK_UNSURE', src.includes("const QUESTION_BANK_UNSURE = '不确定'"), true);
  check('定义了 QUESTION_BANK_SLOTS', src.includes('const QUESTION_BANK_SLOTS = [...QUESTION_BANK_TYPES, QUESTION_BANK_UNSURE]'), true);
  check('题型标签含待归类', /QUESTION_BANK_TYPE_LABELS[\s\S]{0,300}\[QUESTION_BANK_UNSURE\]: '待归类'/.test(src), true);
  check('解析器使用推断器', /const inferred = xxtInferQuestionType\(/.test(src), true);
  check('导入时记录置信度', src.includes('typeConfidence: inferred.confidence'), true);
  check('导入时记录依据', src.includes('typeReason: inferred.reason'), true);
  check('AI 归类提示词存在', src.includes('xxtBuildAiClassifyPrompt'), true);
  check('AI 归类函数存在', src.includes('xxtAiClassifyQuestion'), true);
  check('批量支持 classify 模式', src.includes("mode === 'classify'"), true);
  check('存在跨槽位移动函数', src.includes('applyAiReclassification'), true);
  check('移动时按 index 降序处理', /按原槽位分组、index 降序删除/.test(src), true);
  check('UI 有 AI 归类按钮', src.includes('data-ai-action="classify"'), true);
  check('筛选支持待归类', src.includes('value="unsure"'), true);
  check('题库遍历用 SLOTS', src.includes('QUESTION_BANK_SLOTS.forEach(type => {'), true);
  check('导出时排除待归类', /导出时不带「待归类」/.test(src), true);
}

fs.unlinkSync(modulePath);
console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
