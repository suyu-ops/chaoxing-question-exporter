// 从单文件用户脚本中抽取纯函数，用于 Node 下做回归验证。
// 采用「编译校验」方式确定函数边界：逐个候选结尾尝试 new Function 解析，
// 首个能成功解析的结尾即为函数结束，避免手工花括号/正则匹配的误判。
const fs = require('fs');
const path = require('path');

// 本地开发目录叫 学习通题目导出.js，发布仓库叫 学习通题目导出.user.js，
// 两种命名都支持，避免测试只能在其中一个目录跑。
const SRC_CANDIDATES = [
  path.join(__dirname, '..', '学习通题目导出.js'),
  path.join(__dirname, '..', '学习通题目导出.user.js')
];
const SRC = SRC_CANDIDATES.find(p => fs.existsSync(p)) || SRC_CANDIDATES[0];

function extractFunction(src, name) {
  const patterns = [
    new RegExp('\\n[ \\t]+async function ' + name + '\\('),
    new RegExp('\\n[ \\t]+function ' + name + '\\(')
  ];
  let match = null;
  for (const pattern of patterns) {
    match = src.match(pattern);
    if (match) break;
  }
  if (!match) throw new Error('function not found: ' + name);
  const start = match.index + 1;

  const candidates = [];
  // 顶层缩进可能是 2 或 4 个空格，两种都作为候选结尾。
  for (const indent of ['\n  }', '\n    }']) {
    let cursor = src.indexOf(indent, start);
    while (cursor >= 0) {
      candidates.push(cursor + indent.length);
      cursor = src.indexOf(indent, cursor + 1);
    }
  }
  candidates.sort((a, b) => a - b);
  for (const end of candidates) {
    const body = src.slice(start, end);
    try {
      // 只做语法解析，不执行。
      new Function('return (' + body.replace(/^async function\s+/, 'async function ').replace(/^function\s+/, 'function ') + ')');
      return body;
    } catch (e) { /* 继续找下一个候选结尾 */ }
  }
  throw new Error('unable to determine function body: ' + name);
}

function buildModule(exportsMap, prelude = '') {
  const src = fs.readFileSync(SRC, 'utf8');
  const parts = [
    'const QUESTION_BANK_TYPES = ["\u5355\u9009","\u591a\u9009","\u586b\u7a7a","\u5224\u65ad","\u7b80\u7b54"];',
    'const XXT_TYPE_LABELS = { "\u5355\u9009": "\u5355\u9009\u9898", "\u591a\u9009": "\u591a\u9009\u9898", "\u586b\u7a7a": "\u586b\u7a7a\u9898", "\u5224\u65ad": "\u5224\u65ad\u9898", "\u7b80\u7b54": "\u7b80\u7b54\u9898" };'
    , 'const QUESTION_BANK_UNSURE = "不确定";'
    , 'const QUESTION_BANK_SLOTS = [...QUESTION_BANK_TYPES, QUESTION_BANK_UNSURE];'
    , "const TYPE_RULES = [\n    // 多选题的各种写法\n    { test: /多项选择|多选|不定项|multiple[\\s_-]*choice|checkbox/i, type: '多选' },\n    // 判断题的各种写法\n    { test: /判断|正误|是非|true[\\s_/或-]*(?:or[\\s_-]*)?false|judg(e|ment)/i, type: '判断' },\n    // 填空题\n    { test: /填空|fill[\\s_-]*(?:in[\\s_-]*)?(?:the[\\s_-]*)?blank/i, type: '填空' },\n    // 简答类\n    { test: /简答|问答|论述|名词解释|案例分析|计算题|essay|subjective/i, type: '简答' },\n    // 单选类（含宽泛的“选择题”，必须放最后）\n    { test: /单项选择|单选|选择|single[\\s_-]*choice|radio/i, type: '单选' }\n  ];"
  ];
  if (prelude) parts.push(prelude);
  // exportsMap: { exportName: sourceName }
  const declared = new Set();
  const names = Object.values(exportsMap);
  for (const name of names) {
    if (declared.has(name)) continue;
    declared.add(name);
    parts.push(extractFunction(src, name));
  }
  parts.push('module.exports = { ' + Object.keys(exportsMap).join(', ') + ' };');
  // 用 exportName = sourceName 形式别名导出
  const aliases = Object.entries(exportsMap)
    .filter(([exportName, sourceName]) => exportName !== sourceName)
    .map(([exportName, sourceName]) => `module.exports.${exportName} = ${sourceName};`);
  return parts.join('\n\n') + '\n' + aliases.join('\n');
}

module.exports = { SRC, extractFunction, buildModule };
