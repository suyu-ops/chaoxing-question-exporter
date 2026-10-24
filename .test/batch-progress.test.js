// 批量提取进度持久化回归测试。
// 核心场景：整门课提取过程中页面崩溃/刷新，已提取的题目不能丢。
const fs = require('fs');
const path = require('path');
const { SRC } = require('./extract');

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

// ---- 装配存档函数（用内存模拟存储）----
const store = new Map();
const prelude = [
  'const QUESTION_BANK_TYPES = ["单选","多选","填空","判断","简答"];',
  'const QUESTION_BANK_UNSURE = "不确定";',
  'const QUESTION_BANK_SLOTS = [...QUESTION_BANK_TYPES, QUESTION_BANK_UNSURE];',
  'const BATCH_PROGRESS_KEY = "xxt_batch_progress_v1";',
  'const BATCH_PROGRESS_MAX_BYTES = 3 * 1024 * 1024;',
  'let batchProgressWriter = null;',
  'const GM_setValue = (k, v) => { __store.set(k, v); };',
  'const GM_getValue = (k, d) => (__store.has(k) ? __store.get(k) : d);',
  'const localStorage = { getItem: k => (__store.has(k) ? __store.get(k) : null), setItem: (k, v) => __store.set(k, v), removeItem: k => __store.delete(k) };',
  'const setTimeout = (fn) => { fn(); return 1; };',
  'const clearTimeout = () => {};',
  'const TextEncoder = globalThis.TextEncoder;',
  'const Blob = globalThis.Blob;'
].join('\n');

// 抽取函数
function extract(name) {
  const patterns = ['  function ' + name + '(', '  async function ' + name + '('];
  let start = -1;
  for (const pat of patterns) {
    start = src.indexOf(pat);
    if (start >= 0) break;
  }
  if (start < 0) throw new Error('not found: ' + name);
  const ends = [];
  let cursor = src.indexOf('\n  }', start);
  while (cursor >= 0) {
    ends.push(cursor + '\n  }'.length);
    cursor = src.indexOf('\n  }', cursor + 1);
  }
  for (const end of ends) {
    const body = src.slice(start, end);
    try {
      new Function('return (' + body + ')');
      return body;
    } catch (e) { /* 继续 */ }
  }
  throw new Error('boundary failed: ' + name);
}

const needed = [
  'readBatchProgressValue', 'writeBatchProgressValue', 'clearBatchProgress',
  'serializeBatchRun', 'saveBatchProgress', 'scheduleBatchProgressSave', 'loadBatchProgress'
];
const code = [
  'const __store = new Map();',
  prelude,
  ...needed.map(extract),
  'module.exports = { saveBatchProgress, loadBatchProgress, clearBatchProgress, serializeBatchRun, __store };'
].join('\n\n');
const modulePath = path.join(__dirname, '.build-progress.js');
fs.writeFileSync(modulePath, code);
const M = require(modulePath);

function makeRun(overrides = {}) {
  return {
    id: 'run-1',
    running: true,
    stopped: false,
    title: '逻辑学',
    nextIndex: 3,
    completed: 2,
    taskPointsCompleted: 2,
    added: 8,
    skipped: 1,
    failed: 0,
    answersFilled: 3,
    results: {
      '单选': [
        { stem: '题目A', correctAnswer: 'A' },
        { stem: '题目B', correctAnswer: 'B' }
      ],
      '多选': [{ stem: '题目C', correctAnswer: 'AB' }],
      '填空': [], '判断': [{ stem: '题目D', correctAnswer: '对' }], '简答': [],
      '不确定': []
    },
    typeOrder: ['单选', '多选', '判断'],
    selectedTaskPoints: [
      { id: 'e1', label: '1.1 章节', knowledgeId: 'k1', selected: true, state: 'done' },
      { id: 'e2', label: '1.2 章节', knowledgeId: 'k2', selected: true, state: 'done' },
      { id: 'e3', label: '1.3 章节', knowledgeId: 'k3', selected: true, state: 'current' },
      { id: 'e4', label: '1.4 章节', knowledgeId: 'k4', selected: true, state: 'pending' }
    ],
    logs: Array.from({ length: 100 }, (_, i) => ({ at: Date.now(), message: '日志' + i })),
    ...overrides
  };
}

// ==================== 1. 基本存档与恢复 ====================
{
  M.clearBatchProgress();
  const run = makeRun();
  const ok = M.saveBatchProgress(run);
  check('存档写入成功', ok, true);

  const saved = M.loadBatchProgress();
  check('能读回存档', !!saved, true);
  check('题目总数正确（2+1+0+1+0+0）', saved.total, 4);
  check('进度 nextIndex 保留', saved.nextIndex, 3);
  check('已完成数保留', saved.completed, 2);
  check('课程标题保留', saved.title, '逻辑学');
  check('单选题目完整', saved.results['单选'].length, 2);
  check('判断题保留', saved.results['判断'].length, 1);
  check('题型顺序保留', saved.typeOrder, ['单选', '多选', '判断']);
  check('任务点列表保留', saved.taskPoints.length, 4);
  check('任务点完成状态保留', saved.taskPoints[0].state, 'done');
  check('日志被截断到 60 条', saved.logs.length, 60);
  check('有可读的保存时间', typeof saved.savedAtText === 'string' && saved.savedAtText.length > 0, true);
}

// ==================== 2. 空题库不写存档 ====================
{
  M.clearBatchProgress();
  const emptyRun = makeRun({
    results: { '单选': [], '多选': [], '填空': [], '判断': [], '简答': [], '不确定': [] }
  });
  const ok = M.saveBatchProgress(emptyRun);
  check('空题库不写存档', ok, false);
  check('空题库时存档为空', M.loadBatchProgress(), null);
}

// ==================== 3. 清除存档 ====================
{
  M.saveBatchProgress(makeRun());
  check('清除前有存档', !!M.loadBatchProgress(), true);
  M.clearBatchProgress();
  check('清除后没有存档', M.loadBatchProgress(), null);
}

// ==================== 4. 损坏存档不崩 ====================
{
  M.__store.set('xxt_batch_progress_v1', 'not-json{{{');
  check('非法 JSON 返回 null', M.loadBatchProgress(), null);

  M.__store.set('xxt_batch_progress_v1', JSON.stringify({ results: {} }));
  check('空 results 返回 null', M.loadBatchProgress(), null);

  M.__store.set('xxt_batch_progress_v1', '');
  check('空串返回 null', M.loadBatchProgress(), null);
}

// ==================== 5. 大存档降级不丢全部 ====================
{
  M.clearBatchProgress();
  // 造一个超过 3MB 的题库
  const bigQuestions = Array.from({ length: 6000 }, (_, i) => ({
    stem: '题目 ' + i + ' ' + '内容'.repeat(120),
    correctAnswer: 'A'
  }));
  const bigRun = makeRun({
    results: { '单选': bigQuestions, '多选': [], '填空': [], '判断': [], '简答': [], '不确定': [] }
  });
  const rawBytes = Buffer.byteLength(JSON.stringify(bigRun), 'utf8');
  check('构造的题库确实超限（>3MB）', rawBytes > 3 * 1024 * 1024, true);

  M.saveBatchProgress(bigRun);
  const saved = M.loadBatchProgress();
  check('超限后仍能保存（降级）', !!saved, true);
  if (saved) {
    check('降级后仍保留题目', saved.total > 0, true);
    check('降级后日志被清空', saved.logs.length, 0);
    const savedBytes = Buffer.byteLength(M.__store.get('xxt_batch_progress_v1'), 'utf8');
    check('降级后不超过上限', savedBytes <= 3 * 1024 * 1024, true);
  }
}

// ==================== 6. 源码接线 ====================
{
  check('定义了存档键', src.includes("const BATCH_PROGRESS_KEY = 'xxt_batch_progress_v1'"), true);
  check('每章结束会存档', /每章结束立即存盘/.test(src), true);
  check('循环内调用 scheduleBatchProgressSave', /scheduleBatchProgressSave\(run\)/.test(src), true);
  check('停止时立即存档', /停止时立即落盘/.test(src), true);
  check('正常完成清除存档', /else clearBatchProgress\(\);/.test(src), true);
  check('暂停保留存档', /if \(run\.stopped\) scheduleBatchProgressSave\(run\);/.test(src), true);
  check('beforeunload 兜底', /beforeunload/.test(src), true);
  check('打开弹窗时尝试恢复', src.includes('offerBatchProgressRecovery'), true);
  check('重新扫描会清档', /clearBatchProgress\(\);\s*\n\s*batchPausedRun = null;\s*\n\s*refreshBatchScan\(\);/.test(src), true);
  check('恢复时对齐真实任务点', /scanChapterTestEntries\(\)/.test(src) && /byKnowledge/.test(src), true);
  check('有恢复提示文案', src.includes('检测到上次未完成的整门课提取'), true);
  check('全新开始清旧档', /if \(!shouldResume\) clearBatchProgress\(\);/.test(src), true);
}

// ==================== 7. 序列化结构完整 ====================
{
  const payload = M.serializeBatchRun(makeRun());
  check('序列化含 savedAt', typeof payload.savedAt === 'string', true);
  check('序列化含 nextIndex', payload.nextIndex, 3);
  check('序列化含 results', !!payload.results && !!payload.results['单选'], true);
  check('序列化不含 DOM 引用', JSON.stringify(payload).includes('__fromScan'), false);
  check('序列化任务点精简为 6 个字段',
    Object.keys(payload.taskPoints[0]).sort(),
    ['detail', 'id', 'knowledgeId', 'label', 'selected', 'state']);
}

fs.unlinkSync(modulePath);
console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
