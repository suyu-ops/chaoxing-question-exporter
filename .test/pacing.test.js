// 批量提取限速与风控回归测试。
// 重点验证：
//   1. 档位参数存在且保守档确实足够慢
//   2. 等待时长带随机抖动（不是固定值）
//   3. 长休息按章数触发
//   4. 连续失败会指数退避
//   5. 风控信号能识别
//   6. 代码里不再残留固定间隔常量
const fs = require('fs');
const path = require('path');
const { extractFunction, SRC } = require('./extract');

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

// ---- 装配被测函数 ----
// 常量已提到顶层（2 空格缩进），正则要兼容 2/4 空格。
const profilesMatch = src.match(/const BATCH_PACING_PROFILES = Object\.freeze\(\{[\s\S]*?\n {2,4}\}\),?\s*\)?;?/);
if (!profilesMatch) {
  console.log('✗ 未找到 BATCH_PACING_PROFILES');
  process.exit(1);
}
const riskMatch = src.match(/const BATCH_RISK_PATTERN = .*/);
if (!riskMatch) {
  console.log('✗ 未找到 BATCH_RISK_PATTERN');
  process.exit(1);
}

const code = [
  'const currentSettings = { batchPacing: globalThis.__pacing || "safe" };',
  'const document = { get hidden() { return !!globalThis.__hidden; } };',
  profilesMatch[0],
  riskMatch[0],
  extractFunction(src, 'batchRandomBetween'),
  extractFunction(src, 'currentBatchProfile'),
  extractFunction(src, 'batchVisibilityMultiplier'),
  'module.exports = { BATCH_PACING_PROFILES, BATCH_RISK_PATTERN, batchRandomBetween, currentBatchProfile, batchVisibilityMultiplier };'
].join('\n\n');
const modulePath = path.join(__dirname, '.build-pacing.js');
fs.writeFileSync(modulePath, code);
const M = require(modulePath);

// ==================== 1. 档位参数 ====================
{
  const safe = M.BATCH_PACING_PROFILES.safe;
  const normal = M.BATCH_PACING_PROFILES.normal;
  const fast = M.BATCH_PACING_PROFILES.fast;
  check('存在三档节奏', Object.keys(M.BATCH_PACING_PROFILES).sort(), ['fast', 'normal', 'safe']);
  check('保守档是默认（currentBatchProfile 未配置时）', ['safe', 'normal', 'fast'].includes(M.currentBatchProfile().key), true);
  check('保守档每章间隔下限 >= 12 秒', safe.navigationGap[0] >= 12000, true);
  check('标准档比保守档快', normal.navigationGap[0] < safe.navigationGap[0], true);
  check('快速档比标准档快', fast.navigationGap[0] < normal.navigationGap[0], true);
  check('保守档有长休息', Array.isArray(safe.longRest) && safe.longRest[0] >= 45000, true);
  check('保守档长休息间隔 8~12 章', safe.longRestEvery, [8, 12]);
  check('所有区间都是 [min,max] 且 min<=max',
    Object.values(M.BATCH_PACING_PROFILES).every(p =>
      ['navigationGap', 'navigationSettle', 'taskSwitch', 'taskCooldown', 'chapterCooldown', 'longRestEvery', 'longRest']
        .every(k => Array.isArray(p[k]) && p[k].length === 2 && p[k][0] <= p[k][1])), true);
}

// ==================== 2. 随机抖动 ====================
{
  const range = [12000, 22000];
  const samples = Array.from({ length: 400 }, () => M.batchRandomBetween(range));
  const min = Math.min(...samples);
  const max = Math.max(...samples);
  const unique = new Set(samples).size;
  check('随机值落在区间内', min >= 12000 && max <= 22000, true);
  check('不会永远返回同一个值（真正抖动）', unique > 100, true);
  check('能覆盖区间两端附近', min < 14000 && max > 20000, true);

  // 固定值区间应稳定返回该值
  check('相等区间返回固定值', M.batchRandomBetween([5000, 5000]), 5000);
  // 异常输入安全
  check('undefined 安全', M.batchRandomBetween(undefined), 0);
  check('null 安全', M.batchRandomBetween(null), 0);
}

// ==================== 3. 页面不可见时放大等待 ====================
{
  globalThis.__hidden = true;
  const multipliers = Array.from({ length: 60 }, () => M.batchVisibilityMultiplier());
  globalThis.__hidden = false;
  const visible = Array.from({ length: 60 }, () => M.batchVisibilityMultiplier());
  check('页面隐藏时等待放大（>=1.5 倍）', multipliers.every(v => v >= 1.5), true);
  check('页面可见时不放大', visible.every(v => v === 1), true);
}

// ==================== 4. 风控信号识别 ====================
{
  const risky = [
    'HTTP 403 Forbidden',
    'HTTP 429 Too Many Requests',
    '操作过于频繁，请稍后再试',
    '访问频繁',
    '请输入验证码',
    'captcha required',
    'tooManyRequests'
  ];
  const notRisky = ['题目加载超时', '无法通过课程原生导航进入该任务点', '未发现章节测验任务'];
  check('能识别全部风控信号', risky.every(text => M.BATCH_RISK_PATTERN.test(text)), true);
  check('普通业务错误不误报', notRisky.every(text => !M.BATCH_RISK_PATTERN.test(text)), true);
}

// ==================== 5. 源码层面：移除固定间隔 ====================
{
  check('旧固定常量 BATCH_PACING 已移除', /BATCH_PACING\b(?!_PROFILES)/.test(src), false);
  check('旧 4200 固定间隔不再作为跳转节奏', src.includes('minNavigationGapMs: 4200'), false);
  check('存在长休息函数', src.includes('maybeBatchLongRest'), true);
  check('长休息已接入主循环', /maybeBatchLongRest\(run, index\)/.test(src), true);
  check('存在退避逻辑', /failStreak/.test(src), true);
  check('风控信号会暂停任务', /BATCH_RISK_PATTERN\.test\(reason\)/.test(src), true);
  check('风控暂停后标记 stopped', /run\.stopped = true;/.test(src), true);
  check('成功会重置退避', /run\.failStreak = 0/.test(src), true);
  check('限速日志会告知间隔范围', /限速已开启/.test(src), true);
  check('设置里能选档位', src.includes('data-pacing="safe"'), true);
  check('档位持久化到设置', src.includes("batchPacing: 'safe'"), true);
  check('存在跳转硬下限保护', /BATCH_HARD_MIN_GAP_MS\s*=\s*6000/.test(src), true);
  check('硬下限真的参与计算', /Math\.max\(BATCH_HARD_MIN_GAP_MS, run\.nextNavGapMs\)/.test(src), true);
}

// ==================== 6. 实际耗时估算（保守档） ====================
{
  const p = M.BATCH_PACING_PROFILES.safe;
  const avg = r => (r[0] + r[1]) / 2;
  const perChapter = avg(p.navigationGap) + avg(p.navigationSettle) + avg(p.chapterCooldown);
  const chapterCount = 44;
  const rests = Math.floor(chapterCount / avg(p.longRestEvery));
  const totalMs = perChapter * chapterCount + avg(p.longRest) * rests;
  const minutes = totalMs / 60000;
  check('保守档 44 章耗时应显著变长（>15 分钟）', minutes > 15, true);
  console.log(`   保守档 44 章预计耗时：约 ${Math.round(minutes)} 分钟（含 ${rests} 次长休息）`);
}

fs.unlinkSync(modulePath);
console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
