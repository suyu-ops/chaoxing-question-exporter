// 设置持久化回归测试。
// 核心场景：localStorage 配额被历史记录撑满时，保存设置必须
//   1) 不静默失败；2) 自动清理历史后重试成功；3) 真的读得回来。
// 这正是“AI 配置点了保存、重开又显示未配置”的根因。
const fs = require('fs');
const path = require('path');
const { extractFunction, SRC } = require('./extract');

const src = fs.readFileSync(SRC, 'utf8');

let failed = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failed++;
    console.log(`✗ ${label}\n   期望: ${JSON.stringify(expected)}\n   实际: ${JSON.stringify(actual)}`);
  } else console.log(`✓ ${label}`);
}

// ---- 构造可控配额的 localStorage ----
function makeStorage(quotaBytes) {
  const map = new Map();
  let used = 0;
  const size = v => Buffer.byteLength(String(v), 'utf8');
  return {
    map,
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) {
      const old = map.has(k) ? size(map.get(k)) : 0;
      const next = used - old + size(v);
      if (next > quotaBytes) {
        const err = new Error('QuotaExceededError');
        err.name = 'QuotaExceededError';
        throw err;
      }
      // 先删再加，保证顺序
      if (map.has(k)) map.delete(k);
      map.set(k, String(v));
      used = next;
    },
    removeItem(k) {
      if (!map.has(k)) return;
      used -= size(map.get(k));
      map.delete(k);
    },
    get used() { return used; }
  };
}

function build(prelude) {
  const parts = [
    prelude,
    'const SETTINGS_KEY = "xxt_settings";',
    'const DEFAULT_SETTINGS = { theme:"auto", shortcut:{ctrl:true,shift:true,alt:false,key:"e"}, exportConfig:{format:"word",withAnswers:false,shuffle:false,bankImport:false}, enableDrag:true, rememberPanelPosition:true, panelPosition:null, floatingPositions:{}, bankThreshold:90, ai:{baseUrl:"",apiKey:"",model:"",models:[],concurrency:2,lastTestAt:"",lastTestOk:null} };'
  ];
  for (const name of ['normalizeAiSettings', 'loadSettings', 'saveSettings', 'describeSettingsStorage', 'xxtNormalizeAiBaseUrl']) {
    parts.push(extractFunction(src, name));
  }
  parts.push('let currentSettings = loadSettings();');
  parts.push('module.exports = { get: () => currentSettings, saveSettings, loadSettings, describeSettingsStorage, xxtNormalizeAiBaseUrl, getError: () => settingsSaveError, setToast: fn => { __toastImpl = fn; } };');
  const file = path.join(__dirname, '.build-settings.js');
  fs.writeFileSync(file, parts.join('\n\n'));
  delete require.cache[require.resolve(file)];
  return require(file);
}

// ===== 场景 1：正常配额，往返正常 =====
{
  const store = makeStorage(5 * 1024 * 1024);
  global.localStorage = store;
  const toast = [];
  const M = build('let __toastImpl = () => {}; function showGlobalToast(msg, tone) { return __toastImpl(msg, tone); }');
  M.setToast((msg, tone) => toast.push([tone, msg]));
  const cur = M.get();
  cur.ai = {
    baseUrl: M.xxtNormalizeAiBaseUrl('https://api.deepseek.com'),
    apiKey: 'sk-test123', model: 'deepseek-chat',
    models: ['deepseek-chat'], concurrency: 2, lastTestAt: '', lastTestOk: null
  };
  check('正常配额：保存返回 true', M.saveSettings(cur), true);
  const reloaded = M.loadSettings();
  check('正常配额：Base URL 已补 /v1', reloaded.ai.baseUrl, 'https://api.deepseek.com/v1');
  check('正常配额：API Key 保留', reloaded.ai.apiKey, 'sk-test123');
  check('正常配额：模型保留', reloaded.ai.model, 'deepseek-chat');
  check('正常配额：无错误', M.getError(), '');
}

// ===== 场景 2：配额被历史记录撑满 → 自动清理历史后保存成功 =====
{
  // 配额设为「刚好装不下设置、但清掉历史后能装下」的临界值。
  const store = makeStorage(64 * 1024);
  global.localStorage = store;
  const M = build('let __toastImpl = () => {}; function showGlobalToast(msg, tone) { return __toastImpl(msg, tone); }');
  const toast = [];
  M.setToast((msg, tone) => toast.push([tone, msg]));

  // 精确把剩余空间压到 40 字节，确保设置写不进去（设置约 120+ 字节）。
  store.setItem('xxt_history', 'x'.repeat(64 * 1024 - 'xxt_history'.length - 40));
  check('剩余空间已不足以写入设置', 64 * 1024 - store.used < 100, true);

  const cur = M.get();
  cur.ai = {
    baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-abcdefghijklmn',
    model: 'gpt-4o-mini', models: [], concurrency: 2, lastTestAt: '', lastTestOk: null
  };
  const ok = M.saveSettings(cur);
  check('配额紧张：自动清理历史后保存成功', ok, true);
  check('配额紧张：历史已被清理', store.getItem('xxt_history'), null);
  check('配额紧张：给出清理提示', toast.some(t => /清理下载历史/.test(t[1])), true);

  const reloaded = M.loadSettings();
  check('配额紧张：AI 配置真的存住了', reloaded.ai.model, 'gpt-4o-mini');
  check('配额紧张：API Key 存住了', reloaded.ai.apiKey, 'sk-abcdefghijklmn');
}

// ===== 场景 3：配额太小，连设置都放不下 → 必须报错而非静默 =====
{
  const store = makeStorage(100); // 100 字节，绝对放不下
  global.localStorage = store;
  const M = build('let __toastImpl = () => {}; function showGlobalToast(msg, tone) { return __toastImpl(msg, tone); }');
  const toast = [];
  M.setToast((msg, tone) => toast.push([tone, msg]));
  const cur = M.get();
  cur.ai = { baseUrl: 'https://a.com/v1', apiKey: 'k'.repeat(200), model: 'm', models: [], concurrency: 2, lastTestAt: '', lastTestOk: null };
  const ok = M.saveSettings(cur);
  check('配额极小：保存返回 false', ok, false);
  check('配额极小：记录了错误信息', /保存失败/.test(M.getError()), true);
  check('配额极小：弹出错误提示', toast.some(t => t[0] === 'err'), true);
}

// ===== 场景 4：localStorage 完全不可用（禁用）=====
{
  global.localStorage = {
    getItem() { throw new Error('denied'); },
    setItem() { throw new Error('denied'); },
    removeItem() { throw new Error('denied'); }
  };
  const M = build('let __toastImpl = () => {}; function showGlobalToast(msg, tone) { return __toastImpl(msg, tone); }');
  const cur = M.get();
  cur.ai = { baseUrl: 'https://a.com/v1', apiKey: 'k', model: 'm', models: [], concurrency: 2, lastTestAt: '', lastTestOk: null };
  check('存储被禁用：保存返回 false', M.saveSettings(cur), false);
  check('存储被禁用：有错误信息', !!M.getError(), true);
  check('存储被禁用：加载回退到默认值', M.loadSettings().ai.model, '');
}

// ===== 场景 5：旧版本设置（没有 ai 字段）读取不崩 =====
{
  const store = makeStorage(5 * 1024 * 1024);
  global.localStorage = store;
  store.setItem('xxt_settings', JSON.stringify({ theme: 'dark', bankThreshold: 77 }));
  const M = build('let __toastImpl = () => {}; function showGlobalToast(msg, tone) { return __toastImpl(msg, tone); }');
  const loaded = M.loadSettings();
  check('旧设置：保留 theme', loaded.theme, 'dark');
  check('旧设置：保留 bankThreshold', loaded.bankThreshold, 77);
  check('旧设置：ai 补齐为默认对象', typeof loaded.ai, 'object');
  check('旧设置：ai.baseUrl 为空串', loaded.ai.baseUrl, '');
  check('旧设置：ai.concurrency 有默认值', loaded.ai.concurrency, 2);
}

// ===== 场景 6：ai 字段被写坏（数组/字符串）也能恢复 =====
{
  const store = makeStorage(5 * 1024 * 1024);
  global.localStorage = store;
  store.setItem('xxt_settings', JSON.stringify({ ai: 'not-an-object' }));
  const M = build('let __toastImpl = () => {}; function showGlobalToast(msg, tone) { return __toastImpl(msg, tone); }');
  const loaded = M.loadSettings();
  check('ai 为字符串：恢复为对象', typeof loaded.ai, 'object');
  check('ai 为字符串：字段可用', loaded.ai.concurrency, 2);

  store.setItem('xxt_settings', JSON.stringify({ ai: { concurrency: 999, models: 'x' } }));
  const M2 = build('let __toastImpl = () => {}; function showGlobalToast(msg, tone) { return __toastImpl(msg, tone); }');
  const loaded2 = M2.loadSettings();
  check('并发数超限被夹到 6', loaded2.ai.concurrency, 6);
  check('models 非数组被重置', Array.isArray(loaded2.ai.models), true);
}

const buildFile = path.join(__dirname, '.build-settings.js');
try { fs.unlinkSync(buildFile); } catch (e) {}
console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
